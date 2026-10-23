'use strict';

// CLAUDE'S PROGRAM STATUS (OSC 7501), app half. The keeper persists the CLI's
// own status (test/daemon/program-status.test.js); the session-daemon client
// turns a change into pane.agent_status_changed, the sidebar bridge patches the
// rail row with the status AND the CLI's words on its fast path, and the
// notifier never calls the idle that `clear` became a finish.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SessionSubscription, snapshotFromSessions } = require('../../src/main/session-daemon/client.js');
const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');
const { applySidebarDelta } = require('../../src/shared/sidebar-sync.cjs');
const { mergeSidebarModel } = require('../../src/shared/sidebar-model.cjs');
const { createNotifier } = require('../../src/main/notify.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function statusEvents(frames) {
  let panes = [];
  const owner = { snapshot: async () => ({ snapshot: { workspaces: [], tabs: [], layouts: [], panes } }) };
  const sub = new SessionSubscription(owner, { pollIntervalMs: 60_000 });
  const events = [];
  sub.on('event', (event) => { if (event.event === 'pane.agent_status_changed') events.push(event.data); });
  try {
    for (const frame of frames) { panes = frame; await sub._poll(); }
  } finally { sub.close(); }
  return events;
}
const pane = (status, extra = {}) => ({ pane_id: 'p1', workspace_id: 'p1', agent: 'claude', agent_session: null, agent_status: status, ...extra });

test('a status change becomes pane.agent_status_changed; clear reads as idle; repeats are silent', async () => {
  const events = await statusEvents([
    [pane('working')],
    [pane('working')],
    [pane('working', { agent_status_msg: 'Running tests' })],
    [pane('blocked', { agent_status_kind: 'permission', agent_status_msg: 'approve Write: /tmp/x' })],
    [pane('done')],
    [pane(null)],
    [pane(null)],
  ]);
  assert.deepEqual(events.map((e) => e.agent_status), ['working', 'working', 'blocked', 'done', 'idle']);
  assert.equal(events[1].agent_status_msg, 'Running tests', 'a new step inside working is an event');
  assert.equal(events[2].agent_status_kind, 'permission');
  assert.equal(events[2].agent_status_msg, 'approve Write: /tmp/x');
  assert.ok(events.every((e) => e.agent_status !== 'unknown'), 'unknown would drop the session');
});

test('an idle that came from clear carries agent_status_cleared; a reported idle does not', async () => {
  const events = await statusEvents([[pane('working')], [pane(null)], [pane('working')], [pane('idle')]]);
  assert.deepEqual(events.map((e) => [e.agent_status, e.agent_status_cleared ?? false]),
    [['working', false], ['idle', true], ['working', false], ['idle', false]]);
});

test('the seq rides the pane and the event; an old keeper state without the fields still loads', async () => {
  const base = { id: 's1', cwd: '/tmp/x', pid: 1, agent: 'claude', agent_session: 'abc', agent_status: 'blocked', agent_status_kind: 'permission', agent_status_msg: 'approve Write: …/x' };
  assert.equal(snapshotFromSessions([{ ...base, agent_status_seq: 7 }], '/home/u').panes[0].agent_status_seq, 7);
  const old = snapshotFromSessions([{ id: 's1', cwd: '/tmp/x', pid: 1, agent: 'claude', agent_session: 'abc' }], '/home/u').panes[0];
  assert.equal(old.agent_status, null);
  assert.equal(old.agent_status_seq, null);
  // Same status, kind and text but a new seq: the poll missed the turn in
  // between, and that is still a new prompt.
  const prompt = (seq) => pane('blocked', { agent_status_kind: 'permission', agent_status_msg: 'approve Write: …/x', agent_status_seq: seq });
  const events = await statusEvents([[prompt(2)], [prompt(2)], [prompt(4)]]);
  assert.deepEqual(events.map((e) => e.agent_status_seq), [2, 4]);
});

function liveBridge(status = 'idle') {
  const historyRows = [{ id: 'sess-1', project: 'Project A', title: 'Title', lastActive: '2026-10-11T12:00:00Z', cwd: '/synthetic/a' }];
  const history = Object.assign(new EventEmitter(), { listSessions: async () => historyRows, sessionHomes: async () => ({}), close() {} });
  return createSidebarBridge({
    history, providerHistory: null, providerSessionLinker: null, delegationIndex: null,
    createControlClient: () => ({ bootstrap: async () => ({
      snapshot: { workspaces: [{ workspace_id: 'w', label: 'Project A' }], panes: [{ pane_id: 'p', workspace_id: 'w', agent: 'claude', agent_session: { kind: 'id', value: 'sess-1' }, agent_status: status }] },
      subscription: Object.assign(new EventEmitter(), { close() {} }),
    }) }),
  });
}
const rowOf = (state) => state.model.projects.flatMap((p) => p.sessions).find((r) => r.id === 'sess-1');
const statusEvent = (data) => ({ event: 'pane.agent_status_changed', data: { pane_id: 'p', workspace_id: 'w', ...data } });

// The rail is a versioned delta: a status event patches only the fields it
// names, so the CLI's words must be IN that patch or the rail never sees them.
test('the status fast path patches the CLI words onto the row, and a full merge agrees', async () => {
  const bridge = liveBridge();
  try {
    await bridge.start();
    let state = bridge.getState();
    const pushes = [];
    bridge.emitter.on('update', (next) => pushes.push(next));
    bridge.onPaneAgentStatus(statusEvent({ agent_status: 'blocked', agent_status_kind: 'permission', agent_status_msg: 'approve Write: /tmp/x', agent_status_seq: 3 }));
    await sleep(40);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].delta.kind, 'delta', 'a patch, not a full model');
    state = applySidebarDelta(state, pushes[0].delta);
    assert.deepEqual(state, bridge.getState());
    const row = rowOf(state);
    assert.equal(row.agentStatus, 'blocked');
    assert.equal(row.agentStatusKind, 'permission');
    assert.equal(row.agentStatusMsg, 'approve Write: /tmp/x');
    assert.equal(row.agentStatusSeq, 3);
    // A full merge from the same panes derives the same fields.
    const merged = mergeSidebarModel({
      historySessions: [{ id: 'sess-1', project: 'Project A', title: 'Title', lastActive: '2026-10-11T12:00:00Z' }],
      livePanes: [{ pane_id: 'p', workspace_id: 'w', agent: 'claude', agent_session: { kind: 'id', value: 'sess-1' }, agent_status: 'blocked', agent_status_kind: 'permission', agent_status_msg: 'approve Write: /tmp/x', agent_status_seq: 3 }],
      workspaces: [{ workspace_id: 'w', label: 'Project A' }],
    });
    const mergedRow = merged.projects.flatMap((p) => p.sessions).find((r) => r.id === 'sess-1');
    for (const key of ['agentStatus', 'agentStatusKind', 'agentStatusMsg', 'agentStatusSeq']) assert.equal(mergedRow[key], row[key], key);
    // Leaving blocked clears the words, on the same fast path.
    bridge.onPaneAgentStatus(statusEvent({ agent_status: 'done' }));
    await sleep(40);
    assert.equal(pushes.length, 2);
    assert.equal(rowOf(bridge.getState()).agentStatusMsg, null);
    assert.equal(rowOf(bridge.getState()).agentStatusKind, null);
  } finally { bridge.close(); }
});

test('a new step inside working is patched, coalesced, and pulled in by a real transition', async () => {
  const bridge = liveBridge('working');
  try {
    await bridge.start();
    const pushes = [];
    bridge.emitter.on('update', (next) => pushes.push(next));
    bridge.onPaneAgentStatus(statusEvent({ agent_status: 'working', agent_status_msg: 'Reading files' }));
    bridge.onPaneAgentStatus(statusEvent({ agent_status: 'working', agent_status_msg: 'Running tests' }));
    await sleep(60);
    assert.equal(pushes.length, 0, 'a step-only update waits');
    await sleep(320);
    assert.equal(pushes.length, 1, 'two steps, one patch');
    assert.equal(rowOf(bridge.getState()).agentStatusMsg, 'Running tests');
    bridge.onPaneAgentStatus(statusEvent({ agent_status: 'working', agent_status_msg: 'Writing report' }));
    bridge.onPaneAgentStatus(statusEvent({ agent_status: 'blocked', agent_status_kind: 'permission', agent_status_msg: 'approve Bash: rm x' }));
    await sleep(40);
    assert.equal(pushes.length, 2, 'the transition did not wait behind the step');
    assert.equal(rowOf(bridge.getState()).agentStatus, 'blocked');
  } finally { bridge.close(); }
});

test('the notifier does not call the idle that clear became a finish', () => {
  const calls = [];
  const notifier = createNotifier({ notify: (title, body) => calls.push(body), setBadgeCount: () => {} });
  try {
    notifier.onAgentStatusChanged({ event: 'pane.agent_status_changed', data: { pane_id: 'k', agent_status: 'working' } });
    notifier.onAgentStatusChanged({ event: 'pane.agent_status_changed', data: { pane_id: 'k', agent_status: 'idle', agent_status_cleared: true } });
    notifier._flushNow();
    assert.equal(calls.length, 0, 'a killed working session is not a finished turn');
    notifier.onAgentStatusChanged({ event: 'pane.agent_status_changed', data: { pane_id: 'f', agent_status: 'working' } });
    notifier.onAgentStatusChanged({ event: 'pane.agent_status_changed', data: { pane_id: 'f', agent_status: 'done' } });
    notifier._flushNow();
    assert.equal(calls.length, 1, 'a reported finish still toasts');
  } finally { notifier.destroy(); }
});
