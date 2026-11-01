'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { realTmpDir } = require('../support/real-tmpdir.js');
const path = require('node:path');

const {
  createDelegateProvider,
  deriveRun,
  findQueueForWorkspace,
  joinBatchesToSessions,
  parseEvents,
  queuePath,
  summarizeQueue,
} = require('../../src/main/providers/delegate.js');

// REAL captured queues, not cartoons: these keep the exact structure of the two
// actual delegate queue files, taken 2026-08-03, so the shapes the classifier is
// tested against are the shapes it really sees (a done/pending queue, and an
// abandoned one carrying a stuck `active` batch). Every batch id, status and
// timestamp is the captured one, which is all `summarizeQueue` reads.
//
// The PROSE fields are sample text. A real queue's packets describe the work in
// the author's own words, so the originals carried a second machine's hardware,
// an ssh key filename, private project names and real session ids: content this
// classifier never looks at and a public repository should not carry.
//
// They used to point at the LIVE files under
// /home/you/.local/state/claude-delegate/queues/. That made the unit
// suite depend on mutable machine state: running an orchestration batch, which
// is an ordinary thing to do in this repo, rewrote the fixture underneath the
// tests and turned three of them red with nothing wrong in the code. A test
// whose result depends on what the user did five minutes ago cannot be a gate.
const FIXTURE_DIR = path.join(__dirname, '../fixtures/delegate-queues');
const ABANDONED_QUEUE_FIXTURE = path.join(FIXTURE_DIR, 'abandoned-queue.json');
const LIVE_QUEUE_FIXTURE = path.join(FIXTURE_DIR, 'live-queue.json');

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

test('summarizeQueue matches workspace, counts completion, chooses current engine, and estimates remaining time', () => {
  const now = Date.parse('2026-07-20T12:00:00Z');
  const queue = {
    queue_id: 'queue-9',
    workspace: '/work/harbor',
    batches: [
      { id: 'b1', status: 'done', started_at: '2026-07-20T10:00:00Z', completed_at: '2026-07-20T10:10:00Z' },
      { id: 'b2', status: 'done', started_at: '2026-07-20T10:20:00Z', completed_at: '2026-07-20T10:40:00Z' },
      { id: 'b3', status: 'active', worker_engine: 'sol', updated_at: '2026-07-20T11:59:00Z' },
      { id: 'b4', status: 'pending' },
    ],
  };

  assert.deepEqual(summarizeQueue(queue, '/work/harbor', now), {
    queueId: 'queue-9',
    workspace: path.resolve('/work/harbor'),
    done: 2,
    total: 4,
    remaining: 2,
    currentBatchId: 'b3',
    workerEngine: 'sol',
    active: 1,
    ready: 1,
    waiting: 0,
    overrunning: 0,
    etaMs: 30 * 60 * 1000,
    etaUnknown: null,
    updatedAt: Date.parse('2026-07-20T11:59:00Z'),
    state: 'live',
    visible: true,
  });
  assert.equal(summarizeQueue(queue, '/work/other', now), null);
});

test('summarizeQueue hides an all-done queue ten minutes after its last update', () => {
  const queue = {
    queue_id: 'finished',
    workspace: '/work/harbor',
    batches: [{
      id: 'b1',
      status: 'done',
      started_at: '2026-07-20T10:00:00Z',
      completed_at: '2026-07-20T10:05:00Z',
      updated_at: '2026-07-20T10:05:00Z',
    }],
  };
  const recent = summarizeQueue(queue, '/work/harbor', Date.parse('2026-07-20T10:14:59Z'));
  assert.equal(recent.state, 'completed');
  assert.equal(recent.visible, true);
  assert.equal(summarizeQueue(queue, '/work/harbor', Date.parse('2026-07-20T10:15:01Z')).visible, false);
});

test('worker liveness derives working, awaiting review, quiet, and done with evidence ages', () => {
  const now = Date.parse('2026-08-25T20:00:00Z');
  const queue = {
    queue_id: 'truthful-run',
    workspace: '/work/harbor',
    goal: 'Make orchestration status truthful',
    batches: [
      { id: 'working', title: 'Working batch', status: 'active', worker_engine: 'codex', last_session_id: 'session-working', last_dispatched_at: '2026-08-25T19:50:00Z' },
      { id: 'review', title: 'Review batch', status: 'active', worker_engine: 'claude', last_session_id: 'session-review', last_dispatched_at: '2026-08-25T19:30:00Z' },
      { id: 'quiet', title: 'Quiet batch', status: 'active', worker_engine: 'cursor', last_dispatched_at: '2026-08-25T19:00:00Z' },
      { id: 'complete', title: 'Completed batch', status: 'done', started_at: '2026-08-25T18:00:00Z', completed_at: '2026-08-25T18:10:00Z' },
      { id: 'complete-2', title: 'Second completed batch', status: 'done', started_at: '2026-08-25T18:10:00Z', completed_at: '2026-08-25T18:20:00Z' },
    ],
  };
  const rows = [
    { id: 'session-working', finished: false, signalAt: now - 2 * 60_000, start: '2026-08-25T19:50:10Z' },
    { id: 'wrong-title-match', firstPrompt: 'BATCH TITLE: Working batch', finished: true, signalAt: now - 30_000, start: '2026-08-25T19:50:20Z' },
    { id: 'session-review', finished: true, signalAt: now - 12 * 60_000, start: '2026-08-25T19:30:10Z' },
    { id: 'session-quiet', firstPrompt: 'BATCH TITLE: Quiet batch', finished: false, signalAt: now - 45 * 60_000, start: '2026-08-25T19:00:10Z' },
  ];

  const joined = joinBatchesToSessions(queue, rows, [], now);
  assert.deepEqual(joined.map(({ batchId, workerState, signalAgeMs, signalSource }) => ({ batchId, workerState, signalAgeMs, signalSource })), [
    { batchId: 'working', workerState: 'working', signalAgeMs: 2 * 60_000, signalSource: 'transcript' },
    { batchId: 'review', workerState: 'awaiting-review', signalAgeMs: 12 * 60_000, signalSource: 'transcript' },
    { batchId: 'quiet', workerState: 'quiet', signalAgeMs: 45 * 60_000, signalSource: 'transcript' },
    { batchId: 'complete', workerState: 'done', signalAgeMs: 110 * 60_000, signalSource: null },
    { batchId: 'complete-2', workerState: 'done', signalAgeMs: 100 * 60_000, signalSource: null },
  ]);
  const run = deriveRun(queue, rows, [], now);
  assert.equal(run.summary.working, 1);
  assert.equal(run.summary.awaitingReview, 1);
  assert.equal(run.summary.quiet, 1);
  assert.equal(run.summary.currentState, 'quiet');
  assert.equal(run.summary.signal, 'last signal 45m ago');
  // All three active batches have run past the 10-minute average and run side
  // by side, so each is charged a quarter of it: 2.5 minutes, not the old
  // average x 3 / 3.
  assert.equal(run.summary.etaMs, 2.5 * 60_000);
});

// 2026-10-12, Pat: "you need more shit running in parallel - not all of this
// needs to be sequential". The panel could not tell a batch held back by a
// dependency from one that was ready and simply never dispatched: both read
// "no liveness signal". And its ETA fell back to fully serial whenever nothing
// happened to be active between waves.
test('a pending batch reads ready or waiting on the batches it names', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const queue = { queue_id: 'ready', workspace: '/work/harbor', batches: [
    { id: 'a', title: 'A', status: 'done', started_at: '2026-10-12T02:00:00Z', completed_at: '2026-10-12T02:20:00Z' },
    { id: 'b', title: 'B', status: 'active', last_dispatched_at: '2026-10-12T02:50:00Z' },
    { id: 'c', title: 'C', status: 'pending', depends_on: ['a'] },
    { id: 'd', title: 'D', status: 'pending', depends_on: ['a', 'b'] },
    { id: 'e', title: 'E', status: 'pending', depends_on: ['ghost'] },
  ] };
  const joined = joinBatchesToSessions(queue, [], [], now);
  assert.deepEqual(joined.map(({ batchId, workerState, waitingOn }) => ({ batchId, workerState, waitingOn })), [
    { batchId: 'a', workerState: 'done', waitingOn: null },
    { batchId: 'b', workerState: 'no-signal', waitingOn: null },
    { batchId: 'c', workerState: 'ready', waitingOn: [] },
    { batchId: 'd', workerState: 'waiting', waitingOn: ['b'] },
    { batchId: 'e', workerState: 'waiting', waitingOn: ['ghost'] },
  ]);
  const summary = summarizeQueue(queue, '/work/harbor', now);
  assert.deepEqual([summary.active, summary.ready, summary.waiting], [1, 1, 2]);
});

test('an idle run with ready batches says so in the pill word', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const queue = { queue_id: 'idle', workspace: '/work/harbor', updated_at: '2026-10-12T02:59:00Z', batches: [
    { id: 'a', title: 'A', status: 'done', started_at: '2026-10-12T02:00:00Z', completed_at: '2026-10-12T02:20:00Z' },
    { id: 'b', title: 'B', status: 'pending', depends_on: ['a'] },
  ] };
  assert.equal(deriveRun(queue, [], [], now).summary.stateWord, 'ready, not started');
});

test('the ETA schedules the dependency graph at the run\'s observed width', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const done = (id, start, end) => ({ id, status: 'done', started_at: `2026-10-12T${start}:00Z`, completed_at: `2026-10-12T${end}:00Z` });
  // Two finished batches ran side by side for 10 minutes each: width 2.
  const base = [done('x', '02:30', '02:40'), done('y', '02:30', '02:40')];
  const chain = { queue_id: 'chain', workspace: '/work/harbor', batches: [...base,
    { id: 'a', status: 'pending' },
    { id: 'b', status: 'pending', depends_on: ['a'] },
    { id: 'c', status: 'pending', depends_on: ['b'] },
    { id: 'd', status: 'pending' },
  ] };
  // a -> b -> c is three durations however wide; d runs beside a. The old
  // rule said average x 4 remaining / 0 active = 40 minutes.
  assert.equal(summarizeQueue(chain, '/work/harbor', now).etaMs, 30 * 60_000);
  const wide = { queue_id: 'wide', workspace: '/work/harbor', batches: [...base, done('z', '02:30', '02:40'),
    ...Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, status: 'pending' }))] };
  assert.equal(summarizeQueue(wide, '/work/harbor', now).etaMs, 20 * 60_000);
  const cycle = { queue_id: 'cycle', workspace: '/work/harbor', batches: [...base,
    { id: 'a', status: 'pending', depends_on: ['b'] },
    { id: 'b', status: 'pending', depends_on: ['a'] },
  ] };
  assert.equal(summarizeQueue(cycle, '/work/harbor', now).etaMs, null);
});

// Astra's adversarial review of the change above (2026-10-12), each finding
// reproduced here before it was fixed.
test('the ETA is unknown, with a reason, when work waits on a failed, blocked, missing or self dependency', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const done = (id) => ({ id, status: 'done', started_at: '2026-10-12T02:30:00Z', completed_at: '2026-10-12T02:40:00Z' });
  const base = [done('x'), done('y')];
  for (const [label, extra] of [
    ['failed', [{ id: 'a', status: 'failed' }, { id: 'b', status: 'pending', depends_on: ['a'] }]],
    ['blocked', [{ id: 'a', status: 'blocked' }, { id: 'b', status: 'pending', depends_on: ['a'] }]],
    ['missing', [{ id: 'b', status: 'pending', depends_on: ['ghost'] }]],
    ['self', [{ id: 'b', status: 'pending', depends_on: ['b'] }]],
  ]) {
    const summary = summarizeQueue({ queue_id: label, workspace: '/work/harbor', batches: [...base, ...extra] }, '/work/harbor', now);
    assert.equal(summary.etaMs, null, `${label} dependency still produced an ETA`);
    assert.equal(summary.etaUnknown, 'the dependencies cannot finish as recorded (failed, blocked, missing, circular, or a batch started before its dependency)', label);
  }
  const oneSample = summarizeQueue({ queue_id: 'one', workspace: '/work/harbor', batches: [done('x'), { id: 'b', status: 'pending' }] }, '/work/harbor', now);
  assert.equal(oneSample.etaUnknown, 'needs two finished batches');
});

test('retries are measured from their latest dispatch, and a reset batch has no worker', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  // Three batches whose first attempts failed at 01:00, 01:10 and 01:20 and
  // whose retries then ran one after another, ten minutes each.
  const retried = (id, first, retry, end) => ({ id, status: 'done', started_at: `2026-10-12T${first}:00Z`,
    last_dispatched_at: `2026-10-12T${retry}:00Z`, completed_at: `2026-10-12T${end}:00Z` });
  const batches = [retried('a', '01:00', '02:00', '02:10'), retried('b', '01:10', '02:10', '02:20'), retried('c', '01:20', '02:20', '02:30'),
    // Reset back to pending after a dead run: its old stamps are not a worker.
    { id: 'reset', status: 'pending', started_at: '2026-10-12T02:00:00Z', last_dispatched_at: '2026-10-12T02:00:00Z' },
    ...Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, status: 'pending' }))];
  // Width 1 and ten-minute batches: six remaining take 60 minutes, not the
  // 140 the first-start intervals implied.
  assert.equal(summarizeQueue({ queue_id: 'retry', workspace: '/work/harbor', batches }, '/work/harbor', now).etaMs, 60 * 60_000);
});

test('a batch that needs a resource another active batch holds waits for it, and the ETA queues it', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const done = (id) => ({ id, status: 'done', started_at: '2026-10-12T02:30:00Z', completed_at: '2026-10-12T02:40:00Z' });
  const queue = { queue_id: 'device', workspace: '/work/harbor', batches: [done('x'), done('y'),
    { id: 'android-a', title: 'A', status: 'active', resources: ['android-emulator'], last_dispatched_at: '2026-10-12T02:58:00Z' },
    { id: 'android-b', title: 'B', status: 'pending', resources: ['Android-Emulator'] },
    { id: 'free', title: 'F', status: 'pending' },
  ] };
  const joined = joinBatchesToSessions(queue, [], [], now);
  assert.deepEqual(joined.find((row) => row.batchId === 'android-b').waitingOn, ['android-emulator (held by android-a)']);
  assert.equal(joined.find((row) => row.batchId === 'free').workerState, 'ready');
  const summary = summarizeQueue(queue, '/work/harbor', now);
  assert.deepEqual([summary.ready, summary.waiting], [1, 1]);
  // android-a has 8 of its 10 minutes left; android-b then needs the device
  // for 10 more, while free runs beside them: 18 minutes.
  assert.equal(summary.etaMs, 18 * 60_000);
});

// Astra review, round 2.
test('an active batch whose own dependency is not done makes the ETA unknown', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const done = (id) => ({ id, status: 'done', started_at: '2026-10-12T02:30:00Z', completed_at: '2026-10-12T02:40:00Z' });
  for (const extra of [
    // A cycle with its active half simulated as running would look finishable.
    [{ id: 'a', status: 'active', depends_on: ['b'], last_dispatched_at: '2026-10-12T02:58:00Z' }, { id: 'b', status: 'pending', depends_on: ['a'] }],
    [{ id: 'a', status: 'pending' }, { id: 'b', status: 'active', depends_on: ['a'], last_dispatched_at: '2026-10-12T02:58:00Z' }],
  ]) {
    const summary = summarizeQueue({ queue_id: 'early', workspace: '/work/harbor', batches: [done('x'), done('y'), ...extra] }, '/work/harbor', now);
    assert.equal(summary.etaMs, null);
    assert.match(summary.etaUnknown, /started before its dependency/);
  }
});

test('ten thousand batches contending for one emulator schedule in well under a second', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  // Two overlapping finished batches give width 2, so a slot is always free
  // while every pending batch waits on the one device.
  const batches = [
    { id: 'x', status: 'done', started_at: '2026-10-12T02:30:00Z', completed_at: '2026-10-12T02:40:00Z' },
    { id: 'y', status: 'done', started_at: '2026-10-12T02:30:00Z', completed_at: '2026-10-12T02:40:00Z' },
    ...Array.from({ length: 10_000 }, (_, index) => ({ id: `e${index}`, status: 'pending', resources: ['emulator'] })),
    { id: 'free', status: 'pending' },
  ];
  const started = performance.now();
  const summary = summarizeQueue({ queue_id: 'contended', workspace: '/work/harbor', batches }, '/work/harbor', now);
  assert.equal(summary.etaMs, 10_000 * 10 * 60_000);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)}ms`);
});

test('a batch blocked on one resource hands its turn on another to the next waiter', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const done = (id) => ({ id, status: 'done', started_at: '2026-10-12T02:30:00Z', completed_at: '2026-10-12T02:40:00Z' });
  // Width 2. hold-s holds S for 30 more minutes (overrun floor aside: it was
  // just dispatched). both needs R and S; r-only needs R. r-only must not
  // wait behind both just because both sits earlier in the queue.
  const batches = [done('x'), done('y'),
    { id: 'hold-s', status: 'active', resources: ['s'], last_dispatched_at: '2026-10-12T03:00:00Z' },
    { id: 'both', status: 'pending', resources: ['r', 's'] },
    { id: 'r-only', status: 'pending', resources: ['r'] },
  ];
  // r-only runs beside hold-s (0 to 10), then both runs once S frees (10 to 20).
  assert.equal(summarizeQueue({ queue_id: 'handoff', workspace: '/work/harbor', batches }, '/work/harbor', now).etaMs, 20 * 60_000);
});

test('a blank resource name holds nothing and blocks nothing', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const done = (id) => ({ id, status: 'done', started_at: '2026-10-12T02:30:00Z', completed_at: '2026-10-12T02:40:00Z' });
  const queue = { queue_id: 'blank', workspace: '/work/harbor', batches: [done('x'), done('y'),
    { id: 'a', status: 'active', resources: [''], last_dispatched_at: '2026-10-12T03:00:00Z' },
    { id: 'b', status: 'pending', resources: ['', '  '] },
  ] };
  assert.equal(joinBatchesToSessions(queue, [], [], now).find((row) => row.batchId === 'b').workerState, 'ready');
  assert.equal(summarizeQueue(queue, '/work/harbor', now).etaMs, 10 * 60_000);
});

test('an active batch past the average is counted as running long', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const done = (id) => ({ id, status: 'done', started_at: '2026-10-12T02:30:00Z', completed_at: '2026-10-12T02:40:00Z' });
  const summary = summarizeQueue({ queue_id: 'long', workspace: '/work/harbor', batches: [done('x'), done('y'),
    { id: 'slow', status: 'active', last_dispatched_at: '2026-10-12T01:30:00Z' },
    { id: 'fresh', status: 'active', last_dispatched_at: '2026-10-12T02:58:00Z' },
  ] }, '/work/harbor', now);
  assert.equal(summary.overrunning, 1);
});

test('a ten-thousand batch chain schedules in well under a second', () => {
  const now = Date.parse('2026-10-12T03:00:00Z');
  const batches = [
    { id: 'x', status: 'done', started_at: '2026-10-12T02:30:00Z', completed_at: '2026-10-12T02:40:00Z' },
    { id: 'y', status: 'done', started_at: '2026-10-12T02:30:00Z', completed_at: '2026-10-12T02:40:00Z' },
    // Reverse order, so every link points forward: the worst case for a scan.
    ...Array.from({ length: 10_000 }, (_, index) => ({ id: `c${index}`, status: 'pending', depends_on: index < 9_999 ? [`c${index + 1}`] : [] })),
  ];
  const started = performance.now();
  const summary = summarizeQueue({ queue_id: 'big', workspace: '/work/harbor', batches }, '/work/harbor', now);
  assert.equal(summary.etaMs, 10_000 * 10 * 60_000);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)}ms`);
});

// One completed duration extrapolated over the whole queue is an invention
// wearing an average's clothes; the ETA appears only from two or more.
test('a single completed duration yields no ETA', () => {
  const now = Date.parse('2026-08-25T20:00:00Z');
  const queue = { queue_id: 'one-sample', workspace: '/work/harbor', batches: [
    { id: 'a', title: 'A', status: 'done', started_at: '2026-08-25T18:00:00Z', completed_at: '2026-08-25T18:10:00Z' },
    { id: 'b', title: 'B', status: 'active', last_dispatched_at: '2026-08-25T19:50:00Z' },
    { id: 'c', title: 'C', status: 'pending' },
  ] };
  assert.equal(summarizeQueue(queue, '/work/harbor', now).etaMs, null);
});

test('event recency is a weaker fallback and absence stays honest', () => {
  const now = Date.parse('2026-08-25T20:00:00Z');
  const queue = { queue_id: 'events', workspace: '/work/harbor', batches: [
    { id: 'evented', title: 'Event batch', status: 'active', last_dispatched_at: '2026-08-25T19:00:00Z' },
    { id: 'missing', title: 'Missing batch', status: 'active', last_dispatched_at: '2026-08-25T19:00:00Z' },
  ] };
  const joined = joinBatchesToSessions(queue, [], [{ t: '2026-08-25T19:58:00Z', msg: 'evented still running' }], now);
  assert.equal(joined[0].workerState, 'working');
  assert.equal(joined[0].signalSource, 'event');
  assert.equal(joined[1].workerState, 'no-signal');
  assert.equal(joined[1].signalAgeMs, null);
});

test('queue lookup tolerates Windows casing and matches a worker worktree', () => {
  const queue = { workspace: 'C:\\dev\\Harbor', batches: [{ worktree: 'C:\\dev\\.orch\\lane-one' }] };
  assert.equal(findQueueForWorkspace([queue], 'c:\\DEV\\harbor', 'win32'), queue);
  assert.equal(findQueueForWorkspace([queue], 'c:\\DEV\\.ORCH\\lane-one', 'win32'), queue);
  assert.equal(findQueueForWorkspace([queue], 'C:\\dev\\other', 'win32'), null);
});

test('a reused workspace-pool slot never ties a session to an old queue', () => {
  const slot = 'C:\\dev\\.orch\\pool\\harbor\\slot-01';
  const earlier = { workspace: 'C:\\dev\\Harbor', batches: [{ id: 'a', worktree: slot, lane: 'run1-a', lane_generation: '1' }] };
  const later = { workspace: 'C:\\dev\\Harbor', batches: [{ id: 'b', worktree: slot, lane: 'run2-b', lane_generation: '2' }] };
  const holding = (lane) => ({ laneAt: () => lane });
  assert.equal(findQueueForWorkspace([earlier, later], slot, 'win32', holding({ lane: 'run2-b', generation: 2 })), later, 'the lane the slot holds now names its queue');
  assert.equal(findQueueForWorkspace([earlier, later], slot, 'win32', holding({ lane: 'run1-a', generation: 1 })), earlier);
  assert.equal(findQueueForWorkspace([earlier, later], slot, 'win32', holding({ lane: null, generation: 3 })), null, 'a released slot names no queue');
  assert.equal(findQueueForWorkspace([earlier, later], slot, 'win32', holding(undefined)), null, 'an unreadable pool names no queue');
  assert.equal(findQueueForWorkspace([earlier, later], 'c:\\dev\\harbor', 'win32', holding(null)), earlier, 'the queue is still found through its own workspace');
});

test('real abandoned and live queues are classified without changing delegate batch statuses', async () => {
  const abandoned = JSON.parse(await fs.promises.readFile(ABANDONED_QUEUE_FIXTURE, 'utf8'));
  const live = JSON.parse(await fs.promises.readFile(LIVE_QUEUE_FIXTURE, 'utf8'));
  live.batches.find((batch) => batch.id === 'batch-8').status = 'pending';
  const abandonedUpdatedAt = Date.parse(abandoned.updated_at);
  const liveUpdatedAt = Date.parse(live.updated_at);

  const MIN = 60 * 1000;
  // A queue file is only touched at DISPATCH BOUNDARIES, so quiet is not
  // abandoned. Real batches on 2026-08-02 ran 30+ minutes with no write, and a
  // 10-minute threshold called them abandoned while they were actively working,
  // which is the same confidently-wrong pill this feature exists to remove.
  // The supervisor's own hard cap is the only defensible line.
  assert.equal(summarizeQueue(live, live.workspace, liveUpdatedAt + MIN).state, 'live');
  assert.equal(summarizeQueue(live, live.workspace, liveUpdatedAt + (25 * MIN)).state, 'live', 'a 25-minute batch is normal, not abandoned');
  assert.equal(summarizeQueue(live, live.workspace, liveUpdatedAt + (60 * MIN)).state, 'live', 'an hour-long batch is still working');
  // Past the point the supervisor would have killed any worker, it is orphaned.
  assert.equal(summarizeQueue(live, live.workspace, liveUpdatedAt + (200 * MIN)).state, 'abandoned');
  // And the genuinely dead run, whose batch-10 has been 'active' since the
  // session running it died, reads abandoned at real elapsed time.
  assert.equal(summarizeQueue(abandoned, abandoned.workspace, abandonedUpdatedAt + (200 * MIN)).state, 'abandoned');

  // The pill is for orchestration that is HAPPENING. Relabelling a dead run
  // does not answer "it is almost always stale": it must stop occupying the
  // window. A live run stays visible however long its current batch takes.
  const stillRunning = JSON.parse(JSON.stringify(live));
  stillRunning.batches[stillRunning.batches.length - 1].status = 'pending';
  for (const mins of [1, 25, 60]) {
    assert.equal(summarizeQueue(stillRunning, stillRunning.workspace, liveUpdatedAt + (mins * MIN)).visible, true,
      `a live run must stay visible ${mins} minutes into a batch`);
  }
  assert.equal(summarizeQueue(stillRunning, stillRunning.workspace, liveUpdatedAt + (200 * MIN)).visible, false,
    'a run past the supervisor hard cap is orphaned and must leave the pill');
  assert.equal(summarizeQueue(abandoned, abandoned.workspace, abandonedUpdatedAt + (200 * MIN)).visible, false,
    'the real dead run must not sit on every window of its workspace');
});

test('parseEvents accepts JSONL event records and returns newest first', () => {
  assert.deepEqual(parseEvents('{"t":"10:00","msg":"started"}\ninvalid\n{"t":"10:05","msg":"done"}\n'), [
    { t: '10:05', msg: 'done' },
    { t: '10:00', msg: 'started' },
  ]);
});

test('queuePath resolves workspace and uses the verified twelve-character sha1', () => {
  // A FIXED workspace path, not one derived from the developer's home: the
  // digest is of the resolved path, so a homedir-derived input makes the pinned
  // hash machine-specific and the spec stops pinning anything. The state
  // directory below is still derived, because that half genuinely is.
  const digest = crypto.createHash('sha1').update(path.resolve('/home/example/dev/example-app')).digest('hex').slice(0, 12);
  assert.equal(
    queuePath('/home/example/dev/example-app'),
    path.join(os.homedir(), '.local', 'state', 'claude-delegate', 'queues', `${digest}.json`),
  );
});

test('getQueue reads JSON directly and returns an empty queue when absent', async () => {
  const files = new Map([['/state/queues/abc.json', '{"batches":[{"id":"b1","status":"active"}]}']]);
  const provider = createDelegateProvider({
    queuePathFor: () => '/state/queues/abc.json',
    readFile: async (file) => {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
  });
  assert.equal((await provider.getQueue('/workspace')).batches[0].status, 'active');
  files.clear();
  assert.deepEqual(await provider.getQueue('/workspace'), { batches: [] });
});

test('watchQueue observes the queue, debounces bursts, and closes', async () => {
  const watched = [];
  const provider = createDelegateProvider({
    queuePathFor: () => '/queues/q.json',
    debounceMs: 15,
    watchFile: (file, cb) => {
      const handle = { file, cb, closed: false, close() { this.closed = true; } };
      watched.push(handle);
      return handle;
    },
  });
  let calls = 0;
  const close = provider.watchQueue('/workspace', () => { calls += 1; });
  assert.deepEqual(watched.map((item) => item.file), ['/queues/q.json']);
  watched[0].cb();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(calls, 1);
  close();
  assert.ok(watched.every((item) => item.closed));
});

test('watchQueue polling floor repaints after a queue rewrite when the native event is missed', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(realTmpDir(), 'harbor-queue-poll-'));
  const queueFile = path.join(directory, 'queue.json');
  const live = JSON.parse(await fs.promises.readFile(LIVE_QUEUE_FIXTURE, 'utf8'));
  live.batches.find((batch) => batch.id === 'batch-8').status = 'pending';
  const initialDone = live.batches.filter((batch) => ['done', 'completed', 'success'].includes(batch.status)).length;
  await fs.promises.writeFile(queueFile, JSON.stringify(live));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));

  const provider = createDelegateProvider({
    queuePathFor: () => queueFile,
    debounceMs: 5,
    pollMs: 25,
    watchFile: () => ({ close() {} }),
  });
  const summaries = [];
  const close = provider.watchQueue(live.workspace, async () => {
    summaries.push(await provider.getSummary(live.workspace, Date.parse(live.updated_at) + 60_000));
  });
  t.after(close);

  live.batches.find((batch) => batch.id === 'batch-8').status = 'done';
  await fs.promises.writeFile(queueFile, JSON.stringify(live));

  await waitFor(() => summaries.some((summary) => summary.done === initialDone + 1), 300);
});

test('watchQueue repaints a genuinely live real-fixture queue through the filesystem watcher', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(realTmpDir(), 'harbor-queue-watch-'));
  const queueFile = path.join(directory, 'queue.json');
  const live = JSON.parse(await fs.promises.readFile(LIVE_QUEUE_FIXTURE, 'utf8'));
  live.batches.find((batch) => batch.id === 'batch-8').status = 'pending';
  const initialDone = live.batches.filter((batch) => ['done', 'completed', 'success'].includes(batch.status)).length;
  await fs.promises.writeFile(queueFile, JSON.stringify(live));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));

  const provider = createDelegateProvider({
    queuePathFor: () => queueFile,
    debounceMs: 5,
    pollMs: 5000,
  });
  const summaries = [];
  const close = provider.watchQueue(live.workspace, async () => {
    summaries.push(await provider.getSummary(live.workspace, Date.parse(live.updated_at) + 60_000));
  });
  t.after(close);

  live.batches.find((batch) => batch.id === 'batch-8').status = 'done';
  await fs.promises.writeFile(queueFile, JSON.stringify(live));

  await waitFor(() => summaries.some((summary) => summary.done === initialDone + 1), 1000);
});

test('getEvents reads the optional sidecar and watchQueue observes it when queue id is known', async () => {
  const watched = [];
  const provider = createDelegateProvider({
    stateDir: '/state',
    queuePathFor: () => '/state/queues/q.json',
    readFile: async (file) => {
      assert.equal(file, path.join('/state', 'events', 'queue-1.jsonl'));
      return '{"t":"11:00","msg":"worker started"}\n';
    },
    watchFile: (file) => {
      const handle = { file, close() {} };
      watched.push(handle);
      return handle;
    },
  });

  assert.deepEqual(await provider.getEvents('queue-1'), [{ t: '11:00', msg: 'worker started' }]);
  provider.watchQueue('/workspace', () => {}, 'queue-1')();
  assert.deepEqual(watched.map(({ file }) => file), [
    '/state/queues/q.json',
    path.join('/state', 'events', 'queue-1.jsonl'),
  ]);
});
