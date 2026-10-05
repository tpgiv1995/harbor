'use strict';

// Board PNG/PDF export via a SPAWNED hidden-window Electron render of the real
// Excalidraw scene. The heavy capture is injectable so unit tests cover the
// pure plan (frame selection, path/format) without a GPU, while the default
// path spawns board-export-runner.cjs under the Electron binary: a hidden
// BrowserWindow loads dist/export.html (the vite-bundled exportToBlob entry)
// and runs Excalidraw's own exporter; PDF wraps that PNG through printToPDF.
//
// Why a spawn and a bundle, not an in-process dynamic import (the first shape,
// broken for its whole life): the CLI runs under plain node where no
// BrowserWindow exists, and Excalidraw's prod ESM carries 18 bare specifiers
// (react, roughjs/bin/rough, open-color, @excalidraw/laser-pointer, ...) that
// a Blink page cannot resolve without an import map; offscreen:true also
// crashed the win32 GPU process, so the runner uses a hidden window with
// hardware acceleration off. Do NOT hand-rasterize, and never re-import the
// prod ESM by file URL (a unit spec greps this file for that shape).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createWhiteboardStore } = require('./whiteboard.js');

const EXPORT_PAGE_HINT = 'the built export page (dist/export.html) is missing; run `npm run build` in app/ first';

const FORMATS = new Set(['png', 'pdf']);

function normalizeFormat(format) {
  const value = String(format || '').trim().toLowerCase();
  if (!FORMATS.has(value)) {
    throw new TypeError(`format must be png or pdf (got ${JSON.stringify(format)})`);
  }
  return value;
}

function deriveOutFile({ outFile, id, format } = {}) {
  const kind = normalizeFormat(format);
  const boardId = String(id || 'board').trim() || 'board';
  const target = outFile ? path.resolve(String(outFile)) : path.resolve(`${boardId}.${kind}`);
  const ext = path.extname(target).toLowerCase();
  if (ext === `.${kind}`) return target;
  if (ext === '.png' || ext === '.pdf') {
    return path.join(path.dirname(target), `${path.basename(target, ext)}.${kind}`);
  }
  return `${target}.${kind}`;
}

function liveElements(elements) {
  return (Array.isArray(elements) ? elements : []).filter((el) => el && !el.isDeleted);
}

function isFrame(el) {
  return el && (el.type === 'frame' || el.type === 'magicframe');
}

function findFrame(elements, frameQuery) {
  if (frameQuery == null || frameQuery === '') return null;
  const frames = liveElements(elements).filter(isFrame);
  const needle = String(frameQuery);
  const byId = frames.find((el) => el.id === needle);
  if (byId) return byId;
  const query = needle.toLowerCase();
  const matches = frames.filter((el) => {
    const name = typeof el.name === 'string' ? el.name : '';
    return name.toLowerCase().includes(query) || String(el.id).toLowerCase().includes(query);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`no frame matches "${needle}"`);
  }
  const candidates = matches.slice(0, 10).map((el) => `  ${el.id}  ${el.name || '(unnamed)'}`).join('\n');
  throw new Error(`"${needle}" matches ${matches.length} frames; use an id or a longer phrase:\n${candidates}`);
}

function planExport({ id, frame, format, outFile, scene } = {}) {
  if (!scene || typeof scene !== 'object' || !Array.isArray(scene.elements)) {
    return { ok: false, reason: 'board scene is missing or invalid' };
  }
  const elements = liveElements(scene.elements);
  if (elements.length === 0) {
    return { ok: false, reason: 'board is empty' };
  }
  let kind;
  try {
    kind = normalizeFormat(format);
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  }
  let exportingFrame = null;
  try {
    exportingFrame = frame ? findFrame(scene.elements, frame) : null;
  } catch (error) {
    return { ok: false, reason: String(error.message || error) };
  }
  const target = deriveOutFile({ outFile, id: id || scene.id || scene.name, format: kind });
  return {
    ok: true,
    format: kind,
    outFile: target,
    elements: scene.elements,
    files: scene.files && typeof scene.files === 'object' ? scene.files : {},
    appState: scene.appState && typeof scene.appState === 'object' ? scene.appState : {},
    exportingFrame,
  };
}

function packageRoot() {
  // app/src/main/providers -> app/
  return path.resolve(__dirname, '../../..');
}

function exportPagePath() {
  return path.join(packageRoot(), 'dist', 'export.html');
}

function runnerScriptPath() {
  return path.join(__dirname, 'board-export-runner.cjs');
}

function safeRequireElectron() {
  try {
    // Under plain node the electron npm package exports the PATH to the binary
    // (a string); under a full Electron process it is the API object.
    return require('electron');
  } catch {
    return null;
  }
}

function resolveElectronBinary({ electronModule, env = process.env, execPath = process.execPath } = {}) {
  if (env.HARBOR_ELECTRON_BIN) return env.HARBOR_ELECTRON_BIN;
  const mod = electronModule !== undefined ? electronModule : safeRequireElectron();
  if (typeof mod === 'string' && mod) return mod;
  if (mod && typeof mod === 'object') return execPath;
  return null;
}

function runnerEnv(base = process.env) {
  // The runner must come up as a FULL Electron app. A caller running under
  // ELECTRON_RUN_AS_NODE (bin scripts, the daemon probe posture) would
  // otherwise hand that flag down and the child would boot as plain node with
  // no BrowserWindow, the exact refusal this module used to die of.
  const env = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function runExportJob(job, options = {}) {
  const spawnImpl = options.spawn || spawn;
  const binary = resolveElectronBinary(options);
  if (!binary) {
    throw new Error('board export could not resolve an Electron binary (npm install in app/, or set HARBOR_ELECTRON_BIN)');
  }
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-board-export-job-'));
  const jobPath = path.join(scratch, 'job.json');
  const resultPath = path.join(scratch, 'result.json');
  const timeoutMs = options.timeoutMs || 90000;
  await fsp.writeFile(jobPath, `${JSON.stringify({ ...job, resultPath, timeoutMs })}\n`, 'utf8');
  try {
    const stderr = await new Promise((resolve, reject) => {
      const child = spawnImpl(binary, [runnerScriptPath(), jobPath], {
        env: runnerEnv(options.env || process.env),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let captured = '';
      // The runner carries its own deadline; this outer kill is the backstop
      // that keeps a wedged child from outliving its caller.
      const killer = setTimeout(() => {
        try { child.kill(); } catch {}
      }, timeoutMs + 15000);
      if (child.stderr) child.stderr.on('data', (chunk) => { captured += chunk; });
      child.on('error', (error) => {
        clearTimeout(killer);
        reject(error);
      });
      child.on('exit', () => {
        clearTimeout(killer);
        resolve(captured);
      });
    });
    let result = null;
    try {
      result = JSON.parse(await fsp.readFile(resultPath, 'utf8'));
    } catch {}
    if (!result) {
      const tail = stderr.trim().split(/\r?\n/).slice(-4).join(' | ');
      throw new Error(`export runner produced no result${tail ? `: ${tail}` : ''}`);
    }
    if (!result.ok) throw new Error(result.reason || 'export runner failed');
    return result;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultCaptureScene(payload, options = {}) {
  const pagePath = options.pagePath || exportPagePath();
  const pageExists = options.pageExists !== undefined ? options.pageExists : fs.existsSync(pagePath);
  if (!pageExists) throw new Error(EXPORT_PAGE_HINT);
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-board-export-'));
  const scenePath = path.join(scratch, 'scene.json');
  const outPng = path.join(scratch, 'out.png');
  const scene = {
    elements: payload.elements,
    appState: {
      ...(payload.appState || {}),
      exportBackground: true,
      exportEmbedScene: false,
    },
    files: payload.files || {},
    exportingFrame: payload.exportingFrame || null,
  };
  try {
    await fsp.writeFile(scenePath, `${JSON.stringify(scene)}\n`, 'utf8');
    await runExportJob({ mode: 'png', scenePath, outFile: outPng, pagePath }, options);
    const png = await fsp.readFile(outPng);
    if (!png.length) throw new Error('export runner wrote an empty PNG');
    return png;
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultWritePdf(pngBuffer, outFile, options = {}) {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-board-pdf-'));
  const pngPath = path.join(scratch, 'board.png');
  try {
    await fsp.writeFile(pngPath, pngBuffer);
    await runExportJob({ mode: 'pdf', pngPath, outFile: path.resolve(String(outFile)) }, options);
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

function createBoardExport(options = {}) {
  const store = options.store || createWhiteboardStore(options);
  const captureScene = options.captureScene || ((payload) => defaultCaptureScene(payload, options));
  const writePdf = options.writePdf || ((png, outFile) => defaultWritePdf(png, outFile, options));
  const writeFile = options.writeFile || ((file, data) => fsp.writeFile(file, data));

  async function exportBoard({ id, frame, format, outFile } = {}) {
    if (!id) return { ok: false, reason: 'board id is required' };
    const loaded = await store.read({ id });
    if (!loaded.ok) return { ok: false, reason: loaded.reason || 'board not found' };

    let plan;
    try {
      plan = planExport({
        id: loaded.board.id || id,
        frame,
        format,
        outFile,
        scene: loaded.board,
      });
    } catch (error) {
      return { ok: false, reason: String(error.message || error) };
    }
    if (!plan.ok) return plan;

    let png;
    try {
      png = await captureScene({
        elements: plan.elements,
        appState: plan.appState,
        files: plan.files,
        exportingFrame: plan.exportingFrame,
      });
    } catch (error) {
      return { ok: false, reason: `render failed: ${error.message || error}` };
    }
    if (!png || !png.length) return { ok: false, reason: 'render produced no image' };

    try {
      await fsp.mkdir(path.dirname(plan.outFile), { recursive: true });
      if (plan.format === 'png') {
        await writeFile(plan.outFile, png);
      } else {
        await writePdf(png, plan.outFile);
      }
    } catch (error) {
      return { ok: false, reason: `could not write ${plan.format}: ${error.message || error}` };
    }

    return {
      ok: true,
      id: loaded.board.id || id,
      format: plan.format,
      outFile: plan.outFile,
      frameId: plan.exportingFrame ? plan.exportingFrame.id : null,
    };
  }

  return { exportBoard, store };
}

// Convenience for callers that do not need to hold a factory (CLI, one-shot).
async function exportBoard(args, options = {}) {
  return createBoardExport(options).exportBoard(args);
}

module.exports = {
  normalizeFormat,
  deriveOutFile,
  findFrame,
  planExport,
  createBoardExport,
  exportBoard,
  defaultCaptureScene,
  defaultWritePdf,
  resolveElectronBinary,
  runnerEnv,
  exportPagePath,
  EXPORT_PAGE_HINT,
};
