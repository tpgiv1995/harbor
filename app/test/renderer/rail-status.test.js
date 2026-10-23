'use strict';
// One status light per rail row (renderer/sidebar/rail-status.cjs,
// 2026-10-06): the order is the order Pat would act on things.
const test = require('node:test');
const assert = require('node:assert/strict');
const { railStatus } = require('../../src/renderer/sidebar/rail-status.cjs');

const kind = (input) => railStatus(input).kind;

test('an answer owed outranks everything, from either source', () => {
  assert.equal(kind({ runState: { kind: 'blocked' } }), 'blocked');
  assert.equal(kind({ runState: { kind: 'running', label: 'Working' }, attention: 'blocked' }), 'blocked');
  assert.equal(kind({ attention: 'blocked', dormant: true }), 'blocked');
});

test('work in flight outranks an unseen finish, which outranks plain ready', () => {
  assert.equal(kind({ runState: { kind: 'running', label: 'Working' }, attention: 'finished' }), 'running');
  assert.equal(kind({ runState: { kind: 'background', label: 'watching' }, attention: 'finished' }), 'background');
  assert.equal(kind({ runState: { kind: 'ready' }, attention: 'finished' }), 'finished');
  assert.equal(kind({ runState: { kind: 'ready' } }), 'ready');
});

test('asleep and not running are different states', () => {
  assert.equal(kind({ dormant: true }), 'dormant');
  assert.equal(kind({}), 'stopped');
  assert.equal(kind({ attention: 'finished', dormant: true }), 'finished', 'an unseen finish still shows on a session that later slept');
  assert.equal(kind({ runState: { kind: 'ready' }, dormant: true }), 'ready', 'running again beats an old sleep');
});

test('every state carries a label for the tooltip and screen readers', () => {
  assert.equal(railStatus({ runState: { kind: 'running', label: 'Compiling' } }).label, 'Working: Compiling');
  assert.equal(railStatus({ runState: { kind: 'running', label: 'Working' } }).label, 'Working');
  assert.match(railStatus({ dormant: true }).label, /^Asleep/);
  assert.equal(railStatus({}).label, 'Not running');
  assert.equal(railStatus({ runState: { kind: 'background', label: '2 tasks running', tooltip: 'npm test (bash, 3m)' } }).detail, 'npm test (bash, 3m)');
});

// The CLI's own words (OSC 7501, carried on the row as agentStatus/Kind/Msg):
// the chip and the rail light say what Claude is doing or asking, not a
// generic verb. Message shapes measured on CLI 2.1.301.
const { runStateCue } = require('../../src/shared/session-run-state.cjs');

test('a blocked session says what the CLI is asking, with the whole ask beneath', () => {
  const asking = { isLive: true, agentStatus: 'blocked', agentStatusKind: 'permission', agentStatusMsg: 'approve Write: /tmp/x.txt' };
  const cue = runStateCue(asking);
  assert.equal(cue.label, 'approve Write');
  assert.equal(cue.tooltip, 'approve Write: /tmp/x.txt');
  const status = railStatus({ runState: cue });
  assert.equal(status.label, 'Waiting on you: approve Write');
  assert.equal(status.detail, 'approve Write: /tmp/x.txt');
  assert.equal(runStateCue({ ...asking, agentStatusMsg: 'Not logged in · Please run /login' }).label, 'Not logged in');
  assert.equal(runStateCue({ ...asking, agentStatusMsg: 'answer: Which file?' }).label, 'answer a question');
  // No words, or words too long for a chip: the generic label stays.
  assert.equal(railStatus({ runState: runStateCue({ isLive: true, agentStatus: 'blocked' }) }).label, 'Waiting on your answer');
  assert.equal(runStateCue({ ...asking, agentStatusMsg: `${'x'.repeat(60)}: y` }).label, 'needs your answer');
});

test('a working session shows the CLI step over the transcript verb', () => {
  const working = { isLive: true, agentStatus: 'working', agentStatusMsg: 'Running tests' };
  assert.equal(runStateCue(working, null, { working: true, workingText: 'Thinking' }).label, 'Running tests');
  assert.equal(railStatus({ runState: runStateCue(working) }).label, 'Working: Running tests');
  assert.equal(runStateCue({ ...working, agentStatusMsg: null }, null, { working: true, workingText: 'Thinking' }).label, 'Thinking');
});
