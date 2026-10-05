'use strict';

// Pat, 2026-08-10: "my harbor app keeps closing unexpectedly. twice now this has
// happened". The journal showed the renderer dying at 02:20:29 and the main
// process surviving it for eleven minutes, publishing into a frame that was
// gone and logging 704 errors, holding the single-instance lock the whole time
// so the launcher did nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

const { canReceivePush, planRendererRecovery } = require('../../src/main/renderer-recovery.js');

// A WebContents stand-in. The shapes here are the ones Electron actually
// produces, which is the point: a CRASHED renderer leaves an object that
// answers isDestroyed() with false.
const wc = (over = {}) => ({
  isDestroyed: () => false,
  isCrashed: () => false,
  mainFrame: { detached: false },
  ...over,
});

test('1) a crashed renderer is not pushed into, even though it says it is alive', () => {
  assert.equal(canReceivePush(wc()), true, 'a healthy renderer takes pushes');
  // THE 02:20 CASE. isDestroyed() is false and the object is intact; only
  // isCrashed() tells the truth, which is why guarding on isDestroyed() alone
  // produced 704 log lines instead of zero.
  assert.equal(canReceivePush(wc({ isCrashed: () => true })), false);
  assert.equal(canReceivePush(wc({ isDestroyed: () => true })), false);
  // A detached main frame is the same story one layer down.
  assert.equal(canReceivePush(wc({ mainFrame: { detached: true } })), false);
  assert.equal(canReceivePush(null), false);
  assert.equal(canReceivePush(undefined), false);
});

test('2) an object that throws while being inspected is treated as unusable', () => {
  const hostile = { isDestroyed() { throw new Error('Object has been destroyed'); } };
  assert.equal(canReceivePush(hostile), false);
  const frameThrows = { isDestroyed: () => false, isCrashed: () => false, get mainFrame() { throw new Error('gone'); } };
  assert.equal(canReceivePush(frameThrows), false);
});

test('3) an older WebContents without isCrashed still works', () => {
  // Only isDestroyed is guaranteed across versions; a missing predicate must
  // not make every push a no-op.
  assert.equal(canReceivePush({ isDestroyed: () => false }), true);
  assert.equal(canReceivePush({ isDestroyed: () => true }), false);
});

test('4) a dead renderer is reloaded, not left as a windowless process', () => {
  const plan = planRendererRecovery({ reason: 'crashed' });
  assert.equal(plan.action, 'reload');
  assert.equal(plan.attempts, 1);
  assert.match(plan.why, /reloading/);
  for (const reason of ['oom', 'killed', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'unknown']) {
    assert.equal(planRendererRecovery({ reason }).action, 'reload', `${reason} is recovered`);
  }
});

test('5) a renderer we asked to go away is left alone', () => {
  // Quitting and reloading both end the renderer on purpose; "recovering" from
  // those would fight whatever caused them.
  assert.equal(planRendererRecovery({ reason: 'clean-exit' }).action, 'ignore');
  assert.equal(planRendererRecovery({ reason: 'crashed', shuttingDown: true }).action, 'ignore');
});

test('6) a crash LOOP quits instead of reloading forever', () => {
  // Each death inside the streak window spends one retry.
  const first = planRendererRecovery({ reason: 'crashed', attempts: 0, sinceLastMs: Infinity });
  assert.deepEqual([first.action, first.attempts], ['reload', 1]);
  const second = planRendererRecovery({ reason: 'crashed', attempts: 1, sinceLastMs: 3_000 });
  assert.deepEqual([second.action, second.attempts], ['reload', 2]);
  const third = planRendererRecovery({ reason: 'crashed', attempts: 2, sinceLastMs: 3_000 });
  assert.equal(third.action, 'quit', 'the third death in a streak gives up');
  assert.match(third.why, /started again/);
});

test('7) a death long after the last one starts a fresh streak', () => {
  // An app that crashed once this morning has not spent its retries for the
  // rest of the day, so the counter only accumulates inside the window.
  const later = planRendererRecovery({ reason: 'crashed', attempts: 2, sinceLastMs: 10 * 60_000 });
  assert.equal(later.action, 'reload');
  assert.equal(later.attempts, 1, 'the streak restarted');
  // Right on the boundary still counts as the same streak.
  const boundary = planRendererRecovery({ reason: 'crashed', attempts: 2, sinceLastMs: 60_000 });
  assert.equal(boundary.action, 'quit');
});
