'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, COALESCE_MS, NOTIFY_STATUSES, WORKING } = require('../../src/main/notify.js');

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
