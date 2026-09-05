'use strict';
// Live proof of the Miro sticky + canvas/navigation parity pass (catalog findings
// 29-35, 66-74, section 6): real Input.dispatchMouseEvent / dispatchKeyEvent /
// insertText against a real Excalidraw board, offscreen, isolated profile.
// Boot cloned from drive-connector-snap-win.js.
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const boardFiles = require('../src/renderer/whiteboard/board-files.cjs');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9344;
const OUT = path.join(os.tmpdir(), 'harbor-drive-sticky-canvas');
const BOARD_ID = 'sticky-canvas-drive-board';

// Two overlapping rects (z-order spec) and one far ellipse (minimap target).
const RECT_A = { id: 'za-rect', x: 80, y: 420, w: 160, h: 100 };
const RECT_B = { id: 'zb-rect', x: 140, y: 460, w: 160, h: 100 };
const FAR = { id: 'far-ellipse', x: 2400, y: 1600, w: 300, h: 200 };

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params?.exceptionDetails?.text || 'exception');
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') this.errors.push(String(msg.params.args?.[0]?.value || 'console.error'));
      if (msg.id && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${msg.error.message} from ${pending.method}`));
        else pending.resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      // A dead renderer must surface as a named failure, never a silent hang the
      // shell's timeout then buries (the first run of this drive died mute).
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout on ${method}; page errors so far: ${this.errors.slice(-3).join(' | ') || 'none'}`));
        }
      }, 20000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`${result.exceptionDetails.exception?.description || 'page error'} while evaluating ${expression.slice(0, 140)}`);
    }
    return result.result.value;
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
  }

  async mouse(type, x, y, buttons) {
    // A hover move must carry button 'none' or Chromium drops the pointermove.
    const button = type === 'mouseMoved' && !buttons ? 'none' : 'left';
    await this.send('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y), button, buttons, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0,
    });
  }

  async click(x, y) {
    await this.mouse('mouseMoved', x, y, 0);
    await sleep(60);
    await this.mouse('mousePressed', x, y, 1);
    await sleep(40);
    await this.mouse('mouseReleased', x, y, 0);
    await sleep(120);
  }

  async wheel(x, y, deltaY) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0, deltaX: 0, deltaY });
  }

  async key(key, opts = {}) {
    const keyDefs = {
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
      PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
      n: { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78 },
      g: { key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71 },
      m: { key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 },
      r: { key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82 },
      1: { key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 },
      2: { key: '2', code: 'Digit2', windowsVirtualKeyCode: 50 },
      0: { key: '0', code: 'Digit0', windowsVirtualKeyCode: 48 },
    };
    const def = keyDefs[key];
    if (!def) throw new Error(`no key def for ${key}`);
    let modifiers = 0;
    if (opts.alt) modifiers |= 1;
    if (opts.ctrl) modifiers |= 2;
    if (opts.shift) modifiers |= 8;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...def });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...def });
    await sleep(120);
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cdp.eval(expression)) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

const APP_EXPR = '(() => { const a = window.__harborBoardApi.getAppState(); return { zoom: a.zoom.value, scrollX: a.scrollX, scrollY: a.scrollY, offsetLeft: a.offsetLeft || 0, offsetTop: a.offsetTop || 0, width: a.width, height: a.height, snap: Boolean(a.objectsSnapModeEnabled), grid: Boolean(a.gridModeEnabled), bg: a.viewBackgroundColor, editing: Boolean(a.editingTextElement || a.editingElement) }; })()';

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-sticky-canvas-'));
  const userData = path.join(tmp, 'userData');
  const boardsDir = path.join(tmp, 'boards');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });

  const rect = ({ id, x, y, w, h }, type = 'rectangle') => ({
    id, type, x, y, width: w, height: h, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: '#d0ebff', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, index: null, roundness: null, seed: 1,
    version: 1, versionNonce: 1, isDeleted: false, boundElements: [],
    updated: 1, link: null, locked: false,
  });
  fs.writeFileSync(path.join(boardsDir, `${BOARD_ID}.json`), JSON.stringify({
    type: 'excalidraw', version: 2, source: 'local', name: 'Sticky canvas drive',
    updatedAt: new Date().toISOString(),
    elements: [rect(RECT_A), rect(RECT_B), rect(FAR, 'ellipse')], appState: {}, files: {},
  }, null, 2));

  const failures = [];
  const report = (condition, name, measured = '') => {
    const line = `${condition ? 'PASS' : 'FAIL'} ${name}${measured ? `: ${measured}` : ''}`;
    console.log(line);
    if (!condition) failures.push(line);
    return condition;
  };

  execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.paths = { ...config.paths, cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json'), projectIconsDir: path.join(tmp, 'project-icons'), boardsDir };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  // The anti-throttling switches make the OFFSCREEN window deterministic: without
  // them Chromium's occlusion tracker sometimes suspends frames and timers for the
  // hidden window and CDP's synthetic wheel (which rides the compositor input
  // pipeline) stalls past its own timeout (live-caught: run-to-run flakiness where
  // identical code passed 39/40 then wedged on Input.dispatchMouseEvent). The APP
  // does not need them: board invariants are microtask-driven, never frame-driven.
  const child = spawn(ELECTRON, [
    APP_DIR,
    `--remote-debugging-port=${PORT}`,
    '--no-focus-steal',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ], {
    env: {
      ...process.env,
      HARBOR_E2E: '1',
      HARBOR_E2E_USER_DATA: userData,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
      HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
      HARBOR_NO_ICON_GEN: '1',
      HARBOR_NO_USAGE_FETCH: '1',
      HARBOR_NO_TITLER: '1',
      HARBOR_BOARDS_DIR: boardsDir,
    },
    stdio: 'ignore',
  });

  try {
    let target;
    for (let i = 0; i < 60 && !target; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      } catch { /* app still booting */ }
      if (!target) await sleep(500);
    }
    if (!target) throw new Error('never found the app page over CDP');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');

    await waitFor(cdp, "[...document.querySelectorAll('.view-switch-btn')].some((b) => (b.getAttribute('aria-label') || '') === 'Board')", 'Board tab');
    await cdp.eval("[...document.querySelectorAll('.view-switch-btn')].find((b) => (b.getAttribute('aria-label') || '') === 'Board').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.excalidraw canvas') && window.__harborBoardApi)", 'Excalidraw canvas');
    await waitFor(cdp, 'window.__harborBoardApi.getSceneElements().length === 3', 'seeded shapes');

    // Zoom-menu helpers: every interaction checks the menu's REAL open state first
    // (row clicks deliberately keep the menu open, so blind pct-clicks toggle wrong).
    const zoomMenu = async (open) => {
      const isOpen = await cdp.eval("Boolean(document.querySelector('.wb-zoom-menu'))");
      if (isOpen !== open) {
        await cdp.eval("document.querySelector('.wb-zoom-pct').click()");
        await sleep(180);
      }
    };
    const zoomMenuClick = async (needle) => {
      await zoomMenu(true);
      const ok = await cdp.eval(`(() => { const b = [...document.querySelectorAll('.wb-zoom-menu button')].find((x) => x.textContent.includes('${needle}')); if (!b) return false; b.click(); return true; })()`);
      if (!ok) throw new Error(`zoom menu row not found: ${needle}`);
      await sleep(200);
    };

    // ---- Spec 1: smart guides default ON (finding 66) --------------------------------
    const app0 = await cdp.eval(APP_EXPR);
    report(app0.snap === true, 'smart guides (objectsSnapModeEnabled) default ON', `snap=${app0.snap}`);

    // ---- Spec 2: armed sticky click places ONE ~110px sticky at the click, enters
    // text edit, and DISARMS (finding 30) ----------------------------------------------
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Sticky')).click()");
    await sleep(200);
    const armedNoDrop = await cdp.eval('window.__harborBoardApi.getSceneElements().length');
    report(armedNoDrop === 3, 'clicking the sticky tool arms and drops NOTHING yet', `elements=${armedNoDrop}`);
    // pick a non-default colour from the flyout so the last-colour memory is provable
    await cdp.eval("[...document.querySelectorAll('.wb-sticky')].find((b) => (b.getAttribute('aria-label') || '').startsWith('Pink')).click()");
    await sleep(150);
    const clickAt = { x: 760, y: 260 };
    await cdp.click(clickAt.x, clickAt.y);
    await sleep(500);
    const placed = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const zoom = app.zoom.value;
      const faces = api.getSceneElements().filter((e) => e.customData && e.customData.sticky);
      const face = faces[faces.length - 1];
      if (!face) return null;
      const cx = (face.x + face.width / 2 + app.scrollX) * zoom + (app.offsetLeft || 0);
      const cy = (face.y + face.height / 2 + app.scrollY) * zoom + (app.offsetTop || 0);
      const shadows = api.getSceneElements().filter((e) => e.customData && e.customData.stickyShadow && e.customData.faceId === face.id);
      return {
        id: face.id, w: face.width, h: face.height, bg: face.backgroundColor, cx, cy,
        shadows: shadows.length, count: faces.length,
        armed: document.body.classList.contains('wb-placing-sticky'),
        editing: Boolean(api.getAppState().editingTextElement || api.getAppState().editingElement),
        editorUp: Boolean(document.querySelector('.excalidraw textarea')),
      };
    })()`);
    await cdp.shot('01-sticky-placed-editing');
    report(Boolean(placed) && placed.count === 1, 'one click placed exactly one sticky', `faces=${placed && placed.count}`);
    report(placed && placed.w === 110 && placed.h === 110, 'the sticky is the ~110px Miro small', `${placed && placed.w}x${placed && placed.h}`);
    report(placed && Math.abs(placed.cx - clickAt.x) <= 3 && Math.abs(placed.cy - clickAt.y) <= 3, 'sticky centred at the click point', `centre=${placed && Math.round(placed.cx)},${placed && Math.round(placed.cy)} click=${clickAt.x},${clickAt.y}`);
    report(placed && placed.bg === '#fd9ae7', 'the armed colour (Pink) is the placed colour', `bg=${placed && placed.bg}`);
    report(placed && placed.shadows === 2, 'the face carries its two bottom shadow bands', `bands=${placed && placed.shadows}`);
    report(placed && placed.armed === false, 'the tool DISARMED after one placement', `armed=${placed && placed.armed}`);
    report(placed && (placed.editing || placed.editorUp), 'placement entered text edit (caret ready)', `editing=${placed && placed.editing} editorUp=${placed && placed.editorUp}`);

    // ---- Spec 3: typed long text auto-shrinks; the note NEVER grows (finding 31) -----
    const longText = 'This is a much longer text to prove that the sticky note auto shrinks its font size while the note itself stays the same square size on the canvas.';
    await cdp.send('Input.insertText', { text: longText });
    await sleep(900); // fit pass is rAF-deferred off onChange
    const shrunk = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const els = api.getSceneElements();
      const face = els.filter((e) => e.customData && e.customData.sticky).at(-1);
      const label = els.find((e) => e.type === 'text' && e.containerId === face.id);
      return { fontSize: label ? label.fontSize : null, faceW: face.width, faceH: face.height, wrapped: label ? label.text.includes('\\n') : false };
    })()`);
    await cdp.shot('02-sticky-autoshrunk');
    report(shrunk.fontSize != null && shrunk.fontSize < 14, 'long text auto-shrank the font', `fontSize=${shrunk.fontSize}`);
    report(shrunk.faceW === 110 && shrunk.faceH === 110, 'the note NEVER grew', `${shrunk.faceW}x${shrunk.faceH}`);
    report(shrunk.wrapped === true, 'the label rewrapped to the note width');
    await cdp.key('Escape');
    await sleep(400);

    // ---- Spec 4: N re-arms the LAST colour; short text sits at the 28px ceiling ------
    await cdp.key('Escape'); // clear any selection
    await sleep(150);
    await cdp.key('n');
    await sleep(200);
    const nArmed = await cdp.eval("document.body.classList.contains('wb-placing-sticky')");
    report(nArmed === true, 'N arms sticky placement');
    await cdp.click(1000, 500);
    await sleep(500);
    await cdp.send('Input.insertText', { text: 'Hey' });
    await sleep(900);
    const second = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const els = api.getSceneElements();
      const face = els.filter((e) => e.customData && e.customData.sticky).at(-1);
      const label = els.find((e) => e.type === 'text' && e.containerId === face.id);
      return { bg: face.backgroundColor, fontSize: label ? label.fontSize : null };
    })()`);
    await cdp.shot('03-sticky-n-last-color');
    report(second.bg === '#fd9ae7', 'N placed the LAST colour (Pink)', `bg=${second.bg}`);
    report(second.fontSize === 28, 'short text sits at the 28px Auto ceiling', `fontSize=${second.fontSize}`);
    await cdp.key('Escape');
    await sleep(300);
    await cdp.key('Escape');
    await sleep(200);

    // ---- Spec 5: S/M/L presets (finding 32) ------------------------------------------
    await cdp.click(1000, 500); // select the second sticky
    await sleep(300);
    const segUp = await cdp.eval("Boolean(document.querySelector('.wb-sticky-seg'))");
    report(segUp, 'selecting a sticky shows the S/M/L segment');
    await cdp.eval("[...document.querySelectorAll('.wb-sticky-seg button')].find((b) => b.textContent === 'L').click()");
    await sleep(700);
    const sized = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const els = api.getSceneElements();
      const face = els.filter((e) => e.customData && e.customData.sticky).at(-1);
      const bands = els.filter((e) => e.customData && e.customData.stickyShadow && e.customData.faceId === face.id);
      return { w: face.width, h: face.height, bandsGlued: bands.every((b) => b.width === face.width && b.y > face.y) };
    })()`);
    await cdp.shot('04-sticky-large');
    report(sized.w === 300 && sized.h === 300, 'L preset resized the sticky to 300', `${sized.w}x${sized.h}`);
    report(sized.bandsGlued === true, 'shadow bands follow the resized face');
    await cdp.key('Escape');
    await sleep(200);

    // ---- Spec 6: wheel zooms at the cursor in Mouse mode (finding 69) ----------------
    const wheelAt = { x: 700, y: 400 };
    const before = await cdp.eval(APP_EXPR);
    const anchorScene = { x: (wheelAt.x - before.offsetLeft) / before.zoom - before.scrollX, y: (wheelAt.y - before.offsetTop) / before.zoom - before.scrollY };
    await cdp.wheel(wheelAt.x, wheelAt.y, -240);
    await sleep(300);
    const after = await cdp.eval(APP_EXPR);
    report(after.zoom > before.zoom && Math.abs(after.zoom / before.zoom - 1.12) < 0.01, 'plain wheel zooms IN at one Miro notch', `zoom ${before.zoom} -> ${after.zoom}`);
    const anchorAfter = { x: (wheelAt.x - after.offsetLeft) / after.zoom - after.scrollX, y: (wheelAt.y - after.offsetTop) / after.zoom - after.scrollY };
    report(Math.abs(anchorAfter.x - anchorScene.x) < 1 && Math.abs(anchorAfter.y - anchorScene.y) < 1, 'zoom is anchored at the cursor', `drift=${(anchorAfter.x - anchorScene.x).toFixed(2)},${(anchorAfter.y - anchorScene.y).toFixed(2)}`);

    // Trackpad mode: the same wheel SCROLLS and zoom stays put.
    await zoomMenuClick('Trackpad');
    await zoomMenu(false);
    const beforePad = await cdp.eval(APP_EXPR);
    await cdp.wheel(wheelAt.x, wheelAt.y, -240);
    await sleep(300);
    const afterPad = await cdp.eval(APP_EXPR);
    report(Math.abs(afterPad.zoom - beforePad.zoom) < 0.001, 'Trackpad mode: wheel does not zoom', `zoom ${beforePad.zoom} -> ${afterPad.zoom}`);
    report(Math.abs(afterPad.scrollY - beforePad.scrollY) > 1, 'Trackpad mode: wheel scrolls the canvas', `scrollY ${beforePad.scrollY.toFixed(1)} -> ${afterPad.scrollY.toFixed(1)}`);
    await zoomMenuClick('Mouse');
    await zoomMenu(false);

    // ---- Spec 7: the zoom menu presets + shortcuts (finding 70) ----------------------
    await zoomMenuClick('200%');
    await sleep(300);
    const at200 = await cdp.eval(APP_EXPR);
    report(Math.abs(at200.zoom - 2) < 0.001, 'zoom menu 200% lands exactly', `zoom=${at200.zoom}`);
    await cdp.key('0', { ctrl: true });
    await sleep(400);
    const at100 = await cdp.eval(APP_EXPR);
    report(Math.abs(at100.zoom - 1) < 0.001, 'Ctrl+0 resets to 100%', `zoom=${at100.zoom}`);
    await cdp.key('1', { alt: true });
    await sleep(700);
    const fitApp = await cdp.eval(APP_EXPR);
    report(Math.abs(fitApp.zoom - 1) > 0.01, 'Alt+1 fits the whole board (zoom moved)', `zoom=${fitApp.zoom.toFixed(3)}`);
    // Alt+2: select the far ellipse first, then zoom to it.
    await cdp.eval(`window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { '${FAR.id}': true } } })`);
    await sleep(200);
    await cdp.key('2', { alt: true });
    await sleep(700);
    const selApp = await cdp.eval(APP_EXPR);
    const farCentreScene = { x: FAR.x + FAR.w / 2, y: FAR.y + FAR.h / 2 };
    const viewCentre = { x: selApp.width / (2 * selApp.zoom) - selApp.scrollX, y: selApp.height / (2 * selApp.zoom) - selApp.scrollY };
    report(Math.abs(viewCentre.x - farCentreScene.x) < 20 && Math.abs(viewCentre.y - farCentreScene.y) < 20, 'Alt+2 centres the selection', `centre=${viewCentre.x.toFixed(0)},${viewCentre.y.toFixed(0)} want=${farCentreScene.x},${farCentreScene.y}`);
    await cdp.shot('05-zoom-to-selection');
    await cdp.eval('window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })');
    await cdp.key('0', { ctrl: true });
    await sleep(400);

    // ---- Spec 8: minimap (finding 71) ------------------------------------------------
    await cdp.key('m');
    await sleep(500);
    const mapUp = await cdp.eval("Boolean(document.querySelector('.wb-minimap canvas'))");
    report(mapUp, 'M shows the minimap card');
    await cdp.shot('06-minimap');
    // Click where the far ellipse maps: compute the SAME plan from the page's state.
    const mapState = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const rect = document.querySelector('.wb-minimap canvas').getBoundingClientRect();
      const a = api.getAppState();
      return { rect: { left: rect.left, top: rect.top }, app: { zoom: a.zoom.value, scrollX: a.scrollX, scrollY: a.scrollY, width: a.width, height: a.height }, elements: api.getSceneElements().map((e) => ({ id: e.id, x: e.x, y: e.y, width: e.width, height: e.height, isDeleted: e.isDeleted, customData: e.customData })) };
    })()`);
    const plan = boardFiles.minimapPlan(mapState.elements, { zoom: { value: mapState.app.zoom }, scrollX: mapState.app.scrollX, scrollY: mapState.app.scrollY, width: mapState.app.width, height: mapState.app.height });
    const farBox = { x: plan.ox + (FAR.x + FAR.w / 2 - plan.minX) * plan.scale, y: plan.oy + (FAR.y + FAR.h / 2 - plan.minY) * plan.scale };
    await cdp.click(mapState.rect.left + farBox.x, mapState.rect.top + farBox.y);
    await sleep(400);
    const jumped = await cdp.eval(APP_EXPR);
    const jumpedCentre = { x: jumped.width / (2 * jumped.zoom) - jumped.scrollX, y: jumped.height / (2 * jumped.zoom) - jumped.scrollY };
    report(Math.abs(jumpedCentre.x - (FAR.x + FAR.w / 2)) < 30 && Math.abs(jumpedCentre.y - (FAR.y + FAR.h / 2)) < 30, 'clicking the minimap jumps the viewport there', `centre=${jumpedCentre.x.toFixed(0)},${jumpedCentre.y.toFixed(0)}`);
    await cdp.shot('07-minimap-jumped');
    await cdp.key('m');
    await sleep(200);
    const mapGone = await cdp.eval("Boolean(document.querySelector('.wb-minimap canvas'))");
    report(!mapGone, 'M hides the minimap again');
    await cdp.key('0', { ctrl: true });
    await cdp.key('1', { alt: true });
    await sleep(600);

    // ---- Spec 9: PgUp raises z-order (finding 57 / section 6) ------------------------
    await cdp.eval(`window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { '${RECT_A.id}': true } } })`);
    await sleep(200);
    const orderBefore = await cdp.eval(`window.__harborBoardApi.getSceneElements().findIndex((e) => e.id === '${RECT_A.id}') - window.__harborBoardApi.getSceneElements().findIndex((e) => e.id === '${RECT_B.id}')`);
    await cdp.key('PageUp');
    await sleep(400);
    const orderAfter = await cdp.eval(`window.__harborBoardApi.getSceneElements().findIndex((e) => e.id === '${RECT_A.id}') - window.__harborBoardApi.getSceneElements().findIndex((e) => e.id === '${RECT_B.id}')`);
    report(orderBefore < 0 && orderAfter > 0, 'PgUp brings the selected rect to the front', `relative order ${orderBefore} -> ${orderAfter}`);
    await cdp.key('PageDown');
    await sleep(400);
    const orderBack = await cdp.eval(`window.__harborBoardApi.getSceneElements().findIndex((e) => e.id === '${RECT_A.id}') - window.__harborBoardApi.getSceneElements().findIndex((e) => e.id === '${RECT_B.id}')`);
    report(orderBack < 0, 'PgDn sends it to the back again', `relative order ${orderBack}`);
    await cdp.shot('08-zorder');
    await cdp.eval('window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })');

    // ---- Spec 10: dot grid (finding 72) ----------------------------------------------
    // Stage zoom 100% directly (spec 7 already proved the Ctrl+0 shortcut; staging
    // must not depend on where keyboard focus happens to sit).
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { zoom: { value: 1 } } })");
    await sleep(200);
    await zoomMenuClick('Dots');
    await zoomMenu(false);
    await cdp.key('g');
    await sleep(400);
    const dotState = await cdp.eval(`(() => {
      const layer = document.querySelector('.wb-dot-layer');
      const app = window.__harborBoardApi.getAppState();
      return {
        layerShown: layer && getComputedStyle(layer).display !== 'none',
        pattern: layer ? layer.style.backgroundImage.includes('radial-gradient') : false,
        bg: app.viewBackgroundColor,
        nativeGrid: Boolean(app.gridModeEnabled),
      };
    })()`);
    await cdp.shot('09-dot-grid');
    report(dotState.layerShown === true, 'G with Dots style shows the dot layer', `shown=${dotState.layerShown}`);
    report(dotState.pattern === true, 'the layer carries the radial-gradient dot pattern');
    report(dotState.bg === 'transparent', 'the canvas goes transparent so dots sit UNDER elements', `bg=${dotState.bg}`);
    report(dotState.nativeGrid === false, 'the native line grid stays off in dot mode');
    // zoomed far out the cells collapse and the dots fade instead of becoming noise
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { zoom: { value: 0.3 } } })");
    await sleep(300);
    const faded = await cdp.eval("document.querySelector('.wb-dot-layer').style.backgroundImage");
    report(faded === 'none', 'dots fade out when the grid cells collapse below 10px', `backgroundImage=${faded}`);
    await cdp.key('0', { ctrl: true });
    await sleep(300);
    await cdp.key('g');
    await sleep(400);
    const dotOff = await cdp.eval(`(() => {
      const layer = document.querySelector('.wb-dot-layer');
      const app = window.__harborBoardApi.getAppState();
      return { layerShown: layer && getComputedStyle(layer).display !== 'none', bg: app.viewBackgroundColor };
    })()`);
    report(dotOff.layerShown === false && dotOff.bg !== 'transparent', 'G again restores the solid background', `bg=${dotOff.bg}`);
    // and the LINE style still snaps: flip back to Lines, G on, grid mode is native
    await zoomMenuClick('Lines');
    await zoomMenu(false);
    await cdp.key('g');
    await sleep(300);
    const lineGrid = await cdp.eval('Boolean(window.__harborBoardApi.getAppState().gridModeEnabled)');
    report(lineGrid === true, 'Lines style still uses the native snapping grid');
    await cdp.key('g');
    await sleep(200);

    // ---- Spec 11: a native Excalidraw tool letter still works (section 6 spot check).
    // Tool letters ride Excalidraw's container onKeyDown, so the container must hold
    // focus first, exactly as a user's canvas click leaves it (the global-shortcut
    // family like Ctrl+0 works without it).
    await cdp.click(500, 640);
    await sleep(200);
    await cdp.key('r');
    await sleep(300);
    const toolNow = await cdp.eval("window.__harborBoardApi.getAppState().activeTool.type");
    report(toolNow === 'rectangle', 'R still arms the rectangle tool (native shortcuts intact)', `tool=${toolNow}`);
    await cdp.key('Escape');

    report(cdp.errors.length === 0, 'zero console errors or exceptions', cdp.errors.slice(0, 3).join(' | ') || 'clean');
    report(failures.length === 0, 'drive-sticky-canvas-win');
  } finally {
    child.kill();
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`FAIL drive crashed: ${error.message}`);
  process.exit(1);
});
