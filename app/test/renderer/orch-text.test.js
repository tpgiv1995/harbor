'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { etaText, groupBatches, runCounts, waitingText } = require('../../src/renderer/orchestration/orch-text.cjs');

test('batches group as running, error, not started, then done, keeping queue order', () => {
  const batches = [
    { id: 'd1', status: 'done' }, { id: 'r1', status: 'active' }, { id: 'p1', status: 'pending' },
    { id: 'e1', status: 'failed' }, { id: 'd2', status: 'completed' }, { id: 'r2', status: 'ACTIVE' },
    { id: 'e2', status: 'blocked' }, { id: 'x', status: 'something-new' }, { id: 'n' },
  ];
  assert.deepEqual(groupBatches(batches).map((group) => [group.key, group.label, group.batches.map((batch) => batch.id)]), [
    ['running', 'Running', ['r1', 'r2']],
    ['error', 'Error', ['e1', 'e2']],
    ['pending', 'Not started', ['p1', 'x', 'n']],
    ['done', 'Done', ['d1', 'd2']],
  ]);
  assert.deepEqual(groupBatches([{ id: 'only', status: 'done' }]).map((group) => group.key), ['done']);
  assert.deepEqual(groupBatches([]), []);
});

test('a waiting batch names two of its blockers, then a count', () => {
  assert.equal(waitingText(['r1-table-play']), 'waits on r1-table-play');
  assert.equal(waitingText(['r1', 'r4']), 'waits on r1, r4');
  assert.equal(waitingText(['r13', 'r1', 'r2', 'r10', 'r11', 'r5']), 'waits on r13, r1 +4 more');
  assert.equal(waitingText([]), 'waiting');
  assert.equal(waitingText(undefined), 'waiting');
});

test('the run line counts workers by what they are doing, not by queue status', () => {
  // Three claimed batches: one working, one finished and unreviewed, one hung.
  assert.equal(runCounts({ active: 3, working: 1, awaitingReview: 1, quiet: 1, missing: 0, ready: 2, waiting: 4 }),
    '1 working · 1 awaiting review · 1 quiet · 2 ready, not started · 4 waiting on other batches');
  assert.equal(runCounts({ active: 2, working: 0, awaitingReview: 0, quiet: 0, missing: 2, ready: 0, waiting: 0 }), '2 with no signal');
  assert.equal(runCounts({ active: 0, working: 0, awaitingReview: 0, quiet: 0, missing: 0, ready: 10, waiting: 6 }),
    '10 ready, not started · 6 waiting on other batches');
  // A raw queue summary (no derived counts) only knows "active".
  assert.equal(runCounts({ active: 3, ready: 0, waiting: 0 }), '3 active');
  assert.equal(runCounts({ active: 0, ready: 0, waiting: 0 }), null);
  assert.equal(runCounts(null), null);
  // A worker whose last turn errored or was stopped is neither working nor
  // awaiting review, and the line says so.
  assert.equal(runCounts({ active: 3, working: 1, awaitingReview: 0, quiet: 0, missing: 0, failed: 1, stopped: 1, ready: 0, waiting: 0 }),
    '1 failed · 1 working · 1 stopped');
});

test('the ETA says when a batch is running long instead of promising the same minutes', () => {
  assert.equal(etaText({ etaMs: 35 * 60_000, overrunning: 0 }), 'rough ETA about 35 min');
  assert.equal(etaText({ etaMs: 95 * 60_000, overrunning: 1 }), 'rough ETA about 1h 35m, 1 batch is past the usual length so likely later');
  assert.equal(etaText({ etaMs: 10 * 60_000, overrunning: 2 }), 'rough ETA about 10 min, 2 batches are past the usual length so likely later');
  assert.equal(etaText({ etaMs: null }), null);
});
