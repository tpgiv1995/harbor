'use strict';

// b6 adversarial-review follow-ups for the board model:
//   M5  add-image reads intrinsic PNG/JPEG/GIF dimensions instead of 320x200
//   M6  a poly-shape label is a standalone centered text (customData.labelFor),
//       never a container binding onto a `line` element (undefined in Excalidraw)
//   M1  a label added with a container (connect --label) mirrors the binding
//   M2  rm cleans every binding it strands, for every element family
//   L2  rm of the last image referencing a file garbage-collects its bytes
//   L3  a dark fill flips a bound label to light text so it stays readable

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const model = require('../../src/shared/board-model.cjs');
const { flattenScene } = require('../../src/shared/board-view.cjs');

function seam() {
  let id = 0; let integer = 0;
  return { newId: () => `fixed-${++id}`, now: () => 1700000000000, randomInt: () => ++integer };
}

const emptyScene = () => ({ type: 'excalidraw', version: 2, elements: [], files: {}, appState: {} });

// --- M5: intrinsic image dimensions -----------------------------------------

function minimalPng(width, height) {
  // magic + IHDR chunk header + width/height; enough for a header parser and
  // exactly the bytes a real encoder puts there.
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function minimalJpeg(width, height) {
  // SOI, an APP0 to prove the marker walk skips segments, then SOF0.
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03,
  ]);
}

function minimalGif(width, height) {
  const buffer = Buffer.alloc(10);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

test('imageDimensions parses PNG IHDR, JPEG SOF, and GIF headers, and refuses noise honestly', () => {
  assert.deepEqual(model.imageDimensions(minimalPng(2560, 1400)), { width: 2560, height: 1400 });
  assert.deepEqual(model.imageDimensions(minimalJpeg(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(model.imageDimensions(minimalGif(320, 180)), { width: 320, height: 180 });
  const realPng = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'icon-16.png'));
  assert.deepEqual(model.imageDimensions(realPng), { width: 16, height: 16 });
  assert.equal(model.imageDimensions(Buffer.from('not an image')), null);
  assert.equal(model.imageDimensions(Buffer.alloc(0)), null);
  assert.equal(model.imageDimensions(Buffer.from([0xff, 0xd8, 0xff])), null);
});

test('image() defaults to intrinsic dimensions, scales a lone flag proportionally, and keeps the legacy fallback', () => {
  const intrinsic = model.image({ bytes: minimalPng(2560, 1400) }, seam());
  assert.equal(intrinsic.element.width, 2560);
  assert.equal(intrinsic.element.height, 1400);

  const scaled = model.image({ bytes: minimalPng(2560, 1400), width: 640 }, seam());
  assert.equal(scaled.element.width, 640);
  assert.equal(scaled.element.height, 350);

  const explicit = model.image({ bytes: minimalPng(2560, 1400), width: 100, height: 90 }, seam());
  assert.equal(explicit.element.width, 100);
  assert.equal(explicit.element.height, 90);

  const opaque = model.image({ bytes: Buffer.from('unparsable') }, seam());
  assert.equal(opaque.element.width, 320);
  assert.equal(opaque.element.height, 200);
});

// --- M6: poly labels are standalone text ------------------------------------

test('a poly shape label is standalone centered text tagged labelFor, never bound to the line', () => {
  const [poly, label] = model.shape({ shape: 'triangle', x: 100, y: 50, width: 200, height: 160, text: 'poly words' }, seam());
  assert.equal(poly.type, 'line');
  assert.deepEqual(poly.boundElements, []);
  assert.equal(label.containerId, null);
  assert.equal(label.customData.labelFor, poly.id);
  assert.equal(label.textAlign, 'center');
  assert.equal(label.x, poly.x + poly.width / 2 - label.width / 2);
  assert.equal(label.y, poly.y + poly.height / 2 - label.height / 2);
  assert.deepEqual(model.validateScene({ elements: [poly, label], files: {} }), []);
});

test('flattenScene pairs a labelFor text with its poly shape', () => {
  const [poly, label] = model.shape({ shape: 'hexagon', text: 'hex label' }, seam());
  const flat = flattenScene({ elements: [poly, label], files: {} });
  assert.equal(flat.shapes.find((item) => item.id === poly.id).label, 'hex label');
  assert.ok(flat.texts.some((item) => item.text === 'hex label'));
});

test('the validator rejects text bound to a line container', () => {
  const ctx = seam();
  const [poly] = model.shape({ shape: 'triangle' }, ctx);
  const label = model.textNote({ text: 'bad binding', x: 0, y: 0 }, ctx);
  label.containerId = poly.id;
  poly.boundElements = [{ type: 'text', id: label.id }];
  assert.ok(model.validateScene({ elements: [poly, label], files: {} })
    .some((message) => message.includes(label.id) && /line/.test(message)));
});

test('setText, moveElement, and removeElement all follow a poly label through labelFor', () => {
  const ctx = seam();
  let scene = model.applyOp(emptyScene(), { type: 'board.addShape', shape: 'triangle', x: 0, y: 0, width: 200, height: 160 }, ctx);
  const poly = scene.elements[0];

  // setText on an unlabeled poly creates a standalone labelFor label (H3's rule, poly flavor).
  scene = model.applyOp(scene, { type: 'board.setText', elementId: poly.id, text: 'made later' }, ctx);
  let label = scene.elements.find((e) => e.customData?.labelFor === poly.id && !e.isDeleted);
  assert.ok(label, 'setText created a labelFor label');
  assert.equal(label.containerId, null);
  assert.equal(label.originalText, 'made later');
  assert.deepEqual(model.validateScene(scene), []);

  // setText again updates the same label rather than stacking a second one.
  scene = model.applyOp(scene, { type: 'board.setText', elementId: poly.id, text: 'updated' }, ctx);
  const labels = scene.elements.filter((e) => e.customData?.labelFor === poly.id && !e.isDeleted);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].originalText, 'updated');

  // move keeps the label centered on the moved poly.
  scene = model.applyOp(scene, { type: 'board.moveElement', elementId: poly.id, x: 500, y: 400 }, ctx);
  const moved = scene.elements.find((e) => e.id === poly.id);
  label = scene.elements.find((e) => e.customData?.labelFor === poly.id && !e.isDeleted);
  assert.equal(label.x, moved.x + moved.width / 2 - label.width / 2);
  assert.equal(label.y, moved.y + moved.height / 2 - label.height / 2);

  // rm the poly takes the label with it.
  scene = model.applyOp(scene, { type: 'board.removeElement', elementId: poly.id }, ctx);
  assert.equal(scene.elements.find((e) => e.id === poly.id).isDeleted, true);
  assert.equal(scene.elements.filter((e) => e.customData?.labelFor === poly.id && !e.isDeleted).length, 0);
  assert.deepEqual(model.validateScene(scene), []);
});

// --- H5: connectors terminate at side-midpoint anchors, Miro-style ----------

const sideAnchors = (el) => ([
  [el.x + el.width / 2, el.y],
  [el.x + el.width, el.y + el.height / 2],
  [el.x + el.width / 2, el.y + el.height],
  [el.x, el.y + el.height / 2],
]);

test('a connector runs anchor to anchor for all four relative positions, never center to center', () => {
  const box = { width: 100, height: 60 };
  const cases = [
    // target to the RIGHT: source right-edge midpoint to target left-edge midpoint
    { tx: 400, ty: 0, from: [100, 30], to: [400, 30] },
    // target to the LEFT
    { tx: -400, ty: 0, from: [0, 30], to: [-300, 30] },
    // target BELOW: source bottom to target top
    { tx: 0, ty: 300, from: [50, 60], to: [50, 300] },
    // target ABOVE
    { tx: 0, ty: -300, from: [50, 0], to: [50, -240] },
  ];
  for (const c of cases) {
    const ctx = seam();
    const source = model.shape({ shape: 'rectangle', x: 0, y: 0, ...box }, ctx)[0];
    const target = model.shape({ shape: 'rectangle', x: c.tx, y: c.ty, ...box }, ctx)[0];
    const arrow = model.connector({ source, target }, ctx);
    assert.deepEqual([arrow.x, arrow.y], c.from, `start anchor for target at ${c.tx},${c.ty}`);
    const last = arrow.points.at(-1);
    assert.deepEqual([arrow.x + last[0], arrow.y + last[1]], c.to, `end anchor for target at ${c.tx},${c.ty}`);
    // Bindings survive the anchoring, so drags in the app keep it attached.
    assert.equal(arrow.startBinding.elementId, source.id);
    assert.equal(arrow.endBinding.elementId, target.id);
  }
});

test('explicit endpoint coordinates still override the anchor pick', () => {
  const ctx = seam();
  const source = model.shape({ shape: 'rectangle', x: 0, y: 0 }, ctx)[0];
  const target = model.shape({ shape: 'rectangle', x: 400, y: 0 }, ctx)[0];
  const arrow = model.connector({ source, target, x: 5, y: 6, endX: 305, endY: 6 }, ctx);
  assert.equal(arrow.x, 5);
  assert.equal(arrow.y, 6);
  assert.deepEqual(arrow.points.at(-1), [300, 0]);
});

test('every mindmap template arrow starts and ends on a side-midpoint anchor of its bound shapes', () => {
  const ctx = seam();
  const scene = model.applyOp(emptyScene(), { type: 'board.addTemplate', template: 'mindmap', x: 100, y: 100 }, ctx);
  const byId = new Map(scene.elements.map((el) => [el.id, el]));
  const arrows = scene.elements.filter((el) => el.type === 'arrow');
  assert.ok(arrows.length >= 4, `mindmap has spokes (saw ${arrows.length})`);
  const onAnchor = (el, x, y) => sideAnchors(el).some(([ax, ay]) => Math.abs(ax - x) < 0.01 && Math.abs(ay - y) < 0.01);
  for (const arrow of arrows) {
    const source = byId.get(arrow.startBinding?.elementId);
    const target = byId.get(arrow.endBinding?.elementId);
    assert.ok(source && target, `${arrow.id} is bound both ends`);
    const last = arrow.points.at(-1);
    assert.ok(onAnchor(source, arrow.x, arrow.y), `${arrow.id} starts on a source anchor (got ${arrow.x},${arrow.y})`);
    assert.ok(onAnchor(target, arrow.x + last[0], arrow.y + last[1]), `${arrow.id} ends on a target anchor`);
    // The line must not pass THROUGH the source body: its start is on the
    // source edge nearest the target, so the segment leaves the box at once.
    const scx = source.x + source.width / 2; const scy = source.y + source.height / 2;
    assert.ok(!(Math.abs(arrow.x - scx) < 0.01 && Math.abs(arrow.y - scy) < 0.01), `${arrow.id} starts at the source center`);
  }
});

// --- M1: connect --label mirrors its container binding ----------------------

test('addText with a connector container mirrors the binding and centers on the arrow midpoint', () => {
  const ctx = seam();
  let scene = emptyScene();
  scene = model.applyOp(scene, { type: 'board.addShape', shape: 'rectangle', x: 0, y: 0 }, ctx);
  scene = model.applyOp(scene, { type: 'board.addShape', shape: 'ellipse', x: 400, y: 0 }, ctx);
  const [source, target] = scene.elements;
  scene = model.applyOp(scene, { type: 'board.connect', sourceId: source.id, targetId: target.id }, ctx);
  const arrow = scene.elements.find((e) => e.type === 'arrow');
  scene = model.applyOp(scene, { type: 'board.addText', text: 'Next', container: arrow }, ctx);

  const label = scene.elements.find((e) => e.type === 'text');
  const boundArrow = scene.elements.find((e) => e.id === arrow.id);
  assert.equal(label.containerId, arrow.id);
  assert.ok(boundArrow.boundElements.some((b) => b.type === 'text' && b.id === label.id), 'the arrow mirrors its label binding');
  // The label sits at the arrow's midpoint, not the box-container offset formula.
  const xs = arrow.points.map((p) => p[0]); const ys = arrow.points.map((p) => p[1]);
  const midX = arrow.x + (Math.min(...xs) + Math.max(...xs)) / 2;
  const midY = arrow.y + (Math.min(...ys) + Math.max(...ys)) / 2;
  assert.equal(label.x, midX - label.width / 2);
  assert.equal(label.y, midY - label.height / 2);
  assert.deepEqual(model.validateScene(scene), []);
});

// --- M2: rm strands nothing -------------------------------------------------

function connectedScene(ctx) {
  let scene = emptyScene();
  scene = model.applyOp(scene, { type: 'board.addShape', shape: 'ellipse', x: 0, y: 0, text: 'labeled ellipse' }, ctx);
  scene = model.applyOp(scene, { type: 'board.addShape', shape: 'rectangle', x: 400, y: 0 }, ctx);
  const ellipse = scene.elements.find((e) => e.type === 'ellipse');
  const rect = scene.elements.find((e) => e.type === 'rectangle');
  scene = model.applyOp(scene, { type: 'board.connect', sourceId: ellipse.id, targetId: rect.id }, ctx);
  return { scene, ellipse, rect, arrow: scene.elements.find((e) => e.type === 'arrow') };
}

test('rm a labeled, connected ellipse deletes its label and detaches the arrow binding', () => {
  const ctx = seam();
  const { scene, ellipse, rect, arrow } = connectedScene(ctx);
  const after = model.applyOp(scene, { type: 'board.removeElement', elementId: ellipse.id }, ctx);
  assert.equal(after.elements.find((e) => e.id === ellipse.id).isDeleted, true);
  const label = after.elements.find((e) => e.type === 'text' && e.containerId === ellipse.id);
  assert.equal(label.isDeleted, true, 'the non-rectangle label cascades too');
  const survivingArrow = after.elements.find((e) => e.id === arrow.id);
  assert.equal(survivingArrow.startBinding, null, 'the arrow no longer points at a deleted element');
  assert.equal(survivingArrow.endBinding.elementId, rect.id);
  assert.deepEqual(model.validateScene(after), []);
});

test('rm an arrow removes it from both endpoints boundElements', () => {
  const ctx = seam();
  const { scene, ellipse, rect, arrow } = connectedScene(ctx);
  const after = model.applyOp(scene, { type: 'board.removeElement', elementId: arrow.id }, ctx);
  for (const id of [ellipse.id, rect.id]) {
    const endpoint = after.elements.find((e) => e.id === id);
    assert.equal(endpoint.boundElements.some((b) => b.id === arrow.id), false, `${id} still names the deleted arrow`);
  }
  assert.deepEqual(model.validateScene(after), []);
});

test('rm a bound label directly unmirrors its container', () => {
  const ctx = seam();
  let scene = model.applyOp(emptyScene(), { type: 'board.addShape', shape: 'rectangle', text: 'doomed label' }, ctx);
  const label = scene.elements.find((e) => e.type === 'text');
  const container = scene.elements.find((e) => e.type === 'rectangle');
  scene = model.applyOp(scene, { type: 'board.removeElement', elementId: label.id }, ctx);
  assert.equal(scene.elements.find((e) => e.id === label.id).isDeleted, true);
  assert.deepEqual(scene.elements.find((e) => e.id === container.id).boundElements, []);
  assert.deepEqual(model.validateScene(scene), []);
});

test('setText creating a label on a CONNECTED shape keeps the arrow mirror intact', () => {
  const ctx = seam();
  let scene = emptyScene();
  scene = model.applyOp(scene, { type: 'board.addShape', shape: 'rectangle', x: 0, y: 0 }, ctx);
  scene = model.applyOp(scene, { type: 'board.addShape', shape: 'ellipse', x: 400, y: 0 }, ctx);
  const [rect, ellipse] = scene.elements;
  scene = model.applyOp(scene, { type: 'board.connect', sourceId: rect.id, targetId: ellipse.id }, ctx);
  const arrow = scene.elements.find((e) => e.type === 'arrow');
  scene = model.applyOp(scene, { type: 'board.setText', elementId: rect.id, text: 'late label' }, ctx);
  const host = scene.elements.find((e) => e.id === rect.id);
  assert.ok(host.boundElements.some((b) => b.type === 'arrow' && b.id === arrow.id), 'the arrow mirror survived the label');
  assert.ok(host.boundElements.some((b) => b.type === 'text'), 'the label bound');
  assert.deepEqual(model.validateScene(scene), []);
});

// --- L2: image bytes are garbage-collected ----------------------------------

test('rm of the last image referencing a file drops its bytes; a shared file survives', () => {
  const ctx = seam();
  let scene = model.applyOp(emptyScene(), { type: 'board.addImage', bytes: minimalPng(8, 8) }, ctx);
  scene = model.applyOp(scene, { type: 'board.addImage', bytes: minimalPng(8, 8), x: 100 }, ctx);
  const [first, second] = scene.elements;
  assert.equal(first.fileId, second.fileId, 'identical bytes dedupe to one file');
  assert.equal(Object.keys(scene.files).length, 1);

  scene = model.applyOp(scene, { type: 'board.removeElement', elementId: first.id }, ctx);
  assert.equal(Object.keys(scene.files).length, 1, 'a file still referenced by a live image survives');
  scene = model.applyOp(scene, { type: 'board.removeElement', elementId: second.id }, ctx);
  assert.equal(Object.keys(scene.files).length, 0, 'the last reference takes the bytes with it');
});

// --- L3: label contrast follows the fill ------------------------------------

test('setColor to a dark fill flips a bound label to light text, and back', () => {
  const ctx = seam();
  let scene = model.applyOp(emptyScene(), { type: 'board.addSticky', text: 'read me' }, ctx);
  const face = scene.elements.find((e) => e.type === 'rectangle' && !e.customData?.stickyShadow);
  scene = model.applyOp(scene, { type: 'board.setColor', elementId: face.id, backgroundColor: '#151515' }, ctx);
  let label = scene.elements.find((e) => e.type === 'text' && e.containerId === face.id);
  assert.equal(label.strokeColor, '#ffffff', 'dark fill gets light text');
  scene = model.applyOp(scene, { type: 'board.setColor', elementId: face.id, backgroundColor: '#ffe86d' }, ctx);
  label = scene.elements.find((e) => e.type === 'text' && e.containerId === face.id);
  assert.equal(label.strokeColor, '#1a1a1a', 'light fill gets dark text');
});
