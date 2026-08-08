'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resetBadge,
  resetTooltip,
  clockText,
  relativeText,
} = require('../../src/renderer/sidebar/usage-reset.cjs');

// Pat, 2026-07-27: "i need to be able to see the time that the weekly limits
// reset." The rail showed "7/31" and nothing more, so the weekly badge is the
// contract under test: a date alone is the bug.
//
// Local-time construction on purpose. The badge is read by a human sitting in
// front of this machine, so it must render in THAT person's zone; a test that
// pinned UTC would pass while the rail showed the wrong hour.
const at = (y, m, d, h, min = 0) => Math.floor(new Date(y, m - 1, d, h, min, 0, 0).getTime() / 1000);

test('the weekly badge carries the reset date AND time, not just the date', () => {
  const resetsAt = at(2026, 7, 31, 20, 0); // the real sample from Pat's own cache
  const badge = resetBadge(resetsAt, { window: 'weekly', nowMs: new Date(2026, 6, 27, 12, 0).getTime() });
  assert.equal(badge, '7/31 8pm');
  assert.match(badge, /8pm/, 'the time is the whole point of the fix');
});

test('a weekly reset at a non-round minute keeps its minutes', () => {
  const resetsAt = at(2026, 7, 27, 14, 30);
  assert.equal(resetBadge(resetsAt, { window: 'weekly' }), '7/27 2:30pm');
});

test('a 5-hour reset later today shows the time alone', () => {
  const nowMs = new Date(2026, 6, 27, 11, 0).getTime();
  assert.equal(resetBadge(at(2026, 7, 27, 15, 0), { window: 'fiveHour', nowMs }), '3pm');
});

test('a 5-hour reset that crosses midnight shows its date, so 1am is not read as this morning', () => {
  // A bare "1am" on a window that resets tomorrow reads as thirteen hours in
  // the past, which is exactly the ambiguity the weekly badge was fixing.
  const nowMs = new Date(2026, 6, 27, 23, 30).getTime();
  assert.equal(resetBadge(at(2026, 7, 28, 1, 0), { window: 'fiveHour', nowMs }), '7/28 1am');
});

test('midnight and noon do not collapse to 0', () => {
  assert.equal(clockText(new Date(2026, 6, 27, 0, 0)), '12am');
  assert.equal(clockText(new Date(2026, 6, 27, 12, 0)), '12pm');
});

test('no reset timestamp yields no badge rather than a fabricated one', () => {
  assert.equal(resetBadge(null, { window: 'weekly' }), '');
  assert.equal(resetBadge(undefined, { window: 'weekly' }), '');
  assert.equal(resetBadge(0, { window: 'weekly' }), '');
});

test('relative text degrades through days, hours, minutes', () => {
  const now = new Date(2026, 6, 27, 12, 0).getTime();
  assert.equal(relativeText(new Date(2026, 6, 31, 14, 0).getTime(), now), 'in 4d 2h');
  assert.equal(relativeText(new Date(2026, 6, 31, 12, 0).getTime(), now), 'in 4d');
  assert.equal(relativeText(new Date(2026, 6, 27, 15, 30).getTime(), now), 'in 3h 30m');
  assert.equal(relativeText(new Date(2026, 6, 27, 12, 20).getTime(), now), 'in 20m');
  assert.equal(relativeText(new Date(2026, 6, 27, 11, 0).getTime(), now), 'now', 'a past reset is not negative time');
});

test('the tooltip spells out the same instant the badge abbreviates', () => {
  const nowMs = new Date(2026, 6, 27, 12, 0).getTime();
  const tip = resetTooltip({
    window: 'weekly', pct: 57, resetsAt: at(2026, 7, 31, 20, 0), nowMs,
  });
  assert.match(tip, /weekly window/);
  assert.match(tip, /57% used/);
  assert.match(tip, /resets Friday Jul 31 at 8pm/);
  assert.match(tip, /in 4d 8h/);
});

test('an unknown percentage is stated, never implied as zero', () => {
  const tip = resetTooltip({ window: 'weekly', pct: null, resetsAt: null });
  assert.match(tip, /usage not reported yet/);
  assert.doesNotMatch(tip, /0%/);
});

test('a rolled window says so', () => {
  const tip = resetTooltip({ window: 'fiveHour', pct: 0, rolled: true });
  assert.match(tip, /already reset/);
});
