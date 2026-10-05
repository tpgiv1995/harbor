'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TICK_MS, STALL_MS, RAF_STALL_MS, stallFromTick, classifyTick } = require('../../src/renderer/perf-watch.cjs');

// Normal use must write NOTHING: a tick that arrives on time, or a few ms late,
// is scheduling noise. A freeze is hundreds of ms of overshoot.
test('on-time and slightly late ticks are silent', () => {
  assert.equal(stallFromTick({ now: 1000, last: 1000 - TICK_MS }), null);
  assert.equal(stallFromTick({ now: 1000, last: 1000 - TICK_MS - 40 }), null);
  assert.equal(stallFromTick({ now: 1000, last: 1000 - TICK_MS - (STALL_MS - 1) }), null);
});

test('a blocked main thread is reported with the overshoot as its duration', () => {
  const stall = stallFromTick({ now: 5000, last: 5000 - TICK_MS - 1800 });
  assert.equal(stall.ms, 1800, 'the reported ms is the block, not the interval');
  assert.equal(stall.kind, 'blocked-main-thread');
  assert.match(stall.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('nonsense timestamps never produce a line', () => {
  assert.equal(stallFromTick({ now: NaN, last: 0 }), null);
  assert.equal(stallFromTick({ now: 0, last: NaN }), null);
  assert.equal(stallFromTick({}), null);
});

// Chromium throttles timers in a hidden window, so without this every minimize
// would write a fake multi-second freeze into the one log meant to prove what a
// real freeze looks like.
test('a hidden window reports nothing, however late its ticks are', () => {
  assert.equal(stallFromTick({ now: 60000, last: 0, visible: false }), null);
  assert.equal(stallFromTick({ now: 60000, last: 0, visible: true, settling: true }), null,
    'the first tick after coming back measures the hidden gap, not a stall');
  assert.ok(stallFromTick({ now: 60000, last: 0, visible: true, settling: false }),
    'a visible window still reports');
});

// classifyTick separates "JS thread blocked" from "frames stopped": ticks on
// schedule + rAF silent = the compositor, and the log must say which.
test('a blocked main thread outranks a stale rAF (one cause, one line)', () => {
  const stall = classifyTick({ now: 5000, last: 5000 - TICK_MS - 1800, focused: true, lastRafAt: 0 });
  assert.equal(stall.kind, 'blocked-main-thread');
});

test('healthy ticks with frozen frames report a compositor stall', () => {
  const stall = classifyTick({
    now: 10000, last: 10000 - TICK_MS, focused: true, lastRafAt: 10000 - RAF_STALL_MS - 500,
  });
  assert.equal(stall.kind, 'compositor-stall');
  assert.equal(stall.ms, RAF_STALL_MS + 500);
});

test('a recent frame is silence, not a compositor stall', () => {
  assert.equal(classifyTick({
    now: 10000, last: 10000 - TICK_MS, focused: true, lastRafAt: 10000 - 400,
  }), null);
});

// X11 has no occlusion detection: a COVERED window can stop producing frames
// with nothing wrong. Typing implies focus, so the focus gate costs nothing.
test('an unfocused window never reports a compositor stall', () => {
  assert.equal(classifyTick({
    now: 10000, last: 10000 - TICK_MS, focused: false, lastRafAt: 0,
  }), null);
});

test('a hidden or settling window never reports a compositor stall', () => {
  assert.equal(classifyTick({
    now: 10000, last: 10000 - TICK_MS, visible: false, focused: true, lastRafAt: 0,
  }), null);
  assert.equal(classifyTick({
    now: 10000, last: 10000 - TICK_MS, settling: true, focused: true, lastRafAt: 0,
  }), null);
});

test('no rAF timestamp yet is silence, not a stall', () => {
  assert.equal(classifyTick({ now: 10000, last: 10000 - TICK_MS, focused: true, lastRafAt: null }), null);
});
