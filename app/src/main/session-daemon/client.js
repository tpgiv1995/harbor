'use strict';

const { EventEmitter } = require('node:events');
const os = require('node:os');
const { SessionClient } = require('../../daemon/client.js');
const { resolvePaths } = require('../../daemon/paths.js');
const { projectLabelForCwd } = require('../../shared/project-label.cjs');
const { foregroundProcesses } = require('./process-tree.js');

// ONE SNAPSHOT FETCH PER TICK, SHARED BY EVERY SUBSCRIPTION ON A DAEMON
// (2026-11-06, measured live: 266 `list` requests a minute at the daemon from
// five connections). Each subscription used to poll `owner.snapshot()` on its
// own 1 s timer, and `snapshot()` is the daemon's `list`, which reads every
// session's state record; one Harbor process makes three subscriptions (sidebar
// bridge, terminal bridge, agent status) and the phone server two more, so the
// daemon answered the same question five times a second. Subscriptions that
// take the default cadence now join one SharedSnapshotPoller per daemon: one
// timer, one request in flight, the result fanned out to every member, each of
// which diffs it against ITS OWN previous panes and emits its own events exactly
// as before. A subscription that names its own pollIntervalMs keeps its own
// timer (tests, probes). The poller stops with its last member.
const SHARED_POLL_MS = 1000;
const sharedPollers = new Map();

// Clients in one process that reach the same daemon share a key: its socket,
// and the home it labels projects against (the snapshot's labels depend on it).
// An owner with no socket to name (a test double) is its own key.
function pollerKey(owner) {
  const socketPath = owner?.client?.socketPath;
  return socketPath ? `${socketPath}\n${owner.home ?? ''}` : owner;
}

class SharedSnapshotPoller {
  constructor(key) {
    this.key = key;
    this.members = new Set();
    this.inflight = false;
    this.failing = new WeakSet(); // clients whose last fetch failed
    this.retrying = new WeakSet(); // failing clients with a retry in flight
    this.failures = new WeakMap(); // client -> how many fetches of it have failed
    this.lastGood = null; // the client whose fetch answered last, asked first
    this.timer = setInterval(() => this.tick(), SHARED_POLL_MS);
    this.timer.unref?.();
  }
  join(subscription) { this.members.add(subscription); }
  leave(subscription) {
    this.members.delete(subscription);
    if (this.members.size) return;
    clearInterval(this.timer);
    if (sharedPollers.get(this.key) === this) sharedPollers.delete(this.key);
  }
  // An 'error' nobody listens for throws out of emit; it must not stop the
  // members after it from being served.
  _each(_member, fn) { try { fn(); } catch { /* that member's own problem */ } }
  // Healthy members share one fetch per tick, from the client that answered
  // last, never overlapping. Only the members present when the tick STARTED,
  // whose client was healthy then, are served: one that joined mid-fetch may
  // hold a newer seed, and an older answer reported its new panes closed (Astra
  // review). A client whose last fetch failed is retried on its own, one
  // request at a time, and its members get only its own answers or errors, so
  // a slow broken client never holds up the healthy ones (Astra review round 2).
  tick() {
    if (!this.members.size) return;
    const groups = new Map();
    for (const member of this.members) {
      if (!groups.has(member.owner)) groups.set(member.owner, []);
      groups.get(member.owner).push(member);
    }
    for (const [owner, group] of groups) {
      if (!this.failing.has(owner) || this.retrying.has(owner)) continue;
      this.retrying.add(owner);
      owner.snapshot().then(({ snapshot }) => {
        this.failing.delete(owner);
        for (const member of group) if (this.members.has(member)) this._each(member, () => member._apply(snapshot));
      }, (error) => {
        this.failures.set(owner, (this.failures.get(owner) || 0) + 1);
        for (const member of group) if (this.members.has(member)) this._each(member, () => member._fail(error));
      }).finally(() => this.retrying.delete(owner));
    }
    if (this.inflight) return;
    const healthy = [...groups.keys()].filter((owner) => !this.failing.has(owner))
      .sort((a, b) => (a === this.lastGood ? -1 : b === this.lastGood ? 1 : 0));
    if (!healthy.length) return;
    this.inflight = true;
    this._shared(healthy, groups).finally(() => { this.inflight = false; });
  }
  // A client that fails while this fetch is out is left out of its answer even
  // if a private retry has recovered it since: that retry's answer is newer
  // (Astra review round 3: the older answer closed a pane the retry created).
  async _shared(healthy, groups) {
    const failuresAtStart = new Map(healthy.map((owner) => [owner, this.failures.get(owner) || 0]));
    for (const owner of healthy) {
      let snapshot;
      try {
        snapshot = (await owner.snapshot()).snapshot;
      } catch (error) {
        this.failing.add(owner);
        this.failures.set(owner, (this.failures.get(owner) || 0) + 1);
        for (const member of groups.get(owner)) if (this.members.has(member)) this._each(member, () => member._fail(error));
        continue;
      }
      this.lastGood = owner;
      for (const other of healthy) {
        if (this.failing.has(other) || (this.failures.get(other) || 0) !== failuresAtStart.get(other)) continue;
        for (const member of groups.get(other)) if (this.members.has(member)) this._each(member, () => member._apply(snapshot));
      }
      return;
    }
  }
}

class SessionSubscription extends EventEmitter {
  constructor(owner, options = {}) {
    super();
    this.owner = owner;
    this.closed = false;
    this.panes = new Map();
    this.interval = null;
    this.shared = null;
    if (options.pollIntervalMs) {
      this.interval = setInterval(() => this._poll(), options.pollIntervalMs);
      this.interval.unref?.();
    } else {
      const key = pollerKey(owner);
      let poller = sharedPollers.get(key);
      if (!poller) sharedPollers.set(key, poller = new SharedSnapshotPoller(key));
      poller.join(this);
      this.shared = poller;
    }
  }
  ready() { return Promise.resolve({ subscribed: true }); }
  seedFromSnapshot(snapshot) {
    this.panes = new Map((snapshot?.panes || []).map((pane) => [pane.pane_id, pane]));
    return this;
  }
  // The subscription's own fetch: the custom-interval timer and direct callers.
  async _poll() {
    if (this.closed) return;
    let snapshot;
    try {
      snapshot = (await this.owner.snapshot()).snapshot;
    } catch (error) {
      this._fail(error);
      return;
    }
    this._apply(snapshot);
  }
  _fail(error) {
    if (!this.closed) this.emit('error', error);
  }
  // Diff a fetched snapshot against this subscription's previous panes.
  _apply(snapshot) {
    if (this.closed) return;
    try {
      const next = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
      for (const pane of snapshot.panes) {
        const previous = this.panes.get(pane.pane_id);
        if (previous) {
          const beforeId = previous.agent_session?.value ?? null;
          const afterId = pane.agent_session?.value ?? null;
          if (previous.agent !== pane.agent || beforeId !== afterId
            || previous.codex_title?.prefix !== pane.codex_title?.prefix
            || previous.codex_title?.revision !== pane.codex_title?.revision
            || previous.provider_home !== pane.provider_home) {
            this.emit('event', { event: 'pane.updated', data: { pane } });
          }
          // Another client (the phone server, a tool) can resize a pane; the
          // bridge needs to hear it to keep an open >_ view in step.
          if (pane.cols && pane.rows && (previous.cols !== pane.cols || previous.rows !== pane.rows)) {
            this.emit('event', { event: 'pane.resized', data: { pane_id: pane.pane_id, cols: pane.cols, rows: pane.rows } });
          }
          continue;
        }
        const workspace = snapshot.workspaces.find((item) => item.workspace_id === pane.workspace_id);
        const tab = snapshot.tabs.find((item) => item.tab_id === pane.tab_id);
        const layout = snapshot.layouts.find((item) => item.tab_id === pane.tab_id);
        this.emit('event', { event: 'workspace.created', data: { workspace } });
        this.emit('event', { event: 'tab.created', data: { tab } });
        this.emit('event', { event: 'pane.created', data: { pane } });
        this.emit('event', { event: 'layout.updated', data: { layout } });
      }
      for (const id of this.panes.keys()) {
        if (!next.has(id)) this.emit('event', { event: 'pane.closed', data: { pane_id: id } });
      }
      this.panes = next;
    } catch (error) {
      // One member's failing listener must not stop the others being served.
      this._fail(error);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    this.shared?.leave(this);
    this.emit('close');
  }
}

function sessionRecords(result) {
  return result?.sessions || [];
}

// Drop the grid's empty rows below the content, then keep the last `count`
// lines. Never touches interior blanks.
function tailLines(text, count) {
  const all = String(text ?? '').split('\n');
  let end = all.length;
  while (end > 0 && all[end - 1].trim() === '') end -= 1;
  return all.slice(Math.max(0, end - count), end).join('\n');
}

function paneFor(session) {
  return {
    pane_id: session.id,
    tab_id: session.id,
    workspace_id: session.id,
    cwd: session.cwd,
    pid: session.pid,
    // The launch argv (model and effort as launched), for the team chart.
    argv: Array.isArray(session.argv) ? session.argv : [],
    agent: session.agent ?? null,
    ...(session.provider_home ? { provider_home: session.provider_home } : {}),
    ...(session.codex_title ? { codex_title: session.codex_title } : {}),
    agent_session: session.agent_session
      ? { kind: 'id', value: session.agent_session }
      : null,
    exited: Boolean(session.exit),
    focused: false,
    // When the daemon spawned it. session-send reads this to tell a pane that
    // is still starting from one that has run for hours.
    created_at: session.created_at ?? null,
    // The pty's size as the daemon holds it, whoever set it last (2026-11-06:
    // terminal-bridge compares it with an open >_ view's size).
    cols: Number.isInteger(session.cols) ? session.cols : null,
    rows: Number.isInteger(session.rows) ? session.rows : null,
  };
}

function snapshotFromSessions(sessions, home) {
  sessions = sessions.filter((session) => !session.exit);
  return {
    protocol: 'sessiond-1',
    workspaces: sessions.map((session) => ({
      workspace_id: session.id,
      // NOT the raw cwd. The rail groups by this string, so labelling a folder
      // by its absolute path splits it into two groups: the live sessions under
      // the path and their own history under the real project name.
      label: projectLabelForCwd(session.cwd, home),
      cwd: session.cwd,
      focused: false,
    })),
    tabs: sessions.map((session) => ({
      tab_id: session.id, workspace_id: session.id, label: session.argv?.join(' ') || 'session', focused: true,
    })),
    panes: sessions.map(paneFor),
    layouts: sessions.map((session) => ({ tab_id: session.id, panes: [paneFor(session)] })),
    focused_workspace_id: sessions[0]?.id || null,
  };
}

class SessionDaemonClient {
  constructor(options = {}) {
    this.env = options.env || process.env;
    // The socket is resolved from THIS client's env, not the process's. Without
    // this, an explicit HARBOR_SESSIOND_DIR in an injected env was silently
    // ignored: SessionClient fell back to resolvePaths(), which reads
    // process.env, so a caller that had carefully pointed at a throwaway store
    // connected to the REAL daemon instead. Caught by a server test that
    // isolated its store, passed all four assertions, and then would not exit,
    // because it was holding five live sockets open against the user's own
    // sessiond. A store you can name but not reach is worse than no override.
    this.client = options.client || new SessionClient({
      ...options,
      socketPath: options.socketPath || resolvePaths(this.env).socket,
    });
  }

  request(verb, params = {}) { return this.client.request(verb, params); }
  ping() { return this.request('health'); }
  // The home comes from this client's own env, not os.homedir(), so an
  // isolated harness labels against ITS home rather than the real one.
  get home() { return this.env.HOME || os.homedir(); }
  async snapshot() { return { snapshot: snapshotFromSessions(sessionRecords(await this.request('list')), this.home) }; }
  async assertProtocol() { return this.snapshot(); }
  // Sessions the daemon put to sleep for sitting idle (daemon/dormant-ledger.js),
  // keyed by provider session id. A daemon from before 2026-10-06 rejects the
  // verb; the caller decides what that means.
  async dormantSessions() { return (await this.request('dormant'))?.sessions || {}; }
  subscribe(_subscriptions, options) { return new SessionSubscription(this, options); }
  subscribeAgentStatus() { return new SessionSubscription(this); }
  async bootstrap(options = {}) {
    const result = await this.snapshot();
    const subscription = this.subscribe(null, options.subscriptionOptions);
    // Seed BEFORE wiring the listener, so the boot snapshot's own panes are
    // not replayed as freshly created.
    subscription.seedFromSnapshot(result.snapshot);
    // The caller's onEvent is the entire reason this subscription exists. It
    // was built, polled every second and emitted into nothing, so on sessiond
    // the rail only ever showed what existed at boot: every session Harbor
    // launched was invisible until a restart. The adapter has to wire this,
    // not merely resemble the expected interface.
    if (options.onEvent) subscription.on('event', options.onEvent);
    if (options.onResync) options.onResync(result.snapshot, { discarded: 0, attempt: 0 });
    await subscription.ready();
    return { snapshot: result.snapshot, subscription };
  }

  async _spawn(params = {}) {
    const argv = params.argv || params.command || [this.env.SHELL || '/bin/bash'];
    const normalizedArgv = Array.isArray(argv) ? argv : [this.env.SHELL || '/bin/bash', '-lc', String(argv)];
    const result = await this.request('spawn', {
      argv: normalizedArgv,
      cwd: params.cwd || os.homedir(),
      env: params.env || {},
      cols: params.cols || 120,
      rows: params.rows || 60,
      agent: params.agent,
      agent_session: params.agent_session,
    });
    return { workspace_id: result.id, tab_id: result.id, pane_id: result.id, id: result.id };
  }

  createWorkspace(params) { return this._spawn(params); }
  createTab(params) { return this._spawn(params); }
  splitPane(_paneId, params) { return this._spawn(params); }
  async listWorkspaces() { return (await this.snapshot()).snapshot.workspaces; }
  async listTabs() { return (await this.snapshot()).snapshot.tabs; }
  async listPanes() { return (await this.snapshot()).snapshot.panes; }
  async getWorkspace(id) { return (await this.listWorkspaces()).find((item) => item.workspace_id === id); }
  async getTab(id) { return (await this.listTabs()).find((item) => item.tab_id === id); }
  async getPane(id) { return (await this.listPanes()).find((item) => item.pane_id === id); }
  focusWorkspace() { return Promise.resolve({ ok: true }); }
  focusTab() { return Promise.resolve({ ok: true }); }
  focusPane() { return Promise.resolve({ ok: true }); }
  reportWorkspaceMetadata() { return Promise.resolve({ ok: true }); }
  renameTab() { return Promise.resolve({ ok: true }); }
  // Shaped for the shared consumers. Reporting only
  // { pid, running, exit } left shell_pid and foreground_process_group_id
  // undefined, so worker force-close refused outright ("no shell pid or process
  // group found for pane") and normal close lost the handle it verifies the
  // orphaned process with. node-pty makes the pty leader its own session and
  // process-group leader, which is the same assumption the keeper already
  // relies on when it signals -pid.
  async processInfo(id) {
    const info = await this.request('process', { id });
    const pid = Number.isInteger(info?.pid) ? info.pid : null;
    return {
      process_info: {
        ...info,
        shell_pid: pid,
        foreground_process_group_id: pid,
        foreground_processes: pid && info?.running
          ? await foregroundProcesses(pid, { request: (verb, params) => this.request(verb, params) })
          : [],
      },
    };
  }
  closePane(id) { return this.request('terminate', { id, signal: 'SIGTERM' }); }
  closeTab(id) { return this.closePane(id); }
  closeWorkspace(id) { return this.closePane(id); }
  sendText(id, text) { return this.request('input', { id, text }); }
  annotateSessionIdentity(id, { agent, agentSession }) {
    return this.request('annotate', { id, agent, agent_session: agentSession });
  }
  sendKeys(id, keys) { return this.sendText(id, (Array.isArray(keys) ? keys : [keys]).map((key) => key === 'enter' ? '\r' : key).join('')); }
  sendInput(id, input = {}) {
    const normalized = Buffer.isBuffer(input.bytes)
      ? { ...input, bytes: input.bytes.toString('base64') }
      : input;
    return this.request('input', { id, ...normalized });
  }
  // `recent` means content lines to callers. sessiond models a real screen, so
  // its grid includes every blank row below the cursor, and a 60 row pane
  // showing five lines of output returned 55 trailing blanks. Every send guard
  // reads this tail, so on sessiond they all saw whitespace: assertNotDeadShell
  // stopped recognising a bare shell prompt (the 2026-07-22 incident, where a
  // send was EXECUTED by bash, rebuilt on the new backend), classifyBlocked
  // stopped seeing dialogs, parseMenu found no footer at the bottom of the
  // scrape, and the readiness waits never settled. Measured, not theorised.
  //
  // Trailing blank rows are therefore dropped before slicing, which makes
  // `lines` mean the same thing on both backends: the last N lines that have
  // something on them. Interior blanks are preserved, because a dialog's own
  // spacing is part of what the parsers key off.
  async readPane(id, params = {}) {
    const lines = Number.isInteger(params.lines) && params.lines > 0 ? params.lines : 200;
    const screen = await this.request('screen', { id, scrollback: lines });
    const source = params.source === 'visible' ? screen.visible : screen.text;
    return { read: { text: tailLines(source, lines), visible: tailLines(screen.visible, lines) }, screen };
  }
  async exportLayout({ tab_id }) { return { layout: (await this.snapshot()).snapshot.layouts.find((item) => item.tab_id === tab_id) }; }
  close() { this.client.close(); }
}

module.exports = { SessionDaemonClient, SessionSubscription, snapshotFromSessions };
