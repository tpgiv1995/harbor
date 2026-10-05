'use strict';
// Live proof of the Miro-cloned connector mechanics (catalog: miro-parity-2026-08-30):
// real mouse events drag from a shape's connect dot; the two-tier targeting reveals
// rings within ~25px of the EDGE, glows the whole body with the arrowhead parked at
// the crossed edge, and snaps exactly on a dot; release binds dot-to-dot on side
// midpoints, PINS a body drop at the drop point (entry edge migrating on a later
// shape move), or leaves a DANGLING free end on empty canvas. Plus: endpoint
// re-drag re-snap, bezier default, bend-subdivide, elbow segment drag, fraction
// labels surviving an elbow conversion, and the per-end arrowhead/swap/width
// toolbar. Offscreen, isolated profile, real Excalidraw.
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
// The same pure decisions the canvas executes; the drive computes EXPECTED label
// positions and clearances through them rather than re-deriving the math.
const boardFiles = require('../src/renderer/whiteboard/board-files.cjs');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9342;
const OUT = path.join(os.tmpdir(), 'harbor-drive-connector-snap');
const BOARD_ID = 'snap-drive-board';

const SRC = { id: 'src-rect', x: 60, y: 120, w: 160, h: 100 };
const DST = { id: 'dst-rect', x: 520, y: 300, w: 160, h: 100 };

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
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        // Keep the second argument too: Excalidraw's invariants pass their stack there.
        this.errors.push((msg.params.args || []).slice(0, 2).map((a) => String(a?.value ?? a?.description ?? '')).join(' :: ') || 'console.error');
      }
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
    // A per-screenshot error checkpoint localizes WHICH gesture raised a console
    // error, so a failure names its spec instead of costing a bisect.
    console.log(`  [errors after ${name}: ${this.errors.length}]`);
  }

  async mouse(type, x, y, buttons) {
    // A hover move must carry button 'none' or Chromium drops the pointermove
    // (live-caught: buttons 0 with button 'left' raised no hover dots).
    const button = type === 'mouseMoved' && !buttons ? 'none' : 'left';
    await this.send('Input.dispatchMouseEvent', {
      type, x: Math.round(x), y: Math.round(y), button, buttons, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0,
    });
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.eval(expression)) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// Client-coordinate positions of the four connect dots currently on screen.
const DOTS_EXPR = `[...document.querySelectorAll('button.wb-connect-dot')].map((b) => ({
  side: (b.getAttribute('aria-label') || '').replace('Connect from ', ''),
  x: parseFloat(b.style.left), y: parseFloat(b.style.top),
}))`;

async function hoverDots(cdp, cx, cy, label) {
  const deadline = Date.now() + 8000;
  for (;;) {
    await cdp.mouse('mouseMoved', cx, cy, 0);
    await sleep(120);
    await cdp.mouse('mouseMoved', cx + 2, cy + 1, 0);
    await sleep(180);
    const n = await cdp.eval("document.querySelectorAll('button.wb-connect-dot').length");
    if (n === 4) break;
    if (Date.now() > deadline) {
      const diag = await cdp.eval(`(() => {
        const el = document.elementFromPoint(${Math.round(cx)}, ${Math.round(cy)});
        const app = window.__harborBoardApi?.getAppState() || {};
        return JSON.stringify({
          dots: document.querySelectorAll('button.wb-connect-dot').length,
          under: el ? el.tagName + '.' + el.className : null,
          viewport: [window.innerWidth, window.innerHeight],
          point: [${Math.round(cx)}, ${Math.round(cy)}],
          zoom: app.zoom?.value, scroll: [app.scrollX, app.scrollY], offset: [app.offsetLeft, app.offsetTop],
        });
      })()`);
      await cdp.shot(`fail-${label.replace(/\\s+/g, '-')}`);
      throw new Error(`timeout waiting for ${label} dots; diag=${diag}`);
    }
  }
  const dots = await cdp.eval(DOTS_EXPR);
  return Object.fromEntries(dots.map((d) => [d.side, d]));
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-connector-snap-'));
  const userData = path.join(tmp, 'userData');
  const boardsDir = path.join(tmp, 'boards');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });

  const rect = ({ id, x, y, w, h }) => ({
    id, type: 'rectangle', x, y, width: w, height: h, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: '#d0ebff', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, index: null, roundness: null, seed: 1,
    version: 1, versionNonce: 1, isDeleted: false, boundElements: [],
    updated: 1, link: null, locked: false,
  });
  fs.writeFileSync(path.join(boardsDir, `${BOARD_ID}.json`), JSON.stringify({
    type: 'excalidraw', version: 2, source: 'local', name: 'Snap drive',
    updatedAt: new Date().toISOString(),
    elements: [rect(SRC), rect(DST)], appState: {}, files: {},
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

  // The window must NEVER show on Pat's screen (hard rule: nothing restacks over
  // anything on this box). The occlusion/throttling switches keep an offscreen
  // window deterministic: without them Chromium starves rAF and throttles timers
  // for occluded windows, which is exactly the "events do not land" flakiness the
  // sibling drives caught. The APP does not need them; the drive does.
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

  // The window is BORN offscreen (createWindow spawns HARBOR_E2E windows at
  // x=-4200), so it never paints on the user's screen at all. This mover is
  // insurance on top: one PowerShell loops SetWindowPos every 250ms so a
  // recreate, restore, or anything else that could bring the window back is
  // shoved off again within a beat; it exits with the app.
  const moverScript = 'Add-Type -Name W -Namespace P -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);\'; '
    + `for ($i = 0; $i -lt 2400; $i++) { $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if (-not $p) { break }; if ($p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) | Out-Null }; Start-Sleep -Milliseconds 250 }`;
  const mover = spawn('powershell', ['-NoProfile', '-Command', moverScript], { stdio: 'ignore', detached: false });

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
    await waitFor(cdp, 'window.__harborBoardApi.getSceneElements().length === 2', 'seeded shapes');

    // The page's own transform (zoom 1, scroll 0 for this board, but never assumed).
    const xform = await cdp.eval(`(() => {
      const app = window.__harborBoardApi.getAppState();
      return { zoom: app.zoom?.value || 1, scrollX: app.scrollX || 0, scrollY: app.scrollY || 0, ox: app.offsetLeft || 0, oy: app.offsetTop || 0 };
    })()`);
    const toClient = (sx, sy) => ({ x: (sx + xform.scrollX) * xform.zoom + xform.ox, y: (sy + xform.scrollY) * xform.zoom + xform.oy });
    const centers = {
      src: toClient(SRC.x + SRC.w / 2, SRC.y + SRC.h / 2),
      dst: toClient(DST.x + DST.w / 2, DST.y + DST.h / 2),
    };
    const steps = 6;
    const dragTo = async (fromX, fromY, toX, toY, stepCount = steps) => {
      for (let i = 1; i <= stepCount; i += 1) {
        await cdp.mouse('mouseMoved', fromX + ((toX - fromX) * i) / stepCount, fromY + ((toY - fromY) * i) / stepCount, 1);
        await sleep(40);
      }
    };
    // Reset the board to its two seeded shapes at their original spots: no arrows,
    // no labels, no bindings, nothing selected.
    const resetScene = async () => {
      await cdp.eval(`(() => {
        const api = window.__harborBoardApi;
        const els = api.getSceneElements()
          .filter((e) => e.type !== 'arrow' && e.type !== 'text')
          .map((e) => ({ ...e, x: e.id === '${SRC.id}' ? ${SRC.x} : ${DST.x}, y: e.id === '${SRC.id}' ? ${SRC.y} : ${DST.y}, boundElements: [] }));
        api.updateScene({ elements: els, appState: { selectedElementIds: {} } });
      })()`);
      await sleep(250);
    };
    const readArrow = () => cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const arrow = els.find((e) => e.type === 'arrow' && !e.isDeleted);
      if (!arrow) return null;
      const last = arrow.points[arrow.points.length - 1];
      return {
        id: arrow.id, x: arrow.x, y: arrow.y, points: arrow.points,
        ex: arrow.x + last[0], ey: arrow.y + last[1],
        start: arrow.startBinding || null, end: arrow.endBinding || null,
        roundness: arrow.roundness || null, elbow: arrow.customData?.elbow || null,
        startHead: arrow.startArrowhead ?? null, endHead: arrow.endArrowhead ?? null,
        strokeWidth: arrow.strokeWidth,
      };
    })()`);

    // ---- Spec 1: dot visual ground truth (findings 2, 3) --------------------
    const dstDots = await hoverDots(cdp, centers.dst.x, centers.dst.y, 'target');
    const edgeGap = Math.round(dstDots.right.x - toClient(DST.x + DST.w, DST.y + DST.h / 2).x);
    report(Math.abs(edgeGap - 19) <= 2, 'connect dots float ~19px outside the side midpoints', `gap=${edgeGap}px`);
    await cdp.mouse('mouseMoved', dstDots.right.x, dstDots.right.y, 0);
    await sleep(250);
    const hoverState = await cdp.eval(`(() => {
      const hovered = document.querySelector('.wb-connect-dot.hovered, .wb-connect-dot:hover');
      const rect = hovered ? hovered.getBoundingClientRect() : null;
      const arrowGlyph = hovered ? getComputedStyle(hovered.querySelector('svg')).opacity : null;
      const guide = document.querySelector('.wb-dot-guide');
      const guideRect = guide ? guide.getBoundingClientRect() : null;
      const bg = hovered ? getComputedStyle(hovered).backgroundColor : null;
      return { size: rect ? Math.round(rect.width) : 0, arrowGlyph, guide: Boolean(guide), guideLen: guideRect ? Math.round(Math.max(guideRect.width, guideRect.height)) : 0, bg };
    })()`);
    await cdp.shot('01-hover-dot');
    report(hoverState.size >= 18 && hoverState.size <= 22, 'hovering a dot grows it to a ~20px disc', `size=${hoverState.size}`);
    report(hoverState.arrowGlyph === '1', 'the hovered dot shows its white directional arrow', `opacity=${hoverState.arrowGlyph}`);
    report(hoverState.guide && hoverState.guideLen > 200, 'a long thin gray guide line extends outward from the hovered dot', `len=${hoverState.guideLen}`);
    report(hoverState.bg === 'rgb(56, 89, 255)', 'dots are solid #3859ff', hoverState.bg);

    // ---- Spec 2: two-tier targeting during a drag (findings 7, 8, 9) --------
    const srcDots = await hoverDots(cdp, centers.src.x, centers.src.y, 'source');
    await cdp.mouse('mouseMoved', srcDots.right.x, srcDots.right.y, 0);
    await sleep(80);
    await cdp.mouse('mousePressed', srcDots.right.x, srcDots.right.y, 1);
    const far = toClient(DST.x - 40, DST.y + DST.h / 2);
    await dragTo(srcDots.right.x, srcDots.right.y, far.x, far.y);
    const farState = await cdp.eval("({ rings: document.querySelectorAll('.wb-connect-ring').length, glow: Boolean(document.querySelector('.wb-target-glow')) })");
    report(farState.rings === 0 && !farState.glow, '40px from the edge shows nothing (reveal threshold)', JSON.stringify(farState));
    const nearEdge = toClient(DST.x - 22, DST.y + 18);
    await dragTo(far.x, far.y, nearEdge.x, nearEdge.y, 2);
    const edgeState = await cdp.eval(`(() => {
      const rings = [...document.querySelectorAll('.wb-connect-ring')];
      const leftMid = { x: ${toClient(DST.x, DST.y + DST.h / 2).x}, y: ${toClient(DST.x, DST.y + DST.h / 2).y} };
      const onEdge = rings.some((r) => Math.abs(parseFloat(r.style.left) - leftMid.x) < 2 && Math.abs(parseFloat(r.style.top) - leftMid.y) < 2);
      return { rings: rings.length, lit: document.querySelectorAll('.wb-connect-ring.snap').length, glow: Boolean(document.querySelector('.wb-target-glow')), onEdge };
    })()`);
    await cdp.shot('02-edge-reveal');
    report(edgeState.rings === 4 && edgeState.lit === 0 && !edgeState.glow, 'within 25px of the edge the 4 rings reveal, none lit', JSON.stringify(edgeState));
    report(edgeState.onEdge, 'target rings sit ON the edge midpoints, not outside them');
    const inBody = toClient(DST.x + 40, DST.y + 50);
    await dragTo(nearEdge.x, nearEdge.y, inBody.x, inBody.y, 3);
    const expectEntryX = toClient(DST.x, 0).x;
    const bodyState = await cdp.eval(`(() => {
      const line = document.querySelector('.wb-connect-line line');
      return {
        glow: Boolean(document.querySelector('.wb-target-glow')),
        rings: document.querySelectorAll('.wb-connect-ring').length,
        lineX2: line ? parseFloat(line.getAttribute('x2')) : null,
      };
    })()`);
    await cdp.shot('03-body-glow');
    report(bodyState.glow && bodyState.rings === 4, 'over the body the whole shape highlights with rings up', JSON.stringify(bodyState));
    report(bodyState.lineX2 != null && Math.abs(bodyState.lineX2 - expectEntryX) <= 3, 'the preview arrowhead parks at the crossed edge, not the cursor', `x2=${bodyState.lineX2} edge=${expectEntryX}`);
    const nearDot = toClient(DST.x - 11, DST.y + DST.h / 2 - 10);
    await dragTo(inBody.x, inBody.y, nearDot.x, nearDot.y, 3);
    const leftMidClient = toClient(DST.x, DST.y + DST.h / 2);
    const snapState = await cdp.eval(`(() => {
      const lit = document.querySelector('.wb-connect-ring.snap');
      const line = document.querySelector('.wb-connect-line line');
      return {
        rings: document.querySelectorAll('.wb-connect-ring').length,
        litLeft: lit ? parseFloat(lit.style.left) : null,
        litTop: lit ? parseFloat(lit.style.top) : null,
        lineX2: line ? parseFloat(line.getAttribute('x2')) : null,
        lineY2: line ? parseFloat(line.getAttribute('y2')) : null,
        stroke: line ? getComputedStyle(line).stroke : null,
        dash: line ? getComputedStyle(line).strokeDasharray : null,
        marker: line ? line.getAttribute('marker-end') : null,
      };
    })()`);
    await cdp.shot('04-dot-snap');
    report(snapState.rings === 4 && snapState.litLeft != null
      && Math.abs(snapState.litLeft - leftMidClient.x) < 2 && Math.abs(snapState.litTop - leftMidClient.y) < 2,
    'exactly near a dot: that ring lights solid', `lit=${snapState.litLeft},${snapState.litTop} expected=${leftMidClient.x},${leftMidClient.y}`);
    report(snapState.lineX2 != null && Math.abs(snapState.lineX2 - leftMidClient.x) < 2 && Math.abs(snapState.lineY2 - leftMidClient.y) < 2,
      'the preview line snaps to the dot', `end=${snapState.lineX2},${snapState.lineY2}`);
    report(snapState.stroke === 'rgb(26, 26, 26)' && snapState.dash === 'none' && Boolean(snapState.marker),
      'the drag preview is a live dark line with an arrowhead, not a dashed accent line', `stroke=${snapState.stroke} dash=${snapState.dash} marker=${snapState.marker}`);

    await cdp.mouse('mouseReleased', nearDot.x, nearDot.y, 0);
    await sleep(300);
    const arrow1 = await readArrow();
    await cdp.shot('05-arrow-created');
    report(Boolean(arrow1) && arrow1.start?.elementId === SRC.id && arrow1.end?.elementId === DST.id, 'release binds the arrow both ends', JSON.stringify({ start: arrow1?.start, end: arrow1?.end }));
    // Excalidraw re-normalizes bound endpoints by sub-pixel amounts after
    // creation (it owns live binding geometry), so the interactive assertion is
    // "on the anchor within 2px", not the CLI drive's exactness.
    report(arrow1 && Math.abs(arrow1.x - (SRC.x + SRC.w)) <= 2 && Math.abs(arrow1.y - (SRC.y + SRC.h / 2)) <= 2,
      'arrow starts at the source RIGHT side midpoint', `start=${arrow1?.x},${arrow1?.y}`);
    report(arrow1 && Math.abs(arrow1.ex - DST.x) <= 2 && Math.abs(arrow1.ey - (DST.y + DST.h / 2)) <= 2,
      'arrow ends at the target LEFT side midpoint (the snapped dot)', `end=${arrow1?.ex},${arrow1?.ey}`);
    report(arrow1 && arrow1.roundness?.type === 2 && arrow1.points.length === 2,
      'a new connector defaults to bezier (roundness 2), rendering straight between aligned anchors', JSON.stringify({ roundness: arrow1?.roundness, points: arrow1?.points.length }));

    // ---- Spec 3: body drop PINS the endpoint; the entry edge migrates -------
    await resetScene();
    const srcDots2 = await hoverDots(cdp, centers.src.x, centers.src.y, 'source for body drop');
    const pinScene = { x: DST.x + 40, y: DST.y + 30 };
    const pinClient = toClient(pinScene.x, pinScene.y);
    await cdp.mouse('mouseMoved', srcDots2.right.x, srcDots2.right.y, 0);
    await sleep(80);
    await cdp.mouse('mousePressed', srcDots2.right.x, srcDots2.right.y, 1);
    await dragTo(srcDots2.right.x, srcDots2.right.y, pinClient.x, pinClient.y);
    await cdp.mouse('mouseReleased', pinClient.x, pinClient.y, 0);
    await sleep(300);
    const pinned = await readArrow();
    await cdp.shot('06-body-pinned');
    report(Boolean(pinned) && pinned.end?.elementId === DST.id && pinned.end?.gap === 0,
      'a body drop binds with gap 0 (the pinned-point binding)', JSON.stringify(pinned?.end));
    report(pinned && Math.abs(pinned.ex - pinScene.x) <= 2 && Math.abs(pinned.ey - pinScene.y) <= 2,
      'the endpoint lands AT the drop point inside the body', `end=${pinned?.ex},${pinned?.ey} drop=${pinScene.x},${pinScene.y}`);
    // Really DRAG the target below-left of the source: Excalidraw's own binding
    // update must carry the pinned endpoint with the shape, entering through a
    // DIFFERENT edge (top instead of left).
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })");
    await sleep(120);
    const grab = toClient(DST.x + 120, DST.y + 80);
    const dropAt = toClient(60 + 120, 480 + 80);
    await cdp.mouse('mouseMoved', grab.x, grab.y, 0);
    await sleep(80);
    await cdp.mouse('mousePressed', grab.x, grab.y, 1);
    await dragTo(grab.x, grab.y, dropAt.x, dropAt.y, 8);
    await cdp.mouse('mouseReleased', dropAt.x, dropAt.y, 0);
    await sleep(400);
    const migrated = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const arrow = els.find((e) => e.type === 'arrow' && !e.isDeleted);
      const dst = els.find((e) => e.id === '${DST.id}');
      if (!arrow || !dst) return null;
      const last = arrow.points[arrow.points.length - 1];
      const adj = arrow.points[arrow.points.length - 2];
      const ep = { x: arrow.x + last[0], y: arrow.y + last[1] };
      const ap = { x: arrow.x + adj[0], y: arrow.y + adj[1] };
      // Which edge the adjacent-to-endpoint segment crosses first.
      const dx = ep.x - ap.x; const dy = ep.y - ap.y;
      let tMin = 0; let tMax = 1; let edge = null;
      const tryAxis = (p, d, lo, hi, loName, hiName) => {
        if (d === 0) return;
        let t1 = (lo - p) / d; let n1 = loName; let t2 = (hi - p) / d; let n2 = hiName;
        if (t1 > t2) { [t1, t2] = [t2, t1]; [n1, n2] = [n2, n1]; }
        if (t1 > tMin) { tMin = t1; edge = n1; }
        if (t2 < tMax) tMax = t2;
      };
      tryAxis(ap.x, dx, dst.x, dst.x + dst.width, 'left', 'right');
      tryAxis(ap.y, dy, dst.y, dst.y + dst.height, 'top', 'bottom');
      const inside = ep.x > dst.x + 1 && ep.x < dst.x + dst.width - 1 && ep.y > dst.y + 1 && ep.y < dst.y + dst.height - 1;
      return { dstX: Math.round(dst.x), dstY: Math.round(dst.y), inside, edge, ep: { x: Math.round(ep.x), y: Math.round(ep.y) } };
    })()`);
    await cdp.shot('07-body-pinned-migrated');
    report(Boolean(migrated) && migrated.dstY > 400, 'the target really moved below the source', JSON.stringify(migrated));
    report(Boolean(migrated?.inside), 'the pinned endpoint travelled WITH the shape (still inside its body)', JSON.stringify(migrated?.ep));
    report(migrated?.edge === 'top', 'the entry edge migrated (left before the move, top after)', `edge=${migrated?.edge}`);

    // ---- Spec 4: empty release dangles; a bare dot click makes nothing ------
    await resetScene();
    const srcDots3 = await hoverDots(cdp, centers.src.x, centers.src.y, 'source for dangling');
    await cdp.mouse('mouseMoved', srcDots3.top.x, srcDots3.top.y, 0);
    await sleep(80);
    await cdp.mouse('mousePressed', srcDots3.top.x, srcDots3.top.y, 1);
    const freeEnd = { x: srcDots3.top.x + 60, y: srcDots3.top.y - 50 };
    await dragTo(srcDots3.top.x, srcDots3.top.y, freeEnd.x, freeEnd.y, 3);
    await cdp.mouse('mouseReleased', freeEnd.x, freeEnd.y, 0);
    await sleep(300);
    const dangling = await readArrow();
    await cdp.shot('08-dangling');
    const freeScene = { x: (freeEnd.x - xform.ox) / xform.zoom - xform.scrollX, y: (freeEnd.y - xform.oy) / xform.zoom - xform.scrollY };
    report(Boolean(dangling) && dangling.start?.elementId === SRC.id && dangling.end === null,
      'an empty-canvas release creates a connector with a FREE end (finding 12)', JSON.stringify({ start: dangling?.start, end: dangling?.end }));
    report(dangling && Math.abs(dangling.ex - freeScene.x) <= 2 && Math.abs(dangling.ey - freeScene.y) <= 2,
      'the free end parks where released', `end=${dangling?.ex},${dangling?.ey} drop=${freeScene.x},${freeScene.y}`);
    const arrowsBefore = await cdp.eval("window.__harborBoardApi.getSceneElements().filter((e) => e.type === 'arrow' && !e.isDeleted).length");
    const srcDots4 = await hoverDots(cdp, centers.src.x, centers.src.y, 'source for bare click');
    await cdp.mouse('mousePressed', srcDots4.bottom.x, srcDots4.bottom.y, 1);
    await cdp.mouse('mouseReleased', srcDots4.bottom.x, srcDots4.bottom.y, 0);
    await sleep(250);
    const arrowsAfter = await cdp.eval("window.__harborBoardApi.getSceneElements().filter((e) => e.type === 'arrow' && !e.isDeleted).length");
    report(arrowsAfter === arrowsBefore, 'a bare click on a dot creates nothing', `before=${arrowsBefore} after=${arrowsAfter}`);

    // ---- Spec 5: re-dragging the free end re-enters the snap mechanics ------
    await cdp.eval(`window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { '${dangling.id}': true } } })`);
    await waitFor(cdp, "document.querySelectorAll('.wb-conn-end').length === 2", 'endpoint rings on the selected connector');
    const endHandle = await cdp.eval("(() => { const b = [...document.querySelectorAll('.wb-conn-end')].find((h) => h.getAttribute('aria-label') === 'Connector end point'); return { x: parseFloat(b.style.left), y: parseFloat(b.style.top) }; })()");
    await cdp.shot('09-edit-handles');
    await cdp.mouse('mouseMoved', endHandle.x, endHandle.y, 0);
    await sleep(80);
    await cdp.mouse('mousePressed', endHandle.x, endHandle.y, 1);
    const reDot = toClient(DST.x - 11, DST.y + DST.h / 2 - 8);
    await dragTo(endHandle.x, endHandle.y, reDot.x, reDot.y, 8);
    const reSnap = await cdp.eval("({ rings: document.querySelectorAll('.wb-connect-ring').length, lit: document.querySelectorAll('.wb-connect-ring.snap').length })");
    await cdp.shot('10-end-redrag-snap');
    await cdp.mouse('mouseReleased', reDot.x, reDot.y, 0);
    await sleep(300);
    const reattached = await readArrow();
    report(reSnap.rings === 4 && reSnap.lit === 1, 'the endpoint re-drag shows the full two-tier snap visuals', JSON.stringify(reSnap));
    report(Boolean(reattached) && reattached.end?.elementId === DST.id
      && Math.abs(reattached.ex - DST.x) <= 2 && Math.abs(reattached.ey - (DST.y + DST.h / 2)) <= 2,
    'releasing on the dot re-binds the freed end to the side midpoint', JSON.stringify({ end: reattached?.end, ex: reattached?.ex, ey: reattached?.ey }));

    // ---- Spec 6: labels ride a fraction of the line (finding 22) ------------
    await resetScene();
    const srcDots5 = await hoverDots(cdp, centers.src.x, centers.src.y, 'source for label');
    await cdp.mouse('mouseMoved', srcDots5.right.x, srcDots5.right.y, 0);
    await sleep(80);
    await cdp.mouse('mousePressed', srcDots5.right.x, srcDots5.right.y, 1);
    const dotTarget = toClient(DST.x - 6, DST.y + DST.h / 2);
    await dragTo(srcDots5.right.x, srcDots5.right.y, dotTarget.x, dotTarget.y);
    await cdp.mouse('mouseReleased', dotTarget.x, dotTarget.y, 0);
    await sleep(300);
    const labelArrow = await readArrow();
    report(Boolean(labelArrow) && labelArrow.end?.elementId === DST.id, 'label spec has a bound connector to work on');
    // Deselect, then double-click at the quarter point of the line.
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })");
    await sleep(150);
    const quarter = boardFiles.pointAtFraction(labelArrow.points, 0.25);
    const quarterClient = toClient(labelArrow.x + quarter[0], labelArrow.y + quarter[1]);
    await cdp.mouse('mousePressed', quarterClient.x, quarterClient.y, 1);
    await cdp.mouse('mouseReleased', quarterClient.x, quarterClient.y, 0);
    await sleep(80);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(quarterClient.x), y: Math.round(quarterClient.y), button: 'left', buttons: 1, clickCount: 2 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(quarterClient.x), y: Math.round(quarterClient.y), button: 'left', buttons: 0, clickCount: 2 });
    await waitFor(cdp, "Boolean(document.querySelector('.wb-label-input'))", 'inline connector label editor', 6000);
    await cdp.shot('11-label-editor');
    await cdp.send('Input.insertText', { text: 'yes' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(400);
    const label = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const text = els.find((e) => e.type === 'text' && !e.isDeleted && e.customData?.labelFor === '${labelArrow.id}');
      if (!text) return null;
      return { text: text.text, t: text.customData.labelFraction, cx: text.x + text.width / 2, cy: text.y + text.height / 2 };
    })()`);
    await cdp.shot('12-label-typed');
    report(Boolean(label) && label.text === 'yes' && Math.abs(label.t - 0.25) < 0.05,
      'double-click labels the connector AT that point, storing the fraction', JSON.stringify(label));
    const expectQuarter = { x: labelArrow.x + quarter[0], y: labelArrow.y + quarter[1] };
    report(label && Math.abs(label.cx - expectQuarter.x) <= 3 && Math.abs(label.cy - expectQuarter.y) <= 3,
      'the label centres on its fraction of the line', `label=${label?.cx},${label?.cy} expected=${expectQuarter.x},${expectQuarter.y}`);

    // ---- Spec 7: bend-subdivide on the selected connector (finding 20) ------
    await cdp.eval(`window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { '${labelArrow.id}': true } } })`);
    await waitFor(cdp, "document.querySelectorAll('.wb-conn-mid').length >= 1", 'span midpoint handle');
    const midCount1 = await cdp.eval("document.querySelectorAll('.wb-conn-mid').length");
    const midHandle = await cdp.eval("(() => { const b = document.querySelector('.wb-conn-mid'); return { x: parseFloat(b.style.left), y: parseFloat(b.style.top) }; })()");
    await cdp.mouse('mouseMoved', midHandle.x, midHandle.y, 0);
    await sleep(80);
    await cdp.mouse('mousePressed', midHandle.x, midHandle.y, 1);
    await dragTo(midHandle.x, midHandle.y, midHandle.x, midHandle.y + 60, 4);
    await cdp.mouse('mouseReleased', midHandle.x, midHandle.y + 60, 0);
    await sleep(300);
    const bent = await readArrow();
    const midCount2 = await cdp.eval("document.querySelectorAll('.wb-conn-mid').length");
    await cdp.shot('13-bend-subdivided');
    report(midCount1 === 1 && bent.points.length === 3 && bent.roundness?.type === 2,
      'dragging the midpoint bends the bezier through the dragged point', `points=${bent.points.length} roundness=${JSON.stringify(bent.roundness)}`);
    report(midCount2 === 2, 'each half of the bent curve gets its own midpoint handle (subdivision)', `handles=${midCount2}`);

    // ---- Spec 8: elbow conversion via the Type submenu; the label survives --
    await waitFor(cdp, "Boolean(document.querySelector('.wb-connector-bar'))", 'connector style bar');
    await cdp.eval("document.querySelector('.wb-connector-bar [aria-label=\"Line type\"]').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-conn-type'))", 'Type submenu');
    await cdp.shot('14-type-submenu');
    const typeMenu = await cdp.eval(`(() => {
      const menu = document.querySelector('.wb-conn-type');
      return {
        slider: Boolean(menu.querySelector('input[type=range]')),
        routing: menu.querySelectorAll('[aria-label$="connector"]').length,
        dashes: menu.querySelectorAll('[aria-label$="line"]').length,
      };
    })()`);
    report(typeMenu.slider && typeMenu.routing === 3 && typeMenu.dashes === 3,
      'the Type submenu groups the width slider, routing row, and dash row (finding 24)', JSON.stringify(typeMenu));
    await cdp.eval("document.querySelector('.wb-conn-type [aria-label=\"Elbow connector\"]').click()");
    await sleep(500);
    const elbowed = await readArrow();
    report(elbowed.points.length >= 3 && Boolean(elbowed.elbow) && elbowed.roundness === null,
      'the Elbow conversion routes orthogonal waypoints with rounded corners', `points=${elbowed.points.length} waypoints=${elbowed.elbow?.waypoints?.length}`);
    const labelAfter = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const text = els.find((e) => e.type === 'text' && !e.isDeleted && e.customData?.labelFor === '${labelArrow.id}');
      if (!text) return null;
      return { t: text.customData.labelFraction, cx: text.x + text.width / 2, cy: text.y + text.height / 2 };
    })()`);
    const expectOnElbow = boardFiles.pointAtFraction(elbowed.points, labelAfter?.t);
    await cdp.shot('15-label-survives-elbow');
    report(Boolean(labelAfter)
      && Math.abs(labelAfter.cx - (elbowed.x + expectOnElbow[0])) <= 3
      && Math.abs(labelAfter.cy - (elbowed.y + expectOnElbow[1])) <= 3,
    'the fraction label survives the elbow conversion, riding the new route', `label=${labelAfter?.cx},${labelAfter?.cy} expected=${elbowed.x + expectOnElbow[0]},${elbowed.y + expectOnElbow[1]}`);

    // ---- Spec 9: elbow segment handles translate their segment (finding 21) -
    await waitFor(cdp, "document.querySelectorAll('.wb-conn-mid').length >= 1", 'elbow segment handle');
    const segBefore = elbowed.elbow.waypoints;
    const segHandle = await cdp.eval("(() => { const b = document.querySelector('.wb-conn-mid'); return { x: parseFloat(b.style.left), y: parseFloat(b.style.top), cursor: b.style.cursor }; })()");
    const segVertical = segHandle.cursor === 'ew-resize';
    await cdp.mouse('mouseMoved', segHandle.x, segHandle.y, 0);
    await sleep(80);
    await cdp.mouse('mousePressed', segHandle.x, segHandle.y, 1);
    const segTo = segVertical ? { x: segHandle.x + 34, y: segHandle.y } : { x: segHandle.x, y: segHandle.y + 34 };
    await dragTo(segHandle.x, segHandle.y, segTo.x, segTo.y, 4);
    await cdp.mouse('mouseReleased', segTo.x, segTo.y, 0);
    await sleep(300);
    const segAfterArrow = await readArrow();
    await cdp.shot('16-elbow-segment-drag');
    const segAfter = segAfterArrow.elbow?.waypoints || [];
    const segMoved = segAfter.length === segBefore.length && segAfter.some((p, i) => (
      segVertical ? Math.abs(p[0] - segBefore[i][0]) >= 30 : Math.abs(p[1] - segBefore[i][1]) >= 30
    ));
    const stillOrtho = segAfter.every((p, i) => i === segAfter.length - 1
      || p[0] === segAfter[i + 1][0] || p[1] === segAfter[i + 1][1]);
    report(segMoved && stillOrtho, 'dragging a segment handle translates that segment orthogonally', JSON.stringify({ before: segBefore, after: segAfter }));

    // ---- Spec 10: per-end arrowheads, swap, width slider (findings 23, 25) --
    await cdp.eval("document.querySelector('.wb-connector-bar [aria-label=\"End arrowhead\"]').click()");
    await waitFor(cdp, "document.querySelectorAll('.wb-conn-heads .wb-conn-head-opt').length === 12", 'end arrowhead picker');
    await cdp.shot('17-arrowhead-picker');
    await cdp.eval("document.querySelector('.wb-conn-heads [aria-label=\"ERD many\"]').click()");
    await sleep(200);
    let heads = await readArrow();
    report(heads.endHead === 'crowfoot_many', 'the end picks an ERD crowfoot natively', `end=${heads.endHead}`);
    await cdp.eval("document.querySelector('.wb-connector-bar [aria-label=\"Start arrowhead\"]').click()");
    await waitFor(cdp, "document.querySelectorAll('.wb-conn-heads .wb-conn-head-opt').length === 12", 'start arrowhead picker');
    await cdp.eval("document.querySelector('.wb-conn-heads [aria-label=\"Open circle\"]').click()");
    await sleep(200);
    heads = await readArrow();
    report(heads.startHead === 'circle_outline' && heads.endHead === 'crowfoot_many', 'each end picks independently', `start=${heads.startHead} end=${heads.endHead}`);
    await cdp.eval("document.querySelector('.wb-connector-bar [aria-label=\"Swap line ends\"]').click()");
    await sleep(200);
    heads = await readArrow();
    report(heads.startHead === 'crowfoot_many' && heads.endHead === 'circle_outline', 'Swap line ends flips the arrowheads', `start=${heads.startHead} end=${heads.endHead}`);
    await cdp.eval("document.querySelector('.wb-connector-bar [aria-label=\"Line type\"]').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-conn-width input'))", 'width slider');
    await cdp.eval(`(() => {
      const input = document.querySelector('.wb-conn-width input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '6');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    heads = await readArrow();
    await cdp.shot('18-connector-bar');
    report(heads.strokeWidth === 6, 'the 10-tick width slider applies its width', `strokeWidth=${heads.strokeWidth}`);

    report(cdp.errors.length === 0, 'zero console errors or exceptions', cdp.errors.slice(0, 3).join(' | ') || 'clean');
    report(failures.length === 0, 'drive-connector-snap-win');
  } finally {
    child.kill();
    mover.kill();
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(`FAIL drive crashed: ${error.message}`);
  process.exit(1);
});
