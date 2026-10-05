'use strict';
// A single-flight guard: calls that arrive while a run is in flight coalesce
// into ONE trailing run instead of stacking up behind it.
//
// Why it exists (2026-09-09, "harbor is CRAWLING today"): the Orch summaries
// broadcast is registered on one queue watcher PER OPEN WORKSPACE, and each
// watcher carries its own 10s poll and 2s debounce, so ten open workspaces
// fired the same broadcast about once a second. Each broadcast fans out one
// history-worker `meta` per candidate session (224 that afternoon), and the
// broadcasts overlapped, so the worker's queue grew without bound and every
// send waited behind it. Coalescing overlapping broadcasts bounds the fan-out
// to one build at a time plus one trailing build for whatever arrived during it.
const test = require('node:test');
const assert = require('node:assert');
const { createSingleFlight } = require('../../src/main/single-flight.js');

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('calls during a run coalesce into one trailing run that every waiter receives', async () => {
  const gates = [];
  let runs = 0;
  const flight = createSingleFlight(() => {
    runs += 1;
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });

  const first = flight();
  const during = [flight(), flight(), flight(), flight()];
  assert.strictEqual(runs, 1, 'nothing new starts while the first run is in flight');

  gates[0].resolve('first');
  assert.strictEqual(await first, 'first');
  await Promise.resolve();
  assert.strictEqual(runs, 2, 'exactly one trailing run covers everything that arrived during the first');

  gates[1].resolve('second');
  assert.deepStrictEqual(await Promise.all(during), ['second', 'second', 'second', 'second']);
  assert.strictEqual(runs, 2);
});

test('sequential calls each run', async () => {
  let runs = 0;
  const flight = createSingleFlight(async () => { runs += 1; return runs; });
  assert.strictEqual(await flight(), 1);
  assert.strictEqual(await flight(), 2);
  assert.strictEqual(runs, 2);
});

test('a rejection reaches its waiters and releases the flight', async () => {
  let runs = 0;
  const flight = createSingleFlight(async () => {
    runs += 1;
    if (runs === 1) throw new Error('boom');
    return 'ok';
  });
  await assert.rejects(flight(), /boom/);
  assert.strictEqual(await flight(), 'ok');
  assert.strictEqual(runs, 2);
});
