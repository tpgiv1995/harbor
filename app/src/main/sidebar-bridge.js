'use strict';

const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const { createControlClient } = require('./session-daemon/factory.js');
const { createHistoryProvider } = require('./providers/history.js');
const { createProviderHistory } = require('./providers/provider-history.js');
const { buildProviderPreview } = require('./providers/provider-preview.js');
const { createProviderSessionLinker } = require('./providers/provider-session-link.js');
const { mergeSidebarModel, sleptSince } = require('../shared/sidebar-model.cjs');
const { parseLocalDateTime } = require('../shared/date-roll.cjs');
const { freshWorking } = require('../shared/claude-turn-state.cjs');
const { createDelegationIndex, buildDelegationGroups, ageDelegationGroups, delegationSummaries, mergeDelegationLinks } = require('./providers/delegations.js');
const { createSingleFlight } = require('./single-flight.js');
const { createSidebarPublisher } = require('../shared/sidebar-sync.cjs');
const { isSubSession, subSessionReadOnly, interactiveAgentArgv, listSubSessions } = require('../shared/sub-sessions.cjs');

// The home map the rail renders from, with launch-known accounts filled in
// where the index has nothing to say yet. Returns the SAME object when there is
// nothing to add, so an idle publish allocates nothing.
function withLaunchedHomes(homes, launched) {
  if (!launched || launched.size === 0) return homes;
  let merged = null;
  for (const [id, home] of launched) {
    // A key the index HAS answers for itself, including a deliberate null: the
    // index looked and found no home, which is a fact, not a gap.
    if (!home || Object.hasOwn(homes, id)) continue;
    merged = merged || { ...homes };
    merged[id] = home;
  }
  return merged || homes;
}

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
      // 'unknown' means no foreground agent owns this pane: the CLI
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
    : options.providerHistory || createProviderHistory({
      projectLabelForCwd: options.projectLabelForCwd,
      profiles: options.profiles,
      metadataFile: options.providerMetadataFile,
      factsCacheFile: options.providerFactsCacheFile,
    });
  const makeClient = options.createControlClient || createControlClient;
  const emitter = new EventEmitter();
  const publisher = createSidebarPublisher();
  let paneRows = new Map();
  let liveState = { workspaces: [], panes: [] };
  let historySessions = [];
  let historyById = new Map();
  const delegationIndex = options.delegationIndex === null ? null : options.delegationIndex || createDelegationIndex(options.ownerOptions, { cacheFile: options.delegationScanCacheFile || null });
  let delegationGroups = [];
  // Identity outlives the 48h evidence window. Keep only child -> parent ids,
  // never commands or prompts, in the relocated cache selected by composition.
  let delegationLinks = null;
  let seededHistory = null; let previousEvidenceIds = new Set(); let summaryIds = new Set();
  const sessionId = (p) => typeof p?.agent_session === 'string' ? p.agent_session : p?.agent_session?.value;
  const interactivePanes = new Map();
  const resolvedPanes = () => (providerLinker ? providerLinker.apply(liveState.panes) : liveState.panes)
    .map((pane) => ({ ...pane, isLiveInteractive: interactivePanes.get(pane.pane_id)?.interactive === true }));
  const liveSessionIds = () => resolvedPanes().map(sessionId).filter(Boolean);
  const refreshDelegations = createSingleFlight(async () => {
    if (!delegationIndex || closed) return;
    if (delegationLinks === null) {
      delegationLinks = options.delegationLinksFile
        ? await fsp.readFile(options.delegationLinksFile, 'utf8').then((text) => JSON.parse(text).links || {}).catch(() => ({})) : {};
    }
    const liveIds = liveSessionIds();
    // Durable exact links must reach the evidence scan on its first pass too.
    if (seededHistory !== historySessions) {
      for (const row of historySessions) row.delegatedBy = row.lineage?.parentThreadId || delegationLinks[row.id] || null;
      seededHistory = historySessions;
    }
    const result = await delegationIndex.scan(historySessions, liveIds);
    if (closed) return;
    const built = result.built || buildDelegationGroups(result.parents, result.providers);
    const updates = Object.fromEntries(Object.entries(built.delegatedBy).filter(([id, parent]) => delegationLinks[id] !== parent));
    for (const dispatch of built.dispatches) if (dispatch.resumeId && delegationLinks[dispatch.resumeId] && !built.delegatedBy[dispatch.resumeId]) updates[dispatch.resumeId] = null;
    if (Object.keys(updates).length) {
      if (options.delegationLinksFile) delegationLinks = await mergeDelegationLinks(options.delegationLinksFile, updates);
      else for (const [id, parent] of Object.entries(updates)) { if (parent) delegationLinks[id] = parent; else delete delegationLinks[id]; }
      delegationIndex.updateLinks?.(updates);
    }
    const dispatched = new Set(built.dispatches.map((d) => `${d.parentId}:${d.id}`));
    for (const parent of result.parents) for (const task of parent.background.tasks) task.delegated = dispatched.has(`${parent.id}:${task.id}`);
    delegationGroups = built.groups;
    const parents = new Map(result.parents.map((p) => [p.id, p]));
    const summaries = delegationSummaries(delegationGroups, Date.now(), liveSessionIds());
    const changedIds = new Set([...previousEvidenceIds, ...parents.keys(), ...Object.keys(updates), ...summaryIds, ...summaries.keys()]);
    previousEvidenceIds = new Set(parents.keys()); summaryIds = new Set(summaries.keys());
    const patches = new Map();
    let membershipChanged = false;
    for (const id of changedIds) {
      const row = historyById.get(id); if (!row) continue;
      const wasSubSession = isSubSession(row);
      const background = parents.get(row.id)?.background;
      row.ownerEvidence = parents.get(row.id)?.ownerEvidence;
      if (background) row.background = { ...background, tasks: undefined, outstanding: (background.outstanding || []).map(({ command, prompt, rounds, ...task }) => task) };
      row.delegatedBy = row.lineage?.parentThreadId || delegationLinks[row.id] || null;
      membershipChanged ||= wasSubSession !== isSubSession(row);
      patches.set(id, { background: row.background || null, ownerEvidence: row.ownerEvidence || null,
        delegatedBy: row.delegatedBy || null, isSubSession: isSubSession(row), delegationSummary: summaries.get(id) || null });
    }
    // Evidence refreshes may follow an idle event. Reuse the resident rail
    // rows here, rather than rebuilding and diffing the whole history again.
    if (membershipChanged) { publish(); return; }
    const delta = publisher.patchRows(patches);
    if (delta) emitter.emit('update', { ...publisher.getState(), delta });
  });
  // indexerSessionCount keeps its contract: harbor-index.py's CLAUDE session
  // count (the boot spec compares it against `emit --all` directly); provider
  // rows ride historySessions but never inflate it.
  let claudeHistoryCount = 0;
  let homes = {};
  // The account of a session Harbor launched ITSELF, held until the history
  // index learns it independently. A row's home comes from the index, the index
  // is built from transcript files, and a claude session writes no transcript
  // until its first message: the gap is minutes, and it is not blank, because
  // an unknown home resolves to the DEFAULT profile's badge. So a session
  // started on the third plan wore the first plan's letter (2026-08-09, Pat
  // clicked the rail's `S` five times in two minutes because a badge naming the
  // wrong plan and a button that did nothing look exactly alike).
  const launchedHomes = new Map();
  let daemonClient = null;
  let subscription = null;
  let refreshTimer = null;
  let statusPublishTimer = null;
  let closed = false;
  // Which sessions the daemon put to sleep (daemon/dormant-ledger.js), so the
  // rail can tell "Harbor put this to sleep" from "not running" (2026-10-06).
  // Read on connect and then every 15 s: a sleep is decided on the daemon's
  // own sweep, minutes apart, so this is one small request on a slow clock.
  // A daemon that predates the verb stops the polling until the next connect.
  let dormantSessions = {};
  let dormantTimer = null;
  let dormantSupported = true;
  const DORMANT_POLL_MS = 15_000;

  // Agent detection names a codex/cursor pane's agent but not its session, so those
  // windows had no transcript and fell back to the raw terminal. The linker
  // resolves the id from the CLI's own argv and files.
  const providerLinker = options.providerSessionLinker === null ? null : (
    options.providerSessionLinker || createProviderSessionLinker({
      profiles: options.profiles,
      listPanes: () => liveState.panes,
      paneAgentProcess: async (paneId) => {
        if (!daemonClient) return null;
        const res = await daemonClient.processInfo(paneId);
        const procs = (res?.process_info || res || {}).foreground_processes || [];
        // The deepest foreground child is the agent itself (`node …/bin/codex`
        // spawns the real binary); its start is the pane's agent clock.
        const proc = procs[procs.length - 1];
        if (!proc?.pid) return null;
        // On Linux the /proc/<pid> directory is created at fork, so its mtime
        // IS the process start time (checked against `ps -o lstart`).
        const stat = Number.isFinite(proc.startedMs) ? null : await fsp.stat(`/proc/${proc.pid}`).catch(() => null);
        const startedMs = Number.isFinite(proc.startedMs) ? proc.startedMs : stat?.mtimeMs;
        if (!Number.isFinite(startedMs)) return null;
        return {
          pid: proc.pid,
          startedMs,
          cwd: proc.cwd || null,
          argv: proc.argv || [],
        };
      },
      readPaneText: async (paneId) => {
        if (!daemonClient) return '';
        const res = await daemonClient.readPane(paneId, {
          source: 'recent', lines: 120, strip_ansi: true,
        });
        return res?.read?.text || '';
      },
      annotateSessionIdentity: async (paneId, identity) => {
        if (!daemonClient) throw new Error('provider identity annotation unavailable while daemon is disconnected');
        return daemonClient.annotateSessionIdentity(paneId, identity);
      },
      rememberLink: (fact) => providerHistory?.rememberLink(fact),
    })
  );

  let paneSet = '';
  const refreshInteractivePanes = async () => {
    const client = daemonClient; if (!client?.processInfo || closed) return;
    let changed = false;
    const panes = resolvedPanes();
    for (const pane of panes) {
      if (!isSubSession(historyById.get(sessionId(pane)))) continue;
      const old = interactivePanes.get(pane.pane_id);
      if (old && (old.pending || Date.now() - old.at < 15_000)) continue;
      const entry = { ...old, at: Date.now(), pending: true }; interactivePanes.set(pane.pane_id, entry);
      try {
        const result = await client.processInfo(pane.pane_id);
        if (closed || client !== daemonClient || interactivePanes.get(pane.pane_id) !== entry) continue;
        const processes = (result?.process_info || result || {}).foreground_processes || [];
        const provider = pane.agent || historyById.get(sessionId(pane))?.provider || 'claude';
        // Tools and MCP servers can be below the agent in this chain. The
        // first matching agent owns the pane, not its newest tool child.
        const mode = processes.map((proc) => interactiveAgentArgv(provider, proc.argv)).find((value) => value !== null);
        const interactive = mode === true;
        changed ||= Boolean(old?.interactive) !== interactive;
        entry.interactive = interactive;
      } catch {
        changed ||= Boolean(entry.interactive);
        entry.interactive = false;
      }
      finally { entry.pending = false; }
    }
    if (changed && !closed) publish();
  };
  const publish = () => {
    if (closed) return;
    const ids = new Set(liveState.panes.map((p) => p.pane_id));
    for (const id of interactivePanes.keys()) if (!ids.has(id)) interactivePanes.delete(id);
    const nextPaneSet = JSON.stringify([...ids].sort());
    if (nextPaneSet !== paneSet) { paneSet = nextPaneSet; emitter.emit('panes-changed'); }
    refreshInteractivePanes();
    // The header agents chip is aged on every publish, the overview's rule:
    // shown while a group is active or recently done, gone after.
    const summaries = delegationSummaries(delegationGroups, Date.now(), liveSessionIds());
    summaryIds = new Set(summaries.keys());
    for (const row of historySessions) row.delegationSummary = summaries.get(row.id) || null;
    const livePanes = resolvedPanes();
    const liveIds = new Set(livePanes.map((p) => typeof p.agent_session === 'string' ? p.agent_session : p.agent_session?.value));
    const railHistory = historySessions.filter((row) => !isSubSession(row) || liveIds.has(row.id));
    const model = mergeSidebarModel({
      historySessions: railHistory,
      // The daemon does not name a codex/cursor session; the linker fills the id in
      // from the CLI's own files so those panes merge with their history row
      // instead of floating as anonymous live: entries.
      livePanes,
      workspaces: liveState.workspaces,
      // FILL only, the same contract the window's launch facts follow: the
      // index is a real fact about a session on disk and outranks the argv,
      // because a session can be moved or reconfigured after it starts.
      homes: withLaunchedHomes(homes, launchedHomes),
      dormantSessions,
    });
    const delta = publisher.publish({
      model,
      historyCount: railHistory.length,
      indexerSessionCount: claudeHistoryCount,
    });
    paneRows = new Map();
    for (const project of publisher.getState().model.projects) for (const row of project.sessions) {
      if (row.paneId) paneRows.set(row.paneId, row.id);
    }
    if (delta) emitter.emit('update', { ...publisher.getState(), delta });
  };

  // Agent status can chatter during tool transitions. Collapse a same-frame
  // burst into one sidebar render while still forwarding every raw event to
  // the notification driver.
  const pendingStatuses = new Map();
  let statusNeedsMerge = false;
  const scheduleStatusPublish = (event) => {
    const { pane_id: paneId, agent_status: status } = event.data;
    if (status === 'unknown' || !paneRows.has(paneId)) statusNeedsMerge = true;
    else pendingStatuses.set(paneRows.get(paneId), { agentStatus: status });
    if (statusPublishTimer) return;
    statusPublishTimer = setTimeout(() => {
      statusPublishTimer = null;
      if (statusNeedsMerge) publish();
      else {
        const summaries = delegationSummaries(delegationGroups, Date.now(), liveSessionIds());
        for (const id of new Set([...summaryIds, ...summaries.keys()])) pendingStatuses.set(id, { ...pendingStatuses.get(id), delegationSummary: summaries.get(id) || null });
        summaryIds = new Set(summaries.keys());
        const delta = publisher.patchRows(pendingStatuses);
        if (delta) emitter.emit('update', { ...publisher.getState(), delta });
      }
      pendingStatuses.clear();
      statusNeedsMerge = false;
    }, 16);
    statusPublishTimer.unref?.();
  };

  const onPaneAgentStatus = (event) => {
    const previousState = liveState;
    liveState = applyPaneEvent(liveState, event);
    emitter.emit('pane-agent-status', event);
    if (liveState !== previousState) scheduleStatusPublish(event);
  };

  // Where the last refresh spent its time, for the lifecycle log's
  // window-created line (the launch waits on the first refresh).
  let refreshTimings = null;
  const refreshHistory = createSingleFlight(async () => {
    const refreshStarted = Date.now();
    const [sessions, homeMap] = await Promise.all([
      history.listSessions(),
      history.sessionHomes(),
    ]);
    const claudeRows = sessions.map((row) => ({
      ...row,
      home: homeMap[row.id] ?? null,
    }));
    const claudeDone = Date.now();
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
    historyById = new Map(historySessions.map((row) => [row.id, row]));
    claudeHistoryCount = claudeRows.length;
    homes = homeMap;
    historyFailures = 0;
    if (historyRetryTimer) { clearTimeout(historyRetryTimer); historyRetryTimer = null; }
    // Hand each session back to the index the moment it can answer for itself,
    // so the overlay stays the size of the launches still waiting on a first
    // message rather than growing for the life of the process.
    for (const id of launchedHomes.keys()) {
      if (Object.hasOwn(homeMap, id)) launchedHomes.delete(id);
    }
    const providersDone = Date.now();
    await refreshDelegations();
    refreshTimings = {
      claudeHistoryMs: claudeDone - refreshStarted,
      providerHistoryMs: providersDone - claudeDone,
      backgroundScanMs: Date.now() - providersDone,
    };
    publish();
    emitter.emit('history-refreshed');
  });

  // A refresh that failed is retried on the bridge's own clock. The fs watcher
  // would trigger one too, but only when a transcript changes; on a quiet
  // machine a failed boot refresh would otherwise leave the rail without its
  // history rows until something happened to be written.
  const historyRetryMs = Array.isArray(options.historyRetryMs) && options.historyRetryMs.length
    ? options.historyRetryMs
    : [5000, 15_000, 30_000];
  let historyRetryTimer = null;
  let historyFailures = 0;
  const scheduleHistoryRetry = () => {
    if (closed || historyRetryTimer) return;
    const delay = historyRetryMs[Math.min(historyFailures, historyRetryMs.length - 1)];
    historyFailures += 1;
    historyRetryTimer = setTimeout(() => {
      historyRetryTimer = null;
      refreshHistory().catch((error) => {
        emitter.emit('error', error);
        scheduleHistoryRetry();
      });
    }, delay);
    historyRetryTimer.unref?.();
  };

  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshHistory().catch((error) => {
        emitter.emit('error', error);
        scheduleHistoryRetry();
      });
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
        await connectDaemon();
        reconnectDelayIdx = 0;
      } catch {
        scheduleReconnect();
      }
    }, delay);
    reconnectTimer.unref?.();
  };

  const refreshDormant = async () => {
    const client = daemonClient;
    if (closed || !client?.dormantSessions) return;
    let next;
    try {
      next = await client.dormantSessions();
    } catch (error) {
      if (/unsupported verb/.test(String(error?.message))) dormantSupported = false;
      return;
    }
    if (closed || client !== daemonClient) return;
    const fresh = next && typeof next === 'object' ? next : {};
    if (JSON.stringify(fresh) === JSON.stringify(dormantSessions)) return;
    dormantSessions = fresh;
    publish();
  };

  const connectDaemon = async () => {
    subscription?.close?.();
    clearInterval(dormantTimer);
    dormantTimer = null;
    dormantSupported = true;
    interactivePanes.clear();
    daemonClient = makeClient(options.daemonOptions || {});
    try {
      const boot = await daemonClient.bootstrap({
        onResyncError: (e) => emitter.emit('error', e),
        onResync: (freshSnapshot, { discarded }) => {
          if (discarded) console.log('sidebar-bridge: resync after replay settle, discarded', discarded, 'events');
          liveState = extractLiveState({ snapshot: freshSnapshot });
          interactivePanes.clear();
          publish();
        },
        onEvent: (event) => {
          liveState = applyWorkspaceEvent(liveState, event);
          if (event?.event === 'pane.agent_status_changed') {
            onPaneAgentStatus(event);
          } else {
            if (event?.event === 'pane.agent_detected' || (event?.event === 'pane.updated' && Object.hasOwn(event.data?.pane || {}, 'agent'))) {
              interactivePanes.delete(event.data?.pane_id || event.data?.pane?.pane_id);
            }
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
      {
        dormantTimer = setInterval(() => { if (dormantSupported) refreshDormant(); refreshInteractivePanes(); }, DORMANT_POLL_MS);
        dormantTimer.unref?.();
        refreshDormant();
      }
    } catch (error) {
      emitter.emit('daemon-error', error);
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
    // Two independent halves, each degrading on its own. A history failure at
    // boot (the index worker losing a cache-file race, 2026-09-04) used to
    // reject start() itself, which rejected the boot chain and exited Harbor
    // with no window: the daemon was fine, every session was alive, and the
    // rail simply never got the chance to say so. History now costs its rows
    // until the retry lands; the daemon connect is never gated on it.
    try {
      await refreshHistory();
    } catch (error) {
      emitter.emit('error', error);
      scheduleHistoryRetry();
    }
    const daemonStarted = Date.now();
    try {
      await connectDaemon();
    } catch {
      // Degraded boot (daemon absent): history works; reconnect keeps trying.
      scheduleReconnect();
    }
    daemonConnectMs = Date.now() - daemonStarted;
  };
  let daemonConnectMs = null;

  const focusLivePane = async ({ paneId, workspaceId }) => {
    if (!daemonClient || !paneId) throw new Error('pane focus unavailable');
    if (workspaceId) await daemonClient.focusWorkspace(workspaceId);
    return daemonClient.focusPane(paneId);
  };

  const close = () => {
    closed = true;
    clearTimeout(refreshTimer);
    clearTimeout(statusPublishTimer);
    clearTimeout(reconnectTimer);
    clearTimeout(historyRetryTimer);
    historyRetryTimer = null;
    clearInterval(dormantTimer);
    dormantTimer = null;
    history.removeAllListeners('history-changed');
    history.close?.();
    providerHistory?.emitter.removeAllListeners('changed');
    providerHistory?.close();
    delegationIndex?.close();
    providerLinker?.emitter.removeAllListeners();
    providerLinker?.close();
    subscription?.close?.();
    subscription = null;
    daemonClient = null;
  };

  // Claude ids resolve through the indexer; codex/cursor ids through the
  // provider scan (path + provider, so transcript open needs no hints).
  const getSessionMeta = async (id) => {
    const indexed = historyById.get(id);
    // The bulk index refresh already has these facts. Orch summary polls
    // and send lookups must not enqueue one worker RPC per historical row.
    if (indexed?.meta) return { ...indexed.meta, home: indexed.home ?? null };
    const providerMeta = providerHistory?.metaFor(id);
    if (providerMeta) return providerMeta;
    try {
      return await history.sessionMeta(id);
    } catch (error) {
      const providerMeta = providerHistory?.metaFor(id);
      if (providerMeta) return providerMeta;
      throw error;
    }
  };
  // The same answer for a reader of the conversation: a compressed codex
  // rollout comes back with its decompressed copy as `path`. Everything else
  // (identity, cwd, the Orch join) asks getSessionMeta, which never
  // decompresses anything.
  const getReadableSessionMeta = async (id) => {
    const readable = await providerHistory?.readableMetaFor?.(id);
    return readable || getSessionMeta(id);
  };

  return {
    emitter,
    start,
    refreshHistory,
    startTimings: () => ({ ...refreshTimings, daemonConnectMs }),
    refreshDelegations,
    startBackgroundMigration: () => {
      history.startBackgroundMigration?.();
      providerHistory?.startBackgroundMigration?.();
    },
    listDelegations: () => ageDelegationGroups(delegationGroups, Date.now(), liveSessionIds()),
    listSubSessions: (request) => {
      const live = new Map();
      for (const pane of resolvedPanes()) live.set(sessionId(pane), pane);
      return listSubSessions(historySessions.map((row) => ({ ...row, isLive: live.has(row.id), agentStatus: live.get(row.id)?.agent_status,
        dormant: !live.has(row.id) && sleptSince(dormantSessions[row.id], parseLocalDateTime(row.lastActive)?.getTime() || 0),
      })), request);
    },
    getSession: (id) => {
      const row = historyById.get(id);
      if (!row) return null;
      const panes = resolvedPanes();
      return mergeSidebarModel({ historySessions: [row], homes, workspaces: liveState.workspaces, dormantSessions,
        livePanes: panes.filter((p) => (typeof p.agent_session === 'string' ? p.agent_session : p.agent_session?.value) === id),
      }).projects.flatMap((p) => p.sessions).find((s) => s.id === id) || null;
    },
    getHistoryRows: () => historySessions,
    getSessionLabel: (id) => {
      const row = historyById.get(id);
      return row ? { title: row.title, project: row.project } : null;
    },
    isDelegatedPane: (paneId) => {
      const pane = resolvedPanes().find((p) => p.pane_id === paneId);
      const id = typeof pane?.agent_session === 'string' ? pane.agent_session : pane?.agent_session?.value;
      return subSessionReadOnly({ ...historyById.get(id), isLive: Boolean(pane), isLiveInteractive: pane?.isLiveInteractive });
    },
    isDelegated: (id) => {
      const panes = resolvedPanes().filter((p) => sessionId(p) === id);
      return subSessionReadOnly({ ...historyById.get(id), isLive: panes.length > 0, isLiveInteractive: panes.at(-1)?.isLiveInteractive });
    },
    notificationState: (paneId) => {
      const pane = resolvedPanes().find((p) => p.pane_id === paneId);
      if (!pane) return { alive: false };
      const id = typeof pane.agent_session === 'string' ? pane.agent_session : pane.agent_session?.value;
      const row = historyById.get(id);
      const readOnly = subSessionReadOnly({ ...row, isLive: true, isLiveInteractive: pane.isLiveInteractive });
      return { alive: true, delegatedBy: readOnly ? (row?.delegatedBy || 'sub-session') : null, working: pane.agent_status === 'working' || freshWorking(row?.background),
        background: Boolean(row?.background?.outstanding?.length || row?.background?.awaitingFinal) };
    },
    // Called by the launch flow with the profile it actually passed to the CLI
    // as `--home`. Publishing immediately is the point: the rail row for the new
    // pane arrives from the daemon within seconds, long before any transcript.
    noteLaunchedHome: (sessionId, profileId) => {
      if (!sessionId || !profileId) return;
      // A provisional id is a PANE, not a session, and the home map is keyed by
      // session id, so such an entry could never match a row and would never be
      // pruned either (the prune asks whether the index has learned the id).
      // The real id arrives on the same launch's second event.
      if (/^(pane|live):/.test(sessionId)) return;
      launchedHomes.set(sessionId, profileId);
      publish();
    },
    // The profile a pane was launched with, until the index learns the session.
    getLaunchedHome: (sessionId) => launchedHomes.get(sessionId) || null,
    onPaneAgentStatus,
    focusLivePane,
    close,
    getSessionMeta,
    getReadableSessionMeta,
    // The claude index never holds a codex or cursor id, so asking it alone
    // answered "session ... not in index yet" for every codex batch worker's
    // preview. Ids the provider scan knows get a preview built from their own
    // rollout, from a bounded head and tail.
    getSessionPreview: async (id) => {
      const providerMeta = await providerHistory?.readableMetaFor?.(id);
      if (providerMeta?.path && providerMeta.provider && providerMeta.provider !== 'claude') {
        return buildProviderPreview({ id, meta: providerMeta, row: historyById.get(id) || null });
      }
      return history.sessionPreview(id);
    },
    // A send is the moment a codex pane's first prompt hits disk; resolving
    // right then names the session in seconds instead of at the next tick.
    resolveProviderSessions: () => providerLinker?.resolveNow() ?? false,
    providerSessionForPane: (paneId) => providerLinker?.get(paneId) ?? null,
    // Is a live pane running this provider's agent on this session? The
    // daemon detects the pane's foreground agent from its process tree, and a
    // link exists only while that pane and agent do, so this is the codex
    // owner-liveness answer the transcript provider has no tee or beacon for.
    providerPaneAlive: (sessionId, provider) => {
      const panes = providerLinker ? providerLinker.apply(liveState.panes) : liveState.panes;
      return panes.some((pane) => {
        const named = typeof pane?.agent_session === 'string' ? pane.agent_session : pane?.agent_session?.value;
        return pane?.agent === provider && named === sessionId;
      });
    },
    getLivePaneIds: () => liveState.panes.map((pane) => pane.pane_id),
    getHistoryRow: (id) => historyById.get(id),
    getState: () => publisher.getState(),
  };
}

module.exports = {
  createSidebarBridge,
  withLaunchedHomes,
  extractLiveState,
  applyPaneEvent,
  applyWorkspaceEvent,
};
