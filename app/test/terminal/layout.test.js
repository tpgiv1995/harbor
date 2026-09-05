'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCROLLBACK_CAP,
  layoutPaneStyles,
  tabsForWorkspace,
  focusedTabForWorkspace,
  partitionTabs,
  layoutForTab,
} = require('../../src/shared/terminal-layout.cjs');
const {
  applyWorkspaceEvent,
  applyTabEvent,
  applyLayoutEvent,
  layoutsToMap,
} = require('../../src/main/terminal-bridge.js');

test('SCROLLBACK_CAP is 10000', () => {
  assert.equal(SCROLLBACK_CAP, 10000);
});

test('layoutPaneStyles converts herdr rects to percentage CSS', () => {
  const styles = layoutPaneStyles({
    area: { x: 10, y: 5, width: 200, height: 100 },
    panes: [
      { pane_id: 'p1', focused: true, rect: { x: 10, y: 5, width: 100, height: 100 } },
      { pane_id: 'p2', focused: false, rect: { x: 110, y: 5, width: 100, height: 100 } },
    ],
  });
  assert.equal(styles.length, 2);
  assert.equal(styles[0].paneId, 'p1');
  assert.equal(styles[0].style.left, '0%');
  assert.equal(styles[0].style.width, '50%');
  assert.equal(styles[1].style.left, '50%');
  assert.equal(styles[0].cols, 100);
});

test('tabsForWorkspace sorts by tab number', () => {
  const tabs = tabsForWorkspace([
    { tab_id: 't2', workspace_id: 'w1', number: 2 },
    { tab_id: 't1', workspace_id: 'w1', number: 1 },
    { tab_id: 't3', workspace_id: 'w2', number: 1 },
  ], 'w1');
  assert.deepEqual(tabs.map((tab) => tab.tab_id), ['t1', 't2']);
});

test('partitionTabs splits BATCH TITLE worker tabs from primary tabs', () => {
  const { primary, workers } = partitionTabs([
    { tab_id: 't1', workspace_id: 'w1', number: 1, label: 'marketing site' },
    { tab_id: 't2', workspace_id: 'w1', number: 2, label: 'BATCH TITLE: D.6: stop' },
    { tab_id: 't3', workspace_id: 'w1', number: 3, label: 'LIVE file fix' },
    { tab_id: 't4', workspace_id: 'w1', number: 4, label: 'BATCH TITLE: D.5: notes' },
    { tab_id: 'tx', workspace_id: 'w2', number: 1, label: 'BATCH TITLE: other workspace' },
  ], 'w1');
  assert.deepEqual(primary.map((t) => t.tab_id), ['t1', 't3']);
  assert.deepEqual(workers.map((t) => t.tab_id), ['t2', 't4']);
});

test('partitionTabs keeps ordering by tab number and ignores other workspaces', () => {
  const { primary, workers } = partitionTabs([
    { tab_id: 'b', workspace_id: 'w1', number: 5, label: 'BATCH TITLE: late' },
    { tab_id: 'a', workspace_id: 'w1', number: 1, label: 'BATCH TITLE: early' },
    { tab_id: 'p', workspace_id: 'w1', number: 3, label: 'real tab' },
  ], 'w1');
  assert.deepEqual(workers.map((t) => t.tab_id), ['a', 'b']);
  assert.deepEqual(primary.map((t) => t.tab_id), ['p']);
});

test('partitionTabs returns empty worker set when no batch tabs exist', () => {
  const { primary, workers } = partitionTabs([
    { tab_id: 't1', workspace_id: 'w1', number: 1, label: 'plain' },
  ], 'w1');
  assert.equal(workers.length, 0);
  assert.equal(primary.length, 1);
});

test('focusedTabForWorkspace prefers focused tab', () => {
  const tab = focusedTabForWorkspace([
    { tab_id: 't1', workspace_id: 'w1', number: 1, focused: false },
    { tab_id: 't2', workspace_id: 'w1', number: 2, focused: true },
  ], 'w1');
  assert.equal(tab.tab_id, 't2');
});

test('layoutForTab reads from object map', () => {
  const layout = { tab_id: 't1', panes: [] };
  assert.deepEqual(layoutForTab({ t1: layout }, 't1'), layout);
});

test('layoutsToMap indexes layouts by tab_id', () => {
  const map = layoutsToMap([{ tab_id: 't1' }, { tab_id: 't2' }]);
  assert.ok(map.t1 && map.t2);
});

test('applyWorkspaceEvent tracks create, update, focus, and close', () => {
  let state = { workspaces: [], tabs: [], layouts: {}, focusedWorkspaceId: null };
  state = applyWorkspaceEvent(state, {
    event: 'workspace.created',
    data: { workspace: { workspace_id: 'w1', label: 'alpha' } },
  });
  assert.equal(state.workspaces.length, 1);
  state = applyWorkspaceEvent(state, {
    event: 'workspace.focused',
    data: { workspace_id: 'w1' },
  });
  assert.equal(state.focusedWorkspaceId, 'w1');
  state = applyWorkspaceEvent(state, {
    event: 'workspace.closed',
    data: { workspace_id: 'w1' },
  });
  assert.equal(state.workspaces.length, 0);
});

test('applyTabEvent tracks tab lifecycle', () => {
  let state = { workspaces: [], tabs: [], layouts: {}, focusedWorkspaceId: null };
  state = applyTabEvent(state, {
    event: 'tab.created',
    data: { tab: { tab_id: 't1', workspace_id: 'w1', label: 'one' } },
  });
  assert.equal(state.tabs.length, 1);
  state = applyTabEvent(state, {
    event: 'tab.renamed',
    data: { tab: { tab_id: 't1', workspace_id: 'w1', label: 'renamed' } },
  });
  assert.equal(state.tabs[0].label, 'renamed');
});

test('applyLayoutEvent stores layout by tab id', () => {
  let state = { workspaces: [], tabs: [], layouts: {}, focusedWorkspaceId: null };
  const layout = { tab_id: 't1', panes: [{ pane_id: 'p1' }] };
  state = applyLayoutEvent(state, { event: 'layout.updated', data: { layout } });
  assert.deepEqual(state.layouts.t1, layout);
});
