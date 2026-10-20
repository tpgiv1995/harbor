'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, createStatusQueue, COALESCE_MS, NOTIFY_STATUSES, WORKING } = require('../../src/main/notify.js');

function makeNotifier({ focusedPaneId = null, windowFocused = false } = {}) {
  const calls = [];
  const badgeCounts = [];
  const notifier = createNotifier({
    getFocusedPaneId: () => focusedPaneId,
    isWindowFocused: () => windowFocused,
    notify: (title, body) => calls.push({ title, body }),
    setBadgeCount: (count) => badgeCounts.push(count),
  });
  return { notifier, calls, badgeCounts };
}

function agentStatusEvent(pane_id, agent_status, extra = {}) {
  return {
    event: 'pane.agent_status_changed',
    data: { pane_id, agent_status, title: `Session ${pane_id.slice(0, 6)}`, ...extra },
  };
}

// --- working -> idle/done transition logic ---------------------------------

test('notifier: working->idle fires a notification', (t, done) => {
  const { notifier, calls } = makeNotifier();
  notifier.onAgentStatusChanged(agentStatusEvent('pane-1', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('pane-1', 'idle'));
  notifier._flushNow();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Harbor');
  done();
});

test('notifier: working->done fires a notification', (t, done) => {
  const { notifier, calls } = makeNotifier();
  notifier.onAgentStatusChanged(agentStatusEvent('pane-2', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('pane-2', 'done'));
  notifier._flushNow();
  assert.equal(calls.length, 1);
  done();
});

test('notifier: idle->done does NOT fire (must come from working)', (t, done) => {
  const { notifier, calls } = makeNotifier();
  notifier.onAgentStatusChanged(agentStatusEvent('pane-3', 'idle'));
  notifier.onAgentStatusChanged(agentStatusEvent('pane-3', 'done'));
  notifier._flushNow();
  assert.equal(calls.length, 0);
  done();
});

test('notifier: working->working does NOT fire', (t, done) => {
  const { notifier, calls } = makeNotifier();
  notifier.onAgentStatusChanged(agentStatusEvent('pane-4', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('pane-4', 'working'));
  notifier._flushNow();
  assert.equal(calls.length, 0);
  done();
});

// --- focused pane suppression ----------------------------------------------

test('notifier: no notification for focused pane when window is focused', (t, done) => {
  const { notifier, calls } = makeNotifier({ focusedPaneId: 'pane-5', windowFocused: true });
  notifier.onAgentStatusChanged(agentStatusEvent('pane-5', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('pane-5', 'idle'));
  notifier._flushNow();
  assert.equal(calls.length, 0, 'focused pane should not notify');
  done();
});

test('notifier: notifies focused pane when window is NOT focused', (t, done) => {
  const { notifier, calls } = makeNotifier({ focusedPaneId: 'pane-6', windowFocused: false });
  notifier.onAgentStatusChanged(agentStatusEvent('pane-6', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('pane-6', 'idle'));
  notifier._flushNow();
  assert.equal(calls.length, 1, 'window unfocused means all panes qualify');
  done();
});

test('notifier: notifies non-focused pane even when window is focused', (t, done) => {
  const { notifier, calls } = makeNotifier({ focusedPaneId: 'pane-focus', windowFocused: true });
  notifier.onAgentStatusChanged(agentStatusEvent('pane-other', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('pane-other', 'done'));
  notifier._flushNow();
  assert.equal(calls.length, 1);
  done();
});

// --- coalescing ------------------------------------------------------------

test('notifier: two completions within window coalesce into one native notification', (t, done) => {
  const { notifier, calls } = makeNotifier();

  // Pane A: working -> idle
  notifier.onAgentStatusChanged(agentStatusEvent('pa', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('pa', 'idle'));

  // Pane B: working -> done
  notifier.onAgentStatusChanged(agentStatusEvent('pb', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('pb', 'done'));

  assert.equal(notifier._pendingCount(), 2);
  notifier._flushNow();

  // Both batched into ONE native notification
  assert.equal(calls.length, 1, 'should be exactly one coalesced notification');
  const body = calls[0].body;
  assert.match(body, /2 sessions finished/);
  done();
});

// --- unacknowledged completion badge --------------------------------------

test('notifier: badge counts unique unseen completions and clears on focus acknowledgment', (t, done) => {
  const { notifier, badgeCounts } = makeNotifier();

  notifier.onAgentStatusChanged(agentStatusEvent('badge-a', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('badge-a', 'done'));
  notifier.onAgentStatusChanged(agentStatusEvent('badge-a', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('badge-a', 'blocked'));
  notifier.onAgentStatusChanged(agentStatusEvent('badge-b', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('badge-b', 'idle'));

  assert.deepEqual(badgeCounts, [1, 2], 'a pane is counted once until acknowledged');
  notifier.acknowledgeAll();
  assert.deepEqual(badgeCounts, [1, 2, 0]);
  done();
});

test('notifier: viewing one pane decrements only that unseen completion', (t, done) => {
  const { notifier, badgeCounts } = makeNotifier();
  for (const paneId of ['view-a', 'view-b']) {
    notifier.onAgentStatusChanged(agentStatusEvent(paneId, 'working'));
    notifier.onAgentStatusChanged(agentStatusEvent(paneId, 'done'));
  }

  notifier.acknowledgePane('view-a');
  notifier.acknowledgePane('not-counted');
  assert.deepEqual(badgeCounts, [1, 2, 1]);
  done();
});

test('notifier: single completion produces per-session message (not summary)', (t, done) => {
  const { notifier, calls } = makeNotifier();
  notifier.onAgentStatusChanged(agentStatusEvent('solo', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('solo', 'idle'));
  notifier._flushNow();
  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.doesNotMatch(body, /sessions finished/);
  done();
});

// --- seedFromSnapshot ------------------------------------------------------

test('notifier: seeded pane in working state triggers notification on first idle event', (t, done) => {
  const { notifier, calls } = makeNotifier();
  notifier.seedFromSnapshot({
    panes: [{ pane_id: 'seeded', agent_status: 'working' }],
  });
  notifier.onAgentStatusChanged(agentStatusEvent('seeded', 'idle'));
  notifier._flushNow();
  assert.equal(calls.length, 1, 'seeded working pane should notify on idle');
  done();
});

test('notifier: seeded pane in idle state does NOT trigger notification on done', (t, done) => {
  const { notifier, calls } = makeNotifier();
  notifier.seedFromSnapshot({
    panes: [{ pane_id: 'seeded-idle', agent_status: 'idle' }],
  });
  notifier.onAgentStatusChanged(agentStatusEvent('seeded-idle', 'done'));
  notifier._flushNow();
  assert.equal(calls.length, 0, 'idle->done should not notify (not from working)');
  done();
});

// --- destroy ---------------------------------------------------------------

test('notifier: destroy clears pending batch', (t, done) => {
  const { notifier, calls } = makeNotifier();
  notifier.onAgentStatusChanged(agentStatusEvent('destroy-test', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('destroy-test', 'idle'));
  notifier.destroy();
  assert.equal(notifier._pendingCount(), 0);
  assert.equal(calls.length, 0);
  done();
});

// --- one window, two slots per pane ----------------------------------------
// The window used to keep only the FIRST entry per pane, so a prompt that came
// within COALESCE_MS of a finish was never announced. A pane now has a slot
// for a finish and one for a prompt; the newer entry replaces the older in
// its slot, and at flush a prompt still on screen wins.

test('notifier: a prompt that arrives inside the window of a finish is the one announced', () => {
  const { notifier, calls } = makeNotifier();
  notifier.onAgentStatusChanged(agentStatusEvent('slot-a', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-a', 'done'));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-a', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-a', 'blocked'));
  notifier._flushNow();
  assert.deepEqual(calls.map((call) => call.body), ['Session slot-a needs you']);
});

test('notifier: a prompt answered inside the window gives way to the finish after it', () => {
  const { notifier, calls } = makeNotifier();
  notifier.onAgentStatusChanged(agentStatusEvent('slot-b', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-b', 'blocked'));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-b', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-b', 'done'));
  assert.equal(notifier._pendingCount(), 2, 'one prompt slot and one finish slot');
  notifier._flushNow();
  assert.deepEqual(calls.map((call) => call.body), ['Session slot-b finished']);
});

test('notifier: a prompt answered while the turn goes on toasts nothing and leaves no badge', () => {
  const { notifier, calls, badgeCounts } = makeNotifier();
  notifier.onAgentStatusChanged(agentStatusEvent('slot-c', 'working'));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-c', 'blocked'));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-c', 'working'));
  notifier._flushNow();
  assert.equal(calls.length, 0);
  assert.equal(badgeCounts.at(-1), 0);
});

test('notifier: a newer finish replaces the older one in its slot', () => {
  const { notifier, calls } = makeNotifier();
  notifier.onAgentStatusChanged(agentStatusEvent('slot-d', 'working', { title: 'Old title' }));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-d', 'idle', { title: 'Old title' }));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-d', 'working', { title: 'New title' }));
  notifier.onAgentStatusChanged(agentStatusEvent('slot-d', 'done', { title: 'New title' }));
  assert.equal(notifier._pendingCount(), 1);
  notifier._flushNow();
  assert.deepEqual(calls.map((call) => call.body), ['New title finished']);
});

test('notifier: a coalesced toast counts prompts apart from finishes', () => {
  const { notifier, calls } = makeNotifier();
  for (const [paneId, status] of [['mix-a', 'done'], ['mix-b', 'idle'], ['mix-c', 'blocked']]) {
    notifier.onAgentStatusChanged(agentStatusEvent(paneId, 'working'));
    notifier.onAgentStatusChanged(agentStatusEvent(paneId, status));
  }
  notifier._flushNow();
  assert.deepEqual(calls.map((call) => call.body), ['2 sessions finished · 1 needs you']);
});

// --- status queue ----------------------------------------------------------

test('status queue: a working never overtakes the idle that is waiting on its scan', async () => {
  const delivered = [];
  let release;
  const queue = createStatusQueue({
    scanFor: (data) => (data.agent_status === 'idle' ? new Promise((resolve) => { release = resolve; }) : null),
    deliver: (event) => delivered.push(event.data.agent_status),
  });
  queue(agentStatusEvent('q', 'working'));
  queue(agentStatusEvent('q', 'idle'));
  const last = queue(agentStatusEvent('q', 'working'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ['working'], 'the second working waits behind the idle');
  release();
  await last;
  assert.deepEqual(delivered, ['working', 'idle', 'working']);
});

test('status queue: a failed scan still delivers its event', async () => {
  const delivered = [];
  const queue = createStatusQueue({
    scanFor: (data) => (data.agent_status === 'done' ? Promise.reject(new Error('scan failed')) : null),
    deliver: (event) => delivered.push(event.data.agent_status),
  });
  queue(agentStatusEvent('q', 'working'));
  await queue(agentStatusEvent('q', 'done'));
  const thrown = createStatusQueue({ scanFor: () => { throw new Error('sync'); }, deliver: (event) => delivered.push(event.data.agent_status) });
  await thrown(agentStatusEvent('q', 'idle'));
  assert.deepEqual(delivered, ['working', 'done', 'idle']);
});

test('status queue: the notifier ends on the real state, so the next finish still toasts', async () => {
  const { notifier, calls } = makeNotifier();
  let release;
  const queue = createStatusQueue({
    scanFor: (data) => (data.agent_status === 'idle' ? new Promise((resolve) => { release = resolve; }) : null),
    deliver: (event) => notifier.onAgentStatusChanged(event),
  });
  queue(agentStatusEvent('real', 'working'));
  queue(agentStatusEvent('real', 'idle'));
  const resumed = queue(agentStatusEvent('real', 'working'));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await resumed;
  notifier._flushNow();
  assert.equal(calls.length, 1, 'the first turn finished');
  // Out of order, the late idle would have been the last word and this done
  // (idle -> done) would not count as a finish.
  await queue(agentStatusEvent('real', 'done'));
  notifier._flushNow();
  assert.equal(calls.length, 2, 'the second turn finished too');
});
