'use strict';

// Detection policy for the mid-session wedge watchdog: consecutive ping
// failures trip recovery exactly once, successes reset the counter, a slow
// ping never stacks ticks, and a fresh wedge after recovery trips again.

const test = require('node:test');
const assert = require('node:assert');
const { createDaemonWatchdog } = require('../../src/main/daemon-watchdog.js');

function makePing(script) {
  // script: array of 'ok' | 'fail'; repeats last entry when exhausted
  let i = 0;
  return async () => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step === 'fail') throw new Error('session daemon ping timed out after 10000ms');
  };
}

test('two consecutive failures trip onWedge exactly once', async () => {
  let wedges = 0;
  const dog = createDaemonWatchdog({
    ping: makePing(['fail', 'fail', 'ok']),
    onWedge: async () => { wedges += 1; },
  });
  await dog.tick();
  assert.strictEqual(wedges, 0, 'one failure must not trip');
  await dog.tick();
  assert.strictEqual(wedges, 1);
  await dog.tick(); // healthy again
  assert.strictEqual(wedges, 1);
});

test('a success between failures resets the counter', async () => {
  let wedges = 0;
  const dog = createDaemonWatchdog({
    ping: makePing(['fail', 'ok', 'fail', 'ok']),
    onWedge: async () => { wedges += 1; },
  });
  for (let i = 0; i < 4; i++) await dog.tick();
  assert.strictEqual(wedges, 0, 'non-consecutive failures must never trip');
});

test('no re-trip while recovery is in flight; a fresh wedge after recovery trips again', async () => {
  let wedges = 0;
  let releaseRecovery;
  const recoveryGate = new Promise((r) => { releaseRecovery = r; });
  const dog = createDaemonWatchdog({
    ping: makePing(['fail']),
    onWedge: async () => { wedges += 1; await recoveryGate; },
  });
  await dog.tick();
  const tripping = dog.tick(); // trips, blocks in onWedge
  await Promise.resolve();
  await dog.tick(); // during recovery: must be a no-op
  await dog.tick();
  assert.strictEqual(wedges, 1, 'must not re-trip under an in-flight recovery');
  releaseRecovery();
  await tripping;
  // daemon wedges again after recovery: two fresh consecutive failures re-trip
  await dog.tick();
  await dog.tick();
  assert.strictEqual(wedges, 2);
});

test('a slow ping never stacks ticks', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const dog = createDaemonWatchdog({
    ping: async () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); await gate; inFlight -= 1; },
    onWedge: async () => {},
  });
  const first = dog.tick();
  await Promise.resolve();
  await dog.tick(); // must skip: previous ping still in flight
  await dog.tick();
  release();
  await first;
  assert.strictEqual(maxInFlight, 1);
});
