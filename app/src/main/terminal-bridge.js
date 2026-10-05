'use strict';

const { EventEmitter } = require('node:events');
const { createControlClient, createStreamSupervisor } = require('./session-daemon/factory.js');
const {
  focusedTabForWorkspace,
  layoutForTab,
} = require('../shared/terminal-layout.cjs');

const BACKFILL_LINES = 200;

function layoutsToMap(layouts) {
  const map = {};
  for (const layout of layouts || []) map[layout.tab_id] = layout;
  return map;
}

function applyWorkspaceEvent(state, event) {
  const kind = event?.event;
  const data = event?.data || {};
  if (!kind?.startsWith('workspace.')) return state;

  const workspaces = [...state.workspaces];
  let focusedWorkspaceId = state.focusedWorkspaceId;

  if (kind === 'workspace.created') {
    const workspace = data.workspace;
    if (workspace && !workspaces.some((w) => w.workspace_id === workspace.workspace_id)) {
      workspaces.push(workspace);
    }
  } else if (kind === 'workspace.updated') {
    const workspace = data.workspace;
    if (workspace) {
      const idx = workspaces.findIndex((w) => w.workspace_id === workspace.workspace_id);
      if (idx >= 0) workspaces[idx] = workspace;
      else workspaces.push(workspace);
    }
  } else if (kind === 'workspace.closed') {
    const workspaceId = data.workspace_id || data.workspace?.workspace_id;
    return {
      ...state,
      workspaces: workspaces.filter((w) => w.workspace_id !== workspaceId),
      tabs: state.tabs.filter((t) => t.workspace_id !== workspaceId),
      focusedWorkspaceId: focusedWorkspaceId === workspaceId
        ? (workspaces.find((w) => w.workspace_id !== workspaceId)?.workspace_id ?? null)
        : focusedWorkspaceId,
    };
  } else if (kind === 'workspace.focused') {
    const workspaceId = data.workspace_id || data.workspace?.workspace_id;
    if (workspaceId) focusedWorkspaceId = workspaceId;
  }

  return { ...state, workspaces, focusedWorkspaceId };
}

function applyTabEvent(state, event) {
  const kind = event?.event;
  const data = event?.data || {};
  if (!kind?.startsWith('tab.')) return state;

  const tabs = [...state.tabs];

  if (kind === 'tab.created') {
    const tab = data.tab;
    if (tab && !tabs.some((t) => t.tab_id === tab.tab_id)) tabs.push(tab);
  } else if (kind === 'tab.closed') {
    const tabId = data.tab_id || data.tab?.tab_id;
    const layouts = { ...state.layouts };
    delete layouts[tabId];
    return { ...state, tabs: tabs.filter((t) => t.tab_id !== tabId), layouts };
  } else if (kind === 'tab.renamed' || kind === 'tab.moved' || kind === 'tab.focused') {
    const tab = data.tab;
    if (tab) {
      const idx = tabs.findIndex((t) => t.tab_id === tab.tab_id);
      if (idx >= 0) tabs[idx] = tab;
      else tabs.push(tab);
      // Focus is exclusive per workspace, but the daemon only sends the newly
      // focused tab: clear the stale flag on its siblings or two tabs stay
      // "focused" and the UI keeps rendering the old one.
      if (kind === 'tab.focused' && tab.focused !== false) {
        for (let i = 0; i < tabs.length; i += 1) {
          if (tabs[i].tab_id !== tab.tab_id
            && tabs[i].workspace_id === tab.workspace_id
            && tabs[i].focused) {
            tabs[i] = { ...tabs[i], focused: false };
          }
        }
      }
    }
  }

  return { ...state, tabs };
}

function applyLayoutEvent(state, event) {
  const kind = event?.event;
  const data = event?.data || {};
  if (kind !== 'layout.updated') return state;
  const layout = data.layout;
  if (!layout?.tab_id) return state;
  // A freshly created tab can transiently report an empty layout before the daemon
  // materializes its pane; never let that clobber a known-good layout (a tab
  // whose last pane truly closes is torn down via tab.closed, not this path).
  const existing = state.layouts[layout.tab_id];
  if (!layout.panes?.length && existing?.panes?.length) return state;
  return { ...state, layouts: { ...state.layouts, [layout.tab_id]: layout } };
}

// The geometry a driven pane is held at: big enough for Claude Code's
// AskUserQuestion dialog, which needs ~35 rows and clips into nothing in the
  // smallest historical pane size. See streams.ensureDialogSize for the measurement.
const DIALOG_SIZE = Object.freeze({ cols: 120, rows: 60 });

function createTerminalBridge(options = {}) {
  const emitter = new EventEmitter();
  const makeClient = options.createControlClient || createControlClient;
  const supervisor = (options.createStreamSupervisor || createStreamSupervisor)({
    sessionSocketPath: options.sessionSocketPath,
    sessionStorePolicy: options.sessionStorePolicy,
    env: options.env,
  });
  const processKill = options.processKill || process.kill.bind(process);
  const closePollIntervalMs = options.closePollIntervalMs ?? 100;
  const closePollAttempts = options.closePollAttempts ?? 30;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let client = null;
  let subscription = null;
  let closed = false;
  let state = {
    workspaces: [],
    tabs: [],
    layouts: {},
    focusedWorkspaceId: null,
  };

  const visiblePanes = new Map();
  let controlledPaneId = null;
  // The tab that owns the controlled pane, resolved main-side where the
  // snapshot lives; the renderer keys its displayed tab off this.
  let controlledPaneTabId = null;
  const externalControl = new Map();

  const publish = () => {
    if (closed) return;
    emitter.emit('update', getState());
  };

  const getState = () => ({
    workspaces: state.workspaces,
    tabs: state.tabs,
    layouts: state.layouts,
    focusedWorkspaceId: state.focusedWorkspaceId,
    controlledPaneId,
    controlledPaneTabId,
    externalControl: Object.fromEntries(externalControl),
  });

  const seedFromSnapshot = (snapshot) => {
    const snap = snapshot?.snapshot || snapshot || {};
    state = {
      workspaces: snap.workspaces || [],
      tabs: snap.tabs || [],
      layouts: layoutsToMap(snap.layouts),
      focusedWorkspaceId: snap.focused_workspace_id
        || snap.workspaces?.find((w) => w.focused)?.workspace_id
        || snap.workspaces?.[0]?.workspace_id
        || null,
    };
  };

  const applyEvent = (event) => {
    state = applyWorkspaceEvent(state, event);
    state = applyTabEvent(state, event);
    state = applyLayoutEvent(state, event);
    publish();
  };

  const emitControlState = (paneId, status, reason = null) => {
    emitter.emit('control-state', { paneId, status, reason });
  };

  let reconnectTimer = null;
  let reconnectDelayIdx = 0;
  const RECONNECT_DELAYS = [2000, 5000, 10000, 30000];
  const attemptReconnect = async () => {
    reconnectTimer = null;
    if (closed) return;
    try {
      await connect();
      reconnectDelayIdx = 0;
      // Streams from before the disconnect are dead: rebuild every visible
      // pane's observer through the normal attach+backfill path.
      const panes = [...visiblePanes.entries()].map(([paneId, size]) => ({ paneId, ...size }));
      visiblePanes.clear();
      supervisor.detach();
      await applyVisiblePanes(panes);
      emitter.emit('connection-restored');
    } catch {
      scheduleReconnect();
    }
  };
  const scheduleReconnect = () => {
    emitter.emit('connection-lost');
    clearTimeout(reconnectTimer);
    const delay = RECONNECT_DELAYS[Math.min(reconnectDelayIdx++, RECONNECT_DELAYS.length - 1)];
    reconnectTimer = setTimeout(attemptReconnect, delay);
    reconnectTimer.unref?.();
  };
  // Cut the backoff tail when the daemon is KNOWN healthy again (the wedge
  // recovery path pokes this after a successful recover). Strictly a no-op
  // unless a reconnect is actually pending: a healthy bridge is never yanked
  // through a detach/re-attach it did not need.
  const reconnectNow = () => {
    if (closed || !reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectDelayIdx = 0;
    attemptReconnect();
  };

  // Frames arriving before a pane's backfill has been emitted are held so
  // history always renders above live output (attach starts streaming
  // immediately while backfill awaits its own request).
  const heldFrames = new Map();
  const holdFrames = (paneId) => { if (!heldFrames.has(paneId)) heldFrames.set(paneId, []); };
  const releaseFrames = (paneId) => {
    const held = heldFrames.get(paneId);
    heldFrames.delete(paneId);
    for (const data of held || []) emitter.emit('frame', { paneId, data });
  };

  supervisor.on('exit', ({ paneId, source }) => {
    // An observer child dying while its pane is still on screen (daemon
    // bounce, EPIPE) must re-attach, not freeze the pane forever.
    if (source !== 'observe' || closed || !visiblePanes.has(paneId)) return;
    setTimeout(async () => {
      if (closed || !visiblePanes.has(paneId)) return;
      if (supervisor.observers?.has?.(paneId)) return; // already re-attached
      try {
        const size = visiblePanes.get(paneId);
        holdFrames(paneId);
        supervisor.attachObserver(paneId, size);
        emitter.emit('reset', { paneId });
        await backfillPane(paneId);
        releaseFrames(paneId);
      } catch (error) {
        heldFrames.delete(paneId);
        emitter.emit('error', error);
      }
    }, 1000).unref?.();
  });

  supervisor.on('frame', ({ paneId, bytes }) => {
    const data = bytes.toString('base64');
    if (heldFrames.has(paneId)) { heldFrames.get(paneId).push(data); return; }
    emitter.emit('frame', { paneId, data });
  });

  supervisor.on('denied', ({ paneId, reason }) => {
    externalControl.set(paneId, reason || 'controlled by terminal client');
    if (controlledPaneId === paneId) controlledPaneId = null;
    emitControlState(paneId, 'externally-controlled', reason);
  });

  supervisor.on('pane-gone', ({ paneId }) => {
    externalControl.delete(paneId);
    if (controlledPaneId === paneId) controlledPaneId = null;
    emitControlState(paneId, 'released');
  });

  supervisor.on('error', (e) => {
    // Spawn failures (ENOENT, EMFILE) must degrade a pane, never crash the app.
    emitter.emit('error', e);
  });

  supervisor.on('control-released', ({ paneId }) => {
    if (controlledPaneId === paneId) controlledPaneId = null;
    emitControlState(paneId, 'released');
  });

  const backfillPane = async (paneId) => {
    if (!client) return;
    try {
      // recent_unwrapped: logical lines, so xterm re-wraps at the widget's
      // real width instead of inheriting the pane's historical wrap.
      // strip_ansi: cursor-positioning sequences in the history were emitted
      // for the source geometry and corrupt a differently-sized viewport;
      // scrollback is plain text, live frames keep full color.
      const res = await client.readPane(paneId, {
        source: 'recent_unwrapped',
        lines: BACKFILL_LINES,
        strip_ansi: true,
      });
      const text = res?.read?.text;
      // pane.read returns LF-terminated text; a terminal needs CRLF or every
      // line starts at the previous line's end column (staircase).
      if (text) emitter.emit('backfill', { paneId, text: text.replace(/\r?\n/g, '\r\n') });
    } catch (error) {
      emitter.emit('error', error);
    }
  };

  let visiblePanesChain = Promise.resolve();
  const setVisiblePanes = (panes = []) => {
    // Serialize: overlapping calls double-attach observers and double-backfill
    // (renderer fires on every layout event during boot).
    visiblePanesChain = visiblePanesChain.then(() => applyVisiblePanes(panes), () => applyVisiblePanes(panes));
    return visiblePanesChain;
  };

  const applyVisiblePanes = async (panes = []) => {
    const next = new Map();
    for (const pane of panes) {
      if (!pane?.paneId) continue;
      next.set(pane.paneId, {
        cols: pane.cols || 80,
        rows: pane.rows || 24,
      });
    }

    for (const paneId of visiblePanes.keys()) {
      if (!next.has(paneId)) {
        if (controlledPaneId === paneId) {
          supervisor.releaseControl(paneId);
          controlledPaneId = null;
        }
        supervisor.detach(paneId);
      }
    }

    for (const [paneId, size] of next) {
      if (!visiblePanes.has(paneId)) {
        holdFrames(paneId);
        supervisor.attachObserver(paneId, size);
        await backfillPane(paneId);
        releaseFrames(paneId);
      } else {
        const prev = visiblePanes.get(paneId);
        if (prev.cols !== size.cols || prev.rows !== size.rows) {
          supervisor.resize(paneId, size);
        }
      }
    }

    visiblePanes.clear();
    for (const [paneId, size] of next) visiblePanes.set(paneId, size);
  };

  const BLUR_RELEASE_MS = 450;

  const cancelPendingBlurRelease = () => {
    supervisor.cancelScheduledRelease?.();
  };

  const beginAcquireControl = (paneId, size) => {
    cancelPendingBlurRelease();
    externalControl.delete(paneId);

    const onDenied = (event) => {
      if (event.paneId !== paneId) return;
      externalControl.set(paneId, event.reason || 'controlled by terminal client');
      controlledPaneId = null;
      emitControlState(paneId, 'externally-controlled', event.reason);
      publish();
    };
    supervisor.once('denied', onDenied);
    setTimeout(() => supervisor.removeListener('denied', onDenied), 1500).unref();

    try {
      supervisor.acquireControl(paneId, size);
      controlledPaneId = paneId;
      emitControlState(paneId, 'controlled');
      publish();
    } catch (error) {
      supervisor.removeListener('denied', onDenied);
      emitControlState(paneId, 'error', error.message);
      throw error;
    }
  };

  const focusPane = async ({ paneId, workspaceId, cols, rows }) => {
    if (!client || !paneId) throw new Error('pane focus unavailable');

    // Taking control RESIZES the pty, so the fallback here is not cosmetic: an
    // 80x24 default undid the dialog sizing the moment Pat clicked a window or
    // sent anything, and the next dialog clipped again (caught on the live
    // machine right after shipping the sizing, where the focused pane sat at 23
    // rows while every other pane was at 60). A pane with no ">_" view has no
    // human-chosen size to respect, so it keeps the dialog geometry.
    const size = {
      cols: cols || visiblePanes.get(paneId)?.cols || DIALOG_SIZE.cols,
      rows: rows || visiblePanes.get(paneId)?.rows || DIALOG_SIZE.rows,
    };

    // A dialog sizing may be holding a transient controller on this very pane;
    // Control is exclusive per pane, so acquiring on top of it is
    // refused and the pane gets marked externally-controlled. Waiting it out
    // (bounded by the sizer's own timeout) removes the race instead of leaving
    // it to the retry path.
    await supervisor.sizingFor?.(paneId);

    // Acquire control before focus RPCs so select->type does not wait on
    // workspace/tab switching. acquireControl swaps gracefully when another pane
    // is still held.
    if (!(controlledPaneId === paneId && supervisor.controller)) {
      beginAcquireControl(paneId, size);
    } else if (supervisor.controller) {
      supervisor.controller.size = size;
    }

    if (workspaceId && workspaceId !== state.focusedWorkspaceId) {
      await client.focusWorkspace(workspaceId);
      state = { ...state, focusedWorkspaceId: workspaceId };
      publish();
    }

    await client.focusPane(paneId);
    return { ok: true, paneId };
  };

  // A send in flight LEASES the pane's control: renderer blur (a menu click,
  // focus churn) must never release control between the acquire and the last
  // keystroke (live-caught as a flaky "pane is not focused for control").
  // Blur during a lease is deferred and applied when the last lease drops.
  const controlHolds = new Map();
  const pendingBlur = new Set();

  const doBlur = (paneId) => {
    cancelPendingBlurRelease();
    supervisor.releaseControl(paneId);
    controlledPaneId = null;
    emitControlState(paneId, 'released');
    publish(); // the renderer keys display state off controlledPaneId
  };

  const holdControl = (paneId) => {
    if (!paneId) return;
    cancelPendingBlurRelease();
    controlHolds.set(paneId, (controlHolds.get(paneId) || 0) + 1);
  };

  const releaseControlHold = (paneId) => {
    if (!paneId) return;
    const next = (controlHolds.get(paneId) || 0) - 1;
    if (next > 0) { controlHolds.set(paneId, next); return; }
    controlHolds.delete(paneId);
    if (pendingBlur.delete(paneId) && controlledPaneId === paneId) doBlur(paneId);
  };

  const blurPane = (paneId) => {
    if (!paneId || controlledPaneId !== paneId) return { ok: true };
    if (controlHolds.get(paneId)) {
      pendingBlur.add(paneId);
      return { ok: true, deferred: true };
    }
    // Debounce: a quick reselect cancels this timer in beginAcquireControl.
    supervisor.scheduleReleaseControl?.(paneId, BLUR_RELEASE_MS);
    return { ok: true, debounced: true };
  };

  const controlReady = (paneId) => supervisor.controllerReady?.(paneId) ?? true;

  const sendInput = (paneId, text) => {
    if (externalControl.has(paneId)) {
      return { ok: false, reason: externalControl.get(paneId) };
    }
    if (controlledPaneId !== paneId) {
      return { ok: false, reason: 'pane is not focused for control' };
    }
    supervisor.sendInput(paneId, text);
    return { ok: true };
  };

  // Observer respawn is debounced per pane: window drags fire many resize
  // reports, and each observer respawn discards and re-renders the view.
  const observerResizeTimers = new Map();

  const resizePane = (paneId, size) => {
    const entry = visiblePanes.get(paneId);
    if (entry) {
      entry.cols = size.cols;
      entry.rows = size.rows;
    }
    if (controlledPaneId === paneId) {
      supervisor.resize(paneId, size);
    } else if (visiblePanes.has(paneId)) {
      clearTimeout(observerResizeTimers.get(paneId));
      observerResizeTimers.set(paneId, setTimeout(async () => {
        observerResizeTimers.delete(paneId);
        if (!visiblePanes.has(paneId) || controlledPaneId === paneId) return;
        try {
          holdFrames(paneId);
          supervisor.resize(paneId, size); // respawns the observer at the new viewport
          emitter.emit('reset', { paneId }); // renderer clears the stale-width buffer
          await backfillPane(paneId);
          releaseFrames(paneId);
        } catch (error) {
          heldFrames.delete(paneId);
          emitter.emit('error', error);
        }
      }, 300));
    }
    return { ok: true };
  };

  // Grow a pane so Claude's dialogs fit in it (see streams.ensureDialogSize for
  // the measurement). Three rules keep this from fighting anything:
  //
  //   * a pane with an open ">_" view is OWNED by that xterm's fit; the human
  //     is looking at a real terminal and its size is the size they chose.
  //   * a pane that has been sized is left alone, so a success never repeats.
  //   * a FAILED attempt (control refused, pane busy) is retried on a cooldown
  //     rather than never again, because "attempted once" is not "fixed".
  const DIALOG_SIZE_RETRY_MS = 15_000;
  const dialogSized = new Set(); // panes whose pty is known grown
  const dialogSizeTried = new Map(); // paneId -> last attempt ms
  const ensureDialogSize = async (paneId, opts = {}) => {
    if (!paneId) return { ok: false, reason: 'no pane' };
    if (visiblePanes.has(paneId)) return { ok: false, reason: 'the raw terminal owns this pane size' };
    if (dialogSized.has(paneId) && !opts.force) return { ok: false, reason: 'already sized' };
    const last = dialogSizeTried.get(paneId);
    if (last != null && Date.now() - last < DIALOG_SIZE_RETRY_MS) {
      return { ok: false, reason: 'attempted just now' };
    }
    dialogSizeTried.set(paneId, Date.now());
    try {
      const res = await supervisor.ensureDialogSize(paneId, DIALOG_SIZE);
      if (res?.ok) dialogSized.add(paneId);
      return res;
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  };

  // EVERY pane, not just the ones with a window open on them.
  //
  // Live-caught 2026-07-28, an hour after the sizing shipped: two of twelve
  // panes were still 23x54 because sizing only ran from the question card's
  // poll, and that poll only exists while a session has an OPEN WINDOW. A
  // session can be asked a question with its window closed, and Pat would open
  // it onto exactly the clipped dialog this was supposed to end. The pane is
  // Harbor's to size whether or not anything is looking at it, so a slow sweep
  // covers boot, panes created later, and any attempt that was refused the
  // first time. Serialized: twelve transient control attaches at once is a
  // storm, one at a time is unnoticeable.
  const SWEEP_MS = 20_000;
  let sweepTimer = null;
  let sweeping = false;
  const sizeAllPanes = async () => {
    if (sweeping || closed) return;
    sweeping = true;
    try {
      const paneIds = Object.values(state.layouts || {})
        .flatMap((layout) => (layout.panes || []).map((pane) => pane.pane_id))
        .filter(Boolean);
      for (const paneId of new Set(paneIds)) {
        if (closed) break;
        if (dialogSized.has(paneId) || visiblePanes.has(paneId)) continue;
        await ensureDialogSize(paneId);
      }
    } finally {
      sweeping = false;
    }
  };
  const startPaneSizeSweep = () => {
    if (sweepTimer) return;
    sizeAllPanes().catch(() => {});
    sweepTimer = setInterval(() => { sizeAllPanes().catch(() => {}); }, SWEEP_MS);
    sweepTimer.unref?.();
  };
  const stopPaneSizeSweep = () => {
    clearInterval(sweepTimer);
    sweepTimer = null;
  };

  const focusWorkspace = async (workspaceId) => {
    if (!client) throw new Error('workspace focus unavailable');
    await client.focusWorkspace(workspaceId);
    state = { ...state, focusedWorkspaceId: workspaceId };
    publish();
    return { ok: true, workspaceId };
  };

  const createWorkspace = async (params = {}) => {
    const res = await client.createWorkspace(params);
    publish();
    return res;
  };

  const closeWorkspace = async (workspaceId) => {
    await client.closeWorkspace(workspaceId);
    publish();
    return { ok: true };
  };

  const refreshLayout = async (tabId) => {
    if (!client || !tabId) return;
    try {
      const res = await client.exportLayout({ tab_id: tabId });
      if (res?.layout?.tab_id) {
        // Same guard as applyLayoutEvent: a transient empty export must not
        // clobber a known-good layout.
        const existing = state.layouts[res.layout.tab_id];
        if (!res.layout.panes?.length && existing?.panes?.length) return;
        state = {
          ...state,
          layouts: { ...state.layouts, [res.layout.tab_id]: res.layout },
        };
        publish();
      }
    } catch (error) {
      emitter.emit('error', error);
    }
  };

  const focusTab = async (tabId) => {
    await client.focusTab(tabId);
    // Reflect the switch locally after the ack: the UI must not depend on
    // daemon event delivery for its own action (same treatment tab.rename
    // needed; the events are late or absent under load).
    const target = state.tabs.find((t) => t.tab_id === tabId);
    if (target) {
      state = {
        ...state,
        tabs: state.tabs.map((t) => {
          if (t.tab_id === tabId) return { ...t, focused: true };
          if (t.workspace_id === target.workspace_id && t.focused) return { ...t, focused: false };
          return t;
        }),
      };
    }
    await refreshLayout(tabId);
    publish();
    return { ok: true, tabId };
  };

  const createTab = async (params = {}) => {
    const res = await client.createTab(params);
    publish();
    return res;
  };

  const closeTab = async (tabId) => {
    await client.closeTab(tabId);
    publish();
    return { ok: true, tabId };
  };

  const renameTab = async (tabId, label) => {
    await client.renameTab(tabId, label);
    // The daemon acks the rename but does not reliably emit a tab.renamed event for
    // it, so the incremental state never picks up the new label. Reflect it
    // locally (a later snapshot/event reconciles if the daemon disagrees).
    state = {
      ...state,
      tabs: state.tabs.map((t) => (t.tab_id === tabId ? { ...t, label } : t)),
    };
    publish();
    return { ok: true, tabId, label };
  };

  // The sidebar's open-session path. The pane's TAB may not be the front tab
  // of its workspace (the exact case a sidebar-only navigation hits all the
  // time), so resolve which tab owns the pane and bring IT forward first;
  // otherwise the wrong tab stays on screen while control lands on a hidden
  // pane (and the old focused-tab lookup mis-sized it to 80x24 on top).
  const findPaneTabId = async (paneId) => {
    for (const [tabId, layout] of Object.entries(state.layouts || {})) {
      if (layout?.panes?.some((p) => p.pane_id === paneId)) return tabId;
    }
    try {
      const res = await client.snapshot();
      const snap = res?.snapshot || res || {};
      // A reconnect can leave subscription-derived tab state empty while the
      // request socket already has a current snapshot. Keep the ownership
      // metadata needed by the last-tab workspace fallback.
      if (snap.tabs) state = { ...state, tabs: snap.tabs };
      return (snap.panes || []).find((p) => p.pane_id === paneId)?.tab_id || null;
    } catch {
      return null;
    }
  };

  const requestFocusPane = async ({ paneId, workspaceId }) => {
    cancelPendingBlurRelease();

    // Same rule as focusPane, and this is the path EVERY send takes: taking
    // control resizes the pty, so an 80x24 fallback here silently shrank the
    // pane back under the dialog. Caught on the live machine holding a working
    // pane at 24 rows while every other pane was at 60.
    const rendered = visiblePanes.get(paneId);
    let cols = rendered?.cols || DIALOG_SIZE.cols;
    let rows = rendered?.rows || DIALOG_SIZE.rows;

    await supervisor.sizingFor?.(paneId);

    // Pre-warm control with the renderer-reported size before tab/layout RPCs.
    if (!(controlledPaneId === paneId && supervisor.controller)) {
      beginAcquireControl(paneId, { cols, rows });
    }

    if (workspaceId) await focusWorkspace(workspaceId);
    const tabId = await findPaneTabId(paneId);
    if (tabId) {
      const tab = state.tabs.find((t) => t.tab_id === tabId);
      if (!tab || !tab.focused || tab.workspace_id !== (workspaceId || state.focusedWorkspaceId)) {
        await focusTab(tabId);
      }
      // A fresh tab's layout can lag its pane (live-caught): retry briefly so
      // the pane actually renders instead of leaving an empty grid.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        if (state.layouts[tabId]?.panes?.length) break;
        await refreshLayout(tabId);
        if (state.layouts[tabId]?.panes?.length) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      controlledPaneTabId = tabId;
      const layout = layoutForTab(state.layouts, tabId);
      const paneLayout = layout?.panes?.find((p) => p.pane_id === paneId);
      const layoutCols = paneLayout?.rect?.width;
      const layoutRows = paneLayout?.rect?.height;
      if (layoutCols && layoutRows && (layoutCols !== cols || layoutRows !== rows)) {
        cols = layoutCols;
        rows = layoutRows;
        if (controlledPaneId === paneId) supervisor.resize(paneId, { cols, rows });
      }
    }

    // Daemon focus is UI state; control is already acquiring above.
    if (workspaceId && workspaceId !== state.focusedWorkspaceId) {
      await client.focusWorkspace(workspaceId);
      state = { ...state, focusedWorkspaceId: workspaceId };
      publish();
    }
    await client.focusPane(paneId);
    externalControl.delete(paneId);
    return { ok: true, paneId };
  };

  const paneInSnapshot = async (paneId) => {
    const res = await client.snapshot();
    const snap = res?.snapshot || res || {};
    return (snap.panes || []).some((pane) => pane.pane_id === paneId);
  };

  const pidAlive = (pid) => {
    if (!pid) return false;
    try { processKill(pid, 0); return true; }
    catch (error) {
      if (error?.code === 'ESRCH') return false;
      throw error;
    }
  };

  const verifyGone = async (paneId, shellPid = null) => {
    for (let attempt = 0; attempt < closePollAttempts; attempt += 1) {
      let panePresent = true;
      try { panePresent = await paneInSnapshot(paneId); } catch { /* retry */ }
      const processPresent = shellPid ? pidAlive(shellPid) : false;
      if (!panePresent && !processPresent) return true;
      if (attempt + 1 < closePollAttempts) await sleep(closePollIntervalMs);
    }
    return false;
  };

  // SIGTERM `target` (a negative pgid, or a bare pid), escalating to SIGKILL at
  // the poll midpoint, until `shellPid` is gone. Returns { gone, reason }.
  // Shared by the pane-signal fallback and the closePaneTab orphan reap so both
  // kill the same documented way.
  const killTarget = async (target, shellPid) => {
    try {
      processKill(target, 'SIGTERM');
    } catch (error) {
      if (error?.code !== 'ESRCH') return { gone: false, reason: `SIGTERM failed: ${error.message}` };
    }
    let processGone = !shellPid;
    for (let attempt = 0; attempt < closePollAttempts; attempt += 1) {
      if (!shellPid || !pidAlive(shellPid)) { processGone = true; break; }
      if (attempt === Math.floor(closePollAttempts / 2)) {
        // SIGTERM is ignorable (interactive shells ignore it); escalate.
        try { processKill(target, 'SIGKILL'); } catch { /* ESRCH is fine */ }
        if (shellPid && target !== shellPid) {
          try { processKill(shellPid, 'SIGKILL'); } catch { /* ESRCH is fine */ }
        }
      }
      if (attempt + 1 < closePollAttempts) await sleep(closePollIntervalMs);
    }
    return { gone: processGone };
  };

  const signalPane = async (paneId) => {
    let info;
    try {
      const res = await client.processInfo(paneId);
      info = res?.process_info || res?.processInfo || res;
    } catch (error) {
      return { ok: false, method: 'signal', verified: false, reason: `process info failed: ${error.message}` };
    }
    const shellPid = info?.shell_pid;
    const pgid = info?.foreground_process_group_id;
    const target = pgid ? -pgid : shellPid;
    if (!target) {
      return { ok: false, method: 'signal', verified: false, reason: 'no shell pid or process group found for pane' };
    }
    const { gone, reason } = await killTarget(target, shellPid);
    if (reason) return { ok: false, method: 'signal', verified: false, reason };
    if (!gone) {
      return { ok: false, method: 'signal', verified: false, reason: 'pane process survived SIGTERM and SIGKILL' };
    }
    // The daemon can keep a dead pane in its layout after the shell dies, and
    // the chip row only drops once the pane leaves the snapshot; reap it.
    try {
      if (await paneInSnapshot(paneId)) await client.closePane(paneId);
    } catch { /* best effort; verifyGone below is the arbiter */ }
    const verified = await verifyGone(paneId, shellPid);
    return verified
      ? { ok: true, method: 'signal', verified: true }
      : { ok: false, method: 'signal', verified: false, reason: 'pane process is dead but the pane did not leave the daemon snapshot' };
  };

  // Worker close from the chip menu. RPC acknowledgement is never success by
  // itself: each layer is followed by a fresh snapshot, then the documented
  // exact-process SIGTERM path if the daemon left the pane alive.
  const closePaneTab = async (paneId, { force = false } = {}) => {
    if (!client || !paneId) {
      return { ok: false, method: force ? 'signal' : 'pane', verified: false, reason: 'pane close unavailable' };
    }
    if (force) return signalPane(paneId);

    // Capture the pane's process BEFORE the close. A clean tab/pane close removes
    // the pane from the daemon but can ORPHAN its process: a worker's
    // `claude --resume` (and its MCP-server children) survives the pty teardown,
    // so pane-absence alone must never read as "worker killed". Once the pane is
    // gone processInfo can no longer resolve it, so the pid captured here is the
    // only handle left to verify the process actually died and reap it.
    let shellPid = null;
    let pgid = null;
    try {
      const res = await client.processInfo(paneId);
      const info = res?.process_info || res?.processInfo || res;
      shellPid = info?.shell_pid || null;
      pgid = info?.foreground_process_group_id || null;
    } catch { /* pane may already be gone; best effort */ }

    const tabId = await findPaneTabId(paneId);
    let method = tabId ? 'tab' : 'pane';
    try {
      if (tabId) {
        const tab = state.tabs.find((item) => item.tab_id === tabId);
        try {
          await client.closeTab(tabId);
        } catch (error) {
          if (/last tab/i.test(String(error?.message || '')) && tab?.workspace_id) {
            await client.closeWorkspace(tab.workspace_id);
          } else {
            throw error;
          }
        }
      } else {
        await client.closePane(paneId);
      }
      publish();
    } catch (error) {
      return { ok: false, method, verified: false, reason: error.message };
    }

    // Verified requires BOTH the pane gone AND, when the pid is known, the process
    // dead. A pane that leaves the snapshot while its process lives is a HALF
    // kill: escalate to an exact SIGTERM/SIGKILL on the captured target (the
    // process group so the worker's MCP children die with it), reap any lingering
    // pane, then re-verify.
    if (await verifyGone(paneId, shellPid)) return { ok: true, method, verified: true };
    if (shellPid && pidAlive(shellPid)) {
      const target = pgid ? -pgid : shellPid;
      const { gone } = await killTarget(target, shellPid);
      try {
        if (await paneInSnapshot(paneId)) await client.closePane(paneId);
      } catch { /* best effort; verifyGone below is the arbiter */ }
      if (gone && await verifyGone(paneId, shellPid)) {
        return { ok: true, method: `${method}+signal`, verified: true };
      }
      return { ok: false, method: `${method}+signal`, verified: false, reason: 'pane closed but its process survived SIGTERM and SIGKILL' };
    }
    return signalPane(paneId);
  };

  const connect = async () => {
    subscription?.close?.();
    client = makeClient({
      sessionSocketPath: options.sessionSocketPath,
      sessionStorePolicy: options.sessionStorePolicy,
      env: options.env,
    });
    {
      const boot = await client.bootstrap({
        onEvent: applyEvent,
        onResync: (freshSnapshot, { discarded }) => {
          if (discarded) console.log('terminal-bridge: resync after replay settle, discarded', discarded, 'events');
          seedFromSnapshot({ snapshot: freshSnapshot });
          publish();
        },
        onResyncError: (e) => emitter.emit('error', e),
      });
      subscription = boot.subscription;
      // Never crash the app on socket errors; reconnect on connection loss.
      subscription.on('error', (e) => emitter.emit('error', e));
      subscription.on('close', () => { if (!closed) scheduleReconnect(); });
      seedFromSnapshot(boot.snapshot);
      const tab = focusedTabForWorkspace(state.tabs, state.focusedWorkspaceId);
      if (tab?.tab_id && !state.layouts[tab.tab_id]) {
        await refreshLayout(tab.tab_id);
      } else {
        publish();
      }
    }
  };

  const start = async () => {
    try {
      await connect();
    } catch (error) {
      emitter.emit('error', error);
      publish();
    }
  };

  const close = () => {
    closed = true;
    clearTimeout(reconnectTimer);
    stopPaneSizeSweep();
    supervisor.detach();
    subscription?.close?.();
    subscription = null;
    client = null;
  };

  return {
    emitter,
    supervisor,
    start,
    close,
    reconnectNow,
    getState,
    setVisiblePanes,
    focusPane,
    blurPane,
    controlReady,
    holdControl,
    releaseControlHold,
    sendInput,
    resizePane,
    ensureDialogSize,
    sizeAllPanes,
    startPaneSizeSweep,
    stopPaneSizeSweep,
    focusWorkspace,
    createWorkspace,
    closeWorkspace,
    focusTab,
    createTab,
    closeTab,
    renameTab,
    requestFocusPane,
    closePaneTab,
    seedFromSnapshot,
    applyEvent,
  };
}

module.exports = {
  createTerminalBridge,
  applyWorkspaceEvent,
  applyTabEvent,
  applyLayoutEvent,
  layoutsToMap,
};
