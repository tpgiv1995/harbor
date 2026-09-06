'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gridDimensions, navigateSlot } = require('../../src/renderer/stage/grid-nav.cjs');

test('gridDimensions matches the stage layout ladder', () => {
  assert.deepEqual(gridDimensions(1), { cols: 1, rows: 1 });
  assert.deepEqual(gridDimensions(2), { cols: 2, rows: 1 });
  assert.deepEqual(gridDimensions(4), { cols: 2, rows: 2 });
  assert.deepEqual(gridDimensions(6), { cols: 3, rows: 2 });
  assert.deepEqual(gridDimensions(9), { cols: 3, rows: 3 });
  assert.deepEqual(gridDimensions(12), { cols: 4, rows: 3 });
  assert.deepEqual(gridDimensions(16), { cols: 4, rows: 4 });
});

test('moves to the adjacent occupied cell in each direction (2x2 full)', () => {
  const grid = { slots: [0, 1, 2, 3], cols: 2, rows: 2 };
  assert.equal(navigateSlot({ ...grid, fromSlot: 0, direction: 'right' }), 1);
  assert.equal(navigateSlot({ ...grid, fromSlot: 1, direction: 'left' }), 0);
  assert.equal(navigateSlot({ ...grid, fromSlot: 0, direction: 'down' }), 2);
  assert.equal(navigateSlot({ ...grid, fromSlot: 3, direction: 'up' }), 1);
});

test('skips holes in a straight line', () => {
  // 3x1 row with the middle cell empty: left window jumps across the hole.
  assert.equal(navigateSlot({ slots: [0, 2], fromSlot: 0, direction: 'right', cols: 3, rows: 1 }), 2);
  // Column with a hole between rows in a 3x3.
  assert.equal(navigateSlot({ slots: [0, 6], fromSlot: 0, direction: 'down', cols: 3, rows: 3 }), 6);
});

test('stops at the edge: no wrap, no diagonal guessing', () => {
  const grid = { slots: [0, 1, 2], cols: 2, rows: 2 };
  assert.equal(navigateSlot({ ...grid, fromSlot: 0, direction: 'left' }), null);
  assert.equal(navigateSlot({ ...grid, fromSlot: 0, direction: 'up' }), null);
  // Slot 2 (bottom-left): nothing to its right in ITS row beyond the empty
  // cell, so nothing happens, never a jump to another row.
  assert.equal(navigateSlot({ ...grid, fromSlot: 2, direction: 'right' }), null);
});

test('nonsense input yields null, never a throw', () => {
  assert.equal(navigateSlot({ slots: [0], fromSlot: 0, direction: 'sideways', cols: 1, rows: 1 }), null);
  assert.equal(navigateSlot({ slots: [], fromSlot: NaN, direction: 'left', cols: 2, rows: 2 }), null);
  assert.equal(navigateSlot({ slots: [0], fromSlot: 0, direction: 'left', cols: 0, rows: 0 }), null);
});
