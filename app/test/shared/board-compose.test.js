'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { composeBoard } = require('../../src/shared/board-compose.cjs');
const boardModel = require('../../src/shared/board-model.cjs');
const { flattenScene } = require('../../src/shared/board-view.cjs');

const DEFAULT_SECTIONS = ['Ideas', 'Risks', 'Decisions', 'Actions'];

function emptyScene() {
  return { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} };
}

function seam() {
  let id = 0;
  return {
    newId: () => `compose-${String(++id).padStart(3, '0')}`,
    now: () => 1700000000000,
    randomInt: () => 7,
  };
}

function applyAll(ops) {
  const ctx = seam();
  let scene = emptyScene();
  for (const op of ops) scene = boardModel.applyOp(scene, op, ctx);
  return scene;
}

test('composeBoard returns reducer operations that apply cleanly', () => {
  const ops = composeBoard({ topic: 'Quarterly planning' });
  assert.ok(Array.isArray(ops));
  assert.ok(ops.length > 0);
  assert.ok(ops.every((op) => op && typeof op.type === 'string' && op.type.startsWith('board.')));

  let scene;
  assert.doesNotThrow(() => { scene = applyAll(ops); });
  assert.equal(scene.elements[0].id, 'compose-001');
  assert.ok(scene.elements.every((element) => element.updated === 1700000000000));
});

test('default composition contains the title, mind map, note zones, and discussion region', () => {
  const topic = 'Launch retrospective';
  const ops = composeBoard({ topic });
  const scene = applyAll(ops);

  assert.ok(ops.some((op) => op.type === 'board.addText' && op.text === topic));
  assert.ok(ops.some((op) => op.type === 'board.addTemplate' && op.template === 'mindmap'));
  assert.equal(ops.filter((op) => op.type === 'board.addSticky').length, DEFAULT_SECTIONS.length);
  for (const section of DEFAULT_SECTIONS) {
    assert.ok(ops.some((op) => op.type === 'board.addText' && op.text === section));
  }
  assert.ok(ops.some((op) => op.type === 'board.addShape' && op.text === 'Discussion'));

  const text = scene.elements.map((element) => element.originalText).filter(Boolean);
  assert.ok(text.includes(topic));
  assert.ok(text.includes('Central idea'));
  assert.ok(text.includes('Discussion'));
});

test('flattenScene surfaces deterministic content counts', () => {
  const flat = flattenScene(applyAll(composeBoard({ topic: 'Product ideas' })));

  assert.equal(flat.stickies.length, 4);
  assert.equal(flat.texts.length, 11);
  assert.equal(flat.shapes.length, 6);
  assert.equal(flat.connectors.length, 4);
  assert.equal(flat.images.length, 0);
  assert.deepEqual(flat.stickies.map((sticky) => sticky.text), ['', '', '', '']);
});

test('an unknown --diagram errors with the valid names instead of silently composing a mindmap', () => {
  // The CLI's never-guess posture: add-template errors on an unknown name, and
  // compose must not be the one command that quietly substitutes a default.
  assert.throws(() => composeBoard({ topic: 'T', diagram: 'bogus' }), /unknown diagram "bogus".*kanban.*matrix.*flowchart.*mindmap/s);
  // An OMITTED diagram still defaults to mindmap; only a wrong one refuses.
  assert.ok(composeBoard({ topic: 'T' }).some((op) => op.type === 'board.addTemplate' && op.template === 'mindmap'));
});
