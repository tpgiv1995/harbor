'use strict';

// Returning to the phone app is not a reload (2026-10-11, Pat: "if i leave the
// app for like 5 seconds and return to it ... it reloads and takes a while").
// Two-sided where it matters: the page coming back reconnects at once (and a
// failing link still backs off), a socket that only claims to be open is
// replaced (and one that answers is kept), the cache keeps what fits and
// evicts the rest, slices merge with live rows winning, and the header shows
// only facts Claude reported.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const WEB = path.resolve(__dirname, '../../web/src');
const load = (rel) => import(pathToFileURL(path.join(WEB, rel)).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A scripted WebSocket: tests decide when it opens, answers or closes.
function installFakeSocket(t) {
  const sockets = [];
  class FakeSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closedWith = null; this.answer = true; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(raw) {
      const msg = JSON.parse(raw);
      this.sent.push(msg);
      if (this.answer) setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'response', id: msg.id, result: { banner: null } }) }), 5);
    }
    close(code) { this.closedWith = code ?? 1000; this.readyState = 3; }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  t.after(() => { globalThis.WebSocket = previous; });
  return sockets;
}

function fakeLifecycle() {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  return { window: win, document: doc };
}

test('the page coming back reconnects at once, even after the backoff has grown', async (t) => {
  const sockets = installFakeSocket(t);
  const { createRpcClient } = await load('rpc/client.js');
  const lifecycle = fakeLifecycle();
  const client = createRpcClient({ serverUrl: 'http://127.0.0.1:1', token: 't', lifecycle });
  t.after(() => client.disconnect());
  client.connect();
  sockets[0].open();
  sockets[0].drop();
  await sleep(330);
  assert.equal(sockets.length, 2, 'the first retry comes after 250 ms, not 4 s');
  sockets[1].drop(); await sleep(1100);
  sockets[2].drop(); await sleep(2100);
  sockets[3].drop();
  const before = sockets.length;
  await sleep(150);
  assert.equal(sockets.length, before, 'a failing link backs off (the next step is 4 s)');
  lifecycle.document.visibilityState = 'visible';
  lifecycle.document.dispatchEvent(new Event('visibilitychange'));
  await sleep(30);
  assert.equal(sockets.length, before + 1, 'returning to the app skips the wait');
});

test('a socket that still says open after a suspend must answer, or it is replaced', async (t) => {
  const sockets = installFakeSocket(t);
  const { createRpcClient } = await load('rpc/client.js');
  const lifecycle = fakeLifecycle();
  const states = [];
  const client = createRpcClient({ serverUrl: 'http://127.0.0.1:1', token: 't', lifecycle, onConnectionChange: (s) => states.push(s) });
  t.after(() => client.disconnect());
  client.connect();
  sockets[0].open();
  // Healthy: the probe is answered, nothing changes.
  lifecycle.window.dispatchEvent(new Event('pageshow'));
  await sleep(2700);
  assert.equal(sockets.length, 1, 'an answering socket is kept');
  assert.equal(sockets[0].sent.at(-1).method, 'daemon:get-banner');
  // Dead but "open": no answer within the probe window means a fresh socket.
  sockets[0].answer = false;
  lifecycle.window.dispatchEvent(new Event('online'));
  await sleep(2700);
  assert.equal(sockets.length, 2, 'a silent socket is replaced');
  assert.equal(sockets[0].closedWith, 4000);
  sockets[0].onclose?.({ code: 1006 });
  await sleep(20);
  assert.equal(sockets.length, 2, 'the replaced socket closing late does not start a third');
  assert.ok(states.includes('disconnected') && states.at(-1) === 'connecting');
});

// 2026-10-21: the phone sat on "Connecting…" while the server was healthy. A
// handshake that never completes used to wait for the OS to give up on it.
test('a handshake that never completes is abandoned and retried', async (t) => {
  const sockets = installFakeSocket(t);
  const { createRpcClient } = await load('rpc/client.js');
  const client = createRpcClient({ serverUrl: 'http://127.0.0.1:1', token: 't', lifecycle: fakeLifecycle(), connectTimeoutMs: 120 });
  t.after(() => client.disconnect());
  client.connect();
  await sleep(60);
  assert.equal(sockets.length, 1, 'a handshake gets its time');
  await sleep(120);
  assert.equal(sockets.length, 2, 'a handshake past the timeout is replaced');
  assert.equal(sockets[0].closedWith, 4000);
  assert.equal(client.getFailedAttempts(), 1, 'a timed-out handshake counts as a failure');
  sockets[1].open();
  await sleep(200);
  assert.equal(sockets.length, 2, 'an open socket is never timed out');
  assert.equal(client.getFailedAttempts(), 0);
});

test('coming back replaces a handshake started before the suspend, and leaves a fresh one alone', async (t) => {
  const sockets = installFakeSocket(t);
  const { createRpcClient } = await load('rpc/client.js');
  const lifecycle = fakeLifecycle();
  const client = createRpcClient({ serverUrl: 'http://127.0.0.1:1', token: 't', lifecycle, connectTimeoutMs: 60_000, wakeStaleConnectMs: 100 });
  t.after(() => client.disconnect());
  client.connect();
  lifecycle.window.dispatchEvent(new Event('pageshow'));
  await sleep(20);
  assert.equal(sockets.length, 1, 'a handshake that just started is left to finish');
  await sleep(600);
  lifecycle.document.dispatchEvent(new Event('visibilitychange'));
  await sleep(20);
  assert.equal(sockets.length, 2, 'a stale handshake is replaced at once on return');
  assert.equal(sockets[0].closedWith, 4000);
});

// 2026-10-21 review, finding 4: a socket the network swallowed kept saying OPEN
// and every call waited forever, sends included.
test('an open socket that stops answering is found by the heartbeat and replaced, failing what waited on it', async (t) => {
  const sockets = installFakeSocket(t);
  const { createRpcClient } = await load('rpc/client.js');
  const client = createRpcClient({ serverUrl: 'http://127.0.0.1:1', token: 't', lifecycle: fakeLifecycle(), heartbeatMs: 60, heartbeatAnswerMs: 40 });
  t.after(() => client.disconnect());
  client.connect();
  sockets[0].open();
  await sleep(150);
  assert.equal(sockets.length, 1, 'an answering socket survives its heartbeats');
  sockets[0].answer = false;
  const outcome = client.call('session:send', { text: 'hi' }).then(() => 'answered', (error) => error.message);
  await sleep(200);
  assert.equal(sockets.length, 2, 'a silent socket is replaced');
  assert.match(await outcome, /connection dropped/, 'the waiting call fails instead of spinning');
});

// Second Sol review: heartbeats kept succeeding while one call never came back,
// so Send could spin forever on a healthy socket.
test('a call the server never answers ends at its deadline, an action at the longer one', async (t) => {
  const sockets = installFakeSocket(t);
  const { createRpcClient } = await load('rpc/client.js');
  const client = createRpcClient({ serverUrl: 'http://127.0.0.1:1', token: 't', lifecycle: fakeLifecycle(), heartbeatMs: 60_000, callTimeoutMs: 60, actionTimeoutMs: 160 });
  t.after(() => client.disconnect());
  client.connect();
  sockets[0].open();
  sockets[0].answer = false;
  const read = client.call('sidebar:get-state').then(() => 'answered', (error) => error.code);
  const send = client.call('session:send', { text: 'hi' }).then(() => 'answered', (error) => error.message);
  await sleep(100);
  assert.equal(await read, 'TIMEOUT', 'a read ends at the short deadline');
  assert.equal(await Promise.race([send, sleep(1).then(() => 'still waiting')]), 'still waiting', 'an action gets the longer deadline');
  assert.match(await send, /may still have happened/, 'a timed-out action says it may have landed');
  assert.equal(sockets.length, 1, 'a slow answer is not a dead socket');
});

test('retry now replaces a dead attempt and proves an open socket instead of dropping it', async (t) => {
  const sockets = installFakeSocket(t);
  const { createRpcClient } = await load('rpc/client.js');
  const client = createRpcClient({ serverUrl: 'http://127.0.0.1:1', token: 't', lifecycle: fakeLifecycle(), connectTimeoutMs: 60_000 });
  t.after(() => client.disconnect());
  client.connect();
  client.reconnectNow();
  assert.equal(sockets.length, 2, 'a pending attempt is replaced');
  sockets[1].open();
  client.reconnectNow();
  await sleep(30);
  assert.equal(sockets.length, 2, 'an open socket is kept');
  assert.equal(sockets[1].sent.at(-1).method, 'daemon:get-banner', 'and proven with a round trip');
});

function fakeStorage(t) {
  const map = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  t.after(() => { globalThis.localStorage = previous; });
  return map;
}

test('the cache keeps the last list and conversations, bounded, and evicts the oldest', async (t) => {
  const map = fakeStorage(t);
  const cache = await load('rpc/local-cache.js');
  assert.equal(cache.readCachedSidebar(), null);
  cache.writeCachedSidebar({ projects: [{ label: 'Sample', sessions: [{ id: 'a' }] }] });
  assert.equal(cache.readCachedSidebar().model.projects[0].sessions[0].id, 'a');
  for (let i = 0; i < 6; i += 1) cache.writeCachedTranscript(`s${i}`, [{ kind: 'user', text: `hello ${i}` }], { contextPct: i });
  assert.equal(cache.readCachedTranscript('s5').header.contextPct, 5);
  assert.equal(cache.readCachedTranscript('s1'), null, 'only the four most recent conversations are kept');
  assert.equal(cache.readCachedTranscript('s0'), null);
  const big = Array.from({ length: 60 }, (_, i) => ({ kind: 'assistant', text: 'x'.repeat(i < 59 ? 20_000 : 10) }));
  assert.equal(cache.writeCachedTranscript('big', big, null), true, 'a list too large is kept as fewer recent blocks');
  const kept = cache.readCachedTranscript('big').blocks;
  assert.ok(kept.length < 60 && kept.at(-1).text === 'x'.repeat(10), 'the most recent blocks survive');
  assert.ok([...map.values()].every((v) => v.length <= 900_000));
});

test('a wider slice merges with the pushed list, live rows winning', async () => {
  const { mergeRailModels } = await load('browse/rows.js');
  const slice = { projects: [
    { label: 'A', sessions: [{ id: 'a1', isLive: false, title: 'old copy' }, { id: 'a2' }] },
    { label: 'B', sessions: [{ id: 'b1' }] },
  ] };
  const pushed = { projects: [
    { label: 'A', sessions: [{ id: 'a1', isLive: true, title: 'fresh copy' }, { id: 'a3', isLive: true }] },
    { label: 'C', sessions: [{ id: 'c1', isLive: true }] },
  ] };
  const merged = mergeRailModels(slice, pushed);
  assert.deepEqual(merged.projects.map((p) => p.label), ['A', 'B', 'C']);
  assert.deepEqual(merged.projects[0].sessions.map((s) => s.id), ['a1', 'a2', 'a3']);
  assert.equal(merged.projects[0].sessions[0].title, 'fresh copy');
  assert.equal(mergeRailModels(slice, { projects: [] }), slice);
});

test('the header shows only reported context, and plain status words', async () => {
  const { contextFact, statusFact } = await load('shell/session-facts.js');
  assert.equal(contextFact({ contextPct: 62 }).label, '62%');
  assert.equal(contextFact({ contextPct: 81 }).warn, true);
  assert.equal(contextFact({ contextPct: null, contextTokens: 84_200 }).label, '84k', 'tokens alone when the window is unknown');
  assert.equal(contextFact({ contextPct: null, contextTokens: null }), null, 'nothing reported, nothing shown');
  assert.match(contextFact({ contextPct: null, contextTokens: 84_200 }, 'Codex').title, /Codex has not reported/, 'a codex window never blames Claude');
  assert.match(contextFact({ contextPct: null, contextTokens: 84_200 }).title, /Claude has not reported/);
  const now = Date.UTC(2026, 9, 11, 20, 0, 0);
  assert.equal(statusFact({ session: { isLive: true, paneId: 'p' }, header: { blocked: true } }).label, 'Waiting on you');
  assert.equal(statusFact({ session: { isLive: true, paneId: 'p' }, header: { working: true }, meter: '1m 12s · ↓ 2.4k' }).label, 'Working 1m 12s · ↓ 2.4k');
  assert.equal(statusFact({ session: { isLive: true, paneId: 'p' }, header: { lastWriteMs: now - 12 * 60_000 }, now }).label, 'Idle 12m 00s');
  assert.equal(statusFact({ session: { isLive: false }, header: null, now }).label, 'Not running');
  assert.equal(statusFact({ session: { isLive: true, paneId: 'p', agentStatus: 'working' }, header: { working: true, stale: true }, now }).label, 'Last seen working', 'a cached header never claims the session is working now');
});
