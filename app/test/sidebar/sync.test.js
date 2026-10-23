'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { equal, createSidebarPublisher, applySidebarDelta, createSidebarStore } = require('../../src/shared/sidebar-sync.cjs');
const { mergeSidebarModel } = require('../../src/shared/sidebar-model.cjs');
const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `sample-${i}`, project: `Project ${i % 7}`, title: `Title ${i}`, firstPrompt: 'synthetic prompt '.repeat(20), lastActive: '2026-10-11T12:00:00Z', cwd: 'C:\\synthetic\\project' }));
const snapshot = (historySessions, overlay = {}) => ({ model: mergeSidebarModel({ historySessions, now: new Date('2026-10-11T13:00:00Z'), ...overlay }), historyCount: historySessions.length, indexerSessionCount: historySessions.length });

test('randomized sidebar deltas equal full models and preserve unchanged rows/projects', () => {
  const publisher = createSidebarPublisher();
  let history = rows(80); let state = publisher.getState(); let seed = 8247;
  const overlay = { livePanes: [], dormantSessions: {} }; const covered = new Set();
  const random = (max) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % max; };
  for (let step = 0; step < 400; step++) {
    const index = random(history.length); const row = { ...history[index] };
    const action = random(12); covered.add(action);
    switch (action) {
      case 0: history.push({ ...rows(1)[0], id: `added-${step}` }); break;
      case 1: if (history.length > 10) history.splice(index, 1); break;
      case 2: row.title = `Renamed ${step}`; history[index] = row; break;
      case 3: row.project = `Move ${random(6)}`; history[index] = row; break;
      case 4: history.reverse(); break;
      case 5: row.background = { awaitingFinal: Boolean(step % 2), outstanding: [{ id: `task-${step}` }] }; history[index] = row; break;
      case 6: row.delegatedBy = `parent-${step}`; history[index] = row; break;
      case 7: row.delegationSummary = { running: step % 4 }; history[index] = row; break;
      case 8: row.lastActive = new Date(1791700000000 + step * 60000).toISOString(); history[index] = row; break;
      case 9: row.lineage = { kind: 'exec', parentThreadId: null }; history[index] = row; break;
      case 10: overlay.livePanes = [{ pane_id: 'synthetic-pane', agent: 'claude', agent_session: { kind: 'id', value: row.id }, agent_status: step % 2 ? 'working' : 'idle' }]; break;
      case 11: overlay.dormantSessions[row.id] = step % 2 ? { at: '2026-10-12T13:00:00Z' } : null; break;
    }
    const next = snapshot(history, overlay);
    const previous = state;
    const delta = publisher.publish(next);
    if (delta) state = applySidebarDelta(state, structuredClone(delta));
    assert.deepEqual(state.model, next.model, `step ${step}`);
    assert.deepEqual(state, publisher.getState());
    for (const project of state.model.projects) {
      const oldProject = previous.model.projects.find((p) => p.label === project.label);
      if (equal(oldProject, project)) assert.equal(project, oldProject);
      for (const row of project.sessions) {
        const oldRow = oldProject?.sessions.find((s) => s.id === row.id);
        if (equal(oldRow, row)) assert.equal(row, oldRow);
      }
    }
  }
  assert.equal(covered.size, 12, 'the randomized sequence exercises every change kind');
  const old = state;
  const first = old.model.projects[0].sessions[0];
  const delta = publisher.patchRows(new Map([[first.id, { agentStatus: 'working', dormant: true }]]));
  state = applySidebarDelta(state, delta);
  assert.notEqual(state.model.projects[0], old.model.projects[0]);
  assert.equal(state.model.projects[1], old.model.projects[1]);
  assert.equal(state.model.projects[0].sessions[1], old.model.projects[0].sessions[1]);
});

test('one shared subscription heals dropped and out-of-order deltas and reloads a full state', async () => {
  const publisher = createSidebarPublisher(); publisher.publish(snapshot(rows(20)));
  let listener; let subscriptions = 0; let reads = 0;
  const api = { getState: async () => { reads++; return structuredClone(publisher.getState()); }, onUpdate: (fn) => { subscriptions++; listener = fn; return () => {}; } };
  const store = createSidebarStore(api);
  store.subscribe(() => {}); store.subscribe(() => {}); await store.resync();
  assert.equal(subscriptions, 1);
  const dropped = publisher.patchRows(new Map([['sample-0', { agentStatus: 'working' }]]));
  const next = publisher.patchRows(new Map([['sample-1', { dormant: true }]]));
  listener(next); await store.resync();
  assert.deepEqual(store.getSnapshot().model, publisher.getState().model);
  listener(dropped); await store.resync();
  assert.deepEqual(store.getSnapshot().model, publisher.getState().model);
  assert.equal(reads, 3);
  const reloaded = createSidebarStore(api); reloaded.subscribe(() => {}); await reloaded.resync();
  assert.deepEqual(reloaded.getSnapshot().model, publisher.getState().model);
  store.close(); reloaded.close();
});

test('a recovery broadcast arriving during an older snapshot read is retained', async () => {
  let receive; let reply;
  const publisher = createSidebarPublisher(); publisher.publish(snapshot(rows(2)));
  const old = structuredClone(publisher.getState());
  const store = createSidebarStore({ onUpdate: (fn) => { receive = fn; return () => {}; }, getState: () => new Promise((resolve) => { reply = resolve; }) });
  store.subscribe(() => {}); await tick();
  publisher.patchRows(new Map([['sample-0', { agentStatus: 'working' }]]));
  receive(structuredClone(publisher.getState())); reply(old);
  await store.resync();
  assert.deepEqual(store.getSnapshot().model, publisher.getState().model);
  store.close();
});

test('a failed initial snapshot retries without a push or a tight RPC loop', async () => {
  let calls = 0;
  const expected = snapshot(rows(2));
  const store = createSidebarStore({ onUpdate: () => () => {}, getState: async () => {
    if (++calls === 1) throw Error('renderer recovery in progress');
    return { ...expected, version: 1 };
  } });
  try {
    store.subscribe(() => {});
    await tick(); assert.equal(calls, 1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(calls, 2); assert.deepEqual(store.getSnapshot().model, expected.model);
  } finally { store.close(); }
});

test('status-only bridge pushes stay below 10 KB with 10000 history rows', async () => {
  const historyRows = rows(10000);
  const history = Object.assign(new EventEmitter(), { listSessions: async () => historyRows, sessionHomes: async () => ({}), close() {} });
  const bridge = createSidebarBridge({ history, providerHistory: null, providerSessionLinker: null, delegationIndex: null,
    createControlClient: () => ({ bootstrap: async () => ({ snapshot: { workspaces: [{ workspace_id: 'w', label: 'Project 0' }], panes: [{ pane_id: 'p', workspace_id: 'w', agent: 'claude', agent_session: { kind: 'id', value: 'sample-0' }, agent_status: 'idle' }] }, subscription: Object.assign(new EventEmitter(), { close() {} }) }) }) });
  try {
    await bridge.start(); const before = bridge.getState(); let pushed;
    bridge.emitter.on('update', (state) => { pushed = state; });
    bridge.onPaneAgentStatus({ event: 'pane.agent_status_changed', data: { pane_id: 'p', agent_status: 'working' } });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.ok(Buffer.byteLength(JSON.stringify(pushed.delta)) < 10000);
    assert.equal(pushed.delta.projects.length, 1);
    assert.deepEqual(applySidebarDelta(before, pushed.delta), bridge.getState());
    assert.equal(bridge.getState().model.projects.flatMap((p) => p.sessions).find((r) => r.id === 'sample-0').agentStatus, 'working');
    assert.equal(before.model.projects[1], bridge.getState().model.projects[1]);
    pushed = null;
    bridge.onPaneAgentStatus({ event: 'pane.agent_status_changed', data: { pane_id: 'p', agent_status: 'working' } });
    await tick(); assert.equal(pushed, null, 'no-op status never pushes');
  } finally { bridge.close(); }
});

test('a rebuild with no change publishes nothing, even with an untitled live pane', () => {
  // A live row with no history row was stamped with the render time, so it
  // (and its project's metadata) differed on every rebuild and went out in
  // every delta. It now carries the keeper's clock and is stable.
  const publisher = createSidebarPublisher();
  const overlay = { workspaces: [{ workspace_id: 'w', label: 'Project 0' }],
    livePanes: [{ pane_id: 'untitled', workspace_id: 'w', agent: 'claude', created_at: '2026-10-11T12:30:00Z' }] };
  const build = (now) => ({ model: mergeSidebarModel({ historySessions: rows(20), now, ...overlay }), historyCount: 20, indexerSessionCount: 20 });
  assert.ok(publisher.publish(build(new Date('2026-10-11T13:00:00Z'))));
  assert.equal(publisher.publish(build(new Date('2026-10-11T13:05:00Z'))), null);
});

test('machine sessions leave rail snapshots but live panes, Orch and restored windows still resolve', async () => {
  const data = rows(5);
  data[4].meta = { id: data[4].id, path: 'C:\\synthetic\\conversation.jsonl', firstPrompt: 'Full prompt', start: '2026-10-11T10:00:00Z' };
  Object.assign(data[0], { provider: 'codex', lineage: { kind: 'exec', originator: 'codex_exec' } });
  Object.assign(data[1], { provider: 'codex', lineage: { kind: 'guardian', parentThreadId: 'sample-4' } });
  Object.assign(data[2], { entrypoint: 'sdk-cli' });
  Object.assign(data[3], { entrypoint: 'sdk-cli' });
  const history = Object.assign(new EventEmitter(), { listSessions: async () => data, sessionHomes: async () => ({}), close() {} });
  const bridge = createSidebarBridge({ history, providerHistory: null, providerSessionLinker: null, delegationIndex: null,
    createControlClient: () => ({ bootstrap: async () => ({ snapshot: { workspaces: [{ workspace_id: 'w', label: 'Project 3' }], panes: [{ pane_id: 'p', workspace_id: 'w', agent: 'claude', agent_session: { kind: 'id', value: 'sample-3' }, agent_status: 'idle' }] }, subscription: Object.assign(new EventEmitter(), { close() {} }) }) }) });
  try {
    await bridge.start();
    const rail = bridge.getState().model.projects.flatMap((p) => p.sessions);
    assert.deepEqual(rail.map((r) => r.id).sort(), ['sample-3', 'sample-4']);
    assert.equal(bridge.getSession('sample-0').isSubSession, true);
    assert.equal(bridge.isDelegated('sample-0'), true, 'unlinked exec is also read-only');
    assert.equal(bridge.listSubSessions({ older: true }).total, 4);
    assert.equal(bridge.getHistoryRows().length, 5, 'Orch liveness retains the full private history');
    let workerCalls = 0;
    history.sessionMeta = async () => { workerCalls++; throw Error('unexpected worker lookup'); };
    for (let i = 0; i < 10000; i++) assert.equal((await bridge.getSessionMeta('sample-4')).firstPrompt, 'Full prompt');
    assert.equal(workerCalls, 0, 'Orch metadata bursts are served by the bulk refresh, without worker fan-out');
    const full = bridge.getState();
    await bridge.refreshHistory();
    assert.deepEqual(bridge.getState().model, full.model);
  } finally { bridge.close(); }
});
