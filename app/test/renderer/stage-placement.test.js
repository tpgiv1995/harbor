'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { placeNewTile, resolveStage } = require('../../src/renderer/stage/stage-resolve.cjs');
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
