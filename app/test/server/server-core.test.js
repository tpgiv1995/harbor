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

test('server token is stable, random, and mode 0600', {
  skip: process.platform === 'win32' && 'NTFS does not expose POSIX 0600 permission bits',
}, async (t) => {
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

// Latent until 2026-08-30: e2e:* sat in remote-safe. Same shape as the
// 2026-08-08 terminal:* reclassification — no headless handler, so not live,
// but a future wiring would have inherited no-auth access. Two-sided: the
// refusal names local-only WITH a token, and a real remote-safe method still
// passes without one (so this is not "everything now refuses").
test('e2e:* methods are local-only even with a valid token', () => {
  assert.throws(
    () => authorizeMethod('e2e:quit', { authenticated: true }),
    /e2e:quit.*local-only/,
  );
  assert.throws(
    () => authorizeMethod('e2e:set-link', { authenticated: true }),
    /e2e:set-link.*local-only/,
  );
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
