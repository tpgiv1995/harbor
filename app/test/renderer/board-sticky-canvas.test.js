'use strict';
// Miro sticky + canvas/navigation parity rules (catalog findings 29-35, 66-74, section 6).
// Pure decisions live in board-files.cjs; these specs were written FIRST and fail
// against the pre-feature module.
const test = require('node:test');
const assert = require('node:assert');
const decisions = require('../../src/renderer/whiteboard/board-files.cjs');

// A deterministic fake glyph measure: every char is 0.6em wide (monospace-ish).
const measure = (text, fontSize) => text.length * fontSize * 0.6;

// ---------------------------------------------------------------- sticky sizes

test('sticky default is Miro small (110) and S/M/L presets exist with S as the default', () => {
  assert.equal(decisions.STICKY_SIZE, 110); // finding 30: ~110px square at the click
  assert.equal(decisions.STICKY_SIZES.length, 3);
  assert.deepEqual(decisions.STICKY_SIZES.map((s) => s.key), ['S', 'M', 'L']);
  assert.equal(decisions.STICKY_SIZES[0].px, decisions.STICKY_SIZE); // S IS the default
  assert.ok(decisions.STICKY_SIZES[1].px > decisions.STICKY_SIZES[0].px);
  assert.ok(decisions.STICKY_SIZES[2].px > decisions.STICKY_SIZES[1].px);
});

// ------------------------------------------------------- sticky face + shadow

test('a sticky is two bottom-only shadow bands under a face; no side offset (finding 34)', () => {
  const created = decisions.stickyNoteSkeleton({ color: 'yellow', x: 40, y: 60 });
  assert.equal(created.length, 3);
  const [far, near, face] = created;
  assert.ok(decisions.isStickyShadow(far) && decisions.isStickyShadow(near), 'both bands marked');
  assert.ok(!decisions.isStickyShadow(face));
  // bottom-only: zero horizontal offset, both bands purely below
  assert.equal(far.customData.dx, 0);
  assert.equal(near.customData.dx, 0);
  assert.equal(far.x, face.x);
  assert.equal(near.x, face.x);
  assert.ok(near.customData.dy > 0 && far.customData.dy > near.customData.dy, 'far band reaches lower');
  // soft: falloff over ~8px total, peak (near+far composite) under ~12% darkening
  assert.ok(far.customData.dy <= 10, `falloff ${far.customData.dy}px is not soft`);
  const peak = 100 * (1 - (1 - near.opacity / 100) * (1 - far.opacity / 100));
  assert.ok(peak >= 6 && peak <= 12, `composite peak ${peak}% out of the ~9% band`);
  assert.ok(far.opacity < near.opacity + far.opacity, 'tail must be lighter than the peak');
  // the face is tagged as a sticky (autosize + the S/M/L control key off this)
  assert.deepEqual(face.customData.sticky, { w: decisions.STICKY_SIZE, h: decisions.STICKY_SIZE });
  assert.equal(face.width, decisions.STICKY_SIZE);
});

test('syncStickyShadows glues each band by its OWN offsets and keeps the legacy 5/7 default', () => {
  const face = { id: 'f', type: 'rectangle', x: 100, y: 100, width: 110, height: 110, angle: 0 };
  const near = { id: 'n', type: 'rectangle', x: 100, y: 104, width: 110, height: 110, angle: 0, locked: true, customData: { stickyShadow: true, faceId: 'f', dx: 0, dy: 4 } };
  const far = { id: 'r', type: 'rectangle', x: 100, y: 108, width: 110, height: 110, angle: 0, locked: true, customData: { stickyShadow: true, faceId: 'f', dx: 0, dy: 8 } };
  assert.equal(decisions.syncStickyShadows([far, near, face]).changed, false); // already glued
  const moved = decisions.syncStickyShadows([far, near, { ...face, x: 300, y: 200 }]);
  assert.equal(moved.changed, true);
  assert.equal(moved.elements.find((e) => e.id === 'n').y, 204);
  assert.equal(moved.elements.find((e) => e.id === 'r').y, 208);
  assert.equal(moved.elements.find((e) => e.id === 'n').x, 300);
  // a legacy single-shadow sticky (no dx/dy customData) keeps the historical 5/7 glue
  const legacy = { id: 's', type: 'rectangle', x: 0, y: 0, width: 180, height: 180, angle: 0, locked: true, customData: { stickyShadow: true, faceId: 'f' } };
  const legacyMoved = decisions.syncStickyShadows([legacy, { ...face, width: 180, height: 180 }]);
  assert.equal(legacyMoved.elements.find((e) => e.id === 's').x, 105);
  assert.equal(legacyMoved.elements.find((e) => e.id === 's').y, 107);
  // orphan invariants stand: both bands die with the face
  const orphan = decisions.syncStickyShadows([far, near, { ...face, isDeleted: true }]);
  assert.equal(orphan.changed, true);
  assert.equal(orphan.elements.filter((e) => e.isDeleted && decisions.isStickyShadow(e)).length, 2);
});

// ------------------------------------------------------------ sticky autosize

test('fitStickyFontSize: text auto-shrinks so the note NEVER grows (finding 31)', () => {
  const box = { width: 110, height: 110, measure };
  // empty and short text sit at the 28px ceiling Miro measured
  assert.equal(decisions.fitStickyFontSize({ text: '', ...box }).fontSize, 28);
  assert.equal(decisions.fitStickyFontSize({ text: 'Hey', ...box }).fontSize, 28);
  // a 150-char paragraph lands small (Miro measured ~9px in the same square)
  const long = 'this is a much longer text to prove that the sticky note auto shrinks its font size while the note itself stays the same square size on the canvas'; // 146 chars
  const fitted = decisions.fitStickyFontSize({ text: long, ...box });
  assert.ok(fitted.fontSize < 14, `long text stayed at ${fitted.fontSize}px`);
  assert.ok(fitted.fontSize >= decisions.STICKY_FONT_MIN);
  // the returned layout actually fits the padded box
  const availH = 110 - decisions.STICKY_TEXT_PAD * 2;
  assert.ok(fitted.textHeight <= availH, `layout ${fitted.textHeight} overflows ${availH}`);
  assert.ok(fitted.lines.length > 1, 'long text must wrap');
  // monotone: more text never yields a bigger font; a bigger box never a smaller one
  const mid = decisions.fitStickyFontSize({ text: long.slice(0, 60), ...box });
  assert.ok(mid.fontSize >= fitted.fontSize);
  assert.ok(decisions.fitStickyFontSize({ text: long, width: 220, height: 220, measure }).fontSize >= fitted.fontSize);
});

test('fitStickyFontSize hard-breaks a word wider than the note and never goes below the floor', () => {
  const word = 'x'.repeat(120);
  const fitted = decisions.fitStickyFontSize({ text: word, width: 110, height: 110, measure });
  assert.ok(fitted.lines.length > 1, 'an unbroken 120-char word must be split');
  const avail = 110 - decisions.STICKY_TEXT_PAD * 2;
  for (const line of fitted.lines) {
    assert.ok(measure(line, fitted.fontSize) <= avail + 0.001, `line "${line}" overflows`);
  }
  const absurd = decisions.fitStickyFontSize({ text: 'y'.repeat(4000), width: 110, height: 110, measure });
  assert.equal(absurd.fontSize, decisions.STICKY_FONT_MIN); // floor, never zero
});

test('fitStickyLabels: auto mode shrinks the label and restores the grown face; pinned pins', () => {
  const face = {
    id: 'f', type: 'rectangle', x: 0, y: 0, width: 110, height: 150, angle: 0,
    customData: { sticky: { w: 110, h: 110 } },
    boundElements: [{ id: 't', type: 'text' }],
  };
  const label = {
    id: 't', type: 'text', containerId: 'f', x: 5, y: 5, width: 100, height: 140,
    fontSize: 20, lineHeight: 1.25,
    text: 'a long note that overflowed and grew the container which Miro never does',
    originalText: 'a long note that overflowed and grew the container which Miro never does',
  };
  const out = decisions.fitStickyLabels([face, label], measure);
  assert.equal(out.changed, true);
  const nf = out.elements.find((e) => e.id === 'f');
  const nt = out.elements.find((e) => e.id === 't');
  assert.equal(nf.height, 110); // the note NEVER grows: height restored
  assert.ok(nt.fontSize < 20, `font did not shrink (${nt.fontSize})`);
  assert.ok(nt.text.includes('\n'), 'label rewrapped');
  assert.ok(nt.height <= 110 - decisions.STICKY_TEXT_PAD * 2 + 0.001);
  // centred in the restored face
  assert.ok(Math.abs((nt.x + nt.width / 2) - (nf.x + nf.width / 2)) < 1);
  assert.ok(Math.abs((nt.y + nt.height / 2) - (nf.y + nf.height / 2)) < 1);
  // idempotent: a second pass is quiet (no churn from onChange)
  assert.equal(decisions.fitStickyLabels(out.elements, measure).changed, false);

  // pinned mode: the numeric size wins and the face is left to Excalidraw
  const pinnedFace = { ...face, customData: { sticky: { w: 110, h: 110, font: 14 } } };
  const pinned = decisions.fitStickyLabels([pinnedFace, { ...label, fontSize: 9 }], measure);
  assert.equal(pinned.elements.find((e) => e.id === 't').fontSize, 14);
  assert.equal(pinned.elements.find((e) => e.id === 'f').height, 150); // growth allowed when pinned
});

test('fitStickyLabels: user resizes are adopted, legacy stickies are untouched, moves are quiet', () => {
  const label = (over = {}) => ({
    id: 't', type: 'text', containerId: 'f', x: 5, y: 5, width: 60, height: 20,
    fontSize: 28, lineHeight: 1.25, text: 'hi', originalText: 'hi', ...over,
  });
  // corner resize (width changed) re-seats the intent instead of snapping back
  const resized = { id: 'f', type: 'rectangle', x: 0, y: 0, width: 220, height: 220, angle: 0, customData: { sticky: { w: 110, h: 110 } }, boundElements: [{ id: 't', type: 'text' }] };
  const out = decisions.fitStickyLabels([resized, label()], measure);
  const nf = out.elements.find((e) => e.id === 'f');
  assert.deepEqual(nf.customData.sticky, { w: 220, h: 220 });
  assert.equal(nf.height, 220); // no snap-back
  // a legacy face (no sticky tag, only a shadow naming it) is left entirely alone
  const legacyFace = { id: 'f', type: 'rectangle', x: 0, y: 0, width: 180, height: 240, angle: 0, boundElements: [{ id: 't', type: 'text' }] };
  const shadow = { id: 's', type: 'rectangle', locked: true, customData: { stickyShadow: true, faceId: 'f' } };
  assert.equal(decisions.fitStickyLabels([shadow, legacyFace, label({ fontSize: 20 })], measure).changed, false);
  // a pure move never churns
  const still = { id: 'f', type: 'rectangle', x: 500, y: 700, width: 110, height: 110, angle: 0, customData: { sticky: { w: 110, h: 110 } }, boundElements: [{ id: 't', type: 'text' }] };
  const centred = label({ x: 500 + (110 - 60) / 2, y: 700 + (110 - 20) / 2, height: 35, width: 33.6 });
  const fit1 = decisions.fitStickyLabels([still, centred], measure);
  assert.equal(decisions.fitStickyLabels(fit1.elements, measure).changed, false);
});

test('selectionStickyFace answers only for a lone sticky face', () => {
  const face = { id: 'f', type: 'rectangle', customData: { sticky: { w: 110, h: 110 } } };
  const shadow = { id: 's', type: 'rectangle', locked: true, customData: { stickyShadow: true, faceId: 'g' } };
  const legacy = { id: 'g', type: 'rectangle' };
  const rect = { id: 'r', type: 'rectangle' };
  const els = [face, shadow, legacy, rect];
  assert.equal(decisions.selectionStickyFace(els, new Set(['f'])), 'f');
  assert.equal(decisions.selectionStickyFace(els, new Set(['g'])), 'g'); // legacy: named by a shadow
  assert.equal(decisions.selectionStickyFace(els, new Set(['r'])), null);
  assert.equal(decisions.selectionStickyFace(els, new Set(['f', 'r'])), null); // not alone
  assert.equal(decisions.selectionStickyFace(els, new Set()), null);
});

// -------------------------------------------------------------- wheel zooming

test('wheelZoomPlan zooms at the cursor: the scene point under it stays put (finding 69)', () => {
  const app = { zoom: { value: 1 }, scrollX: -40, scrollY: 25, offsetLeft: 300, offsetTop: 50 };
  const clientX = 700;
  const clientY = 420;
  const sceneBefore = { x: (clientX - 300) / 1 - app.scrollX, y: (clientY - 50) / 1 - app.scrollY };
  const plan = decisions.wheelZoomPlan(app, clientX, clientY, -240);
  assert.ok(Math.abs(plan.zoom - 1.12) < 0.005, `one Miro notch is ~1.12x, got ${plan.zoom}`);
  const sceneAfter = { x: (clientX - 300) / plan.zoom - plan.scrollX, y: (clientY - 50) / plan.zoom - plan.scrollY };
  assert.ok(Math.abs(sceneAfter.x - sceneBefore.x) < 0.001, 'cursor anchor drifted in x');
  assert.ok(Math.abs(sceneAfter.y - sceneBefore.y) < 0.001, 'cursor anchor drifted in y');
  // wheel down zooms out; extremes clamp to Excalidraw's own limits
  assert.ok(decisions.wheelZoomPlan(app, clientX, clientY, 240).zoom < 1);
  assert.equal(decisions.wheelZoomPlan({ ...app, zoom: { value: 0.1 } }, 0, 0, 9999).zoom, 0.1);
  assert.equal(decisions.wheelZoomPlan({ ...app, zoom: { value: 30 } }, 0, 0, -9999).zoom, 30);
});

test('zoomAtPoint holds its anchor for the preset jumps (50/100/200/400)', () => {
  const app = { zoom: { value: 0.7 }, scrollX: 120, scrollY: -60, offsetLeft: 0, offsetTop: 0, width: 1200, height: 800 };
  const before = { x: 600 / 0.7 - 120, y: 400 / 0.7 + 60 };
  for (const level of [0.5, 1, 2, 4]) {
    const plan = decisions.zoomAtPoint(app, level, 600, 400);
    assert.equal(plan.zoom, level);
    assert.ok(Math.abs((600 / level - plan.scrollX) - before.x) < 0.001);
    assert.ok(Math.abs((400 / level - plan.scrollY) - before.y) < 0.001);
  }
});

// ------------------------------------------------------------------- minimap

test('minimapPlan maps every element and the viewport into the card; jump centres (finding 71)', () => {
  const app = { zoom: { value: 1 }, scrollX: 0, scrollY: 0, width: 1000, height: 800 };
  const els = [
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 },
    { id: 'b', type: 'ellipse', x: 2000, y: 1500, width: 300, height: 200 },
    { id: 's', type: 'rectangle', locked: true, customData: { stickyShadow: true, faceId: 'a' }, x: 0, y: 8, width: 200, height: 100 },
    { id: 'gone', type: 'rectangle', isDeleted: true, x: -9999, y: -9999, width: 10, height: 10 },
  ];
  const plan = decisions.minimapPlan(els, app);
  assert.equal(plan.boxes.length, 2); // shadows and deleted never render
  const inCard = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= decisions.MINIMAP_W && r.y + r.h <= decisions.MINIMAP_H;
  for (const box of plan.boxes) assert.ok(inCard(box), `box ${JSON.stringify(box)} outside the card`);
  assert.ok(inCard(plan.view), 'viewport rect must always be inside the card');
  // click the far element's box centre: the viewport must centre on it
  const b = plan.boxes[1];
  const jump = decisions.minimapJump(plan, b.x + b.w / 2, b.y + b.h / 2, app);
  const centreScene = { x: 1000 / 2 - jump.scrollX, y: 800 / 2 - jump.scrollY };
  assert.ok(Math.abs(centreScene.x - 2150) < 2, `centre x ${centreScene.x} not on the element`);
  assert.ok(Math.abs(centreScene.y - 1600) < 2, `centre y ${centreScene.y} not on the element`);
});

test('minimapPlan of an empty board still shows the viewport rect', () => {
  const app = { zoom: { value: 2 }, scrollX: -500, scrollY: 300, width: 1000, height: 600 };
  const plan = decisions.minimapPlan([], app);
  assert.equal(plan.boxes.length, 0);
  assert.ok(plan.view.w > 0 && plan.view.h > 0);
});

// -------------------------------------------------------------------- z-order

test('reorderElements: PgUp family moves the selection through the stack (finding 57)', () => {
  const els = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(decisions.reorderElements(els, ['a'], 'front').map((e) => e.id), ['b', 'c', 'a']);
  assert.deepEqual(decisions.reorderElements(els, ['c'], 'back').map((e) => e.id), ['c', 'a', 'b']);
  assert.deepEqual(decisions.reorderElements(els, ['a'], 'forward').map((e) => e.id), ['b', 'a', 'c']);
  assert.deepEqual(decisions.reorderElements(els, ['c'], 'backward').map((e) => e.id), ['a', 'c', 'b']);
  // moved elements get index:null so Excalidraw reindexes them by array position
  const moved = decisions.reorderElements(els, ['a'], 'front');
  assert.equal(moved[2].index, null);
  // already at the top: no-op answers null so the caller skips the update
  assert.equal(decisions.reorderElements(els, ['c'], 'front'), null);
  assert.equal(decisions.reorderElements(els, ['a'], 'back'), null);
});

test('reorderElements carries a sticky\'s shadows and a container\'s bound text along', () => {
  const els = [
    { id: 'shadow', locked: true, customData: { stickyShadow: true, faceId: 'face' } },
    { id: 'face', boundElements: [{ id: 'label', type: 'text' }] },
    { id: 'label', type: 'text', containerId: 'face' },
    { id: 'other' },
  ];
  const out = decisions.reorderElements(els, ['face'], 'front');
  assert.deepEqual(out.map((e) => e.id), ['other', 'shadow', 'face', 'label']);
});

// ------------------------------------------------------------------- dot grid

test('dotGridStyle tracks pan and zoom so the dots stay glued to the scene (finding 72)', () => {
  const still = decisions.dotGridStyle({ gridSize: 20, zoom: 1, scrollX: 0, scrollY: 0 });
  assert.equal(still.backgroundSize, '20px 20px');
  assert.equal(still.backgroundPosition, '0px 0px');
  const panned = decisions.dotGridStyle({ gridSize: 20, zoom: 1, scrollX: -130, scrollY: 45 });
  assert.equal(panned.backgroundPosition, '10px 5px'); // modular, never negative
  const zoomed = decisions.dotGridStyle({ gridSize: 20, zoom: 2, scrollX: 0, scrollY: 0 });
  assert.equal(zoomed.backgroundSize, '40px 40px');
  assert.ok(still.backgroundImage.includes('radial-gradient'));
  // zoomed far out the cells collapse; the dot field fades out instead of becoming noise
  assert.equal(decisions.dotGridStyle({ gridSize: 20, zoom: 0.4 }).backgroundImage, 'none');
});
