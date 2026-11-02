'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { connectorPaths, rowsOf } = require('../../src/renderer/orchestration/team-layout.cjs');

// The team board's lines are drawn from measured card boxes (visual px), so
// these fixtures are boxes as the board would measure them.
const box = (left, top, width = 312, height = 158) => ({ left, top, right: left + width, bottom: top + height });

function numbers(d) {
  return d.match(/-?\d+(\.\d+)?/g).map(Number);
}

test('a parent with one row of children: one bus, one drop per child ending on its top edge', () => {
  const rects = { lead: box(200, 0), a: box(0, 202), b: box(400, 202) };
  const paths = connectorPaths(rects, [{ parent: 'lead', children: [{ id: 'a', kind: 'directs' }, { id: 'b', kind: 'directs' }] }], [], { gap: 44 });
  const bus = paths.find((p) => p.kind === 'bus');
  assert.ok(bus, 'a bus is drawn');
  // From the parent's bottom centre down to the bus, halfway into the gap.
  assert.deepEqual(numbers(bus.d).slice(0, 3), [356, 158, 180]);
  const drops = paths.filter((p) => p.arrow);
  assert.deepEqual(drops.map((p) => p.to).sort(), ['a', 'b']);
  for (const drop of drops) {
    const [x, y1, y2] = numbers(drop.d);
    assert.equal(y1, 180, 'the drop starts on the bus');
    assert.equal(y2, rects[drop.to].top - 1, 'the arrow ends on the child top edge');
    assert.equal(x, (rects[drop.to].left + rects[drop.to].right) / 2, 'the drop is centred on the child');
  }
});

test('children wrapped onto two rows share a trunk left of every child, so no line crosses a card', () => {
  const rects = { lead: box(300, 0), a: box(100, 202), b: box(450, 202), c: box(100, 404) };
  const paths = connectorPaths(rects, [{ parent: 'lead', children: ['a', 'b', 'c'].map((id) => ({ id, kind: 'directs' })) }], [], { gap: 44, trunkInset: 14 });
  const bus = paths.find((p) => p.kind === 'bus');
  assert.match(bus.d, /M86 180V382/, 'the trunk runs at x=86 (14 left of the leftmost child) from the first bus to the second');
  // Every horizontal run starts at or right of the trunk, never inside a card.
  for (const [, x1] of bus.d.matchAll(/M(-?[\d.]+) [\d.]+H/g)) assert.ok(Number(x1) >= 86 - 0.001, `a bus starts at x=${x1}`);
  assert.equal(rowsOf([{ rect: rects.a }, { rect: rects.b }, { rect: rects.c }]).length, 2);
});

test('beyond one level: the trunk clears a first-row child\'s whole subtree, not just its card', () => {
  // Row 1: child a, whose own children reach 330px further left than a's card.
  // Row 2: child b. A trunk placed from the cards (x = a.left - 14) would run
  // down through a's grandchildren on its way to row 2.
  const a = box(400, 202);
  a.node = { left: 70, top: 202, right: 1042, bottom: 562 };
  const b = { ...box(400, 606), node: box(400, 606) };
  const grandchild = box(70, 404);
  const rects = { lead: box(400, 0), a, b, grandchild };
  const [bus] = connectorPaths(rects, [{ parent: 'lead', children: [{ id: 'a', kind: 'directs' }, { id: 'b', kind: 'directs' }] }], [], { gap: 44, trunkInset: 13 });
  const trunk = bus.d.match(/M(-?[\d.]+) [\d.]+V/g).map((m) => Number(m.slice(1).split(' ')[0])).find((x) => x < 400);
  assert.equal(trunk, 57, 'the trunk runs 13px left of the widest subtree');
  assert.ok(trunk < grandchild.left, 'so it never enters the grandchild card');
});

test('the bus gap follows the zoom it is given, so a zoomed board still meets its cards', () => {
  const z = 0.7;
  const rects = { lead: box(0, 0, 312 * z, 158 * z), a: box(0, 158 * z + 44 * z, 312 * z, 158 * z) };
  const [bus, drop] = connectorPaths(rects, [{ parent: 'lead', children: [{ id: 'a', kind: 'directs' }] }], [], { gap: 44 * z });
  const busY = numbers(bus.d)[2];
  assert.ok(busY > rects.lead.bottom && busY < rects.a.top, 'the bus sits between parent and child');
  assert.equal(numbers(drop.d).at(-1), rects.a.top - 1);
});

test('cross lines use the sides of both cards, so they never look like a reporting arrow', () => {
  const rects = { x: box(0, 0), below: box(0, 300), beside: box(500, 0) };
  const paths = connectorPaths(rects, [], [{ from: 'x', to: 'below', kind: 'reviews' }, { from: 'x', to: 'beside', kind: 'keeps-alive' }]);
  const down = paths.find((p) => p.to === 'below');
  const across = paths.find((p) => p.to === 'beside');
  const first = numbers(down.d).slice(0, 2);
  assert.ok(first[0] === 0 || first[0] === 312, 'leaves from a side');
  assert.equal(first[1], 79, 'at mid height');
  assert.equal(segmentsOf(down.d).at(-1)[3], 379, 'and arrives at the middle of the card below');
  assert.equal(across.d, 'M312 79H499', 'facing neighbours get one straight run');
  assert.ok(down.arrow && across.arrow);
});

test('a child or parent that is not on the board draws nothing', () => {
  const rects = { lead: box(0, 0) };
  assert.deepEqual(connectorPaths(rects, [{ parent: 'lead', children: [{ id: 'gone', kind: 'directs' }] }], [{ from: 'lead', to: 'gone', kind: 'reviews' }]), []);
});

// Walk an M/H/V/Q path into straight segments (a Q corner is the two legs
// through its control point, which is the exact corner of an orthogonal turn).
function segmentsOf(d) {
  const segs = []; let x = 0; let y = 0;
  for (const m of d.matchAll(/([MHVQ])(-?[\d.]+)(?: (-?[\d.]+))?(?: (-?[\d.]+))?(?: (-?[\d.]+))?/g)) {
    const n = m.slice(2).filter((v) => v !== undefined).map(Number);
    if (m[1] === 'M') { [x, y] = n; } else if (m[1] === 'H') { segs.push([x, y, n[0], y]); [x] = n; } else if (m[1] === 'V') { segs.push([x, y, x, n[0]]); [, y] = [x, n[0]]; } else { segs.push([x, y, n[0], n[1]], [n[0], n[1], n[2], n[3]]); [x, y] = [n[2], n[3]]; }
  }
  return segs;
}
const crosses = (seg, c) => Math.min(seg[0], seg[2]) < c.right - 1 && Math.max(seg[0], seg[2]) > c.left + 1 && Math.min(seg[1], seg[3]) < c.bottom - 1 && Math.max(seg[1], seg[3]) > c.top + 1;

test('a cross-level line goes around the cards between its ends and enters its target from the side', () => {
  // Reviewer two rows below its target, with a card squarely in between.
  const rects = { target: box(0, 0), blocker: box(0, 202), reviewer: box(0, 404), beside: box(334, 202) };
  const [path] = connectorPaths(rects, [], [{ from: 'reviewer', to: 'target', kind: 'reviews' }], { crossMargin: 8, crossBend: 30 });
  assert.doesNotMatch(path.d, /C/, 'routed, not the fallback curve');
  const segs = segmentsOf(path.d);
  for (const [id, card] of Object.entries(rects)) for (const seg of segs) assert.ok(!crosses(seg, card), `the line passes through ${id}: ${path.d}`);
  const end = segs.at(-1);
  assert.equal(end[1], 79, 'it ends at the middle of the target\'s height');
  assert.ok(end[2] === -1 || end[2] === 313, 'on the target\'s left or right edge');
  const start = segs[0];
  assert.ok(start[0] === 0 || start[0] === 312, 'it leaves the reviewer from a side, never the top or bottom');
});

test('neighbours side by side get a straight line between facing edges', () => {
  const rects = { a: box(0, 0), b: box(400, 0) };
  const [path] = connectorPaths(rects, [], [{ from: 'a', to: 'b', kind: 'keeps-alive' }]);
  assert.equal(path.d, 'M312 79H399');
});
