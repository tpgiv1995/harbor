'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', '..', '..', 'bin', 'harbor-board');
const { flattenScene } = require('../../src/shared/board-view.cjs');
const { createBoardExport } = require('../../src/main/providers/board-export.js');
const { main: boardMain } = require('../../../bin/harbor-board');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-board-write-'));
  const board = {
    type: 'excalidraw', version: 2, source: 'test', name: 'Write Test',
    updatedAt: new Date(0).toISOString(), elements: [], appState: {}, files: {},
  };
  fs.writeFileSync(path.join(dir, 'write-test.json'), `${JSON.stringify(board)}\n`);
  return dir;
}

function run(dir, args) {
  const env = { ...process.env, HARBOR_BOARDS_DIR: dir };
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30000 });
  assert.equal(result.status, 0, `${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  return result;
}

function json(dir, args) {
  const result = run(dir, [...args, '--json']);
  assert.ok(result.stdout.trim(), `${args.join(' ')} produced no JSON output: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('write commands compose a board and export it without touching the real store', async (t) => {
  const dir = sandbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sticky = json(dir, ['add-sticky', 'Write Test', '--text', 'First note', '--color', 'yellow', '--x', '20', '--y', '30']);
  const shape = json(dir, ['add-shape', 'write-test', '--shape', 'rectangle', '--text', 'Original shape', '--x', '400', '--y', '30']);
  json(dir, ['add-template', 'write-test', '--template', 'kanban', '--x', '20', '--y', '300']);
  const arrow = json(dir, ['connect', 'write-test', '--from', sticky.id, '--to', shape.id, '--label', 'Next']);
  json(dir, ['set-text', 'write-test', '--id', shape.id, '--text', 'Changed shape']);

  assert.ok(sticky.id);
  assert.ok(shape.id);
  assert.ok(arrow.id);
  const scene = JSON.parse(fs.readFileSync(path.join(dir, 'write-test.json'), 'utf8'));
  const flat = flattenScene(scene);
  assert.equal(flat.stickies.some((item) => item.text === 'First note'), true);
  assert.equal(flat.shapes.some((item) => item.label === 'Changed shape'), true);
  assert.ok(flat.shapes.length >= 4, 'the shape and kanban template are present');
  assert.equal(flat.connectors.some((item) => item.id === arrow.id), true);
  assert.equal(flat.connectors.some((item) => item.label === 'Next'), true);

  const outFile = path.join(dir, 'board.png');
  const previousDir = process.env.HARBOR_BOARDS_DIR;
  process.env.HARBOR_BOARDS_DIR = dir;
  let output = '';
  const oldLog = console.log;
  console.log = (value) => { output += `${value}\n`; };
  try {
    const exporter = createBoardExport({
      dir,
      captureScene: async () => Buffer.from('test png'),
    });
    await boardMain(
      ['export', 'write-test', '--format', 'png', '--out', outFile, '--json'],
      { exportBoard: (args) => exporter.exportBoard(args) },
    );
  } finally {
    console.log = oldLog;
    if (previousDir === undefined) delete process.env.HARBOR_BOARDS_DIR;
    else process.env.HARBOR_BOARDS_DIR = previousDir;
  }
  const exported = JSON.parse(output);
  assert.equal(exported.outFile, outFile);
  assert.ok(fs.statSync(outFile).size > 0);

  const listed = json(dir, ['list']);
  assert.equal(listed.count, 1);
  assert.equal(json(dir, ['show', 'Write Test']).id, 'write-test');
  assert.match(run(dir, ['dir']).stdout, new RegExp(dir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  assert.equal(json(dir, ['export-images', 'write-test', '--out', path.join(dir, 'images')]).count, 0);
});

function fail(dir, args) {
  const env = { ...process.env, HARBOR_BOARDS_DIR: dir };
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30000 });
  assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded:\n${result.stdout}`);
  return result;
}

function boardBytes(dir) {
  return fs.readFileSync(path.join(dir, 'write-test.json'), 'utf8');
}

test('M3: an op that would corrupt the board is refused and the file is untouched', (t) => {
  const dir = sandbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sticky = json(dir, ['add-sticky', 'write-test', '--text', 'guarded', '--x', '10', '--y', '10']);
  const scene = JSON.parse(boardBytes(dir));
  const shadow = scene.elements.find((el) => el.customData && el.customData.stickyShadow && el.customData.faceId === sticky.id);
  assert.ok(shadow, 'the sticky has a shadow');
  const before = boardBytes(dir);
  // Moving the SHADOW alone desyncs it from its face, a state validateScene
  // names; the CLI must refuse the write rather than persist the corruption.
  const refused = fail(dir, ['move', 'write-test', '--id', shadow.id, '--x', '900', '--y', '900']);
  assert.match(refused.stderr, /refusing to write/);
  assert.match(refused.stderr, /sticky shadow/);
  assert.equal(boardBytes(dir), before, 'a refused write leaves the file byte-identical');
});

test('M3: a pre-broken board still accepts a harmless add, with a warning naming what was found', (t) => {
  const dir = sandbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scene = JSON.parse(boardBytes(dir));
  // A dangling container binding, the shape an outside editor can leave.
  scene.elements.push({
    id: 'orphan-label', type: 'text', x: 0, y: 0, width: 50, height: 27, angle: 0,
    strokeColor: '#1a1a1a', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1,
    strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, index: null,
    roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: [],
    updated: 1, link: null, locked: false, text: 'orphan', fontSize: 20, fontFamily: 6,
    textAlign: 'center', verticalAlign: 'middle', containerId: 'no-such-element',
    originalText: 'orphan', autoResize: true, lineHeight: 1.35,
  });
  fs.writeFileSync(path.join(dir, 'write-test.json'), `${JSON.stringify(scene)}\n`);
  const env = { ...process.env, HARBOR_BOARDS_DIR: dir };
  const result = spawnSync(process.execPath, [CLI, 'add-sticky', 'write-test', '--text', 'still lands', '--json'], { encoding: 'utf8', env, timeout: 30000 });
  assert.equal(result.status, 0, `add to a pre-broken board failed:\n${result.stderr}`);
  assert.match(result.stderr, /pre-existing/);
  const after = JSON.parse(boardBytes(dir));
  assert.ok(after.elements.some((el) => el.type === 'text' && el.originalText === 'still lands'));
});

test('L4: table dimensions are capped with an honest refusal', (t) => {
  const dir = sandbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = boardBytes(dir);
  const refused = fail(dir, ['add-table', 'write-test', '--rows', '1000', '--cols', '1000']);
  assert.match(refused.stderr, /at most/);
  assert.equal(boardBytes(dir), before);
  const ok = json(dir, ['add-table', 'write-test', '--rows', '3', '--cols', '4']);
  assert.equal(ok.ids.length, 12);
});

test('M5: add-image defaults to intrinsic dimensions and scales a lone --width proportionally', (t) => {
  const dir = sandbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A PNG header claiming 300x150 is all the parser reads.
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(300, 16);
  png.writeUInt32BE(150, 20);
  const file = path.join(dir, 'probe.png');
  fs.writeFileSync(file, png);

  const intrinsic = json(dir, ['add-image', 'write-test', '--file', file]);
  const scaled = json(dir, ['add-image', 'write-test', '--file', file, '--width', '100', '--x', '500']);
  const scene = JSON.parse(boardBytes(dir));
  const first = scene.elements.find((el) => el.id === intrinsic.id);
  const second = scene.elements.find((el) => el.id === scaled.id);
  assert.equal(first.width, 300);
  assert.equal(first.height, 150);
  assert.equal(second.width, 100);
  assert.equal(second.height, 50);
});
