'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RAIL_DEFAULT_WIDTH } = require('../../src/renderer/profiles.cjs');

// Measured grid track model for the usage-meter row. The percentages and reset
// badges share fixed tracks so columns line up across profile rows; this test
// pins the x-offset math the CSS encodes at 2560x1600 rail widths.
const BADGE_W = 16;
const BADGE_GAP = 8;
const GROUP_5H_W = 106;
const GROUP_GAP = 8;
const GROUP_WEEKLY_DONUT = 18;
const PCT_W = 30;
const PCT_GAP = 4;

function meterColumnPositions() {
  // One default width since 2026-11-19 (the rail head no longer grows with the
  // plan count); the column positions never depended on it.
  const railWidth = RAIL_DEFAULT_WIDTH;
  const padding = 12;
  const firstDonutX = padding + BADGE_W + BADGE_GAP;
  const weeklyDonutX = firstDonutX + GROUP_5H_W + GROUP_GAP;
  const weeklyPctX = weeklyDonutX + GROUP_WEEKLY_DONUT + PCT_GAP;
  return { railWidth, firstDonutX, weeklyDonutX, weeklyPctX };
}

test('meter column positions at 1, 3, and 5 profiles', () => {
  const one = meterColumnPositions(1);
  const three = meterColumnPositions(3);
  const five = meterColumnPositions(5);
  assert.deepEqual(one, { railWidth: 292, firstDonutX: 36, weeklyDonutX: 150, weeklyPctX: 172 });
  assert.deepEqual(three, { railWidth: 292, firstDonutX: 36, weeklyDonutX: 150, weeklyPctX: 172 });
  assert.deepEqual(five, { railWidth: 292, firstDonutX: 36, weeklyDonutX: 150, weeklyPctX: 172 });
  assert.equal(three.firstDonutX, one.firstDonutX);
  assert.equal(three.weeklyPctX, five.weeklyPctX);
});
