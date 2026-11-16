'use strict';

// A client's resources die with the client.
//
// The provider layer under src/main/ was written for Electron main, where there
// is one client and it dies with the process. The mobile server serves the same
// providers to many clients that vanish and return. Before this, nothing
// released what a departed client held: measured on 2026-08-03 against real
// transcripts, six sessions viewed by clients that then dropped their sockets
// left rss at 342MB (from 73MB) and six armed pollers, with nothing freed six
// seconds after every client was gone.
//
// Every spec here is TWO-SIDED on purpose. "The entry is gone after the client
// leaves" passes just as well if opens never worked at all, so each release
// assertion is paired with a control proving the resource was really held while
// the client was still there.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');
const { composeServer } = require('../../src/server/compose.js');
const { ClientQueue } = require('../../src/server/transport/ws.js');
const { createClientResources } = require('../../src/server/client-resources.js');

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

async function harness(t, { metaGate = null, ...options } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-client-lifetime-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const projects = path.join(dir, 'projects');
  await fs.mkdir(projects, { recursive: true });
  const metaById = new Map();
  for (const id of [SESSION_A, SESSION_B]) {
    const file = path.join(projects, `${id}.jsonl`);
    await fs.writeFile(file, `${JSON.stringify({
      type: 'user', sessionId: id, cwd: dir,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    })}\n`);
    metaById.set(id, { path: file, cwd: dir, provider: 'claude' });
  }
  const composed = await composeServer({
    userDataDir: dir,
    env: {
      ...process.env,
      HARBOR_NO_DAEMON_START: '1', HARBOR_TAILNET_LOGINS: 'none',
      HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_VOICE: '1',
      HARBOR_CONTEXT_DIR: path.join(dir, 'context'),
      // The session store is isolated the same way userData is: the default
      // backend owns a real store, and the isolation guard refuses an isolated
      // profile that reaches for it (which is the guard doing its job).
      HARBOR_SESSIOND_DIR: path.join(dir, 'sessiond'),
    },
    sidebar: {
      emitter: new EventEmitter(), async start() {}, close() {},
      getState: () => ({ model: { projects: [] } }),
      getSessionMeta: async (id) => { await metaGate?.(id); return metaById.get(id) || null; },
    },
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable() { return false; }, close() {} },
    icons: { async list() { return { dir, icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({ lists: [] }), mutate: async () => ({ ok: true }), subscribe() {}, close() {} },
    terminalBridge: { close() {} },
    ...options,
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => composed.close());
  return { composed, url: `ws://127.0.0.1:${address.port}/ws?token=${composed.token}`, dir };
}

// EVERY WAIT HERE HAS A DEADLINE THAT NAMES ITS STEP (2026-11-15). This file
// hung three full gate runs in a row on a loaded machine (16+ minutes each,
// the log frozen at an earlier file) and passed alone and 24 copies at once:
// none of its waits could fail, so a lost reply was silence. A healthy step
// here takes milliseconds; thirty seconds is a hang, and the failure says
// which one. scripts/test.js adds the per-test ceiling for every other file.
const STEP_MS = 30_000;
function within(promise, what, ms = STEP_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nothing after ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const connect = (url, opts) => within(new Promise((resolve, reject) => {
  const ws = new WebSocket(url, opts);
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
}), 'websocket connect');

let nextRpcId = 0;
function rpc(ws, method, payload) {
  const id = ++nextRpcId;
  let onMessage;
  const reply = new Promise((resolve) => {
    onMessage = (bytes) => {
      const message = JSON.parse(bytes);
      if (message.type === 'response' && message.id === id) resolve(message);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, payload }));
  });
  return within(reply, `rpc ${method} (id ${id}) response`).finally(() => ws.off('message', onMessage));
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

test('a transcript opened by a client is held while it is connected and released when it vanishes', async (t) => {
  const { composed, url } = await harness(t);
  const ws = await connect(url);
  await rpc(ws, 'transcript:open', { sessionId: SESSION_A });

  // Control side: it really is open while the client is there. Without this the
  // release assertion below would pass even if open had silently failed.
  assert.equal(composed.transcript.openCount(), 1, 'the open must actually take effect while the client is connected');

  // A phone that walks out of range sends no close frame; the socket just dies.
  ws._socket.destroy();
  await settle();
  assert.equal(composed.transcript.openCount(), 0, 'a departed client must not pin the transcript it opened');
});

test('one client cannot close a transcript another client holds', async (t) => {
  const { composed, url } = await harness(t);
  const owner = await connect(url);
  const stranger = await connect(url);
  await rpc(owner, 'transcript:open', { sessionId: SESSION_A });
  assert.equal(composed.transcript.openCount(), 1);

  const refused = await rpc(stranger, 'transcript:close', { sessionId: SESSION_A });
  assert.equal(refused.result.ignored, 'not held by this client');
  assert.equal(composed.transcript.openCount(), 1, "a stranger's close must not decrement the owner's hold");

  // ...and the owner's own close still works, so the guard is not just refusing
  // everything.
  await rpc(owner, 'transcript:close', { sessionId: SESSION_A });
  assert.equal(composed.transcript.openCount(), 0, 'the holder must still be able to close its own transcript');
  owner.close(); stranger.close();
});

test('repeated reconnects to the same session leave nothing stranded', async (t) => {
  const { composed, url } = await harness(t);
  for (let i = 0; i < 5; i += 1) {
    const ws = await connect(url);
    await rpc(ws, 'transcript:open', { sessionId: SESSION_A });
    ws._socket.destroy();
    await settle(80);
  }
  assert.equal(composed.transcript.openCount(), 0, 'five phone reconnects must not leave five stranded refs');

  // And the provider is still usable afterwards: a stranded refcount used to
  // make every later close a no-op, so prove open/close still reaches zero.
  const ws = await connect(url);
  await rpc(ws, 'transcript:open', { sessionId: SESSION_B });
  assert.equal(composed.transcript.openCount(), 1);
  await rpc(ws, 'transcript:close', { sessionId: SESSION_B });
  assert.equal(composed.transcript.openCount(), 0);
  ws.close();
});

test('a client that stops answering is reaped, and a healthy one is left alone', async (t) => {
  const { composed, url } = await harness(t, { heartbeatMs: 60 });

  // autoPong: false is a client that is still TCP-connected but no longer
  // answering, which is what a sleeping or out-of-range phone looks like.
  const silent = await connect(url, { autoPong: false });
  await rpc(silent, 'transcript:open', { sessionId: SESSION_A });
  assert.equal(composed.transcript.openCount(), 1);
  await within(new Promise((resolve) => silent.once('close', resolve)), 'the heartbeat reaping the silent client');
  await settle();
  assert.equal(composed.transcript.openCount(), 0, 'a silent client must be reaped and its holds released');

  // Two-sided: the same heartbeat must NOT disturb a client that is answering,
  // or the reaper would just be disconnecting everyone on a timer.
  const healthy = await connect(url);
  await rpc(healthy, 'transcript:open', { sessionId: SESSION_B });
  await settle(400); // several heartbeat intervals
  assert.equal(healthy.readyState, WebSocket.OPEN, 'a responsive client must survive the heartbeat');
  assert.equal(composed.transcript.openCount(), 1, 'and must keep what it opened');
  healthy.close();
});

test('the outbound queue is bounded by bytes, not just by item count', () => {
  const queue = new ClientQueue({ limit: 256, maxBytes: 1024 * 1024, logger: { warn() {} }, clientId: 'phone' });
  const big = { replace: [{ key: 'b1', text: 'x'.repeat(200 * 1024) }] };
  let accepted = 0;
  while (queue.enqueue('transcript:update', big)) accepted += 1;
  assert.ok(accepted < 256, `the item cap alone must not be the bound (accepted ${accepted})`);
  assert.ok(queue.bytes <= 1024 * 1024, `retained bytes must stay under the cap (was ${queue.bytes})`);
});

test('an empty queue accepts an oversized payload so one big push cannot disconnect a client', () => {
  const queue = new ClientQueue({ limit: 256, maxBytes: 1024, logger: { warn() {} }, clientId: 'phone' });
  assert.equal(queue.enqueue('transcript:update', { text: 'x'.repeat(64 * 1024) }), true);
  assert.equal(queue.length, 1);
  // ...but it does not then keep accepting: the backlog is what is bounded.
  assert.equal(queue.enqueue('transcript:update', { text: 'x'.repeat(64 * 1024) }), false);
});

test('the registry releases exactly as many times as a client acquired, and only what it holds', () => {
  const released = [];
  const resources = createClientResources({ releasers: { transcript: (key) => released.push(key) } });
  resources.acquire('a', 'transcript', 's1');
  resources.acquire('a', 'transcript', 's1'); // two windows on one session
  resources.acquire('b', 'transcript', 's2');

  assert.equal(resources.release('b', 'transcript', 's1'), false, 'b never held s1');
  assert.equal(resources.release('a', 'transcript', 's1'), true);

  resources.releaseAll('a');
  assert.deepEqual(released, ['s1'], 'one acquire remained after the explicit release, so exactly one release runs');
  resources.releaseAll('b');
  assert.deepEqual(released, ['s1', 's2']);
  assert.equal(resources.clientCount(), 0);
});

// EACH TRANSCRIPT GOES ONLY TO THE CLIENTS HOLDING IT (2026-10-21 audit). Every
// socket used to receive every open session's updates, so a busy chat or a
// second device slowed an unrelated phone conversation and a Notes-only viewer
// got whole transcripts it never asked for. Two-sided throughout: the holder
// still receives what a stranger must not.
function collectPushes(ws) {
  const pushes = [];
  ws.on('message', (bytes) => {
    const message = JSON.parse(bytes);
    if (message.type === 'push') pushes.push(message);
  });
  return pushes;
}
const transcriptPushes = (pushes, sessionId) => pushes.filter((m) => m.channel === 'transcript:update' && m.args[0]?.sessionId === sessionId);
const replaces = (pushes, sessionId) => transcriptPushes(pushes, sessionId).filter((m) => Array.isArray(m.args[0].replace));

async function writeUserLine(dir, sessionId, text) {
  await fs.appendFile(path.join(dir, 'projects', `${sessionId}.jsonl`), `${JSON.stringify({
    type: 'user', sessionId, cwd: dir, message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`);
}

test('a transcript update reaches only the clients holding that session', async (t) => {
  const { composed, url, dir } = await harness(t);
  const viewerA = await connect(url);
  const viewerB = await connect(url);
  const notesOnly = await connect(url);
  const [pushesA, pushesB, pushesNotes] = [viewerA, viewerB, notesOnly].map(collectPushes);
  await rpc(viewerA, 'transcript:open', { sessionId: SESSION_A });
  await rpc(viewerB, 'transcript:open', { sessionId: SESSION_B });
  await settle(50);
  assert.equal(replaces(pushesA, SESSION_A).length, 1, 'an opener receives its own first snapshot');

  await writeUserLine(dir, SESSION_A, 'live line for A');
  await composed.transcript.refresh(SESSION_A);
  await settle(80);
  assert.ok(transcriptPushes(pushesA, SESSION_A).some((m) => m.args[0].append?.some((b) => b.text === 'live line for A')),
    'the holder receives the live delta');
  assert.deepEqual(transcriptPushes(pushesB, SESSION_A), [], 'a client viewing another session never receives this one');
  assert.deepEqual(pushesNotes.filter((m) => m.channel === 'transcript:update'), [], 'a client that opened nothing receives no transcript');
  assert.equal(replaces(pushesB, SESSION_B).length, 1, 'control: B still receives its own session');
  viewerA.close(); viewerB.close(); notesOnly.close();
});

test('re-opening a session that is already open sends its snapshot to the requester alone', async (t) => {
  const { composed, url, dir } = await harness(t);
  const first = await connect(url);
  const second = await connect(url);
  const [pushesFirst, pushesSecond] = [first, second].map(collectPushes);
  await rpc(first, 'transcript:open', { sessionId: SESSION_A });
  await settle(50);
  await rpc(second, 'transcript:open', { sessionId: SESSION_A });
  await settle(50);
  assert.equal(replaces(pushesSecond, SESSION_A).length, 1, 'the second opener gets the snapshot');
  assert.equal(replaces(pushesFirst, SESSION_A).length, 1, 'the first holder is current and is not sent it again');

  await writeUserLine(dir, SESSION_A, 'both hold this');
  await composed.transcript.refresh(SESSION_A);
  await settle(80);
  for (const pushes of [pushesFirst, pushesSecond]) {
    assert.ok(transcriptPushes(pushes, SESSION_A).some((m) => m.args[0].append?.some((b) => b.text === 'both hold this')),
      'every holder receives the live delta');
  }
  first.close(); second.close();
});

test('a client that leaves while its open is still in flight leaves nothing open behind it', async (t) => {
  let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { composed, url } = await harness(t, { metaGate: () => { entered(); return gate; } });
  const ws = await connect(url);
  ws.send(JSON.stringify({ id: 1, method: 'transcript:open', payload: { sessionId: SESSION_A } }));
  await within(reached, 'the server entering the gated open'); // the server is inside the open, waiting on the transcript's metadata
  ws._socket.destroy();
  await settle();
  release();
  await settle();
  assert.equal(composed.transcript.openCount(), 0, 'the late open gives its ref straight back');
  assert.equal(composed.clientResources.clientCount(), 0, 'and the departed client is not resurrected as a holder');

  // Control: the same open from a client that stays is held.
  const stays = await connect(url);
  await rpc(stays, 'transcript:open', { sessionId: SESSION_B });
  assert.equal(composed.transcript.openCount(), 1);
  stays.close();
});
