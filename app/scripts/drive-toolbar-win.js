'use strict';
// Live proof of Wave C: the contextual toolbar ABOVE the selection and everything it
// opens (Miro catalog findings 26, 46-48, 53, 56, 57, 76). Real
// Input.dispatchMouseEvent / dispatchKeyEvent against a real Excalidraw board,
// offscreen, isolated profile. Boot cloned from drive-sticky-canvas-win.js.
//
// Every assertion reads the ELEMENT DATA the click produced, not just the DOM: a menu
// that opens and writes nothing is the failure mode this drive exists to catch.
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The shape catalog grows wave by wave, so "All shapes" is checked against the catalog
// itself rather than against a number that goes stale the next time a glyph lands.
const { SHAPE_DEFS } = require('../src/renderer/whiteboard/board-files.cjs');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9345;
const OUT = path.join(os.tmpdir(), 'harbor-drive-toolbar');
const BOARD_ID = 'toolbar-drive-board';

// A compact seeded layout, centred in the canvas at load so nothing starts clamped
// against a viewport edge (placement clamping has its own spec at the end).
const A = { id: 'a-rect', x: 0, y: 0, w: 160, h: 100 };
const B = { id: 'b-rect', x: 360, y: 0, w: 160, h: 100 };
const LAB = { id: 'lab-rect', x: 0, y: 240, w: 220, h: 120 };
const DST = { id: 'dst-rect', x: 380, y: 260, w: 140, h: 90 };
const GROUP_W = 520;
const GROUP_H = 360;

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
      // A dead renderer must surface as a named failure, never a silent hang.
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
    await sleep(50);
    await this.mouse('mousePressed', x, y, 1);
    await sleep(40);
    await this.mouse('mouseReleased', x, y, 0);
    await sleep(140);
  }

  async drag(fromX, fromY, toX, toY, steps = 8) {
    await this.mouse('mouseMoved', fromX, fromY, 0);
    await sleep(40);
    await this.mouse('mousePressed', fromX, fromY, 1);
    for (let i = 1; i <= steps; i += 1) {
      await this.mouse('mouseMoved', fromX + ((toX - fromX) * i) / steps, fromY + ((toY - fromY) * i) / steps, 1);
      await sleep(20);
    }
    await this.mouse('mouseReleased', toX, toY, 0);
    await sleep(200);
  }

  async key(key, opts = {}) {
    const keyDefs = {
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      c: { key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 },
      v: { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 },
    };
    const def = keyDefs[key];
    if (!def) throw new Error(`no key def for ${key}`);
    let modifiers = 0;
    if (opts.alt) modifiers |= 1;
    if (opts.ctrl) modifiers |= 2;
    if (opts.shift) modifiers |= 8;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...def });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...def });
    await sleep(140);
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

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-toolbar-'));
  const userData = path.join(tmp, 'userData');
  const boardsDir = path.join(tmp, 'boards');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });

  const base = {
    angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#d0ebff', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, index: null, roundness: null, seed: 1,
    version: 1, versionNonce: 1, isDeleted: false, boundElements: [],
    updated: 1, link: null, locked: false,
  };
  const rect = ({ id, x, y, w, h }, over = {}) => ({ ...base, id, type: 'rectangle', x, y, width: w, height: h, ...over });
  const arrow = {
    ...base,
    id: 'link', type: 'arrow', x: A.w + 4, y: A.h / 2, width: B.x - A.w - 8, height: 0,
    points: [[0, 0], [B.x - A.w - 8, 0]], backgroundColor: 'transparent',
    startBinding: { elementId: A.id, focus: 0, gap: 4 },
    endBinding: { elementId: B.id, focus: 0, gap: 4 },
    startArrowhead: null, endArrowhead: 'arrow', lastCommittedPoint: null, elbowed: false,
  };
  const labelText = {
    ...base,
    id: 'lab-text', type: 'text', x: LAB.x + 60, y: LAB.y + 48, width: 100, height: 25,
    text: 'Label', originalText: 'Label', fontSize: 20, fontFamily: 6, textAlign: 'center',
    verticalAlign: 'middle', lineHeight: 1.25, containerId: LAB.id, backgroundColor: 'transparent',
    strokeColor: '#1a1a1a', autoResize: true,
  };

  fs.writeFileSync(path.join(boardsDir, `${BOARD_ID}.json`), JSON.stringify({
    type: 'excalidraw', version: 2, source: 'local', name: 'Toolbar drive',
    updatedAt: new Date().toISOString(),
    elements: [
      rect(A, { boundElements: [{ type: 'arrow', id: 'link' }] }),
      rect(B, { boundElements: [{ type: 'arrow', id: 'link' }] }),
      arrow,
      rect(LAB, { boundElements: [{ type: 'text', id: 'lab-text' }] }),
      labelText,
      rect(DST, { backgroundColor: '#ffffff' }),
    ],
    appState: {},
    files: {},
  }, null, 2));

  const failures = [];
  const report = (condition, name, measured = '') => {
    const line = `${condition ? 'PASS' : 'FAIL'} ${name}${measured ? `: ${measured}` : ''}`;
    console.log(line);
    if (!condition) failures.push(line);
    return condition;
  };

  if (!process.env.HARBOR_DRIVE_SKIP_BUILD) execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.paths = { ...config.paths, cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json'), projectIconsDir: path.join(tmp, 'project-icons'), boardsDir };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  // The anti-throttling switches make the OFFSCREEN window deterministic: without them
  // Chromium's occlusion tracker suspends frames and timers for a hidden window and
  // synthetic input stalls past its own timeout.
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
    await waitFor(cdp, 'window.__harborBoardApi.getSceneElements().length === 6', 'seeded board');

    // Centre the seeded group in the canvas at 1:1 so nothing starts clamped.
    const centre = async () => {
      await cdp.eval(`(() => {
        const api = window.__harborBoardApi;
        const app = api.getAppState();
        api.updateScene({ appState: { zoom: { value: 1 }, scrollX: (app.width - ${GROUP_W}) / 2, scrollY: (app.height - ${GROUP_H}) / 2 } });
      })()`);
      await sleep(250);
    };
    await centre();

    // ---- helpers -------------------------------------------------------------------
    // A `line` stores its points relative to x/y and rebases them onto points[0], so its
    // x is NOT its left edge: `bounds` is the absolute box every geometry claim uses.
    const readEl = (id) => cdp.eval(`(() => {
      const e = window.__harborBoardApi.getSceneElements().find((x) => x.id === '${id}');
      if (!e) return null;
      const pts = e.points || [];
      const bounds = pts.length
        ? {
          x: e.x + Math.min(...pts.map((p) => p[0])),
          y: e.y + Math.min(...pts.map((p) => p[1])),
          w: Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])),
          h: Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])),
        }
        : { x: e.x, y: e.y, w: e.width, h: e.height };
      return {
        bounds,
        id: e.id, type: e.type, x: e.x, y: e.y, w: e.width, h: e.height,
        bg: e.backgroundColor, stroke: e.strokeColor, strokeWidth: e.strokeWidth,
        strokeStyle: e.strokeStyle || 'solid', opacity: e.opacity, roundness: e.roundness || null,
        customData: e.customData || null, points: (e.points || []).length,
        firstPoint: (e.points || [])[0] || null, lastPoint: (e.points || []).at(-1) || null,
        containerId: e.containerId || null, boundElements: e.boundElements || [],
        fontFamily: e.fontFamily ?? null, fontSize: e.fontSize ?? null, textAlign: e.textAlign ?? null,
        startBinding: e.startBinding || null, endBinding: e.endBinding || null,
      };
    })()`);

    const clientBox = (id) => cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const z = app.zoom.value;
      const e = api.getSceneElements().find((x) => x.id === '${id}');
      if (!e) return null;
      const left = (e.x + app.scrollX) * z + (app.offsetLeft || 0);
      const top = (e.y + app.scrollY) * z + (app.offsetTop || 0);
      const w = e.width * z;
      const h = e.height * z;
      return { left, top, width: w, height: h, right: left + w, bottom: top + h, cx: left + w / 2, cy: top + h / 2 };
    })()`);

    const barRect = () => cdp.eval(`(() => {
      const bar = document.querySelector('.wb-float-bar');
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, cx: r.left + r.width / 2, place: bar.dataset.place };
    })()`);

    // Click the CENTRE of a real control, refusing when something covers it: a toolbar
    // painted under the canvas or behind a menu is exactly the defect worth catching.
    const clickEl = async (selector, label) => {
      const info = await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        // A long palette scrolls inside its panel, which is what a user does to reach
        // the row they want; the click still has to land on the real, visible control.
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return { covered: true, reason: 'zero size' };
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        const hit = Boolean(top && (top === el || el.contains(top) || top.contains(el)));
        const box = (n) => (n ? \`\${n.tagName}\${n.className ? '.' + String(n.className).split(' ')[0] : ''}@\${Math.round(n.getBoundingClientRect().left)},\${Math.round(n.getBoundingClientRect().top)} \${Math.round(n.getBoundingClientRect().width)}x\${Math.round(n.getBoundingClientRect().height)}\` : 'nothing');
        return { x, y, covered: !hit, reason: hit ? '' : \`want \${box(el)} got \${box(top)}\` };
      })()`);
      if (!info) throw new Error(`no element for ${label || selector}`);
      if (info.covered) throw new Error(`${label || selector} is not clickable at its centre (${info.reason})`);
      await cdp.click(info.x, info.y);
      return info;
    };

    const setRange = async (selector, value) => {
      await cdp.eval(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '${value}');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(200);
    };

    const selectedIds = () => cdp.eval("Object.keys(window.__harborBoardApi.getAppState().selectedElementIds || {}).sort().join(',')");

    // Select by really clicking the shape, and PROVE the click took: the floating card
    // now lives over the canvas, so a click that lands on chrome instead of the board
    // must fail loudly here rather than cascade into a wrong-selection mystery further
    // down. One retry lands a quarter into the shape, away from anything centred on it.
    const select = async (id) => {
      const box = await clientBox(id);
      await cdp.click(box.cx, box.cy);
      await sleep(300);
      if (await selectedIds() !== id) {
        const at = await cdp.eval(`(() => {
          const el = document.elementFromPoint(${box.cx}, ${box.cy});
          return el ? el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '') : 'nothing';
        })()`);
        await cdp.click(box.left + box.width * 0.25, box.top + box.height * 0.75);
        await sleep(300);
        const after = await selectedIds();
        if (after !== id) throw new Error(`clicking ${id} selected "${after}" (centre hit ${at})`);
      }
      return clientBox(id);
    };

    const openMenu = async (label) => {
      await clickEl(`.wb-float-bar [aria-label="${label}"]`, label);
      await sleep(220);
      return cdp.eval(`(() => {
        const btn = document.querySelector('.wb-float-bar [aria-label="${label}"]');
        const menu = document.querySelector('.wb-tb-menu');
        if (!btn || !menu) return null;
        const b = btn.getBoundingClientRect();
        const m = menu.getBoundingClientRect();
        return { btnBottom: b.bottom, menuTop: m.top, menuLeft: m.left, menuRight: m.right, menuBottom: m.bottom, width: m.width, height: m.height };
      })()`);
    };

    // ---- Spec 1: the card floats ABOVE the selection, centred on it (finding 76) -----
    let boxA = await select(A.id);
    await waitFor(cdp, "Boolean(document.querySelector('.wb-float-bar'))", 'floating toolbar');
    let bar1 = await barRect();
    report(Boolean(bar1), 'selecting a shape raises the floating toolbar');
    report(bar1.place === 'above' && bar1.bottom <= boxA.top, 'the toolbar sits ABOVE the selection', `barBottom=${bar1.bottom.toFixed(0)} shapeTop=${boxA.top.toFixed(0)} place=${bar1.place}`);
    report(Math.abs(bar1.cx - boxA.cx) <= 2, 'the toolbar is centred on the selection', `barCx=${bar1.cx.toFixed(1)} shapeCx=${boxA.cx.toFixed(1)}`);
    report(boxA.top - bar1.bottom <= 16, 'the toolbar sits just off the selection, not floating away', `gap=${(boxA.top - bar1.bottom).toFixed(1)}px`);
    const noBottomBar = await cdp.eval("(() => { const b = document.querySelector('.wb-float-bar'); return b ? getComputedStyle(b).position : null; })()");
    report(noBottomBar === 'fixed', 'the selection bar is a viewport-anchored card, not the old bottom chrome', `position=${noBottomBar}`);
    await cdp.shot('01-toolbar-above-selection');

    // ---- Spec 2: a connector selection floats the same card, with its own controls ---
    const linkBox = await clientBox('link');
    await cdp.click(linkBox.cx, linkBox.cy);
    await sleep(400);
    const connBar = await cdp.eval(`(() => {
      const bar = document.querySelector('.wb-float-bar.wb-connector-bar');
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, cx: r.left + r.width / 2, place: bar.dataset.place, type: Boolean(bar.querySelector('[aria-label="Line type"]')), arrange: Boolean(bar.querySelector('[aria-label="Arrange"]')) };
    })()`);
    report(Boolean(connBar), 'selecting a connector raises the connector bar in the same floating card');
    report(connBar && connBar.type && connBar.arrange, 'it keeps the connector controls and gains Arrange / More', JSON.stringify(connBar && { type: connBar.type, arrange: connBar.arrange }));
    const connGeom = await cdp.eval(`(() => {
      const bar = document.querySelector('.wb-float-bar');
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const z = app.zoom.value;
      const e = api.getSceneElements().find((x) => x.id === 'link');
      const top = (e.y + app.scrollY) * z + (app.offsetTop || 0);
      return { barBottom: bar.getBoundingClientRect().bottom, arrowTop: top };
    })()`);
    report(connGeom.barBottom <= connGeom.arrowTop + 1, 'the connector card sits above the connector too', `barBottom=${connGeom.barBottom.toFixed(0)} arrowTop=${connGeom.arrowTop.toFixed(0)}`);
    await clickEl('.wb-float-bar [aria-label="Line type"]', 'Line type');
    await sleep(260);
    const typeGeom = await cdp.eval(`(() => {
      const btn = document.querySelector('.wb-float-bar [aria-label="Line type"]');
      const menu = document.querySelector('.wb-conn-type');
      if (!menu) return null;
      const b = btn.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      return { btnBottom: b.bottom, menuTop: m.top, routing: menu.querySelectorAll('[aria-label$="connector"]').length, onScreen: m.top >= 0 && m.bottom <= window.innerHeight };
    })()`);
    report(Boolean(typeGeom) && typeGeom.menuTop >= typeGeom.btnBottom && typeGeom.onScreen,
      'the connector Type submenu opens DOWN and stays on screen', JSON.stringify(typeGeom));
    await cdp.shot('09-connector-card');
    // Curved, not elbow: an orthogonal route between two horizontally aligned endpoints
    // with nothing in the way IS a straight segment, so elbow would prove nothing here.
    await clickEl('.wb-conn-type [aria-label="Curved connector"]', 'Curved connector');
    await sleep(400);
    const curved = await readEl('link');
    report(curved.points === 3 && curved.roundness && curved.roundness.type === 2,
      'the connector controls still apply through the floating card', `points=${curved.points} roundness=${JSON.stringify(curved.roundness)}`);
    await cdp.key('Escape');
    await sleep(200);

    // Back to the shape for the tracking spec, with a fresh baseline for the card.
    boxA = await select(A.id);
    bar1 = await barRect();

    // ---- Spec 3: it TRACKS the selection through a real drag ------------------------
    await cdp.drag(boxA.cx, boxA.cy, boxA.cx + 90, boxA.cy + 70);
    await sleep(350);
    const boxA2 = await clientBox(A.id);
    const bar2 = await barRect();
    report(Math.hypot(boxA2.cx - boxA.cx, boxA2.cy - boxA.cy) > 40, 'the drag actually moved the shape', `moved=${Math.hypot(boxA2.cx - boxA.cx, boxA2.cy - boxA.cy).toFixed(0)}px`);
    report(Math.abs(bar2.cx - boxA2.cx) <= 3, 'the toolbar tracked the dragged shape horizontally', `barCx=${bar2.cx.toFixed(1)} shapeCx=${boxA2.cx.toFixed(1)}`);
    report(bar2.bottom <= boxA2.top && Math.abs(bar2.bottom - bar1.bottom) > 20, 'the toolbar tracked it vertically and stayed above', `barBottom ${bar1.bottom.toFixed(0)} -> ${bar2.bottom.toFixed(0)} shapeTop=${boxA2.top.toFixed(0)}`);

    // The rail owns the left edge; the card is clamped clear of it at every position.
    const railClear = await cdp.eval(`(() => {
      const rail = document.querySelector('.wb-rail');
      const bar = document.querySelector('.wb-float-bar');
      if (!rail || !bar) return null;
      const r = rail.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return { railRight: r.right, barLeft: b.left };
    })()`);
    report(railClear.barLeft >= railClear.railRight - 1, 'the toolbar never overlaps the tool rail', `railRight=${railClear.railRight.toFixed(0)} barLeft=${railClear.barLeft.toFixed(0)}`);

    // ---- Spec 3: the Border popover writes every one of its controls (finding 47) ----
    const borderMenu = await openMenu('Border options');
    report(Boolean(borderMenu) && borderMenu.menuTop >= borderMenu.btnBottom, 'the border submenu opens DOWN from its button (finding 76)', `btnBottom=${borderMenu && borderMenu.btnBottom.toFixed(0)} menuTop=${borderMenu && borderMenu.menuTop.toFixed(0)}`);
    const borderShape = await cdp.eval(`(() => {
      const menu = document.querySelector('.wb-tb-menu');
      return {
        styles: menu.querySelectorAll('[aria-label$="border"]').length,
        sliders: [...menu.querySelectorAll('.wb-tb-slider')].map((s) => s.querySelector('.wb-tb-slider-foot span').textContent),
        radius: Boolean(menu.querySelector('[aria-label="Corner radius"]')),
        noColor: Boolean(menu.querySelector('[aria-label="No color"]')),
      };
    })()`);
    report(borderShape.styles === 3, 'border style row offers solid / dashed / dotted', `styles=${borderShape.styles}`);
    report(borderShape.sliders.join(',') === 'Thickness,Opacity,Rounded corners', 'the popover carries Thickness, Opacity and Rounded corners', borderShape.sliders.join(','));
    report(borderShape.radius && borderShape.noColor, 'it carries the numeric corner radius and a No color button');
    await cdp.shot('02-border-popover');

    await clickEl('.wb-tb-menu [aria-label="Dashed border"]', 'Dashed border');
    await sleep(260);
    let elA = await readEl(A.id);
    report(elA.strokeStyle === 'dashed', 'Dashed writes strokeStyle onto the element', `strokeStyle=${elA.strokeStyle}`);

    await setRange('.wb-tb-menu [aria-label="Thickness"]', 6);
    elA = await readEl(A.id);
    report(elA.strokeWidth === 6, 'the Thickness slider writes strokeWidth', `strokeWidth=${elA.strokeWidth}`);

    await setRange('.wb-tb-menu [aria-label="Opacity"]', 60);
    elA = await readEl(A.id);
    report(elA.opacity === 60, 'the Opacity slider writes opacity', `opacity=${elA.opacity}`);

    await cdp.eval(`(() => {
      const input = document.querySelector('.wb-tb-menu [aria-label="Corner radius"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '24');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(260);
    elA = await readEl(A.id);
    report(Boolean(elA.roundness) && elA.roundness.type === 3 && elA.roundness.value === 24,
      'Rounded corners writes a REAL numeric radius Excalidraw renders', JSON.stringify(elA.roundness));

    await clickEl('.wb-tb-menu [aria-label="Brand colors: Luminous"]', 'Luminous swatch');
    await sleep(260);
    elA = await readEl(A.id);
    report(elA.stroke === '#437ffe', 'a Brand swatch writes its exact catalog hex to the border', `strokeColor=${elA.stroke}`);

    // ---- Spec 4: the palette is Miro Brand / All structure (finding 26) --------------
    const palette = await cdp.eval(`(() => {
      const menu = document.querySelector('.wb-tb-menu');
      const sections = [...menu.querySelectorAll('.wb-palette-section')].map((s) => ({
        label: s.querySelector('.wb-palette-label').textContent,
        swatches: s.querySelectorAll('.wb-dot-swatch').length,
      }));
      const tail = menu.querySelector('.wb-palette-tail');
      const first = menu.querySelector('.wb-dot-swatch');
      const r = first.getBoundingClientRect();
      return {
        sections,
        tail: tail ? tail.textContent.trim() : null,
        custom: Boolean(tail && tail.querySelector('.wb-swatch-custom')),
        eyedrop: Boolean(tail && tail.querySelector('.wb-eyedrop')),
        swatchW: Math.round(r.width),
        round: getComputedStyle(first).borderRadius,
        cols: getComputedStyle(menu.querySelector('.wb-palette-grid')).gridTemplateColumns.split(' ').length,
      };
    })()`);
    report(palette.sections.length === 2 && palette.sections[0].label === 'Brand colors' && palette.sections[1].label === 'All colors',
      'the palette is two labelled sections, Brand then All', JSON.stringify(palette.sections.map((s) => s.label)));
    report(palette.sections[0].swatches === 18 && palette.sections[1].swatches === 23,
      'both sections carry the catalog counts (18 brand, 23 named)', JSON.stringify(palette.sections.map((s) => s.swatches)));
    report(palette.cols === 4, 'swatches sit four to a row like Miro', `cols=${palette.cols}`);
    report(palette.swatchW === 30 && palette.round === '50%', 'swatches are the ~30px round discs Miro draws', `${palette.swatchW}px ${palette.round}`);
    report(/Add a custom color/.test(palette.tail || '') && palette.custom && palette.eyedrop, 'the custom-colour tail closes the panel', palette.tail);

    await clickEl('.wb-tb-menu [aria-label="No color"]', 'No color (border)');
    await sleep(260);
    elA = await readEl(A.id);
    report(elA.stroke === 'transparent', 'No color removes the border entirely', `strokeColor=${elA.stroke}`);
    await cdp.key('Escape');
    await sleep(200);

    // ---- Spec 5: the Fill popover (finding 48) ---------------------------------------
    const fillMenu = await openMenu('Fill colour');
    report(fillMenu.menuTop >= fillMenu.btnBottom, 'the fill submenu opens DOWN from its button', `menuTop=${fillMenu.menuTop.toFixed(0)}`);
    const fillShape = await cdp.eval(`(() => {
      const menu = document.querySelector('.wb-tb-menu');
      return {
        opacityFirst: menu.querySelector('.wb-tb-slider .wb-tb-slider-foot span').textContent,
        sliders: menu.querySelectorAll('.wb-tb-slider').length,
        noColor: Boolean(menu.querySelector('[aria-label="No color"]')),
        sections: menu.querySelectorAll('.wb-palette-section').length,
      };
    })()`);
    report(fillShape.opacityFirst === 'Opacity' && fillShape.sliders === 1 && fillShape.noColor && fillShape.sections === 2,
      'the fill popover is opacity on top, No color, then the same palette', JSON.stringify(fillShape));
    await clickEl('.wb-tb-menu [aria-label="All colors: Yellow"]', 'All colors Yellow');
    await sleep(260);
    elA = await readEl(A.id);
    report(elA.bg === '#ffdc4a', 'an All-colors swatch writes its exact catalog hex to the fill', `backgroundColor=${elA.bg}`);
    await cdp.shot('03-fill-popover');
    await clickEl('.wb-tb-menu [aria-label="No color"]', 'No color (fill)');
    await sleep(260);
    elA = await readEl(A.id);
    report(elA.bg === 'transparent', 'No color clears the fill', `backgroundColor=${elA.bg}`);
    // put a real fill back so the copy-style spec has something to carry
    await clickEl('.wb-tb-menu [aria-label="Brand colors: Emerald"]', 'Emerald swatch');
    await sleep(260);
    elA = await readEl(A.id);
    report(elA.bg === '#24b27c', 'the fill takes a second Brand colour cleanly', `backgroundColor=${elA.bg}`);
    await cdp.key('Escape');
    await sleep(200);

    // ---- Spec 6: the typography row on a text-bearing element (findings 49-51) -------
    await select(LAB.id);
    const typo = await cdp.eval(`(() => {
      const bar = document.querySelector('.wb-float-bar');
      return {
        font: Boolean(bar.querySelector('[aria-label="Font"]')),
        size: Boolean(bar.querySelector('[aria-label="Text size"]')),
        align: Boolean(bar.querySelector('[aria-label="Text alignment"]')),
        color: Boolean(bar.querySelector('[aria-label="Text colour"]')),
      };
    })()`);
    report(typo.font && typo.size && typo.align && typo.color, 'a text-bearing selection grows the typography row', JSON.stringify(typo));

    const fontMenu = await openMenu('Font');
    report(fontMenu.menuTop >= fontMenu.btnBottom, 'the font list opens DOWN from its button');
    await clickEl('.wb-tb-menu [aria-label="Lilita One"]', 'Lilita One');
    await sleep(300);
    let label = await readEl('lab-text');
    report(label.fontFamily === 7, 'the font list writes fontFamily onto the bound label', `fontFamily=${label.fontFamily}`);

    const sizeBefore = label.fontSize;
    await clickEl('.wb-float-bar [aria-label="Bigger text"]', 'Bigger text');
    await sleep(320);
    label = await readEl('lab-text');
    report(label.fontSize === sizeBefore + 2, 'the size stepper writes fontSize', `fontSize ${sizeBefore} -> ${label.fontSize}`);
    report(Math.abs(label.h - label.fontSize * 1.25) < 1.5, 'the bound label was RE-LAID-OUT for the new size, not left at the old box', `height=${label.h.toFixed(1)} want=${(label.fontSize * 1.25).toFixed(1)}`);

    await openMenu('Text alignment');
    await clickEl('.wb-tb-menu [aria-label="Align right"]', 'Align right');
    await sleep(300);
    label = await readEl('lab-text');
    report(label.textAlign === 'right', 'the alignment submenu writes textAlign', `textAlign=${label.textAlign}`);

    await openMenu('Text colour');
    await clickEl('.wb-tb-menu [aria-label="All colors: Dark Violet"]', 'Dark Violet');
    await sleep(300);
    label = await readEl('lab-text');
    report(label.stroke === '#6631d7', 'the text-colour popover recolours the LABEL, not the container', `labelStroke=${label.stroke}`);
    const container = await readEl(LAB.id);
    report(container.stroke !== '#6631d7', 'the container keeps its own border colour', `containerStroke=${container.stroke}`);
    await cdp.shot('04-typography');
    await cdp.key('Escape');
    await sleep(200);

    // ---- Spec 7a: switch type carries a label across the container / poly divide -----
    const switchMenu = await openMenu('Switch type');
    report(switchMenu.menuTop >= switchMenu.btnBottom, 'the switch-type grid opens DOWN from its button');
    const grid = await cdp.eval(`(() => {
      const menu = document.querySelector('.wb-tb-menu');
      return {
        glyphs: menu.querySelectorAll('.wb-switch-grid .wb-tb-glyph').length,
        cols: getComputedStyle(menu.querySelector('.wb-switch-grid')).gridTemplateColumns.split(' ').length,
        allShapes: Boolean(menu.querySelector('.wb-tb-allshapes')),
      };
    })()`);
    report(grid.glyphs === 12 && grid.cols === 4 && grid.allShapes, 'the quick-convert grid is 12 glyphs in 4 columns plus All shapes', JSON.stringify(grid));
    await cdp.shot('05-switch-type-grid');
    await clickEl('.wb-tb-menu .wb-tb-allshapes', 'All shapes');
    await sleep(220);
    const expanded = await cdp.eval("document.querySelectorAll('.wb-tb-menu .wb-switch-grid .wb-tb-glyph').length");
    report(expanded === SHAPE_DEFS.length, 'All shapes expands to every shape the board draws', `glyphs=${expanded} catalog=${SHAPE_DEFS.length}`);

    // Cross is deliberately a shape the QUICK grid does NOT offer, so this also proves
    // the All-shapes expansion reaches real conversions, and it fills its whole box, so
    // the geometry claim below is exact rather than "inscribed somewhere in there".
    const labBefore = await readEl(LAB.id);
    await clickEl('.wb-tb-menu [aria-label="Switch to Cross"]', 'Switch to Cross');
    await sleep(400);
    const star = await readEl(LAB.id);
    label = await readEl('lab-text');
    report(star.type === 'line' && star.customData && star.customData.polyShape === 'cross', 'switching to a poly shape converts the element in place', `type=${star.type} poly=${star.customData && star.customData.polyShape}`);
    const sameBox = (a, b) => ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= 1);
    report(sameBox(star.bounds, labBefore.bounds), 'the shape never moves on the board through a conversion',
      `${JSON.stringify(star.bounds)} was ${JSON.stringify(labBefore.bounds)}`);
    report(star.points === 13 && JSON.stringify(star.firstPoint) === JSON.stringify(star.lastPoint), 'the poly is a CLOSED filled polygon', `points=${star.points}`);
    report(label.containerId === null && label.customData && label.customData.labelFor === LAB.id,
      'the bound label became the standalone tagged text a poly shape wears', `containerId=${label.containerId} labelFor=${label.customData && label.customData.labelFor}`);

    await openMenu('Switch type');
    await clickEl('.wb-tb-menu [aria-label="Switch to Rounded rectangle"]', 'Switch to Rounded rectangle');
    await sleep(400);
    const backRect = await readEl(LAB.id);
    label = await readEl('lab-text');
    report(backRect.type === 'rectangle' && backRect.roundness && backRect.roundness.type === 3, 'switching back makes a real rounded container', `type=${backRect.type} roundness=${JSON.stringify(backRect.roundness)}`);
    report(sameBox(backRect.bounds, labBefore.bounds), 'and the round trip lands the shape exactly where it started',
      `${JSON.stringify(backRect.bounds)} was ${JSON.stringify(labBefore.bounds)}`);
    report(label.containerId === LAB.id && (!label.customData || !label.customData.labelFor), 'the label is bound text again', `containerId=${label.containerId}`);
    report(backRect.boundElements.some((b) => b.type === 'text' && b.id === 'lab-text'), 'the container names its label again');
    await cdp.key('Escape');
    await sleep(200);

    // ---- Spec 7b: switch type preserves connector bindings ---------------------------
    await select(A.id);
    const beforeSwitch = await readEl(A.id);
    await openMenu('Switch type');
    await clickEl('.wb-tb-menu [aria-label="Switch to Ellipse"]', 'Switch to Ellipse');
    await sleep(400);
    const ellipse = await readEl(A.id);
    const linkAfter = await readEl('link');
    report(ellipse.type === 'ellipse', 'the rectangle became an ellipse', `type=${ellipse.type}`);
    report(sameBox(ellipse.bounds, beforeSwitch.bounds) && ellipse.bg === beforeSwitch.bg, 'the conversion kept its box and paint', `${JSON.stringify(ellipse.bounds)} bg=${ellipse.bg}`);
    report(Boolean(linkAfter.startBinding) && linkAfter.startBinding.elementId === A.id, 'the connector bound to it is still bound', JSON.stringify(linkAfter.startBinding));
    const barAfterSwitch = await barRect();
    const boxAfterSwitch = await clientBox(A.id);
    report(Math.abs(barAfterSwitch.cx - boxAfterSwitch.cx) <= 2 && barAfterSwitch.bottom <= boxAfterSwitch.top, 'the toolbar stays above the converted shape');
    // Back to a rectangle, which is the one type that can carry a numeric corner radius,
    // so the copy-style spec below has a real radius to prove travels with the recipe.
    await openMenu('Switch type');
    await clickEl('.wb-tb-menu [aria-label="Switch to Rectangle"]', 'Switch to Rectangle');
    await sleep(400);
    const backFromEllipse = await readEl(A.id);
    report(backFromEllipse.type === 'rectangle' && sameBox(backFromEllipse.bounds, beforeSwitch.bounds),
      'and back to a rectangle without moving', `${JSON.stringify(backFromEllipse.bounds)}`);
    await openMenu('Border options');
    await clickEl('.wb-tb-menu [aria-label="All colors: Dark Blue"]', 'Dark Blue border');
    await sleep(240);
    await cdp.eval(`(() => {
      const input = document.querySelector('.wb-tb-menu [aria-label="Corner radius"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '18');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(300);
    await cdp.key('Escape');
    await sleep(200);
    await cdp.shot('06-switched-to-ellipse');

    // ---- Spec 8: Arrange is the z-order submenu (finding 57) -------------------------
    const zOf = () => cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      return els.findIndex((e) => e.id === '${A.id}') - els.findIndex((e) => e.id === '${B.id}');
    })()`);
    const zBefore = await zOf();
    const arrangeMenu = await openMenu('Arrange');
    const arrangeRows = await cdp.eval(`(() => [...document.querySelectorAll('.wb-tb-menu .wb-tb-row')].map((r) => r.textContent))()`);
    report(arrangeMenu.menuTop >= arrangeMenu.btnBottom, 'the Arrange submenu opens DOWN from its button');
    report(arrangeRows.length === 4 && arrangeRows[0].startsWith('Bring forward') && arrangeRows[1].startsWith('Bring to front')
      && arrangeRows[2].startsWith('Send backward') && arrangeRows[3].startsWith('Send to back'),
    'Arrange is Miro four z-order rows in Miro order', JSON.stringify(arrangeRows));
    report(arrangeRows.join('').includes('PgUp') && arrangeRows.join('').includes('PgDn'), 'each row names its Miro shortcut');
    await cdp.shot('07-arrange-menu');
    await clickEl('.wb-tb-menu [aria-label="Bring to front"]', 'Bring to front');
    await sleep(400);
    const zFront = await zOf();
    report(zBefore < 0 && zFront > 0, 'Bring to front raises the selection past its neighbour', `relative order ${zBefore} -> ${zFront}`);
    await openMenu('Arrange');
    await clickEl('.wb-tb-menu [aria-label="Send to back"]', 'Send to back');
    await sleep(400);
    const zBack = await zOf();
    report(zBack < 0, 'Send to back returns it below', `relative order ${zBack}`);

    // ---- Spec 9: copy style / paste style (findings 56, 63) --------------------------
    const source = await readEl(A.id);
    await openMenu('More');
    const moreRows = await cdp.eval(`(() => [...document.querySelectorAll('.wb-tb-menu .wb-tb-row')].map((r) => ({ text: r.textContent, disabled: r.disabled })))()`);
    // Wave D filled in the two deeper Miro rows this menu had deferred (findings 56, 61).
    report(moreRows.length === 4
      && moreRows[0].text.startsWith('Copy style') && moreRows[1].text.startsWith('Paste style')
      && moreRows[2].text.startsWith('Copy as image') && moreRows[3].text.startsWith('Lock'),
    'the More menu carries Copy style, Paste style, Copy as image and Lock', JSON.stringify(moreRows.map((r) => r.text)));
    report(moreRows[1].disabled === true, 'Paste style is disabled until a style has been copied');
    await clickEl('.wb-tb-menu [aria-label="Copy style"]', 'Copy style');
    await sleep(300);

    const dstBefore = await readEl(DST.id);
    await select(DST.id);
    await openMenu('More');
    await clickEl('.wb-tb-menu [aria-label="Paste style"]', 'Paste style');
    await sleep(400);
    let dst = await readEl(DST.id);
    report(dst.bg === source.bg && dst.stroke === source.stroke && dst.strokeWidth === source.strokeWidth
      && dst.strokeStyle === source.strokeStyle && dst.opacity === source.opacity,
    'Paste style transfers the whole recipe', `bg=${dst.bg} stroke=${dst.stroke} width=${dst.strokeWidth} style=${dst.strokeStyle} opacity=${dst.opacity}`);
    report(source.roundness && source.roundness.value === 18 && JSON.stringify(dst.roundness) === JSON.stringify(source.roundness),
      'the corner radius travels with the style', `${JSON.stringify(dst.roundness)} from ${JSON.stringify(source.roundness)}`);
    report(dst.x === dstBefore.x && dst.y === dstBefore.y && dst.w === dstBefore.w && dst.h === dstBefore.h, 'paste style never moves or resizes the target', `${dst.x},${dst.y} ${dst.w}x${dst.h}`);
    await cdp.shot('08-style-pasted');

    // The keyboard path is the one Miro users actually use.
    await openMenu('Fill colour');
    await clickEl('.wb-tb-menu [aria-label="All colors: Light Green"]', 'Light Green');
    await sleep(260);
    dst = await readEl(DST.id);
    report(dst.bg === '#adf0c7', 'the target was restyled away from the copied recipe', `backgroundColor=${dst.bg}`);
    await cdp.key('Escape');
    await sleep(200);
    await select(A.id);
    await cdp.key('c', { ctrl: true, alt: true });
    await select(DST.id);
    await cdp.key('v', { ctrl: true, alt: true });
    await sleep(400);
    dst = await readEl(DST.id);
    report(dst.bg === source.bg && dst.stroke === source.stroke, 'Ctrl+Alt+C then Ctrl+Alt+V does the same job from the keyboard', `backgroundColor=${dst.bg}`);

    // ---- Spec 11: the card holds at a different zoom, and on a MULTI selection -------
    // A green drive that only ever measures one shape at 100% in the big window is not
    // proof: placement is client-space maths and has to hold wherever the board is.
    await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const e = api.getSceneElements().find((x) => x.id === '${LAB.id}');
      const z = 0.4;
      // Park the shape at the middle of the canvas so the clamps are out of the way and
      // the centring itself is what gets measured.
      api.updateScene({ appState: { zoom: { value: z }, scrollX: (app.width / 2) / z - (e.x + e.width / 2), scrollY: (app.height / 2) / z - (e.y + e.height / 2) } });
    })()`);
    await sleep(400);
    const zoomedBox = await select(LAB.id);
    const zoomedBar = await barRect();
    report(Math.abs(zoomedBar.cx - zoomedBox.cx) <= 3 && zoomedBar.bottom <= zoomedBox.top,
      'at 40% zoom the card is still centred above the selection', `barCx=${zoomedBar.cx.toFixed(1)} shapeCx=${zoomedBox.cx.toFixed(1)}`);
    await centre(); // back to 1:1 with the whole group in view for the specs below
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { 'a-rect': true, 'b-rect': true, 'lab-rect': true, 'dst-rect': true } } })");
    await sleep(400);
    const multi = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const z = app.zoom.value;
      const ids = ['a-rect', 'b-rect', 'lab-rect', 'dst-rect'];
      const els = api.getSceneElements().filter((e) => ids.includes(e.id));
      const left = Math.min(...els.map((e) => (e.x + app.scrollX) * z + (app.offsetLeft || 0)));
      const right = Math.max(...els.map((e) => (e.x + e.width + app.scrollX) * z + (app.offsetLeft || 0)));
      const top = Math.min(...els.map((e) => (e.y + app.scrollY) * z + (app.offsetTop || 0)));
      const bar = document.querySelector('.wb-float-bar');
      const b = bar.getBoundingClientRect();
      const view = { left: app.offsetLeft || 0, top: app.offsetTop || 0, width: app.width, height: app.height };
      return {
        unionCx: (left + right) / 2, unionTop: top,
        barCx: b.left + b.width / 2, barBottom: b.bottom,
        inside: b.left >= view.left && b.right <= view.left + view.width,
        switchBtn: Boolean(bar.querySelector('[aria-label="Switch type"]')),
      };
    })()`);
    report(Math.abs(multi.barCx - multi.unionCx) <= 3 && multi.barBottom <= multi.unionTop && multi.inside,
      'a multi-selection centres the card on the union box, still inside the canvas', JSON.stringify(multi));
    report(multi.switchBtn === false, 'switch type hides on a multi-selection (it converts ONE shape)', `switchBtn=${multi.switchBtn}`);
    await cdp.shot('12-multi-selection');

    // ---- Spec 12: the card flips BELOW when there is no room above -------------------
    const boxB = await select(B.id);
    await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      // Scroll the board so the selection sits 12px from the top of the CANVAS, which
      // is less room than the card needs above it.
      const want = (app.offsetTop || 0) + 12;
      api.updateScene({ appState: { scrollY: app.scrollY - (${Math.round(boxB.top)} - want) / app.zoom.value } });
    })()`);
    await sleep(400);
    const flipped = await barRect();
    const boxBTop = await clientBox(B.id);
    report(flipped.place === 'below' && flipped.top >= boxBTop.bottom - 1,
      'a selection pinned to the top edge flips the card BELOW it instead of off screen', `place=${flipped.place} barTop=${flipped.top.toFixed(0)} shapeBottom=${boxBTop.bottom.toFixed(0)}`);
    // And it stays on the BOARD: the card is clamped to the drawing surface, so it can
    // never ride up over the board header, the app banner, or the title bar.
    const inCanvas = await cdp.eval(`(() => {
      const app = window.__harborBoardApi.getAppState();
      const b = document.querySelector('.wb-float-bar').getBoundingClientRect();
      const view = { left: app.offsetLeft || 0, top: app.offsetTop || 0, width: app.width, height: app.height };
      return {
        view,
        inside: b.left >= view.left && b.top >= view.top && b.right <= view.left + view.width && b.bottom <= view.top + view.height,
        bar: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      };
    })()`);
    report(inCanvas.inside, 'the flipped card stays inside the canvas, never over the app chrome above it', JSON.stringify(inCanvas));
    await cdp.shot('10-flipped-below');

    // Deselect by clicking bare board, and the card goes away entirely (no bottom chrome
    // left behind). The empty point is found the way a user finds one: somewhere the
    // canvas is showing and nothing, chrome included, is in the way.
    const empty = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const z = app.zoom.value;
      const els = api.getSceneElements().filter((e) => !e.isDeleted);
      const rail = document.querySelector('.wb-rail').getBoundingClientRect();
      const bar = document.querySelector('.wb-float-bar');
      const b = bar ? bar.getBoundingClientRect() : null;
      const covers = (cx, cy) => els.some((e) => {
        const left = (e.x + app.scrollX) * z + (app.offsetLeft || 0);
        const top = (e.y + app.scrollY) * z + (app.offsetTop || 0);
        return cx >= left - 30 && cx <= left + e.width * z + 30 && cy >= top - 30 && cy <= top + e.height * z + 30;
      });
      for (let y = window.innerHeight - 80; y > 120; y -= 40) {
        for (let x = rail.right + 60; x < window.innerWidth - 140; x += 60) {
          if (covers(x, y)) continue;
          if (b && x >= b.left - 8 && x <= b.right + 8 && y >= b.top - 8 && y <= b.bottom + 8) continue;
          const el = document.elementFromPoint(x, y);
          if (el && el.tagName === 'CANVAS') return { x, y };
        }
      }
      return null;
    })()`);
    if (!empty) throw new Error('found no bare canvas point to deselect on');
    await cdp.click(empty.x, empty.y);
    await sleep(350);
    const gone = await cdp.eval("Boolean(document.querySelector('.wb-float-bar'))");
    const selNow = await selectedIds();
    report(!gone && selNow === '', 'the card disappears with the selection', `selection="${selNow}" card=${gone}`);
    await cdp.shot('11-deselected');

    report(cdp.errors.length === 0, 'zero console errors or exceptions', cdp.errors.slice(0, 3).join(' | ') || 'clean');
    report(failures.length === 0, 'drive-toolbar-win');
  } finally {
    child.kill();
  }
  console.log(`screenshots: ${OUT}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`FAIL drive crashed: ${error.message}`);
  process.exit(1);
});
