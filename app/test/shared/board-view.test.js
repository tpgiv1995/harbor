'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { flattenScene, sceneImages, extForMime } = require('../../src/shared/board-view.cjs');

// A 1x1 transparent PNG as a data URL, so sceneImages has real base64 to decode.
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function scene(elements, files = {}) {
  return { type: 'excalidraw', version: 2, elements, files };
}

test('every text and image is surfaced, deleted and shadow elements are not', () => {
  const flat = flattenScene(scene([
    { id: 'face1', type: 'rectangle', x: 10, y: 10, width: 180, height: 180, backgroundColor: '#fff79e' },
    { id: 'shadow1', type: 'rectangle', x: 15, y: 17, customData: { stickyShadow: true, faceId: 'face1' } },
    { id: 'label1', type: 'text', text: 'sticky words', containerId: 'face1', x: 20, y: 20 },
    { id: 'loose1', type: 'text', text: 'floating note', x: 500, y: 40 },
    { id: 'img1', type: 'image', fileId: 'f1', x: 0, y: 300, width: 400, height: 300 },
    { id: 'gone', type: 'text', text: 'deleted', isDeleted: true, x: 0, y: 0 },
  ], { f1: { mimeType: 'image/png', dataURL: PNG_1x1 } }));

  // both texts present (bound + loose), the deleted one absent
  assert.equal(flat.texts.length, 2);
  assert.deepEqual(flat.texts.map((t) => t.text).sort(), ['floating note', 'sticky words']);
  // the shadow never appears as content
  assert.ok(!flat.shapes.some((s) => s.id === 'shadow1'));
  assert.ok(!flat.stickies.some((s) => s.id === 'shadow1'));
  // the image is surfaced with its mime type resolved from files
  assert.equal(flat.images.length, 1);
  assert.equal(flat.images[0].mimeType, 'image/png');
  assert.equal(flat.images[0].hasBytes, true);
});

test('a face named by a shadow becomes a sticky carrying its bound text', () => {
  const flat = flattenScene(scene([
    { id: 'face1', type: 'rectangle', x: 10, y: 10, width: 180, height: 180, backgroundColor: '#fff79e' },
    { id: 'shadow1', type: 'rectangle', x: 15, y: 17, customData: { stickyShadow: true, faceId: 'face1' } },
    { id: 'label1', type: 'text', text: 'fix this header', containerId: 'face1', x: 20, y: 20 },
  ]));
  assert.equal(flat.stickies.length, 1);
  assert.equal(flat.stickies[0].text, 'fix this header');
  assert.equal(flat.stickies[0].color, '#fff79e');
  // it is a sticky, not a plain shape
  assert.equal(flat.shapes.length, 0);
});

test('a plain shape with bound text reports the label but stays a shape', () => {
  const flat = flattenScene(scene([
    { id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, backgroundColor: '#a5d8ff', strokeColor: '#1e1e1e' },
    { id: 'boxlabel', type: 'text', text: 'Step 1', containerId: 'box', x: 5, y: 5 },
  ]));
  assert.equal(flat.stickies.length, 0);
  assert.equal(flat.shapes.length, 1);
  assert.equal(flat.shapes[0].label, 'Step 1');
});

test('connectors capture start and end bindings and any label', () => {
  const flat = flattenScene(scene([
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 },
    { id: 'b', type: 'rectangle', x: 200, y: 0, width: 50, height: 50 },
    { id: 'arr', type: 'arrow', points: [[0, 0], [150, 0]], startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } },
  ]));
  assert.equal(flat.connectors.length, 1);
  assert.equal(flat.connectors[0].startBoundTo, 'a');
  assert.equal(flat.connectors[0].endBoundTo, 'b');
});

test('sceneImages decodes base64 data URLs and skips undecodable ones', () => {
  const imgs = sceneImages(scene([
    { id: 'img1', type: 'image', fileId: 'f1', x: 0, y: 0, width: 10, height: 10 },
  ], {
    f1: { mimeType: 'image/png', dataURL: PNG_1x1 },
    f2: { mimeType: 'image/svg+xml', dataURL: 'data:image/svg+xml,%3Csvg/%3E' }, // not base64
  }));
  const png = imgs.find((i) => i.fileId === 'f1');
  const svg = imgs.find((i) => i.fileId === 'f2');
  assert.equal(png.isBase64, true);
  assert.ok(Buffer.from(png.data, 'base64').length > 0);
  assert.equal(png.placed.id, 'img1'); // paired with the placed element
  assert.equal(svg.isBase64, false); // present but flagged as not base64-decodable
});

test('extForMime maps known types and falls back to bin', () => {
  assert.equal(extForMime('image/png'), 'png');
  assert.equal(extForMime('image/jpeg'), 'jpg');
  assert.equal(extForMime('application/x-weird'), 'bin');
});
