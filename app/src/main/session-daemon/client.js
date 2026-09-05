'use strict';

const { EventEmitter } = require('node:events');
const os = require('node:os');
const { SessionClient } = require('../../daemon/client.js');
const { resolvePaths } = require('../../daemon/paths.js');
const { projectLabelForCwd } = require('../../shared/project-label.cjs');
const { foregroundProcesses } = require('./process-tree.js');

class SessionSubscription extends EventEmitter {
  constructor(owner, options = {}) {
    super();
    this.owner = owner;
    this.closed = false;
    this.panes = new Map();
    this.interval = setInterval(() => this._poll(), options.pollIntervalMs || 1000);
    this.interval.unref?.();
  }
  ready() { return Promise.resolve({ subscribed: true }); }
  seedFromSnapshot(snapshot) {
    this.panes = new Map((snapshot?.panes || []).map((pane) => [pane.pane_id, pane]));
    return this;
  }
  async _poll() {
    if (this.closed) return;
    try {
      const snapshot = (await this.owner.snapshot()).snapshot;
      const next = new Map(snapshot.panes.map((pane) => [pane.pane_id, pane]));
      for (const pane of snapshot.panes) {
        const previous = this.panes.get(pane.pane_id);
        if (previous) {
          const beforeId = previous.agent_session?.value ?? null;
          const afterId = pane.agent_session?.value ?? null;
          if (previous.agent !== pane.agent || beforeId !== afterId) {
            this.emit('event', { event: 'pane.updated', data: { pane } });
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
      if (!this.closed) this.emit('error', error);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.interval);
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
    agent: session.agent ?? null,
    agent_session: session.agent_session
      ? { kind: 'id', value: session.agent_session }
      : null,
    exited: Boolean(session.exit),
    focused: false,
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
        foreground_processes: pid && info?.running ? await foregroundProcesses(pid) : [],
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
