'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPaneEvent, withLaunchedHomes } = require('../../src/main/sidebar-bridge.js');

test('pane agent status events update the sidebar pane state', () => {
  const state = {
    workspaces: [],
    panes: [{ pane_id: 'pane-1', agent_status: 'idle' }],
  };
  const next = applyPaneEvent(state, {
    event: 'pane.agent_status_changed',
    data: { pane_id: 'pane-1', agent_status: 'working' },
  });
  assert.equal(next.panes[0].agent_status, 'working');
});

test('duplicate pane agent status events do not create new sidebar state', () => {
  const state = {
    workspaces: [],
    panes: [{ pane_id: 'pane-1', agent_status: 'working' }],
  };
  const next = applyPaneEvent(state, {
    event: 'pane.agent_status_changed',
    data: { pane_id: 'pane-1', agent_status: 'working' },
  });
  assert.equal(next, state);
});

// The 2026-07-22 live incident, model layer: the Claude CLI segfaulted back
// to a bash prompt at 23:34 and the session stayed GREEN in the rail for 90
// minutes, because agent facts were only ever added to a pane, never removed.
// Herdr reports agent_status 'unknown' when no foreground agent owns the pane
// (schema enum: idle|working|blocked|done|unknown); that is the exit signal.
test('agent_status unknown drops the pane: a crashed CLI must not stay a live session', () => {
  const state = {
    workspaces: [],
    panes: [{
      pane_id: 'w2:p3',
      workspace_id: 'w2',
      agent: 'claude',
      agent_session: { kind: 'id', value: 'ebe07764' },
      agent_status: 'working',
    }],
  };
  const next = applyPaneEvent(state, {
    event: 'pane.agent_status_changed',
    data: { pane_id: 'w2:p3', agent_status: 'unknown' },
  });
  assert.deepEqual(next.panes, []);
});

test('pane.updated carrying explicit null agent facts drops the pane', () => {
  const state = {
    workspaces: [],
    panes: [{
      pane_id: 'w2:p3',
      workspace_id: 'w2',
      agent: 'claude',
      agent_session: { kind: 'id', value: 'ebe07764' },
      agent_status: 'working',
    }],
  };
  const next = applyPaneEvent(state, {
    event: 'pane.updated',
    data: { pane: { pane_id: 'w2:p3', workspace_id: 'w2', agent: null, agent_session: null } },
  });
  assert.deepEqual(next.panes, []);
});

test('pane.updated OMITTING agent facts preserves them (title chatter must not kill a live session)', () => {
  const state = {
    workspaces: [],
    panes: [{
      pane_id: 'w2:p3',
      workspace_id: 'w2',
      agent: 'claude',
      agent_session: { kind: 'id', value: 'ebe07764' },
      agent_status: 'working',
    }],
  };
  const next = applyPaneEvent(state, {
    event: 'pane.updated',
    data: { pane: { pane_id: 'w2:p3', workspace_id: 'w2', terminal_title: 'new title' } },
  });
  assert.equal(next.panes[0].agent, 'claude');
  assert.equal(next.panes[0].agent_session.value, 'ebe07764');
  assert.equal(next.panes[0].terminal_title, 'new title');
});

// A session Harbor launched itself knows its account before the history index
// does. The index is built from transcript files and a claude session writes no
// transcript until its first message, so a rail row spends that whole gap with
// `home: null`, which `normalizeHome` renders as the DEFAULT profile's badge
// rather than as nothing. Pat launched on the third plan and the rail said the
// first plan, for 1m46s, so he clicked the same button five times (2026-08-09).
test('the rail fills a launched account the index has not learned yet', () => {
  const launched = new Map([['abc-123', 'work']]);
  assert.deepEqual(withLaunchedHomes({}, launched), { 'abc-123': 'work' });
  // FILL only: once the index can answer for a session, the index wins, because
  // a session can be moved or reconfigured after it is launched.
  const indexed = { 'abc-123': 'team' };
  assert.equal(withLaunchedHomes(indexed, launched), indexed, 'same object: nothing to add');
  // An index that looked and honestly found no home is a fact, not a gap.
  const searched = { 'abc-123': null };
  assert.equal(withLaunchedHomes(searched, launched), searched);
  // Other sessions are untouched, and an empty overlay allocates nothing.
  const others = { 'def-456': 'personal' };
  assert.deepEqual(withLaunchedHomes(others, launched), { 'def-456': 'personal', 'abc-123': 'work' });
  assert.equal(withLaunchedHomes(others, new Map()), others);
});
