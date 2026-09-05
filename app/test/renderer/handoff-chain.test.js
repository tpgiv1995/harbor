'use strict';
// The one-click handoff chain: /handoff -> /compact -> /pickup in one session.
// The planner is pure: the composition root feeds it ticks (transcript
// working/blocked) and send results, and it answers with at most one action.
// Step completion is the transcript's own working clock (a turn seen starting,
// then quiet), and /compact completion is proven by the send path accepting
// /pickup, because the send guards already refuse while compaction chrome is
// on screen; the chain never re-derives that classifier.
const test = require('node:test');
const assert = require('node:assert');
const {
  createChain, chainTick, chainSendResult, describeChain, DEFAULT_CONFIG,
} = require('../../src/renderer/stage/handoff-chain.cjs');

const CFG = {
  startDeadlineMs: 10_000,
  stepDeadlineMs: 60_000,
  quietTicks: 3,
  retryDelayMs: 2_000,
  compactGraceMs: 5_000,
};

const idle = (now) => ({ now, working: false, blocked: false, missing: false });
const busy = (now) => ({ now, working: true, blocked: false, missing: false });

// Drives a fresh chain to the point where /compact was just accepted.
function chainAtCompactAccepted() {
  let state = createChain({ sessionId: 's1', now: 0, config: CFG });
  let out = chainTick(state, idle(1000));
  assert.strictEqual(out.action?.type, 'send');
  assert.strictEqual(out.action.text, '/handoff');
  state = chainSendResult(out.state, { ok: true, now: 2000 });
  out = chainTick(state, busy(3000));
  state = out.state;
  for (const now of [10_000, 11_000, 12_000]) {
    out = chainTick(state, idle(now));
    state = out.state;
  }
  assert.strictEqual(out.action?.type, 'send');
  assert.strictEqual(out.action.text, '/compact');
  return chainSendResult(out.state, { ok: true, now: 13_000 });
}

test('happy path: handoff runs, compact accepted, pickup delivered', () => {
  let state = chainAtCompactAccepted();
  // Inside the grace window nothing is attempted even though the pane is idle.
  let out = chainTick(state, idle(14_000));
  assert.strictEqual(out.action, null);
  out = chainTick(out.state, idle(19_000));
  assert.strictEqual(out.action?.type, 'send');
  assert.strictEqual(out.action.text, '/pickup');
  state = chainSendResult(out.state, { ok: true, now: 20_000 });
  assert.strictEqual(state.status, 'done');
  assert.match(describeChain(state), /pickup/i);
});

test('a turn that never visibly starts fails at the start deadline', () => {
  let state = createChain({ sessionId: 's1', now: 0, config: CFG });
  let out = chainTick(state, idle(1000));
  state = chainSendResult(out.state, { ok: true, now: 2000 });
  out = chainTick(state, idle(5000));
  assert.strictEqual(out.state.status, 'active');
  out = chainTick(out.state, idle(13_000));
  assert.strictEqual(out.state.status, 'failed');
  assert.match(out.state.reason, /never started/i);
});

test('quiet must be consecutive: a working tick resets the count', () => {
  let state = createChain({ sessionId: 's1', now: 0, config: CFG });
  let out = chainTick(state, idle(1000));
  state = chainSendResult(out.state, { ok: true, now: 2000 });
  out = chainTick(state, busy(3000));
  out = chainTick(out.state, idle(4000));
  out = chainTick(out.state, idle(5000));
  out = chainTick(out.state, busy(6000)); // tool gap ended, still working
  out = chainTick(out.state, idle(7000));
  out = chainTick(out.state, idle(8000));
  assert.strictEqual(out.action, null, 'two quiet ticks are not enough');
  out = chainTick(out.state, idle(9000));
  assert.strictEqual(out.action?.type, 'send');
  assert.strictEqual(out.action.text, '/compact');
});

test('blocked ticks during the handoff turn neither fail nor count as quiet', () => {
  let state = createChain({ sessionId: 's1', now: 0, config: CFG });
  let out = chainTick(state, idle(1000));
  state = chainSendResult(out.state, { ok: true, now: 2000 });
  out = chainTick(state, busy(3000));
  out = chainTick(out.state, { now: 4000, working: false, blocked: true, missing: false });
  out = chainTick(out.state, { now: 5000, working: false, blocked: true, missing: false });
  out = chainTick(out.state, { now: 6000, working: false, blocked: true, missing: false });
  assert.strictEqual(out.action, null);
  assert.strictEqual(out.state.status, 'active');
  // Answered, turn resumes, then finishes.
  out = chainTick(out.state, busy(7000));
  out = chainTick(out.state, idle(8000));
  out = chainTick(out.state, idle(9000));
  out = chainTick(out.state, idle(10_000));
  assert.strictEqual(out.action?.text, '/compact');
});

test('pickup refusals retry on the delay and a late acceptance finishes the chain', () => {
  let state = chainAtCompactAccepted();
  let out = chainTick(state, idle(19_000));
  assert.strictEqual(out.action?.text, '/pickup');
  state = chainSendResult(out.state, { ok: false, reason: 'compacting', now: 19_100 });
  assert.strictEqual(state.status, 'active');
  out = chainTick(state, idle(19_500));
  assert.strictEqual(out.action, null, 'retry waits out the delay');
  out = chainTick(state, idle(21_200));
  assert.strictEqual(out.action?.text, '/pickup');
  state = chainSendResult(out.state, { ok: true, now: 21_300 });
  assert.strictEqual(state.status, 'done');
});

test('pickup refusals past the step deadline fail carrying the last refusal reason', () => {
  let state = chainAtCompactAccepted();
  let now = 19_000;
  for (;;) {
    const out = chainTick(state, idle(now));
    if (out.state.status === 'failed') { state = out.state; break; }
    state = out.action?.text === '/pickup'
      ? chainSendResult(out.state, { ok: false, reason: 'the session is compacting', now })
      : out.state;
    now += 2_500;
    assert.ok(now < 200_000, 'chain must fail before this');
  }
  assert.match(state.reason, /compacting/);
});

test('a closed window (missing transcript) fails the chain honestly', () => {
  let state = createChain({ sessionId: 's1', now: 0, config: CFG });
  let out = chainTick(state, idle(1000));
  state = chainSendResult(out.state, { ok: true, now: 2000 });
  out = chainTick(state, { now: 3000, working: false, blocked: false, missing: true });
  assert.strictEqual(out.state.status, 'failed');
  assert.match(out.state.reason, /window/i);
});

test('a refused /handoff or /compact send fails with the refusal reason', () => {
  let state = createChain({ sessionId: 's1', now: 0, config: CFG });
  const out = chainTick(state, idle(1000));
  state = chainSendResult(out.state, { ok: false, reason: 'no composer', now: 2000 });
  assert.strictEqual(state.status, 'failed');
  assert.match(state.reason, /no composer/);
});

test('describeChain names every live stage for the status row', () => {
  let state = createChain({ sessionId: 's1', now: 0, config: CFG });
  assert.match(describeChain(state), /handoff/i);
  let out = chainTick(state, idle(1000));
  state = chainSendResult(out.state, { ok: true, now: 2000 });
  out = chainTick(state, busy(3000));
  assert.match(describeChain(out.state), /handoff/i);
  state = chainAtCompactAccepted();
  assert.match(describeChain(state), /compact/i);
  state = chainSendResult(
    chainTick(state, idle(19_000)).state,
    { ok: false, reason: 'compacting', now: 19_100 },
  );
  assert.match(describeChain(state), /compact|pickup/i);
});

test('default config carries production-scale deadlines', () => {
  assert.ok(DEFAULT_CONFIG.stepDeadlineMs >= 10 * 60_000);
  assert.ok(DEFAULT_CONFIG.startDeadlineMs >= 60_000);
  assert.ok(DEFAULT_CONFIG.quietTicks >= 2);
});
