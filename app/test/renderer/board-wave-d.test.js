'use strict';

// Wave D of the Miro-parity program: the full shape catalog (catalog findings 23 and 36),
// connectable text (38), the right-click menus (62-64), frame presets (40), and the More
// rows Wave C deferred (56, 61). Every decision under test is PURE and lives in
// board-files.cjs; the canvas only executes it.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SHAPE_DEFS, SHAPE_GROUPS, shapeDef, shapeSkeleton, isPolyShape,
  arcPoints, bowSegment, unitPolygon,
  isConnectable, CONNECTABLE_TYPES,
  lockElements, selectionLocked, unlockAllElements, hasLockedElements,
  clearSelectionContent, selectionHasContent,
  duplicateElements, DUPLICATE_GAP, selectableIds,
  contextMenuModel, contextMenuPlacement, CONTEXT_MENU_WIDTH,
  FRAME_PRESETS, framePreset, frameSkeleton,
  switchShapeType, SWITCH_TYPE_KEYS,
} = require('../../src/renderer/whiteboard/board-files.cjs');

const el = (over = {}) => ({
  id: 'e', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, isDeleted: false,
  boundElements: [], strokeColor: '#1e1e1e', backgroundColor: '#ffffff', ...over,
});

// ---- The shape catalog (findings 23, 36) --------------------------------------------

test('every shape def is a drawable member of a declared group', () => {
  const groups = new Set(SHAPE_GROUPS.map((group) => group.key));
  assert.ok(groups.size >= 2, 'the panel is sectioned the way Miro sections it');
  const keys = new Set();
  for (const def of SHAPE_DEFS) {
    assert.ok(!keys.has(def.key), `duplicate shape key ${def.key}`);
    keys.add(def.key);
    assert.ok(groups.has(def.group), `${def.key} names an undeclared group ${def.group}`);
    assert.ok(def.label && def.label.trim(), `${def.key} has no label`);
    if (def.kind === 'native') { assert.ok(def.tool, `${def.key} names no Excalidraw tool`); continue; }
    assert.equal(def.kind, 'poly');
    assert.ok(def.points.length >= 3, `${def.key} is not a polygon`);
    // Normalized into the unit box, and actually SPANNING it: a def that only used part
    // of its box would draw smaller than the drag the user made.
    const xs = def.points.map((p) => p[0]);
    const ys = def.points.map((p) => p[1]);
    assert.ok(Math.min(...xs) >= -1e-6 && Math.max(...xs) <= 1 + 1e-6, `${def.key} escapes the unit box in x`);
    assert.ok(Math.min(...ys) >= -1e-6 && Math.max(...ys) <= 1 + 1e-6, `${def.key} escapes the unit box in y`);
    assert.ok(Math.max(...xs) > 0.9, `${def.key} does not span its box in x`);
    assert.ok(Math.max(...ys) > 0.85, `${def.key} does not span its box in y`);
  }
});

test('the Basic shapes group carries the Miro glyphs Excalidraw can genuinely draw', () => {
  const basic = new Set(SHAPE_DEFS.filter((def) => def.group === 'basic').map((def) => def.key));
  // Finding 36's Basic Shapes list, in Miro's own words, mapped to Harbor's keys.
  for (const key of [
    'rectangle', 'rounded', 'ellipse', 'triangle', 'diamond', 'speech', 'parallelogram',
    'star', 'arrow-block', 'arrow-left', 'arrow-both', 'pentagon', 'octagon', 'hexagon',
    'split-rect', 'trapezoid', 'cloud', 'cross', 'cylinder', 'flag', 'd-shape',
  ]) assert.ok(basic.has(key), `Miro basic shape ${key} is missing`);
  // Deliberately absent, and it must STAY absent rather than be faked: Miro's braces are
  // two disjoint stroked curls, and one `line` element is a single closed filled path.
  assert.equal(basic.has('braces'), false);
});

test('the Flowchart group is a separate section of single-outline symbols', () => {
  const flow = SHAPE_DEFS.filter((def) => def.group === 'flowchart');
  assert.ok(flow.length >= 8, 'the flowchart section is worth having');
  for (const def of flow) {
    assert.equal(def.kind, 'poly');
    assert.ok(def.key.startsWith('flow-'), `${def.key} is not namespaced to the flowchart set`);
  }
});

test('a poly shape skeleton is a closed, filled, tagged line scaled into its box', () => {
  for (const def of SHAPE_DEFS.filter((d) => d.kind === 'poly')) {
    const [made] = shapeSkeleton(def.key, 40, 60, 200, 120);
    assert.equal(made.type, 'line');
    assert.equal(made.fillStyle, 'solid');
    assert.equal(made.roughness, 0);
    assert.equal(made.customData.polyShape, def.key);
    assert.ok(isPolyShape(made));
    assert.deepEqual(made.points[0], made.points[made.points.length - 1], `${def.key} is not closed`);
    // The drawn span is the def's own span scaled by the drag, exactly. (An inscribed
    // regular polygon spans slightly less than its box by construction, which is why
    // this compares against the def rather than against the drag.)
    const span = (values) => Math.max(...values) - Math.min(...values);
    const dx = span(def.points.map((p) => p[0]));
    const dy = span(def.points.map((p) => p[1]));
    assert.ok(Math.abs(span(made.points.map((p) => p[0])) - dx * 200) < 1, `${def.key} does not scale to the drawn width`);
    assert.ok(Math.abs(span(made.points.map((p) => p[1])) - dy * 120) < 1, `${def.key} does not scale to the drawn height`);
  }
});

test('the interior-line shapes draw that line as a zero-area spur, not as a second path', () => {
  // Excalidraw draws ONE path per `line`, so a divider inside a filled shape can only be
  // an out-and-back excursion: the outline visits a vertex it already passed. The fill is
  // unaffected (the excursion encloses no area) while the stroke draws the detail.
  for (const key of ['split-rect', 'cylinder']) {
    const def = shapeDef(key);
    const seen = new Map();
    let revisits = 0;
    def.points.forEach((point, i) => {
      const tag = `${point[0].toFixed(3)},${point[1].toFixed(3)}`;
      if (seen.has(tag) && seen.get(tag) !== i - 1) revisits += 1;
      seen.set(tag, i);
    });
    assert.ok(revisits > 0, `${key} carries no spur, so its interior line would not draw`);
  }
  // The split rectangle's divider is a full-width run at the split, and its silhouette is
  // still the whole box.
  const split = shapeDef('split-rect').points;
  assert.ok(split.some(([x, y]) => x === 0 && y > 0 && y < 1), 'the divider does not start on the left edge');
  assert.ok(split.some(([x, y]) => x === 1 && y > 0 && y < 1), 'the divider does not reach the right edge');
});

test('the curve samplers author in any space and answer in the unit box', () => {
  const arc = arcPoints(0, 0, 10, 5, 0, 180, 4);
  assert.equal(arc.length, 5);
  assert.ok(Math.abs(arc[0][0] - 10) < 1e-9 && Math.abs(arc[0][1]) < 1e-9);
  assert.ok(Math.abs(arc[2][1] - 5) < 1e-9, 'the quarter point sits at the bottom, y down');
  // A bow excludes its start so segments chain without doubling a vertex, and bulges
  // along the left-hand normal.
  const bow = bowSegment([0, 0], [10, 0], 0.5, 2);
  assert.equal(bow.length, 2);
  assert.ok(bow[0][1] < 0, 'a positive bulge on a rightward run bows upward');
  assert.deepEqual(bow[bow.length - 1], [10, 0]);
  const unit = unitPolygon([[5, 100], [15, 100], [10, 300]]);
  assert.deepEqual(unit, [[0, 0], [1, 0], [0.5, 1]]);
});

test('switch type still reaches every catalog shape, quick grid first', () => {
  for (const key of SWITCH_TYPE_KEYS) assert.ok(shapeDef(key), `${key} is not a real shape`);
  // A new catalog entry must be convertible too, or "All shapes" would offer a dead glyph.
  const source = [el({ id: 'a', type: 'rectangle' })];
  const converted = switchShapeType(source, ['a'], 'cloud');
  assert.equal(converted[0].type, 'line');
  assert.equal(converted[0].customData.polyShape, 'cloud');
  assert.equal(converted[0].id, 'a', 'the id survives so bindings and z-order do');
});

// ---- Connectable text (finding 38) ---------------------------------------------------

test('a standalone text is connectable; a bound label, a shadow and a locked shape are not', () => {
  assert.ok(CONNECTABLE_TYPES.has('text'), 'Miro text carries the four side anchors');
  assert.ok(isConnectable(el({ type: 'text', text: 'hi' })));
  assert.ok(isConnectable(el({ type: 'rectangle' })));
  assert.ok(isConnectable(el({ type: 'image' })));
  assert.equal(isConnectable(el({ type: 'text', containerId: 'host' })), false, 'a label is not its own object');
  assert.equal(isConnectable(el({ customData: { stickyShadow: true, faceId: 'f' } })), false);
  assert.equal(isConnectable(el({ locked: true })), false, 'a locked element is not interactive');
  assert.equal(isConnectable(el({ isDeleted: true })), false);
  assert.equal(isConnectable(el({ type: 'arrow' })), false);
  // A catalog poly IS connectable (Pat, 2026-08-30: this exclusion was the
  // "parity is a liar" bug); its attachment rides customData.polyBind because
  // Excalidraw cannot natively bind to a line. A plain drawn line is not one.
  assert.equal(isConnectable(el({ type: 'line', customData: { polyShape: 'star' } })), true);
  assert.equal(isConnectable(el({ type: 'line' })), false);
  assert.equal(isConnectable(null), false);
});

// ---- Lock, unlock all, clear content (findings 61-63) ---------------------------------

test('lock carries a bound label along and never touches a sticky shadow', () => {
  const scene = [
    el({ id: 'band', customData: { stickyShadow: true, faceId: 'face' }, locked: true }),
    el({ id: 'face', boundElements: [{ type: 'text', id: 'label' }] }),
    el({ id: 'label', type: 'text', containerId: 'face' }),
    el({ id: 'other' }),
  ];
  const locked = lockElements(scene, ['face'], true);
  assert.equal(locked.find((e) => e.id === 'face').locked, true);
  assert.equal(locked.find((e) => e.id === 'label').locked, true, 'an unlocked label inside a locked shape still eats clicks');
  assert.equal(locked.find((e) => e.id === 'other').locked, undefined);
  assert.equal(locked.find((e) => e.id === 'band').locked, true, 'the band keeps the lock it was born with');
  assert.equal(selectionLocked(locked, ['face']), true);
  assert.equal(selectionLocked(scene, ['face']), false);
  assert.equal(selectionLocked(scene, []), false, 'an empty selection is not "locked"');
  const back = lockElements(locked, ['face'], false);
  assert.equal(back.find((e) => e.id === 'face').locked, false);
  assert.equal(back.find((e) => e.id === 'band').locked, true);
});

test('unlock all frees the board but leaves the sticky bands locked', () => {
  const scene = [
    el({ id: 'band', customData: { stickyShadow: true, faceId: 'face' }, locked: true }),
    el({ id: 'face', locked: true }),
    el({ id: 'free' }),
  ];
  assert.equal(hasLockedElements(scene), true);
  const next = unlockAllElements(scene);
  assert.equal(next.changed, true);
  assert.equal(next.elements.find((e) => e.id === 'face').locked, false);
  assert.equal(next.elements.find((e) => e.id === 'band').locked, true);
  assert.equal(hasLockedElements(next.elements), false, 'a still-locked band is not a lock the user can clear');
  assert.equal(unlockAllElements(next.elements).changed, false, 'a second pass is a no-op');
});

test('clear content tombstones the text and drops the container mirror', () => {
  const scene = [
    el({ id: 'face', boundElements: [{ type: 'text', id: 'label' }, { type: 'arrow', id: 'link' }] }),
    el({ id: 'label', type: 'text', containerId: 'face', text: 'words' }),
    el({ id: 'poly', type: 'line', customData: { polyShape: 'star' } }),
    el({ id: 'polylabel', type: 'text', customData: { labelFor: 'poly' }, text: 'star' }),
    el({ id: 'link', type: 'arrow' }),
  ];
  assert.equal(selectionHasContent(scene, ['face']), true);
  assert.equal(selectionHasContent(scene, ['link']), false);
  const cleared = clearSelectionContent(scene, ['face']);
  assert.equal(cleared.changed, true);
  assert.equal(cleared.elements.find((e) => e.id === 'label').isDeleted, true);
  assert.deepEqual(cleared.elements.find((e) => e.id === 'face').boundElements, [{ type: 'arrow', id: 'link' }]);
  // A poly's standalone label is content too.
  const poly = clearSelectionContent(scene, ['poly']);
  assert.equal(poly.elements.find((e) => e.id === 'polylabel').isDeleted, true);
  assert.equal(clearSelectionContent(scene, ['link']).changed, false);
});

// ---- Duplicate (finding 59) ----------------------------------------------------------

test('duplicate lands beside the original and re-points every internal reference', () => {
  const scene = [
    el({ id: 'band', x: 0, y: 4, width: 110, height: 110, customData: { stickyShadow: true, faceId: 'face', dx: 0, dy: 4 }, locked: true }),
    el({ id: 'face', x: 0, y: 0, width: 110, height: 110, boundElements: [{ type: 'text', id: 'label' }, { type: 'arrow', id: 'outside' }], customData: { sticky: { w: 110, h: 110 } } }),
    el({ id: 'label', type: 'text', containerId: 'face', x: 10, y: 40, width: 40, height: 20, text: 'hi' }),
    el({ id: 'outside', type: 'arrow', startBinding: { elementId: 'face', focus: 0, gap: 6 } }),
  ];
  let n = 0;
  const made = duplicateElements(scene, ['face'], () => `copy-${++n}`);
  assert.equal(made.elements.length, scene.length + 3, 'the face brings its label and its band');
  const face = made.elements.find((e) => e.id === 'copy-2');
  const band = made.elements.find((e) => e.customData && e.customData.faceId === face.id && e.id !== 'band');
  const label = made.elements.find((e) => e.containerId === face.id && e.id !== 'label');
  assert.equal(face.x, 110 + DUPLICATE_GAP, 'the copy sits beside the original, Miro-style');
  assert.equal(face.y, 0, 'and at the same y');
  assert.ok(band && band.x === face.x, 'the band travels with the face');
  assert.ok(label && label.x === 10 + 110 + DUPLICATE_GAP);
  assert.deepEqual(face.boundElements, [{ type: 'text', id: label.id }], 'a connector to an uncopied shape is dropped, never silently re-bound');
  assert.equal(face.index, null, 'Excalidraw re-indexes the clone by array position');
  assert.equal(scene.length, 4, 'the input is untouched');
});

test('duplicate of nothing is a no-op, and select-all skips what cannot be acted on', () => {
  const scene = [
    el({ id: 'band', customData: { stickyShadow: true, faceId: 'face' }, locked: true }),
    el({ id: 'face' }),
    el({ id: 'label', type: 'text', containerId: 'face' }),
    el({ id: 'locked', locked: true }),
    el({ id: 'gone', isDeleted: true }),
  ];
  assert.deepEqual(duplicateElements(scene, [], () => 'x').ids, []);
  assert.deepEqual(selectableIds(scene), ['face']);
});

// ---- The right-click menus (findings 62-64) ------------------------------------------

const keysOf = (rows) => rows.filter((row) => row.kind !== 'sep').map((row) => row.key);

test('the canvas menu is Miro\'s canvas list, minus what a Harbor board has no notion of', () => {
  const rows = contextMenuModel({ kind: 'canvas', anyLocked: true, hasCopiedStyle: true });
  assert.deepEqual(keysOf(rows), ['addSticky', 'addText', 'selectAll', 'unlockAll', 'pasteStyle', 'showAll', 'wheelMode']);
  assert.ok(rows.some((row) => row.kind === 'sep'), 'the list is grouped, not one run');
  assert.equal(rows.find((row) => row.key === 'wheelMode').kind, 'submenu');
  const bare = contextMenuModel({ kind: 'canvas' });
  assert.equal(bare.find((row) => row.key === 'unlockAll').disabled, true, 'nothing locked, nothing to unlock');
  assert.equal(bare.find((row) => row.key === 'pasteStyle').disabled, true, 'no style copied yet');
});

test('the element menu carries Clear content and the connector menu deliberately does not', () => {
  const element = contextMenuModel({ kind: 'element', hasContent: true, hasCopiedStyle: true });
  assert.deepEqual(keysOf(element), ['copyImage', 'duplicate', 'remove', 'copyStyle', 'pasteStyle', 'clearContent', 'arrange', 'lock']);
  const connector = contextMenuModel({ kind: 'connector', hasCopiedStyle: true });
  assert.deepEqual(keysOf(connector), ['copyImage', 'duplicate', 'remove', 'copyStyle', 'pasteStyle', 'arrange', 'lock']);
  assert.equal(element.find((row) => row.key === 'arrange').kind, 'submenu');
  assert.equal(contextMenuModel({ kind: 'element' }).find((row) => row.key === 'clearContent').disabled, true);
  // A locked selection offers the inverse row, never a Lock that does nothing.
  const locked = contextMenuModel({ kind: 'element', locked: true });
  assert.ok(keysOf(locked).includes('unlock'));
  assert.equal(keysOf(locked).includes('lock'), false);
  // Every row carries a stable unique key, separators included, so React never keys twice.
  const all = [...element, ...connector.map((row) => ({ ...row, key: `c-${row.key}` }))];
  assert.equal(new Set(all.map((row) => row.key)).size, all.length);
});

test('the menu is anchored by top or bottom so it never needs its own height', () => {
  const viewport = { width: 1000, height: 800 };
  const upper = contextMenuPlacement({ x: 400, y: 100, viewport });
  assert.deepEqual({ left: upper.left, top: upper.top, bottom: upper.bottom, flipped: upper.flipped },
    { left: 400, top: 100, bottom: null, flipped: false });
  const lower = contextMenuPlacement({ x: 400, y: 700, viewport });
  assert.equal(lower.flipped, true);
  assert.equal(lower.top, null);
  assert.equal(lower.bottom, 100, 'anchoring the BOTTOM at the click needs no measured height');
  // Clamped horizontally by its known width, both sides.
  assert.equal(contextMenuPlacement({ x: 990, y: 10, viewport }).left, 1000 - CONTEXT_MENU_WIDTH - 8);
  assert.equal(contextMenuPlacement({ x: -50, y: 10, viewport }).left, 8);
  assert.ok(contextMenuPlacement({ x: 400, y: 100, viewport }).maxHeight <= 800);
  assert.equal(contextMenuPlacement({ x: 1, y: 1 }), null);
});

// ---- Frame presets (finding 40) -------------------------------------------------------

test('frame presets are Miro\'s list, Custom first and every size honest', () => {
  assert.equal(FRAME_PRESETS[0].key, 'custom');
  assert.equal(FRAME_PRESETS[0].width, null, 'Custom is drawn, not dropped at a size');
  for (const label of ['A4', 'Letter', '16:9', '4:3', '1:1', 'Mobile', 'Tablet', 'Desktop']) {
    const preset = FRAME_PRESETS.find((entry) => entry.label === label);
    assert.ok(preset, `Miro's ${label} frame is missing`);
    assert.ok(preset.width > 0 && preset.height > 0);
  }
  const ratio = (label) => {
    const preset = FRAME_PRESETS.find((entry) => entry.label === label);
    return preset.width / preset.height;
  };
  assert.ok(Math.abs(ratio('16:9') - 16 / 9) < 1e-6);
  assert.ok(Math.abs(ratio('4:3') - 4 / 3) < 1e-6);
  assert.equal(ratio('1:1'), 1);
  assert.equal(framePreset('nope'), null);
});

test('a frame skeleton is a real frame element, and Custom builds nothing', () => {
  const [frame] = frameSkeleton('a4', 12.6, 30.2);
  assert.equal(frame.type, 'frame');
  assert.equal(frame.name, 'A4');
  assert.deepEqual(frame.children, [], 'the skeleton type requires children; the frame adopts what it covers');
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 13, y: 30 });
  assert.deepEqual({ w: frame.width, h: frame.height }, { w: 794, h: 1123 });
  assert.deepEqual(frameSkeleton('custom', 0, 0), []);
  assert.deepEqual(frameSkeleton('nope', 0, 0), []);
});
