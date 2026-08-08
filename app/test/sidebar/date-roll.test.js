'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  displayDayFor,
  displayDayStart,
  displayDayStartForDateInput,
  cutoffForFilter,
  parseLocalDateTime,
} = require('../../src/shared/date-roll.cjs');

test('display day rolls at 06:00 local', () => {
  const beforeRoll = new Date(2026, 6, 17, 5, 30, 0);
  const afterRoll = new Date(2026, 6, 17, 6, 30, 0);
  assert.equal(displayDayFor(beforeRoll).toDateString(), new Date(2026, 6, 16).toDateString());
  assert.equal(displayDayFor(afterRoll).toDateString(), new Date(2026, 6, 17).toDateString());
});

test('today filter uses display day start at 06:00', () => {
  const atFive = new Date(2026, 6, 17, 5, 0, 0);
  const cutoff = cutoffForFilter({ kind: 'today' }, atFive);
  assert.equal(cutoff.getTime(), displayDayStart(atFive).getTime());
  assert.equal(cutoff.getHours(), 6);
  assert.equal(cutoff.getDate(), 16);
});

test('custom since input starts at 06:00 on that date', () => {
  const cutoff = cutoffForFilter({ kind: 'since', value: '2026-07-10' });
  assert.equal(cutoff.getFullYear(), 2026);
  assert.equal(cutoff.getMonth(), 6);
  assert.equal(cutoff.getDate(), 10);
  assert.equal(cutoff.getHours(), 6);
});

test('06:00 boundary includes session just after roll and excludes just before', () => {
  const boundary = displayDayStartForDateInput('2026-07-17');
  const included = parseLocalDateTime('2026-07-17 06:01');
  const excluded = parseLocalDateTime('2026-07-17 05:59');
  assert.ok(included >= boundary);
  assert.ok(excluded < boundary);
});
