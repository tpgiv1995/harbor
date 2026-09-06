'use strict';

// Wave C: the contextual toolbar above the selection and the popovers it opens
// (Miro catalog findings 26, 46-48, 53, 56, 57, 76). Every pure decision the card
// makes lives in board-files.cjs and is pinned here.

const assert = require('node:assert/strict');
const test = require('node:test');
const decisions = require('../../src/renderer/whiteboard/board-files.cjs');

const {
  PALETTE_SECTIONS, BRAND_COLORS, ALL_COLORS, normalizeHex,
  selectionSceneBox, sceneBoxToClient, toolbarPlacement,
  BORDER_STYLES, selectionStrokeStyle,
  setCornerRadius, selectionCornerRadius, selectionRadiusEditable,
  SWITCH_TYPE_KEYS, selectionShapeKey, isSwitchable, switchShapeType, shapeDef,
  copySelectionStyle, pasteSelectionStyle,
  BOARD_FONTS, TEXT_ALIGNS, selectionTextStyle, setTextProp, wrapTextToWidth, layoutBoundText,
  ARRANGE_OPS,
} = decisions;

// A crude but monotone glyph measure: every character is half the font size wide.
const measure = (text, size) => String(text).length * size * 0.5;

const rect = (over = {}) => ({
  id: 'r1', type: 'rectangle', x: 100, y: 100, width: 120, height: 80,
  strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100,
  roundness: null, boundElements: [], isDeleted: false, ...over,
});

const text = (over = {}) => ({
  id: 't1', type: 'text', x: 120, y: 130, width: 60, height: 25,
  text: 'Hello', originalText: 'Hello', fontSize: 20, fontFamily: 6,
  textAlign: 'center', verticalAlign: 'middle', lineHeight: 1.25,
  strokeColor: '#1a1a1a', containerId: null, isDeleted: false, ...over,
});

test('the colour popover is Miro two sections, Brand then All, with the catalog hexes', () => {
  assert.deepEqual(PALETTE_SECTIONS.map((s) => s.label), ['Brand colors', 'All colors']);
  assert.equal(BRAND_COLORS.length, 18);
  assert.equal(ALL_COLORS.length, 23);
  // Spot checks straight off catalog finding 26.
  assert.equal(BRAND_COLORS.find((c) => c.label === 'Luminous').hex, '#437ffe');
  assert.equal(BRAND_COLORS.find((c) => c.label === 'Gold Leaf').hex, '#d4a537');
  assert.equal(ALL_COLORS.find((c) => c.label === 'Dark Violet').hex, '#6631d7');
  assert.equal(ALL_COLORS.find((c) => c.label === 'Magenta').hex, '#bd0a0a');
  assert.equal(ALL_COLORS[0].hex, '#fff6b6');
  assert.equal(ALL_COLORS.at(-1).hex, '#6631d7');
  // Every swatch is a real normalized hex and every key is unique.
  for (const section of PALETTE_SECTIONS) {
    for (const color of section.colors) {
      assert.equal(normalizeHex(color.hex), color.hex, `${color.key} is not a normalized hex`);
      assert.ok(color.label, `${color.key} has no label`);
    }
  }
  const keys = PALETTE_SECTIONS.flatMap((s) => s.colors.map((c) => c.key));
  assert.equal(new Set(keys).size, keys.length);
});

test('the selection box ignores sticky shadows and deleted elements', () => {
  const elements = [
    rect({ id: 'a', x: 100, y: 100, width: 100, height: 50 }),
    rect({ id: 'shadow', x: 100, y: 108, width: 100, height: 50, customData: { stickyShadow: true, faceId: 'a' } }),
    rect({ id: 'b', x: 300, y: 60, width: 40, height: 40 }),
    rect({ id: 'gone', x: 0, y: 0, width: 10, height: 10, isDeleted: true }),
  ];
  const ids = new Set(['a', 'shadow', 'b', 'gone']);
  assert.deepEqual(selectionSceneBox(elements, ids), { x: 100, y: 60, width: 240, height: 90 });
  assert.equal(selectionSceneBox(elements, new Set(['nope'])), null);
  // The shadow alone measures nothing, which is what keeps a sticky's box its face.
  assert.equal(selectionSceneBox(elements, new Set(['shadow'])), null);
});

test('the selection box maps to client space through zoom, scroll and offset', () => {
  const client = sceneBoxToClient({ x: 100, y: 50, width: 200, height: 100 }, {
    zoom: { value: 2 }, scrollX: 10, scrollY: -20, offsetLeft: 30, offsetTop: 40,
  });
  assert.deepEqual(client, { left: 250, top: 100, width: 400, height: 200, right: 650, bottom: 300 });
});

test('the toolbar centres above the selection and flips below only when it must', () => {
  const size = { width: 300, height: 40 };
  const viewport = { width: 1200, height: 800 };
  const above = toolbarPlacement({ box: { left: 400, top: 300, width: 200, height: 100, bottom: 400 }, size, viewport });
  assert.deepEqual(above, { left: 350, top: 248, above: true });

  // No room above: the card flips below the selection rather than off the top edge.
  const below = toolbarPlacement({ box: { left: 400, top: 10, width: 200, height: 100, bottom: 110 }, size, viewport });
  assert.equal(below.above, false);
  assert.equal(below.top, 122);

  // Clamped away from the tool rail on the left and from the right edge.
  const railed = toolbarPlacement({ box: { left: 0, top: 400, width: 40, height: 40, bottom: 440 }, size, viewport, minLeft: 70 });
  assert.equal(railed.left, 70);
  const edge = toolbarPlacement({ box: { left: 1180, top: 400, width: 20, height: 40, bottom: 440 }, size, viewport, minLeft: 70 });
  assert.equal(edge.left, 892);
  assert.equal(toolbarPlacement({ box: null, size, viewport }), null);

  // The viewport is the CANVAS, not the window: a card near the top of an inset canvas
  // flips below rather than riding up over the app chrome above it.
  const inset = { left: 300, top: 180, width: 900, height: 620 };
  const high = toolbarPlacement({ box: { left: 500, top: 190, width: 100, height: 60, bottom: 250 }, size, viewport: inset, minLeft: 370 });
  assert.equal(high.above, false);
  assert.equal(high.top, 262);
  const leftEdge = toolbarPlacement({ box: { left: 305, top: 500, width: 40, height: 40, bottom: 540 }, size, viewport: inset, minLeft: 370 });
  assert.equal(leftEdge.left, 370, 'clamped clear of the rail inside the canvas');
  const rightEdge = toolbarPlacement({ box: { left: 1180, top: 500, width: 20, height: 40, bottom: 540 }, size, viewport: inset, minLeft: 370 });
  assert.equal(rightEdge.left, 892, 'clamped to the canvas right edge, not the window');
});

test('the border popover reads back a shared stroke style and refuses to guess a mixed one', () => {
  assert.deepEqual(BORDER_STYLES.map((s) => s.key), ['solid', 'dashed', 'dotted']);
  const elements = [rect({ id: 'a' }), rect({ id: 'b', strokeStyle: 'dashed' }), rect({ id: 'c', strokeStyle: undefined })];
  assert.equal(selectionStrokeStyle(elements, new Set(['b'])), 'dashed');
  assert.equal(selectionStrokeStyle(elements, new Set(['a', 'c'])), 'solid', 'an unset strokeStyle renders solid');
  assert.equal(selectionStrokeStyle(elements, new Set(['a', 'b'])), null);
  assert.equal(selectionStrokeStyle(elements, new Set([])), null);
});

test('corner radius is a real number on a rectangle and honest about the shapes that cannot carry one', () => {
  const elements = [rect({ id: 'a' }), rect({ id: 'e', type: 'ellipse' })];
  const rounded = setCornerRadius(elements, new Set(['a']), 24);
  assert.deepEqual(rounded[0].roundness, { type: 3, value: 24 });
  assert.equal(selectionCornerRadius(rounded, new Set(['a'])), 24);

  // An ellipse only has Excalidraw's proportional rounding, which carries no number,
  // so it takes the proportional form and the numeric control is hidden for it.
  const roundedEllipse = setCornerRadius(elements, new Set(['e']), 24);
  assert.deepEqual(roundedEllipse[1].roundness, { type: 2 });
  assert.equal(selectionRadiusEditable(elements, new Set(['a'])), true);
  assert.equal(selectionRadiusEditable(elements, new Set(['a', 'e'])), false);

  // Zero is sharp, and sharp reads back as zero.
  const sharp = setCornerRadius(rounded, new Set(['a']), 0);
  assert.equal(sharp[0].roundness, null);
  assert.equal(selectionCornerRadius(sharp, new Set(['a'])), 0);
  // A roundness with no value is Excalidraw's own 32px default.
  assert.equal(selectionCornerRadius([rect({ roundness: { type: 3 } })], new Set(['r1'])), 32);
  // Disagreeing radii answer null rather than picking one.
  assert.equal(selectionCornerRadius(rounded, new Set(['a', 'e'])), null);
});

test('switch type converts in place: same id, same box, same bindings', () => {
  const arrow = {
    id: 'arr', type: 'arrow', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, 10]],
    startBinding: { elementId: 'r1', focus: 0, gap: 4 }, endBinding: null, isDeleted: false,
  };
  const elements = [rect({ boundElements: [{ type: 'arrow', id: 'arr' }] }), arrow];
  const next = switchShapeType(elements, new Set(['r1']), 'ellipse');
  const converted = next.find((el) => el.id === 'r1');
  assert.equal(converted.type, 'ellipse');
  assert.equal(converted.x, 100);
  assert.equal(converted.width, 120);
  assert.equal(converted.backgroundColor, '#a5d8ff');
  assert.equal(next.indexOf(converted), 0, 'the stack position never moves');
  assert.deepEqual(next.find((el) => el.id === 'arr').startBinding, arrow.startBinding);
  assert.deepEqual(converted.boundElements, [{ type: 'arrow', id: 'arr' }]);

  // "rounded" is the rectangle tool with a roundness, exactly as the rail draws it.
  const roundedNext = switchShapeType(elements, new Set(['r1']), 'rounded');
  assert.equal(roundedNext[0].type, 'rectangle');
  assert.deepEqual(roundedNext[0].roundness, { type: 3 });
});

test('switch type moves a label across the container / poly divide', () => {
  const elements = [
    rect({ boundElements: [{ type: 'text', id: 't1' }] }),
    text({ containerId: 'r1' }),
  ];
  const toPoly = switchShapeType(elements, new Set(['r1']), 'triangle');
  const poly = toPoly.find((el) => el.id === 'r1');
  const label = toPoly.find((el) => el.id === 't1');
  const def = shapeDef('triangle');
  assert.equal(poly.type, 'line');
  assert.equal(poly.customData.polyShape, 'triangle');
  assert.equal(poly.points.length, def.points.length + 1, 'the loop closes on its first vertex');
  assert.deepEqual(poly.points[0], poly.points.at(-1));
  assert.deepEqual(poly.boundElements, [], 'Excalidraw never binds text to a line');
  assert.equal(label.containerId, null);
  assert.equal(label.customData.labelFor, 'r1');
  assert.equal(label.x, 100 + (120 - 60) / 2, 'the freed label centres on the shape');

  // And back: the standalone label becomes real bound text again.
  const backToRect = switchShapeType(toPoly, new Set(['r1']), 'rectangle');
  const container = backToRect.find((el) => el.id === 'r1');
  const bound = backToRect.find((el) => el.id === 't1');
  assert.equal(container.type, 'rectangle');
  assert.equal(container.points, undefined);
  assert.equal(container.customData, undefined, 'the polyShape tag goes with the line');
  assert.deepEqual(container.boundElements, [{ type: 'text', id: 't1' }]);
  assert.equal(bound.containerId, 'r1');
  assert.equal(bound.customData, undefined);
});

test('a shape converted to a poly and back lands exactly where it started', () => {
  // A `line` stores points RELATIVE to x/y and rebases them onto points[0], so its x is
  // not its left edge. Reading a poly's box off x/width would jump the shape by half its
  // width on the way back (drive-caught); the absolute bounds are the only honest box.
  const bounds = (el) => {
    if (!el.points || !el.points.length) return { x: el.x, y: el.y, w: el.width, h: el.height };
    const xs = el.points.map((p) => p[0]);
    const ys = el.points.map((p) => p[1]);
    return {
      x: el.x + Math.min(...xs), y: el.y + Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
    };
  };
  const box = { x: 200, y: 140, w: 220, h: 120 };
  const start = rect({ x: box.x, y: box.y, width: box.w, height: box.h });
  for (const key of SWITCH_TYPE_KEYS.concat('cross')) {
    const def = shapeDef(key);
    if (def.kind !== 'poly') continue;
    const poly = switchShapeType([start], new Set(['r1']), key)[0];
    assert.deepEqual(poly.points[0], [0, 0], `${key} is rebased onto its own origin`);
    const polyBox = bounds(poly);
    // Inscribed, never translated: a star does not fill its box, but it never leaves it.
    assert.ok(polyBox.x >= box.x - 1 && polyBox.y >= box.y - 1
      && polyBox.x + polyBox.w <= box.x + box.w + 1 && polyBox.y + polyBox.h <= box.y + box.h + 1,
    `${key} left the box it was drawn in: ${JSON.stringify(polyBox)}`);
    // Converting back takes the poly's own bounds, exactly.
    const back = switchShapeType([poly], new Set(['r1']), 'rectangle')[0];
    assert.deepEqual(bounds(back), polyBox, `${key} did not come back where it went`);
  }
  // A shape that fills its whole box round-trips pixel for pixel.
  for (const key of ['triangle', 'parallelogram', 'cross', 'speech']) {
    const poly = switchShapeType([start], new Set(['r1']), key)[0];
    const back = switchShapeType([poly], new Set(['r1']), 'rectangle')[0];
    assert.deepEqual(bounds(back), box, `${key} does not round-trip`);
  }
});

test('switch type knows what it may convert, and what the toolbar shows', () => {
  const sticky = rect({ id: 's1', customData: { sticky: { w: 110, h: 110 } } });
  const shadow = rect({ id: 'sh', customData: { stickyShadow: true, faceId: 's1' } });
  assert.equal(isSwitchable(rect()), true);
  assert.equal(isSwitchable(sticky), false, 'a sticky keeps its square shadow bands');
  assert.equal(isSwitchable(shadow), false);
  assert.equal(isSwitchable({ ...rect(), type: 'arrow' }), false);
  // The whole grid resolves to real shapes.
  assert.equal(SWITCH_TYPE_KEYS.length, 12);
  assert.ok(SWITCH_TYPE_KEYS.every((key) => shapeDef(key)));
  // A converted sticky stays a sticky.
  assert.deepEqual(switchShapeType([sticky], new Set(['s1']), 'ellipse'), [sticky]);

  assert.equal(selectionShapeKey([rect()], new Set(['r1'])), 'rectangle');
  assert.equal(selectionShapeKey([rect({ roundness: { type: 3 } })], new Set(['r1'])), 'rounded');
  assert.equal(selectionShapeKey([rect({ type: 'diamond' })], new Set(['r1'])), 'diamond');
  const star = { ...rect(), type: 'line', customData: { polyShape: 'star' } };
  assert.equal(selectionShapeKey([star], new Set(['r1'])), 'star');
  assert.equal(selectionShapeKey([rect({ id: 'a' }), rect({ id: 'b' })], new Set(['a', 'b'])), null);
});

test('copy style carries the paint and never the geometry', () => {
  const source = rect({
    id: 'src', backgroundColor: '#ffdc4a', strokeColor: '#bd0a0a', strokeWidth: 4,
    strokeStyle: 'dashed', opacity: 60, roundness: { type: 3, value: 18 },
    boundElements: [{ type: 'text', id: 'st' }],
  });
  const sourceText = text({ id: 'st', containerId: 'src', fontSize: 28, textAlign: 'right', strokeColor: '#067429' });
  const target = rect({ id: 'dst', x: 900, y: 900, width: 40, height: 40 });
  const elements = [source, sourceText, target];

  const style = copySelectionStyle(elements, new Set(['src']));
  assert.equal(style.shape.backgroundColor, '#ffdc4a');
  assert.equal(style.shape.strokeStyle, 'dashed');
  assert.equal(style.radius, 18);
  assert.equal(style.text.fontSize, 28);
  assert.equal(style.text.textAlign, 'right');
  for (const forbidden of ['x', 'y', 'width', 'height', 'id', 'points', 'boundElements']) {
    assert.equal(style.shape[forbidden], undefined, `${forbidden} is geometry, not paint`);
  }

  const pasted = pasteSelectionStyle(elements, new Set(['dst']), style);
  const painted = pasted.find((el) => el.id === 'dst');
  assert.equal(painted.backgroundColor, '#ffdc4a');
  assert.equal(painted.strokeColor, '#bd0a0a');
  assert.equal(painted.strokeWidth, 4);
  assert.equal(painted.opacity, 60);
  assert.deepEqual(painted.roundness, { type: 3, value: 18 });
  assert.equal(painted.x, 900, 'paste style never moves anything');
  assert.equal(painted.width, 40);

  // An adaptive radius means nothing on an ellipse, so it is re-derived for the target.
  const ellipse = [rect({ id: 'el', type: 'ellipse' })];
  const onEllipse = pasteSelectionStyle(ellipse, new Set(['el']), style);
  assert.deepEqual(onEllipse[0].roundness, { type: 2 });

  // A sticky's shadow band keeps its own faint paint.
  const shadow = rect({ id: 'sh', opacity: 5, customData: { stickyShadow: true, faceId: 'dst' } });
  const withShadow = pasteSelectionStyle([shadow], new Set(['sh']), style);
  assert.deepEqual(withShadow[0], shadow);
  assert.equal(copySelectionStyle(elements, new Set(['nothing'])), null);
  assert.deepEqual(pasteSelectionStyle(elements, new Set(['dst']), null), elements);
});

test('typography reads and writes every text the selection carries', () => {
  const elements = [
    rect({ boundElements: [{ type: 'text', id: 't1' }] }),
    text({ containerId: 'r1' }),
    text({ id: 't2', fontSize: 12, fontFamily: 2, textAlign: 'left' }),
  ];
  // Selecting the CONTAINER reads its bound label's typography.
  assert.deepEqual(selectionTextStyle(elements, new Set(['r1'])), { fontFamily: 6, fontSize: 20, textAlign: 'center' });
  assert.deepEqual(selectionTextStyle(elements, new Set(['r1', 't2'])), { fontFamily: null, fontSize: null, textAlign: null });
  assert.equal(selectionTextStyle(elements, new Set(['nope'])), null);

  // Every font offered is one Excalidraw actually ships, and the alignments are Miro's three.
  assert.deepEqual(TEXT_ALIGNS.map((a) => a.key), ['left', 'center', 'right']);
  assert.ok(BOARD_FONTS.length >= 5);
  assert.equal(new Set(BOARD_FONTS.map((f) => f.family)).size, BOARD_FONTS.length);

  // A font-size write re-lays-out a bound label, because Excalidraw only re-measures
  // through its own editing actions and would otherwise keep the old box.
  const bigger = setTextProp(elements, new Set(['r1']), 'fontSize', 40, measure);
  const label = bigger.find((el) => el.id === 't1');
  assert.equal(label.fontSize, 40);
  assert.equal(label.height, 40 * 1.25);
  assert.equal(label.width, measure('Hello', 40));
  assert.equal(label.y, 100 + (80 - 50) / 2, 'a middle-aligned label recentres');
  assert.equal(bigger.find((el) => el.id === 't2').fontSize, 12, 'an unselected text is untouched');
});

test('a sticky label is left to the autosize pass, which owns its size', () => {
  const elements = [
    rect({ id: 's1', customData: { sticky: { w: 120, h: 80 } }, boundElements: [{ type: 'text', id: 't1' }] }),
    text({ containerId: 's1' }),
  ];
  const next = setTextProp(elements, new Set(['s1']), 'fontFamily', 7, measure);
  const label = next.find((el) => el.id === 't1');
  assert.equal(label.fontFamily, 7);
  assert.equal(label.width, 60, 'the sticky fit pass, not this write, decides the box');
  assert.equal(label.x, 120);
});

test('the bound-text layout wraps to the container and honours its alignment', () => {
  const container = { x: 0, y: 0, width: 60, height: 60 };
  const laid = layoutBoundText(text({ text: 'one two three four', originalText: 'one two three four', fontSize: 10, textAlign: 'left', verticalAlign: 'top' }), container, measure);
  assert.ok(laid.text.includes('\n'), 'long text wraps to the container width');
  assert.equal(laid.x, 5, 'a left-aligned label sits at the padding');
  assert.equal(laid.y, 5);
  assert.deepEqual(wrapTextToWidth('aaaa bb', 10, 30, measure), ['aaaa', 'bb']);
  // A word too wide for the line is hard-broken by characters, the way Excalidraw wraps.
  assert.deepEqual(wrapTextToWidth('aaaaaaaa', 10, 30, measure), ['aaaaaa', 'aa']);
});

test('Arrange is Miro z-order in Miro order, with Miro shortcuts', () => {
  assert.deepEqual(ARRANGE_OPS.map((op) => op.key), ['forward', 'front', 'backward', 'back']);
  assert.deepEqual(ARRANGE_OPS.map((op) => op.hint), ['Shift+PgUp', 'PgUp', 'Shift+PgDn', 'PgDn']);
  assert.deepEqual(ARRANGE_OPS.map((op) => op.label), ['Bring forward', 'Bring to front', 'Send backward', 'Send to back']);
  // and every op is one reorderElements actually implements
  const elements = [rect({ id: 'a' }), rect({ id: 'b' })];
  for (const op of ARRANGE_OPS) {
    const moved = decisions.reorderElements(elements, new Set(['a']), op.key);
    assert.ok(moved === null || Array.isArray(moved), `${op.key} is not a real z-order op`);
  }
  assert.deepEqual(decisions.reorderElements(elements, new Set(['a']), 'front').map((el) => el.id), ['b', 'a']);
});
