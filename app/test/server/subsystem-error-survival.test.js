'use strict';

// A subsystem failure must not kill harbor-server.
//
// Live incident 2026-08-03 15:23:32: one python3 child failed inside
// history.sessionHomes(); sidebar-bridge's refreshHistory re-emitted it as
// emitter.emit('error', err); compose.js had registered NO 'error' listener;
// Node's documented behaviour for an EventEmitter emitting 'error' with no
// listener is to THROW; harbor-server exited 1 with Pat's phone connected.
// The journal signature is "Emitted 'error' event at:".
//
// The desktop root has always had `sidebarBridge.emitter.on('error', ...)`, so
// the identical condition merely logged there. This is the fifth time a new
// composition root has missed something the desktop root has.
//
// These specs are deliberately TWO-SIDED. A test that only asserts "the server
// survived" passes just as well when the emit never happened, which is exactly
// how a guard rots. Each case therefore proves the emit REACHED the emitter
// (listener count > 0) AND that the process survived it.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { composeServer } = require('../../src/server/compose.js');

function stubs(dir) {
  return {
    sidebar: { emitter: new EventEmitter(), async start() {}, close() {}, getState: () => ({ model: {} }) },
    transcript: { emitter: new EventEmitter(), close() {}, closeAll() {} },
    terminalBridge: { emitter: new EventEmitter(), async start() {}, close() {} },
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable() { return false; } },
    icons: { async list() { return { dir, icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
  };
}

async function compose(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-suberr-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Merge FIRST, then hand the same objects to composeServer and back to the
  // caller. Returning the pre-override stubs meant a test emitted on an
  // emitter the server had never seen, so it threw for the wrong reason.
  const s = { ...stubs(dir), ...extra };
  const composed = await composeServer({
    userDataDir: dir,
    env: { ...process.env, HARBOR_NO_DAEMON_START: '1', HARBOR_TAILNET_LOGINS: 'none', HARBOR_SESSIOND_DIR: path.join(dir, 'sessiond') },
    ...s,
  });
  t.after(() => composed.close());
  return { composed, ...s };
}

test('SUBSYS-ERR-1: every subsystem that can emit error HAS a listener in the headless root', async (t) => {
  const { sidebar, transcript, terminalBridge } = await compose(t);
  // Without this, the emits below would pass for the wrong reason: an emitter
  // nobody listens to and nobody emits on also "survives".
  for (const [name, emitter] of [['sidebar', sidebar.emitter], ['transcript', transcript.emitter], ['terminal-bridge', terminalBridge.emitter]]) {
    assert.ok(
      emitter.listenerCount('error') > 0,
      `${name} has no 'error' listener in the headless composition; an emit would throw and kill harbor-server`,
    );
  }
});

test('SUBSYS-ERR-2: a sidebar error survives, which is the exact 2026-08-03 crash', async (t) => {
  const { sidebar } = await compose(t);
  // Byte-for-byte the error that killed the server: an execFile rejection from
  // the python child behind history.sessionHomes().
  const real = new Error('Command failed: python3 -c import importlib.util, json, sys');
  assert.doesNotThrow(() => sidebar.emitter.emit('error', real));
});

test('SUBSYS-ERR-3: transcript and terminal-bridge errors survive too', async (t) => {
  const { transcript, terminalBridge } = await compose(t);
  assert.doesNotThrow(() => transcript.emitter.emit('error', new Error('transcript tail failed')));
  assert.doesNotThrow(() => terminalBridge.emitter.emit('error', new Error('pane stream died')));
});

test('SUBSYS-ERR-4: the server still SERVES after a subsystem error, not merely survives', async (t) => {
  const { composed, sidebar } = await compose(t, {
    sidebar: { emitter: new EventEmitter(), async start() {}, close() {}, getState: () => ({ model: { projects: ['still here'] } }) },
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  sidebar.emitter?.emit?.('error', new Error('boom'));
  // Degrade, do not die: the rail keeps serving its last good state.
  const res = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(res.status, 200);
});

test('SUBSYS-ERR-5: an unlistened emitter really would throw (the guard is not vacuous)', () => {
  // Proves the failure mode this file defends against is real, so nobody later
  // decides these listeners are decoration and removes them.
  const bare = new EventEmitter();
  assert.equal(bare.listenerCount('error'), 0);
  assert.throws(() => bare.emit('error', new Error('unlistened')), /unlistened/);
});
