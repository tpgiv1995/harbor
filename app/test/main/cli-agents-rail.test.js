'use strict';

// `claude agents --json` on the rail: a pane's own OSC 7501 status wins, the
// CLI's list fills in for sessions Harbor does not run (and for a pane whose
// keeper or CLI predates OSC 7501), and a list row under a pane's pid is that
// pane's. The list reaches the rail through a full merge; a pane status event
// still takes the fast path, and its patch agrees with the merge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mergeSidebarModel } = require('../../src/shared/sidebar-model.cjs');
const { runStateCue } = require('../../src/shared/session-run-state.cjs');
const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');
const { applySidebarDelta } = require('../../src/shared/sidebar-sync.cjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rowsOf = (model) => new Map(model.projects.flatMap((p) => p.sessions).map((s) => [s.id, s]));
const workspaces = [{ workspace_id: 'w1', label: 'proj' }];
const now = new Date('2026-10-15T20:00:00Z');

test('a pane status wins; the CLI list fills in for sessions Harbor does not run', () => {
  const cliStatuses = new Map([
    ['outside', { status: 'blocked', waitingFor: 'permission prompt', kind: 'interactive', pid: 9000 }],
    ['harbor', { status: 'idle', waitingFor: null, kind: 'interactive', pid: 4242 }],
  ]);
  const historySessions = [
    { id: 'outside', project: 'proj', title: 'Outside session', lastActive: '2026-10-15 14:00' },
    { id: 'harbor', project: 'proj', title: 'Harbor session', lastActive: '2026-10-15 14:00' },
    { id: 'gone', project: 'proj', title: 'Old session', lastActive: '2026-10-01 14:00' },
  ];
  const livePanes = [{ pane_id: 'p1', workspace_id: 'w1', pid: 4242, agent: 'claude', agent_session: { kind: 'id', value: 'harbor' }, agent_status: 'working', agent_status_seq: 2 }];
  const rows = rowsOf(mergeSidebarModel({ historySessions, livePanes, workspaces, cliStatuses, now }));
  assert.equal(rows.get('harbor').agentStatus, 'working', 'OSC 7501 from the pane beats the CLI list');
  assert.equal(rows.get('harbor').panePid, 4242);
  assert.equal(rows.get('outside').agentStatus, 'blocked');
  assert.equal(rows.get('outside').cliAlive, true);
  assert.equal(rows.get('outside').agentWaitingFor, 'permission prompt');
  assert.equal(rows.get('gone').cliAlive, false);
  const cue = runStateCue(rows.get('outside'), null, null);
  assert.equal(cue.kind, 'blocked');
  assert.equal(cue.tooltip, 'waiting on a permission prompt in a window outside Harbor', 'it can only be answered where it runs');
  assert.equal(runStateCue({ ...rows.get('outside'), agentStatus: 'idle', agentWaitingFor: null }, null, null).kind, 'ready', 'listed = running');
  assert.equal(runStateCue(rows.get('gone'), null, null), null, 'not listed, no pane: not running');
  // Without the list, nothing changes.
  const plain = rowsOf(mergeSidebarModel({ historySessions, livePanes, workspaces, now }));
  assert.equal(plain.get('outside').agentStatus, null);
  assert.equal(plain.get('outside').cliAlive, false);
});

// A /clear or fork inside a Harbor pane starts session Y under the pane's own
// CLI process while the pane still holds X. The list row for Y carries the
// pane's pid, so it is the pane's, not a second session outside Harbor.
test('a CLI-list row under a live pane pid is the pane\'s, not a second blocked session', () => {
  const cliStatuses = new Map([
    ['Y', { status: 'blocked', waitingFor: 'permission prompt', kind: 'interactive', pid: 4242 }],
    ['outside', { status: 'blocked', waitingFor: 'permission prompt', kind: 'interactive', pid: 9000 }],
  ]);
  const historySessions = [
    { id: 'X', project: 'proj', title: 'Before /clear', lastActive: '2026-10-15 14:00' },
    { id: 'Y', project: 'proj', title: 'After /clear', lastActive: '2026-10-15 14:05' },
    { id: 'outside', project: 'proj', title: 'Terminal session', lastActive: '2026-10-15 14:05' },
  ];
  // A keeper from before OSC 7501: the pane has no status of its own.
  const livePanes = [{ pane_id: 'p1', workspace_id: 'w1', pid: 4242, agent: 'claude', agent_session: { kind: 'id', value: 'X' }, agent_status: null }];
  const rows = rowsOf(mergeSidebarModel({ historySessions, livePanes, workspaces, cliStatuses, now }));
  assert.equal(rows.get('Y').cliAlive, false, 'Y is the pane, not a window outside Harbor');
  assert.equal(rows.get('Y').agentStatus, null);
  assert.equal(rows.get('X').agentStatus, 'blocked', 'the pane shows the status of the CLI it runs');
  assert.equal(rows.get('X').agentWaitingFor, 'permission prompt');
  assert.equal(rows.get('outside').cliAlive, true);
  assert.equal([...rows.values()].filter((row) => row.agentStatus === 'blocked').length, 2, 'the pane\'s prompt counts once');
  // With an OSC status of its own the pane still wins, and the list's words go.
  const osc = rowsOf(mergeSidebarModel({ historySessions, livePanes: [{ ...livePanes[0], agent_status: 'working', agent_status_seq: 1 }], workspaces, cliStatuses, now }));
  assert.equal(osc.get('X').agentStatus, 'working');
  assert.equal(osc.get('X').agentWaitingFor, null);
});

function bridgeWith(cliAgents, paneStatus = null) {
  const historyRows = [
    { id: 'sess-1', project: 'Project A', title: 'Pane', lastActive: '2026-10-11T12:00:00Z', cwd: '/synthetic/a' },
    { id: 'sess-2', project: 'Project A', title: 'Outside', lastActive: '2026-10-11T12:00:00Z', cwd: '/synthetic/a' },
  ];
  const history = Object.assign(new EventEmitter(), { listSessions: async () => historyRows, sessionHomes: async () => ({}), close() {} });
  return createSidebarBridge({
    cliAgents,
    history, providerHistory: null, providerSessionLinker: null, delegationIndex: null,
    createControlClient: () => ({ bootstrap: async () => ({
      snapshot: { workspaces: [{ workspace_id: 'w', label: 'Project A' }], panes: [{ pane_id: 'p', workspace_id: 'w', pid: 31, agent: 'claude', agent_session: { kind: 'id', value: 'sess-1' }, agent_status: paneStatus }] },
      subscription: Object.assign(new EventEmitter(), { close() {} }),
    }) }),
  });
}
function fakeCliAgents(initial) {
  const emitter = new EventEmitter();
  let snapshot = initial;
  return {
    on: (...args) => emitter.on(...args),
    off: (...args) => emitter.off(...args),
    snapshot: () => snapshot,
    set(next) { snapshot = next; emitter.emit('change', snapshot); },
    listeners: () => emitter.listenerCount('change'),
  };
}
const rowIn = (state, id) => state.model.projects.flatMap((p) => p.sessions).find((r) => r.id === id);

test('a change in the CLI list reaches the rail, and the bridge lets go of the list on close', async () => {
  const cli = fakeCliAgents(new Map());
  const bridge = bridgeWith(cli);
  try {
    await bridge.start();
    let state = bridge.getState();
    assert.equal(rowIn(state, 'sess-2').cliAlive, false);
    const pushes = [];
    bridge.emitter.on('update', (next) => pushes.push(next));
    cli.set(new Map([['sess-2', { status: 'blocked', waitingFor: 'permission prompt', kind: 'interactive', pid: 77 }]]));
    await sleep(40);
    assert.equal(pushes.length, 1);
    state = applySidebarDelta(state, pushes[0].delta);
    assert.deepEqual(state, bridge.getState());
    assert.equal(rowIn(state, 'sess-2').cliAlive, true);
    assert.equal(rowIn(state, 'sess-2').agentStatus, 'blocked');
    assert.equal(rowIn(state, 'sess-2').agentWaitingFor, 'permission prompt');
  } finally { bridge.close(); }
  assert.equal(cli.listeners(), 0);
});

// The list filled in a pre-OSC pane's status (with its words); the pane's own
// report then arrives on the fast path. agentWaitingFor is a status-driven
// field (paneStatusFields), so the patch clears it and agrees with a merge.
test('a pane status on the fast path replaces what the list filled in', async () => {
  const cli = fakeCliAgents(new Map([['sess-1', { status: 'blocked', waitingFor: 'permission prompt', kind: 'interactive', pid: 31 }]]));
  const bridge = bridgeWith(cli);
  try {
    await bridge.start();
    let state = bridge.getState();
    assert.equal(rowIn(state, 'sess-1').agentStatus, 'blocked');
    assert.equal(rowIn(state, 'sess-1').agentWaitingFor, 'permission prompt');
    const pushes = [];
    bridge.emitter.on('update', (next) => pushes.push(next));
    bridge.onPaneAgentStatus({ event: 'pane.agent_status_changed', data: { pane_id: 'p', workspace_id: 'w', agent_status: 'working', agent_status_msg: 'Running tests', agent_status_seq: 4 } });
    await sleep(40);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].delta.kind, 'delta', 'a patch, not a full model');
    state = applySidebarDelta(state, pushes[0].delta);
    const row = rowIn(state, 'sess-1');
    assert.equal(row.agentStatus, 'working');
    assert.equal(row.agentStatusMsg, 'Running tests');
    assert.equal(row.agentWaitingFor, null, 'the list\'s words left with its status');
    const merged = rowIn({ model: mergeSidebarModel({
      historySessions: [{ id: 'sess-1', project: 'Project A', title: 'Pane', lastActive: '2026-10-11T12:00:00Z' }],
      livePanes: [{ pane_id: 'p', workspace_id: 'w', pid: 31, agent: 'claude', agent_session: { kind: 'id', value: 'sess-1' }, agent_status: 'working', agent_status_msg: 'Running tests', agent_status_seq: 4 }],
      workspaces: [{ workspace_id: 'w', label: 'Project A' }],
      cliStatuses: cli.snapshot(),
    }) }, 'sess-1');
    for (const key of ['agentStatus', 'agentStatusKind', 'agentStatusMsg', 'agentStatusSeq', 'agentWaitingFor']) assert.equal(merged[key], row[key], key);
  } finally { bridge.close(); }
});
