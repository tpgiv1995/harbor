'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { placeNewTile, resolveStage, placeDraggedTile } = require('../../src/renderer/stage/stage-resolve.cjs');
const tile = (sessionId, slot) => ({ sessionId, slot });
const visible = id => id !== 'missing';

test('new windows fill the first visible gap, relocating a hidden reservation without losing it', () => {
  const original = [tile('a', 0), tile('missing', 1), tile('b', 2)];
  const placed = placeNewTile({ tiles: original, tile: tile('new'), isResolvable: visible });
  assert.equal(placed.find(t => t.sessionId === 'new').slot, 1);
  assert.equal(placed.find(t => t.sessionId === 'b').slot, 2);
  assert.equal(placed.find(t => t.sessionId === 'missing').slot, 3);
  assert.equal(original[1].slot, 1, 'input remains unchanged');
  assert.equal(resolveStage({ tiles: placed, isResolvable: () => true }).tiles.length, 4);
  assert.equal(new Set(placed.map(t => t.slot)).size, 4, 'restoring the hidden window cannot overlap');
});

test('an explicit empty cell wins over the first gap', () => {
  const placed = placeNewTile({ tiles: [tile('a', 0), tile('b', 2)], tile: tile('new'), preferredSlot: 3 });
  assert.equal(placed.at(-1).slot, 3);
});

test('a cell occupied while a launch was pending falls back to the next visible gap', () => {
  let tiles = [tile('a', 0), tile('b', 2)];
  tiles = placeNewTile({ tiles, tile: tile('first'), preferredSlot: 1 });
  tiles = placeNewTile({ tiles, tile: tile('second'), preferredSlot: 1 });
  assert.equal(tiles.find(t => t.sessionId === 'first').slot, 1);
  assert.equal(tiles.find(t => t.sessionId === 'second').slot, 3);
});

test('invalid requested cells fall back to reading order; manual positions are preserved', () => {
  for (const preferredSlot of [-1, 16, NaN, '3', null]) {
    const placed = placeNewTile({ tiles: [tile('a', 3)], tile: tile('new'), preferredSlot });
    assert.deepEqual(placed.map(t => t.slot), [3, 0]);
  }
});

// 2026-10-07, Pat dragged a window from the middle of a full 4x4 stage to the
// empty cell after the last window and it "left behind a 'gap'": "the others
// would 'slide' and adjust and there wouldn't be that gap".
const slots = (tiles) => Object.fromEntries(tiles.map(t => [t.sessionId, t.slot]));
const grid = (n) => Array.from({ length: n }, (_, i) => tile(`w${i}`, i));

test('a window dragged into the empty cells after the others joins the end of their run, no gap', () => {
  const tiles = grid(14).map(t => t.sessionId === 'w6' ? { ...t, sessionId: 'mover' } : t);
  const placed = placeDraggedTile({ tiles, sessionId: 'mover', cell: 14 });
  const s = slots(placed);
  assert.deepEqual([...new Set(placed.map(t => t.slot))].sort((a, b) => a - b), Array.from({ length: 14 }, (_, i) => i), 'cells 0..13 filled, no hole');
  assert.equal(s.mover, 13, 'it lands right after the window that was last');
  assert.equal(s.w7, 6, 'the window after the vacated cell slid back into it');
  assert.equal(s.w13, 12);
  assert.equal(s.w0, 0, 'windows before the vacated cell never move');
});

test('the last window still moves into the empty cell after it (three windows, one bottom-right)', () => {
  const placed = placeDraggedTile({ tiles: grid(3), sessionId: 'w2', cell: 3 });
  assert.deepEqual(slots(placed), { w0: 0, w1: 1, w2: 3 });
});

// Same evening, Pat: "i would want it to slide in between the two, not swap.
// swap is a terrible design choice".
test('dropping onto another window slides the windows between, never swaps', () => {
  assert.deepEqual(slots(placeDraggedTile({ tiles: grid(5), sessionId: 'w1', cell: 3 })), { w0: 0, w1: 3, w2: 1, w3: 2, w4: 4 }, 'forward: w2 and w3 slide back, w1 takes cell 3');
  assert.deepEqual(slots(placeDraggedTile({ tiles: grid(5), sessionId: 'w3', cell: 1 })), { w0: 0, w1: 2, w2: 3, w3: 1, w4: 4 }, 'backward: w1 and w2 slide on, w3 takes cell 1');
});

test('a slide onto a window keeps empty and hidden cells where they are', () => {
  const tiles = [tile('a', 0), tile('b', 1), tile('c', 3), tile('d', 4)];
  assert.deepEqual(slots(placeDraggedTile({ tiles, sessionId: 'a', cell: 4 })), { b: 0, c: 1, d: 3, a: 4 }, 'the empty cell 2 stays empty');
  const hidden = id => id !== 'ghost';
  const withGhost = [tile('a', 0), tile('ghost', 1), tile('b', 2), tile('c', 3)];
  assert.deepEqual(slots(placeDraggedTile({ tiles: withGhost, sessionId: 'a', cell: 3, isResolvable: hidden })), { ghost: 1, b: 0, c: 2, a: 3 }, 'the hidden window keeps its cell');
});

test('a backward drag into a hole closes the vacated cell with the windows after it', () => {
  const tiles = [tile('a', 0), tile('b', 2), tile('c', 3), tile('d', 4)];
  assert.deepEqual(slots(placeDraggedTile({ tiles, sessionId: 'c', cell: 1 })), { a: 0, c: 1, b: 2, d: 3 });
  assert.deepEqual(slots(placeDraggedTile({ tiles, sessionId: 'd', cell: 1 })), { a: 0, d: 1, b: 2, c: 3 }, 'nothing after the last window: no slide');
});

test('the slide stops at the next empty cell; a window dropped beyond it lands exactly there', () => {
  const tiles = [tile('a', 0), tile('b', 1), tile('c', 2), tile('d', 4), tile('e', 5)];
  assert.deepEqual(slots(placeDraggedTile({ tiles, sessionId: 'a', cell: 7 })), { b: 0, c: 1, a: 7, d: 4, e: 5 });
});

test('a hidden window reads as an empty cell: the slide stops there, and a drop on it moves the hidden one aside', () => {
  const hidden = id => id !== 'ghost';
  const tiles = [tile('a', 0), tile('b', 1), tile('ghost', 2), tile('c', 3)];
  const stop = placeDraggedTile({ tiles, sessionId: 'a', cell: 5, isResolvable: hidden });
  assert.deepEqual(slots(stop), { b: 0, a: 5, ghost: 2, c: 3 }, 'b slides back; the run ends at the hidden cell');
  const onto = placeDraggedTile({ tiles, sessionId: 'c', cell: 2, isResolvable: hidden });
  const s = slots(onto);
  assert.equal(s.c, 2);
  assert.equal(new Set(onto.map(t => t.slot)).size, 4, 'no two windows share a cell');
  assert.ok(![0, 1, 2].includes(s.ghost), 'the hidden window keeps its identity in a free cell');
});

test('no-op and invalid drags return the tiles unchanged', () => {
  const tiles = grid(3);
  for (const cell of [1, -1, 16, NaN, '2']) assert.equal(placeDraggedTile({ tiles, sessionId: 'w1', cell }), tiles);
  assert.equal(placeDraggedTile({ tiles, sessionId: 'nope', cell: 2 }), tiles);
});
