'use strict';

// The rules around growing a pane so a dialog fits in it. The measurement and
// These guards keep sessiond sizing from fighting anything on the machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createTerminalBridge } = require('../../src/main/terminal-bridge.js');
const { SessionStreamSupervisor } = require('../../src/main/session-daemon/streams.js');
const { SessionSubscription, snapshotFromSessions } = require('../../src/main/session-daemon/client.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function subscription() {
  const sub = new EventEmitter();
  sub.close = () => {};
  return sub;
}

function bridgeWith(panes, extra = {}) {
  class FakeSessionDaemon {
    async bootstrap() { return { snapshot: { panes, tabs: [], layouts: [] }, subscription: subscription() }; }
    async snapshot() { return { snapshot: { panes } }; }
    async readPane() { return { read: { text: '' } }; }
    async focusPane() { return {}; }
    async focusWorkspace() { return {}; }
    async focusTab() { return {}; }
    async exportLayout() { return {}; }
  }
  const supervisor = new EventEmitter();
  supervisor.detach = () => {};
  return createTerminalBridge({
    createControlClient: () => new FakeSessionDaemon(),
    createStreamSupervisor: () => supervisor,
    env: { ...process.env, HARBOR_SESSION_BACKEND: 'sessiond' },
    sessionStorePolicy: { allowed: true },
    ...extra,
  });
}

test('the sessiond supervisor resizes a pane to dialog geometry', async () => {
  const calls = [];
  const client = {
    onEvent: () => () => {},
    request: async (verb, params) => { calls.push([verb, params]); return { ok: true }; },
    close() {},
  };
  const supervisor = new SessionStreamSupervisor({ client });
  assert.deepEqual(await supervisor.ensureDialogSize('p1', { cols: 120, rows: 60 }), {
    ok: true, via: 'sessiond', cols: 120, rows: 60,
  });
  assert.deepEqual(calls, [['resize', { id: 'p1', cols: 120, rows: 60, purpose: 'dialog' }]]);
  supervisor.detach();
});

test('a pane is sized once, and only forced again on demand', async () => {
  const bridge = bridgeWith([{ pane_id: 'p1' }]);
  await bridge.start();
  const calls = [];
  bridge.supervisor.ensureDialogSize = async (paneId, size) => { calls.push({ paneId, size }); return { ok: true }; };

  assert.equal((await bridge.ensureDialogSize('p1')).ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].size, { cols: 120, rows: 60 });

  // The card polls every 700ms; a size attempt per poll would be a resize storm.
  await bridge.ensureDialogSize('p1');
  await bridge.ensureDialogSize('p1');
  assert.equal(calls.length, 1, 'sized once per pane');

  // force is the "this dialog is STILL clipped" retry, and it is rate limited
  // too, so a pane that keeps snapping back cannot turn into a loop.
  await bridge.ensureDialogSize('p1', { force: true });
  assert.equal(calls.length, 1, 'a forced retry still waits out the cooldown');
});

// A pane with an open ">_" view belongs to that xterm's fit: the human is
// looking at a real terminal at the size they gave it, and resizing it out from
// under them is exactly the kind of out-of-band poke that is never allowed.
test('a pane with the raw terminal open is never resized behind it', async () => {
  const bridge = bridgeWith([{ pane_id: 'p1' }]);
  await bridge.start();
  let called = 0;
  bridge.supervisor.ensureDialogSize = async () => { called += 1; return { ok: true }; };
  bridge.supervisor.attachObserver = () => ({});

  await bridge.setVisiblePanes([{ paneId: 'p1', cols: 90, rows: 28 }]);
  const res = await bridge.ensureDialogSize('p1');
  assert.equal(res.ok, false);
  assert.match(res.reason, /raw terminal/);
  assert.equal(called, 0);
});

test('a sizing failure is reported, never thrown into the poll', async () => {
  const bridge = bridgeWith([{ pane_id: 'p1' }]);
  await bridge.start();
  bridge.supervisor.ensureDialogSize = async () => { throw new Error('control refused'); };
  const res = await bridge.ensureDialogSize('p1');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'control refused');
});

test('no pane, no sizing', async () => {
  const bridge = bridgeWith([]);
  await bridge.start();
  assert.equal((await bridge.ensureDialogSize(null)).ok, false);
});

// Caught on the live machine minutes after shipping the sizing: every pane sat
// at 60 rows except the FOCUSED one, which was back at 23. Taking control
// resizes the pty, and the fallback size there was 80x24, so the first click or
// send undid the fix and the next dialog clipped again.
test('taking control of a pane without a >_ view keeps the dialog geometry', async () => {
  const bridge = bridgeWith([{ pane_id: 'p1', tab_id: 't1' }]);
  await bridge.start();
  const sizes = [];
  bridge.supervisor.acquireControl = (paneId, size) => { sizes.push(size); return {}; };
  bridge.supervisor.attachObserver = () => ({});

  await bridge.focusPane({ paneId: 'p1' });
  assert.deepEqual(sizes.at(-1), { cols: 120, rows: 60 });
});

test('a pane with a >_ view open keeps the size that xterm fitted', async () => {
  const bridge = bridgeWith([{ pane_id: 'p1', tab_id: 't1' }]);
  await bridge.start();
  const sizes = [];
  bridge.supervisor.acquireControl = (paneId, size) => { sizes.push(size); return {}; };
  bridge.supervisor.attachObserver = () => ({});

  await bridge.setVisiblePanes([{ paneId: 'p1', cols: 94, rows: 31 }]);
  await bridge.focusPane({ paneId: 'p1' });
  assert.deepEqual(sizes.at(-1), { cols: 94, rows: 31 }, "the human's terminal size wins");
});

// Control is exclusive per pane, so an acquire landing on top of the sizer is
// refused, and a refusal marks the pane
// externally-controlled: a send then fails for a reason that has nothing to do
// with the send. One gate run out of four tripped it before this wait existed.
// requestFocusPane is the path EVERY send takes, and it had the same 80x24
// fallback: the pane Harbor was driving sat at 24 rows on the live machine
// while every other pane was at 60.
test('the send path takes control at the dialog geometry too', async () => {
  const bridge = bridgeWith([{ pane_id: 'p1', tab_id: 't1' }]);
  await bridge.start();
  const sizes = [];
  bridge.supervisor.acquireControl = (paneId, size) => { sizes.push(size); return {}; };
  bridge.supervisor.attachObserver = () => ({});

  await bridge.requestFocusPane({ paneId: 'p1' });
  assert.deepEqual(sizes.at(-1), { cols: 120, rows: 60 });

  await bridge.setVisiblePanes([{ paneId: 'p1', cols: 94, rows: 31 }]);
  await bridge.requestFocusPane({ paneId: 'p1' });
  assert.deepEqual(sizes.at(-1), { cols: 94, rows: 31 }, "an open >_ still owns its size");
});

test('taking control waits out an in-flight sizing instead of racing it', async () => {
  const bridge = bridgeWith([{ pane_id: 'p1', tab_id: 't1' }]);
  await bridge.start();
  const order = [];
  let release;
  const sizing = new Promise((r) => { release = r; });
  bridge.supervisor.sizingFor = (paneId) => (paneId === 'p1' ? sizing.then(() => order.push('sized')) : null);
  bridge.supervisor.acquireControl = () => { order.push('acquired'); return {}; };
  bridge.supervisor.attachObserver = () => ({});

  const focused = bridge.focusPane({ paneId: 'p1' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, [], 'control is not taken while the sizer holds the pane');
  release();
  await focused;
  assert.deepEqual(order, ['sized', 'acquired']);
});

// Live-caught an hour after the sizing shipped: two of Pat's twelve panes were
// still 23x54, because sizing only ran from the question card's poll and that
// poll only exists while a session has an OPEN WINDOW. A session can be asked a
// question with its window closed, and he would open it onto exactly the
// clipped dialog this was supposed to end.
test('the sweep sizes every pane, including ones no window is watching', async () => {
  const bridge = bridgeWith([]);
  await bridge.start();
  bridge.seedFromSnapshot({
    snapshot: {
      panes: [], tabs: [],
      layouts: [
        { tab_id: 't1', panes: [{ pane_id: 'p1' }, { pane_id: 'p2' }] },
        { tab_id: 't2', panes: [{ pane_id: 'p3' }] },
      ],
    },
  });
  const sized = [];
  bridge.supervisor.ensureDialogSize = async (paneId) => { sized.push(paneId); return { ok: true }; };
  bridge.supervisor.attachObserver = () => ({});

  await bridge.sizeAllPanes();
  assert.deepEqual(sized, ['p1', 'p2', 'p3']);

  // A success never repeats: twelve transient control attaches every sweep
  // would be a storm on the daemon.
  await bridge.sizeAllPanes();
  assert.deepEqual(sized, ['p1', 'p2', 'p3']);
});

test('a refused sizing is retried later, because attempted is not fixed', async () => {
  const bridge = bridgeWith([]);
  await bridge.start();
  bridge.seedFromSnapshot({ snapshot: { panes: [], tabs: [], layouts: [{ tab_id: 't1', panes: [{ pane_id: 'p1' }] }] } });
  let ok = false;
  const tries = [];
  bridge.supervisor.ensureDialogSize = async (paneId) => { tries.push(paneId); return { ok }; };
  bridge.supervisor.attachObserver = () => ({});

  await bridge.sizeAllPanes();
  assert.equal(tries.length, 1, 'refused the first time');
  await bridge.sizeAllPanes();
  assert.equal(tries.length, 1, 'and not hammered inside the cooldown');
});

test('the sweep leaves a pane with the raw terminal open alone', async () => {
  const bridge = bridgeWith([]);
  await bridge.start();
  bridge.seedFromSnapshot({ snapshot: { panes: [], tabs: [], layouts: [{ tab_id: 't1', panes: [{ pane_id: 'p1' }] }] } });
  const sized = [];
  bridge.supervisor.ensureDialogSize = async (paneId) => { sized.push(paneId); return { ok: true }; };
  bridge.supervisor.attachObserver = () => ({});
  await bridge.setVisiblePanes([{ paneId: 'p1', cols: 94, rows: 31 }]);
  await bridge.sizeAllPanes();
  assert.deepEqual(sized, []);
});

// A RAW VIEW OWNS ITS PANE'S SIZE ACROSS CLIENTS (2026-11-06, Pat: "look at the
// scrambled lettering"). The phone server's bridge grew a pane Pat was watching
// raw on the desktop to 120x60 and the desktop view scrambled.
test('a dialog resize the daemon refuses is a failure the bridge retries, not a success', async () => {
  const client = {
    onEvent: () => () => {},
    request: async () => ({ resized: false, reason: 'a raw terminal view owns this pane size' }),
    close() {},
  };
  const supervisor = new SessionStreamSupervisor({ client });
  assert.deepEqual(await supervisor.ensureDialogSize('p1'), { ok: false, reason: 'a raw terminal view owns this pane size' });
  supervisor.detach();
});

test('the daemon poll reports a pane another client resized', async () => {
  let sessions = [{ id: 'p1', cwd: 'C:\\dev\\x', cols: 154, rows: 35 }];
  const owner = { snapshot: async () => ({ snapshot: snapshotFromSessions(sessions, 'C:\\Users\\x') }) };
  const sub = new SessionSubscription(owner, { pollIntervalMs: 60_000 });
  const events = [];
  sub.on('event', (event) => events.push(event));
  await sub._poll();
  await sub._poll();
  assert.equal(events.filter((e) => e.event === 'pane.resized').length, 0, 'an unchanged size says nothing');
  sessions = [{ ...sessions[0], cols: 120, rows: 60 }];
  await sub._poll();
  assert.deepEqual(events.filter((e) => e.event === 'pane.resized').map((e) => e.data), [{ pane_id: 'p1', cols: 120, rows: 60 }]);
  sub.close();
});

async function viewing(extra = {}) {
  const bridge = bridgeWith([{ pane_id: 'p1', tab_id: 't1' }], { healConfirmMs: 20, healMinGapMs: 300, ...extra });
  await bridge.start();
  const resizes = [];
  const resets = [];
  bridge.supervisor.attachObserver = () => ({});
  bridge.supervisor.resize = (paneId, size) => resizes.push({ paneId, ...size });
  bridge.emitter.on('reset', ({ paneId }) => resets.push(paneId));
  await bridge.setVisiblePanes([{ paneId: 'p1', cols: 154, rows: 35 }]);
  resizes.length = 0;
  resets.length = 0;
  return { bridge, resizes, resets };
}
const daemonSays = (bridge, cols, rows, paneId = 'p1') => bridge.applyEvent({ event: 'pane.resized', data: { pane_id: paneId, cols, rows } });

test('an open >_ view takes its size back when another client resizes its pane, and repaints', async () => {
  const { bridge, resizes, resets } = await viewing();
  daemonSays(bridge, 120, 60);
  await sleep(100);
  assert.deepEqual(resizes, [{ paneId: 'p1', cols: 154, rows: 35 }], 'the view\'s own size goes back to the pty');
  assert.deepEqual(resets, ['p1'], 'and the view is cleared and refilled at that size');
  daemonSays(bridge, 154, 35);
  await sleep(100);
  assert.equal(resizes.length, 1, 'once the daemon agrees, nothing more happens');
  bridge.close();
});

test('a size that agrees with the view again within the confirm delay is left alone (the bridge\'s own resize landing)', async () => {
  const { bridge, resizes, resets } = await viewing({ healConfirmMs: 80 });
  daemonSays(bridge, 150, 34);
  daemonSays(bridge, 154, 35);
  await sleep(200);
  assert.deepEqual(resizes, []);
  assert.deepEqual(resets, []);
  bridge.close();
});

test('two viewers cannot flap a pane: one heal per gap', async () => {
  const { bridge, resizes } = await viewing();
  daemonSays(bridge, 120, 60);
  await sleep(100);
  daemonSays(bridge, 154, 35);
  daemonSays(bridge, 70, 40);
  await sleep(100);
  assert.equal(resizes.length, 1, 'a second foreign size inside the gap waits');
  // Astra review 2026-11-06, finding 6: the daemon reports a size only when it
  // changes, so a wrong size that stays put must be repaired once the gap ends.
  await sleep(400);
  assert.equal(resizes.length, 2, 'and is repaired when the gap is over');
  assert.deepEqual(resizes[1], { paneId: 'p1', cols: 154, rows: 35 });
  bridge.close();
});

test('a pane with no open >_ view is never resized by the heal, and the phone server does not heal', async () => {
  const quiet = await viewing();
  daemonSays(quiet.bridge, 120, 60, 'p2');
  await sleep(100);
  assert.deepEqual(quiet.resizes, []);
  quiet.bridge.close();
  const phone = await viewing({ healForeignResize: false });
  daemonSays(phone.bridge, 120, 60);
  await sleep(100);
  assert.deepEqual(phone.resizes, []);
  phone.bridge.close();
});
