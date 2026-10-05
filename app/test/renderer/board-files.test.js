'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const decisions = require('../../src/renderer/whiteboard/board-files.cjs');

test('board filenames use stable kebab slugs and collision suffixes', () => {
  assert.equal(decisions.boardSlug('  Q&A / Launch Plan  '), 'q-and-a-launch-plan');
  assert.equal(decisions.boardSlug('Caf\u00e9 Notes'), 'cafe-notes');
  assert.equal(decisions.boardSlug('***'), 'untitled-board');
  assert.equal(decisions.availableBoardId('Launch', ['launch', 'launch-2']), 'launch-3');
});

test('boards display newest first with a stable name tie break', () => {
  const boards = decisions.orderBoards([
    { id: 'b', name: 'Beta', updatedAt: '2026-08-24T10:00:00.000Z' },
    { id: 'c', name: 'Charlie', updatedAt: '2026-08-25T10:00:00.000Z' },
    { id: 'a', name: 'Alpha', updatedAt: '2026-08-24T10:00:00.000Z' },
  ]);
  assert.deepEqual(boards.map(({ id }) => id), ['c', 'a', 'b']);
});

test('debounce waits to 1200ms and flushes immediately when leaving', () => {
  assert.deepEqual(decisions.debouncePlan({ dirty: false }), { action: 'none', waitMs: 0 });
  assert.deepEqual(decisions.debouncePlan({ dirty: true, elapsedMs: 350 }), { action: 'wait', waitMs: 850 });
  assert.deepEqual(decisions.debouncePlan({ dirty: true, elapsedMs: 1200 }), { action: 'save', waitMs: 0 });
  assert.deepEqual(decisions.debouncePlan({ dirty: true, elapsedMs: 5, flush: true }), { action: 'save', waitMs: 0 });
});

test("sticky palette is Miro's full grid of distinct, fully-specified colors", () => {
  assert.equal(decisions.STICKY_COLORS.length, 16); // Miro's 2-column colour grid
  const keys = new Set(decisions.STICKY_COLORS.map((color) => color.key));
  assert.equal(keys.size, 16);
  for (const color of decisions.STICKY_COLORS) {
    for (const field of ['key', 'label', 'bg', 'text']) {
      assert.match(String(color[field]), /\S/, `${field} missing on ${color.key}`);
    }
    assert.match(color.bg, /^#[0-9a-f]{6}$/i, `${color.key} bg is not a hex colour`);
  }
  assert.ok(decisions.STICKY_COLORS.some((color) => color.key === decisions.DEFAULT_STICKY));
  assert.equal(decisions.stickyColor('yellow').bg, '#ffe86d'); // Miro's default yellow
});

test('a sticky is shadow bands under a face; the face carries the colour and binds a label', () => {
  const created = decisions.stickyNoteSkeleton({ color: 'dark-green', x: 12.4, y: 30.6 });
  const face = created[created.length - 1];
  const shadow = created[0];
  // the coloured face
  assert.equal(face.type, 'rectangle');
  assert.equal(face.backgroundColor, '#6ae08d'); // Miro's Dark Green, sampled live
  assert.equal(face.strokeColor, 'transparent'); // flat, borderless, Miro-style
  assert.equal(face.roundness, null); // near-square corners, not Excalidraw's round button
  assert.equal(face.width, decisions.STICKY_SIZE);
  assert.equal(face.roughness, 0);
  assert.equal(face.x, 12); // rounded to whole scene units
  assert.equal(face.label, undefined);
  // the soft bottom shadow behind it (what makes it read like a real sticky note)
  assert.ok(decisions.isStickyShadow(shadow), 'the first element is not the marked shadow');
  assert.ok(shadow.y > face.y, 'shadow is not offset below the face');
  assert.equal(shadow.x, face.x); // bottom-only since the Miro diff: no side shadow
  assert.ok(shadow.opacity > 0 && shadow.opacity < 30, `shadow opacity ${shadow.opacity} out of soft range`);
  assert.equal(shadow.roundness, null);

  const withText = decisions.stickyNoteSkeleton({ color: 'blue', text: 'ship it' });
  const textFace = withText[withText.length - 1];
  assert.equal(textFace.label.text, 'ship it'); // the face (last element) carries the label
  assert.equal(textFace.label.verticalAlign, 'center');

  const fallbackFace = decisions.stickyNoteSkeleton({ color: 'does-not-exist' }).at(-1);
  assert.equal(fallbackFace.backgroundColor, decisions.STICKY_COLORS[0].bg);

  // recolouring a selected sticky recolours only the face, never its shadow
  const recoloured = decisions.recolorElements([{ ...shadow, id: 's' }, { ...face, id: 'f' }], ['s', 'f'], 'fill', '#40c057');
  assert.equal(recoloured[0].backgroundColor, shadow.backgroundColor); // shadow untouched
  assert.equal(recoloured[1].backgroundColor, '#40c057'); // face recoloured
});

test('placeCentered maps the viewport center to scene coords under scroll and zoom', () => {
  const base = { width: 1000, height: 800, zoom: { value: 1 }, scrollX: 0, scrollY: 0 };
  assert.deepEqual(decisions.viewportCenterScene(base), { x: 500, y: 400 });
  assert.deepEqual(decisions.placeCentered(base, 180, 180), { x: 410, y: 310 });

  const scrolled = { width: 1000, height: 800, zoom: { value: 2 }, scrollX: -100, scrollY: -50 };
  // sceneCenter = (w/2)/zoom - scrollX = 250 + 100 = 350 ; (h/2)/zoom - scrollY = 200 + 50 = 250
  assert.deepEqual(decisions.viewportCenterScene(scrolled), { x: 350, y: 250 });
  assert.deepEqual(decisions.placeCentered({}, 100, 100), { x: -50, y: -50 });
});

test('the persist signature moves for real state changes but not for pan or zoom', () => {
  const a = { viewBackgroundColor: '#121212', gridModeEnabled: false, scrollX: 0, zoom: { value: 1 } };
  const panned = { ...a, scrollX: -900, scrollY: 320, zoom: { value: 3 } };
  assert.equal(decisions.appStatePersistSignature(a), decisions.appStatePersistSignature(panned));
  const gridOn = { ...a, gridModeEnabled: true, gridSize: 20 };
  assert.notEqual(decisions.appStatePersistSignature(a), decisions.appStatePersistSignature(gridOn));
  assert.equal(decisions.boardChanged({ version: 1, appSig: 'x' }, { version: 1, appSig: 'x' }), false);
  assert.equal(decisions.boardChanged({ version: 1, appSig: 'x' }, { version: 2, appSig: 'x' }), true);
  assert.equal(decisions.boardChanged({ version: 1, appSig: 'x' }, { version: 1, appSig: 'y' }), true);
});

test('the style palette is rich and recolors only the selection', () => {
  assert.ok(decisions.STYLE_COLORS.length >= 14, `palette has only ${decisions.STYLE_COLORS.length} colors`);
  assert.ok(decisions.STYLE_COLORS.some((c) => c.hex === 'transparent'), 'palette lacks a no-fill option');
  assert.equal(decisions.STROKE_WIDTHS.length, 3);

  const els = [
    { id: 'a', backgroundColor: '#111', strokeColor: '#eee', strokeWidth: 1, fillStyle: 'hachure' },
    { id: 'b', backgroundColor: '#222', strokeColor: '#ddd', strokeWidth: 2 },
  ];
  const fill = decisions.recolorElements(els, ['a'], 'fill', '#40c057');
  assert.equal(fill[0].backgroundColor, '#40c057');
  assert.equal(fill[0].fillStyle, 'solid'); // a real fill, not hachure
  assert.equal(fill[1].backgroundColor, '#222'); // b untouched
  assert.notEqual(fill[0], els[0]); // new object, no mutation

  const line = decisions.recolorElements(els, new Set(['a', 'b']), 'line', '#f06595');
  assert.equal(line[0].strokeColor, '#f06595');
  assert.equal(line[1].strokeColor, '#f06595');

  const cleared = decisions.recolorElements(els, ['a'], 'fill', 'transparent');
  assert.equal(cleared[0].backgroundColor, 'transparent');

  const widened = decisions.setSelectionProp(els, ['b'], 'strokeWidth', 4);
  assert.equal(widened[1].strokeWidth, 4);
  assert.equal(widened[0].strokeWidth, 1);
});

test('selectionStyle reports shared style and null on disagreement', () => {
  const els = [
    { id: 'a', backgroundColor: '#111', strokeColor: '#eee', strokeWidth: 2 },
    { id: 'b', backgroundColor: '#111', strokeColor: '#000', strokeWidth: 2 },
  ];
  assert.deepEqual(decisions.selectionStyle(els, ['a']), { count: 1, fill: '#111', stroke: '#eee', width: 2 });
  const both = decisions.selectionStyle(els, ['a', 'b']);
  assert.equal(both.count, 2);
  assert.equal(both.fill, '#111'); // shared
  assert.equal(both.stroke, null); // differ
  assert.equal(both.width, 2);
});

test('sticky shadows follow their face and orphans are dropped', () => {
  const face = { id: 'f', type: 'rectangle', x: 100, y: 100, width: 180, height: 180, angle: 0 };
  const shadow = { id: 's', type: 'rectangle', x: 105, y: 107, width: 180, height: 180, angle: 0, locked: true, customData: { stickyShadow: true, faceId: 'f' } };
  assert.equal(decisions.syncStickyShadows([shadow, face]).changed, false); // already glued
  const moved = decisions.syncStickyShadows([shadow, { ...face, x: 400, y: 300 }]);
  assert.equal(moved.changed, true);
  const ns = moved.elements.find((e) => e.id === 's');
  assert.equal(ns.x, 405); // face.x + shadow dx
  assert.equal(ns.y, 307); // face.y + shadow dy
  const orphan = decisions.syncStickyShadows([shadow]); // face gone -> shadow marked deleted
  assert.equal(orphan.changed, true);
  assert.equal(orphan.elements.length, 1); // kept in the array...
  assert.equal(orphan.elements[0].isDeleted, true); // ...but flagged deleted (updateScene merges by id)
  // onChange hands the FULL list including the just-deleted face (isDeleted:true), which must
  // still count as gone so the shadow is cleaned (Pat's grey-ghost delete bug).
  const deadFace = decisions.syncStickyShadows([shadow, { ...face, isDeleted: true }]);
  assert.equal(deadFace.changed, true);
  assert.equal(deadFace.elements.find((e) => e.id === 's').isDeleted, true);
  // an already-deleted shadow is left alone (no churn)
  assert.equal(decisions.syncStickyShadows([{ ...shadow, isDeleted: true }]).changed, false);
  assert.equal(decisions.syncStickyShadows([{ id: 'r', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }]).changed, false);
});

test('connector detection, routing, dash, heads and readback', () => {
  const els = [
    { id: 'r', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
    { id: 'e', type: 'ellipse', x: 300, y: 200, width: 100, height: 60 },
    { id: 'a', type: 'arrow', x: 100, y: 30, points: [[0, 0], [200, 200]], strokeStyle: 'solid', roundness: null, startArrowhead: null, endArrowhead: 'arrow' },
  ];
  // a selection of only connectors gets the connector bar; mixed or shape does not
  assert.equal(decisions.selectionIsConnector(els, ['a']), true);
  assert.equal(decisions.selectionIsConnector(els, ['r']), false);
  assert.equal(decisions.selectionIsConnector(els, ['a', 'r']), false);
  assert.equal(decisions.selectionIsConnector(els, []), false);

  // routing rewrites the connector's points and keeps its two endpoints; the
  // elbow carries its logical waypoints in customData.elbow while `points`
  // holds the rounded-corner expansion (Miro finding 17)
  const elbow = decisions.setConnectorRouting(els, ['a'], 'elbow');
  const ea = elbow.find((x) => x.id === 'a');
  assert.ok(ea.points.length >= 4, `points=${ea.points.length}`);
  assert.deepEqual(ea.points[0], [0, 0]);
  assert.deepEqual(ea.points[ea.points.length - 1], [200, 200]);
  assert.equal(ea.roundness, null);
  assert.equal(ea.customData.elbow.waypoints.length, 4);
  assert.deepEqual(ea.customData.elbow.waypoints[0], [0, 0]);
  assert.deepEqual(ea.customData.elbow.waypoints[3], [200, 200]);

  const curved = decisions.setConnectorRouting(els, ['a'], 'curved');
  const ca = curved.find((x) => x.id === 'a');
  assert.equal(ca.points.length, 3);
  assert.equal(ca.roundness.type, 2);
  assert.deepEqual(ca.points[2], [200, 200]);

  // elbow then straight collapses back to two points
  const straight = decisions.setConnectorRouting(elbow, ['a'], 'straight');
  const sa = straight.find((x) => x.id === 'a');
  assert.equal(sa.points.length, 2);
  assert.deepEqual(sa.points[1], [200, 200]);

  // a shape is never re-routed even if in the id set
  assert.equal(decisions.setConnectorRouting(els, ['r'], 'elbow').find((x) => x.id === 'r').points, undefined);

  // dash and arrowheads
  assert.equal(decisions.setConnectorDash(els, ['a'], 'dashed').find((x) => x.id === 'a').strokeStyle, 'dashed');
  const heads = decisions.setConnectorHeads(els, ['a'], { start: 'arrow', end: null }).find((x) => x.id === 'a');
  assert.equal(heads.startArrowhead, 'arrow');
  assert.equal(heads.endArrowhead, null);

  // readback drives the toolbar's active-state highlighting
  assert.deepEqual(decisions.connectorStyle(els, ['a']), { routing: 'straight', dash: 'solid', start: null, end: 'arrow' });
  assert.equal(decisions.connectorStyle(elbow, ['a']).routing, 'elbow');
  assert.equal(decisions.connectorStyle(curved, ['a']).routing, 'curved');
});

test('the shapes palette is far past three, with text-capable natives and drawable polys', () => {
  const keys = decisions.SHAPE_DEFS.map((d) => d.key);
  // Native container shapes (drag-to-draw + bound text) lead; then a rich poly set.
  assert.ok(keys.length >= 14, `only ${keys.length} shapes`);
  for (const k of ['rectangle', 'rounded', 'ellipse', 'diamond', 'triangle', 'pentagon', 'hexagon', 'star']) {
    assert.ok(keys.includes(k), `missing shape ${k}`);
  }
  const natives = decisions.SHAPE_DEFS.filter((d) => d.kind === 'native');
  assert.ok(natives.every((d) => typeof d.tool === 'string'), 'a native shape has no Excalidraw tool');
  assert.equal(decisions.shapeDef('rounded').rounded, true);
  // Every poly def is a closed set of in-box normalized points.
  for (const def of decisions.SHAPE_DEFS.filter((d) => d.kind === 'poly')) {
    assert.ok(def.points.length >= 3, `${def.key} has too few points`);
    for (const [px, py] of def.points) {
      assert.ok(px >= 0 && px <= 1 && py >= 0 && py <= 1, `${def.key} point out of the unit box`);
    }
  }
});

test('a poly shape skeleton is a closed, filled line marked as a SHAPE not a connector', () => {
  const [tri] = decisions.shapeSkeleton('triangle', 40, 60, 160, 120);
  assert.equal(tri.type, 'line');
  assert.equal(tri.x, 40);
  assert.equal(tri.y, 60);
  assert.equal(tri.width, 160);
  assert.equal(tri.height, 120);
  // scaled to the box and closed (first point repeated at the end)
  assert.deepEqual(tri.points[0], tri.points[tri.points.length - 1]);
  assert.ok(tri.points.every(([x, y]) => x >= 0 && x <= 160 && y >= 0 && y <= 120), 'point escaped the box');
  assert.equal(tri.backgroundColor, decisions.SHAPE_FILL);
  assert.equal(tri.fillStyle, 'solid');
  assert.equal(tri.roughness, 0);
  // marked so the fill/colour bar shows for it, never the connector routing bar
  assert.ok(decisions.isPolyShape(tri));
  assert.equal(decisions.selectionIsConnector([{ id: 't', ...tri }], ['t']), false);
  // a star has 10 outer/inner vertices (+1 to close)
  assert.equal(decisions.shapeSkeleton('star', 0, 0, 100, 100)[0].points.length, 11);
  // native shapes are drawn by their own tool, not as a skeleton
  assert.deepEqual(decisions.shapeSkeleton('rectangle', 0, 0, 10, 10), []);
});

test('a table is a grid of editable cells sharing one id, with add/remove row and column', () => {
  const skel = decisions.tableSkeleton('T1', 3, 3, 0, 0);
  assert.equal(skel.length, 9);
  assert.ok(skel.every((c) => c.type === 'rectangle' && c.customData.table.id === 'T1'), 'cells are not one-id rectangles');
  // header row 0 is tinted, data rows are white
  const header = skel.filter((c) => c.customData.table.r === 0);
  const data = skel.filter((c) => c.customData.table.r > 0);
  assert.ok(header.every((c) => c.backgroundColor !== '#ffffff'), 'header row not tinted distinctly');
  assert.ok(data.every((c) => c.backgroundColor === '#ffffff'), 'data cells not white');
  // give the skeleton ids so add/remove can address it, the way convert would
  const els = skel.map((c, i) => ({ ...c, id: `c${i}` }));
  // add a column: 3 new cells at c===3
  const colSkel = decisions.tableColumnSkeletons(els, 'T1');
  assert.equal(colSkel.length, 3);
  assert.ok(colSkel.every((c) => c.customData.table.c === 3), 'new column not indexed at 3');
  // add a row: 3 new cells at r===3 (data-styled)
  const rowSkel = decisions.tableRowSkeletons(els, 'T1');
  assert.equal(rowSkel.length, 3);
  assert.ok(rowSkel.every((c) => c.customData.table.r === 3 && c.backgroundColor === '#ffffff'), 'new row wrong');
  // remove the last row: those cells (and their bound text) are MARKED isDeleted, never dropped
  const withText = [...els, { id: 'tx', type: 'text', containerId: 'c8', text: 'x' }];
  const afterDel = decisions.tableRemoveRow(withText, 'T1');
  assert.equal(afterDel.length, withText.length, 'removeRow dropped elements instead of marking them');
  const live = afterDel.filter((e) => !e.isDeleted && e.customData && e.customData.table);
  assert.equal(live.length, 6, 'removeRow did not mark the last row deleted');
  assert.ok(afterDel.find((e) => e.id === 'tx').isDeleted, 'bound text of a removed cell not deleted');
  // never shrink below 1x1
  const oneRow = decisions.tableSkeleton('T2', 1, 2, 0, 0).map((c, i) => ({ ...c, id: `o${i}` }));
  assert.equal(decisions.tableRemoveRow(oneRow, 'T2').filter((e) => e.isDeleted).length, 0, 'removed the only row');
  // selection controls key off a selected cell
  assert.equal(decisions.selectionTableId(els, ['c4']), 'T1');
  assert.equal(decisions.selectionTableId([{ id: 'z', type: 'rectangle' }], ['z']), null);
});

test('normalizeHex accepts 3/6-digit hex with or without a hash and rejects the rest', () => {
  assert.equal(decisions.normalizeHex('#AABBCC'), '#aabbcc');
  assert.equal(decisions.normalizeHex('aabbcc'), '#aabbcc');
  assert.equal(decisions.normalizeHex('#abc'), '#aabbcc');
  assert.equal(decisions.normalizeHex('  #F06595  '), '#f06595'); // trimmed
  assert.equal(decisions.normalizeHex('123'), '#112233');
  assert.equal(decisions.normalizeHex(''), null);
  assert.equal(decisions.normalizeHex('#12'), null); // 2 digits
  assert.equal(decisions.normalizeHex('#1234'), null); // 4 digits (no alpha support)
  assert.equal(decisions.normalizeHex('rebeccapurple'), null); // named colours are not hex
  assert.equal(decisions.normalizeHex('#gggggg'), null);
  assert.equal(decisions.normalizeHex(null), null);
});

test('rgbaToHex converts a sampled pixel and reports fully-transparent as no sample', () => {
  assert.equal(decisions.rgbaToHex([255, 0, 0, 255]), '#ff0000');
  assert.equal(decisions.rgbaToHex([25, 113, 194, 255]), '#1971c2');
  assert.equal(decisions.rgbaToHex(new Uint8ClampedArray([64, 192, 87, 255])), '#40c057');
  assert.equal(decisions.rgbaToHex([1, 2, 3]), '#010203'); // no alpha channel is opaque
  assert.equal(decisions.rgbaToHex([300, -5, 87, 255]), '#ff0057'); // clamped to 0..255
  assert.equal(decisions.rgbaToHex([10, 20, 30, 0]), null); // fully transparent -> nothing under the cursor
});

test('addRecentColor keeps a deduped, most-recent-first, capped custom-colour list', () => {
  assert.deepEqual(decisions.addRecentColor([], '#ff0000'), ['#ff0000']);
  // most recent moves to the front, no duplicate
  assert.deepEqual(decisions.addRecentColor(['#111111', '#222222'], '#222222'), ['#222222', '#111111']);
  // normalized before compare and store (a 3-digit and its 6-digit form are one colour)
  assert.deepEqual(decisions.addRecentColor(['#aabbcc'], '#abc'), ['#aabbcc']);
  // invalid or transparent inputs never enter the list
  assert.deepEqual(decisions.addRecentColor(['#111111'], 'not-a-colour'), ['#111111']);
  assert.deepEqual(decisions.addRecentColor(['#111111'], 'transparent'), ['#111111']);
  // capped at RECENT_COLORS_MAX, oldest dropped
  const many = Array.from({ length: decisions.RECENT_COLORS_MAX }, (_, i) => `#0000${(i + 16).toString(16)}`);
  const grown = decisions.addRecentColor(many, '#ffffff');
  assert.equal(grown.length, decisions.RECENT_COLORS_MAX);
  assert.equal(grown[0], '#ffffff');
  assert.ok(!grown.includes(many[many.length - 1]), 'the oldest colour was not dropped when capped');
});

test('selectionOpacity reports the shared 0-100 opacity, defaulting undefined to 100', () => {
  const els = [
    { id: 'a', opacity: 100 },
    { id: 'b', opacity: 40 },
    { id: 'c' }, // no opacity field reads as fully opaque
    { id: 's', opacity: 13, locked: true, customData: { stickyShadow: true } },
  ];
  assert.equal(decisions.selectionOpacity(els, ['a']), 100);
  assert.equal(decisions.selectionOpacity(els, ['b']), 40);
  assert.equal(decisions.selectionOpacity(els, ['c']), 100); // default when unset
  assert.equal(decisions.selectionOpacity(els, ['a', 'b']), null); // disagree
  assert.equal(decisions.selectionOpacity(els, ['a', 'c']), 100); // both effectively 100
  assert.equal(decisions.selectionOpacity(els, []), null);
  // a sticky reads from its face; its shadow's own opacity is never counted
  assert.equal(decisions.selectionOpacity([...els, { id: 'face', opacity: 60 }], ['face', 's']), 60);
});

test('text colour recolours bound and standalone text, never the container stroke', () => {
  const els = [
    { id: 'face', type: 'rectangle', strokeColor: 'transparent', backgroundColor: '#ffe86d', boundElements: [{ id: 'lbl', type: 'text' }] },
    { id: 'lbl', type: 'text', containerId: 'face', strokeColor: '#1a1a1a' },
    { id: 'free', type: 'text', strokeColor: '#000000' },
  ];
  // selecting a sticky/shape recolours its BOUND label, leaving the container stroke alone
  const r = decisions.recolorText(els, ['face'], '#e64980');
  assert.equal(r.find((e) => e.id === 'lbl').strokeColor, '#e64980');
  assert.equal(r.find((e) => e.id === 'face').strokeColor, 'transparent'); // the container is untouched
  assert.equal(r.find((e) => e.id === 'free').strokeColor, '#000000'); // an unrelated text is untouched
  // selecting a standalone text recolours it directly
  assert.equal(decisions.recolorText(els, ['free'], '#40c057').find((e) => e.id === 'free').strokeColor, '#40c057');
  // detection drives whether the Text control shows
  assert.equal(decisions.selectionHasText(els, ['face']), true); // via its bound label
  assert.equal(decisions.selectionHasText(els, ['free']), true); // a standalone text
  assert.equal(decisions.selectionHasText(els, []), false);
  assert.equal(decisions.selectionHasText([{ id: 'r', type: 'rectangle' }], ['r']), false);
  // readback for the active swatch highlight
  assert.equal(decisions.selectionTextColor(els, ['face']), '#1a1a1a');
  assert.equal(decisions.selectionTextColor(els, ['free']), '#000000');
  assert.equal(decisions.selectionTextColor(els, ['r']), null);
});

test('a poly shape honours caller fill/stroke and falls back to the clean defaults', () => {
  const [custom] = decisions.shapeSkeleton('triangle', 0, 0, 100, 100, { fill: '#123456', stroke: '#654321', strokeWidth: 4 });
  assert.equal(custom.backgroundColor, '#123456');
  assert.equal(custom.strokeColor, '#654321');
  assert.equal(custom.strokeWidth, 4);
  const [fallback] = decisions.shapeSkeleton('triangle', 0, 0, 100, 100);
  assert.equal(fallback.backgroundColor, decisions.SHAPE_FILL);
  assert.equal(fallback.strokeColor, decisions.SHAPE_STROKE);
});

// M4 (b6 review): the canvas restore must repair bindings at load, so a broken
// containerId/boundElements pair or a dangling arrow binding self-heals instead
// of rendering undefined. refreshDimensions must NOT ride along: it re-measures
// text before Excalidraw's fonts load and would rewrite Pat's labels with
// fallback-font metrics.
test('WhiteboardCanvas restores with repairBindings and never refreshDimensions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/whiteboard/WhiteboardCanvas.jsx'), 'utf8');
  assert.match(source, /restore\(\{[\s\S]*?\}, null, null, \{ repairBindings: true \}\)/);
  assert.equal(source.includes('refreshDimensions'), false);
});

// H1 (b6 review): when a board changed on disk underneath an OPEN canvas, the
// on-disk scene is MERGED into the live one rather than either side clobbering
// the other: per element the higher version wins, unsaved local elements
// survive, disk-only additions land, and an unchanged merge reports itself so
// a bare reload never schedules an echo save.
test('mergeBoardScene keeps local work, adopts disk additions and newer disk edits', () => {
  const canvas = [
    { id: 'a', type: 'rectangle', version: 3, x: 0 },
    { id: 'local-only', type: 'rectangle', version: 1, x: 50 },
    { id: 'b', type: 'text', version: 2, x: 100 },
  ];
  const disk = [
    { id: 'a', type: 'rectangle', version: 5, x: 900 }, // CLI edited it
    { id: 'b', type: 'text', version: 1, x: 111 }, // stale on disk; canvas is newer AND differs
    { id: 'cli-sticky', type: 'rectangle', version: 1, x: 200 }, // CLI added it
  ];
  const merged = decisions.mergeBoardScene(canvas, disk);
  assert.equal(merged.changed, true);
  assert.equal(merged.elements.find((el) => el.id === 'a').x, 900);
  assert.equal(merged.elements.find((el) => el.id === 'b').x, 100);
  assert.ok(merged.elements.some((el) => el.id === 'local-only'), 'unsaved local work survives');
  assert.ok(merged.elements.some((el) => el.id === 'cli-sticky'), 'the CLI addition lands');
  // The canvas holds things the disk lacks (local-only, and b materially
  // newer), so the merge must say so: the caller has to persist the union
  // even when its own editing state reads clean.
  assert.equal(merged.canvasAhead, true);
});

test('mergeBoardScene compares CONTENT, so normalization version bumps are not differences', () => {
  // Excalidraw's mount normalization re-indexes CLI-authored elements and
  // bumps version/versionNonce/updated with NO content change (measured
  // live); treating that as canvas-ahead or disk-ahead re-created the very
  // echo save the merge exists to prevent.
  const canvas = [{ id: 'a', type: 'rectangle', version: 2, versionNonce: 9, updated: 999, index: 'a1', x: 0 }];
  const normalizedOnly = decisions.mergeBoardScene(canvas, [{ id: 'a', type: 'rectangle', version: 1, versionNonce: 1, updated: 1, index: null, x: 0 }]);
  assert.equal(normalizedOnly.changed, false);
  assert.equal(normalizedOnly.canvasAhead, false);
  // The same shape the other way: a disk version bump with identical content
  // must not rebuild the canvas element.
  const diskBumped = decisions.mergeBoardScene(canvas, [{ id: 'a', type: 'rectangle', version: 7, versionNonce: 3, updated: 2, index: 'a1', x: 0 }]);
  assert.equal(diskBumped.changed, false);
  assert.equal(diskBumped.elements[0].versionNonce, 9);
});

test('mergeBoardScene reports canvasAhead exactly when the disk is missing canvas-side truth', () => {
  const canvas = [{ id: 'a', type: 'rectangle', version: 2, x: 40 }];
  // Disk matches or exceeds the canvas: nothing to push back.
  assert.equal(decisions.mergeBoardScene(canvas, [{ id: 'a', type: 'rectangle', version: 2, x: 40 }]).canvasAhead, false);
  assert.equal(decisions.mergeBoardScene(canvas, [{ id: 'a', type: 'rectangle', version: 5, x: 41 }, { id: 'new', type: 'text', version: 1 }]).canvasAhead, false);
  // Disk regressed an element materially (a CLI read-modify-write raced an
  // app save and rewrote the file from a stale read).
  assert.equal(decisions.mergeBoardScene(canvas, [{ id: 'a', type: 'rectangle', version: 1, x: 0 }]).canvasAhead, true);
  // Disk lost an element the canvas still holds.
  assert.equal(decisions.mergeBoardScene(canvas, []).canvasAhead, true);
});

test('mergeBoardScene honours disk deletions, skips disk tombstones, and reports no change when equal', () => {
  const canvas = [{ id: 'a', type: 'rectangle', version: 2, isDeleted: false }];
  const rmOnDisk = decisions.mergeBoardScene(canvas, [{ id: 'a', type: 'rectangle', version: 3, isDeleted: true }]);
  assert.equal(rmOnDisk.changed, true);
  assert.equal(rmOnDisk.elements.find((el) => el.id === 'a').isDeleted, true, 'a CLI rm reaches the canvas');

  const tombstone = decisions.mergeBoardScene(canvas, [
    { id: 'a', type: 'rectangle', version: 2, isDeleted: false },
    { id: 'gone-long-ago', type: 'text', version: 4, isDeleted: true },
  ]);
  assert.equal(tombstone.changed, false, 'a disk-only tombstone is not new content');
  assert.equal(tombstone.elements.length, 1);

  const identical = decisions.mergeBoardScene(canvas, [{ id: 'a', type: 'rectangle', version: 2, isDeleted: false }]);
  assert.equal(identical.changed, false);
  assert.deepEqual(identical.elements, canvas);
});

test('newBoardFiles answers only the disk files the canvas does not hold yet', () => {
  const canvasFiles = { f1: { id: 'f1', dataURL: 'data:x' } };
  const diskFiles = { f1: { id: 'f1', dataURL: 'data:x' }, f2: { id: 'f2', dataURL: 'data:y' } };
  assert.deepEqual(decisions.newBoardFiles(canvasFiles, diskFiles), [{ id: 'f2', dataURL: 'data:y' }]);
  assert.deepEqual(decisions.newBoardFiles(canvasFiles, { f1: { id: 'f1', dataURL: 'data:x' } }), []);
  assert.deepEqual(decisions.newBoardFiles(undefined, undefined), []);
});

test('every template builds a bound, self-consistent skeleton', () => {
  const keys = new Set(decisions.TEMPLATES.map((template) => template.key));
  assert.ok(keys.has('kanban') && keys.has('flow') && keys.has('mindmap') && keys.has('matrix'));
  for (const template of decisions.TEMPLATES) {
    assert.match(template.label, /\S/);
    assert.ok(template.width > 0 && template.height > 0, `${template.key} has no size`);
    const els = template.build(100, 100);
    assert.ok(Array.isArray(els) && els.length > 0, `${template.key} built nothing`);
    const ids = new Set(els.filter((el) => el.id).map((el) => el.id));
    for (const el of els) {
      assert.match(String(el.type), /\S/, `${template.key} element has no type`);
      // an arrow that binds by id must reference an element in the same batch
      if (el.start && el.start.id) assert.ok(ids.has(el.start.id), `${template.key} arrow start ${el.start.id} unbound`);
      if (el.end && el.end.id) assert.ok(ids.has(el.end.id), `${template.key} arrow end ${el.end.id} unbound`);
    }
  }
});

test('the board switcher filters by name, trimmed and case-insensitive', () => {
  const boards = [
    { id: 'plan', name: 'Launch Plan' },
    { id: 'retro', name: 'Sprint Retro' },
    { id: 'qa', name: 'Q&A board' },
  ];
  assert.deepEqual(decisions.filterBoards(boards, '  plan ').map(({ id }) => id), ['plan']);
  assert.deepEqual(decisions.filterBoards(boards, 'R').map(({ id }) => id), ['retro', 'qa']);
  assert.deepEqual(decisions.filterBoards(boards, '').map(({ id }) => id), ['plan', 'retro', 'qa']);
  assert.deepEqual(decisions.filterBoards(boards, '   ').map(({ id }) => id), ['plan', 'retro', 'qa']);
  assert.deepEqual(decisions.filterBoards(boards, 'zebra'), []);
  assert.deepEqual(decisions.filterBoards(null, 'x'), []);
});

test('a duplicated board gets a Copy of name that dodges collisions', () => {
  assert.equal(decisions.duplicateName('Launch Plan', []), 'Copy of Launch Plan');
  assert.equal(decisions.duplicateName('Launch Plan', ['Copy of Launch Plan']), 'Copy of Launch Plan 2');
  assert.equal(
    decisions.duplicateName('Launch Plan', ['Copy of Launch Plan', 'Copy of Launch Plan 2']),
    'Copy of Launch Plan 3',
  );
  assert.equal(decisions.duplicateName('', []), 'Copy of Untitled board');
});

test('board tiles get a stable spread hue per id', () => {
  const hue = decisions.boardHue('launch-plan');
  assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360);
  assert.equal(decisions.boardHue('launch-plan'), hue, 'the hue must be stable per id');
  const hues = new Set(['a', 'b', 'c', 'd', 'launch-plan', 'retro'].map((id) => decisions.boardHue(id)));
  assert.ok(hues.size >= 4, 'different ids should mostly spread to different hues');
});

test('poly shapes are connectable: dots, snap, and drop targeting include them', () => {
  // Pat, 2026-08-30: dragging a connector between catalog shapes gave no dots
  // and no snap; CONNECTABLE_TYPES silently excluded every line-based poly.
  const poly = { id: 'tri', type: 'line', customData: { polyShape: 'triangle' }, isDeleted: false, locked: false };
  assert.equal(decisions.isConnectable(poly), true);
  assert.equal(decisions.isConnectable({ ...poly, locked: true }), false);
  assert.equal(decisions.isConnectable({ id: 'a', type: 'arrow' }), false, 'a plain connector is not a target');
  assert.equal(decisions.isConnectable({ id: 'l', type: 'line' }), false, 'a plain drawn line is not a target');
});

test('syncPolyConnectors glues polyBind arrow ends to the poly box anchors', () => {
  const poly = { id: 'tri', type: 'line', x: 100, y: 100, width: 200, height: 100, customData: { polyShape: 'triangle' }, isDeleted: false };
  const arrow = {
    id: 'a1', type: 'arrow', x: 400, y: 150, points: [[0, 0], [60, 10], [120, 20]],
    customData: { polyBind: { end: { id: 'tri', side: 'right' } } }, isDeleted: false,
  };
  const { elements, changed } = decisions.syncPolyConnectors([poly, arrow]);
  assert.equal(changed, true);
  const glued = elements.find((e) => e.id === 'a1');
  const last = glued.points[glued.points.length - 1];
  // right side midpoint of the poly box = (300, 150); end scene = x + last
  assert.equal(Math.round(glued.x + last[0]), 300);
  assert.equal(Math.round(glued.y + last[1]), 150);
  // a second pass with nothing moved is a no-op
  assert.equal(decisions.syncPolyConnectors(elements).changed, false);
});

test('syncPolyConnectors glues the START end by shifting origin, keeping other points in place', () => {
  const poly = { id: 'tri', type: 'line', x: 0, y: 0, width: 100, height: 100, customData: { polyShape: 'triangle' }, isDeleted: false };
  const arrow = {
    id: 'a2', type: 'arrow', x: 200, y: 200, points: [[0, 0], [50, 40], [100, 80]],
    customData: { polyBind: { start: { id: 'tri', side: 'bottom' } } }, isDeleted: false,
  };
  const { elements } = decisions.syncPolyConnectors([poly, arrow]);
  const glued = elements.find((e) => e.id === 'a2');
  // bottom midpoint = (50, 100); start scene = x + points[0]
  assert.equal(Math.round(glued.x + glued.points[0][0]), 50);
  assert.equal(Math.round(glued.y + glued.points[0][1]), 100);
  // the mid and end points kept their SCENE positions (250,240) and (300,280)
  assert.equal(Math.round(glued.x + glued.points[1][0]), 250);
  assert.equal(Math.round(glued.y + glued.points[1][1]), 240);
  assert.equal(Math.round(glued.x + glued.points[2][0]), 300);
  assert.equal(Math.round(glued.y + glued.points[2][1]), 280);
});

test('syncPolyConnectors drops the bind of a deleted poly, leaving an honest dangling end', () => {
  const arrow = {
    id: 'a3', type: 'arrow', x: 10, y: 10, points: [[0, 0], [50, 50]],
    customData: { polyBind: { end: { id: 'gone', side: 'left' } } }, isDeleted: false,
  };
  const { elements, changed } = decisions.syncPolyConnectors([arrow]);
  assert.equal(changed, true);
  const kept = elements.find((e) => e.id === 'a3');
  assert.equal(kept.customData.polyBind.end, undefined);
  assert.deepEqual(kept.points, [[0, 0], [50, 50]], 'the endpoint stays where it was');
});
