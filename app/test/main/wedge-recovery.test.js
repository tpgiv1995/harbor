'use strict';

// THE WATCHDOG HEALS WITHOUT AN APP RELAUNCH (2026-08-30, r2-selfheal item 3).
// The old onWedge body ran app.relaunch() after recovery because a wedge's
// established connections never emit 'close'; every recovery lane now ends
// with the wedged process dead, so the bridges reconnect in place and the
// relaunch is gone from the wedge path (daemon:retry keeps its relaunch as the
// manual last resort). The module spec pins the policy with injected fakes;
// the wiring spec pins index.js's watchdog block to the new module, which is
// the assertion that FAILS at pre-fix HEAD (the block contained app.relaunch).
// The full Electron drive belongs to the e2e port batch, honestly labelled.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createWedgeRecovery } = require('../../src/main/wedge-recovery.js');

test('on a wedge it recovers in place: recover-mode connect, banner, reconnect poke, and no relaunch surface at all', async () => {
  const calls = { connect: [], banners: [], reconnects: 0 };
  const onWedge = createWedgeRecovery({
    connectDaemon: async (options) => { calls.connect.push(options); return true; },
    setBanner: (banner) => calls.banners.push(banner),
    reconnectNow: () => { calls.reconnects += 1; },
  });
  assert.equal(await onWedge(), true);
  assert.deepEqual(calls.connect, [{ recover: true }], 'the wedge lane connects in recover mode');
  assert.equal(calls.banners.length, 1);
  assert.match(calls.banners[0].error, /recovering: the session daemon went unresponsive/);
  assert.equal(calls.reconnects, 1, 'a successful recover cuts the bridge backoff tail');
});

test('a failed recovery leaves the error banner and never pokes the bridges', async () => {
  const calls = { banners: [], reconnects: 0 };
  const onWedge = createWedgeRecovery({
    connectDaemon: async () => false,
    setBanner: (banner) => calls.banners.push(banner),
    reconnectNow: () => { calls.reconnects += 1; },
  });
  assert.equal(await onWedge(), false);
  assert.equal(calls.banners.length, 1, 'the recovering banner stays; daemon:retry is the manual path');
  assert.equal(calls.reconnects, 0, 'no poke without a healthy daemon');
});

test('a throwing reconnect poke never breaks the recovery verdict', async () => {
  const onWedge = createWedgeRecovery({
    connectDaemon: async () => true,
    setBanner: () => {},
    reconnectNow: () => { throw new Error('bridge already closed'); },
  });
  assert.equal(await onWedge(), true);
});

test('requires its two real dependencies', () => {
  assert.throws(() => createWedgeRecovery({}), /requires connectDaemon and setBanner/);
});

test('index.js wires the watchdog to wedge-recovery and its block carries no app.relaunch', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/main/index.js'), 'utf8');
  const start = source.indexOf('daemonWatchdog = createDaemonWatchdog');
  const end = source.indexOf('daemonWatchdog.start()', start);
  assert.ok(start >= 0 && end > start, 'the watchdog wiring block exists');
  const block = source.slice(start, end);
  assert.ok(block.includes('createWedgeRecovery'), 'onWedge is the wedge-recovery policy');
  assert.ok(!block.includes('app.relaunch'), 'the wedge path never relaunches the app');
  assert.ok(!block.includes('app.exit'), 'the wedge path never exits the app');
});
