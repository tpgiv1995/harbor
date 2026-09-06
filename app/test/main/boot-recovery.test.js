'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createBootRecovery } = require('../../src/main/boot-recovery.js');

// Deterministic clock. Timer callbacks are NOT awaited to completion before
// the next due timer fires: a probe callback can sit awaiting its own
// deadline timer, which is exactly the hang the probe-timeout guard exists
// for, so the clock must be able to fire that deadline while the callback is
// still in flight. Microtasks are flushed generously after every fire so
// promise chains settle before assertions.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  return {
    setTimer: (fn, ms) => { seq += 1; timers.set(seq, { at: now + ms, fn }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
    flush,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let dueId = null;
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!due || t.at < due.at)) { dueId = id; due = t; }
        }
        if (!due) break;
        now = due.at;
        timers.delete(dueId);
        due.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

function harness({ mountResults = [], probeMount } = {}) {
  const clock = fakeClock();
  const loads = [];
  const logs = [];
  let mountCalls = 0;
  const recovery = createBootRecovery({
    attemptLoad: () => loads.push('load'),
    probeMount: probeMount || (async () => {
      const result = mountCalls < mountResults.length ? mountResults[mountCalls] : mountResults.at(-1) ?? false;
      mountCalls += 1;
      return result;
    }),
    log: (line) => logs.push(line),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, recovery, loads, logs, probeCount: () => mountCalls };
}

// Probe schedule is [1200, 3500, 8000, 15000]; verdict lands at the last miss.
const VERDICT_MS = 15_000;

test('a load that mounts goes healthy, and later builds never reload a healthy window', async () => {
  const h = harness({ mountResults: [false, true] });
  h.recovery.loadFinished();
  await h.clock.advance(1200);
  assert.strictEqual(h.recovery.healthy, false, 'first probe misses, not yet a verdict');
  await h.clock.advance(2300);
  assert.strictEqual(h.recovery.healthy, true, 'second probe finds the mount');
  // Two-sided: the exact signal that reloads an unhealthy window must do
  // nothing to a healthy one.
  h.recovery.distChanged();
  await h.clock.advance(60_000);
  assert.deepStrictEqual(h.loads, [], 'no reload was ever fired');
});

test('a load that never mounts retries, escalating to the steady cadence', async () => {
  const h = harness({ mountResults: [false] });
  h.recovery.loadFinished();
  await h.clock.advance(VERDICT_MS); // all probes miss -> retry in 2000
  assert.deepStrictEqual(h.loads, [], 'no retry before the verdict delay');
  await h.clock.advance(2000);
  assert.strictEqual(h.loads.length, 1, 'first retry at 2s');

  h.recovery.loadFinished();
  await h.clock.advance(VERDICT_MS + 4000);
  assert.strictEqual(h.loads.length, 2, 'second retry at 4s');

  h.recovery.loadFinished();
  await h.clock.advance(VERDICT_MS + 8000);
  assert.strictEqual(h.loads.length, 3, 'third retry at 8s');

  h.recovery.loadFinished();
  await h.clock.advance(VERDICT_MS + 9999);
  assert.strictEqual(h.loads.length, 3, 'steady cadence not yet due');
  await h.clock.advance(1);
  assert.strictEqual(h.loads.length, 4, 'then every 10s, forever');
});

test('a failed load schedules a retry; ERR_ABORTED (our own superseding retry) never does', async () => {
  const h = harness();
  h.recovery.loadFailed({ errorCode: -6, errorDescription: 'ERR_FILE_NOT_FOUND' });
  await h.clock.advance(2000);
  assert.strictEqual(h.loads.length, 1, 'a real failure retries');
  h.recovery.loadFailed({ errorCode: -3, errorDescription: 'ERR_ABORTED' });
  await h.clock.advance(120_000);
  assert.strictEqual(h.loads.length, 1, 'an abort schedules nothing');
});

test('a settled new build reloads an unhealthy window immediately and cancels the pending retry', async () => {
  const h = harness({ mountResults: [false] });
  h.recovery.loadFinished();
  await h.clock.advance(VERDICT_MS); // verdict: unhealthy, retry waiting
  h.recovery.distChanged();
  assert.strictEqual(h.loads.length, 1, 'the build is what we were waiting for; no timer ride-out');
  await h.clock.advance(60_000);
  assert.strictEqual(h.loads.length, 1, 'the cancelled retry never double-fires');
});

test('close cancels probes and retries', async () => {
  const h = harness({ mountResults: [false] });
  h.recovery.loadFinished();
  await h.clock.advance(VERDICT_MS);
  h.recovery.close();
  await h.clock.advance(600_000);
  assert.deepStrictEqual(h.loads, [], 'a closed window never loads');
});

test('a mount found on the very first probe stops the later probes', async () => {
  const h = harness({ mountResults: [true] });
  h.recovery.loadFinished();
  await h.clock.advance(1200);
  assert.strictEqual(h.recovery.healthy, true);
  await h.clock.advance(60_000);
  assert.strictEqual(h.probeCount(), 1, 'no probe fires after health');
});

test('a probe that never settles counts as a miss, not a wedge', async () => {
  // executeJavaScript against a deadlocked renderer can hang forever; the
  // deadline must turn that into a miss so the verdict and retry still land.
  const h = harness({ probeMount: () => new Promise(() => {}) });
  h.recovery.loadFinished();
  // Last probe at 15s + 5s probe deadline + 2s retry delay.
  await h.clock.advance(VERDICT_MS + 5000 + 2000);
  assert.strictEqual(h.loads.length, 1, 'the hung probe still produced a retry');
});

test('a stale in-flight probe result is discarded after close or a newer load', async () => {
  const resolvers = [];
  const h = harness({ probeMount: () => new Promise((resolve) => resolvers.push(resolve)) });
  h.recovery.loadFinished();
  await h.clock.advance(1200); // probe 1 fires, left pending
  assert.strictEqual(resolvers.length, 1);

  h.recovery.loadFinished(); // generation bump: probe 1 is now stale
  resolvers[0](true);
  await h.clock.flush();
  assert.strictEqual(h.recovery.healthy, false, 'a stale probe cannot mark the newer load healthy');

  await h.clock.advance(1200); // the newer load's first probe fires, left pending
  assert.strictEqual(resolvers.length, 2);
  h.recovery.close();
  resolvers[1](true);
  await h.clock.flush();
  assert.strictEqual(h.recovery.healthy, false, 'a closed recovery ignores every late result');
});

test('rearm forfeits health so a crash-recovery reload gets the boot watch back', async () => {
  const h = harness({ mountResults: [false, true, false] });
  h.recovery.loadFinished();
  await h.clock.advance(3500);
  assert.strictEqual(h.recovery.healthy, true, 'mounted once');

  h.recovery.rearm(); // render-process-gone is about to window.reload()
  assert.strictEqual(h.recovery.healthy, false, 'health is forfeit after a renderer death');
  h.recovery.loadFinished(); // the reload landed on a broken dist
  await h.clock.advance(VERDICT_MS + 2000);
  assert.strictEqual(h.loads.length, 1, 'the post-crash black window retries like a boot');

  h.recovery.close();
  h.recovery.rearm();
  // The closed state must be OBSERVABLY closed, not just quiet: a boot signal
  // after rearm-on-closed must schedule nothing (this is the assertion that
  // fails if rearm's closed-guard is dropped).
  const probesBefore = h.probeCount();
  h.recovery.loadFinished();
  h.recovery.distChanged();
  await h.clock.advance(600_000);
  assert.strictEqual(h.probeCount(), probesBefore, 'no probe fires for a closed recovery');
  assert.strictEqual(h.loads.length, 1, 'rearm after close stays closed');
});
