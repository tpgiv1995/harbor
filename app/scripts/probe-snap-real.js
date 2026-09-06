'use strict';
// Reproduce Pat's exact reported gesture (2026-08-30): click a connect dot on
// shape A, drag with a ragged human path toward shape B's opposite dot, release
// SHORT of it (inside SNAP_RADIUS), at 150% device scale. Asserts the arrow
// snapped to B's side-midpoint anchor and bound both ends. Screenshots every
// phase. Never shows a window (HARBOR_E2E offscreen).
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const APP_DIR = path.resolve(__dirname, '..');
const PORT = 9351;
const OUT = path.join(os.tmpdir(), 'harbor-probe-snap');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
      else this.events.push(msg);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const res = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval failed');
    return res.result.value;
  }
  async shot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.data, 'base64'));
  }
}

async function waitFor(cdp, expr, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.eval(`Boolean(${expr})`)) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-probe-snap-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // presence alone can flip electron to node mode
  const child = spawn(path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'], {
    cwd: APP_DIR,
    env: {
      ...env,
      HARBOR_E2E: '1',
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
      HARBOR_SESSIOND_SOCKET: path.join(tmp, 'sessiond', 'd.sock'),
      HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
      HARBOR_BOARDS_DIR: path.join(tmp, 'boards'),
      HARBOR_E2E_FAKE_LAUNCH: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });

  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch { /* booting */ }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('no page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // Pat's world: 150% scaling.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1.5, mobile: false });

  await waitFor(cdp, "[...document.querySelectorAll('.view-switch-btn')].some((b) => (b.getAttribute('aria-label') || b.textContent.trim()) === 'Board')", 'Board tab');
  await cdp.eval("[...document.querySelectorAll('.view-switch-btn')].find((b) => (b.getAttribute('aria-label') || b.textContent.trim()) === 'Board').click()");
  await waitFor(cdp, "document.querySelector('.excalidraw canvas') && window.__harborBoardApi", 'canvas');

  // Two clean rectangles, far apart.
  await cdp.eval(`(() => {
    const api = window.__harborBoardApi;
    const mk = (id, x, y) => ({ id, type: 'rectangle', x, y, width: 180, height: 120, angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#d0ebff', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: x, version: 1, versionNonce: x, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false });
    const tri = { id: 'probe-a', type: 'line', x: 120, y: 260, width: 180, height: 120, angle: 0, points: [[90, 0], [180, 120], [0, 120], [90, 0]], strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 7, version: 1, versionNonce: 7, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null, lastCommittedPoint: null, customData: { polyShape: true } };
    api.updateScene({ elements: [tri, mk('probe-b', 640, 420)], appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} } });
  })()`);
  await sleep(400);

  const geom = await cdp.eval(`(() => {
    const api = window.__harborBoardApi; const app = api.getAppState(); const z = app.zoom.value;
    const el = (id) => api.getSceneElements().find((e) => e.id === id);
    const client = (x, y) => ({ x: Math.round((x + app.scrollX) * z + (app.offsetLeft || 0)), y: Math.round((y + app.scrollY) * z + (app.offsetTop || 0)) });
    const a = el('probe-a'); const b = el('probe-b');
    return {
      aRight: client(a.x + a.width, a.y + a.height / 2),
      bLeft: client(b.x, b.y + b.height / 2),
      aCenter: client(a.x + a.width / 2, a.y + a.height / 2),
    };
  })()`);

  // Hover shape A so its dots appear, like a human mousing in.
  const mouse = (type, x, y, buttons, button = 'none') => cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons });
  await mouse('mouseMoved', geom.aCenter.x - 60, geom.aCenter.y - 40, 0);
  await mouse('mouseMoved', geom.aCenter.x, geom.aCenter.y, 0);
  await sleep(350);
  const dots = await cdp.eval("[...document.querySelectorAll('.wb-connect-dot')].map((d) => { const r = d.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })");
  await cdp.shot('1-hover-dots');
  if (dots.length !== 4) throw new Error(`expected 4 hover dots, saw ${dots.length}`);
  const rightDot = dots.reduce((best, d) => (d.x > (best?.x ?? -1) ? d : best), null);

  // The human drag: press ON the right dot, ragged path, release 14px short of
  // B's left-side midpoint (inside SNAP_RADIUS 24, not on the dot).
  await mouse('mouseMoved', rightDot.x, rightDot.y, 0);
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rightDot.x, y: rightDot.y, button: 'left', buttons: 1, clickCount: 1 });
  const releaseAt = { x: geom.bLeft.x - 14, y: geom.bLeft.y - 6 };
  const steps = 14;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const jitterY = Math.sin(i * 1.7) * 3;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(rightDot.x + (releaseAt.x - rightDot.x) * t),
      y: Math.round(rightDot.y + (releaseAt.y - rightDot.y) * t + jitterY),
      button: 'none',
      buttons: 1,
    });
    await sleep(28);
  }
  await sleep(200);
  await cdp.shot('2-mid-drag-near-target');
  const midState = await cdp.eval("({ rings: document.querySelectorAll('.wb-target-ring, .wb-connect-dot').length, lit: Boolean(document.querySelector('.wb-target-ring.lit, .wb-connect-dot.lit, .wb-snap-lit, [data-snap=\\'dot\\']')) })");
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: releaseAt.x, y: releaseAt.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(500);
  await cdp.shot('3-released');

  const verdict = await cdp.eval(`(() => {
    const api = window.__harborBoardApi; const app = api.getAppState(); const z = app.zoom.value;
    const arrow = [...api.getSceneElements()].reverse().find((e) => e.type === 'arrow' && !e.isDeleted);
    if (!arrow) return { arrow: false };
    const b = api.getSceneElements().find((e) => e.id === 'probe-b');
    const endScene = { x: arrow.x + arrow.points[arrow.points.length - 1][0], y: arrow.y + arrow.points[arrow.points.length - 1][1] };
    const want = { x: b.x, y: b.y + b.height / 2 };
    return {
      arrow: true,
      startBound: Boolean((arrow.startBinding && arrow.startBinding.elementId === 'probe-a')
        || (arrow.customData && arrow.customData.polyBind && arrow.customData.polyBind.start && arrow.customData.polyBind.start.id === 'probe-a')),
      endBound: Boolean(arrow.endBinding && arrow.endBinding.elementId === 'probe-b'),
      endDx: Math.round((endScene.x - want.x) * 10) / 10,
      endDy: Math.round((endScene.y - want.y) * 10) / 10,
      points: arrow.points.length,
    };
  })()`);

  // Move the poly and prove the glue: the arrow's START must follow to the new
  // right-side midpoint via the maintenance pass.
  await cdp.eval("(() => { const api = window.__harborBoardApi; api.updateScene({ elements: api.getSceneElements().map((e) => (e.id === 'probe-a' ? { ...e, x: e.x + 80, y: e.y + 60 } : e)), captureUpdate: 'IMMEDIATELY' }); })()");
  await sleep(600);
  const follow = await cdp.eval(`(() => {
    const api = window.__harborBoardApi;
    const a = api.getSceneElements().find((e) => e.id === 'probe-a');
    const arrow = [...api.getSceneElements()].reverse().find((e) => e.type === 'arrow' && !e.isDeleted);
    const startScene = { x: arrow.x + arrow.points[0][0], y: arrow.y + arrow.points[0][1] };
    const want = { x: a.x + a.width, y: a.y + a.height / 2 };
    return { dx: Math.round((startScene.x - want.x) * 10) / 10, dy: Math.round((startScene.y - want.y) * 10) / 10 };
  })()`);
  console.log('poly moved, arrow start follow offset:', JSON.stringify(follow));
  await cdp.shot('4-poly-moved');

  console.log('mid-drag ui:', JSON.stringify(midState));
  console.log('verdict:', JSON.stringify(verdict));
  const snapOk = verdict.arrow && verdict.startBound && verdict.endBound
    && Math.abs(verdict.endDx) <= 8 && Math.abs(verdict.endDy) <= 8
    && Math.abs(follow.dx) <= 2 && Math.abs(follow.dy) <= 2;
  console.log(snapOk ? 'SNAP OK at DPR 1.5' : 'SNAP BROKEN at DPR 1.5');
  console.log('screenshots:', OUT);
  try { child.kill(); } catch {}
  process.exit(snapOk ? 0 : 1);
})().catch((error) => { console.error('PROBE FAILED:', error.message); process.exit(2); });
