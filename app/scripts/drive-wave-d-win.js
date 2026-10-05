'use strict';
// Live proof of Wave D: the full shape catalog (catalog findings 23, 36), connectable
// TEXT (38), the right-click menus (62-64), frame presets (40), and the More rows Wave C
// deferred (56, 61), plus the CLI sticky's two-band shadow rendering on a real canvas.
//
// Real Input.dispatchMouseEvent / dispatchKeyEvent against a real Excalidraw board,
// offscreen, isolated profile. Boot cloned from drive-toolbar-win.js.
//
// Every assertion reads the ELEMENT DATA the gesture produced, not just the DOM: a menu
// that opens and writes nothing is the failure mode this drive exists to catch.
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9346;
const OUT = path.join(os.tmpdir(), 'harbor-drive-wave-d');
const BOARD_ID = 'wave-d-drive-board';

const model = require('../src/shared/board-model.cjs');
const {
  SHAPE_DEFS, SHAPE_GROUPS, STICKY_SHADOW_BANDS, FRAME_PRESETS,
} = require('../src/renderer/whiteboard/board-files.cjs');

// Deterministic ids so every assertion can name the element it means.
function seam(prefix) {
  let n = 0;
  let integer = 1;
  return { newId: () => `${prefix}-${++n}`, now: () => 1700000000000, randomInt: () => (integer += 7) };
}

// The contact sheet: every poly shape in the catalog, laid out in a grid, so ONE
// screenshot shows what all of them actually draw.
const SHEET_W = 150;
const SHEET_H = 110;
const SHEET_GAP = 40;
const SHEET_COLS = 6;
const POLY_DEFS = SHAPE_DEFS.filter((def) => def.kind === 'poly');

// The interactive fixtures, parked well clear of the sheet.
const TXT = { x: 0, y: 1400 };
const TGT = { x: 460, y: 1380, w: 180, h: 110 };
const LAB = { x: 0, y: 1650, w: 220, h: 120 };
const LINK_A = { x: 460, y: 1650, w: 160, h: 100 };
const LINK_B = { x: 820, y: 1650, w: 160, h: 100 };
const CLI_STICKY = { x: 0, y: 1900 };

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    this.requests = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params?.exceptionDetails?.text || 'exception');
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') this.errors.push(String(msg.params.args?.[0]?.value || 'console.error'));
      if (msg.method === 'Network.requestWillBeSent') this.requests.push(msg.params?.request?.url || '');
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

  async mouse(type, x, y, buttons, button) {
    // A hover move must carry button 'none' or Chromium drops the pointermove.
    const which = button || (type === 'mouseMoved' && !buttons ? 'none' : 'left');
    await this.send('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y), button: which, buttons,
      clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0,
    });
  }

  async click(x, y) {
    await this.mouse('mouseMoved', x, y, 0);
    await sleep(50);
    await this.mouse('mousePressed', x, y, 1);
    await sleep(40);
    await this.mouse('mouseReleased', x, y, 0);
    await sleep(160);
  }

  // A real secondary click: pressed + released with button 'right', which is what
  // Chromium turns into a contextmenu event.
  async rightClick(x, y) {
    await this.mouse('mouseMoved', x, y, 0);
    await sleep(60);
    await this.mouse('mousePressed', x, y, 2, 'right');
    await sleep(40);
    await this.mouse('mouseReleased', x, y, 0, 'right');
    await sleep(260);
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
    await sleep(220);
  }

  async key(key, opts = {}) {
    const keyDefs = {
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      l: { key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76 },
      d: { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 },
    };
    const def = keyDefs[key];
    if (!def) throw new Error(`no key def for ${key}`);
    let modifiers = 0;
    if (opts.alt) modifiers |= 1;
    if (opts.ctrl) modifiers |= 2;
    if (opts.shift) modifiers |= 8;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...def });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...def });
    await sleep(160);
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

const DOTS_EXPR = `[...document.querySelectorAll('button.wb-connect-dot')].map((b) => ({
  side: (b.getAttribute('aria-label') || '').replace('Connect from ', ''),
  x: parseFloat(b.style.left), y: parseFloat(b.style.top),
}))`;

async function hoverDots(cdp, cx, cy, label) {
  const deadline = Date.now() + 9000;
  for (;;) {
    await cdp.mouse('mouseMoved', cx, cy, 0);
    await sleep(120);
    await cdp.mouse('mouseMoved', cx + 2, cy + 1, 0);
    await sleep(180);
    if (await cdp.eval("document.querySelectorAll('button.wb-connect-dot').length") === 4) break;
    if (Date.now() > deadline) {
      await cdp.shot(`fail-${label.replace(/\s+/g, '-')}`);
      throw new Error(`timeout waiting for ${label} dots`);
    }
  }
  const dots = await cdp.eval(DOTS_EXPR);
  return Object.fromEntries(dots.map((d) => [d.side, d]));
}

function buildBoard() {
  const ctx = seam('sheet');
  const elements = [];
  POLY_DEFS.forEach((def, i) => {
    const col = i % SHEET_COLS;
    const row = Math.floor(i / SHEET_COLS);
    const [el] = model.shape({
      shape: def.key, id: `poly-${def.key}`,
      x: col * (SHEET_W + SHEET_GAP), y: row * (SHEET_H + SHEET_GAP),
      width: SHEET_W, height: SHEET_H, backgroundColor: '#a5d8ff', strokeColor: '#1e1e1e',
    }, ctx);
    elements.push(el);
  });
  // A standalone text: Miro's connectable text (finding 38).
  elements.push(model.textNote({ id: 'free-text', x: TXT.x, y: TXT.y, text: 'Connect me', fontSize: 28 }, seam('txt')));
  const target = model.shape({ shape: 'rectangle', id: 'target-rect', x: TGT.x, y: TGT.y, width: TGT.w, height: TGT.h, backgroundColor: '#ffffff' }, seam('tgt'))[0];
  elements.push(target);
  // A labelled shape, for Clear content and for the bound-label-is-not-connectable rule.
  const [labelled, boundLabel] = model.shape({ shape: 'rectangle', id: 'labelled', x: LAB.x, y: LAB.y, width: LAB.w, height: LAB.h, text: 'Label', backgroundColor: '#ffe066' }, seam('lab'));
  elements.push(labelled, boundLabel);
  // Two shapes joined by a connector, for the connector context menu.
  const a = model.shape({ shape: 'rectangle', id: 'link-a', x: LINK_A.x, y: LINK_A.y, width: LINK_A.w, height: LINK_A.h, backgroundColor: '#d0ebff' }, seam('la'))[0];
  const b = model.shape({ shape: 'rectangle', id: 'link-b', x: LINK_B.x, y: LINK_B.y, width: LINK_B.w, height: LINK_B.h, backgroundColor: '#d3f9d8' }, seam('lb'))[0];
  const link = model.connector({ id: 'link', source: a, target: b }, seam('ln'));
  elements.push(a, b, link);
  // The CLI-authored sticky: the follow-up under test is that its shadow is now the SAME
  // two-band object the app writes, and that the app's own glue pass agrees with it.
  elements.push(...model.stickyNote({ color: 'yellow', x: CLI_STICKY.x, y: CLI_STICKY.y, text: 'CLI sticky' }, seam('cli')));
  return elements;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wave-d-'));
  const userData = path.join(tmp, 'userData');
  const boardsDir = path.join(tmp, 'boards');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });

  const elements = buildBoard();
  const seededViolations = model.validateScene({ elements, files: {} });
  fs.writeFileSync(path.join(boardsDir, `${BOARD_ID}.json`), JSON.stringify({
    type: 'excalidraw', version: 2, source: 'local', name: 'Wave D drive',
    updatedAt: new Date().toISOString(), elements, appState: {}, files: {},
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
    await cdp.send('Network.enable');

    await waitFor(cdp, "[...document.querySelectorAll('.view-switch-btn')].some((b) => (b.getAttribute('aria-label') || '') === 'Board')", 'Board tab');
    await cdp.eval("[...document.querySelectorAll('.view-switch-btn')].find((b) => (b.getAttribute('aria-label') || '') === 'Board').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.excalidraw canvas') && window.__harborBoardApi)", 'Excalidraw canvas');
    await waitFor(cdp, `window.__harborBoardApi.getSceneElements().length === ${elements.length}`, 'seeded board');

    // ---- helpers -------------------------------------------------------------------
    // A `line` stores its points relative to x/y and rebases them onto points[0], so its
    // x is NOT its left edge: `bounds` is the absolute box every geometry claim uses.
    const readEl = (id) => cdp.eval(`(() => {
      const e = window.__harborBoardApi.getSceneElementsIncludingDeleted().find((x) => x.id === '${id}');
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
        bounds, id: e.id, type: e.type, x: e.x, y: e.y, w: e.width, h: e.height,
        bg: e.backgroundColor, stroke: e.strokeColor, fillStyle: e.fillStyle,
        locked: Boolean(e.locked), isDeleted: Boolean(e.isDeleted), opacity: e.opacity,
        customData: e.customData || null, points: (e.points || []).length,
        containerId: e.containerId || null, boundElements: e.boundElements || [],
        startBinding: e.startBinding || null, endBinding: e.endBinding || null,
        text: e.text ?? null, name: e.name ?? null,
      };
    })()`);

    const clientBox = (id) => cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const z = app.zoom.value;
      const e = api.getSceneElements().find((x) => x.id === '${id}');
      if (!e) return null;
      const pts = e.points || [];
      const bx = pts.length ? e.x + Math.min(...pts.map((p) => p[0])) : e.x;
      const by = pts.length ? e.y + Math.min(...pts.map((p) => p[1])) : e.y;
      const left = (bx + app.scrollX) * z + (app.offsetLeft || 0);
      const top = (by + app.scrollY) * z + (app.offsetTop || 0);
      const w = e.width * z;
      const h = e.height * z;
      return { left, top, width: w, height: h, right: left + w, bottom: top + h, cx: left + w / 2, cy: top + h / 2 };
    })()`);

    // Centre a scene box in the canvas at 1:1, so nothing under test starts clamped or
    // hidden behind the rail.
    const focusOn = async (x, y, w, h, zoom = 1) => {
      await cdp.eval(`(() => {
        const api = window.__harborBoardApi;
        const app = api.getAppState();
        api.updateScene({ appState: { zoom: { value: ${zoom} }, scrollX: (app.width / ${zoom} - ${w}) / 2 - ${x}, scrollY: (app.height / ${zoom} - ${h}) / 2 - ${y} } });
      })()`);
      await sleep(280);
    };

    const selectedIds = () => cdp.eval("Object.keys(window.__harborBoardApi.getAppState().selectedElementIds || {}).sort().join(',')");

    const clickEl = async (selector, label) => {
      const info = await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return { covered: true, reason: 'zero size' };
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        const hit = Boolean(top && (top === el || el.contains(top) || top.contains(el)));
        const box = (n) => (n ? \`\${n.tagName}\${n.className ? '.' + String(n.className).split(' ')[0] : ''}@\${Math.round(n.getBoundingClientRect().left)},\${Math.round(n.getBoundingClientRect().top)}\` : 'nothing');
        return { x, y, covered: !hit, reason: hit ? '' : \`want \${box(el)} got \${box(top)}\` };
      })()`);
      if (!info) throw new Error(`no element for ${label || selector}`);
      if (info.covered) throw new Error(`${label || selector} is not clickable at its centre (${info.reason})`);
      await cdp.click(info.x, info.y);
      return info;
    };

    const select = async (id) => {
      const box = await clientBox(id);
      await cdp.click(box.cx, box.cy);
      await sleep(280);
      if (await selectedIds() !== id) {
        await cdp.click(box.left + box.width * 0.3, box.top + box.height * 0.7);
        await sleep(280);
        const after = await selectedIds();
        if (after !== id) throw new Error(`clicking ${id} selected "${after}"`);
      }
      return clientBox(id);
    };

    const ctxRows = () => cdp.eval(`(() => {
      const menu = document.querySelector('.wb-ctx-menu');
      if (!menu) return null;
      const r = menu.getBoundingClientRect();
      return {
        kind: menu.dataset.kind,
        label: menu.getAttribute('aria-label'),
        rows: [...menu.querySelectorAll(':scope > button, :scope > .wb-ctx-host > button')].map((b) => ({
          label: b.getAttribute('aria-label'), disabled: b.disabled,
        })),
        seps: menu.querySelectorAll('.wb-ctx-sep').length,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        onScreen: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        excalidrawMenu: Boolean(document.querySelector('.excalidraw .context-menu')),
      };
    })()`);

    const clickCtxRow = async (label) => {
      await clickEl(`.wb-ctx-menu [aria-label="${label}"]`, `context row ${label}`);
      await sleep(320);
    };

    // ================================================================================
    // Spec 1: the shape catalog renders, in sections, and every glyph draws (23, 36)
    // ================================================================================
    report(seededViolations.length === 0, 'the seeded board is a valid scene', seededViolations.slice(0, 3).join(' | ') || 'clean');
    const sheetW = SHEET_COLS * (SHEET_W + SHEET_GAP);
    const sheetH = Math.ceil(POLY_DEFS.length / SHEET_COLS) * (SHEET_H + SHEET_GAP);
    await focusOn(0, 0, sheetW, sheetH, 0.6);
    await cdp.shot('01-shape-catalog-sheet');
    const drawn = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.polyShape);
      return {
        count: els.length,
        allLines: els.every((e) => e.type === 'line'),
        allFilled: els.every((e) => e.fillStyle === 'solid' && e.backgroundColor !== 'transparent'),
        allClosed: els.every((e) => {
          const p = e.points;
          return p.length > 2 && Math.abs(p[0][0] - p.at(-1)[0]) < 0.01 && Math.abs(p[0][1] - p.at(-1)[1]) < 0.01;
        }),
        keys: els.map((e) => e.customData.polyShape).sort().join(','),
      };
    })()`);
    report(drawn.count === POLY_DEFS.length, `all ${POLY_DEFS.length} poly shapes render on the board`, `count=${drawn.count}`);
    report(drawn.allLines && drawn.allFilled && drawn.allClosed, 'every one is a closed, solid-filled line element', JSON.stringify({ lines: drawn.allLines, filled: drawn.allFilled, closed: drawn.allClosed }));
    report(drawn.keys === POLY_DEFS.map((d) => d.key).sort().join(','), 'and each carries its own catalog key');

    // The flyout is SECTIONED, and every catalog glyph is reachable from it.
    await clickEl('.wb-rail [aria-label="Shapes"]', 'Shapes rail button');
    await sleep(260);
    const flyout = await cdp.eval(`(() => {
      const panel = document.querySelector('.wb-flyout-shapes');
      if (!panel) return null;
      const r = panel.getBoundingClientRect();
      const rail = document.querySelector('.wb-rail').getBoundingClientRect();
      return {
        groups: [...panel.querySelectorAll('.wb-shape-group-label')].map((n) => n.textContent),
        buttons: panel.querySelectorAll('button').length,
        perGroup: [...panel.querySelectorAll('.wb-shape-grid')].map((g) => g.querySelectorAll('button').length),
        visible: r.width > 0 && r.height > 0 && r.left >= rail.right - 1 && r.right <= window.innerWidth,
        // A 34-glyph panel must never run off the window: it is CAPPED and scrolls inside
        // itself, which is what keeps it usable in the ~820px pop-out board window.
        contained: r.top >= 0 && r.bottom <= window.innerHeight,
        scrolls: getComputedStyle(panel).overflowY === 'auto',
        clipped: getComputedStyle(document.querySelector('.wb-rail')).overflowX === 'hidden',
        labels: [...panel.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
      };
    })()`);
    await cdp.shot('02-shapes-flyout');
    report(Boolean(flyout) && flyout.visible, 'the shapes flyout opens to the right of the rail and is on screen', JSON.stringify(flyout && { visible: flyout.visible, groups: flyout.groups }));
    report(!flyout.clipped, 'the rail does not clip its own right-opening flyout', `railOverflowX=${flyout.clipped ? 'hidden' : 'visible'}`);
    report(flyout.contained && flyout.scrolls, 'the 34-glyph panel is capped inside the window and scrolls itself', `contained=${flyout.contained} overflowY=${flyout.scrolls ? 'auto' : 'visible'}`);
    report(flyout.groups.length === SHAPE_GROUPS.length, `the panel is sectioned into ${SHAPE_GROUPS.length} groups`, flyout.groups.join(' / '));
    report(flyout.buttons === SHAPE_DEFS.length, `every one of the ${SHAPE_DEFS.length} catalog shapes is reachable`, `buttons=${flyout.buttons} perGroup=${flyout.perGroup.join('+')}`);
    for (const key of ['Cloud', 'Cylinder', 'Split rectangle', 'Flag', 'D-shape', 'Arrow left', 'Arrow both ways', 'Terminator', 'Document']) {
      if (!flyout.labels.includes(key)) report(false, `the flyout offers ${key}`);
    }
    report(['Cloud', 'Cylinder', 'Split rectangle', 'Flag', 'D-shape', 'Arrow left', 'Arrow both ways', 'Terminator', 'Document'].every((k) => flyout.labels.includes(k)),
      'the new Miro basic and flowchart glyphs are all in the flyout');

    // Draw one of the NEW shapes at a drag size, the way a user does.
    await clickEl('.wb-flyout-shapes [aria-label="Cloud"]', 'Cloud shape');
    await sleep(200);
    const before = await cdp.eval("window.__harborBoardApi.getSceneElements().length");
    await focusOn(0, 0, sheetW, sheetH, 0.6);
    const drawFrom = { x: 900, y: 620 };
    await cdp.drag(drawFrom.x, drawFrom.y, drawFrom.x + 190, drawFrom.y + 130, 6);
    await sleep(350);
    const madeCloud = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const el = els.filter((e) => e.customData && e.customData.polyShape === 'cloud').at(-1);
      if (!el) return null;
      const xs = el.points.map((p) => p[0]);
      const ys = el.points.map((p) => p[1]);
      return { id: el.id, type: el.type, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), pts: el.points.length, count: els.length };
    })()`);
    report(madeCloud && madeCloud.count === before + 1, 'drawing from the flyout adds exactly one element', `count=${madeCloud && madeCloud.count} was=${before}`);
    report(madeCloud && Math.abs(madeCloud.w - 190 / 0.6) < 8 && Math.abs(madeCloud.h - 130 / 0.6) < 8,
      'the drawn cloud is the size of the drag, at the live zoom', madeCloud && `${madeCloud.w.toFixed(0)}x${madeCloud.h.toFixed(0)} scene px`);
    await cdp.shot('03-cloud-drawn');

    // ================================================================================
    // Spec 2: connectable text (finding 38)
    // ================================================================================
    await focusOn(TXT.x - 40, TXT.y - 60, 760, 240, 1);
    const textBox = await clientBox('free-text');
    const textDots = await hoverDots(cdp, textBox.cx, textBox.cy, 'text');
    await cdp.shot('04-text-connect-dots');
    report(Object.keys(textDots).length === 4, 'hovering a standalone TEXT shows its four connect dots', Object.keys(textDots).join(','));
    const gapRight = textDots.right.x - textBox.right;
    const gapTop = textBox.top - textDots.top.y;
    report(Math.abs(gapRight - 19) <= 2 && Math.abs(gapTop - 19) <= 2,
      'the text dots float the same 19px outside its box as a shape\'s', `right=${gapRight.toFixed(1)} top=${gapTop.toFixed(1)}`);

    // Drag from the text's right dot into the target rectangle: a real Miro-style connect.
    const tgtBox = await clientBox('target-rect');
    await cdp.mouse('mouseMoved', textDots.right.x, textDots.right.y, 0);
    await sleep(90);
    await cdp.mouse('mousePressed', textDots.right.x, textDots.right.y, 1);
    for (let i = 1; i <= 8; i += 1) {
      await cdp.mouse('mouseMoved', textDots.right.x + ((tgtBox.cx - textDots.right.x) * i) / 8, textDots.right.y + ((tgtBox.cy - textDots.right.y) * i) / 8, 1);
      await sleep(25);
    }
    await cdp.mouse('mouseReleased', tgtBox.cx, tgtBox.cy, 0);
    await sleep(400);
    const fromText = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const arrow = els.filter((e) => e.type === 'arrow' && e.startBinding && e.startBinding.elementId === 'free-text').at(-1);
      if (!arrow) return null;
      const text = els.find((e) => e.id === 'free-text');
      return {
        id: arrow.id,
        start: arrow.startBinding,
        end: arrow.endBinding,
        mirrored: (text.boundElements || []).some((b) => b.type === 'arrow' && b.id === arrow.id),
      };
    })()`);
    await cdp.shot('05-connector-from-text');
    report(Boolean(fromText), 'a connector can be dragged FROM a text element');
    report(fromText && fromText.end && fromText.end.elementId === 'target-rect', 'and it binds to the shape it was dropped on', JSON.stringify(fromText && fromText.end));
    report(fromText && fromText.mirrored, 'the text carries the mirrored boundElements entry, so the line follows it');

    // Move the text and the bound end must travel with it (the point of binding at all).
    const arrowBefore = await readEl(fromText.id);
    await cdp.drag(textBox.cx, textBox.cy, textBox.cx, textBox.cy + 120, 6);
    await sleep(420);
    const arrowAfter = await readEl(fromText.id);
    report(Math.abs(arrowAfter.y - arrowBefore.y) > 40, 'moving the text drags its bound connector end with it',
      `dy=${(arrowAfter.y - arrowBefore.y).toFixed(1)}`);

    // A BOUND label is not its own connect target: hovering the labelled shape's text
    // must show the SHAPE's dots, never a second set inside them.
    await focusOn(LAB.x - 40, LAB.y - 40, 700, 220, 1);
    const labBox = await clientBox('labelled');
    const labDots = await hoverDots(cdp, labBox.cx, labBox.cy, 'labelled shape');
    const onShape = Math.abs((labDots.right.x - labBox.right) - 19) <= 2 && Math.abs((labDots.left.y) - labBox.cy) <= 3;
    report(onShape, 'hovering a shape\'s bound label still shows the SHAPE\'s dots, not the label\'s',
      `right=${(labDots.right.x - labBox.right).toFixed(1)} leftY=${labDots.left.y.toFixed(1)} shapeCy=${labBox.cy.toFixed(1)}`);

    // ================================================================================
    // Spec 3: the right-click menus (findings 62-64)
    // ================================================================================
    await focusOn(LAB.x - 40, LAB.y - 40, 700, 220, 1);
    const labBox2 = await clientBox('labelled');
    await cdp.rightClick(labBox2.cx, labBox2.cy);
    const elementMenu = await ctxRows();
    await cdp.shot('06-context-element');
    report(Boolean(elementMenu), 'right-clicking an element opens Harbor\'s own menu');
    report(elementMenu && elementMenu.kind === 'element', 'it is the ELEMENT list', elementMenu && elementMenu.kind);
    report(elementMenu && !elementMenu.excalidrawMenu, 'and Excalidraw\'s own context menu is suppressed');
    report(elementMenu && elementMenu.onScreen, 'the menu is fully on screen', elementMenu && JSON.stringify(elementMenu.rect));
    const elementLabels = elementMenu.rows.map((r) => r.label);
    report(JSON.stringify(elementLabels) === JSON.stringify(['Copy as image', 'Duplicate', 'Delete', 'Copy style', 'Paste style', 'Clear content', 'Arrange', 'Lock']),
      'the element rows are the catalog list Harbor can honestly execute, in order', elementLabels.join(' / '));
    report(elementMenu.seps >= 2, 'grouped by separators like Miro\'s', `seps=${elementMenu.seps}`);
    report(await selectedIds() === 'labelled', 'right-clicking an unselected element selects it first', await selectedIds());
    report(elementMenu.rows.find((r) => r.label === 'Paste style').disabled === true, 'Paste style is disabled until a style is copied');

    // Escape closes it, and the next canvas click is NOT eaten (the Wave C lesson).
    await cdp.key('Escape');
    await sleep(220);
    report(await cdp.eval("Boolean(document.querySelector('.wb-ctx-menu'))") === false, 'Escape closes the menu');

    // Clear content really empties the shape.
    await cdp.rightClick(labBox2.cx, labBox2.cy);
    await sleep(200);
    await clickCtxRow('Clear content');
    const clearedLabel = await readEl('lab-1');
    const clearedHost = await readEl('labelled');
    const labelId = (await cdp.eval("(window.__harborBoardApi.getSceneElementsIncludingDeleted().find((e) => e.id === 'labelled').boundElements || []).length"));
    report(clearedHost && labelId === 0, 'Clear content drops the container\'s mirror entry', `boundElements=${labelId}`);
    const anyLiveLabel = await cdp.eval("window.__harborBoardApi.getSceneElements().some((e) => e.type === 'text' && e.containerId === 'labelled')");
    report(anyLiveLabel === false, 'and the label is really gone from the board', `clearedLabel=${clearedLabel ? clearedLabel.isDeleted : 'absent'}`);
    await cdp.shot('07-cleared-content');

    // Duplicate places the copy BESIDE the original (finding 59).
    const beforeDup = await readEl('labelled');
    await cdp.rightClick(labBox2.cx, labBox2.cy);
    await sleep(200);
    await clickCtxRow('Duplicate');
    const dup = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const sel = Object.keys(window.__harborBoardApi.getAppState().selectedElementIds || {});
      const copy = els.find((e) => sel.includes(e.id) && e.id !== 'labelled');
      return copy ? { id: copy.id, x: copy.x, y: copy.y, w: copy.width, selCount: sel.length } : null;
    })()`);
    report(Boolean(dup), 'Duplicate creates a copy and selects it');
    report(dup && Math.abs(dup.x - (beforeDup.x + beforeDup.w + 40)) < 1 && dup.y === beforeDup.y,
      'the copy lands beside the original, same y, 40px gap', dup && `x=${dup.x} (want ${beforeDup.x + beforeDup.w + 40}) y=${dup.y}`);
    await cdp.shot('08-duplicated');

    // Arrange is a real submenu that really reorders.
    await cdp.rightClick(labBox2.cx, labBox2.cy);
    await sleep(200);
    await clickEl('.wb-ctx-menu [aria-label="Arrange"]', 'Arrange');
    await sleep(240);
    const sub = await cdp.eval(`(() => {
      const s = document.querySelector('.wb-ctx-sub');
      if (!s) return null;
      return { rows: [...s.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) };
    })()`);
    report(sub && JSON.stringify(sub.rows) === JSON.stringify(['Bring forward', 'Bring to front', 'Send backward', 'Send to back']),
      'the Arrange submenu is Miro\'s z-order list, in Miro\'s order', sub && sub.rows.join(' / '));
    const indexBefore = await cdp.eval("window.__harborBoardApi.getSceneElements().findIndex((e) => e.id === 'labelled')");
    await clickEl('.wb-ctx-sub [aria-label="Send to back"]', 'Send to back');
    await sleep(320);
    const indexAfter = await cdp.eval("window.__harborBoardApi.getSceneElements().findIndex((e) => e.id === 'labelled')");
    report(indexAfter === 0 && indexBefore !== 0, 'Send to back really moves it to the bottom of the stack', `${indexBefore} -> ${indexAfter}`);
    await cdp.shot('09-arrange-submenu');

    // The CANVAS menu is a different list. The bare point is found the way a user finds
    // one, and RE-found each time, because every spec here adds something to the board.
    const findEmpty = () => cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const z = app.zoom.value;
      const els = api.getSceneElements().filter((e) => !e.isDeleted);
      const rail = document.querySelector('.wb-rail').getBoundingClientRect();
      const covers = (cx, cy) => els.some((e) => {
        const left = (e.x + app.scrollX) * z + (app.offsetLeft || 0);
        const top = (e.y + app.scrollY) * z + (app.offsetTop || 0);
        return cx >= left - 40 && cx <= left + e.width * z + 40 && cy >= top - 40 && cy <= top + e.height * z + 40;
      });
      for (let y = 140; y < window.innerHeight - 200; y += 40) {
        for (let x = rail.right + 70; x < window.innerWidth - 320; x += 60) {
          if (covers(x, y)) continue;
          const el = document.elementFromPoint(x, y);
          if (el && el.tagName === 'CANVAS') return { x, y };
        }
      }
      return null;
    })()`);
    const bareCanvasPoint = async (label) => {
      const point = await findEmpty();
      if (!point) throw new Error(`found no bare canvas point for ${label}`);
      return point;
    };
    const emptyPoint = await bareCanvasPoint('the canvas menu');
    await cdp.rightClick(emptyPoint.x, emptyPoint.y);
    const canvasMenu = await ctxRows();
    await cdp.shot('10-context-canvas');
    report(canvasMenu && canvasMenu.kind === 'canvas', 'right-clicking bare board opens the CANVAS list', canvasMenu && canvasMenu.kind);
    report(canvasMenu && JSON.stringify(canvasMenu.rows.map((r) => r.label))
      === JSON.stringify(['Add sticky note', 'Add text', 'Select all', 'Unlock all', 'Paste style', 'Show all', 'Mouse or trackpad']),
      'the canvas rows are Miro\'s canvas list, minus what a board has no notion of', canvasMenu && canvasMenu.rows.map((r) => r.label).join(' / '));
    report(canvasMenu.rows.find((r) => r.label === 'Unlock all').disabled === true, 'Unlock all is disabled while nothing is locked');

    // Add sticky note places one AT the click, not at the viewport centre.
    const stickiesBefore = await cdp.eval("window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.sticky).length");
    await clickCtxRow('Add sticky note');
    await sleep(400);
    const placed = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const z = app.zoom.value;
      const els = api.getSceneElements().filter((e) => e.customData && e.customData.sticky);
      const el = els.at(-1);
      if (!el) return null;
      return {
        count: els.length,
        cx: (el.x + el.width / 2 + app.scrollX) * z + (app.offsetLeft || 0),
        cy: (el.y + el.height / 2 + app.scrollY) * z + (app.offsetTop || 0),
        bands: api.getSceneElements().filter((e) => e.customData && e.customData.faceId === el.id).length,
      };
    })()`);
    report(placed && placed.count === stickiesBefore + 1, 'Add sticky note drops exactly one sticky');
    report(placed && Math.hypot(placed.cx - emptyPoint.x, placed.cy - emptyPoint.y) <= 3,
      'and it lands centred on the point that was right-clicked', placed && `off=${Math.hypot(placed.cx - emptyPoint.x, placed.cy - emptyPoint.y).toFixed(1)}px`);
    report(placed && placed.bands === STICKY_SHADOW_BANDS.length, 'with its two shadow bands', placed && `bands=${placed.bands}`);
    await cdp.shot('11-sticky-from-canvas-menu');

    // Add text places a real text element at the click too, not a tool the user then has
    // to aim: a row that says "Add" must add.
    const textPoint = await bareCanvasPoint('Add text');
    const textsBefore = await cdp.eval("window.__harborBoardApi.getSceneElements().filter((e) => e.type === 'text' && !e.containerId).length");
    await cdp.rightClick(textPoint.x, textPoint.y);
    await sleep(200);
    await clickCtxRow('Add text');
    await sleep(500);
    await cdp.key('Escape');
    await sleep(200);
    const addedText = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const z = app.zoom.value;
      const texts = api.getSceneElements().filter((e) => e.type === 'text' && !e.containerId);
      const el = texts.at(-1);
      if (!el) return null;
      return { count: texts.length, left: (el.x + app.scrollX) * z + (app.offsetLeft || 0), top: (el.y + app.scrollY) * z + (app.offsetTop || 0), text: el.text };
    })()`);
    report(addedText && addedText.count === textsBefore + 1, 'Add text adds exactly one text element', addedText && `count=${addedText.count}`);
    report(addedText && Math.hypot(addedText.left - textPoint.x, addedText.top - textPoint.y) <= 4,
      'and it lands at the point that was right-clicked', addedText && `off=${Math.hypot(addedText.left - textPoint.x, addedText.top - textPoint.y).toFixed(1)}px`);

    // Select all really selects the actionable board, and nothing decorative.
    const selectAllPoint = await bareCanvasPoint('Select all');
    await cdp.rightClick(selectAllPoint.x, selectAllPoint.y);
    await sleep(200);
    await clickCtxRow('Select all');
    const selectedAll = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const ids = new Set(Object.keys(api.getAppState().selectedElementIds || {}));
      const els = api.getSceneElements();
      return {
        count: ids.size,
        shadows: els.filter((e) => ids.has(e.id) && e.customData && e.customData.stickyShadow).length,
        labels: els.filter((e) => ids.has(e.id) && e.containerId).length,
        actionable: els.filter((e) => !e.locked && !(e.customData && e.customData.stickyShadow) && !e.containerId).length,
      };
    })()`);
    report(selectedAll.count === selectedAll.actionable && selectedAll.count > 10,
      'Select all takes the whole actionable board', JSON.stringify(selectedAll));
    report(selectedAll.shadows === 0 && selectedAll.labels === 0,
      'and never a shadow band or a bound label', `shadows=${selectedAll.shadows} labels=${selectedAll.labels}`);
    await cdp.key('Escape');
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })");
    await sleep(200);

    // The shortcuts the menu ADVERTISES must do exactly what the rows do, exactly once:
    // Excalidraw binds Ctrl+D itself, so a hint that says Ctrl+D and a handler that lets
    // Excalidraw's own duplicate run too would silently make two copies.
    await cdp.key('Escape');
    await sleep(200);
    await select('labelled');
    const countBeforeKey = await cdp.eval("window.__harborBoardApi.getSceneElements().length");
    await cdp.key('d', { ctrl: true });
    await sleep(420);
    const countAfterKey = await cdp.eval("window.__harborBoardApi.getSceneElements().length");
    report(countAfterKey === countBeforeKey + 1, 'Ctrl+D duplicates exactly ONCE (Excalidraw\'s own duplicate never also runs)',
      `${countBeforeKey} -> ${countAfterKey}`);
    const keyCopy = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const sel = Object.keys(api.getAppState().selectedElementIds || {});
      const copy = api.getSceneElements().find((e) => sel.includes(e.id) && e.id !== 'labelled');
      const src = api.getSceneElements().find((e) => e.id === 'labelled');
      return copy && src ? { dx: copy.x - src.x, dy: copy.y - src.y, srcW: src.width } : null;
    })()`);
    report(keyCopy && Math.abs(keyCopy.dx - (keyCopy.srcW + 40)) < 1 && keyCopy.dy === 0,
      'and it uses Miro\'s beside placement, not Excalidraw\'s +10/+10', keyCopy && JSON.stringify(keyCopy));
    // Ctrl+Shift+L is the same toggle the row is, on the same selection.
    await select('labelled');
    await cdp.key('l', { ctrl: true, shift: true });
    await sleep(320);
    report((await readEl('labelled')).locked === true, 'Ctrl+Shift+L locks the selection');
    await clickEl('.wb-rail [aria-label="Select  V"]', 'Select tool');
    const relocked = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      return els.filter((e) => e.locked && !(e.customData && e.customData.stickyShadow)).length;
    })()`);
    report(relocked >= 1, 'and the lock is real board state, not a toolbar flag', `locked=${relocked}`);
    // Put the board back so the later Lock spec starts from a clean slate.
    await cdp.eval("window.__harborBoardApi.updateScene({ elements: window.__harborBoardApi.getSceneElements().map((e) => (e.customData && e.customData.stickyShadow ? e : { ...e, locked: false })) })");
    await sleep(250);

    // The CONNECTOR menu drops Clear content (finding 64).
    await cdp.key('Escape');
    await focusOn(LINK_A.x - 60, LINK_A.y - 60, 700, 220, 1);
    const linkBox = await clientBox('link');
    await cdp.rightClick(linkBox.cx, linkBox.cy);
    const connMenu = await ctxRows();
    await cdp.shot('12-context-connector');
    report(connMenu && connMenu.kind === 'connector', 'right-clicking a connector opens the CONNECTOR list', connMenu && connMenu.kind);
    report(connMenu && JSON.stringify(connMenu.rows.map((r) => r.label))
      === JSON.stringify(['Copy as image', 'Duplicate', 'Delete', 'Copy style', 'Paste style', 'Arrange', 'Lock']),
      'the connector list drops Clear content, exactly as Miro\'s does', connMenu && connMenu.rows.map((r) => r.label).join(' / '));
    await cdp.key('Escape');

    // ================================================================================
    // Spec 4: Lock, Unlock all, and Copy as image (findings 56, 61)
    // ================================================================================
    await focusOn(LINK_A.x - 60, LINK_A.y - 60, 700, 220, 1);
    const aBox = await select('link-a');
    await cdp.rightClick(aBox.cx, aBox.cy);
    await sleep(200);
    await clickCtxRow('Lock');
    const lockedA = await readEl('link-a');
    report(lockedA.locked === true, 'Lock writes locked:true on the element', `locked=${lockedA.locked}`);
    report(await selectedIds() === '', 'and clears the selection, so no toolbar points at something unclickable');
    await cdp.click(aBox.cx, aBox.cy);
    await sleep(280);
    report(await selectedIds() === '', 'a locked shape cannot be selected by clicking it', `selection="${await selectedIds()}"`);
    const lockedDots = await cdp.eval(`(async () => {
      const el = document.elementFromPoint(${Math.round(aBox.cx)}, ${Math.round(aBox.cy)});
      return document.querySelectorAll('button.wb-connect-dot').length;
    })()`);
    report(lockedDots === 0, 'and offers no connect dots', `dots=${lockedDots}`);
    await cdp.shot('13-locked');

    const unlockPoint = await bareCanvasPoint('Unlock all');
    await cdp.rightClick(unlockPoint.x, unlockPoint.y);
    const lockedCanvas = await ctxRows();
    report(lockedCanvas.rows.find((r) => r.label === 'Unlock all').disabled === false, 'now Unlock all is enabled');
    await clickCtxRow('Unlock all');
    const unlockedA = await readEl('link-a');
    report(unlockedA.locked === false, 'Unlock all frees it again', `locked=${unlockedA.locked}`);
    const bandsStillLocked = await cdp.eval("window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.stickyShadow).every((e) => e.locked === true)");
    report(bandsStillLocked, 'while every sticky shadow band STAYS locked (it is decoration, not the user\'s to free)');

    // The More menu carries the two deferred rows, and Copy as image really writes.
    const bBox = await select('link-b');
    await clickEl('.wb-float-bar [aria-label="More"]', 'More');
    await sleep(240);
    const moreRows = await cdp.eval(`(() => {
      const menu = document.querySelector('.wb-tb-menu');
      if (!menu) return null;
      return [...menu.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    })()`);
    await cdp.shot('14-more-menu');
    report(moreRows && moreRows.includes('Copy as image') && moreRows.includes('Lock'),
      'the More menu now carries Copy as image and Lock', moreRows && moreRows.join(' / '));
    await clickEl('.wb-tb-menu [aria-label="Copy as image"]', 'Copy as image');
    await sleep(900);
    const copyStatus = await cdp.eval("(document.querySelector('.wb-status') || {}).textContent || ''");
    report(copyStatus === 'Copied PNG', 'Copy as image really puts a PNG on the clipboard', `status="${copyStatus}"`);
    report(Boolean(bBox), 'a selection was in place for the export');

    // ================================================================================
    // Spec 5: frame presets (finding 40)
    // ================================================================================
    await cdp.key('Escape');
    await clickEl('.wb-rail [aria-label="Frame"]', 'Frame rail button');
    await sleep(240);
    const frameFlyout = await cdp.eval(`(() => {
      const panel = document.querySelector('.wb-rail-flyout[aria-label="Frame presets"]');
      if (!panel) return null;
      const r = panel.getBoundingClientRect();
      return { rows: [...panel.querySelectorAll('button')].map((b) => b.textContent), visible: r.width > 0 && r.right <= window.innerWidth };
    })()`);
    await cdp.shot('15-frame-flyout');
    report(frameFlyout && frameFlyout.visible && frameFlyout.rows.length === FRAME_PRESETS.length,
      `the Frame flyout offers all ${FRAME_PRESETS.length} Miro presets`, frameFlyout && frameFlyout.rows.join(' / '));
    const framesBefore = await cdp.eval("window.__harborBoardApi.getSceneElements().filter((e) => e.type === 'frame').length");
    await clickEl('.wb-rail-flyout [aria-label="A4 frame"]', 'A4 frame');
    await sleep(700);
    const frame = await cdp.eval(`(() => {
      const el = window.__harborBoardApi.getSceneElements().filter((e) => e.type === 'frame').at(-1);
      return el ? { type: el.type, w: el.width, h: el.height, name: el.name, count: window.__harborBoardApi.getSceneElements().filter((e) => e.type === 'frame').length } : null;
    })()`);
    await cdp.shot('16-a4-frame');
    report(Boolean(frame) && frame.count === framesBefore + 1, 'picking A4 drops exactly one real frame element');
    report(frame && frame.w === 794 && frame.h === 1123, 'at A4\'s pixel size', frame && `${frame.w}x${frame.h}`);
    report(frame && frame.name === 'A4', 'named after the preset', frame && frame.name);

    // ================================================================================
    // Spec 6: the CLI sticky's shadow is the app's shadow (the Wave D follow-up)
    // ================================================================================
    await focusOn(CLI_STICKY.x - 60, CLI_STICKY.y - 60, 320, 260, 1.4);
    await cdp.shot('17-cli-sticky');
    // The CLI factory mints the face id FIRST (its bands and label reference it), so the
    // seam names it cli-1 whatever the band count is.
    const cliSticky = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const face = els.find((e) => e.id === 'cli-1');
      const bands = els.filter((e) => e.customData && e.customData.stickyShadow && e.customData.faceId === face.id);
      return {
        faceId: face.id,
        bands: bands.map((b) => ({ dx: Math.round(b.x - face.x), dy: Math.round(b.y - face.y), opacity: b.opacity, locked: b.locked, w: b.width, h: b.height })),
        faceW: face.width, faceH: face.height,
        label: (els.find((e) => e.containerId === face.id) || {}).text || null,
      };
    })()`);
    const wantBands = STICKY_SHADOW_BANDS.map((b) => ({ dx: b.dx, dy: b.dy, opacity: b.opacity }));
    const gotBands = cliSticky.bands.map((b) => ({ dx: b.dx, dy: b.dy, opacity: b.opacity }));
    report(JSON.stringify(gotBands) === JSON.stringify(wantBands),
      'a CLI-authored sticky renders with the app\'s TWO bottom shadow bands, not the old single +5/+7 square',
      `got=${JSON.stringify(gotBands)} want=${JSON.stringify(wantBands)}`);
    report(cliSticky.bands.every((b) => b.locked && b.w === cliSticky.faceW && b.h === cliSticky.faceH),
      'each band is locked and exactly the size of the face', JSON.stringify(cliSticky.bands.map((b) => [b.locked, b.w, b.h])));
    report(cliSticky.label === 'CLI sticky', 'and its label survived the round trip', String(cliSticky.label));

    // The app's own glue pass agrees: moving the face carries both bands, at their own
    // offsets, which is what proves the CLI and the app now speak one contract.
    const cliBox = await clientBox(cliSticky.faceId);
    await cdp.drag(cliBox.cx, cliBox.cy, cliBox.cx + 120, cliBox.cy + 60, 6);
    await sleep(500);
    const movedBands = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const face = els.find((e) => e.id === '${cliSticky.faceId}');
      return els.filter((e) => e.customData && e.customData.faceId === face.id)
        .map((b) => ({ dx: Math.round(b.x - face.x), dy: Math.round(b.y - face.y) }));
    })()`);
    report(JSON.stringify(movedBands.map((b) => ({ dx: b.dx, dy: b.dy })))
      === JSON.stringify(STICKY_SHADOW_BANDS.map((b) => ({ dx: b.dx, dy: b.dy }))),
      'and dragging it keeps every band glued at its OWN offsets', JSON.stringify(movedBands));
    await cdp.shot('18-cli-sticky-moved');

    // ================================================================================
    // Hygiene
    // ================================================================================
    const http = cdp.requests.filter((url) => /^https?:/i.test(url));
    report(http.length === 0, 'no request ever left the app', http.slice(0, 3).join(', ') || `total=${cdp.requests.length}`);
    report(cdp.errors.length === 0, 'zero console errors or exceptions', cdp.errors.slice(0, 3).join(' | ') || 'clean');
    report(failures.length === 0, 'drive-wave-d-win');
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
