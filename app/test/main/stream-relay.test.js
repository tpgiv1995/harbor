'use strict';

// The app half of the 2026-10-14 daemon stall. The daemon half (one relay per
// connection and pane, brakes when the client falls behind, `unobserve`) is
// proven against a real daemon in test/daemon/sessiond.test.js and measured
// with scripts/load-sessiond-win.js. These pin what Harbor itself must do:
// tell the daemon when a pane is no longer watched, keep listening across a
// reconnect, repaint a view whose frames were shed, and close the connection
// every one-off health check opens.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { SessionStreamSupervisor } = require('../../src/main/session-daemon/streams.js');
const { createTerminalBridge } = require('../../src/main/terminal-bridge.js');
const { pingDaemonOnce } = require('../../src/main/session-daemon/factory.js');

function fakeClient() {
  const events = new EventEmitter();
  const calls = [];
  let closes = 0;
  return {
    calls,
    get closes() { return closes; },
    emitEvent: (event) => events.emit('event', event),
    onEvent(listener) { events.on('event', listener); return () => events.off('event', listener); },
    request: async (verb, params) => { calls.push([verb, params]); return { observing: verb === 'observe' }; },
    close() { closes += 1; },
  };
}

const frame = (id, text) => ({ id, type: 'frame', text, bytes: Buffer.from(text).toString('base64') });

test('detaching a pane tells the daemon to stop relaying it', async () => {
  const client = fakeClient();
  const supervisor = new SessionStreamSupervisor({ client });
  const frames = [];
  supervisor.on('frame', ({ paneId, text }) => frames.push([paneId, text]));
  supervisor.attachObserver('p1');
  client.emitEvent(frame('p1', 'before'));
  supervisor.detach('p1');
  client.emitEvent(frame('p1', 'after'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.calls, [['observe', { id: 'p1' }], ['unobserve', { id: 'p1' }]]);
  assert.deepEqual(frames, [['p1', 'before']]);
});

test('a reset keeps listening, so a pane re-attached after a reconnect still gets frames', () => {
  const client = fakeClient();
  const supervisor = new SessionStreamSupervisor({ client });
  const frames = [];
  supervisor.on('frame', ({ paneId, text }) => frames.push([paneId, text]));
  supervisor.attachObserver('p1');
  supervisor.reset();
  assert.equal(client.closes, 1, 'the dead connection is dropped');
  assert.equal(supervisor.observers.size, 0);
  supervisor.attachObserver('p1');
  client.emitEvent(frame('p1', 'after the reconnect'));
  assert.deepEqual(frames, [['p1', 'after the reconnect']],
    'detach() used here removed the only listener and froze every >_ view');
});

test('a full detach (app shutdown) stops listening for good', () => {
  const client = fakeClient();
  const supervisor = new SessionStreamSupervisor({ client });
  const frames = [];
  supervisor.on('frame', () => frames.push(1));
  supervisor.attachObserver('p1');
  supervisor.detach();
  client.emitEvent(frame('p1', 'late'));
  assert.equal(frames.length, 0);
});

test('the bridge reconnect path resets the supervisor instead of detaching it', () => {
  const source = require('node:fs').readFileSync(require.resolve('../../src/main/terminal-bridge.js'), 'utf8');
  const reconnect = source.slice(source.indexOf('const attemptReconnect'), source.indexOf('const scheduleReconnect'));
  assert.match(reconnect, /supervisor\.reset\(\)/);
  assert.doesNotMatch(reconnect, /supervisor\.detach\(\)/);
});

function bridgeWith() {
  const reads = [];
  class FakeSessionDaemon {
    async bootstrap() { return { snapshot: { panes: [{ pane_id: 'p1' }], tabs: [], layouts: [] }, subscription: Object.assign(new EventEmitter(), { close() {} }) }; }
    async snapshot() { return { snapshot: { panes: [{ pane_id: 'p1' }] } }; }
    async readPane(paneId) { reads.push(paneId); return { read: { text: 'history line' } }; }
  }
  const supervisor = new EventEmitter();
  supervisor.detach = () => {};
  supervisor.attachObserver = () => ({});
  supervisor.ensureDialogSize = async () => ({ ok: true });
  const bridge = createTerminalBridge({
    createControlClient: () => new FakeSessionDaemon(),
    createStreamSupervisor: () => supervisor,
    env: { ...process.env, HARBOR_SESSION_BACKEND: 'sessiond' },
    sessionStorePolicy: { allowed: true },
  });
  return { bridge, supervisor, reads };
}

test('a degraded stream repaints a visible pane from its history, and only a visible one', async () => {
  const { bridge, supervisor, reads } = bridgeWith();
  await bridge.start();
  await bridge.setVisiblePanes([{ paneId: 'p1', cols: 90, rows: 28 }]);
  const resets = [];
  bridge.emitter.on('reset', ({ paneId }) => resets.push(paneId));
  reads.length = 0;

  supervisor.emit('warning', { paneId: 'p1', type: 'stream-degraded', dropped_frames: 12 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(resets, ['p1']);
  assert.deepEqual(reads, ['p1'], 'the view is rebuilt from the pane, not left missing output');

  supervisor.emit('warning', { paneId: 'p2', type: 'stream-degraded', dropped_frames: 3 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(resets, ['p1'], 'a pane nobody is looking at is not repainted');
  bridge.close();
});

test('a one-off health check closes the connection it opened', async () => {
  const opened = [];
  class StubClient {
    constructor() { this.closed = false; opened.push(this); }
    async ping() { return { ok: true }; }
    close() { this.closed = true; }
  }
  class FailingClient extends StubClient { async ping() { throw new Error('timed out'); } }
  const options = { env: { HARBOR_SESSION_BACKEND: 'sessiond' }, sessionStorePolicy: { allowed: true } };
  assert.deepEqual(await pingDaemonOnce({ ...options, SessionDaemonClient: StubClient }), { ok: true });
  await assert.rejects(pingDaemonOnce({ ...options, SessionDaemonClient: FailingClient }), /timed out/);
  assert.deepEqual(opened.map((client) => client.closed), [true, true],
    'the app watchdog pinged every 30 s through a fresh client and never closed one');
});

test('every ping site goes through the closing helper', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(require.resolve('../../src/main/index.js'), 'utf8');
  const server = fs.readFileSync(require.resolve('../../src/server/compose.js'), 'utf8');
  for (const [name, source] of [['main/index.js', main], ['server/compose.js', server]]) {
    assert.doesNotMatch(source, /createControlClient\([^)]*\)\.ping\(\)/, `${name} pings through a client it never closes`);
  }
});

// Keys a session send types are ANSWERED (Sol's review, 2026-11-18): the
// keeper replies once it has written them, and a write it refused fails the
// send instead of leaving it to wait minutes for text that was never typed.
test('an answered write resolves when the keeper took the keys and rejects when it did not', async () => {
  const client = fakeClient();
  client.request = async (verb, params) => {
    client.calls.push([verb, params]);
    if (verb === 'input' && params.text === 'refused') throw new Error('session p1 has exited');
    return { accepted: true };
  };
  const supervisor = new SessionStreamSupervisor({ client });
  await assert.rejects(supervisor.sendInputAcked('p1', 'x'), /not controlling p1/, 'only the controlling client types');
  supervisor.acquireControl('p1', { cols: 80, rows: 24 });
  assert.deepEqual(await supervisor.sendInputAcked('p1', 'hello'), { accepted: true });
  await assert.rejects(supervisor.sendInputAcked('p1', 'refused'), /has exited/);
  assert.deepEqual(client.calls.filter(([verb]) => verb === 'input'), [['input', { id: 'p1', text: 'hello' }], ['input', { id: 'p1', text: 'refused' }]]);
});
