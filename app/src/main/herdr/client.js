'use strict';

// Herdr control-plane client.
//
// The Herdr daemon speaks newline-delimited JSON over a Unix domain socket
// (docs/upstream-herdr-docs/socket-api.mdx). Two behaviours matter and are
// baked into this client:
//
//   1. Normal request/response is ONE request per connection. The server sends
//      exactly one response line and then closes the socket. Reusing a socket
//      for a second request fails with EPIPE. So request() opens a fresh
//      short-lived connection each call.
//   2. events.subscribe is the exception: after the acknowledgement line the
//      server keeps the connection open and pushes event lines. HerdrSubscription
//      holds that long-lived connection.
//
// Response lines carry an "id" plus "result" or "error". Pushed event lines
// carry "event" and "data" with no "id" (schema: subscription/event -> {event,
// data}). The data payload has a "type" const and the resource record, and pane
// records carry a monotonic "revision".
//
// Bootstrap pattern (REQUIREMENTS S6, upstream issue #1270): the server replays
// retained history to every new subscriber, so we snapshot first, seed a Deduper
// from that snapshot, then subscribe and drop replayed events by id/revision.
//
// Part of /home/you/dev/harbor (see README.md).

const net = require('net');
const { EventEmitter } = require('events');
const { platform } = require('../platform/index.js');

const DEFAULT_SOCKET = platform.herdrTransport();
// Kept in step with lifecycle.js SUPPORTED_PROTOCOLS: an ALLOWLIST, never a
// `>=`, so an unknown future protocol fails closed. 16 is Herdr 0.7.4 (the
// pinned stable build); 17 is 0.7.5-preview, the only channel shipping Windows
// binaries. The delta between them is agent.send splitting into agent.prompt /
// agent.send_keys plus agent.view.*/agent.wait, none of which this client
// calls. See the protocol note in CLAUDE.md before adding a third.
const SUPPORTED_PROTOCOLS = Object.freeze([16, 17]);
const EXPECTED_PROTOCOL = SUPPORTED_PROTOCOLS[0];
const EXPECTED_SCHEMA_VERSION = 1;

let requestCounter = 0;
let subscriptionCounter = 0;

class HerdrError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'HerdrError';
    this.code = code;
  }
}

// Splits a growing byte stream into complete NDJSON lines. Handles a JSON
// object split across multiple socket chunks by buffering until the newline.
function makeLineReader(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  };
}

// Drops replayed lifecycle events. Seeded from a session.snapshot so that the
// history the server replays to a fresh subscriber is recognised and skipped.
class Deduper {
  constructor() {
    this.revisions = new Map(); // pane_id -> highest revision delivered
    this.seen = new Set(); // `${event}:${id}` identity for created/closed
  }

  seedSnapshot(snapshot) {
    if (!snapshot) return;
    for (const p of snapshot.panes || []) {
      if (typeof p.revision === 'number') this.revisions.set(p.pane_id, p.revision);
      this.seen.add('pane.created:' + p.pane_id);
    }
    for (const w of snapshot.workspaces || []) this.seen.add('workspace.created:' + w.workspace_id);
    for (const t of snapshot.tabs || []) this.seen.add('tab.created:' + t.tab_id);
  }

  // Returns true when the event is fresh (should be delivered), false when it
  // is a replay of state already reflected in the snapshot/earlier events.
  accept(ev) {
    return !this._isReplay(ev);
  }

  _isReplay(ev) {
    const kind = ev && ev.event;
    const data = (ev && ev.data) || {};
    if (!kind) return false;

    if (kind.startsWith('pane.')) {
      const pane = data.pane;
      const paneId = pane ? pane.pane_id : data.pane_id;
      if (pane && typeof pane.revision === 'number') {
        const prev = this.revisions.get(paneId);
        if (prev !== undefined && pane.revision <= prev) return true;
        this.revisions.set(paneId, pane.revision);
      }
      if (kind === 'pane.created' || kind === 'pane.closed') {
        const key = kind + ':' + paneId;
        if (this.seen.has(key)) return true;
        this.seen.add(key);
        if (kind === 'pane.closed') {
          // Prune: a closed pane's ids never recur (herdr ids are monotonic);
          // without this the maps grow for the life of the process.
          this.revisions.delete(paneId);
          this.seen.delete('pane.created:' + paneId);
        }
      }
      return false;
    }

    if (kind === 'workspace.created' || kind === 'tab.created') {
      const id = data.workspace ? data.workspace.workspace_id
        : data.tab ? data.tab.tab_id
        : data.id;
      const key = kind + ':' + id;
      if (this.seen.has(key)) return true;
      this.seen.add(key);
      return false;
    }

    if (kind === 'workspace.closed' || kind === 'tab.closed') {
      const id = data.workspace_id || data.workspace?.workspace_id
        || data.tab_id || data.tab?.tab_id;
      if (id) {
        this.seen.delete('workspace.created:' + id);
        this.seen.delete('tab.created:' + id);
      }
      return false;
    }

    return false;
  }
}

// A long-lived events.subscribe connection. Emits deduped "event" (after the
// Deduper) and raw "raw" (every pushed line) events. ready() resolves once the
// server has acknowledged the subscription.
class HerdrSubscription extends EventEmitter {
  constructor(socketPath, subscriptions, opts = {}) {
    super();
    this.socketPath = socketPath;
    this.subscriptions = subscriptions;
    this.id = 'sub_' + (++subscriptionCounter);
    this.deduper = opts.deduper || new Deduper();
    this.closed = false;
    this._readyTimeoutMs = opts.readyTimeoutMs != null ? opts.readyTimeoutMs : 10000;
    // Replay-settle window (#1270): buffer the initial replay burst; declare
    // settled after quietGapMs with no events (capped at settleMaxMs).
    this._settling = opts.settle !== false;
    this._settleBuffer = [];
    this._quietGapMs = opts.quietGapMs != null ? opts.quietGapMs : 400;
    this._settleMaxMs = opts.settleMaxMs != null ? opts.settleMaxMs : 5000;
    this._settleTimer = null;
    this._settleDeadline = null;
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    this._connect();
  }

  seedFromSnapshot(snapshot) {
    this.deduper.seedSnapshot(snapshot);
    return this;
  }

  _bumpSettleTimer() {
    if (!this._settling) return;
    if (!this._settleDeadline) this._settleDeadline = Date.now() + this._settleMaxMs;
    clearTimeout(this._settleTimer);
    const remaining = this._settleDeadline - Date.now();
    if (remaining <= 0) { this._finishSettle(); return; }
    const wait = Math.min(this._quietGapMs, remaining);
    this._settleTimer = setTimeout(() => this._finishSettle(), wait);
    this._settleTimer.unref?.();
  }

  _finishSettle() {
    if (!this._settling) return;
    this._settling = false;
    clearTimeout(this._settleTimer);
    const discarded = this._settleBuffer.length;
    this._settleBuffer = [];
    this.emit('settled', { discarded });
  }

  ready() {
    return this._readyPromise;
  }

  _connect() {
    const conn = net.createConnection(this.socketPath);
    this.conn = conn;
    let acked = false;
    const timer = setTimeout(() => {
      if (!acked) {
        this._readyReject(new HerdrError('timeout', 'events.subscribe not acknowledged in time'));
        conn.destroy();
      }
    }, this._readyTimeoutMs);

    const read = makeLineReader((line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (e) { this.emit('parse-error', { line, error: e }); return; }
      if (!acked && msg.id === this.id) {
        acked = true;
        clearTimeout(timer);
        if (msg.error) this._readyReject(new HerdrError(msg.error.code, msg.error.message));
        else {
          this.emit('ready', msg.result);
          this._readyResolve(msg.result);
          this._bumpSettleTimer();
        }
        return;
      }
      // Pushed events have {event, data} and no id.
      if (msg.event && msg.data) {
        // Wire delivers underscore names (workspace_created); the documented
        // taxonomy and all consumers use dotted (workspace.created). Normalize
        // once here (first underscore only: workspace_metadata_updated ->
        // workspace.metadata_updated).
        if (!msg.event.includes('.')) {
          msg = { ...msg, raw_event: msg.event, event: msg.event.replace('_', '.') };
        }
        this.emit('raw', msg);
        if (this.closed) return;
        if (!this.deduper.accept(msg)) return;
        if (this._settling) {
          if (this._settleBuffer.length < 2000) this._settleBuffer.push(msg);
          this._bumpSettleTimer();
          return;
        }
        this.emit('event', msg);
      }
    });

    conn.on('connect', () => {
      conn.write(JSON.stringify({ id: this.id, method: 'events.subscribe', params: { subscriptions: this.subscriptions } }) + '\n');
    });
    conn.on('data', read);
    conn.on('error', (e) => {
      clearTimeout(timer);
      if (!acked) this._readyReject(e);
      if (!this.closed) this.emit('error', e);
    });
    conn.on('close', () => {
      clearTimeout(timer);
      if (!acked) {
        this._readyReject(new HerdrError('closed', 'events.subscribe connection closed before ack'));
      }
      if (!this.closed) this.emit('close');
    });
  }

  close() {
    this.closed = true;
    if (this.conn) this.conn.destroy();
  }
}

// The default lifecycle subscription set: every event that a client keeping a
// live cache from session.snapshot needs, restricted to subscriptions the schema
// accepts with only a {type} (the per-pane wait subscriptions are excluded).
const LIFECYCLE_SUBSCRIPTIONS = [
  'workspace.created', 'workspace.updated', 'workspace.metadata_updated',
  'workspace.renamed', 'workspace.moved', 'workspace.closed', 'workspace.focused',
  'worktree.created', 'worktree.opened', 'worktree.removed',
  'tab.created', 'tab.closed', 'tab.focused', 'tab.renamed', 'tab.moved',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.focused',
  'pane.moved', 'pane.exited', 'pane.agent_detected',
  // pane.agent_status_changed requires a pane_id filter per socket-api.mdx; a
  // type-only subscription makes herdr close the connection before ack.
  'layout.updated',
].map((type) => ({ type }));

class HerdrClient {
  constructor(opts = {}) {
    this.socketPath = opts.socketPath || process.env.HERDR_SOCKET_PATH || DEFAULT_SOCKET;
    this.requestTimeoutMs = opts.requestTimeoutMs != null ? opts.requestTimeoutMs : 10000;
  }

  // One connection per request. Resolves with result, rejects with HerdrError.
  request(method, params = {}) {
    const id = 'req_' + (++requestCounter);
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(this.socketPath);
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.destroy();
        fn(arg);
      };
      const timer = setTimeout(
        () => finish(reject, new HerdrError('timeout', `herdr ${method} timed out after ${this.requestTimeoutMs}ms`)),
        this.requestTimeoutMs,
      );
      const read = makeLineReader((line) => {
        let msg;
        try { msg = JSON.parse(line); } catch (e) { return finish(reject, e); }
        if (msg.error) return finish(reject, new HerdrError(msg.error.code, msg.error.message));
        finish(resolve, msg.result);
      });
      conn.on('connect', () => conn.write(JSON.stringify({ id, method, params }) + '\n'));
      conn.on('data', read);
      conn.on('error', (e) => finish(reject, e));
      conn.on('close', () => finish(reject, new HerdrError('closed', `connection closed before a response to ${method}`)));
    });
  }

  // --- server ---
  ping() { return this.request('ping'); }

  // --- session bootstrap ---
  snapshot() { return this.request('session.snapshot'); }

  // Assert the running daemon speaks a supported protocol (REQUIREMENTS A6).
  // schema_version is a property of the bundled schema document, not the wire
  // snapshot; we assert the runtime protocol and return the snapshot.
  // Accepts a single protocol or a list; defaults to the allowlist above.
  async assertProtocol(expected = SUPPORTED_PROTOCOLS) {
    const accepted = Array.isArray(expected) ? expected : [expected];
    const res = await this.snapshot();
    const proto = res.snapshot && res.snapshot.protocol;
    if (!accepted.includes(proto)) {
      throw new HerdrError('protocol_mismatch', `herdr protocol ${proto} does not match pinned ${accepted.join(', ')}`);
    }
    return res;
  }

  // Snapshot, then subscribe with a Deduper seeded from that snapshot so replayed
  // history (#1270) is dropped. Returns { snapshot, subscription }.
  async bootstrap(opts = {}) {
    const subscriptions = opts.subscriptions || LIFECYCLE_SUBSCRIPTIONS;
    const snapRes = await this.snapshot();
    const subscription = this.subscribe(subscriptions, opts.subscriptionOptions || {});
    subscription.seedFromSnapshot(snapRes.snapshot);
    if (opts.onEvent) subscription.on('event', opts.onEvent);
    if (opts.onResync) {
      subscription.on('settled', async ({ discarded }) => {
        const delays = [0, 500, 1500, 5000, 15000];
        for (let attempt = 0; attempt < delays.length; attempt++) {
          if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
          try {
            const fresh = await this.snapshot();
            subscription.seedFromSnapshot(fresh.snapshot);
            opts.onResync(fresh.snapshot, { discarded, attempt });
            return;
          } catch (e) {
            if (attempt === delays.length - 1) {
              console.error('herdr resync failed after retries:', e.message);
              opts.onResyncError?.(e);
            }
          }
        }
      });
    }
    await subscription.ready();
    return { snapshot: snapRes.snapshot, subscription };
  }

  subscribe(subscriptions = LIFECYCLE_SUBSCRIPTIONS, opts = {}) {
    return new HerdrSubscription(this.socketPath, subscriptions, opts);
  }

  // Per-pane agent-status subscription (the daemon requires a pane_id per
  // entry; a filterless entry is silently ignored, verified live 2026-07-17).
  // The settle window absorbs the #1270 replay of historical transitions so
  // stale completions never toast at (re)subscribe time.
  subscribeAgentStatus(paneIds, opts = {}) {
    const entries = paneIds.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id }));
    return new HerdrSubscription(this.socketPath, entries, {
      quietGapMs: 400,
      settleMaxMs: 2000,
      ...opts,
    });
  }

  // --- workspaces ---
  createWorkspace(params = {}) { return this.request('workspace.create', params); }
  listWorkspaces() { return this.request('workspace.list'); }
  getWorkspace(workspace_id) { return this.request('workspace.get', { workspace_id }); }
  focusWorkspace(workspace_id) { return this.request('workspace.focus', { workspace_id }); }
  reportWorkspaceMetadata(params) { return this.request('workspace.report_metadata', params); }

  // --- tabs ---
  createTab(params = {}) { return this.request('tab.create', params); }
  listTabs(workspace_id) { return this.request('tab.list', workspace_id ? { workspace_id } : {}); }
  getTab(tab_id) { return this.request('tab.get', { tab_id }); }
  focusTab(tab_id) { return this.request('tab.focus', { tab_id }); }
  renameTab(tab_id, label) { return this.request('tab.rename', { tab_id, label }); }

  // --- panes ---
  listPanes(workspace_id) { return this.request('pane.list', workspace_id ? { workspace_id } : {}); }
  getPane(pane_id) { return this.request('pane.get', { pane_id }); }
  processInfo(pane_id) { return this.request('pane.process_info', { pane_id }); }
  focusPane(pane_id) { return this.request('pane.focus', { pane_id }); }
  closePane(pane_id) { return this.request('pane.close', { pane_id }); }
  sendText(pane_id, text) { return this.request('pane.send_text', { pane_id, text }); }
  sendKeys(pane_id, keys) { return this.request('pane.send_keys', { pane_id, keys: Array.isArray(keys) ? keys : [keys] }); }
  sendInput(pane_id, input) {
    // input: { text } and/or { keys }
    return this.request('pane.send_input', Object.assign({ pane_id }, input));
  }

  // --- layout ---
  exportLayout(params = {}) { return this.request('layout.export', params); }

  // --- pane read (scrollback backfill on attach) ---
  readPane(pane_id, params = {}) {
    return this.request('pane.read', Object.assign({
      pane_id,
      source: 'recent',
      lines: 200,
      strip_ansi: false,
    }, params));
  }

  splitPane(pane_id, params = {}) {
    return this.request('pane.split', Object.assign({ pane_id }, params));
  }

  // --- workspace lifecycle ---
  closeWorkspace(workspace_id) { return this.request('workspace.close', { workspace_id }); }

  // --- tab lifecycle ---
  closeTab(tab_id) { return this.request('tab.close', { tab_id }); }
}

module.exports = {
  HerdrClient,
  HerdrSubscription,
  Deduper,
  HerdrError,
  DEFAULT_SOCKET,
  EXPECTED_PROTOCOL,
  SUPPORTED_PROTOCOLS,
  EXPECTED_SCHEMA_VERSION,
  LIFECYCLE_SUBSCRIPTIONS,
};
