'use strict';
// A claude-delegate batch joined to its Codex worker. Codex workers are not
// launched with the BATCH TITLE: prefix, so the join also takes a session
// started in the batch's own lane worktree, and a worker's failed or stopped
// last turn reads as such. Every row below is SYNTHETIC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { joinBatchesToSessions, refineSummary, summarizeQueue } = require('../../src/main/providers/delegate.js');

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const CHILD = '20000000-0000-4000-8000-000000000002';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-codex-workers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('batch join: a codex worker in the lane worktree links without a BATCH TITLE prefix; failed and stopped turns say so', (t) => {
  const dir = tmp(t); const lane = path.join(dir, 'lane-batch-1'); fs.mkdirSync(lane);
  const queue = { workspace: dir, batches: [{ id: 'batch-1', title: 'Fix parser', status: 'active', worktree: lane, last_dispatched_at: iso(T0) }] };
  const worker = { id: CHILD, provider: 'codex', cwd: lane, firstPrompt: 'You are a worker. GOAL: fix it', lineage: { startedMs: T0 + 3000 }, signalAt: T0 + 50_000 };
  const now = T0 + 60_000;
  let [row] = joinBatchesToSessions(queue, [worker], [], now);
  assert.equal(row.sessionId, CHILD); assert.equal(row.workerState, 'working');
  assert.equal(joinBatchesToSessions(queue, [{ ...worker, lineage: { startedMs: T0 - 10 * 60_000 } }], [], now)[0].sessionId, null,
    'a session started in the lane before this dispatch is an older attempt');
  assert.equal(joinBatchesToSessions(queue, [{ ...worker, cwd: dir, firstPrompt: 'Preamble. BATCH TITLE: Fix parser FINDING IDS: X' }], [], now)[0].sessionId, CHILD,
    'a codex prompt may carry the packet after a preamble');
  [row] = joinBatchesToSessions(queue, [{ ...worker, finished: true, turnEnd: 'error', turnError: { message: 'quota' }, resultText: null }], [], now);
  assert.equal(row.workerState, 'failed'); assert.equal(row.workerError, 'quota');
  [row] = joinBatchesToSessions(queue, [{ ...worker, signalAt: T0, finished: true, turnEnd: 'aborted' }], [], now);
  assert.equal(row.workerState, 'stopped', 'a stopped worker is not "possibly hung"');
  [row] = joinBatchesToSessions(queue, [{ ...worker, finished: true, turnEnd: 'complete', resultText: 'Done: 3 files.' }], [], now);
  assert.equal(row.workerState, 'awaiting-review'); assert.equal(row.workerResult, 'Done: 3 files.');
  const summary = refineSummary(summarizeQueue(queue, dir, now), joinBatchesToSessions(queue, [{ ...worker, turnEnd: 'error' }], [], now));
  assert.equal(summary.stateWord, 'worker failed'); assert.equal(summary.currentState, 'failed');
});

test('batch join: batches sharing a lane worktree each get their own worker, never a later session', (t) => {
  const dir = tmp(t); const lane = path.join(dir, 'lane1'); fs.mkdirSync(lane);
  const MIN = 60_000;
  const queue = { workspace: dir, batches: [
    { id: 'batch-a', title: 'Alpha', status: 'done', worktree: lane, last_dispatched_at: iso(T0) },
    { id: 'batch-b', title: 'Beta', status: 'active', worktree: lane, last_dispatched_at: iso(T0 + 30 * MIN) },
  ] };
  const workerA = { id: 'worker-a', provider: 'codex', cwd: lane, firstPrompt: 'You are a worker.', startedAt: iso(T0 + 5000),
    signalAt: T0 + 20 * MIN, finished: true, turnEnd: 'complete', resultText: 'A done' };
  const workerB = { id: 'worker-b', provider: 'codex', cwd: lane, firstPrompt: 'You are a worker.', startedAt: iso(T0 + 30 * MIN + 5000),
    signalAt: T0 + 40 * MIN };
  const review = { id: 'review', provider: 'claude', cwd: lane, firstPrompt: 'Review the lane', startedAt: iso(T0 + 45 * MIN),
    signalAt: T0 + 59 * MIN, finished: true, resultText: 'review notes' };
  const now = T0 + 60 * MIN;
  const [a, b] = joinBatchesToSessions(queue, [review, workerB, workerA], [], now);
  assert.equal(a.sessionId, 'worker-a', 'the done batch keeps its own worker, not the next batch in the lane');
  assert.equal(a.workerResult, 'A done');
  assert.equal(b.sessionId, 'worker-b', 'the earliest session after dispatch is the worker; a later review is not');
  assert.equal(b.workerResult, null);
});

test('batch join: a title match outranks a lane-worktree match, and an exact id outranks both', (t) => {
  const dir = tmp(t); const lane = path.join(dir, 'lane1'); fs.mkdirSync(lane);
  const queue = { workspace: dir, batches: [{ id: 'batch-b', title: 'Beta', status: 'active', worktree: lane, last_dispatched_at: iso(T0) }] };
  const stray = { id: 'stray', provider: 'claude', cwd: lane, firstPrompt: 'look at the diff', startedAt: iso(T0 + 1000), signalAt: T0 + 50_000 };
  const worker = { id: 'worker-b', provider: 'claude', cwd: lane, firstPrompt: 'BATCH TITLE: Beta\nFINDING IDS: 1', startedAt: iso(T0 + 2000), signalAt: T0 + 10_000 };
  const now = T0 + 60_000;
  assert.equal(joinBatchesToSessions(queue, [stray, worker], [], now)[0].sessionId, 'worker-b');
  const pinned = { ...queue, batches: [{ ...queue.batches[0], last_session_id: 'stray' }] };
  assert.equal(joinBatchesToSessions(pinned, [stray, worker], [], now)[0].sessionId, 'stray');
});

test('batch join: a lane re-dispatched within minutes keeps each worker with its own batch', (t) => {
  const dir = tmp(t); const lane = path.join(dir, 'lane1'); fs.mkdirSync(lane);
  // Two dispatches three minutes apart. A's worker starts two and a half
  // minutes after its dispatch: past the midpoint of the two stamps, before B's.
  const queue = { workspace: dir, batches: [
    { id: 'batch-a', title: 'Alpha', status: 'active', worktree: lane, last_dispatched_at: iso(T0) },
    { id: 'batch-b', title: 'Beta', status: 'active', worktree: lane, last_dispatched_at: iso(T0 + 3 * MIN) },
  ] };
  const workerA = { id: 'worker-a', provider: 'codex', cwd: lane, firstPrompt: 'You are a worker.', startedAt: iso(T0 + 2.5 * MIN), signalAt: T0 + 4 * MIN };
  const workerB = { id: 'worker-b', provider: 'codex', cwd: lane, firstPrompt: 'You are a worker.', startedAt: iso(T0 + 3.5 * MIN), signalAt: T0 + 4 * MIN };
  const [a, b] = joinBatchesToSessions(queue, [workerB, workerA], [], T0 + 5 * MIN);
  assert.equal(a.sessionId, 'worker-a');
  assert.equal(b.sessionId, 'worker-b');
});

test('batch join: a session another batch recorded as its worker never joins this one by title or lane', (t) => {
  const dir = tmp(t); const lane = path.join(dir, 'lane1'); fs.mkdirSync(lane);
  const shared = { id: 'worker-a', provider: 'codex', cwd: lane, firstPrompt: 'Preamble. BATCH TITLE: Beta', startedAt: iso(T0 + 1000), signalAt: T0 + 50_000 };
  const queue = { workspace: dir, batches: [
    { id: 'batch-a', title: 'Alpha', status: 'active', worktree: lane, last_dispatched_at: iso(T0), last_session_id: 'worker-a' },
    { id: 'batch-b', title: 'Beta', status: 'active', worktree: lane, last_dispatched_at: iso(T0) },
  ] };
  const [a, b] = joinBatchesToSessions(queue, [shared], [], T0 + 60_000);
  assert.equal(a.sessionId, 'worker-a');
  assert.equal(b.sessionId, null, 'the title in its prompt does not override the recorded owner');
  assert.equal(b.workerState, 'no-signal');
});
