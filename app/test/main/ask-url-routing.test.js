'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouter } = require('../../src/main/rpc/router.js');
const { bindIpcMain, registerIpcHandler } = require('../../src/main/rpc/ipc-transport.js');

test('ask URL routing refuses remote browser launch before the desktop IPC adapter', async () => {
  const router = createRouter();
  const handlers = new Map();
  const ipc = { handle: (name, fn) => handlers.set(name, fn) };
  const calls = [];
  registerIpcHandler(router, ipc, 'ask:answer', (_event, payload) => {
    calls.push(payload);
    return { ok: true };
  });
  bindIpcMain(router, ipc);
  for (const source of ['ws', 'remote', undefined]) {
    const result = await router.call('ask:answer', { id: 'toy', action: 'open-url' }, { source });
    assert.equal(result.ok, false);
  }
  assert.equal(calls.length, 0);
  assert.equal((await router.call('ask:answer', { id: 'toy', action: 'accept' }, { source: 'ws' })).ok, true);
  assert.equal((await handlers.get('ask:answer')({}, { id: 'toy', action: 'open-url' })).ok, true);
  assert.deepEqual(calls.map(call => call.action), ['accept', 'open-url']);
});
