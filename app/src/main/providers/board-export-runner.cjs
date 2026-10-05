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

// 2026-09-19: the first 8 bytes of every valid PNG file, used below to
// refuse writing anything that only LOOKS like a successful capture.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  // 2026-09-19: this window used to run sandbox:false,
  // contextIsolation:false, nodeIntegration:true so the PAGE could
  // `require('node:fs')` to read the scene and write the PNG. Board content
  // is not guaranteed first-party: whiteboard:write / whiteboard:create are
  // MUTATING phone-server methods (docs/SECURITY-MOBILE.md), so a holder of
  // the server token can author the scene this window renders. Full Node
  // access for a page rendering board data it does not control is the wrong
  // trade for "move some bytes between processes"; wrapPdf below already
  // has the right posture; this now matches it exactly.
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
    await win.loadFile(job.pagePath);
    // The RUNNER (Node side) reads the scene now, not the page: the page has
    // no `require` to read it with any more. The scene is inlined into the
    // executeJavaScript string via JSON.stringify, the same way job.scenePath
    // and job.outFile were inlined as strings before this fix.
    let scene;
    try {
      scene = JSON.parse(fs.readFileSync(job.scenePath, 'utf8'));
    } catch (error) {
      return { ok: false, reason: `could not read scene file: ${error.message || error}` };
    }
    const result = await win.webContents.executeJavaScript(`(async () => {
  const scene = ${JSON.stringify(scene)};
  const until = Date.now() + 30000;
  while (!window.__harborBoardExport) {
    if (Date.now() > until) return { ok: false, reason: 'export bundle never initialized (is dist/export.html from the current build?)' };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
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
    // No Node in this page any more (contextIsolation/sandbox, above): hand
    // the bytes back to the runner as base64 through executeJavaScript's own
    // return value instead of writing the file from inside the page.
    //
    // 2026-09-19: onloadend fires after BOTH a successful load and a
    // failed one, and the old handler resolved unconditionally from it
    // without ever checking reader.error, so an errored or empty read
    // resolved base64: '' and this function reported ok:true. The runner then
    // decoded that to a 0-byte buffer and wrote a 0-byte PNG as a "successful"
    // export. onloadend now checks reader.error itself instead of trusting
    // that onerror always wins the race, and an empty result is refused the
    // same way a real error is, rather than silently degrading to ''.
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (reader.error) {
          reject(reader.error);
          return;
        }
        const decoded = String(reader.result || '').split(',')[1];
        if (!decoded) {
          reject(new Error('FileReader produced no data for the exported blob'));
          return;
        }
        resolve(decoded);
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader failed reading the exported blob'));
      reader.readAsDataURL(blob);
    });
    return { ok: true, base64 };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
})()`);
    if (!result || !result.ok) return result || { ok: false, reason: 'export produced no result' };
    const buffer = Buffer.from(result.base64, 'base64');
    // the page above now rejects on a failed or empty FileReader read
    // instead of resolving base64:'', but this is the last point before a
    // file is actually written, so it refuses on its own terms too: an empty
    // buffer, or one that does not even start with the PNG signature, is a
    // failed export no matter how it got here, never a 0-byte "success".
    if (buffer.length === 0 || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return { ok: false, reason: `export decoded to ${buffer.length} byte(s) that are not a valid PNG` };
    }
    fs.writeFileSync(job.outFile, buffer);
    return { ok: true, bytes: buffer.length };
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
