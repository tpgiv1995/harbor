'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const model = require('../../src/shared/board-model.cjs');
const { flattenScene } = require('../../src/shared/board-view.cjs');
const {
  STICKY_COLORS, STICKY_SHADOW_BANDS, STICKY_SHADOW_COLOR, syncStickyShadows,
} = require('../../src/renderer/whiteboard/board-files.cjs');

function seam() {
  let id = 0; let integer = 0;
  return { newId: () => `fixed-${++id}`, now: () => 1700000000000, randomInt: () => ++integer };
}
function allTypes(ctx = seam()) {
  const sticky = model.stickyNote({ x: 10, y: 20, text: 'fix this header' }, ctx);
  const shapes = ['rectangle', 'ellipse', 'diamond', 'triangle'].flatMap((shape) => model.shape({ shape, text: 'Label' }, ctx));
  const text = model.textNote({ x: 1, y: 2, text: 'Standalone' }, ctx);
  const image = model.image({ bytes: Buffer.from('png'), width: 20, height: 30 }, ctx).element;
  const arrow = model.connector({ source: shapes[0], target: shapes[2] }, ctx);
  return [...sticky, ...shapes, text, image, arrow, ...model.table({ rows: 2, cols: 2 }, ctx)];
}

test('builders emit the full base schema, house style, visible geometry, and normalized linear points', () => {
  const elements = allTypes();
  for (const el of elements) {
    for (const key of model.BASE_KEYS) assert.ok(Object.hasOwn(el, key), `${el.id} lacks ${key}`);
    assert.equal(Object.values(el).includes(undefined), false, `${el.id} contains undefined`);
    assert.equal(el.roughness, 0); assert.equal(el.fillStyle, 'solid'); assert.equal(el.isDeleted, false);
    assert.equal(el.version, 1); assert.equal(el.index, null); assert.deepEqual(el.groupIds, []);
    assert.equal(el.frameId, null); assert.equal(el.link, null);
    if (el.type === 'line' || el.type === 'arrow') {
      assert.ok(el.points.length >= 2); assert.deepEqual(el.points[0], [0, 0]);
      const xs = el.points.map((p) => p[0]); const ys = el.points.map((p) => p[1]);
      assert.equal(el.width, Math.max(...xs) - Math.min(...xs));
      assert.equal(el.height, Math.max(...ys) - Math.min(...ys));
    } else assert.notEqual(el.width === 0 && el.height === 0, true);
  }
});

test('sticky composite matches production shadow synchronization and exact text metrics', () => {
  // The CLI writes the SAME shadow the app does: Miro's bottom-only falloff as the two
  // locked bands of STICKY_SHADOW_BANDS, each carrying its own dx/dy, not the single
  // +5/+7 square this factory shipped before Wave D.
  const made = model.stickyNote({ color: 'yellow', x: 10.4, y: 20.4, text: 'fix this header' }, seam());
  const bands = made.filter((el) => el.customData?.stickyShadow);
  const [face, label] = made.slice(bands.length);
  assert.equal(bands.length, STICKY_SHADOW_BANDS.length);
  bands.forEach((shadow, i) => {
    const band = STICKY_SHADOW_BANDS[i];
    assert.equal(shadow.locked, true); assert.equal(shadow.customData.stickyShadow, true);
    assert.equal(shadow.customData.faceId, face.id);
    assert.equal(shadow.customData.dx, band.dx); assert.equal(shadow.customData.dy, band.dy);
    assert.equal(shadow.x, face.x + band.dx); assert.equal(shadow.y, face.y + band.dy);
    assert.equal(shadow.width, face.width); assert.equal(shadow.height, face.height); assert.equal(shadow.angle, face.angle);
    assert.equal(shadow.opacity, band.opacity); assert.equal(shadow.backgroundColor, STICKY_SHADOW_COLOR);
    // The bands render UNDER the face, so they must precede it in the element order.
    assert.ok(made.indexOf(shadow) < made.indexOf(face));
  });
  assert.equal(face.backgroundColor, STICKY_COLORS.find((c) => c.key === 'yellow').bg);
  assert.equal(face.roundness, null); assert.equal(face.strokeColor, 'transparent');
  assert.deepEqual(face.boundElements, [{ type: 'text', id: label.id }]);
  assert.equal(label.containerId, face.id); assert.equal(label.fontFamily, 6); assert.equal(label.lineHeight, 1.35);
  assert.equal(label.textAlign, 'center'); assert.equal(label.verticalAlign, 'middle');
  assert.equal(label.height, label.fontSize * label.lineHeight * label.text.split('\n').length);
  assert.ok(label.width <= model.getBoundTextMaxWidth(face));
  assert.equal(label.text.replace(/\n/g, ' '), label.originalText);
  // The app's own glue pass finds nothing to fix: the CLI wrote what the app maintains.
  assert.equal(syncStickyShadows([...bands, face, label]).changed, false);
  // A legacy single-shadow sticky (no dx/dy) still reads as glued at the historical
  // offsets, so an existing board neither reflows nor starts failing validation.
  const legacy = { ...bands[0], customData: { stickyShadow: true, faceId: face.id }, x: face.x + 5, y: face.y + 7 };
  assert.deepEqual(model.shadowOffsets(legacy), { dx: 5, dy: 7 });
  assert.deepEqual(model.validateScene({ elements: [legacy, face, label], files: {} }), []);
});

function independentPosition(container, text) {
  let ox = 5; let oy = 5;
  if (container.type === 'ellipse') { ox += (container.width / 2) * (1 - Math.sqrt(2) / 2); oy += (container.height / 2) * (1 - Math.sqrt(2) / 2); }
  if (container.type === 'diamond') { ox += container.width / 4; oy += container.height / 4; }
  return { x: container.x + ox + model.getBoundTextMaxWidth(container, text.fontSize) / 2 - text.width / 2, y: container.y + oy + model.getBoundTextMaxHeight(container) / 2 - text.height / 2 };
}
test('bound text position independently matches rectangle, ellipse, and diamond formulas', () => {
  for (const kind of ['rectangle', 'ellipse', 'diamond']) {
    const [container, label] = model.shape({ shape: kind, x: 30, y: 40, width: 240, height: 140, text: 'bounded words' }, seam());
    assert.deepEqual({ x: label.x, y: label.y }, independentPosition(container, label));
  }
});

test('connector bindings are mirrored and validator accepts the correct scene', () => {
  const ctx = seam(); const source = model.shape({ shape: 'rectangle' }, ctx)[0]; const target = model.shape({ shape: 'ellipse', x: 300 }, ctx)[0];
  const arrow = model.connector({ source, target }, ctx); const scene = { elements: [source, target, arrow], files: {} };
  assert.equal(arrow.startBinding.elementId, source.id); assert.equal(arrow.endBinding.elementId, target.id);
  assert.ok(source.boundElements.some((b) => b.id === arrow.id && b.type === 'arrow'));
  assert.ok(target.boundElements.some((b) => b.id === arrow.id && b.type === 'arrow'));
  assert.equal(arrow.endArrowhead, 'arrow'); assert.equal(arrow.elbowed, false); assert.deepEqual(model.validateScene(scene), []);
});

test('validator rejects every broken invariant and accepts its corresponding builder output', () => {
  const ctx = seam(); const correctSticky = model.stickyNote({ text: 'ok' }, ctx); const [container, text] = model.shape({ shape: 'rectangle', text: 'ok' }, ctx);
  const other = model.shape({ shape: 'ellipse', x: 300 }, ctx)[0]; const arrow = model.connector({ source: container, target: other }, ctx);
  const correct = { elements: [...correctSticky, container, text, other, arrow, ...model.table({ rows: 2, cols: 2 }, ctx)], files: {} };
  assert.deepEqual(model.validateScene(correct), []);
  const cases = [];
  const broken = () => structuredClone(correct);
  // The sticky's face sits AFTER its shadow bands, so it is named rather than indexed.
  const stickyFaceId = correctSticky[STICKY_SHADOW_BANDS.length].id;
  let s = broken(); s.elements[0].customData.faceId = 'missing'; cases.push([s, s.elements[0].id]);
  s = broken(); s.elements.find((e) => e.id === stickyFaceId).isDeleted = true; cases.push([s, s.elements[0].id]);
  // A band glued at the wrong offset is a geometry violation, whichever band it is.
  s = broken(); s.elements[0].y += 3; cases.push([s, s.elements[0].id]);
  s = broken(); const bound = s.elements.find((e) => e.id === text.id); s.elements.find((e) => e.id === container.id).boundElements = []; cases.push([s, bound.id]);
  s = broken(); s.elements.find((e) => e.id === container.id).boundElements.push({ type: 'text', id: 'missing' }); cases.push([s, container.id]);
  s = broken(); const a = s.elements.find((e) => e.id === arrow.id); a.startBinding.elementId = 'missing'; cases.push([s, a.id]);
  s = broken(); const c = s.elements.find((e) => e.id === container.id); c.boundElements.push({ type: 'arrow', id: 'missing' }); cases.push([s, c.id]);
  s = broken(); s.elements[1].id = s.elements[0].id; cases.push([s, s.elements[0].id]);
  const badLine = model.shape({ shape: 'triangle' }, seam())[0]; badLine.points = [[0, 0]]; cases.push([{ elements: [badLine], files: {} }, badLine.id]);
  const zero = model.shape({ shape: 'rectangle' }, seam())[0]; zero.width = 0; zero.height = 0; cases.push([{ elements: [zero], files: {} }, zero.id]);
  const empty = model.textNote({ text: 'x' }, seam()); empty.text = ''; cases.push([{ elements: [empty], files: {} }, empty.id]);
  const gap = model.table({ rows: 2, cols: 2 }, seam()); gap.splice(2, 1); cases.push([{ elements: gap, files: {} }, gap[0].id]);
  for (const [scene, id] of cases) assert.ok(model.validateScene(scene).some((message) => message.includes(id)), `missing violation for ${id}`);
});

test('factory output round-trips through flattenScene', () => {
  const ctx = seam(); const elements = [];
  elements.push(...model.stickyNote({ text: 'Sticky words' }, ctx));
  elements.push(model.textNote({ x: 20, y: 400, text: 'Standalone' }, ctx));
  const [shape, label] = model.shape({ shape: 'rectangle', x: 300, y: 200, text: 'Shape label' }, ctx); elements.push(shape, label);
  const target = model.shape({ shape: 'ellipse', x: 600, y: 200 }, ctx)[0]; elements.push(target);
  elements.push(model.connector({ source: shape, target }, ctx));
  const madeImage = model.image({ x: 500, y: 500, bytes: Buffer.from('image bytes'), mimeType: 'image/png' }, ctx); elements.push(madeImage.element);
  const flat = flattenScene({ elements, files: { [madeImage.element.fileId]: madeImage.file } });
  assert.equal(flat.stickies.length, 1); assert.equal(flat.stickies[0].text, 'Sticky words');
  assert.equal(flat.texts.length, 3); assert.ok(flat.texts.some((item) => item.boundTo === shape.id)); assert.ok(flat.texts.some((item) => item.boundTo === null));
  assert.equal(flat.images[0].hasBytes, true); assert.equal(flat.images[0].mimeType, 'image/png');
  assert.equal(flat.shapes.length, 2); assert.equal(flat.shapes.find((item) => item.id === shape.id).label, 'Shape label');
  assert.equal(flat.connectors[0].startBoundTo, shape.id); assert.equal(flat.connectors[0].endBoundTo, target.id);
  assert.equal(flat.shapes.some((item) => item.id === elements[0].id), false);
});

test('determinism seam, real identity, integer seeds, and source dependency guard', () => {
  assert.deepEqual(model.stickyNote({ text: 'same' }, seam()), model.stickyNote({ text: 'same' }, seam()));
  const ids = new Set();
  for (let i = 0; i < 1000; i += 1) { const el = model.shape({ shape: 'rectangle' })[0]; ids.add(el.id); for (const key of ['seed', 'versionNonce']) { assert.equal(Number.isInteger(el[key]), true); assert.ok(el[key] >= 0 && el[key] < 2 ** 31); } }
  assert.equal(ids.size, 1000);
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared/board-model.cjs'), 'utf8');
  assert.equal(source.includes('@excalidraw'), false);
});

test('reducer is pure, marks removals, cascades sticky removal, and supports all add operations', () => {
  const initial = { type: 'excalidraw', version: 2, elements: [], files: {}, appState: {} }; const ctx = seam();
  let scene = model.applyOp(initial, { type: 'board.addSticky', text: 'note' }, ctx); assert.equal(initial.elements.length, 0);
  // The face follows its shadow bands; removing it cascades every band plus the label.
  const faceId = scene.elements[STICKY_SHADOW_BANDS.length].id;
  scene = model.applyOp(scene, { type: 'board.removeElement', elementId: faceId }, ctx);
  assert.equal(scene.elements.filter((e) => e.isDeleted).length, STICKY_SHADOW_BANDS.length + 2);
  for (const op of [{ type: 'board.addShape', shape: 'rectangle' }, { type: 'board.addText', text: 'text' }, { type: 'board.addImage', bytes: Buffer.from('x') }, { type: 'board.addTemplate', template: 'kanban' }, { type: 'board.addTemplate', template: 'matrix' }, { type: 'board.addTemplate', template: 'flowchart' }, { type: 'board.addTemplate', template: 'mindmap' }, { type: 'board.addTable', rows: 2, cols: 2 }]) scene = model.applyOp(scene, op, ctx);
  assert.ok(scene.elements.length > 20); assert.ok(Object.keys(scene.files).length === 1);
});
