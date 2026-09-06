'use strict';

// Manual reorder, once the rendered order stopped being the stored order.
//
// A star pins its task to the top of My order, so the rows on screen and the
// `order` sequence the reducer splices interleave. A drop names the row it
// landed on and always did; an Alt+arrow names a DIRECTION, and this is where
// the visible neighbour gets resolved. Getting either wrong is silent: the task
// moves in the file and appears not to move, or moves the other way.

const test = require('node:test');
const assert = require('node:assert/strict');

const { planMove } = require('../../src/renderer/tasks/reorder-move.cjs');

// Stored order A B C D, with C and D starred, so the screen reads C D A B.
const ORDER = ['A', 'B', 'C', 'D'];
const SHOWN = ['C', 'D', 'A', 'B'];
const PINNED = ['C', 'D'];

const plan = (over) => planMove({ order: ORDER, shown: SHOWN, pinned: PINNED, ...over });

test('1) a drop lands where it was dropped, translated into stored order', () => {
  // A dropped after B: stored order becomes B A C D, screen C D B A.
  assert.deepEqual(plan({ taskId: 'A', targetId: 'B', position: 'after' }), { toIndex: 1 });
  // D dropped before C: stored order becomes A B D C, screen D C A B.
  assert.deepEqual(plan({ taskId: 'D', targetId: 'C', position: 'before' }), { toIndex: 2 });
  // A dropped before B is where A already is.
  assert.equal(plan({ taskId: 'A', targetId: 'B', position: 'before' }), null);
});

test('2) Alt+arrow steps past the VISIBLE neighbour, not the next stored slot', () => {
  // D is SECOND on screen and LAST in stored order. Alt+Up means "above C", the
  // row over it on screen, which is stored index 2. A blind from-1 would have
  // stepped it past B instead: invisible on screen, and wrong in the file.
  assert.deepEqual(plan({ taskId: 'D', targetId: null, position: 'up' }), { toIndex: 2 });
  // B is last on screen and second in stored order. Alt+Up means "above A".
  assert.deepEqual(plan({ taskId: 'B', targetId: null, position: 'up' }), { toIndex: 0 });
  // C is first on screen; there is nothing above it.
  assert.equal(plan({ taskId: 'C', targetId: null, position: 'up' }), null);
  // B is last on screen; there is nothing below it.
  assert.equal(plan({ taskId: 'B', targetId: null, position: 'down' }), null);
});

test('3) nothing crosses the pin, in either direction', () => {
  // A is directly under the starred block. Alt+Up would mean "above D", which
  // the pin makes impossible; accepting it wrote A BELOW D in stored order and
  // moved A one row DOWN the screen, the exact opposite of the keystroke.
  assert.equal(plan({ taskId: 'A', targetId: null, position: 'up' }), null);
  // And the starred row cannot be pushed under an ordinary one.
  assert.equal(plan({ taskId: 'D', targetId: null, position: 'down' }), null);
  // A drag across the line is the same event with a mouse, so it is refused the
  // same way rather than landing somewhere the screen cannot show it.
  assert.equal(plan({ taskId: 'A', targetId: 'C', position: 'before' }), null);
  assert.equal(plan({ taskId: 'C', targetId: 'B', position: 'after' }), null);
});

test('4) with no star in play the two sequences agree and nothing changed', () => {
  const flat = (over) => planMove({ order: ORDER, shown: ORDER, ...over });
  assert.deepEqual(flat({ taskId: 'A', targetId: null, position: 'down' }), { toIndex: 1 });
  assert.deepEqual(flat({ taskId: 'D', targetId: null, position: 'up' }), { toIndex: 2 });
  assert.deepEqual(flat({ taskId: 'D', targetId: 'A', position: 'before' }), { toIndex: 0 });
  assert.equal(flat({ taskId: 'A', targetId: null, position: 'up' }), null);
  assert.equal(flat({ taskId: 'D', targetId: null, position: 'down' }), null);
});

test('5) a move that names nothing real is refused, never a throw', () => {
  assert.equal(plan({ taskId: 'gone', targetId: 'A', position: 'before' }), null);
  // Another branch entirely: a drop across branches is never a re-parent.
  assert.equal(plan({ taskId: 'A', targetId: 'elsewhere', position: 'after' }), null);
  assert.equal(planMove(), null);
  assert.equal(planMove({ taskId: 'A' }), null);
  assert.equal(plan({ taskId: 'A', targetId: null, position: 'sideways' }), null);
});
