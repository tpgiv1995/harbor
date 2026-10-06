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
