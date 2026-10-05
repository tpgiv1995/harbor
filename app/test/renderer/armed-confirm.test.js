'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  armedConfirmClick,
  DISARM_MS,
} = require('../../src/renderer/armed-confirm.cjs');

// Live-caught 2026-07-20: Pat clicked the old Take over chip and nothing
// happened; no IPC, no error, no kill. The two-click confirm had two silent
// dead zones: a double-click's second click landed under 300ms and was
// dropped, and a deliberate click after actually reading the confirm question
// landed after the 4s auto-disarm, so it merely re-armed. That chip is gone
// (sending into an outside session adopts it instead); worker close keeps the
// two-click confirm, so the contract lives here: a confirm gesture must never
// be silently consumed.

test('first click arms the confirm instead of firing', () => {
  const { armed, fire } = armedConfirmClick(null, 1000);
  assert.equal(fire, false);
  assert.deepEqual(armed, { at: 1000 });
});

test('a double-click second click keeps the confirm armed instead of dropping the gesture', () => {
  const first = armedConfirmClick(null, 1000);
  const second = armedConfirmClick(first.armed, 1150);
  assert.equal(second.fire, false, 'a double-click is not consent and must not fire');
  assert.ok(second.armed, 'the swallowed click must leave the confirm armed');
  assert.equal(second.armed.at, 1150, 'the armed window restarts from the swallowed click');
});

test('a distinct second click fires the confirm', () => {
  const first = armedConfirmClick(null, 1000);
  const second = armedConfirmClick(first.armed, 1500);
  assert.equal(second.fire, true);
  assert.equal(second.armed, null);
});

test('the click after a swallowed double-click burst fires', () => {
  const first = armedConfirmClick(null, 1000);
  const burst = armedConfirmClick(first.armed, 1150);
  const third = armedConfirmClick(burst.armed, 3000);
  assert.equal(third.fire, true);
});

test('caller state such as the worker id rides through arming and refresh', () => {
  const first = armedConfirmClick(null, 1000, { id: 'w1V:p3' });
  assert.equal(first.armed.id, 'w1V:p3');
  const refreshed = armedConfirmClick(first.armed, 1100, { id: 'w1V:p3' });
  assert.equal(refreshed.armed.id, 'w1V:p3');
});

test('the disarm window outlives reading the confirm question', () => {
  // "end it in the terminal and kill the in-flight turn, then continue here?"
  // is eleven words; 4 seconds was shorter than reading it (live-caught).
  assert.ok(DISARM_MS >= 10_000, `DISARM_MS ${DISARM_MS} is too short to read the confirm copy`);
});
