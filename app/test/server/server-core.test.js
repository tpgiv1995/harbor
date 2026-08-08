'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAppShim } = require('../../src/server/app-shim.js');
const { ensureServerToken, authorizeMethod } = require('../../src/server/transport/auth.js');
const { ClientQueue } = require('../../src/server/transport/ws.js');
test('app shim supplies only userData and throws for every other path', () => {
  const app = createAppShim({ userDataDir: '/tmp/isolated-harbor' });
  assert.equal(app.getPath('userData'), '/tmp/isolated-harbor');
  assert.throws(() => app.getPath('appData'), /app\.getPath\('appData'\) is not available headless/);
});

test('server token is stable, random, and mode 0600', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-auth-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await ensureServerToken(dir); const second = await ensureServerToken(dir);
  assert.equal(first, second); assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(path.join(dir, 'server-token'))).mode & 0o777, 0o600);
});
test('capability gate denies session:send without auth and names local-only refusals', () => {
  assert.throws(() => authorizeMethod('session:send', { authenticated: false }), /authentication required.*session:send/);
  assert.doesNotThrow(() => authorizeMethod('session:send', { authenticated: true }));
  assert.throws(() => authorizeMethod('window:minimize', { authenticated: true }), /window:minimize.*local-only/);
  assert.doesNotThrow(() => authorizeMethod('sidebar:get-state', { authenticated: false }));
});
test('client queue drops oldest terminal frame without growing past its bound', () => {
  const queue = new ClientQueue({ limit: 3, logger: { warn() {} }, clientId: 'phone' });
  queue.enqueue('sidebar:update', { n: 1 }); queue.enqueue('terminal:frame', { n: 1 });
  queue.enqueue('terminal:frame', { n: 2 }); queue.enqueue('terminal:frame', { n: 3 });
  assert.equal(queue.length, 3); assert.equal(queue.droppedFrames, 1);
  // Items are serialized on enqueue now (the queue is byte-bounded, so it has
  // to know each item's real size); the ordering assertion is unchanged.
  assert.deepEqual(queue.items.map((item) => JSON.parse(item.text).n), [1, 2, 3]);
});
