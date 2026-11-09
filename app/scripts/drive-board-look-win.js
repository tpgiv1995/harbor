'use strict';

// The Board on its dark canvas, photographed and measured. An ISOLATED Harbor (tmp
// userData, its own relocated sessiond, a private boards folder) is born offscreen by
// main's HARBOR_E2E rule and driven with real input events; nothing touches the real
// daemon, the real ~/.harbor or the screen.
//
// Boards: a hand-built "legacy" board saved the OLD way (white background, near-black ink,
// a sticky, a pastel column, a screenshot of known colours) so every number is exact, and,
// when --real <file> is given, a copy of a real saved board for the looks. A fresh board is
// then driven the way a user does (draw, type, paste an image, sticky, connector, dot grid),
// exported through the CLI, and reopened.
//
// Usage (from app/, after `npx vite build`):
//   node scripts/drive-board-look-win.js --out <dir> [--real <board.json>] [--sizes pat,mock]
// The captures are for a person to read; the assertions are the measurable half.

const { spawn, execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const { SessionClient } = require('../src/daemon/client.js');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = Number(process.env.DRIVE_BOARD_LOOK_PORT || 9384);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'harbor-drive-board-look')));
const REAL = arg('real', null);
const SIZE_TABLE = {
  pat: { width: 956, height: 574, scale: 1.8 },
  mock: { width: 1906, height: 908, scale: 1.8 },
};
const SIZES = arg('sizes', 'pat,mock').split(',').filter((s) => SIZE_TABLE[s]);
const step = (label) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${label}\n`);
const CANVAS = [0x14, 0x1a, 0x26];

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.errors = []; this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method) this.events.push(msg);
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params?.exceptionDetails?.exception?.description || 'exception');
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${method})`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout on ${method}`)); } }, 60_000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`page threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text} in ${expression.slice(0, 120)}`);
    return result.result.value;
  }

  async size({ width, height, scale }) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await sleep(500);
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    step(`captured ${name}`);
    return file;
  }

  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: extra.button || (type === 'mouseMoved' ? 'none' : 'left'), buttons: type === 'mousePressed' ? 1 : (extra.buttons || 0), clickCount: type === 'mouseMoved' ? 0 : 1 });
  }

  async click(x, y) { await this.mouse('mouseMoved', x, y); await this.mouse('mousePressed', x, y); await this.mouse('mouseReleased', x, y); }

  async dblclick(x, y) {
    await this.mouse('mouseMoved', x, y);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
  }

  async drag(x1, y1, x2, y2) {
    await this.mouse('mouseMoved', x1, y1);
    await this.mouse('mousePressed', x1, y1);
    for (let i = 1; i <= 6; i += 1) await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 6, y: y1 + ((y2 - y1) * i) / 6, button: 'left', buttons: 1 });
    await this.mouse('mouseReleased', x2, y2);
  }

  async key(key, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }

  async escape() { await this.key('Escape', 'Escape', 27); await sleep(120); }
}

async function waitFor(cdp, expression, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.eval(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(200);
  }
}

// The legacy board: stored the way boards were before the dark canvas. Every number the
// assertions use comes from here.
const SHOT_QUADS = ['#d62828', '#2a9d8f', '#f4a261', '#264de4'];
function legacyBoard() {
  const base = (id, type, x, y, w, h, over = {}) => ({
    id, type, x, y, width: w, height: h, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null,
    index: null, roundness: null, seed: 7, version: 3, versionNonce: 11, isDeleted: false, boundElements: [], updated: 1,
    link: null, locked: false, ...over,
  });
  const text = (id, x, y, s, over = {}) => base(id, 'text', x, y, 10 + s.length * 11, 27, {
    text: s, originalText: s, fontSize: 20, fontFamily: 6, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.35, ...over,
  });
  return {
    type: 'excalidraw', version: 2, source: 'drive', name: 'Legacy board',
    appState: { viewBackgroundColor: '#ffffff', gridSize: null },
    elements: [
      text('t-plain', 60, 40, 'Plan for the week', { strokeColor: '#1e1e1e' }),
      text('t-grey', 60, 90, 'Notes in grey ink', { strokeColor: '#495057', fontSize: 16 }),
      base('col', 'rectangle', 60, 150, 220, 220, { backgroundColor: '#e7f5ff', strokeColor: '#74c0fc', roundness: { type: 3 } }),
      text('t-col', 76, 166, 'To do', { strokeColor: '#212529' }),
      base('face', 'rectangle', 340, 150, 160, 160, { backgroundColor: '#ffe86d', strokeColor: 'transparent', boundElements: [{ type: 'text', id: 't-sticky' }], customData: { sticky: true } }),
      text('t-sticky', 352, 215, 'Ship it', { strokeColor: '#1a1a1a', containerId: 'face', textAlign: 'center', verticalAlign: 'middle' }),
      base('box', 'rectangle', 560, 150, 180, 100, { strokeColor: '#1e1e1e', boundElements: [{ type: 'text', id: 't-box' }, { type: 'arrow', id: 'arr' }] }),
      text('t-box', 590, 185, 'Review', { strokeColor: '#1e1e1e', containerId: 'box', textAlign: 'center', verticalAlign: 'middle' }),
      base('box2', 'ellipse', 560, 320, 180, 100, { strokeColor: '#e03131', boundElements: [{ type: 'arrow', id: 'arr' }] }),
      base('arr', 'arrow', 650, 252, 0, 66, { strokeColor: '#495057', points: [[0, 0], [0, 66]], startBinding: { elementId: 'box', focus: 0, gap: 2 }, endBinding: { elementId: 'box2', focus: 0, gap: 2 }, startArrowhead: null, endArrowhead: 'arrow', lastCommittedPoint: null, elbowed: false }),
      base('pen', 'line', 800, 150, 120, 0, { strokeColor: '#1e1e1e', points: [[0, 0], [120, 0]] }),
      base('shot', 'image', 800, 200, 200, 200, { backgroundColor: 'transparent', strokeColor: 'transparent', fileId: 'shot-file', status: 'saved', scale: [1, 1], crop: null }),
    ],
    files: { 'shot-file': { id: 'shot-file', mimeType: 'image/png', created: 1, lastRetrieved: 1, dataURL: '__SHOT__' } },
  };
}

const SHOT_MAKER = `((quads) => {
  const c = document.createElement('canvas'); c.width = 40; c.height = 40;
  const g = c.getContext('2d');
  g.fillStyle = quads[0]; g.fillRect(0, 0, 20, 20);
  g.fillStyle = quads[1]; g.fillRect(20, 0, 20, 20);
  g.fillStyle = quads[2]; g.fillRect(0, 20, 20, 20);
  g.fillStyle = quads[3]; g.fillRect(20, 20, 20, 20);
  return c.toDataURL('image/png');
})`;

// Pixel helpers run in the page: sample the static board canvas at a CLIENT point.
const PIXEL_JS = `window.__px = (cx, cy) => {
  const canvas = document.querySelector('.excalidraw canvas.static') || document.querySelector('.excalidraw canvas');
  const r = canvas.getBoundingClientRect();
  const sx = Math.round((cx - r.left) * canvas.width / r.width);
  const sy = Math.round((cy - r.top) * canvas.height / r.height);
  const d = canvas.getContext('2d').getImageData(sx, sy, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
};
window.__sceneToClient = (x, y) => {
  const a = window.__harborBoardApi.getAppState();
  const canvas = document.querySelector('.excalidraw canvas.static') || document.querySelector('.excalidraw canvas');
  const r = canvas.getBoundingClientRect();
  return { x: r.left + (x + a.scrollX) * a.zoom.value, y: r.top + (y + a.scrollY) * a.zoom.value };
};
window.__region = (cx, cy, w, h) => {
  const canvas = document.querySelector('.excalidraw canvas.static') || document.querySelector('.excalidraw canvas');
  const r = canvas.getBoundingClientRect();
  const k = canvas.width / r.width;
  const x0 = Math.max(0, Math.round((cx - r.left) * k)); const y0 = Math.max(0, Math.round((cy - r.top) * k));
  const d = canvas.getContext('2d').getImageData(x0, y0, Math.round(w * k), Math.round(h * k)).data;
  let min = 255; let max = 0;
  for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; if (l < min) min = l; if (l > max) max = l; }
  return { min: Math.round(min), max: Math.round(max) };
};
true`;

const near = (a, b, tol = 3) => a.length >= 3 && b.every((v, i) => Math.abs(a[i] - v) <= tol);
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-board-look-'));
  const userData = path.join(tmp, 'userData');
  const boardsDir = path.join(tmp, 'boards');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });
  const claudeHome = path.join(tmp, 'claude-home');
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
  const config = {
    paths: { projectsDir: path.join(tmp, 'projects'), cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json'), notesFile: path.join(tmp, 'notes.json'), boardsDir, projectIconsDir: path.join(tmp, 'project-icons') },
    profiles: [{ id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', configHome: claudeHome, email: null, isDefault: true }],
    setup: { completed: true, completedAt: null, appVersion: null },
  };
  fs.mkdirSync(config.paths.projectsDir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  // Seed: the legacy board (exact numbers) and, optionally, a copy of a real saved board.
  const legacy = legacyBoard();
  const origLegacy = JSON.parse(JSON.stringify(legacy));
  fs.writeFileSync(path.join(boardsDir, 'legacy-board.json'), JSON.stringify({ ...legacy, files: {} }));
  if (REAL) fs.copyFileSync(REAL, path.join(boardsDir, 'real-board.json'));

  const store = path.join(tmp, 'sessiond');
  fs.mkdirSync(store, { recursive: true });
  const socketPath = path.join(store, 'daemon.sock');
  const namespace = `harbor-board-look-${process.pid}`;
  const daemon = spawn(guiNodeExec, [path.join(APP_DIR, 'src', 'daemon', 'daemon.js')], {
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: namespace },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (const deadline = Date.now() + 15_000; ;) {
    try { const probe = new SessionClient({ socketPath }); const r = await probe.request('health'); probe.close(); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error('isolated daemon never answered');
    await sleep(100);
  }
  const env = {
    ...process.env, HARBOR_E2E: '1', HARBOR_E2E_USER_DATA: userData, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_SESSIOND_JOB_NAMESPACE: namespace, HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_NO_ICON_GEN: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_TITLER: '1', HARBOR_NO_VOICE: '1',
    HARBOR_CLI_UPDATES_FILE: path.join(tmp, 'cli-updates.json'), HARBOR_BOARDS_DIR: boardsDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'], {
    env, windowsHide: true, stdio: ['ignore', fs.openSync(path.join(OUT, 'electron.log'), 'w'), fs.openSync(path.join(OUT, 'electron.err.log'), 'w')],
  });

  const results = [];
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); else results.push(`ok: ${message}`); };
  let fatal = '';
  try {
    let target = null;
    for (let i = 0; i < 1200 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('the isolated Harbor never exposed a page');
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.size(SIZE_TABLE.mock);

    const openBoardView = async () => {
      await waitFor(cdp, "[...document.querySelectorAll('.view-switch-btn')].some((b) => b.textContent.trim() === 'Board')", 'Board tab', 120_000);
      await cdp.eval("[...document.querySelectorAll('.view-switch-btn')].find((b) => b.textContent.trim() === 'Board').click()");
      await waitFor(cdp, "Boolean(document.querySelector('.excalidraw canvas') && window.__harborBoardApi)", 'Excalidraw canvas', 120_000);
      await cdp.eval(PIXEL_JS);
    };
    const openByName = async (name) => {
      await cdp.eval("document.querySelector('.wb-switcher-btn').click()");
      await waitFor(cdp, "Boolean(document.querySelector('.wb-switcher-panel'))", 'switcher panel');
      await cdp.eval(`[...document.querySelectorAll('.wb-switcher-row .wb-switcher-name')].find((e) => e.textContent === ${JSON.stringify(name)}).closest('button').click()`);
      await sleep(900);
      await waitFor(cdp, "Boolean(document.querySelector('.excalidraw canvas') && window.__harborBoardApi)", 'canvas after switch');
      await cdp.eval(PIXEL_JS);
    };
    const fit = async () => { await cdp.eval("document.querySelector('[aria-label=\"Fit board to screen\"]').click()"); await sleep(700); };
    const shots = async (name, fn) => {
      for (const sizeName of SIZES) {
        await cdp.size(SIZE_TABLE[sizeName]);
        if (fn) await fn(sizeName);
        await sleep(350);
        await cdp.shot(`${name}-${sizeName}`);
      }
      await cdp.size(SIZE_TABLE.mock);
    };

    await openBoardView();
    step('board view open');

    // ---- 1. The legacy board ------------------------------------------------------------
    await openByName('Legacy board');
    // Seed the screenshot (the file would be too large for a one-line seed) and let the
    // board save it, then reopen so it comes back through the real load path.
    const dataUrl = await cdp.eval(`${SHOT_MAKER}(${JSON.stringify(SHOT_QUADS)})`);
    await cdp.eval(`(() => { const api = window.__harborBoardApi; api.addFiles([{ id: 'shot-file', mimeType: 'image/png', created: 1, lastRetrieved: 1, dataURL: ${JSON.stringify(dataUrl)} }]); const els = api.getSceneElements(); api.updateScene({ elements: els.map((e) => e.id === 'shot' ? { ...e, version: e.version + 1 } : e) }); return true; })()`);
    await sleep(2200);
    const seeded = JSON.parse(fs.readFileSync(path.join(boardsDir, 'legacy-board.json'), 'utf8'));
    results.push(`legacy after first open and save: bg=${seeded.appState.viewBackgroundColor} files=${Object.keys(seeded.files || {}).length}`);
    await cdp.send('Page.reload');
    await openBoardView();
    await openByName('Legacy board');
    await sleep(600);
    await fit();
    await shots('01-legacy', fit);
    await cdp.size(SIZE_TABLE.mock);
    await fit();

    const probe = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const by = Object.fromEntries(els.map((e) => [e.id, e]));
      const app = window.__harborBoardApi.getAppState();
      const c = (id, dx, dy) => window.__sceneToClient(by[id].x + dx, by[id].y + dy);
      return {
        bg: app.viewBackgroundColor, theme: app.theme, cur: app.currentItemStrokeColor,
        ink: Object.fromEntries(els.map((e) => [e.id, e.strokeColor])),
        fillPx: window.__px(c('col', 10, 200).x, c('col', 10, 200).y),
        stickyPx: window.__px(c('face', 12, 12).x, c('face', 12, 12).y),
        canvasPx: window.__px(c('col', -30, 100).x, c('col', -30, 100).y),
        shot: [[50, 50], [150, 50], [50, 150], [150, 150]].map(([dx, dy]) => { const p = c('shot', dx, dy); return window.__px(p.x, p.y); }),
        plainRegion: window.__region(c('t-plain', 0, 0).x, c('t-plain', 0, 0).y, 120, 14),
        stickyRegion: window.__region(c('face', 40, 60).x, c('face', 40, 60).y, 70, 18),
        colRegion: window.__region(c('t-col', 0, 0).x, c('t-col', 0, 0).y, 44, 14),
        zoom: app.zoom.value,
      };
    })()`);
    check(probe.theme === 'light', `Excalidraw runs its light theme (so no colour is inverted): ${probe.theme}`);
    check(probe.bg === '#141a26', `the legacy white board shows the dark canvas: ${probe.bg}`);
    check(near(probe.canvasPx, CANVAS, 2), `the canvas pixel is the dark canvas: ${probe.canvasPx}`);
    check(probe.ink['t-plain'] === '#e4e5ec' && probe.ink['t-grey'] === '#e4e5ec', `near-black and grey text show the light ink: ${probe.ink['t-plain']} ${probe.ink['t-grey']}`);
    check(probe.ink.arr === '#e4e5ec' && probe.ink.pen === '#e4e5ec', `a grey connector and a dark line show the light ink: ${probe.ink.arr} ${probe.ink.pen}`);
    check(probe.ink['t-sticky'] === '#1a1a1a' && probe.ink['t-col'] === '#212529', `dark text on a sticky and on a pastel column stays dark: ${probe.ink['t-sticky']} ${probe.ink['t-col']}`);
    check(probe.ink.box2 === '#e03131', `a readable red border is untouched: ${probe.ink.box2}`);
    check(near(probe.stickyPx, hex('#ffe86d'), 3), `the sticky keeps its fill ${probe.stickyPx}`);
    check(near(probe.fillPx, hex('#e7f5ff'), 3), `the pastel column keeps its fill ${probe.fillPx}`);
    const quads = SHOT_QUADS.map(hex);
    check(probe.shot.every((px, i) => near(px, quads[i], 6)), `the pasted screenshot keeps its true colours ${JSON.stringify(probe.shot)} vs ${JSON.stringify(quads)}`);
    check(probe.plainRegion.max > 170, `light text reads on the canvas (brightest ${probe.plainRegion.max})`);
    check(probe.stickyRegion.min < 90, `dark text reads on the sticky (darkest ${probe.stickyRegion.min})`);
    check(probe.colRegion.min < 90, `dark title reads on the pastel column (darkest ${probe.colRegion.min})`);

    // A real edit, so the board saves. The stored colours must come back unchanged.
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => b.getAttribute('aria-label') === 'Shapes').click()");
    await cdp.eval("[...document.querySelectorAll('.wb-flyout-shapes .wb-rail-btn')].find((b) => /Rectangle/.test(b.getAttribute('aria-label'))).click()");
    const spot = await cdp.eval("(() => { const p = window.__sceneToClient(1100, 150); return p; })()");
    await cdp.drag(Math.round(spot.x), Math.round(spot.y), Math.round(spot.x + 120), Math.round(spot.y + 80));
    await sleep(2400);
    const saved = JSON.parse(fs.readFileSync(path.join(boardsDir, 'legacy-board.json'), 'utf8'));
    const savedById = Object.fromEntries(saved.elements.map((e) => [e.id, e]));
    const drift = origLegacy.elements.filter((e) => savedById[e.id] && (savedById[e.id].strokeColor !== e.strokeColor || savedById[e.id].backgroundColor !== e.backgroundColor)).map((e) => `${e.id}: ${e.strokeColor}/${e.backgroundColor} -> ${savedById[e.id].strokeColor}/${savedById[e.id].backgroundColor}`);
    check(drift.length === 0, `saving never rewrites a stored colour (${drift.join('; ') || 'none changed'})`);
    check(origLegacy.elements.every((e) => savedById[e.id]), 'every stored element is still in the file');
    check(saved.appState.viewBackgroundColor === '#141a26', `the saved background is the dark canvas: ${saved.appState.viewBackgroundColor}`);
    const drawn = saved.elements.find((e) => e.type === 'rectangle' && !origLegacy.elements.some((o) => o.id === e.id));
    check(Boolean(drawn) && drawn.strokeColor === '#e4e5ec', `a rectangle drawn on the old board gets the light ink: ${drawn && drawn.strokeColor}`);

    // ---- 2. A real saved board, if given ---------------------------------------------------
    if (REAL) {
      await openByName('Untitled board');
      await sleep(900);
      await fit();
      await shots('02-real', fit);
      await cdp.size(SIZE_TABLE.mock);
      const realProbe = await cdp.eval(`(() => ({ bg: window.__harborBoardApi.getAppState().viewBackgroundColor, files: Object.keys(window.__harborBoardApi.getFiles()).length, n: window.__harborBoardApi.getSceneElements().length, ink: [...new Set(window.__harborBoardApi.getSceneElements().filter((e) => e.type === 'text' || e.type === 'arrow').map((e) => e.strokeColor))] }))()`);
      results.push(`real board: ${JSON.stringify(realProbe)}`);
      check(realProbe.bg === '#141a26', `the real saved board shows the dark canvas: ${realProbe.bg}`);
    }

    // ---- 3. A new board, driven the way a user does -------------------------------------------
    await cdp.eval("document.querySelector('.whiteboard-new').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.whiteboard-rename'))", 'new board rename');
    await cdp.eval(`(() => { const input = document.querySelector('.whiteboard-rename'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, 'Fresh board'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await sleep(900);
    await cdp.eval(PIXEL_JS);
    await cdp.size(SIZE_TABLE.mock);
    await shots('03-empty');
    await cdp.eval("document.querySelector('.wb-switcher-btn').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-switcher-panel'))", 'switcher panel');
    const panelBg = await cdp.eval("getComputedStyle(document.querySelector('.wb-switcher-panel')).backgroundColor");
    check(panelBg === 'rgb(23, 26, 39)', `the board switcher paints an opaque panel: ${panelBg}`);
    await shots('03b-switcher');
    await cdp.eval("document.querySelector('.wb-switcher-btn').click()");
    await sleep(250);
    const empty = await cdp.eval("({ bg: window.__harborBoardApi.getAppState().viewBackgroundColor, cur: window.__harborBoardApi.getAppState().currentItemStrokeColor })");
    check(empty.bg === '#141a26', `a new board shows the dark canvas: ${empty.bg}`);
    check(empty.cur === '#e4e5ec', `new ink defaults to the light ink: ${empty.cur}`);

    // text
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /^Text/.test(b.getAttribute('aria-label'))).click()");
    await cdp.click(560, 200);
    await sleep(200);
    await cdp.send('Input.insertText', { text: 'Roadmap' });
    await cdp.escape();
    // rectangle
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => b.getAttribute('aria-label') === 'Shapes').click()");
    await cdp.eval("[...document.querySelectorAll('.wb-flyout-shapes .wb-rail-btn')].find((b) => /^Rectangle/.test(b.getAttribute('aria-label'))).click()");
    await cdp.drag(520, 300, 700, 400);
    await cdp.escape();
    // second shape and a connector between them
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => b.getAttribute('aria-label') === 'Shapes').click()");
    await cdp.eval("[...document.querySelectorAll('.wb-flyout-shapes .wb-rail-btn')].find((b) => /^Ellipse/.test(b.getAttribute('aria-label'))).click()");
    await cdp.drag(900, 300, 1080, 400);
    await cdp.escape();
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /^Arrow/.test(b.getAttribute('aria-label'))).click()");
    await cdp.drag(705, 350, 895, 350);
    await cdp.escape();
    // freehand
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /^Draw/.test(b.getAttribute('aria-label'))).click()");
    await cdp.drag(520, 480, 700, 540);
    await cdp.escape();
    // sticky
    await cdp.eval("document.querySelector('.wb-rail .wb-rail-btn.accent').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-flyout-swatches'))", 'sticky flyout');
    await sleep(150);
    await shots('04-sticky-flyout');
    await cdp.click(1200, 480);
    await sleep(500);
    await cdp.send('Input.insertText', { text: 'Ship it' });
    await cdp.escape();
    // pasted screenshot: a real paste event carrying a PNG file
    await cdp.eval("window.__harborBoardApi.setActiveTool({ type: 'selection' })");
    await cdp.click(1300, 760);
    await sleep(250);
    const pasted = await cdp.eval(`(async () => {
      const dataUrl = ${SHOT_MAKER}(${JSON.stringify(SHOT_QUADS)});
      const blob = await (await fetch(dataUrl)).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }));
      const before = window.__harborBoardApi.getSceneElements().length;
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 1200));
      return { before, after: window.__harborBoardApi.getSceneElements().length, images: window.__harborBoardApi.getSceneElements().filter((e) => e.type === 'image').length };
    })()`);
    results.push(`paste: ${JSON.stringify(pasted)}`);
    check(pasted.images === 1, 'a pasted screenshot becomes an image element');
    await cdp.click(1700, 820);
    await sleep(300);
    await shots('05-new-board');

    const fresh = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const kind = (t) => els.filter((e) => e.type === t).map((e) => e.strokeColor);
      const face = els.find((e) => e.customData && e.customData.sticky);
      const lbl = face && els.find((e) => e.containerId === face.id);
      const img = els.find((e) => e.type === 'image');
      const mid = img && window.__sceneToClient(img.x + img.width * 0.25, img.y + img.height * 0.25);
      const mid2 = img && window.__sceneToClient(img.x + img.width * 0.75, img.y + img.height * 0.75);
      return {
        text: kind('text'), rect: kind('rectangle'), ellipse: kind('ellipse'), arrow: kind('arrow'), pen: kind('freedraw'),
        sticky: face && face.backgroundColor, stickyText: lbl && lbl.strokeColor,
        imgQ1: mid && window.__px(mid.x, mid.y), imgQ4: mid2 && window.__px(mid2.x, mid2.y),
      };
    })()`);
    check(fresh.text.includes('#e4e5ec'), `text typed on the canvas is light (a note's own text is dark, below): ${JSON.stringify(fresh.text)}`);
    const solid = (list) => list.filter((c) => c !== 'transparent');
    check(solid(fresh.rect).length >= 1 && solid(fresh.rect).every((c) => c === '#e4e5ec') && solid(fresh.ellipse).every((c) => c === '#e4e5ec'), `drawn shapes get light borders: ${JSON.stringify(fresh.rect)} ${JSON.stringify(fresh.ellipse)}`);
    check(fresh.arrow.length >= 1 && fresh.arrow.every((c) => c === '#e4e5ec'), `a connector is light: ${JSON.stringify(fresh.arrow)}`);
    check(fresh.pen.every((c) => c === '#e4e5ec'), `a freehand stroke is light: ${JSON.stringify(fresh.pen)}`);
    check(Boolean(fresh.sticky) && /^#(1e1e1e|1a1a1a)$/i.test(fresh.stickyText || ''), `text typed into a sticky is made dark so it reads on the note: ${fresh.sticky} ${fresh.stickyText}`);
    check(fresh.imgQ1 && near(fresh.imgQ1, quads[0], 6) && near(fresh.imgQ4, quads[3], 6), `a pasted image keeps its true colours: ${JSON.stringify([fresh.imgQ1, fresh.imgQ4])}`);

    // selection chrome: float card over a shape, a colour submenu open
    await cdp.click(521, 350);
    await sleep(400);
    await shots('06-float-card');
    await cdp.eval("document.querySelector('.wb-float-bar [aria-label=\"Fill colour\"]') && document.querySelector('.wb-float-bar [aria-label=\"Fill colour\"]').click()");
    await sleep(350);
    await cdp.size(SIZE_TABLE.mock);
    await cdp.shot('07-fill-menu-mock');
    const menuOpacity = await cdp.eval(`(() => { const m = document.querySelector('.wb-tb-menu'); if (!m) return null; const s = getComputedStyle(m); const bar = getComputedStyle(document.querySelector('.wb-float-bar')); return { menu: s.backgroundColor, bar: bar.backgroundColor }; })()`);
    results.push(`panel backgrounds: ${JSON.stringify(menuOpacity)}`);
    check(menuOpacity && !/rgba\(.*,\s*0?\.\d+\)$/.test(menuOpacity.bar) && !/rgba\(.*,\s*0?\.\d+\)$/.test(menuOpacity.menu || 'rgb(0,0,0)'), `the card and its submenu paint opaque: ${JSON.stringify(menuOpacity)}`);
    await cdp.escape();
    await cdp.escape();

    // Excalidraw's own menu in the dark chrome
    await cdp.eval("document.querySelector('.dropdown-menu-button') && document.querySelector('.dropdown-menu-button').click()");
    await sleep(500);
    await cdp.shot('08-main-menu-mock');
    await cdp.escape();

    // line grid
    await cdp.eval("document.querySelector('[aria-label=\"Toggle grid and snap to grid\"]').click()");
    await sleep(600);
    await shots('09-line-grid');
    const gridPx = await cdp.eval("(() => { const p = window.__sceneToClient(0, 0); const out = []; for (let i = 0; i < 40; i += 1) out.push(window.__px(p.x + 2 + i, p.y + 1 + 3)); return out.map((d) => Math.round(0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2])); })()");
    check(Math.max(...gridPx) < 90, `line grid lines are dark-canvas greys, not Excalidraw's pale ones (brightest sampled ${Math.max(...gridPx)})`);
    await cdp.eval("document.querySelector('[aria-label=\"Toggle grid and snap to grid\"]').click()");
    await sleep(300);

    // dot grid
    await cdp.eval("window.localStorage.setItem('harbor-board-grid-style', 'dot')");
    await cdp.send('Page.reload');
    await openBoardView();
    await openByName('Fresh board');
    await sleep(500);
    // A reload restores the saved grid flag (the dot layer is re-derived on a frame that an
    // occluded window may not run), so start from a known state: off, then on in dot style.
    const gridBtn = "document.querySelector('[aria-label=\"Toggle grid and snap to grid\"]')";
    await cdp.eval(`${gridBtn}.getAttribute('aria-pressed') === 'true' && ${gridBtn}.click()`);
    await sleep(400);
    await cdp.eval(`${gridBtn}.click()`);
    await sleep(900);
    await shots('10-dot-grid');
    const dots = await cdp.eval(`(() => {
      const layer = document.querySelector('.wb-dot-layer');
      const s = getComputedStyle(layer);
      return { display: s.display, bg: s.backgroundColor, image: s.backgroundImage.slice(0, 80), live: window.__harborBoardApi.getAppState().viewBackgroundColor, cls: document.body.classList.contains('wb-dot-grid') };
    })()`);
    results.push(`dot layer: ${JSON.stringify(dots)}`);
    check(dots.cls && dots.display === 'block' && dots.bg === 'rgb(20, 26, 38)', `dot mode paints the dark canvas under a transparent board: ${JSON.stringify(dots)}`);
    check(/rgba\((1[5-9]\d|2\d\d)/.test(dots.image), `the dots are light: ${dots.image}`);
    await cdp.eval(`${gridBtn}.getAttribute('aria-pressed') === 'true' && ${gridBtn}.click()`);
    await sleep(300);
    await cdp.eval("window.localStorage.removeItem('harbor-board-grid-style')");

    await sleep(2400);
    // Export: the CLI, which renders through the same exporter a user's Copy as PNG uses.
    const cli = path.join(path.resolve(APP_DIR, '..'), 'bin', 'harbor-board');
    for (const [needle, file] of [['Legacy board', 'export-legacy.png'], ['Fresh board', 'export-fresh.png'], ...(REAL ? [['Untitled board', 'export-real.png']] : [])]) {
      const run = spawnSync(process.execPath, [cli, 'export', needle, '--format', 'png', '--out', path.join(OUT, file)], { env: { ...process.env, HARBOR_BOARDS_DIR: boardsDir }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
      check(run.status === 0 && fs.existsSync(path.join(OUT, file)) && fs.statSync(path.join(OUT, file)).size > 2000, `export of "${needle}" wrote a PNG${run.status === 0 ? '' : `: ${run.stderr.slice(-200)}`}`);
    }

    // Reopen: the fresh board comes back the same.
    await cdp.send('Page.reload');
    await openBoardView();
    await openByName('Fresh board');
    await sleep(700);
    await fit();
    await shots('11-reopened', fit);
    const reopened = await cdp.eval(`(() => { const els = window.__harborBoardApi.getSceneElements(); return { n: els.length, bg: window.__harborBoardApi.getAppState().viewBackgroundColor, images: els.filter((e) => e.type === 'image').length, files: Object.keys(window.__harborBoardApi.getFiles()).length, text: els.filter((e) => e.type === 'text').map((e) => e.strokeColor) }; })()`);
    results.push(`reopened: ${JSON.stringify(reopened)}`);
    check(reopened.bg === '#141a26' && reopened.images === 1 && reopened.files === 1, `the new board reopens with its canvas, image and file: ${JSON.stringify(reopened)}`);

    // ---- 4. Why Excalidraw's own dark theme is not used ----------------------------------------
    await cdp.size(SIZE_TABLE.mock);
    await openByName('Legacy board');
    await sleep(500);
    await fit();
    await cdp.size({ width: 1906, height: 908, scale: 1 });
    await fit();
    await cdp.eval(`(() => { const st = document.createElement('style'); st.id = 'probe-dark'; st.textContent = '.excalidraw.theme--dark canvas { filter: var(--theme-filter) !important; }'; document.head.appendChild(st); window.__harborBoardApi.updateScene({ appState: { theme: 'dark', viewBackgroundColor: '#ffffff' } }); return true; })()`);
    await sleep(900);
    // The CSS filter is not in the canvas's own pixels, so read the colours from a real screenshot.
    const spots = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements(); const by = Object.fromEntries(els.map((e) => [e.id, e]));
      const c = (id, dx, dy) => window.__sceneToClient(by[id].x + dx, by[id].y + dy);
      return { filter: getComputedStyle(document.querySelector('.excalidraw canvas.static')).filter, sticky: c('face', 12, 12), col: c('col', 10, 200), q1: c('shot', 50, 50), q4: c('shot', 150, 150), canvas: c('col', -30, 100) };
    })()`);
    const shotFile = await cdp.shot('12-probe-excalidraw-dark-theme');
    const b64 = fs.readFileSync(shotFile).toString('base64');
    const read = await cdp.eval(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height; const g = cv.getContext('2d'); g.drawImage(bmp, 0, 0);
      const at = (p) => Array.from(g.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data);
      const spots = ${JSON.stringify(spots)};
      return { sticky: at(spots.sticky), col: at(spots.col), q1: at(spots.q1), q4: at(spots.q4), canvas: at(spots.canvas) };
    })()`);
    const dark = { filter: spots.filter, ...read };
    results.push(`excalidraw dark theme probe (CSS filter forced on): ${JSON.stringify(dark)}`);
    check(!near(dark.sticky, hex('#ffe86d'), 12) || !near(dark.col, hex('#e7f5ff'), 12), `PROBE: Excalidraw's own dark theme changes sticky/pastel fills (sticky ${dark.sticky}, column ${dark.col})`);

    if (cdp.errors.length) results.push(`page errors: ${cdp.errors.slice(-5).join(' | ')}`);
    const urls = cdp.events.filter((event) => event.method === 'Network.requestWillBeSent').map((event) => event.params.request.url);
    const http = urls.filter((url) => /^https?:/i.test(url));
    check(http.length === 0, `no network request left the app (${urls.length} requests, http=${http.length})`);
    ws.close();
  } catch (error) {
    fatal = String(error.stack || error);
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
    try { daemon.kill(); } catch { /* already gone */ }
    await sleep(500);
    try { fs.cpSync(boardsDir, path.join(OUT, 'boards'), { recursive: true }); } catch { /* optional */ }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  const verdict = fatal ? `FATAL ${fatal}` : (failures.length ? `FAIL\n${failures.join('\n')}` : 'PASS');
  const report = `${verdict}\n\n${results.join('\n')}\nscreenshots: ${OUT}\n`;
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  process.stdout.write(report);
  process.exit(fatal || failures.length ? 1 : 0);
}

main();
