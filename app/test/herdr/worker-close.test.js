'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createTerminalBridge } = require('../../src/main/terminal-bridge.js');

function subscription() {
  const sub = new EventEmitter();
  sub.close = () => {};
  return sub;
}

function fakeBridge({ initial, snapshots, closeTab, closePane, closeWorkspace, processInfo, processKill }) {
  class FakeHerdr {
    async bootstrap() { return { snapshot: initial, subscription: subscription() }; }
    async snapshot() { return { snapshot: snapshots.shift() || snapshots.at(-1) || { panes: [] } }; }
    async closeTab(id) { return closeTab?.(id); }
    async closePane(id) { return closePane?.(id); }
    async closeWorkspace(id) { return closeWorkspace?.(id); }
    async processInfo(id) { return processInfo?.(id); }
    async exportLayout() { return {}; }
  }
  // A herdr-backend suite: it injects a fake herdr client, so it says so
  // instead of inheriting the default.
  return createTerminalBridge({
    HerdrClient: FakeHerdr,
    env: { ...process.env, HARBOR_SESSION_BACKEND: 'herdr' },
    processKill,
    closePollIntervalMs: 0,
    closePollAttempts: 3,
  });
}

test('tab close returns a verified structured result after pane disappears', async () => {
  const calls = [];
  const pane = { pane_id: 'p1', tab_id: 't1' };
  const bridge = fakeBridge({
    initial: { panes: [pane], tabs: [{ tab_id: 't1', workspace_id: 'w1' }], layouts: [] },
    snapshots: [{ panes: [pane] }, { panes: [] }],
    closeTab: async (id) => calls.push(['tab', id]),
  });
  await bridge.start();

  assert.deepEqual(await bridge.closePaneTab('p1'), {
    ok: true, method: 'tab', verified: true,
  });
  assert.deepEqual(calls, [['tab', 't1']]);
  bridge.close();
});

test('pane close fallback fires when fresh snapshot cannot resolve a tab', async () => {
  const calls = [];
  const bridge = fakeBridge({
    initial: { panes: [], tabs: [], layouts: [] },
    snapshots: [{ panes: [{ pane_id: 'p2' }] }, { panes: [] }],
    closePane: async (id) => calls.push(['pane', id]),
  });
  await bridge.start();

  assert.deepEqual(await bridge.closePaneTab('p2'), {
    ok: true, method: 'pane', verified: true,
  });
  assert.deepEqual(calls, [['pane', 'p2']]);
  bridge.close();
});

test('fresh snapshot preserves last-tab workspace close when subscription state is stale', async () => {
  const calls = [];
  const bridge = fakeBridge({
    initial: { panes: [], tabs: [], layouts: [] },
    snapshots: [{
      panes: [{ pane_id: 'p-last', tab_id: 't-last' }],
      tabs: [{ tab_id: 't-last', workspace_id: 'w-last' }],
    }, { panes: [] }],
    closeTab: async () => { throw new Error('cannot close the last tab'); },
    closeWorkspace: async (id) => calls.push(id),
  });
  await bridge.start();

  assert.deepEqual(await bridge.closePaneTab('p-last'), {
    ok: true, method: 'tab', verified: true,
  });
  assert.deepEqual(calls, ['w-last']);
  bridge.close();
});

test('signal fallback SIGTERMs the exact process group and polls until dead', async () => {
  const pane = { pane_id: 'p3', tab_id: 't3' };
  const signals = [];
  let aliveChecks = 0;
  const bridge = fakeBridge({
    initial: { panes: [pane], tabs: [{ tab_id: 't3', workspace_id: 'w3' }], layouts: [] },
    snapshots: [
      { panes: [pane] },
      { panes: [pane] }, { panes: [pane] }, { panes: [pane] },
      { panes: [pane] }, { panes: [] },
    ],
    closeTab: async () => {},
    processInfo: async () => ({ process_info: {
      pane_id: 'p3', shell_pid: 4321, foreground_process_group_id: 8765,
    } }),
    processKill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 0) {
        aliveChecks += 1;
        if (aliveChecks >= 2) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
    },
  });
  await bridge.start();

  assert.deepEqual(await bridge.closePaneTab('p3'), {
    ok: true, method: 'signal', verified: true,
  });
  // closePaneTab now polls the captured pid inside verifyGone before the signal
  // fallback runs, so the SIGTERM is no longer guaranteed to be signals[0].
  assert.ok(signals.some(([pid, signal]) => pid === -8765 && signal === 'SIGTERM'), 'SIGTERMs the process group');
  assert.ok(signals.some(([pid, signal]) => pid === 4321 && signal === 0), 'polls the shell pid');
  assert.ok(aliveChecks >= 2);
  bridge.close();
});

test('tab close escalates to an exact-pid kill when the pane leaves but its process survives', async () => {
  // The half-kill bug: closing the tab removes the pane from the daemon, but the
  // worker's `claude --resume` process lives on. Pane-absence must not read as a
  // kill; closePaneTab escalates to an exact SIGTERM/SIGKILL on the captured pgid.
  const pane = { pane_id: 'p5', tab_id: 't5' };
  const signals = [];
  let sigkilled = false;
  const bridge = fakeBridge({
    initial: { panes: [pane], tabs: [{ tab_id: 't5', workspace_id: 'w5' }], layouts: [] },
    snapshots: [{ panes: [pane] }, { panes: [] }],
    closeTab: async () => {},
    processInfo: async () => ({ process_info: {
      pane_id: 'p5', shell_pid: 5000, foreground_process_group_id: 6000,
    } }),
    processKill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGKILL') sigkilled = true;
      if (signal === 0 && sigkilled) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      // signal 0 while alive, and SIGTERM/SIGKILL, are all no-ops that "land"
    },
  });
  await bridge.start();

  const result = await bridge.closePaneTab('p5');
  assert.deepEqual(result, { ok: true, method: 'tab+signal', verified: true });
  assert.ok(signals.some(([pid, signal]) => pid === -6000 && signal === 'SIGTERM'), 'SIGTERMs the captured process group');
  assert.ok(signals.some(([pid, signal]) => pid === -6000 && signal === 'SIGKILL'), 'escalates to SIGKILL when the orphan ignores SIGTERM');
  bridge.close();
});

test('tab close reports an honest failure when the orphaned process cannot be killed', async () => {
  const pane = { pane_id: 'p6', tab_id: 't6' };
  const bridge = fakeBridge({
    initial: { panes: [pane], tabs: [{ tab_id: 't6', workspace_id: 'w6' }], layouts: [] },
    snapshots: [{ panes: [pane] }, { panes: [] }],
    closeTab: async () => {},
    processInfo: async () => ({ process_info: {
      pane_id: 'p6', shell_pid: 7000, foreground_process_group_id: 7001,
    } }),
    processKill: () => {}, // every signal is a no-op: the orphan never dies
  });
  await bridge.start();

  const result = await bridge.closePaneTab('p6');
  assert.equal(result.ok, false);
  assert.equal(result.method, 'tab+signal');
  assert.equal(result.verified, false);
  assert.match(result.reason, /survived SIGTERM and SIGKILL/i);
  bridge.close();
});

test('force close enters signal path and reports an honest verification failure', async () => {
  const pane = { pane_id: 'p4', tab_id: 't4' };
  const bridge = fakeBridge({
    initial: { panes: [pane], tabs: [{ tab_id: 't4', workspace_id: 'w4' }], layouts: [] },
    snapshots: Array.from({ length: 8 }, () => ({ panes: [pane] })),
    processInfo: async () => ({ process_info: { pane_id: 'p4', shell_pid: 999 } }),
    processKill: () => {},
  });
  await bridge.start();

  const result = await bridge.closePaneTab('p4', { force: true });
  assert.equal(result.ok, false);
  assert.equal(result.method, 'signal');
  assert.equal(result.verified, false);
  assert.match(result.reason, /survived SIGTERM and SIGKILL/i);
  bridge.close();
});
