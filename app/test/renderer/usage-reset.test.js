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

// 2026-11-23: a stale reading is a floor (usage only goes up inside a window),
// so every plan surface prints it as "N%+" and the tooltip says how old it is.
const { usageText, ageText } = require('../../src/renderer/sidebar/usage-reset.cjs');

test('usageText: a stale reading carries a "+", a live one and a full one do not', () => {
  assert.equal(usageText(20), '20%');
  assert.equal(usageText(20.4, { stale: true }), '20%+');
  assert.equal(usageText(100, { stale: true }), '100%');
  assert.equal(usageText(null, { stale: true }), '--');
  assert.equal(usageText(undefined, { empty: '—' }), '—');
});

test('resetTooltip: a stale reading says it is a floor, its age, why, and the next read', () => {
  const nowMs = new Date(2026, 10, 23, 12, 40).getTime();
  const tip = resetTooltip({
    window: 'weekly',
    pct: 20,
    resetsAt: at(2026, 11, 28, 2),
    stale: true,
    updatedAt: new Date(2026, 10, 21, 4, 0).toISOString(),
    staleReason: 'Claude\'s usage service asked Harbor to pause reads for this plan (HTTP 429)',
    nextReadAt: new Date(2026, 10, 23, 12, 53).toISOString(),
    nowMs,
  });
  assert.match(tip, /at least 20% used/);
  assert.match(tip, /last read 2d ago, so it may be higher now/);
  assert.match(tip, /HTTP 429/);
  assert.match(tip, /next read after 12:53pm/);
  // A live reading keeps the old wording exactly.
  const live = resetTooltip({ window: 'weekly', pct: 20, resetsAt: at(2026, 11, 28, 2), nowMs });
  assert.doesNotMatch(live, /at least|last read/);
});

test('ageText picks the coarsest honest unit', () => {
  const nowMs = Date.parse('2026-11-23T18:00:00Z');
  assert.equal(ageText('2026-11-23T17:20:00Z', nowMs), '40m ago');
  assert.equal(ageText('2026-11-23T05:00:00Z', nowMs), '13h ago');
  assert.equal(ageText('2026-11-21T10:00:00Z', nowMs), '2d ago');
  assert.equal(ageText('nonsense', nowMs), 'at an unknown time');
});
