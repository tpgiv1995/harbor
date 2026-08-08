'use strict';

// Pure unit tests for the #1270 replay deduper and the client's method surface.
// No daemon required.

const test = require('node:test');
const assert = require('node:assert');
const { Deduper, HerdrClient, LIFECYCLE_SUBSCRIPTIONS } = require('../../src/main/herdr/client.js');

test('Deduper drops replayed pane events by revision, seeded from snapshot', () => {
  const d = new Deduper();
  d.seedSnapshot({
    workspaces: [{ workspace_id: 'w1' }],
    tabs: [{ tab_id: 'w1:t1' }],
    panes: [{ pane_id: 'w1:p1', revision: 5 }],
  });

  // replayed update at the snapshot revision -> replay, dropped
  assert.equal(d.accept({ event: 'pane.updated', data: { pane: { pane_id: 'w1:p1', revision: 5 } } }), false);
  // stale update below the snapshot revision -> dropped
  assert.equal(d.accept({ event: 'pane.updated', data: { pane: { pane_id: 'w1:p1', revision: 4 } } }), false);
  // genuinely newer update -> delivered
  assert.equal(d.accept({ event: 'pane.updated', data: { pane: { pane_id: 'w1:p1', revision: 6 } } }), true);
  // the same newer revision replayed again -> dropped
  assert.equal(d.accept({ event: 'pane.updated', data: { pane: { pane_id: 'w1:p1', revision: 6 } } }), false);
});

test('Deduper drops replayed created events for resources already in the snapshot', () => {
  const d = new Deduper();
  d.seedSnapshot({
    workspaces: [{ workspace_id: 'w1' }],
    tabs: [{ tab_id: 'w1:t1' }],
    panes: [{ pane_id: 'w1:p1', revision: 1 }],
  });

  assert.equal(d.accept({ event: 'workspace.created', data: { workspace: { workspace_id: 'w1' } } }), false);
  assert.equal(d.accept({ event: 'tab.created', data: { tab: { tab_id: 'w1:t1' } } }), false);
  assert.equal(d.accept({ event: 'pane.created', data: { pane: { pane_id: 'w1:p1', revision: 1 } } }), false);

  // a genuinely new workspace passes, and a replay of it is then dropped
  assert.equal(d.accept({ event: 'workspace.created', data: { workspace: { workspace_id: 'w2' } } }), true);
  assert.equal(d.accept({ event: 'workspace.created', data: { workspace: { workspace_id: 'w2' } } }), false);
});

test('Deduper delivers a brand-new pane once and dedupes its replay', () => {
  const d = new Deduper();
  d.seedSnapshot({ panes: [] });
  assert.equal(d.accept({ event: 'pane.created', data: { pane: { pane_id: 'w1:p9', revision: 1 } } }), true);
  // replayed identical created event
  assert.equal(d.accept({ event: 'pane.created', data: { pane: { pane_id: 'w1:p9', revision: 1 } } }), false);
  // later real update is delivered
  assert.equal(d.accept({ event: 'pane.updated', data: { pane: { pane_id: 'w1:p9', revision: 2 } } }), true);
});

test('client method surface covers the required methods', () => {
  const c = new HerdrClient({ socketPath: '/nonexistent.sock' });
  for (const m of [
    'ping', 'snapshot', 'assertProtocol', 'bootstrap', 'subscribe',
    'createWorkspace', 'listWorkspaces', 'focusWorkspace', 'reportWorkspaceMetadata',
    'createTab', 'listTabs', 'focusTab', 'renameTab',
    'listPanes', 'getPane', 'focusPane', 'closePane',
    'sendText', 'sendKeys', 'sendInput', 'exportLayout',
  ]) {
    assert.equal(typeof c[m], 'function', `missing method ${m}`);
  }
});

test('default lifecycle subscriptions are {type}-only and cover pane/tab/workspace/layout', () => {
  const types = LIFECYCLE_SUBSCRIPTIONS.map((s) => s.type);
  for (const t of ['pane.created', 'pane.closed', 'pane.updated', 'tab.created', 'workspace.created', 'layout.updated']) {
    assert.ok(types.includes(t), `missing subscription ${t}`);
  }
  for (const s of LIFECYCLE_SUBSCRIPTIONS) {
    assert.deepEqual(Object.keys(s), ['type'], `subscription ${s.type} must be {type}-only`);
  }
});
