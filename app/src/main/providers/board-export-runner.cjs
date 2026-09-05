'use strict';

// Electron MAIN script for one board-export job. Spawned by board-export.js
// (defaultCaptureScene / defaultWritePdf) as `electron board-export-runner.cjs
// <job.json>`, because the harbor-board CLI runs under plain node where no
// BrowserWindow exists, and a capture has to happen inside a real Chromium.
//
// Posture rules this file must never lose:
// - The window is HIDDEN (show:false) and nothing ever calls show/focus/
//   moveTop: automation on this box must not restack anything over Pat's
//   screen, and there is no focus guard on win32 to hand the screen back.
// - A hidden window, NOT offscreen:true: the offscreen path crashed the GPU
//   process on win32 (prior session, live). Hardware acceleration is disabled
//   because a 2D-canvas export needs no compositor and a software raster
//   cannot lose a GPU process.
// - http/https are BLOCKED and RECORDED: boards must export with the network
//   unplugged, and Excalidraw's silent esm.sh font fallback (the 2026-08-26
//   trap) must fail the job loudly instead of leaking to a CDN.
// - The runner writes {ok:false, reason} to the result file on EVERY failure
//   path and hard-exits on a deadline, so a wedged page can never leave a
//   zombie Electron behind (this machine's oldest wound).

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const jobPath = process.argv[process.argv.length - 1];
let job = null;
let resultPath = null;
let finished = false;

function finish(result, code) {
  if (finished) return;
  finished = true;
  try {
    if (resultPath) fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`, 'utf8');
  } catch {}
  try { app.exit(code); } catch { process.exit(code); }
}

try {
  job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  resultPath = job.resultPath;
  if (!resultPath) throw new Error('job carries no resultPath');
} catch (error) {
  console.error(`board-export-runner: unreadable job: ${error.message || error}`);
  process.exit(2);
}

process.on('uncaughtException', (error) => {
  finish({ ok: false, reason: `runner crashed: ${error.message || error}` }, 2);
});

app.disableHardwareAcceleration();

// Hard deadline: a hung font load or a wedged page must end THIS process, not
// wait for the parent's kill (which can itself die first).
const deadline = setTimeout(() => {
  finish({ ok: false, reason: `runner timed out after ${job.timeoutMs || 90000}ms` }, 3);
}, job.timeoutMs || 90000);
if (typeof deadline.unref === 'function') deadline.unref();

function watchNetwork(win, httpAttempts) {
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      httpAttempts.push(details.url);
      callback({ cancel: true });
    },
  );
}

function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

async function capturePng(httpAttempts) {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: false,
    },
  });
  try {
    hardenWindow(win);
    watchNetwork(win, httpAttempts);
    await win.loadFile(job.pagePath);
    return await win.webContents.executeJavaScript(`(async () => {
  const until = Date.now() + 30000;
  while (!window.__harborBoardExport) {
    if (Date.now() > until) return { ok: false, reason: 'export bundle never initialized (is dist/export.html from the current build?)' };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    const fs = require('node:fs');
    const scene = JSON.parse(fs.readFileSync(${JSON.stringify(job.scenePath)}, 'utf8'));
    // Mount the font vehicle FIRST: without registered content fonts,
    // exportToBlob measures labels with fallback metrics and clips them.
    await window.__harborBoardExport.prepareFonts(scene);
    const blob = await window.__harborBoardExport.exportToBlob({
      elements: scene.elements,
      appState: scene.appState,
      files: scene.files,
      mimeType: 'image/png',
      exportPadding: 24,
      exportingFrame: scene.exportingFrame || undefined,
      // The returned width/height are the CANVAS size: they must carry the
      // scale, or 2x content draws into a 1x canvas and the export is the
      // top-left quarter of the board (the first live render's exact bug).
      getDimensions: (width, height) => {
        const scale = Math.max(1, Math.min(2, 2400 / Math.max(width, height, 1)));
        return { width: width * scale, height: height * scale, scale };
      },
    });
    const buffer = Buffer.from(await blob.arrayBuffer());
    fs.writeFileSync(${JSON.stringify(job.outFile)}, buffer);
    return { ok: true, bytes: buffer.length };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
})()`);
  } finally {
    win.destroy();
  }
}

async function wrapPdf(httpAttempts) {
  const wrapperPath = path.join(path.dirname(job.pngPath), 'board-pdf-wrapper.html');
  fs.writeFileSync(
    wrapperPath,
    `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;padding:0;background:#fff}
img{display:block;max-width:100%;height:auto}
</style></head><body><img src="${path.basename(job.pngPath)}"/></body></html>\n`,
    'utf8',
  );
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    hardenWindow(win);
    watchNetwork(win, httpAttempts);
    await win.loadFile(wrapperPath);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      pageSize: 'Letter',
    });
    fs.mkdirSync(path.dirname(job.outFile), { recursive: true });
    fs.writeFileSync(job.outFile, pdf);
    return { ok: true, bytes: pdf.length };
  } finally {
    win.destroy();
  }
}

app.whenReady().then(async () => {
  const httpAttempts = [];
  let result;
  try {
    if (job.mode === 'png') result = await capturePng(httpAttempts);
    else if (job.mode === 'pdf') result = await wrapPdf(httpAttempts);
    else result = { ok: false, reason: `unknown mode ${JSON.stringify(job.mode)}` };
  } catch (error) {
    result = { ok: false, reason: String(error?.message || error) };
  }
  if (result.ok && httpAttempts.length > 0) {
    result = {
      ok: false,
      reason: `export attempted ${httpAttempts.length} network request(s); boards must export offline: ${httpAttempts.slice(0, 5).join(', ')}`,
    };
  }
  result.httpAttempts = httpAttempts;
  finish(result, result.ok ? 0 : 1);
}).catch((error) => {
  finish({ ok: false, reason: `runner failed to start: ${error?.message || error}` }, 2);
});
