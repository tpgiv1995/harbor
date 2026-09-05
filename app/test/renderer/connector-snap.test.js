'use strict';
// Interactive connector snap (Miro-style): while dragging from a connect dot,
// the nearest anchor dot of a nearby shape highlights and the release binds the
// arrow dot-to-dot. The decisions are pure in board-files.cjs; the layer JSX
// only executes them. Anchor geometry is board-model's anchorPoints, the same
// side midpoints the CLI binds to (H5), so an app-drawn and a CLI-drawn arrow
// land identically.
const test = require('node:test');
const assert = require('node:assert');
const boardFiles = require('../../src/renderer/whiteboard/board-files.cjs');

const { nearestAnchorSide, connectorPlan } = boardFiles;

const anchorMap = {
  id: 't1',
  top: { x: 200, y: 87 },
  right: { x: 313, y: 130 },
  bottom: { x: 200, y: 173 },
  left: { x: 87, y: 130 },
};

test('nearestAnchorSide picks the closest dot within the radius', () => {
  assert.deepStrictEqual(
    nearestAnchorSide(anchorMap, 310, 122, 24),
    { side: 'right', point: { x: 313, y: 130 } },
  );
});

test('nearestAnchorSide answers null outside the radius', () => {
  assert.strictEqual(nearestAnchorSide(anchorMap, 200, 20, 24), null);
});

test('nearestAnchorSide breaks a near-tie by actual distance', () => {
  // Closer to top (dy 5) than to left (dx 30).
  const got = nearestAnchorSide({ ...anchorMap, top: { x: 120, y: 95 } }, 117, 100, 40);
  assert.strictEqual(got.side, 'top');
});

const src = { id: 's', x: 0, y: 0, width: 100, height: 60 };
const dst = { id: 'd', x: 300, y: 0, width: 100, height: 60 };

test('connectorPlan with explicit sides lands on exact side midpoints', () => {
  const plan = connectorPlan({ source: src, fromSide: 'right', target: dst, toSide: 'left' });
  assert.deepStrictEqual(plan.from, { x: 100, y: 30 });
  assert.deepStrictEqual(plan.to, { x: 300, y: 30 });
  assert.strictEqual(plan.fromSide, 'right');
  assert.strictEqual(plan.toSide, 'left');
});

test('connectorPlan honours the dot the drag STARTED from, even against geometry', () => {
  const plan = connectorPlan({ source: src, fromSide: 'top', target: dst, toSide: 'left' });
  assert.deepStrictEqual(plan.from, { x: 50, y: 0 });
});

test('connectorPlan body drop picks the target side nearest the drop point', () => {
  const plan = connectorPlan({ source: src, fromSide: 'right', target: dst, dropX: 310, dropY: 55 });
  assert.strictEqual(plan.toSide, 'left');
  assert.deepStrictEqual(plan.to, { x: 300, y: 30 });
});

test('connectorPlan body drop with no drop point falls back to the side facing the source', () => {
  const plan = connectorPlan({ source: src, fromSide: 'right', target: dst });
  assert.strictEqual(plan.toSide, 'left');
});

// ---- Miro two-tier drag targeting (catalog findings 7, 8, 9) ----------------
const {
  EDGE_REVEAL,
  classifyDragPoint,
  segmentBoxEntry,
  bindingFocusFromDrop,
  bindingFocusPoint,
  pointAtFraction,
  nearestFractionOnPolyline,
  syncConnectorLabels,
  moveConnectorEndpoint,
  bendConnectorAt,
  moveConnectorPoint,
  elbowWaypoints,
  translateElbowSegment,
  routeConnector,
  ARROWHEADS,
  swapConnectorHeads,
  bindConnectorEnd,
  detachConnectorEnd,
  connectorStyle,
  ELBOW_CLEARANCE,
} = boardFiles;

const box = { x: 100, y: 100, width: 200, height: 100 };

test('classifyDragPoint: within snap radius of a side midpoint is a dot hit', () => {
  // Left edge midpoint is (100, 150); 10px away snaps.
  const got = classifyDragPoint(box, 92, 145);
  assert.strictEqual(got.mode, 'dot');
  assert.strictEqual(got.side, 'left');
  assert.deepStrictEqual(got.point, { x: 100, y: 150 });
});

test('classifyDragPoint: inside the body (far from every dot) is a body hit', () => {
  const got = classifyDragPoint(box, 160, 130);
  assert.strictEqual(got.mode, 'body');
});

test('classifyDragPoint: within 25px of the edge but off every dot reveals rings', () => {
  // 22px left of the edge, 60px above the left midpoint: reveal, no dot.
  const got = classifyDragPoint(box, 78, 105);
  assert.strictEqual(got.mode, 'edge');
});

test('classifyDragPoint: 30-40px out is nothing (finding 7 threshold)', () => {
  assert.strictEqual(classifyDragPoint(box, 100 - EDGE_REVEAL - 6, 150), null);
  assert.strictEqual(classifyDragPoint(box, 160, 100 - 40), null);
});

test('segmentBoxEntry parks the arrowhead at the crossed edge (finding 9)', () => {
  // From the left, entering the body: the entry is on the left edge.
  const entry = segmentBoxEntry(box, { x: 0, y: 150 }, { x: 200, y: 150 });
  assert.deepStrictEqual(entry, { x: 100, y: 150 });
  // From above at an angle.
  const top = segmentBoxEntry(box, { x: 200, y: 0 }, { x: 200, y: 130 });
  assert.deepStrictEqual(top, { x: 200, y: 100 });
  // A segment that never enters answers null.
  assert.strictEqual(segmentBoxEntry(box, { x: 0, y: 0 }, { x: 50, y: 20 }), null);
});

// ---- Excalidraw binding focus port (pinned body drops, finding 10) ----------
const focusEl = { type: 'rectangle', x: 0, y: 0, width: 200, height: 100 };

test('a drop at the shape centre computes focus 0 (the aim is the centre)', () => {
  const focus = bindingFocusFromDrop(focusEl, { x: -300, y: 50 }, { x: 100, y: 50 });
  assert.ok(Math.abs(focus) < 1e-9, `focus=${focus}`);
  assert.deepStrictEqual(bindingFocusPoint(focusEl, 0, { x: -300, y: 50 }), { x: 100, y: 50 });
});

test('focus round-trips: the focus point Excalidraw derives is on the aim line', () => {
  // Drop off-centre inside the body; the reconstructed gap-0 endpoint must sit
  // on the line from the adjacent point through the drop (Excalidraw's own
  // construction: the intersection of that line with a box diagonal).
  const a = { x: -300, y: 20 };
  const b = { x: 140, y: 30 };
  const focus = bindingFocusFromDrop(focusEl, a, b);
  const p = bindingFocusPoint(focusEl, focus, a);
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const dist = Math.abs(cross) / Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(dist < 0.5, `focus point ${JSON.stringify(p)} is ${dist}px off the aim line`);
  assert.ok(p.x > 0 && p.x < 200 && p.y > 0 && p.y < 100, `focus point ${JSON.stringify(p)} left the shape`);
});

test('focus is signed: drops either side of the centre line get opposite signs', () => {
  const a = { x: -300, y: 50 };
  const above = bindingFocusFromDrop(focusEl, a, { x: 100, y: 20 });
  const below = bindingFocusFromDrop(focusEl, a, { x: 100, y: 80 });
  assert.ok(above !== 0 && below !== 0);
  assert.ok(Math.sign(above) !== Math.sign(below), `above=${above} below=${below}`);
});

test('diamond focus round-trips on its own axes', () => {
  const dia = { type: 'diamond', x: 0, y: 0, width: 100, height: 100 };
  const a = { x: -200, y: 40 };
  const b = { x: 50, y: 45 };
  const focus = bindingFocusFromDrop(dia, a, b);
  const p = bindingFocusPoint(dia, focus, a);
  const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const dist = Math.abs(cross) / Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(dist < 0.5, `diamond focus point ${JSON.stringify(p)} is ${dist}px off the aim line`);
});

// ---- Label position fractions (finding 22) ----------------------------------
test('pointAtFraction walks the polyline by arc length', () => {
  const pts = [[0, 0], [100, 0], [100, 100]];
  assert.deepStrictEqual(pointAtFraction(pts, 0), [0, 0]);
  assert.deepStrictEqual(pointAtFraction(pts, 0.5), [100, 0]);
  assert.deepStrictEqual(pointAtFraction(pts, 0.75), [100, 50]);
  assert.deepStrictEqual(pointAtFraction(pts, 1), [100, 100]);
  // A missing fraction reads as the midpoint (the legacy behaviour).
  assert.deepStrictEqual(pointAtFraction(pts, undefined), [100, 0]);
});

test('nearestFractionOnPolyline projects a point onto the nearest span', () => {
  const pts = [[0, 0], [100, 0], [100, 100]];
  const got = nearestFractionOnPolyline(pts, 25, 8);
  assert.ok(Math.abs(got.t - 0.125) < 1e-9, `t=${got.t}`);
  assert.ok(Math.abs(got.distance - 8) < 1e-9);
  const corner = nearestFractionOnPolyline(pts, 130, 60);
  assert.ok(Math.abs(corner.t - 0.8) < 1e-9, `t=${corner.t}`);
});

test('syncConnectorLabels glues a fraction label to its arrow and buries orphans', () => {
  const arrow = { id: 'a1', type: 'arrow', x: 10, y: 10, points: [[0, 0], [100, 0]] };
  const label = {
    id: 't1', type: 'text', x: 0, y: 0, width: 20, height: 10,
    customData: { labelFor: 'a1', labelFraction: 0.25 },
  };
  const synced = syncConnectorLabels([arrow, label]);
  assert.strictEqual(synced.changed, true);
  const moved = synced.elements.find((e) => e.id === 't1');
  assert.strictEqual(moved.x, 10 + 25 - 10);
  assert.strictEqual(moved.y, 10 + 0 - 5);
  // Already in place: no churn.
  assert.strictEqual(syncConnectorLabels(synced.elements).changed, false);
  // The host dies, the label follows (same contract as sticky shadows).
  const dead = syncConnectorLabels([{ ...arrow, isDeleted: true }, moved]);
  assert.strictEqual(dead.changed, true);
  assert.strictEqual(dead.elements.find((e) => e.id === 't1').isDeleted, true);
  // A poly-shape labelFor (no fraction, host not an arrow) is the CLI's: untouched.
  const poly = { id: 'p1', type: 'line', x: 0, y: 0, width: 50, height: 50, customData: { polyShape: 'triangle' } };
  const polyLabel = { id: 't2', type: 'text', x: 3, y: 4, width: 10, height: 10, customData: { labelFor: 'p1' } };
  assert.strictEqual(syncConnectorLabels([poly, polyLabel]).changed, false);
});

test('a label with no stored fraction reads as the midpoint (0.5)', () => {
  const arrow = { id: 'a1', type: 'arrow', x: 0, y: 0, points: [[0, 0], [200, 0]] };
  const label = { id: 't1', type: 'text', x: 999, y: 999, width: 40, height: 20, customData: { labelFor: 'a1' } };
  const synced = syncConnectorLabels([arrow, label]);
  const moved = synced.elements.find((e) => e.id === 't1');
  assert.strictEqual(moved.x, 100 - 20);
  assert.strictEqual(moved.y, 0 - 10);
});

// ---- Endpoint and waypoint editing (findings 19, 20, 21) --------------------
test('moveConnectorEndpoint rebases the element for a start move, not an end move', () => {
  const el = { id: 'a', type: 'arrow', x: 10, y: 10, points: [[0, 0], [50, 20], [100, 40]] };
  const end = moveConnectorEndpoint(el, 'end', 200, 100);
  assert.strictEqual(end.x, 10);
  assert.deepStrictEqual(end.points[2], [190, 90]);
  assert.deepStrictEqual(end.points[0], [0, 0]);
  const start = moveConnectorEndpoint(el, 'start', 0, 0);
  assert.strictEqual(start.x, 0);
  assert.strictEqual(start.y, 0);
  assert.deepStrictEqual(start.points[0], [0, 0]);
  // Interior and far points keep their ABSOLUTE positions.
  assert.deepStrictEqual(start.points[1], [60, 30]);
  assert.deepStrictEqual(start.points[2], [110, 50]);
});

test('bendConnectorAt inserts a waypoint in the dragged span; each half then has its own span', () => {
  const el = { id: 'a', type: 'arrow', x: 0, y: 0, points: [[0, 0], [200, 0]], roundness: { type: 2 } };
  const bent = bendConnectorAt(el, 0, 100, 60);
  assert.strictEqual(bent.points.length, 3);
  assert.deepStrictEqual(bent.points[1], [100, 60]);
  assert.deepStrictEqual(bent.roundness, { type: 2 });
  const moved = moveConnectorPoint(bent, 1, 90, 70);
  assert.deepStrictEqual(moved.points[1], [90, 70]);
});

test('an elbow keeps logical waypoints and a segment drag translates orthogonally', () => {
  const el = {
    id: 'a', type: 'arrow', x: 0, y: 0,
    points: [[0, 0], [100, 0], [100, 100], [200, 100]], roundness: null,
  };
  const routed = routeConnector(el, 'elbow');
  const wps = elbowWaypoints(routed);
  assert.ok(wps.length >= 3, `waypoints=${JSON.stringify(wps)}`);
  assert.deepStrictEqual(wps[0], [0, 0]);
  assert.deepStrictEqual(wps[wps.length - 1], [200, 100]);
  // Translate the middle (vertical) segment 40px right: both its points move in x only.
  const vertIndex = wps.findIndex((p, i) => i < wps.length - 1 && p[0] === wps[i + 1][0]);
  assert.ok(vertIndex >= 0);
  const dragged = translateElbowSegment(routed, vertIndex, 40, 40);
  const wps2 = elbowWaypoints(dragged);
  assert.strictEqual(wps2[vertIndex][0], wps[vertIndex][0] + 40);
  assert.strictEqual(wps2[vertIndex][1], wps[vertIndex][1]);
  assert.strictEqual(wps2[vertIndex + 1][0], wps[vertIndex + 1][0] + 40);
  // Endpoints never move.
  assert.deepStrictEqual(wps2[0], [0, 0]);
  assert.deepStrictEqual(wps2[wps2.length - 1], [200, 100]);
});

test('elbow routing clears an obstacle by ~28px and rounds its corners (finding 17)', () => {
  // Source at (0,0)-(100,60), target LEFT of it; connector exits the source's
  // bottom dot and must enter the target's left mid anchor from outside,
  // clearing both bodies by the clearance margin.
  const source = { x: 0, y: 0, width: 100, height: 60 };
  const target = { x: -400, y: 0, width: 100, height: 60 };
  const el = {
    id: 'a', type: 'arrow', x: 50, y: 60,
    points: [[0, 0], [-450 - 50 + 0, -30]], roundness: { type: 2 },
  };
  // Absolute endpoints: start (50,60) = source bottom mid; end (-400, 30) = target left mid.
  el.points = [[0, 0], [-450, -30]];
  const routed = routeConnector(el, 'elbow', { obstacles: [source, target] });
  const wps = elbowWaypoints(routed);
  // Endpoints preserved.
  assert.deepStrictEqual(wps[0], [0, 0]);
  assert.deepStrictEqual(wps[wps.length - 1], [-450, -30]);
  // Every waypoint segment is orthogonal.
  for (let i = 0; i < wps.length - 1; i += 1) {
    const dx = wps[i + 1][0] - wps[i][0];
    const dy = wps[i + 1][1] - wps[i][1];
    assert.ok(dx === 0 || dy === 0, `segment ${i} is diagonal: ${JSON.stringify([wps[i], wps[i + 1]])}`);
  }
  // No interior segment crosses either body (the stubs touch at their anchors only).
  const crosses = (p, q, boxAbs) => {
    const bx = boxAbs.x - el.x; const by = boxAbs.y - el.y;
    if (p[0] === q[0]) {
      if (p[0] <= bx || p[0] >= bx + boxAbs.width) return false;
      const y1 = Math.min(p[1], q[1]); const y2 = Math.max(p[1], q[1]);
      return y2 > by && y1 < by + boxAbs.height;
    }
    if (p[1] <= by || p[1] >= by + boxAbs.height) return false;
    const x1 = Math.min(p[0], q[0]); const x2 = Math.max(p[0], q[0]);
    return x2 > bx && x1 < bx + boxAbs.width;
  };
  for (let i = 1; i < wps.length - 2; i += 1) {
    assert.ok(!crosses(wps[i], wps[i + 1], source), `segment ${i} crosses the source body`);
    assert.ok(!crosses(wps[i], wps[i + 1], target), `segment ${i} crosses the target body`);
  }
  // The rendered points carry rounded corners: more points than waypoints, same ends.
  assert.ok(routed.points.length > wps.length, `no corner rounding: ${routed.points.length} points`);
  assert.deepStrictEqual(routed.points[0], [0, 0]);
  assert.deepStrictEqual(routed.points[routed.points.length - 1], [-450, -30]);
  assert.ok(ELBOW_CLEARANCE >= 25 && ELBOW_CLEARANCE <= 30);
});

test('a 2-point connector with roundness 2 reads as curved (the bezier default)', () => {
  const els = [{ id: 'a', type: 'arrow', x: 0, y: 0, points: [[0, 0], [100, 0]], roundness: { type: 2 }, strokeStyle: 'solid', startArrowhead: null, endArrowhead: 'arrow' }];
  assert.strictEqual(connectorStyle(els, ['a']).routing, 'curved');
});

// ---- Arrowheads and swap (findings 23, 25) ----------------------------------
test('the arrowhead set is exactly what Excalidraw draws natively, plus none', () => {
  const values = ARROWHEADS.map((h) => h.value);
  assert.deepStrictEqual(values, [
    null, 'arrow', 'triangle', 'triangle_outline', 'diamond', 'diamond_outline',
    'circle', 'circle_outline', 'bar', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many',
  ]);
  for (const head of ARROWHEADS) {
    assert.ok(head.key && head.label, `head ${head.value} is missing key or label`);
  }
});

test('swapConnectorHeads flips which end carries which arrowhead', () => {
  const els = [
    { id: 'a', type: 'arrow', points: [[0, 0], [10, 0]], startArrowhead: null, endArrowhead: 'triangle' },
    { id: 'r', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
  ];
  const swapped = swapConnectorHeads(els, ['a', 'r']);
  const arrow = swapped.find((e) => e.id === 'a');
  assert.strictEqual(arrow.startArrowhead, 'triangle');
  assert.strictEqual(arrow.endArrowhead, null);
  // A shape in the selection is untouched.
  assert.strictEqual(swapped.find((e) => e.id === 'r').startArrowhead, undefined);
});

test('normalizeLinearPoints rebases a denormalized arrow without moving it', () => {
  const { normalizeLinearPoints } = boardFiles;
  // Excalidraw demands points[0] === [0,0] (its LinearElementEditor logs
  // "Linear element is not normalized" otherwise), but its own interactive
  // passes can leave a half-pixel offset behind. The repair keeps every
  // ABSOLUTE point identical while restoring the invariant.
  const dirty = { id: 'a', type: 'arrow', x: 220, y: 170, points: [[0.5, 0.5], [299.5, 179.5]] };
  const { elements, changed } = normalizeLinearPoints([dirty]);
  assert.strictEqual(changed, true);
  const fixed = elements[0];
  assert.deepStrictEqual(fixed.points[0], [0, 0]);
  assert.strictEqual(fixed.x, 220.5);
  assert.strictEqual(fixed.y, 170.5);
  assert.deepStrictEqual(fixed.points[1], [299, 179]);
  // Absolute endpoints unchanged.
  assert.strictEqual(fixed.x + fixed.points[1][0], dirty.x + dirty.points[1][0]);
  // A clean arrow (and non-linear elements) cause no churn.
  assert.strictEqual(normalizeLinearPoints(elements).changed, false);
  assert.strictEqual(normalizeLinearPoints([{ id: 'r', type: 'rectangle', x: 0, y: 0 }]).changed, false);
});

// ---- Bind and detach for endpoint re-drags (finding 19) ---------------------
test('detachConnectorEnd clears the binding and its mirror; bindConnectorEnd restores both', () => {
  const els = [
    { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, boundElements: [{ id: 'a', type: 'arrow' }] },
    { id: 'r2', type: 'rectangle', x: 50, y: 0, width: 10, height: 10, boundElements: [{ id: 'a', type: 'arrow' }] },
    { id: 'a', type: 'arrow', points: [[0, 0], [50, 0]], startBinding: { elementId: 'r1', focus: 0, gap: 6 }, endBinding: { elementId: 'r2', focus: 0, gap: 6 } },
  ];
  const detached = detachConnectorEnd(els, 'a', 'end');
  assert.strictEqual(detached.find((e) => e.id === 'a').endBinding, null);
  assert.deepStrictEqual(detached.find((e) => e.id === 'r2').boundElements, []);
  // The start's mirror survives on r1.
  assert.strictEqual(detached.find((e) => e.id === 'r1').boundElements.length, 1);
  const rebound = bindConnectorEnd(detached, 'a', 'end', { elementId: 'r2', focus: 0.2, gap: 0 });
  assert.deepStrictEqual(rebound.find((e) => e.id === 'a').endBinding, { elementId: 'r2', focus: 0.2, gap: 0 });
  assert.deepStrictEqual(rebound.find((e) => e.id === 'r2').boundElements, [{ id: 'a', type: 'arrow' }]);
  // Both ends on ONE shape: detaching one end keeps the shared mirror entry.
  const loop = [
    { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, boundElements: [{ id: 'a', type: 'arrow' }] },
    { id: 'a', type: 'arrow', points: [[0, 0], [5, 0]], startBinding: { elementId: 'r1', focus: 0, gap: 6 }, endBinding: { elementId: 'r1', focus: 0, gap: 6 } },
  ];
  const half = detachConnectorEnd(loop, 'a', 'end');
  assert.strictEqual(half.find((e) => e.id === 'r1').boundElements.length, 1);
});
