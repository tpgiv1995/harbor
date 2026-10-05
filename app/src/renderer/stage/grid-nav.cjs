'use strict';

// Stage grid geometry and spatial window navigation (Alt+arrows). CommonJS
// so the tests require it directly, the same split file-drop.cjs uses; the
// Stage imports gridDimensions from here too, so navigation math and the
// rendered grid can never disagree about shape.

// Adaptive grid: every tile in a layout shares identical cell size.
function gridDimensions(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  if (count <= 12) return { cols: 4, rows: 3 };
  return { cols: 4, rows: 4 };
}

const DELTAS = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

// The next occupied cell in a straight line from the current one, skipping
// holes, stopping at the grid edge. Straight-line on purpose: the answer to
// "which window is to my right" must be predictable from the screen, never a
// nearest-neighbor guess that jumps rows.
function navigateSlot({ slots, fromSlot, direction, cols, rows }) {
  const delta = DELTAS[direction];
  if (!delta || !Number.isInteger(fromSlot) || !Number.isInteger(cols) || cols < 1 || rows < 1) return null;
  const occupied = new Set((slots || []).filter((slot) => Number.isInteger(slot)));
  let col = fromSlot % cols;
  let row = Math.floor(fromSlot / cols);
  for (;;) {
    col += delta[0];
    row += delta[1];
    if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
    const slot = row * cols + col;
    if (occupied.has(slot)) return slot;
  }
}

module.exports = { gridDimensions, navigateSlot };
