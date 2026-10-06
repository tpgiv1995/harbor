'use strict';
// The rail learns which sessions Harbor put to sleep from the daemon's sleep
// ledger (daemon/dormant-ledger.js, 2026-10-06), so "asleep" and "not running"
// can look different. Two-sided: a row in the ledger reads as dormant, and a
// daemon from before the ledger (which rejects the request) changes nothing
// and raises nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');

function fakeHistory() {
  const history = new EventEmitter();
  history.listSessions = async () => [
    { id: 'slept', lastActive: '2026-09-04 22:00', project: 'proj', title: 'slept overnight', cwd: 'C:\\dev\\proj' },
    { id: 'closed', lastActive: '2026-09-04 21:00', project: 'proj', title: 'closed by hand', cwd: 'C:\\dev\\proj' },
  ];
  history.sessionHomes = async () => ({});
  history.sessionMeta = async () => ({});
  history.sessionPreview = async () => '';
  history.close = () => {};
  return history;
}

function fakeClient(dormantSessions) {
  const subscription = new EventEmitter();
  subscription.close = () => {};
  let asked = 0;
  return {
    asked: () => asked,
    bootstrap: async () => ({
      snapshot: {
        workspaces: [{ workspace_id: 'w1', label: 'proj', cwd: 'C:\\dev\\proj' }],
        panes: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'claude', agent_session: { kind: 'id', value: 'live-1' } }],
      },
      subscription,
    }),
    dormantSessions: async () => { asked += 1; return dormantSessions(); },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (model, id) => model.projects.flatMap((p) => p.sessions).find((s) => s.id === id);

test('a session in the daemon sleep ledger reads as dormant; others do not', async () => {
  const client = fakeClient(() => ({ slept: { at: '2026-09-06T00:00:00.000Z', agent: 'claude' } }));
  const bridge = createSidebarBridge({
    history: fakeHistory(), providerHistory: null, providerSessionLinker: null, createControlClient: () => client,
  });
  const updates = [];
  bridge.emitter.on('update', (update) => updates.push(update));
  await bridge.start();
  await sleep(50);
  const model = bridge.getState().model;
  assert.equal(row(model, 'slept').dormant, true, 'put to sleep after its last turn: dormant');
  assert.equal(row(model, 'closed').dormant, false, 'not in the ledger: just not running');
  assert.equal(row(model, 'live-1').dormant, undefined, 'a live pane is never asleep');
  assert.equal(row(updates.at(-1).model, 'slept').dormant, true, 'the renderer was told');
  assert.equal(client.asked(), 1);
  bridge.close();
});

test('a daemon from before the ledger changes nothing and raises nothing', async () => {
  const client = fakeClient(() => { throw new Error('unsupported verb: dormant'); });
  const bridge = createSidebarBridge({
    history: fakeHistory(), providerHistory: null, providerSessionLinker: null, createControlClient: () => client,
  });
  const errors = [];
  bridge.emitter.on('error', (error) => errors.push(error));
  await bridge.start();
  await sleep(50);
  assert.equal(row(bridge.getState().model, 'slept').dormant, false);
  assert.deepEqual(errors, []);
  bridge.close();
});
