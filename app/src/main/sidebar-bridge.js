'use strict';

const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const { createControlClient } = require('./session-daemon/factory.js');
const { createHistoryProvider } = require('./providers/history.js');
const { createProviderHistory } = require('./providers/provider-history.js');
const { createProviderSessionLinker } = require('./providers/provider-session-link.js');
const { mergeSidebarModel } = require('../shared/sidebar-model.cjs');

function extractLiveState(snapshot) {
  const snap = snapshot?.snapshot || snapshot || {};
  return {
    workspaces: snap.workspaces || [],
    panes: (snap.panes || []).filter((pane) => pane.agent_session || pane.agent),
  };
}

function applyPaneEvent(state, event) {
  const kind = event?.event;
  const data = event?.data || {};
  if (!kind?.startsWith('pane.')) return state;

  const panes = [...state.panes];
  const workspaces = [...state.workspaces];

  if (kind === 'pane.created' || kind === 'pane.updated') {
    const pane = data.pane;
    if (!pane) return state;
    const idx = panes.findIndex((p) => p.pane_id === pane.pane_id);
    if (idx >= 0) {
      // Preserve agent facts learned from pane.agent_detected: pane.updated
      // records do not always carry them. EXPLICIT nulls are the agent
      // exiting (the CLI crashed or quit back to the shell) and must clear
      // the facts: keeping them left a crashed session green for 90 minutes
      // and routed its next send into bash (live-caught 2026-07-22).
      const merged = { ...panes[idx], ...pane };
      if (!merged.agent && !merged.agent_session) {
        return { workspaces, panes: panes.filter((p) => p.pane_id !== pane.pane_id) };
      }
      panes[idx] = merged;
    } else if (pane.agent_session || pane.agent) {
      // Same filter as the snapshot path: plain shell panes are not sessions
      // and must not light a project live.
      panes.push(pane);
    }
    return { workspaces, panes };
  }

  if (kind === 'pane.agent_detected') {
    // A claude (or other agent) appeared in an existing pane. The event body
    // carries agent + pane_id but no pane record (verified live 2026-07-17).
    const paneId = data.pane_id;
    if (!paneId) return state;
    const idx = panes.findIndex((p) => p.pane_id === paneId);
    if (idx >= 0) panes[idx] = { ...panes[idx], agent: data.agent || panes[idx].agent };
    else panes.push({ pane_id: paneId, workspace_id: data.workspace_id, agent: data.agent });
    return { workspaces, panes };
  }

  if (kind === 'pane.agent_status_changed') {
    const paneId = data.pane_id;
    const agentStatus = data.agent_status;
    if (!paneId || !agentStatus) return state;
    const idx = panes.findIndex((p) => p.pane_id === paneId);
    if (idx < 0) return state;
    if (agentStatus === 'unknown') {
      // 'unknown' is herdr's "no foreground agent owns this pane": the CLI
      // exited or crashed back to the shell. A plain shell pane is not a
      // session (same filter as the snapshot path), so drop it; re-detection
      // re-adds it via pane.agent_detected. Keeping stale agent facts kept a
      // crashed session green for 90 minutes and routed its next send into
      // bash (live-caught 2026-07-22).
      return { workspaces, panes: panes.filter((p) => p.pane_id !== paneId) };
    }
    if (panes[idx].agent_status === agentStatus) return state;
    panes[idx] = { ...panes[idx], agent_status: agentStatus };
    return { workspaces, panes };
  }

  if (kind === 'pane.closed') {
    const paneId = data.pane_id || data.pane?.pane_id;
    return { workspaces, panes: panes.filter((p) => p.pane_id !== paneId) };
  }

  return state;
}

function applyWorkspaceEvent(state, event) {
  const kind = event?.event;
  const data = event?.data || {};
  if (!kind?.startsWith('workspace.')) return state;

  const panes = [...state.panes];
  const workspaces = [...state.workspaces];

  if (kind === 'workspace.closed') {
    const workspaceId = data.workspace_id || data.workspace?.workspace_id;
    return {
      workspaces: workspaces.filter((w) => w.workspace_id !== workspaceId),
      panes: panes.filter((p) => p.workspace_id !== workspaceId),
    };
  }

  if (kind === 'workspace.created') {
    const workspace = data.workspace;
    if (!workspace) return state;
    if (!workspaces.some((w) => w.workspace_id === workspace.workspace_id)) {
      workspaces.push(workspace);
    }
    return { workspaces, panes };
  }

  if (kind === 'workspace.updated') {
    const workspace = data.workspace;
    if (!workspace) return state;
    const idx = workspaces.findIndex((w) => w.workspace_id === workspace.workspace_id);
    if (idx >= 0) workspaces[idx] = workspace;
    else workspaces.push(workspace);
    return { workspaces, panes };
  }

  return state;
}

function createSidebarBridge(options = {}) {
  const history = options.history || createHistoryProvider();
  // Codex/cursor sessions ride their own transcript stores; without these
  // rows the rail was Claude-only and non-Claude windows had no identity.
  const providerHistory = options.providerHistory === null
    ? null
    : options.providerHistory || createProviderHistory({ projectLabelForCwd: options.projectLabelForCwd });
  const makeClient = options.createControlClient || createControlClient;
  const emitter = new EventEmitter();
  let liveState = { workspaces: [], panes: [] };
  let historySessions = [];
  // indexerSessionCount keeps its contract: harbor-index.py's CLAUDE session
  // count (the boot spec compares it against `emit --all` directly); provider
  // rows ride historySessions but never inflate it.
  let claudeHistoryCount = 0;
  let homes = {};
  let herdrClient = null;
  let subscription = null;
  let refreshTimer = null;
  let statusPublishTimer = null;
  let closed = false;

  // Herdr's agent detector names a codex/cursor pane's agent but never its
  // session (agent_session stays null, verified live 2026-07-25), so those
  // windows had no transcript and fell back to the raw terminal. The linker
  // resolves the id from the CLI's own argv and files.
  const providerLinker = options.providerSessionLinker === null ? null : (
    options.providerSessionLinker || createProviderSessionLinker({
      listPanes: () => liveState.panes,
      paneAgentProcess: async (paneId) => {
        if (!herdrClient) return null;
        const res = await herdrClient.processInfo(paneId);
        const procs = (res?.process_info || res || {}).foreground_processes || [];
        // The deepest foreground child is the agent itself (`node …/bin/codex`
        // spawns the real binary); its start is the pane's agent clock.
        const proc = procs[procs.length - 1];
        if (!proc?.pid) return null;
        // On Linux the /proc/<pid> directory is created at fork, so its mtime
        // IS the process start time (checked against `ps -o lstart`).
        const stat = await fsp.stat(`/proc/${proc.pid}`).catch(() => null);
        if (!stat) return null;
        return {
          pid: proc.pid,
          startedMs: stat.mtimeMs,
          cwd: proc.cwd || null,
          argv: proc.argv || [],
        };
      },
      readPaneText: async (paneId) => {
        if (!herdrClient) return '';
        const res = await herdrClient.readPane(paneId, {
          source: 'recent', lines: 120, strip_ansi: true,
        });
        return res?.read?.text || '';
      },
    })
  );

  const publish = () => {
    if (closed) return;
    const model = mergeSidebarModel({
      historySessions,
      // Herdr never names a codex/cursor session; the linker fills the id in
      // from the CLI's own files so those panes merge with their history row
      // instead of floating as anonymous live: entries.
      livePanes: providerLinker ? providerLinker.apply(liveState.panes) : liveState.panes,
      workspaces: liveState.workspaces,
      homes,
    });
    emitter.emit('update', {
      model,
      historyCount: historySessions.length,
      indexerSessionCount: claudeHistoryCount,
    });
  };

  // Agent status can chatter during tool transitions. Collapse a same-frame
  // burst into one sidebar render while still forwarding every raw event to
  // the notification driver.
  const scheduleStatusPublish = () => {
    if (statusPublishTimer) return;
    statusPublishTimer = setTimeout(() => {
      statusPublishTimer = null;
      publish();
    }, 16);
    statusPublishTimer.unref?.();
  };

  const onPaneAgentStatus = (event) => {
    const previousState = liveState;
    liveState = applyPaneEvent(liveState, event);
    emitter.emit('pane-agent-status', event);
    if (liveState !== previousState) scheduleStatusPublish();
  };

  const refreshHistory = async () => {
    const [sessions, homeMap] = await Promise.all([
      history.listSessions(),
      history.sessionHomes(),
    ]);
    const claudeRows = sessions.map((row) => ({
      ...row,
      home: homeMap[row.id] ?? null,
    }));
    let providerRows = [];
    if (providerHistory) {
      // Cursor never records its cwd; reverse the munge from cwds Harbor
      // already knows (claude history + live workspaces).
      const knownCwds = new Set(claudeRows.map((row) => row.cwd).filter(Boolean));
      for (const workspace of liveState.workspaces || []) {
        if (workspace?.cwd) knownCwds.add(workspace.cwd);
      }
      try {
        providerRows = await providerHistory.listSessions({ knownCwds: [...knownCwds] });
      } catch (error) {
        emitter.emit('error', error);
      }
    }
    historySessions = [...claudeRows, ...providerRows];
    claudeHistoryCount = claudeRows.length;
    homes = homeMap;
    publish();
  };

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshHistory().catch((error) => emitter.emit('error', error));
    }, 250);
  };

  let reconnectTimer = null;
  let reconnectDelayIdx = 0;
  const RECONNECT_DELAYS = [2000, 5000, 10000, 30000];
  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    const delay = RECONNECT_DELAYS[Math.min(reconnectDelayIdx++, RECONNECT_DELAYS.length - 1)];
    reconnectTimer = setTimeout(async () => {
      if (closed) return;
      try {
        await connectHerdr();
        reconnectDelayIdx = 0;
      } catch {
        scheduleReconnect();
      }
    }, delay);
    reconnectTimer.unref?.();
  };

  const connectHerdr = async () => {
    subscription?.close?.();
    herdrClient = makeClient({ ...(options.herdrOptions || {}), HerdrClient: options.HerdrClient });
    try {
      const boot = await herdrClient.bootstrap({
        onResyncError: (e) => emitter.emit('error', e),
        onResync: (freshSnapshot, { discarded }) => {
          if (discarded) console.log('sidebar-bridge: resync after replay settle, discarded', discarded, 'events');
          liveState = extractLiveState({ snapshot: freshSnapshot });
          publish();
        },
        onEvent: (event) => {
          liveState = applyWorkspaceEvent(liveState, event);
          if (event?.event === 'pane.agent_status_changed') {
            onPaneAgentStatus(event);
          } else {
            liveState = applyPaneEvent(liveState, event);
            publish();
          }
        },
      });
      subscription = boot.subscription;
      subscription.on('error', (e) => emitter.emit('error', e));
      subscription.on('close', () => { if (!closed) scheduleReconnect(); });
      liveState = extractLiveState(boot.snapshot);
      publish();
    } catch (error) {
      emitter.emit('herdr-error', error);
      publish();
      throw error;
    }
  };

  const start = async () => {
    history.on('history-changed', scheduleRefresh);
    if (providerHistory) {
      providerHistory.emitter.on('changed', scheduleRefresh);
      providerHistory.start();
    }
    if (providerLinker) {
      // A newly named session needs its history row too: the rail merges the
      // live pane onto that row, and the window opens its transcript by id.
      providerLinker.emitter.on('link', (link) => {
        emitter.emit('provider-session-linked', link);
        scheduleRefresh();
      });
      providerLinker.emitter.on('changed', publish);
      providerLinker.emitter.on('error', (error) => emitter.emit('error', error));
      providerLinker.start();
    }
    await refreshHistory();
    try {
      await connectHerdr();
    } catch {
      // Degraded boot (daemon absent): history works; reconnect keeps trying.
      scheduleReconnect();
    }
  };

  const focusLivePane = async ({ paneId, workspaceId }) => {
    if (!herdrClient || !paneId) throw new Error('pane focus unavailable');
    if (workspaceId) await herdrClient.focusWorkspace(workspaceId);
    return herdrClient.focusPane(paneId);
  };

  const close = () => {
    closed = true;
    clearTimeout(refreshTimer);
    clearTimeout(statusPublishTimer);
    clearTimeout(reconnectTimer);
    history.removeAllListeners('history-changed');
    history.close?.();
    providerHistory?.emitter.removeAllListeners('changed');
    providerHistory?.close();
    providerLinker?.emitter.removeAllListeners();
    providerLinker?.close();
    subscription?.close?.();
    subscription = null;
    herdrClient = null;
  };

  return {
    emitter,
    start,
    refreshHistory,
    onPaneAgentStatus,
    focusLivePane,
    close,
    // Claude ids resolve through the indexer; codex/cursor ids through the
    // provider scan (path + provider, so transcript open needs no hints).
    getSessionMeta: async (id) => {
      try {
        return await history.sessionMeta(id);
      } catch (error) {
        const providerMeta = providerHistory?.metaFor(id);
        if (providerMeta) return providerMeta;
        throw error;
      }
    },
    getSessionPreview: (id) => history.sessionPreview(id),
    // A send is the moment a codex pane's first prompt hits disk; resolving
    // right then names the session in seconds instead of at the next tick.
    resolveProviderSessions: () => providerLinker?.resolveNow() ?? false,
    providerSessionForPane: (paneId) => providerLinker?.get(paneId) ?? null,
    getState: () => ({
      model: mergeSidebarModel({
        historySessions,
        livePanes: providerLinker ? providerLinker.apply(liveState.panes) : liveState.panes,
        workspaces: liveState.workspaces,
        homes,
      }),
      historyCount: historySessions.length,
      indexerSessionCount: claudeHistoryCount,
    }),
  };
}

module.exports = {
  createSidebarBridge,
  extractLiveState,
  applyPaneEvent,
  applyWorkspaceEvent,
};
