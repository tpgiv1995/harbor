'use strict';

const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeFormat,
  deriveOutFile,
  findFrame,
  planExport,
  createBoardExport,
  resolveElectronBinary,
  runnerEnv,
  exportPagePath,
  EXPORT_PAGE_HINT,
} = require('../../src/main/providers/board-export.js');
const { createWhiteboardStore } = require('../../src/main/providers/whiteboard.js');

function scene(elements = [], files = {}, appState = {}) {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'local',
    name: 'Test board',
    elements,
    appState,
    files,
  };
}

function frame(id, name, extras = {}) {
  return {
    id,
    type: 'frame',
    name,
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    angle: 0,
    strokeColor: '#bbb',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...extras,
  };
}

function rect(id, frameId = null) {
  return {
    id,
    type: 'rectangle',
    x: 10,
    y: 10,
    width: 80,
    height: 40,
    angle: 0,
    strokeColor: '#000',
    backgroundColor: '#fff',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

test('normalizeFormat accepts png and pdf only', () => {
  assert.equal(normalizeFormat('png'), 'png');
  assert.equal(normalizeFormat('PNG'), 'png');
  assert.equal(normalizeFormat('pdf'), 'pdf');
  assert.equal(normalizeFormat('Pdf'), 'pdf');
  assert.throws(() => normalizeFormat('svg'), /png|pdf/i);
  assert.throws(() => normalizeFormat(''), /png|pdf/i);
  assert.throws(() => normalizeFormat(null), /png|pdf/i);
});

test('deriveOutFile keeps an explicit path and forces the format extension', () => {
  const png = deriveOutFile({ outFile: 'C:\\tmp\\board.png', id: 'ideas', format: 'png' });
  assert.equal(png, path.resolve('C:\\tmp\\board.png'));

  const swapped = deriveOutFile({ outFile: '/tmp/board.png', id: 'ideas', format: 'pdf' });
  assert.equal(swapped, path.resolve('/tmp/board.pdf'));

  const bare = deriveOutFile({ outFile: '/tmp/out', id: 'ideas', format: 'png' });
  assert.equal(bare, path.resolve('/tmp/out.png'));
});

test('deriveOutFile invents a path from the board id when outFile is omitted', () => {
  const cwd = process.cwd();
  const out = deriveOutFile({ id: 'ideas-and-images', format: 'pdf' });
  assert.equal(out, path.join(cwd, 'ideas-and-images.pdf'));
});

test('findFrame matches by id or unique name fragment', () => {
  const elements = [
    frame('frame-a', 'Sprint plan'),
    frame('frame-b', 'Risk wall'),
    rect('r1', 'frame-a'),
  ];
  assert.equal(findFrame(elements, 'frame-a').id, 'frame-a');
  assert.equal(findFrame(elements, 'risk').id, 'frame-b');
  assert.equal(findFrame(elements, 'Sprint plan').name, 'Sprint plan');
  assert.equal(findFrame(elements, null), null);
  assert.equal(findFrame(elements, ''), null);
});

test('findFrame refuses an ambiguous name and a miss', () => {
  const elements = [
    frame('frame-a', 'Plan A'),
    frame('frame-b', 'Plan B'),
  ];
  assert.throws(() => findFrame(elements, 'Plan'), /matches .* frames/i);
  assert.throws(() => findFrame(elements, 'missing'), /no frame matches/i);
});

test('findFrame ignores deleted frames', () => {
  const elements = [
    frame('gone', 'Old', { isDeleted: true }),
    frame('live', 'Old wall'),
  ];
  assert.equal(findFrame(elements, 'Old').id, 'live');
});

test('planExport selects the whole board or a named frame', () => {
  const board = scene([
    frame('frame-a', 'Sprint'),
    rect('inside', 'frame-a'),
    rect('outside', null),
  ]);
  const whole = planExport({ id: 'ideas', format: 'png', outFile: '/tmp/a.png', scene: board });
  assert.equal(whole.ok, true);
  assert.equal(whole.format, 'png');
  assert.equal(whole.outFile, path.resolve('/tmp/a.png'));
  assert.equal(whole.exportingFrame, null);
  assert.equal(whole.elements.length, 3);

  const framed = planExport({
    id: 'ideas',
    frame: 'Sprint',
    format: 'pdf',
    outFile: '/tmp/a.png',
    scene: board,
  });
  assert.equal(framed.ok, true);
  assert.equal(framed.format, 'pdf');
  assert.equal(framed.outFile, path.resolve('/tmp/a.pdf'));
  assert.equal(framed.exportingFrame.id, 'frame-a');
  assert.equal(framed.elements.length, 3, 'Excalidraw filters by exportingFrame; keep the full element list');
});

test('planExport refuses a bad format without throwing', () => {
  const board = scene([rect('r1')]);
  const bad = planExport({ id: 'x', format: 'svg', scene: board });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /png|pdf/i);
});

test('exportBoard writes PNG via the injected capturer and PDF via the pdf writer', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-board-export-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createWhiteboardStore({ dir, now: () => Date.parse('2026-08-29T12:00:00.000Z') });
  const created = await store.create({ name: 'Export Me' });
  await store.write({
    id: created.board.id,
    scene: scene([
      frame('f1', 'Alpha'),
      rect('r1', 'f1'),
    ]),
  });

  const captures = [];
  const pdfs = [];
  const exporter = createBoardExport({
    store,
    captureScene: async (payload) => {
      captures.push(payload);
      return Buffer.from('fake-png-bytes');
    },
    writePdf: async (png, outFile) => {
      pdfs.push({ png: png.toString(), outFile });
      await fs.writeFile(outFile, Buffer.from(`%PDF-fake\n${png.toString()}`));
    },
  });

  const pngOut = path.join(dir, 'board.png');
  const pngResult = await exporter.exportBoard({
    id: created.board.id,
    format: 'png',
    outFile: pngOut,
  });
  assert.equal(pngResult.ok, true);
  assert.equal(pngResult.format, 'png');
  assert.equal(pngResult.outFile, pngOut);
  assert.equal(await fs.readFile(pngOut, 'utf8'), 'fake-png-bytes');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].exportingFrame, null);
  assert.equal(captures[0].elements.some((el) => el.id === 'r1'), true);

  const pdfOut = path.join(dir, 'frame.pdf');
  const pdfResult = await exporter.exportBoard({
    id: created.board.id,
    frame: 'Alpha',
    format: 'pdf',
    outFile: pdfOut,
  });
  assert.equal(pdfResult.ok, true);
  assert.equal(pdfResult.format, 'pdf');
  assert.equal(pdfs.length, 1);
  assert.equal(pdfs[0].outFile, pdfOut);
  assert.equal(captures[1].exportingFrame.id, 'f1');
  assert.match(await fs.readFile(pdfOut, 'utf8'), /^%PDF-fake/);
});

// The capture runs in a SPAWNED Electron child (a hidden window running the
// vite-bundled export page), because the CLI is invoked under plain node where
// no BrowserWindow exists, and because dynamic-importing Excalidraw's prod ESM
// into a Blink page dies on 18 bare specifiers (react, roughjs/bin/rough,
// open-color, @excalidraw/laser-pointer, ...) no page can resolve without an
// import map. These specs pin the pure decisions of that spawn path.

test('resolveElectronBinary: env pin wins, node gets the npm path, electron gets execPath, absence refuses', () => {
  assert.equal(
    resolveElectronBinary({ env: { HARBOR_ELECTRON_BIN: 'C:\\pin\\electron.exe' }, electronModule: 'ignored' }),
    'C:\\pin\\electron.exe',
  );
  // plain node: the electron npm package's export IS the path to the binary
  assert.equal(
    resolveElectronBinary({ env: {}, electronModule: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe' }),
    'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
  );
  // full Electron: require('electron') is the API object and we ARE the binary
  assert.equal(
    resolveElectronBinary({ env: {}, electronModule: { BrowserWindow: function BrowserWindow() {} }, execPath: 'C:\\apps\\electron.exe' }),
    'C:\\apps\\electron.exe',
  );
  assert.equal(resolveElectronBinary({ env: {}, electronModule: null }), null);
  assert.equal(resolveElectronBinary({ env: {}, electronModule: '' }), null);
});

test('runnerEnv strips ELECTRON_RUN_AS_NODE and preserves the rest', () => {
  const base = { PATH: 'C:\\bin', ELECTRON_RUN_AS_NODE: '1', HARBOR_BOARDS_DIR: 'D:\\boards' };
  const env = runnerEnv(base);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined, 'a child spawned with ELECTRON_RUN_AS_NODE comes up as plain node with no BrowserWindow');
  assert.equal(env.PATH, 'C:\\bin');
  assert.equal(env.HARBOR_BOARDS_DIR, 'D:\\boards');
  assert.equal(base.ELECTRON_RUN_AS_NODE, '1', 'the caller env is never mutated');
});

test('exportPagePath points at the built export page and the hint names the build', () => {
  const page = exportPagePath();
  assert.equal(path.basename(page), 'export.html');
  assert.equal(path.basename(path.dirname(page)), 'dist');
  assert.match(EXPORT_PAGE_HINT, /npm run build/);
});

test('the export page pins an ABSOLUTE EXCALIDRAW_ASSET_PATH before the module loads', () => {
  const source = fsSync.readFileSync(path.join(__dirname, '../../export.html'), 'utf8');
  const assetIdx = source.indexOf('EXCALIDRAW_ASSET_PATH');
  const moduleIdx = source.indexOf('type="module"');
  assert.ok(assetIdx > -1, 'export.html must set EXCALIDRAW_ASSET_PATH');
  assert.ok(moduleIdx > -1, 'export.html must load the export entry as a module');
  assert.ok(assetIdx < moduleIdx, 'the asset path must be set BEFORE the module script or fonts fall back to the esm.sh CDN');
  assert.match(source, /new URL\('\.\/excalidraw-assets\/', document\.baseURI\)\.href/, 'the asset path must be ABSOLUTE (the 2026-08-26 CDN-fallback trap)');
});

test('the export entry bundles exportToBlob from the package, and nothing imports the prod file by URL', () => {
  const entry = fsSync.readFileSync(path.join(__dirname, '../../src/board-export/entry.js'), 'utf8');
  assert.match(entry, /from '@excalidraw\/excalidraw'/, 'vite must resolve the bare specifiers at build time');
  assert.match(entry, /exportToBlob/);
  assert.match(entry, /__harborBoardExport/, 'the runner finds the API on window');
  const provider = fsSync.readFileSync(path.join(__dirname, '../../src/main/providers/board-export.js'), 'utf8');
  assert.doesNotMatch(provider, /dist\/prod\/index\.js/, 'the un-resolvable dynamic import of the prod ESM must stay gone');
});

test('vite builds the export page as a second rollup input', () => {
  const config = fsSync.readFileSync(path.join(__dirname, '../../vite.config.js'), 'utf8');
  assert.match(config, /export\.html/, 'npm run build must produce dist/export.html');
});

test('the runner never shows, focuses, or restacks a window and refuses the network', () => {
  const runner = fsSync.readFileSync(path.join(__dirname, '../../src/main/providers/board-export-runner.cjs'), 'utf8');
  assert.match(runner, /show:\s*false/, 'the export window must be hidden');
  assert.doesNotMatch(runner, /\.show\(\)/, 'never show a window from automation on this box');
  assert.doesNotMatch(runner, /\.focus\(\)/, 'never focus a window from automation on this box');
  assert.match(runner, /onBeforeRequest/, 'http and https are blocked and recorded, so a CDN fallback fails loudly instead of leaking');
});

test('exportBoard surfaces store misses and frame errors honestly', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-board-export-miss-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createWhiteboardStore({ dir });
  const exporter = createBoardExport({
    store,
    captureScene: async () => Buffer.from('x'),
  });
  const missing = await exporter.exportBoard({ id: 'nope', format: 'png', outFile: path.join(dir, 'x.png') });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not found|could not/i);

  const created = await store.create({ name: 'Has Frames' });
  await store.write({
    id: created.board.id,
    scene: scene([frame('f1', 'One'), frame('f2', 'Two'), rect('r1', 'f1')]),
  });
  const ambig = await exporter.exportBoard({
    id: created.board.id,
    frame: 'o',
    format: 'png',
    outFile: path.join(dir, 'y.png'),
  });
  assert.equal(ambig.ok, false);
  assert.match(ambig.reason, /matches .* frames/i);
});
