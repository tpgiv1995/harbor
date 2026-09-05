'use strict';

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9338;
const OUT = path.join(os.tmpdir(), 'harbor-drive-whiteboard');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method) this.events.push(msg);
      if (msg.id && this.pending.has(msg.id)) {
        const pending = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${msg.error.message} from ${pending.method} ${pending.hint}`));
        else pending.resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, hint: String(params.expression || '').slice(0, 140) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`${result.exceptionDetails.exception?.description || 'page error'} while evaluating ${expression.slice(0, 140)}`);
    }
    return result.result.value;
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
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

const elementSource = `(() => {
  const base = (id, type, x, y, width, height, index) => ({
    id, type, x, y, width, height, angle: 0, strokeColor: '#4dabf7',
    backgroundColor: type === 'image' ? 'transparent' : '#1971c2',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1,
    opacity: 100, groupIds: [], frameId: null, index, roundness: type === 'rectangle' ? { type: 3 } : null,
    seed: 10 + index.length, version: 1, versionNonce: 100 + index.length,
    isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
  });
  const rectangle = base('drive-rectangle', 'rectangle', 80, 90, 240, 140, 'a0');
  const ellipse = base('drive-ellipse', 'ellipse', 390, 120, 180, 180, 'a1');
  const image = {
    ...base('drive-image', 'image', 650, 120, 64, 64, 'a2'),
    fileId: 'drive-image-file', status: 'saved', scale: [1, 1], crop: null,
  };
  const file = {
    id: 'drive-image-file',
    dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lM3Z7wAAAABJRU5ErkJggg==',
    mimeType: 'image/png', created: Date.now(), lastRetrieved: Date.now(),
  };
  window.__harborBoardApi.addFiles([file]);
  window.__harborBoardApi.updateScene({ elements: [rectangle, ellipse, image] });
  return { elementCount: window.__harborBoardApi.getSceneElements().length, fileCount: Object.keys(window.__harborBoardApi.getFiles()).length };
})()`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  // HARBOR_DRIVE_SKIP_BUILD=1 reuses the current dist: rebuilding the LIVE dist races
  // Pat's own relaunches (the black-screen incident), so skip when dist is known-good.
  if (!process.env.HARBOR_DRIVE_SKIP_BUILD) execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-whiteboard-drive-'));
  const userData = path.join(tmp, 'userData');
  const boardsDir = path.join(tmp, 'boards');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.paths = {
    ...config.paths,
    cacheDir: path.join(tmp, 'cache'),
    tasksFile: path.join(tmp, 'tasks.json'),
    projectIconsDir: path.join(tmp, 'project-icons'),
    boardsDir,
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  // The window is born offscreen under HARBOR_E2E (createWindow spawns it at
  // x=-4200), so nothing ever paints over the user's screen. The occlusion and
  // throttling switches keep that offscreen window deterministic: without them
  // Chromium starves rAF and throttles timers for a window it considers
  // occluded, which is exactly the "synthetic input does not land" flakiness.
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

  const results = [];
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };

  try {
    let target;
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(500);
      try {
        const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json());
        target = targets.find((item) => item.type === 'page' && !item.url.startsWith('devtools:'));
      } catch {}
    }
    if (!target) throw new Error('CDP target never appeared');
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`, { stdio: 'ignore' });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

    await waitFor(cdp, "[...document.querySelectorAll('.view-switch-btn')].some((b) => b.textContent.trim() === 'Board')", 'Board tab');
    await cdp.eval("[...document.querySelectorAll('.view-switch-btn')].find((b) => b.textContent.trim() === 'Board').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.excalidraw canvas') && window.__harborBoardApi)", 'Excalidraw canvas');
    await cdp.shot('1-empty-board');

    // Regression guard for the reported collision: the Excalidraw hamburger menu must
    // NOT open on top of the tool rail. It used to drop straight down over the rail,
    // which (rail z-index 6) painted the rail across the first character of every menu
    // row ("ind on canvas"). The dropdown now flies out to the right of the rail.
    await cdp.eval("(() => { const b = document.querySelector('.dropdown-menu-button'); if (b) b.click(); return Boolean(b); })()");
    await waitFor(cdp, "Boolean(document.querySelector('.dropdown-menu'))", 'main menu open');
    await sleep(120);
    const menuGeo = await cdp.eval(`(() => {
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
      const m = rect(document.querySelector('.dropdown-menu'));
      const rail = rect(document.querySelector('.wb-rail'));
      const overlap = (m && rail) ? !(m.right <= rail.x || rail.right <= m.x || m.y + m.h <= rail.y || rail.y + rail.h <= m.y) : true;
      return { m, rail, overlap, clearsRail: (m && rail) ? m.x >= rail.right : false, gap: (m && rail) ? m.x - rail.right : null };
    })()`);
    results.push(`menu vs rail: menu=[${menuGeo.m && menuGeo.m.x},${menuGeo.m && menuGeo.m.right}] rail=[${menuGeo.rail && menuGeo.rail.x},${menuGeo.rail && menuGeo.rail.right}] overlap=${menuGeo.overlap} gap=${menuGeo.gap}`);
    check(!menuGeo.overlap, `the main menu overlaps the tool rail (menu x=${menuGeo.m && menuGeo.m.x}, rail right=${menuGeo.rail && menuGeo.rail.right})`);
    check(menuGeo.clearsRail, `the main menu does not clear the rail (menu x=${menuGeo.m && menuGeo.m.x} < rail right ${menuGeo.rail && menuGeo.rail.right})`);
    await cdp.shot('1b-menu-open');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(150);

    const added = await cdp.eval(elementSource);
    results.push(`programmatic scene: elements=${added.elementCount} files=${added.fileCount}`);
    check(added.elementCount === 3, `expected 3 elements after updateScene, saw ${added.elementCount}`);
    check(added.fileCount === 1, `expected 1 file after addFiles, saw ${added.fileCount}`);
    await cdp.shot('2-shapes-and-image');
    await sleep(1800);

    const boardFiles = fs.readdirSync(boardsDir).filter((name) => name.endsWith('.json'));
    check(boardFiles.length === 1, `expected one board file, saw ${boardFiles.length}`);
    const firstPath = path.join(boardsDir, boardFiles[0]);
    const persisted = JSON.parse(fs.readFileSync(firstPath, 'utf8'));
    results.push(`disk scene: ${path.basename(firstPath)} elements=${persisted.elements.length} files=${Object.keys(persisted.files).length}`);
    check(persisted.elements.length === 3, `disk board has ${persisted.elements.length} elements`);
    check(Object.keys(persisted.files).length === 1, 'disk board lost its embedded image file');

    await cdp.send('Page.reload');
    await waitFor(cdp, "window.__harborBoardApi && window.__harborBoardApi.getSceneElements().length === 3", 'restored shapes');
    await waitFor(cdp, "Object.keys(window.__harborBoardApi.getFiles()).length === 1", 'restored image');
    const restored = await cdp.eval("({ elements: window.__harborBoardApi.getSceneElements().map((e) => e.type), files: Object.keys(window.__harborBoardApi.getFiles()), roughness: window.__harborBoardApi.getSceneElements().map((e) => e.roughness) })");
    results.push(`reload scene: elements=${restored.elements.join(',')} files=${restored.files.join(',')} roughness=${restored.roughness.join(',')}`);
    check(restored.elements.includes('image'), 'image element did not survive reload');
    // Shapes saved with Excalidraw's sketchy roughness must come back CLEAN (normalized on load).
    check(restored.roughness.every((r) => r === 0 || r === undefined), `existing shapes stayed sketchy after reload (roughness ${restored.roughness.join(',')})`);
    await cdp.shot('3-restored-after-reload');

    // Miro-style board switcher (2026-08-30): New renames inline in the picker
    // bar (Miro's editable title); the switcher button carries the ACTIVE name.
    await cdp.eval("document.querySelector('.whiteboard-new').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-switcher-title-rename'))", 'inline title rename after New board');
    await cdp.eval(`(() => {
      const input = document.querySelector('.whiteboard-rename');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Second board');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await waitFor(cdp, "(document.querySelector('.wb-switcher-btn .wb-switcher-name') || {}).textContent === 'Second board'", 'the switcher button shows the renamed active board');
    await cdp.eval("document.querySelector('.wb-switcher-btn').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-switcher-panel'))", 'switcher panel opens');
    await waitFor(cdp, "[...document.querySelectorAll('.wb-switcher-row .wb-switcher-name')].some((e) => e.textContent === 'Second board')", 'renamed second board listed in the switcher');
    // Search filters the list live.
    await cdp.eval("(() => { const s = document.querySelector('.wb-switcher-search'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(s, 'unti'); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    await sleep(150);
    const filtered = await cdp.eval("[...document.querySelectorAll('.wb-switcher-row .wb-switcher-name')].map((e) => e.textContent)");
    results.push(`switcher search 'unti': ${JSON.stringify(filtered)}`);
    check(filtered.length === 1 && filtered[0] === 'Untitled board', `switcher search should leave only Untitled board, saw ${JSON.stringify(filtered)}`);
    await cdp.shot('4-second-board');
    await cdp.eval("[...document.querySelectorAll('.wb-switcher-row .wb-switcher-name')].find((e) => e.textContent === 'Untitled board').closest('button').click()");
    await waitFor(cdp, "window.__harborBoardApi.getSceneElements().length === 3", 'first board after switch');
    check(!(await cdp.eval("Boolean(document.querySelector('.wb-switcher-panel'))")), 'the switcher panel should close when a board is picked');
    await cdp.shot('5-switched-back');

    // Duplicate through the switcher carries the whole scene under a Copy of
    // name; delete (arm + confirm) moves it to trash; land back on board one.
    await cdp.eval("document.querySelector('.wb-switcher-btn').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-switcher-panel'))", 'switcher reopens for duplicate');
    await cdp.eval("[...document.querySelectorAll('.wb-switcher-row')].find((r) => r.querySelector('.wb-switcher-name').textContent === 'Untitled board').querySelector('[title=\"Duplicate board\"]').click()");
    await waitFor(cdp, "document.querySelector('.wb-switcher-btn .wb-switcher-name').textContent === 'Copy of Untitled board'", 'duplicate created and opened');
    await waitFor(cdp, "window.__harborBoardApi.getSceneElements().length === 3", 'duplicate carries the source scene');
    const delRowExpr = "[...document.querySelectorAll('.wb-switcher-row')].find((r) => r.querySelector('.wb-switcher-name').textContent === 'Copy of Untitled board')";
    await cdp.eval(`${delRowExpr}.querySelector('.wb-switcher-act.delete').click()`);
    await sleep(120);
    check(await cdp.eval(`Boolean(${delRowExpr}.querySelector('.wb-switcher-act.delete.armed'))`), 'first Delete click should arm, not delete');
    await cdp.eval(`${delRowExpr}.querySelector('.wb-switcher-act.delete').click()`);
    await waitFor(cdp, "![...document.querySelectorAll('.wb-switcher-row .wb-switcher-name')].some((e) => e.textContent === 'Copy of Untitled board')", 'armed confirm moved the duplicate to trash');
    await cdp.eval("[...document.querySelectorAll('.wb-switcher-row .wb-switcher-name')].find((e) => e.textContent === 'Untitled board').closest('button').click()");
    await waitFor(cdp, "window.__harborBoardApi.getSceneElements().length === 3", 'back on the first board after the trash round trip');

    // --- Harbor rail: Miro-style ARMED sticky placement, templates flyout, grid ---
    // Clicking the sticky tool ARMS placement (opens the colour flyout + crosshair); it does
    // NOT drop a sticky. The next canvas click drops one WHERE you click (the Miro model).
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } })");
    await sleep(60);
    const beforeSticky = await cdp.eval('window.__harborBoardApi.getSceneElements().length');
    await cdp.eval("document.querySelector('.wb-rail .wb-rail-btn.accent').click()"); // arm placement
    await waitFor(cdp, "Boolean(document.querySelector('.wb-flyout-swatches'))", 'sticky flyout opens on click (armed)');
    await cdp.shot('6a-armed-flyout');
    const flyoutGeo = await cdp.eval("(() => { const f = document.querySelector('.wb-flyout-swatches'); const r = f.getBoundingClientRect(); return { x: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom), cols: getComputedStyle(f).gridTemplateColumns.split(' ').length, onscreen: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 }; })()");
    results.push(`sticky flyout: x=${flyoutGeo.x} top=${flyoutGeo.top} bottom=${flyoutGeo.bottom} cols=${flyoutGeo.cols} onscreen=${flyoutGeo.onscreen}`);
    check(flyoutGeo.cols === 2, `sticky flyout is not a 2-column grid (${flyoutGeo.cols} cols)`);
    check(flyoutGeo.onscreen, `sticky flyout panel spills off-screen (top ${flyoutGeo.top}, bottom ${flyoutGeo.bottom}, x ${flyoutGeo.x})`);
    check(await cdp.eval(`window.__harborBoardApi.getSceneElements().length === ${beforeSticky}`), 'clicking the sticky tool wrongly dropped a sticky before any canvas click');
    check(await cdp.eval("document.body.classList.contains('wb-placing-sticky')"), 'armed sticky placement did not set the placing state');
    // Miro shows a sticky-note cursor in placement mode (not the default): a url() cursor.
    check(await cdp.eval("getComputedStyle(document.querySelector('.excalidraw canvas')).cursor.includes('url(')"), 'armed sticky mode did not set the sticky-note cursor');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 900, y: 480, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 900, y: 480, button: 'left', buttons: 0, clickCount: 1 });
    // Wave B one-shot model (catalog finding 30): ONE click places ONE ~110px sticky
    // centred at the click with TWO bottom shadow bands, enters text edit, and DISARMS.
    await waitFor(cdp, "window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.sticky).length === 1", 'sticky placed on the canvas click (face + shadow bands)');
    await sleep(250);
    const sticky = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const els = api.getSceneElements();
      const face = els.filter((e) => e.customData && e.customData.sticky).slice(-1)[0];
      const bands = els.filter((e) => e.customData && e.customData.stickyShadow && e.customData.faceId === face.id);
      const app = api.getAppState(); const z = app.zoom.value;
      const screenCx = (face.x + face.width / 2 + app.scrollX) * z + (app.offsetLeft || 0);
      const screenCy = (face.y + face.height / 2 + app.scrollY) * z + (app.offsetTop || 0);
      const canvas = document.querySelector('.excalidraw canvas');
      return { type: face.type, bg: face.backgroundColor, stroke: face.strokeColor, w: Math.round(face.width), h: Math.round(face.height), filter: getComputedStyle(canvas).filter,
        screenCx: Math.round(screenCx), screenCy: Math.round(screenCy), faceId: face.id,
        bands: bands.length, bandsBelow: bands.every((b) => b.y > face.y), bandsGlued: bands.every((b) => b.width === face.width),
        bandsLocked: bands.every((b) => Boolean(b.locked)), bandOpacity: bands.length ? Math.max(...bands.map((b) => b.opacity)) : null,
        armed: document.body.classList.contains('wb-placing-sticky'),
        editorUp: Boolean(document.querySelector('.excalidraw textarea')) };
    })()`);
    results.push(`sticky: type=${sticky.type} bg=${sticky.bg} stroke=${sticky.stroke} ${sticky.w}x${sticky.h} placedAt=(${sticky.screenCx},${sticky.screenCy}) bands=${sticky.bands} below=${sticky.bandsBelow} glued=${sticky.bandsGlued} locked=${sticky.bandsLocked} op=${sticky.bandOpacity} armed=${sticky.armed} editor=${sticky.editorUp} canvasFilter=${sticky.filter}`);
    check(sticky.type === 'rectangle', `sticky is a ${sticky.type}, not a rectangle`);
    check(sticky.bg === '#ffe86d', `default sticky bg ${sticky.bg}, expected Miro yellow`);
    check(sticky.stroke === 'transparent', `sticky has a border (${sticky.stroke}); expected borderless`);
    check(sticky.w === 110 && sticky.h === 110, `sticky is ${sticky.w}x${sticky.h}, expected the 110px Miro small`);
    // The sticky lands centred WHERE you clicked (Miro), not at the viewport centre.
    check(Math.abs(sticky.screenCx - 900) <= 10 && Math.abs(sticky.screenCy - 480) <= 10, `sticky did not land where clicked (screen ${sticky.screenCx},${sticky.screenCy} vs click 900,480)`);
    // Two locked, linked, low-opacity bottom bands form the Miro-style soft drop shadow.
    check(sticky.bands === 2, `sticky has ${sticky.bands} shadow bands behind it, expected 2`);
    check(sticky.bandsBelow && sticky.bandsGlued, 'the shadow bands are not glued to the bottom of the face');
    check(sticky.bandsLocked, 'a sticky shadow band is not locked (it would be independently selectable)');
    check(sticky.bandOpacity > 0 && sticky.bandOpacity < 30, `sticky shadow bands look wrong (max opacity ${sticky.bandOpacity})`);
    // The canvas must NOT carry Excalidraw's dark-mode invert filter (the colour bug).
    check(sticky.filter === 'none', `canvas still inverts colours (filter: ${sticky.filter})`);
    // One-shot: the tool DISARMS after a single placement and drops the caret in.
    check(sticky.armed === false, 'the sticky tool stayed armed after placing (Wave B one-shot model disarms)');
    check(sticky.editorUp, 'placement did not enter text edit (no caret)');
    await cdp.shot('6-sticky-note');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(400);

    // The shadow bands FOLLOW their face: move the face, and syncStickyShadows re-glues.
    await cdp.eval(`(() => { const api = window.__harborBoardApi; const els = api.getSceneElements(); const next = els.map((e) => e.id === '${sticky.faceId}' ? { ...e, x: e.x + 300, y: e.y + 200 } : e); api.updateScene({ elements: next, captureUpdate: 'immediately' }); })()`);
    await sleep(400);
    const followed = await cdp.eval(`(() => { const els = window.__harborBoardApi.getSceneElements(); const face = els.find((e) => e.id === '${sticky.faceId}'); const bands = els.filter((e) => e.customData && e.customData.faceId === '${sticky.faceId}'); return { bands: bands.length, glued: bands.every((b) => b.width === face.width && b.y > face.y && b.y < face.y + face.height + 16) }; })()`);
    results.push(`sticky shadow follows face: bands=${followed && followed.bands} glued=${followed && followed.glued}`);
    check(followed && followed.bands === 2 && followed.glued, 'the shadow bands did not follow their face after a move');

    // One-shot placement disarmed the tool; re-arm, pick a colour from the flyout, and
    // the NEXT click places THAT colour where clicked.
    await cdp.eval("document.querySelector('.wb-rail .wb-rail-btn.accent').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-flyout-swatches'))", 're-armed sticky flyout for the colour pick');
    const swatchCount = await cdp.eval("document.querySelectorAll('.wb-flyout-swatches .wb-sticky').length");
    results.push(`sticky flyout swatches: ${swatchCount}`);
    check(swatchCount === 16, `sticky flyout shows ${swatchCount} colours, expected Miro's 16`);
    await cdp.eval("[...document.querySelectorAll('.wb-flyout-swatches .wb-sticky')].find((s) => (s.getAttribute('aria-label') || '').startsWith('Dark Green')).click()");
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 640, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 640, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(cdp, "window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.sticky).length === 2", 'sticky placed after picking a colour');
    const colour = await cdp.eval("window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.sticky).slice(-1)[0].backgroundColor");
    results.push(`sticky colour (picked): ${colour}`);
    check(colour === '#6ae08d', `picked Dark Green sticky produced ${colour}, expected #6ae08d`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(300);

    // Placement lands WHERE clicked even zoomed OUT (40%): re-arm, click a canvas point.
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { zoom: { value: 0.4 } } })");
    await sleep(120);
    await cdp.eval("document.querySelector('.wb-rail .wb-rail-btn.accent').click()");
    await waitFor(cdp, "document.body.classList.contains('wb-placing-sticky')", 're-armed for the zoom placement');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1000, y: 520, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1000, y: 520, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(cdp, "window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.sticky).length === 3", 'sticky placed at 40% zoom');
    const zoomSticky = await cdp.eval(`(() => {
      const api = window.__harborBoardApi; const els = api.getSceneElements();
      const face = els.filter((e) => e.customData && e.customData.sticky).slice(-1)[0];
      const app = api.getAppState(); const zoom = app.zoom.value;
      const sx = (face.x + face.width / 2 + app.scrollX) * zoom + (app.offsetLeft || 0);
      const sy = (face.y + face.height / 2 + app.scrollY) * zoom + (app.offsetTop || 0);
      return { type: face.type, zoom, screenX: Math.round(sx), screenY: Math.round(sy) };
    })()`);
    results.push(`zoom sticky: zoom=${zoomSticky.zoom} placedAt=(${zoomSticky.screenX},${zoomSticky.screenY})`);
    check(Math.abs(zoomSticky.screenX - 1000) <= 12 && Math.abs(zoomSticky.screenY - 520) <= 12, `zoomed sticky did not land where clicked (screen ${zoomSticky.screenX},${zoomSticky.screenY} vs 1000,520)`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(200);
    // Escape DISARMS an armed tool without placing (so stray canvas clicks are safe).
    await cdp.eval("document.querySelector('.wb-rail .wb-rail-btn.accent').click()");
    await waitFor(cdp, "document.body.classList.contains('wb-placing-sticky')", 'armed for the Escape-disarm check');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(100);
    check(!(await cdp.eval("document.body.classList.contains('wb-placing-sticky')")), 'Escape did not disarm sticky placement');
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { zoom: { value: 1 } } })");

    // Orphan cleanup (Pat's report: deleting a sticky left its shadow as a grey ghost).
    // Place a sticky, select it with a real click, press Delete; its shadow must go too and
    // NO orphan shadow may remain anywhere on the board.
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, selectedElementIds: {} } })");
    await cdp.eval("document.querySelector('.wb-rail .wb-rail-btn.accent').click()"); // arm
    await waitFor(cdp, "Boolean(document.querySelector('.wb-flyout-swatches'))", 'flyout for delete test');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1150, y: 640, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1150, y: 640, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(cdp, "window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.sticky).length === 4", 'sticky for the delete test placed');
    // placement entered text edit and auto-disarmed; Escape commits the empty label
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(200);
    await cdp.eval("(() => { window.__delId = window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.sticky).slice(-1)[0].id; })()");
    // real click to select + focus the canvas, then Delete
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1150, y: 640, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1150, y: 640, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(140);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
    await sleep(500);
    const del = await cdp.eval("(() => { const els = window.__harborBoardApi.getSceneElements(); const orphans = els.filter((e) => e.customData && e.customData.stickyShadow && !els.some((f) => f.id === (e.customData && e.customData.faceId))); return { faceGone: !els.some((e) => e.id === window.__delId), shadowGone: !els.some((e) => e.customData && e.customData.faceId === window.__delId), orphans: orphans.length }; })()");
    results.push(`real-delete orphan cleanup: faceGone=${del.faceGone} shadowGone=${del.shadowGone} orphans=${del.orphans}`);
    check(del.faceGone, 'real Delete did not remove the sticky face');
    check(del.shadowGone, 'deleting a sticky left ITS shadow behind (orphan) - Pat report');
    check(del.orphans === 0, `${del.orphans} orphan sticky shadow(s) remain on the board after a delete`);
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })");

    // Flowchart proves skeleton arrow-binding survives a real convert+insert.
    const beforeTpl = await cdp.eval('window.__harborBoardApi.getSceneElements().length');
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => b.getAttribute('aria-label') === 'Templates').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-flyout-list'))", 'template flyout opens');
    await cdp.eval("[...document.querySelectorAll('.wb-template-item')].find((b) => b.textContent === 'Flowchart').click()");
    await waitFor(cdp, `window.__harborBoardApi.getSceneElements().length >= ${beforeTpl + 5}`, 'flowchart inserted');
    const flow = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const added = els.slice(${beforeTpl});
      const arrows = added.filter((e) => e.type === 'arrow');
      const bound = arrows.filter((e) => e.startBinding && e.endBinding).length;
      return { added: added.length, arrows: arrows.length, bound, diamond: added.some((e) => e.type === 'diamond') };
    })()`);
    results.push(`flowchart: added=${flow.added} arrows=${flow.arrows} bound=${flow.bound} diamond=${flow.diamond}`);
    check(flow.diamond, 'flowchart produced no decision diamond');
    check(flow.arrows >= 3, `flowchart produced ${flow.arrows} arrows, expected 3`);
    check(flow.bound === flow.arrows, `only ${flow.bound}/${flow.arrows} flowchart arrows bound to their nodes`);
    await cdp.shot('7-flowchart');

    // Grid toggle (rail) writes real appState.
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /toggle grid/i.test(b.getAttribute('aria-label') || '')).click()");
    await waitFor(cdp, 'window.__harborBoardApi.getAppState().gridModeEnabled === true', 'grid enabled');
    results.push('grid: enabled via rail');
    await cdp.shot('8-grid');

    // Custom chrome: Excalidraw's native toolbar + panel are hidden, our rail replaces them.
    const chrome = await cdp.eval(`(() => {
      const tb = document.querySelector('.excalidraw .App-toolbar-container');
      const panel = document.querySelector('.excalidraw .App-menu__left');
      return {
        toolbarHidden: !tb || getComputedStyle(tb).display === 'none',
        panelHidden: !panel || getComputedStyle(panel).display === 'none',
        railBtns: document.querySelectorAll('.wb-rail .wb-rail-btn').length,
      };
    })()`);
    results.push(`chrome: nativeToolbarHidden=${chrome.toolbarHidden} nativePanelHidden=${chrome.panelHidden} railBtns=${chrome.railBtns}`);
    check(chrome.toolbarHidden, 'native Excalidraw shape toolbar is still visible');
    check(chrome.railBtns >= 12, `tool rail has only ${chrome.railBtns} buttons`);

    // The rail drives Excalidraw's real active tool (rectangle via the Shapes flyout).
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => b.getAttribute('aria-label') === 'Shapes').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-flyout-shapes'))", 'shapes flyout opens');
    await cdp.eval("[...document.querySelectorAll('.wb-flyout-shapes .wb-rail-btn')].find((b) => /Rectangle/.test(b.getAttribute('aria-label'))).click()");
    await waitFor(cdp, "window.__harborBoardApi.getAppState().activeTool.type === 'rectangle'", 'rail selected the rectangle tool');
    results.push('rail: rectangle tool active (via shapes flyout)');

    // Actually DRAW a rectangle by dragging on the canvas (the core action a user does).
    // Real browser input (Input.dispatchMouseEvent), not synthetic DOM events, so it
    // exercises Excalidraw's own drawing exactly as a mouse would.
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } })");
    await sleep(80);
    const beforeDraw = await cdp.eval('window.__harborBoardApi.getSceneElements().length');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1240, y: 640, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1320, y: 700, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1400, y: 760, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1400, y: 760, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(160);
    const drawn = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const added = api.getSceneElements().slice(${beforeDraw});
      const rect = added.find((e) => e.type === 'rectangle');
      const app = api.getAppState();
      return { added: added.length, hasRect: Boolean(rect), roughness: rect ? rect.roughness : null,
        x: rect ? Math.round(rect.x) : null, y: rect ? Math.round(rect.y) : null, w: rect ? Math.round(rect.width) : null,
        gridOn: Boolean(app.gridModeEnabled), gridSize: app.gridSize || 0 };
    })()`);
    results.push(`draw rect: added=${drawn.added} hasRect=${drawn.hasRect} roughness=${drawn.roughness} at=(${drawn.x},${drawn.y}) w=${drawn.w} gridOn=${drawn.gridOn}/${drawn.gridSize}`);
    check(drawn.hasRect, 'picking the rectangle tool and dragging on the canvas created NO rectangle');
    // Clean, not sketchy: new shapes must render with roughness 0 (Pat's "janky" report).
    check(drawn.roughness === 0, `a newly drawn rectangle has roughness ${drawn.roughness}, not the clean 0`);
    // Grid snap (Pat's request): with grid ON, an off-grid drag must land the shape on
    // gridSize multiples so shapes stay aligned and consistent. Grid was enabled above.
    check(drawn.gridOn && drawn.gridSize === 20, `grid should be on (size 20) for the snap check, saw ${drawn.gridOn}/${drawn.gridSize}`);
    check(drawn.x % drawn.gridSize === 0 && drawn.y % drawn.gridSize === 0 && drawn.w % drawn.gridSize === 0,
      `grid ON but the drawn rect did NOT snap to the grid: x=${drawn.x} y=${drawn.y} w=${drawn.w} should all be multiples of ${drawn.gridSize}`);

    // Type TEXT: activate the text tool, click the canvas, type, commit. It must land
    // the typed text with the clean default font.
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /Text/.test(b.getAttribute('aria-label'))).click()");
    await waitFor(cdp, "window.__harborBoardApi.getAppState().activeTool.type === 'text'", 'text tool active');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1300, y: 520, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1300, y: 520, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(140);
    await cdp.send('Input.insertText', { text: 'Hello' });
    await sleep(140);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(160);
    const typed = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const txt = [...els].reverse().find((e) => e.type === 'text');
      return { text: txt ? txt.text : null, font: txt ? txt.fontFamily : null, expect: window.__harborBoardApi.getAppState().currentItemFontFamily };
    })()`);
    results.push(`text: "${typed.text}" font=${typed.font} expectFont=${typed.expect}`);
    check(typed.text === 'Hello', `typed text did not commit (got "${typed.text}")`);
    check(typed.font === typed.expect, `typed text uses font ${typed.font}, not the clean default ${typed.expect}`);

    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /Select/.test(b.getAttribute('aria-label'))).click()");

    // Style bar recolors the selection: fill green, then line pink + bold width.
    await cdp.eval(`(() => {
      const target = [...window.__harborBoardApi.getSceneElements()].reverse().find((e) => e.type === 'rectangle');
      window.__harborBoardApi.__targetId = target.id;
      window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { [target.id]: true } } });
    })()`);
    // Wave C: the contextual floating card replaces the bottom style bar. Deep popover
    // coverage lives in drive-toolbar-win.js; this is the integration proof HERE.
    await waitFor(cdp, "Boolean(document.querySelector('.wb-float-bar'))", 'floating toolbar appears on selection');
    await cdp.eval("document.querySelector('.wb-float-bar [aria-label=\"Fill colour\"]').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-tb-menu [aria-label=\"Brand colors: Emerald\"]'))", 'fill popover opens');
    await cdp.eval("document.querySelector('.wb-tb-menu [aria-label=\"Brand colors: Emerald\"]').click()");
    await sleep(220);
    const styled = await cdp.eval(`(() => {
      const el = window.__harborBoardApi.getSceneElements().find((e) => e.id === window.__harborBoardApi.__targetId);
      return { bg: el.backgroundColor, fillStyle: el.fillStyle };
    })()`);
    results.push(`style fill: bg=${styled.bg} fillStyle=${styled.fillStyle}`);
    check(styled.bg === '#24b27c', `fill swatch produced ${styled.bg}, expected Emerald #24b27c`);
    check(styled.fillStyle === 'solid', `fill left a non-solid fillStyle ${styled.fillStyle}`);
    await cdp.eval("document.querySelector('.wb-float-bar [aria-label=\"Border options\"]').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-tb-menu [aria-label=\"Thickness\"]'))", 'border popover opens');
    await cdp.eval("document.querySelector('.wb-tb-menu [aria-label=\"Brand colors: Luminous\"]').click()");
    await cdp.eval("(() => { const i = document.querySelector('.wb-tb-menu [aria-label=\"Thickness\"]'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, '4'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await sleep(220);
    const styled2 = await cdp.eval(`(() => {
      const el = window.__harborBoardApi.getSceneElements().find((e) => e.id === window.__harborBoardApi.__targetId);
      return { stroke: el.strokeColor, width: el.strokeWidth };
    })()`);
    results.push(`style line: stroke=${styled2.stroke} width=${styled2.width}`);
    check(styled2.stroke === '#437ffe', `border swatch produced ${styled2.stroke}, expected Luminous #437ffe`);
    check(styled2.width === 4, `thickness slider produced strokeWidth ${styled2.width}`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(150);
    await cdp.shot('10-custom-chrome');

    // The floating card must stay inside the board and clear of the rail at the main
    // window's 960px MIN width.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    const narrow = await cdp.eval(`(() => {
      const bar = document.querySelector('.wb-float-bar');
      const canvas = document.querySelector('.whiteboard-canvas');
      const rail = document.querySelector('.wb-rail');
      const b = bar ? bar.getBoundingClientRect() : null;
      const c = canvas ? canvas.getBoundingClientRect() : null;
      const r = rail ? rail.getBoundingClientRect() : null;
      return {
        present: Boolean(bar),
        left: b ? Math.round(b.left) : null, right: b ? Math.round(b.right) : null,
        canvasLeft: c ? Math.round(c.left) : null, canvasRight: c ? Math.round(c.right) : null,
        railRight: r ? Math.round(r.right) : null,
      };
    })()`);
    results.push(`float card @960: present=${narrow.present} bar=[${narrow.left},${narrow.right}] canvas=[${narrow.canvasLeft},${narrow.canvasRight}] railRight=${narrow.railRight}`);
    check(narrow.present, 'floating card vanished at the 960px min width');
    check(narrow.left >= narrow.railRight - 1, `floating card overlaps the tool rail at 960px (card left ${narrow.left}, rail right ${narrow.railRight})`);
    check(narrow.left >= narrow.canvasLeft - 1 && narrow.right <= narrow.canvasRight + 1, `floating card spills outside the board at 960px (card [${narrow.left},${narrow.right}] vs canvas [${narrow.canvasLeft},${narrow.canvasRight}])`);
    await cdp.shot('10b-style-bar-narrow');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(120);
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })");

    // Right-drag pans the canvas (Miro-style); a plain right-click still menus.
    await cdp.eval(`(() => {
      const canvas = document.querySelector('.excalidraw canvas');
      window.__panBefore = window.__harborBoardApi.getAppState().scrollX;
      const ev = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2, pointerId: 1, pointerType: 'mouse' });
      canvas.dispatchEvent(ev('pointerdown', 820, 500));
      document.dispatchEvent(ev('pointermove', 900, 560));
      document.dispatchEvent(ev('pointermove', 1010, 640));
      document.dispatchEvent(ev('pointerup', 1010, 640));
    })()`);
    await sleep(250);
    const panned = await cdp.eval(`(() => {
      const after = window.__harborBoardApi.getAppState().scrollX;
      // the drag just happened, so this contextmenu must be suppressed...
      const menuSuppressed = !document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      // ...and the next plain right-click must let the menu through.
      const menuAllowed = document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return { before: Math.round(window.__panBefore), after: Math.round(after), menuSuppressed, menuAllowed };
    })()`);
    results.push(`pan: scrollX ${panned.before}->${panned.after} menuAfterDrag=${panned.menuSuppressed ? 'suppressed' : 'shown'} menuOnClick=${panned.menuAllowed ? 'shown' : 'suppressed'}`);
    check(Math.abs(panned.after - panned.before) > 60, `right-drag did not pan the canvas (scrollX ${panned.before} -> ${panned.after})`);
    check(panned.menuSuppressed, 'context menu was not suppressed after a right-drag pan');
    check(panned.menuAllowed, 'context menu was wrongly suppressed on a plain right-click');
    // Copy PNG now lives in the Excalidraw main menu (hamburger); its clipboard:write-image
    // IPC path is unchanged and covered by the channel manifest test + earlier drive runs.

    // Connector: drag from a shape's edge dot onto another shape to auto-link them.
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { 'drive-rectangle': true } } })");
    await waitFor(cdp, "document.querySelectorAll('.wb-connect-dot').length === 4", 'connect dots appear on selection');
    await cdp.eval(`(() => {
      const dot = document.querySelector('.wb-connect-dot');
      const r = dot.getBoundingClientRect();
      dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.top + 6, button: 0, buttons: 1, pointerId: 2, pointerType: 'mouse' }));
    })()`);
    await sleep(90); // let React attach the drag listeners
    await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const app = api.getAppState();
      const zoom = app.zoom.value || 1;
      const el = api.getSceneElements().find((e) => e.id === 'drive-ellipse');
      const tx = (el.x + el.width / 2 + app.scrollX) * zoom + (app.offsetLeft || 0);
      const ty = (el.y + el.height / 2 + app.scrollY) * zoom + (app.offsetTop || 0);
      const mk = (type, x, y) => document.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 2, pointerType: 'mouse' }));
      mk('pointermove', tx, ty);
      mk('pointerup', tx, ty);
    })()`);
    await sleep(200);
    const conn = await cdp.eval(`(() => {
      const arrows = window.__harborBoardApi.getSceneElements().filter((e) => e.type === 'arrow');
      const linked = arrows.find((a) => a.startBinding && a.startBinding.elementId === 'drive-rectangle' && a.endBinding && a.endBinding.elementId === 'drive-ellipse');
      return { arrows: arrows.length, linked: Boolean(linked) };
    })()`);
    results.push(`connector: arrows=${conn.arrows} linkedRectToEllipse=${conn.linked}`);
    check(conn.linked, 'dragging from a connect dot to another shape did not create a bound arrow');
    await cdp.shot('11-connector');

    // The connect dots must land on the shape EDGES at a zoomed-OUT level too (the
    // positioning math multiplies by zoom, so 40% is where it would be wrong).
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { zoom: { value: 0.4 } } })");
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { 'drive-ellipse': true } } })");
    await waitFor(cdp, "document.querySelectorAll('.wb-connect-dot').length === 4", 'connect dots at 40% zoom');
    const dots = await cdp.eval(`(() => {
      const api = window.__harborBoardApi; const app = api.getAppState(); const zoom = app.zoom.value;
      const el = api.getSceneElements().find((e) => e.id === 'drive-ellipse');
      const left = (el.x + app.scrollX) * zoom + (app.offsetLeft || 0);
      const top = (el.y + app.scrollY) * zoom + (app.offsetTop || 0);
      const w = el.width * zoom; const h = el.height * zoom;
      const centres = [...document.querySelectorAll('.wb-connect-dot')].map((d) => { const r = d.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
      const rightDot = centres.reduce((a, b) => (b.x > a.x ? b : a));
      const topDot = centres.reduce((a, b) => (b.y < a.y ? b : a));
      return { rightX: rightDot.x, rightY: rightDot.y, topY: topDot.y, edgeRightX: Math.round(left + w), midY: Math.round(top + h / 2), edgeTopY: Math.round(top) };
    })()`);
    // The dots sit a small gap OUTSIDE each edge (Miro's measured ~19px), never on the shape
    // body, so a click or double-click on the shape (to select or to edit its text) is never
    // eaten by a dot. So the right dot is just past the right edge, the top dot just above the
    // top edge, and each stays centred on its edge's midline.
    const GAP = 19;
    results.push(`connect dots @40%: right=(${dots.rightX},${dots.rightY}) edge x=${dots.edgeRightX} midY=${dots.midY}; topDotY=${dots.topY} edge=${dots.edgeTopY}`);
    check(dots.rightX > dots.edgeRightX && Math.abs(dots.rightX - dots.edgeRightX - GAP) <= 6, `right connect dot x=${dots.rightX} is not ~${GAP}px OUTSIDE the shape's right edge (${dots.edgeRightX}) at 40% zoom`);
    check(Math.abs(dots.rightY - dots.midY) <= 3, `right connect dot y=${dots.rightY} off the shape's vertical middle (${dots.midY}) at 40% zoom`);
    check(dots.topY < dots.edgeTopY && Math.abs(dots.edgeTopY - dots.topY - GAP) <= 6, `top connect dot y=${dots.topY} is not ~${GAP}px ABOVE the shape's top edge (${dots.edgeTopY}) at 40% zoom`);
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { zoom: { value: 1 }, selectedElementIds: {} } })");
    await sleep(80);

    // Connector style bar (Miro parity): selecting the connector shows the connector bar
    // (not the shape fill/line bar), and its controls restyle routing, dash, and heads.
    // The arrow under test is the DIAGONAL rect-to-ellipse connector this drive created:
    // "first bound arrow" used to grab a flowchart arrow between vertically ALIGNED
    // shapes, whose elbow route is legitimately a straight 2-point segment (the same
    // reason a Miro connector between aligned edges renders straight, catalog finding
    // 14), so the adds-waypoints assertion below needs an arrow with a real dogleg.
    const connArrowId = await cdp.eval("(() => { const a = window.__harborBoardApi.getSceneElements().find((e) => e.type === 'arrow' && e.startBinding && e.startBinding.elementId === 'drive-rectangle'); return a ? a.id : null; })()");
    check(Boolean(connArrowId), 'no bound connector available to test the connector style bar');
    if (connArrowId) {
      await cdp.eval(`window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { '${connArrowId}': true } } })`);
      await waitFor(cdp, "Boolean(document.querySelector('.wb-connector-bar'))", 'connector style bar appears');
      check(!(await cdp.eval("Boolean(document.querySelector('.wb-style-bar:not(.wb-connector-bar)'))")), 'the shape fill/line bar wrongly showed for a connector selection');
      // Routing and dash moved into the Miro-style Type submenu (finding 24);
      // open it before driving them.
      const openType = async () => {
        if (!(await cdp.eval("Boolean(document.querySelector('.wb-conn-type'))"))) {
          await cdp.eval("document.querySelector('.wb-connector-bar [aria-label=\"Line type\"]').click()");
          await sleep(150);
        }
      };
      await openType();
      await cdp.eval("[...document.querySelectorAll('.wb-conn-type [aria-label*=\"Elbow\"]')][0].click()");
      await sleep(160);
      const elbowPts = await cdp.eval(`window.__harborBoardApi.getSceneElements().find((e) => e.id === '${connArrowId}').points.length`);
      results.push(`connector elbow: points=${elbowPts}`);
      check(elbowPts >= 3, `elbow routing did not add waypoints (points=${elbowPts})`);
      await openType();
      await cdp.eval("[...document.querySelectorAll('.wb-conn-type [aria-label*=\"Curved\"]')][0].click()");
      await sleep(150);
      const curved = await cdp.eval(`(() => { const a = window.__harborBoardApi.getSceneElements().find((e) => e.id === '${connArrowId}'); return { n: a.points.length, r: a.roundness && a.roundness.type }; })()`);
      results.push(`connector curved: points=${curved.n} roundness=${curved.r}`);
      check(curved.n === 3 && curved.r === 2, `curved routing did not apply (points=${curved.n} roundness=${curved.r})`);
      await openType();
      await cdp.eval("[...document.querySelectorAll('.wb-conn-type [aria-label*=\"Dashed\"]')][0].click()");
      await sleep(140);
      const dash = await cdp.eval(`window.__harborBoardApi.getSceneElements().find((e) => e.id === '${connArrowId}').strokeStyle`);
      results.push(`connector dash: ${dash}`);
      check(dash === 'dashed', `dashed did not apply (strokeStyle=${dash})`);
      // Arrowheads are per-end pickers now (finding 25): set BOTH ends to the
      // open arrow through each picker.
      await cdp.eval("document.querySelector('.wb-connector-bar [aria-label=\"Start arrowhead\"]').click()");
      await sleep(150);
      await cdp.eval("document.querySelector('.wb-conn-heads [aria-label=\"Open arrow\"]').click()");
      await sleep(140);
      await cdp.eval("document.querySelector('.wb-connector-bar [aria-label=\"End arrowhead\"]').click()");
      await sleep(150);
      await cdp.eval("document.querySelector('.wb-conn-heads [aria-label=\"Open arrow\"]').click()");
      await sleep(140);
      const heads = await cdp.eval(`(() => { const a = window.__harborBoardApi.getSceneElements().find((e) => e.id === '${connArrowId}'); return { s: a.startArrowhead, e: a.endArrowhead }; })()`);
      results.push(`connector heads: start=${heads.s} end=${heads.e}`);
      check(heads.s === 'arrow' && heads.e === 'arrow', `both-ends arrowheads did not apply (start=${heads.s} end=${heads.e})`);
      await cdp.shot('17-connector-bar');
    }
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })");
    await sleep(80);

    // Universal hover dots: hovering an UNSELECTED shape (selection tool, no button held)
    // reveals its four connect dots, so a connector can be dragged from any shape (Miro).
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} } })");
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /Select/.test(b.getAttribute('aria-label') || '')).click()");
    await sleep(100);
    const hoverPos = await cdp.eval("(() => { const api = window.__harborBoardApi; const app = api.getAppState(); const z = app.zoom.value; const el = api.getSceneElements().find((e) => e.id === 'drive-rectangle'); return { cx: Math.round((el.x + el.width/2 + app.scrollX) * z + (app.offsetLeft||0)), cy: Math.round((el.y + el.height/2 + app.scrollY) * z + (app.offsetTop||0)) }; })()");
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverPos.cx, y: hoverPos.cy, button: 'none', buttons: 0 });
    await sleep(350);
    const hoverDots = await cdp.eval("document.querySelectorAll('.wb-connect-dot').length");
    results.push(`hover dots on an unselected shape: ${hoverDots}`);
    check(hoverDots === 4, `hovering an unselected shape did not reveal 4 connect dots (saw ${hoverDots})`);
    // Move off the shape: the dots retract.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverPos.cx + 600, y: hoverPos.cy - 300, button: 'none', buttons: 0 });
    await sleep(300);
    const dotsAway = await cdp.eval("document.querySelectorAll('.wb-connect-dot').length");
    results.push(`hover dots after moving off: ${dotsAway}`);
    check(dotsAway === 0, `connect dots did not retract after moving off the shape (saw ${dotsAway})`);

    // Regression guard for Pat's report: the connect dots must FOLLOW a shape being
    // dragged, not lag at its old spot. Select, press-and-move (mid-drag), and confirm the
    // 4-dot centroid still sits on the shape's (moved) centre while the button is held.
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: { 'drive-rectangle': true } } })");
    await sleep(120);
    const dragStart = await cdp.eval("(() => { const api = window.__harborBoardApi; const app = api.getAppState(); const z = app.zoom.value; const el = api.getSceneElements().find((e) => e.id === 'drive-rectangle'); return { cx: Math.round((el.x + el.width/2 + app.scrollX) * z + (app.offsetLeft||0)), cy: Math.round((el.y + el.height/2 + app.scrollY) * z + (app.offsetTop||0)) }; })()");
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragStart.cx, y: dragStart.cy, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragStart.cx + 120, y: dragStart.cy + 90, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragStart.cx + 240, y: dragStart.cy + 180, button: 'left', buttons: 1 });
    await sleep(140);
    const midDrag = await cdp.eval(`(() => {
      const api = window.__harborBoardApi; const app = api.getAppState(); const z = app.zoom.value;
      const el = api.getSceneElements().find((e) => e.id === 'drive-rectangle');
      const shapeCx = (el.x + el.width/2 + app.scrollX) * z + (app.offsetLeft||0);
      const shapeCy = (el.y + el.height/2 + app.scrollY) * z + (app.offsetTop||0);
      const dots = [...document.querySelectorAll('.wb-connect-dot')].map((d) => { const r = d.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; });
      if (dots.length !== 4) return { dots: dots.length };
      const cx = dots.reduce((s, d) => s + d.x, 0) / 4;
      const cy = dots.reduce((s, d) => s + d.y, 0) / 4;
      return { dots: 4, gap: Math.round(Math.hypot(cx - shapeCx, cy - shapeCy)) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragStart.cx + 240, y: dragStart.cy + 180, button: 'left', buttons: 0, clickCount: 1 });
    results.push(`dots track a drag: dots=${midDrag.dots} centreGap=${midDrag.gap}`);
    check(midDrag.dots === 4, `dots vanished mid-drag (saw ${midDrag.dots})`);
    check(midDrag.gap !== undefined && midDrag.gap <= 14, `connect dots LAG behind a dragged shape (their centre is ${midDrag.gap}px off the shape's centre)`);
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })");
    await sleep(80);

    // Eraser + undo, driven the way a user does it: DRAW a rectangle (so it enters
    // Excalidraw's history), erase it with the eraser tool, then click Undo to restore.
    // (An element added via updateScene has no create-checkpoint, so undo could not
    // bring it back; drawing it first is the honest path.)
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: -2400, scrollY: -1600, zoom: { value: 1 }, selectedElementIds: {} } })");
    await sleep(80);
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => b.getAttribute('aria-label') === 'Shapes').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-flyout-shapes'))", 'shapes flyout for eraser test');
    await cdp.eval("[...document.querySelectorAll('.wb-flyout-shapes .wb-rail-btn')].find((b) => /Rectangle/.test(b.getAttribute('aria-label'))).click()");
    await waitFor(cdp, "window.__harborBoardApi.getAppState().activeTool.type === 'rectangle'", 'rect tool for eraser test');
    const eraseDrawBefore = await cdp.eval('window.__harborBoardApi.getSceneElements().length');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 780, y: 560, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 860, y: 620, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 660, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 900, y: 660, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(180);
    const eraseTarget = await cdp.eval(`(() => {
      const api = window.__harborBoardApi; const app = api.getAppState(); const z = app.zoom.value;
      const el = api.getSceneElements().slice(${eraseDrawBefore}).find((e) => e.type === 'rectangle');
      if (!el) return null;
      window.__eraseId = el.id;
      return { id: el.id,
        x: Math.round((el.x + app.scrollX) * z + (app.offsetLeft || 0)), y: Math.round((el.y + app.scrollY) * z + (app.offsetTop || 0)),
        cx: Math.round((el.x + el.width / 2 + app.scrollX) * z + (app.offsetLeft || 0)), cy: Math.round((el.y + el.height / 2 + app.scrollY) * z + (app.offsetTop || 0)) };
    })()`);
    results.push(`erase target drawn: ${eraseTarget ? eraseTarget.id : 'NONE'}`);
    check(Boolean(eraseTarget), 'could not draw a rectangle for the eraser test');
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /Eraser/.test(b.getAttribute('aria-label') || '')).click()");
    await waitFor(cdp, "window.__harborBoardApi.getAppState().activeTool.type === 'eraser'", 'eraser tool active');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: eraseTarget.x + 4, y: eraseTarget.y + 4, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: eraseTarget.cx, y: eraseTarget.cy, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: eraseTarget.cx, y: eraseTarget.cy, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(180);
    const erased = await cdp.eval("Boolean(window.__harborBoardApi.getSceneElements().find((e) => e.id === window.__eraseId))");
    results.push(`eraser: element still present after erase drag = ${erased}`);
    check(!erased, 'the eraser tool did not delete the element it was dragged across');
    // Undo restores it via the visible Undo control in the footer (the button a user clicks).
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /Select/.test(b.getAttribute('aria-label') || '')).click()");
    const undoClicked = await cdp.eval("(() => { const b = [...document.querySelectorAll('.excalidraw button')].find((x) => /undo/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.title||''))); if (b) { b.click(); return true; } return false; })()");
    await sleep(260);
    const undone = await cdp.eval("Boolean(window.__harborBoardApi.getSceneElements().find((e) => e.id === window.__eraseId))");
    results.push(`undo control found=${undoClicked} restored erased element=${undone}`);
    check(undoClicked, 'no visible Undo control was found in the board footer');
    check(undone, 'the Undo control did not restore the erased element');
    // Remove the test rectangle and restore the viewport for later tests.
    await cdp.eval("window.__harborBoardApi.updateScene({ elements: window.__harborBoardApi.getSceneElements().filter((e) => e.id !== window.__eraseId), appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} } })");
    await sleep(80);

    // Exploratory sweep: open the Library panel and the right-click context menu, and
    // capture them for a human read. The panel slides from the right and must not cover
    // the LEFT tool rail; the context menu must be readable and not clipped behind chrome.
    await cdp.eval("(() => { const b = [...document.querySelectorAll('.excalidraw button')].find((x) => /library/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.title||''))); if (b) b.click(); return Boolean(b); })()");
    await sleep(450);
    await cdp.shot('15-library-open');
    const lib = await cdp.eval(`(() => {
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), right: Math.round(r.right) }; };
      const panel = document.querySelector('.excalidraw .layer-ui__sidebar') || document.querySelector('.excalidraw .sidebar') || document.querySelector('.excalidraw [class*="sidebar"]');
      const rail = rect(document.querySelector('.wb-rail'));
      const p = rect(panel);
      return { panel: p, rail, coversRail: (p && rail) ? p.x < rail.right : null };
    })()`);
    results.push(`library panel: panel=${lib.panel ? '[' + lib.panel.x + ',' + lib.panel.right + ']' : 'none'} rail=${lib.rail ? '[' + lib.rail.x + ',' + lib.rail.right + ']' : 'none'} coversRail=${lib.coversRail}`);
    if (lib.panel && lib.coversRail !== null) check(!lib.coversRail, `the Library panel covers the tool rail (panel x ${lib.panel.x}, rail right ${lib.rail && lib.rail.right})`);
    await cdp.eval("(() => { const b = [...document.querySelectorAll('.excalidraw button')].find((x) => /library/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.title||''))); if (b) b.click(); })()");
    await sleep(200);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 900, y: 480, button: 'right', buttons: 2, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 900, y: 480, button: 'right', buttons: 2, clickCount: 1 });
    await sleep(300);
    await cdp.shot('16-context-menu');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(120);

    // Label a sticky by DOUBLE-CLICKING it (the core annotate gesture). Arm, place one on
    // the canvas, disarm, then double-click the placed note and type. The bound text must
    // land and be readable (dark) on the bright note.
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} } })");
    await cdp.eval("document.querySelector('.wb-rail .wb-rail-btn.accent').click()"); // arm
    await waitFor(cdp, "Boolean(document.querySelector('.wb-flyout-swatches'))", 'sticky flyout for label test');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 950, y: 560, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 950, y: 560, button: 'left', buttons: 0, clickCount: 1 });
    // Wave B: the placement itself enters text edit and auto-disarms. Escape OUT of the
    // auto edit so the DOUBLE-CLICK gesture below is what binds the label.
    await waitFor(cdp, "Boolean(document.querySelector('.excalidraw textarea'))", 'label-test sticky entered its auto edit');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(250);
    const stickyPos = await cdp.eval(`(() => {
      const api = window.__harborBoardApi; const app = api.getAppState(); const zoom = app.zoom.value;
      const el = api.getSceneElements().filter((e) => e.customData && e.customData.sticky).slice(-1)[0];
      window.__stickyId = el.id;
      return { cx: Math.round((el.x + el.width / 2 + app.scrollX) * zoom + (app.offsetLeft || 0)), cy: Math.round((el.y + el.height / 2 + app.scrollY) * zoom + (app.offsetTop || 0)) };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: stickyPos.cx, y: stickyPos.cy, button: 'left', buttons: 1, clickCount: 2 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stickyPos.cx, y: stickyPos.cy, button: 'left', buttons: 0, clickCount: 2 });
    await sleep(180);
    await cdp.send('Input.insertText', { text: 'Note' });
    await sleep(140);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(160);
    const labelled = await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const sticky = api.getSceneElements().find((e) => e.id === window.__stickyId);
      const bound = sticky && sticky.boundElements ? sticky.boundElements.find((b) => b.type === 'text') : null;
      const text = bound ? api.getSceneElements().find((e) => e.id === bound.id) : null;
      return { hasText: Boolean(text), content: text ? text.text : null, color: text ? text.strokeColor : null };
    })()`);
    const sum = labelled.color && /^#[0-9a-f]{6}$/i.test(labelled.color)
      ? parseInt(labelled.color.slice(1, 3), 16) + parseInt(labelled.color.slice(3, 5), 16) + parseInt(labelled.color.slice(5, 7), 16)
      : 999;
    results.push(`sticky label: hasText=${labelled.hasText} content="${labelled.content}" color=${labelled.color}`);
    check(labelled.hasText && labelled.content === 'Note', `double-click sticky did not bind the typed label (got "${labelled.content}")`);
    check(sum < 300, `sticky label colour ${labelled.color} is not dark/readable on a bright note`);
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })");

    // Full screen: rail + titlebar collapse and the board fills the window.
    await cdp.eval("document.querySelector('.whiteboard-fs').click()");
    await waitFor(cdp, "document.body.hasAttribute('data-board-fullscreen')", 'entered full screen');
    const fsInfo = await cdp.eval(`(() => {
      const rail = document.querySelector('.rail');
      const title = document.querySelector('.titlebar');
      const view = document.querySelector('.whiteboard-view');
      return {
        railHidden: !rail || getComputedStyle(rail).display === 'none',
        titleHidden: !title || getComputedStyle(title).display === 'none',
        margin: getComputedStyle(view).marginTop,
        canvasW: Math.round(document.querySelector('.whiteboard-canvas').getBoundingClientRect().width),
      };
    })()`);
    results.push(`fullscreen: railHidden=${fsInfo.railHidden} titleHidden=${fsInfo.titleHidden} margin=${fsInfo.margin} canvasW=${fsInfo.canvasW}`);
    check(fsInfo.railHidden, 'rail did not hide in full screen');
    check(fsInfo.titleHidden, 'title bar did not hide in full screen');
    check(fsInfo.margin === '0px', `board keeps margin ${fsInfo.margin} in full screen`);
    check(fsInfo.canvasW > 1400, `canvas only ${fsInfo.canvasW}px wide in full screen, did not fill`);
    await cdp.shot('9-fullscreen');
    // Exit so the rail measurements below still have a rail to measure.
    await cdp.eval("document.querySelector('.whiteboard-fs').click()");
    await waitFor(cdp, "!document.body.hasAttribute('data-board-fullscreen')", 'exited full screen');
    check(await cdp.eval("getComputedStyle(document.querySelector('.rail')).display !== 'none'"), 'rail did not return after exiting full screen');

    for (const width of [292, 268, 228, 190]) {
      const measured = await cdp.eval(`(() => {
        const rail = document.querySelector('.rail');
        rail.style.setProperty('--rail-width', '${width}px');
        const row = document.querySelector('.view-switch');
        const buttons = [...row.querySelectorAll('.view-switch-btn')];
        const lines = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
        return new Promise((resolve) => requestAnimationFrame(() => resolve({
          rail: Math.round(rail.getBoundingClientRect().width),
          client: row.clientWidth,
          scroll: row.scrollWidth,
          rows: lines.size,
          labels: buttons.map((button) => ({ text: button.textContent.trim(), width: Math.round(button.getBoundingClientRect().width), clipped: button.scrollWidth > button.clientWidth + 1 })),
        })));
      })()`);
      results.push(`tabs ${width}px: rail=${measured.rail} client=${measured.client} scroll=${measured.scroll} rows=${measured.rows} labels=${JSON.stringify(measured.labels)}`);
      check(measured.rail === width, `rail measured ${measured.rail}px at requested ${width}px`);
      check(measured.scroll <= measured.client + 1, `tabs overflow at ${width}px`);
      check(measured.labels.every((label) => !label.clipped), `a tab label clipped at ${width}px`);
    }

    // Multi-window: pop the board into its own OS window (offscreen under E2E) and
    // verify that window renders ONLY the board, not the full app shell. The
    // pop-out bridge (win.openBoard) rides a different branch than the connector
    // work; on a checkout that does not carry it this spec SKIPS loudly instead
    // of crashing the whole drive, and it runs in full wherever the bridge exists.
    const hasOpenBoard = await cdp.eval("typeof (window.harbor.win && window.harbor.win.openBoard) === 'function'");
    let boardTarget;
    if (!hasOpenBoard) {
      results.push('SKIP pop-out spec: window.harbor.win.openBoard is not on this branch');
    } else {
      await cdp.eval('window.harbor.win.openBoard()');
      for (let i = 0; i < 30 && !boardTarget; i += 1) {
        await sleep(300);
        try {
          const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json());
          boardTarget = targets.find((item) => item.type === 'page' && /window=board/.test(item.url));
        } catch {}
      }
      check(Boolean(boardTarget), 'the popped-out board window never appeared');
    }
    if (boardTarget) {
      const ws2 = await new Promise((resolve, reject) => {
        const socket = new WebSocket(boardTarget.webSocketDebuggerUrl);
        socket.addEventListener('open', () => resolve(socket));
        socket.addEventListener('error', reject);
      });
      const cdp2 = new Cdp(ws2);
      await cdp2.send('Runtime.enable');
      await cdp2.send('Page.enable');
      await waitFor(cdp2, "Boolean(document.querySelector('.board-window .whiteboard-view .excalidraw canvas'))", 'board window renders the whiteboard', 20000);
      const bw = await cdp2.eval(`(() => {
        const rail = document.querySelector('.wb-rail');
        const zoom = document.querySelector('.excalidraw .App-menu_bottom') || document.querySelector('.excalidraw [class*="zoom-actions"]');
        const railRect = rail ? rail.getBoundingClientRect() : null;
        const zoomRect = zoom ? zoom.getBoundingClientRect() : null;
        return {
          boardWindow: Boolean(document.querySelector('.board-window')),
          appShell: Boolean(document.querySelector('.app-shell')),
          rail: Boolean(rail),
          popout: Boolean([...document.querySelectorAll('.whiteboard-fs, .whiteboard-popout')].find((b) => b.textContent === 'Pop out')),
          railBottom: railRect ? Math.round(railRect.bottom) : null,
          railBtns: document.querySelectorAll('.wb-rail > .wb-rail-btn, .wb-rail > .wb-rail-host').length,
          zoomTop: zoomRect ? Math.round(zoomRect.top) : null,
          winH: window.innerHeight,
        };
      })()`);
      results.push(`board window: boardWindow=${bw.boardWindow} appShell=${bw.appShell} rail=${bw.rail} popoutHidden=${!bw.popout} railBottom=${bw.railBottom} zoomTop=${bw.zoomTop} winH=${bw.winH}`);
      check(bw.boardWindow, 'board window did not render the .board-window container');
      check(!bw.appShell, 'board window wrongly rendered the full app shell');
      check(bw.rail, 'board window did not render the whiteboard tool rail');
      check(!bw.popout, 'board window should hide its own Pop out button');
      // The rail must clear Excalidraw's bottom-left zoom controls (the reported bug).
      const railClears = (bw.railBottom !== null && bw.zoomTop !== null)
        ? bw.railBottom <= bw.zoomTop
        : (bw.railBottom !== null && bw.railBottom < bw.winH - 52);
      check(railClears, `tool rail (bottom ${bw.railBottom}) overlaps the zoom controls (top ${bw.zoomTop}, winH ${bw.winH}) in the board window`);
      await cdp2.shot('12-board-window');

      // The pop-out's real narrow case: resize to its 640px MIN, select a shape, and
      // confirm the floating card stays fully inside the small window.
      await cdp2.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 720, deviceScaleFactor: 1, mobile: false });
      await waitFor(cdp2, 'Boolean(window.__harborBoardApi)', 'board window API ready', 10000);
      await cdp2.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { 'drive-rectangle': true } } })");
      await waitFor(cdp2, "Boolean(document.querySelector('.wb-float-bar'))", 'floating card in the pop-out', 8000);
      const bwStyle = await cdp2.eval(`(() => {
        const bar = document.querySelector('.wb-float-bar');
        const b = bar.getBoundingClientRect();
        return { left: Math.round(b.left), right: Math.round(b.right), win: window.innerWidth };
      })()`);
      results.push(`pop-out float card @640: bar=[${bwStyle.left},${bwStyle.right}] win=${bwStyle.win}`);
      check(bwStyle.left >= 0 && bwStyle.right <= bwStyle.win, `pop-out floating card spills at 640px (card [${bwStyle.left},${bwStyle.right}] win ${bwStyle.win})`);
      await cdp2.shot('13-popout-narrow');
      ws2.close();
    }

    // --- Regression: shapes palette, drag-to-draw polys, text-in-shape, arrow finish hint,
    //     offset connect dots, zoom-to-fit. Driven on the MAIN window with real input on a
    //     fresh board (Pat's report: "3 fucking shapes", the arrow "just kept going", and
    //     "no way to edit text in a shape"). ---
    const press = (x, y, type, clickCount = 1, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: buttons ?? (type === 'mousePressed' ? 1 : 0), clickCount });
    const moveTo = (x, y, buttons = 0) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons });
    const dragOut = async (x0, y0, x1, y1) => { await moveTo(x0, y0); await press(x0, y0, 'mousePressed'); await moveTo((x0 + x1) / 2, (y0 + y1) / 2, 1); await moveTo(x1, y1, 1); await press(x1, y1, 'mouseReleased'); };
    const dbl = async (x, y) => { await moveTo(x, y); await press(x, y, 'mousePressed', 1); await press(x, y, 'mouseReleased', 1); await press(x, y, 'mousePressed', 2); await press(x, y, 'mouseReleased', 2); };
    const esc = () => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }).then(() => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }));

    await cdp.eval("[...document.querySelectorAll('.view-switch-btn')].find((b) => b.textContent.trim() === 'Board').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.excalidraw canvas') && window.__harborBoardApi)", 'board canvas for shape regression');
    await cdp.eval("document.querySelector('.whiteboard-new').click()");
    await sleep(400);
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } })");
    await sleep(120);

    // The shapes flyout is a SECTIONED panel (Wave D, Miro finding 36): one labelled
    // block per group, each block a 4-column grid, 14+ shapes in total.
    await cdp.eval("[...document.querySelectorAll('.wb-rail .wb-rail-btn')].find((b) => /Shapes/.test(b.getAttribute('aria-label') || '')).click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-flyout-shapes'))", 'shapes flyout');
    const shapeN = await cdp.eval("document.querySelectorAll('.wb-flyout-shapes .wb-rail-btn').length");
    const flyCols = await cdp.eval("getComputedStyle(document.querySelector('.wb-flyout-shapes .wb-shape-grid')).gridTemplateColumns.split(' ').length");
    const flyGroups = await cdp.eval("document.querySelectorAll('.wb-flyout-shapes .wb-shape-group-label').length");
    results.push(`shapes palette: count=${shapeN} cols=${flyCols} groups=${flyGroups}`);
    check(shapeN >= 14, `shapes palette has only ${shapeN} shapes`);
    check(flyCols === 4, `shapes grid is not 4 columns (${flyCols})`);
    check(flyGroups >= 2, `shapes flyout is not sectioned (${flyGroups} labelled groups)`);

    // Arm a triangle, drag it out at size: a closed filled `line` marked as a SHAPE.
    await cdp.eval("[...document.querySelectorAll('.wb-flyout-shapes .wb-rail-btn')].find((b) => /^Triangle/.test(b.getAttribute('aria-label') || '')).click()");
    await sleep(120);
    check(await cdp.eval("document.body.classList.contains('wb-placing-shape')"), 'arming a poly shape did not set placement mode');
    const beforeShape = await cdp.eval('window.__harborBoardApi.getSceneElements().length');
    await dragOut(520, 300, 700, 470);
    await waitFor(cdp, `window.__harborBoardApi.getSceneElements().length === ${beforeShape + 1}`, 'triangle drawn at drag size');
    const poly = await cdp.eval("(() => { const e = window.__harborBoardApi.getSceneElements().slice(-1)[0]; return { type: e.type, w: Math.round(e.width), poly: Boolean(e.customData && e.customData.polyShape), bg: e.backgroundColor }; })()");
    results.push(`poly shape: type=${poly.type} w=${poly.w} polyShape=${poly.poly} bg=${poly.bg}`);
    check(poly.type === 'line' && poly.poly && poly.w >= 150 && poly.w <= 190, `triangle drew wrong: ${JSON.stringify(poly)}`);
    check(!(await cdp.eval("document.body.classList.contains('wb-placing-shape')")), 'shape tool did not disarm after one draw');
    // A drawn poly offers the SHAPE card (Fill control), never the connector card
    // (the polyShape customData mark is the thing under test), and recolours.
    await sleep(250);
    const shapeBar = await cdp.eval("({ connector: Boolean(document.querySelector('.wb-float-bar.wb-connector-bar')), fill: Boolean(document.querySelector('.wb-float-bar [aria-label=\"Fill colour\"]')) })");
    check(!shapeBar.connector && shapeBar.fill, `a drawn shape showed the wrong card (connector=${shapeBar.connector} fill=${shapeBar.fill})`);
    const bgBefore = await cdp.eval('window.__harborBoardApi.getSceneElements().slice(-1)[0].backgroundColor');
    await cdp.eval("document.querySelector('.wb-float-bar [aria-label=\"Fill colour\"]').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-tb-menu [aria-label=\"All colors: Yellow\"]'))", 'fill popover for the drawn poly');
    await cdp.eval("document.querySelector('.wb-tb-menu [aria-label=\"All colors: Yellow\"]').click()");
    await sleep(200);
    const bgAfter = await cdp.eval('window.__harborBoardApi.getSceneElements().slice(-1)[0].backgroundColor');
    check(bgBefore !== bgAfter && bgAfter === '#ffdc4a', `fill swatch did not recolour the shape (was ${bgBefore}, now ${bgAfter})`);
    await esc();
    await sleep(150);
    await cdp.shot('18-shapes-palette');

    // Text-in-shape: a native rectangle's connect dots sit OUTSIDE its body (never eating the
    // click), and double-clicking the body opens the text editor and binds the text.
    await esc();
    await cdp.eval("window.__harborBoardApi.setActiveTool({ type: 'rectangle' })");
    await sleep(80);
    await dragOut(520, 600, 760, 740);
    await sleep(150);
    await cdp.eval("window.__harborBoardApi.setActiveTool({ type: 'selection' })");
    await sleep(80);
    const rbox = await cdp.eval("(() => { const app = window.__harborBoardApi.getAppState(); const e = window.__harborBoardApi.getSceneElements().find((x) => x.type === 'rectangle'); const z = app.zoom.value; const left = (e.x + app.scrollX) * z + (app.offsetLeft || 0); const top = (e.y + app.scrollY) * z + (app.offsetTop || 0); return { left: Math.round(left), top: Math.round(top), right: Math.round(left + e.width * z), bottom: Math.round(top + e.height * z), cx: Math.round(left + e.width * z / 2), cy: Math.round(top + e.height * z / 2) }; })()");
    await moveTo(rbox.cx, rbox.cy); await press(rbox.cx, rbox.cy, 'mousePressed'); await press(rbox.cx, rbox.cy, 'mouseReleased'); // select
    await moveTo(rbox.cx, rbox.cy); await sleep(200); // hover raises dots
    const rectDots = await cdp.eval("[...document.querySelectorAll('.wb-connect-dot')].map((d) => { const r = d.getBoundingClientRect(); return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }; })");
    const onBody = rectDots.filter((d) => d.cx > rbox.left + 2 && d.cx < rbox.right - 2 && d.cy > rbox.top + 2 && d.cy < rbox.bottom - 2);
    results.push(`connect dots: count=${rectDots.length} onBody=${onBody.length}`);
    check(rectDots.length === 4, `expected 4 connect dots, saw ${rectDots.length}`);
    check(onBody.length === 0, `a connect dot sits on the shape body and would eat clicks: ${JSON.stringify(onBody)}`);
    await dbl(rbox.cx, rbox.cy);
    await sleep(250);
    check(await cdp.eval("Boolean(document.querySelector('.excalidraw textarea'))"), 'double-click a shape did not open its text editor');
    await cdp.send('Input.insertText', { text: 'Inside' });
    await sleep(150);
    await esc();
    await sleep(200);
    const shapeText = await cdp.eval("(() => { const els = window.__harborBoardApi.getSceneElements(); const r = els.find((e) => e.type === 'rectangle'); const t = els.find((e) => e.type === 'text' && e.containerId === (r && r.id)); return t && t.text; })()");
    check(shapeText === 'Inside', `text did not bind into the shape (got ${JSON.stringify(shapeText)})`);
    await cdp.shot('19-text-in-shape');

    // The arrow "never ends": a multi-point line raises the finish hint; Escape finishes it.
    await cdp.eval("window.__harborBoardApi.setActiveTool({ type: 'arrow' })");
    await sleep(80);
    await moveTo(950, 300); await press(950, 300, 'mousePressed'); await press(950, 300, 'mouseReleased');
    await sleep(100);
    await moveTo(1100, 360); await press(1100, 360, 'mousePressed'); await press(1100, 360, 'mouseReleased');
    await sleep(150);
    const hint = await cdp.eval("(() => { const h = document.querySelector('.wb-hint'); return { shown: !!h, text: h && h.textContent }; })()");
    results.push(`arrow multi-point hint: ${JSON.stringify(hint)}`);
    check(hint.shown && /finish/i.test(hint.text || ''), `no finish hint while placing a multi-point line: ${JSON.stringify(hint)}`);
    await cdp.shot('20-arrow-hint');
    await esc();
    await sleep(150);
    check(!(await cdp.eval("Boolean(document.querySelector('.wb-hint'))")), 'the finish hint did not clear after Escape');

    // Zoom-to-fit control exists.
    check(await cdp.eval("Boolean([...document.querySelectorAll('.wb-rail .wb-rail-btn')].find((b) => /Fit board/i.test(b.getAttribute('aria-label') || '')))"), 'no zoom-to-fit control in the rail');

    // --- Tables (Miro parity): drop a 3x3, type into a cell, grow and shrink it ---
    // Run on the CURRENT board (no new-board churn: the table checks filter by
    // customData.table, so any other elements present are irrelevant).
    await esc();
    await cdp.eval("window.__harborBoardApi.setActiveTool({ type: 'selection' })");
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} } })");
    await sleep(120);
    await cdp.eval("[...document.querySelectorAll('.wb-rail .wb-rail-btn')].find((b) => /^Table$/.test(b.getAttribute('aria-label') || '')).click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-rail-flyout'))", 'table size flyout');
    await cdp.eval("[...document.querySelectorAll('.wb-rail-flyout .wb-template-item')].find((b) => /3 x 3/.test(b.textContent)).click()");
    await sleep(300);
    const table = await cdp.eval("(() => { const cells = window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.table); const tid = cells[0] && cells[0].customData.table.id; return { cells: cells.length, tid: Boolean(tid), oneId: cells.every((c) => c.customData.table.id === tid), rects: cells.every((c) => c.type === 'rectangle') }; })()");
    results.push(`table: cells=${table.cells} oneId=${table.oneId} customDataSurvived=${table.tid}`);
    check(table.cells === 9 && table.oneId && table.rects && table.tid, `3x3 table wrong: ${JSON.stringify(table)}`);
    // Double-click a cell binds text (the same edit-in-shape gesture).
    const cpos = await cdp.eval("(() => { const app = window.__harborBoardApi.getAppState(); const c = window.__harborBoardApi.getSceneElements().find((e) => e.customData && e.customData.table && e.customData.table.r === 1 && e.customData.table.c === 1); const z = app.zoom.value; return { x: Math.round((c.x + c.width / 2 + app.scrollX) * z + (app.offsetLeft || 0)), y: Math.round((c.y + c.height / 2 + app.scrollY) * z + (app.offsetTop || 0)), id: c.id }; })()");
    await dbl(cpos.x, cpos.y);
    await sleep(250);
    check(await cdp.eval("Boolean(document.querySelector('.excalidraw textarea'))"), 'double-click a table cell did not open its editor');
    await cdp.send('Input.insertText', { text: 'Cell' });
    await sleep(150);
    await esc();
    await sleep(200);
    check(await cdp.eval(`(() => { const t = window.__harborBoardApi.getSceneElements().find((e) => e.type === 'text' && e.containerId === '${cpos.id}'); return t && t.text; })() === 'Cell'`), 'typed text did not bind into the table cell');
    // Select a cell: the +/- row/column controls appear and mutate the grid.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cpos.x, y: cpos.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cpos.x, y: cpos.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cpos.x, y: cpos.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
    const tcount = () => cdp.eval("window.__harborBoardApi.getSceneElements().filter((e) => e.customData && e.customData.table && !e.isDeleted).length");
    const ctlButtons = await cdp.eval("[...document.querySelectorAll('.wb-table-seg button')].map((b) => b.textContent)");
    results.push(`table controls: ${JSON.stringify(ctlButtons)}`);
    check(ctlButtons.length === 4, `table row/column controls did not appear on a selected cell (saw ${JSON.stringify(ctlButtons)})`);
    const clickCtl = async (pred, label) => {
      const r = await cdp.eval(`(() => { const b = [...document.querySelectorAll('.wb-table-seg button')].find((x) => ${pred}); if (b) { b.click(); return true; } return [...document.querySelectorAll('.wb-table-seg button')].map((x) => x.textContent); })()`);
      check(r === true, `table control ${label} not found; buttons=${JSON.stringify(r)}`);
    };
    await clickCtl("/Col/.test(x.textContent) && x.textContent.includes('+')", '+Col');
    await sleep(250);
    check(await tcount() === 12, `add column did not grow the table to 12 cells (saw ${await tcount()})`);
    await clickCtl("/Row/.test(x.textContent) && /\\u2212/.test(x.textContent)", '-Row');
    await sleep(250);
    // 3x3 (9) -> +Col (3 rows x 4 cols = 12) -> -Row (2 rows x 4 cols = 8)
    check(await tcount() === 8, `remove row did not shrink the table to 8 (saw ${await tcount()})`);
    results.push('table grow/shrink: 9 -> +Col 12 -> -Row 8');
    await cdp.shot('21-table');

    // --- Custom colour, eyedropper, pre-draw colour, and the connect-dot keep-alive corridor.
    // Pat's ask: pick ANY colour for shapes/pen/text/connectors, sample a colour from a dropped
    // image, and reuse it; plus the reported dots-vanish-in-the-gap bug. ---
    await cdp.eval("localStorage.removeItem('harbor-board-colors')");
    await cdp.eval("window.__harborBoardApi.setActiveTool({ type: 'selection' })");
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} } })");
    await sleep(120);
    // Self-contained fixtures on the CURRENT board (an earlier section opened a fresh board, so
    // the originally-seeded drive-image/arrow are not here): a target, a known-fill source, an
    // arrow (for the connector bar), and a data-URL image (for image sampling / taint proof).
    const mkRect = (id, x, y, w, h, color) => `{ id: '${id}', type: 'rectangle', x: ${x}, y: ${y}, width: ${w}, height: ${h}, angle: 0, strokeColor: '${color}', backgroundColor: '${color}', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: ${x + y}, version: 1, versionNonce: ${x + 1}, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false }`;
    await cdp.eval(`(() => {
      const api = window.__harborBoardApi;
      const arrow = { id: 'cc-arrow', type: 'arrow', x: 250, y: 420, width: 160, height: 80, angle: 0, points: [[0, 0], [160, 80]], strokeColor: '#868e96', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 5, version: 1, versionNonce: 5, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow' };
      const image = { id: 'cc-image', type: 'image', x: 720, y: 430, width: 96, height: 96, angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 7, version: 1, versionNonce: 7, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, fileId: 'cc-image-file', status: 'saved', scale: [1, 1], crop: null };
      api.addFiles([{ id: 'cc-image-file', dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lM3Z7wAAAABJRU5ErkJggg==', mimeType: 'image/png', created: Date.now(), lastRetrieved: Date.now() }]);
      api.updateScene({ elements: [...api.getSceneElements(), ${mkRect('cc-target', 200, 200, 200, 140, '#adb5bd')}, ${mkRect('ed-source', 720, 200, 200, 160, '#abcdef')}, arrow, image] });
    })()`);
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { 'cc-target': true } } })");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-float-bar'))", 'floating card for custom colour');

    // Custom colour by TYPING a hex into the popover (reached through the Fill popover).
    await cdp.eval("document.querySelector('.wb-float-bar [aria-label=\"Fill colour\"]').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-tb-menu .wb-swatch-custom'))", 'fill palette with the custom + button');
    await cdp.eval("document.querySelector('.wb-tb-menu .wb-swatch-custom').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-color-pop'))", 'custom colour popover opens');
    const setInput = (sel, val, enter) => `(() => { const i = document.querySelector('${sel}'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, '${val}'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); ${enter ? "i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));" : ''} })()`;
    await cdp.eval(setInput('.wb-color-hex', '123456', true));
    await sleep(150);
    const hexApplied = await cdp.eval("window.__harborBoardApi.getSceneElements().find((e) => e.id === 'cc-target').backgroundColor");
    results.push(`custom hex fill: ${hexApplied}`);
    check(hexApplied === '#123456', `typing a custom hex did not set the shape fill (got ${hexApplied})`);
    // The native colour wheel applies live too.
    await cdp.eval(setInput('.wb-color-wheel input[type=color]', '#00ff88', false));
    await sleep(120);
    const wheelApplied = await cdp.eval("window.__harborBoardApi.getSceneElements().find((e) => e.id === 'cc-target').backgroundColor");
    results.push(`custom wheel fill: ${wheelApplied}`);
    check(wheelApplied === '#00ff88', `the colour wheel did not set the shape fill (got ${wheelApplied})`);
    // Both are remembered for reuse, most-recent first.
    const recents = await cdp.eval("JSON.parse(localStorage.getItem('harbor-board-colors') || '[]')");
    results.push(`recent colours: ${JSON.stringify(recents)}`);
    check(recents.includes('#123456') && recents.includes('#00ff88'), `custom colours were not saved for reuse (${JSON.stringify(recents)})`);
    check(recents[0] === '#00ff88', `most-recent colour is not first (${JSON.stringify(recents)})`);
    await cdp.shot('22-custom-colour');

    // Eyedropper: arm it from the popover, then click the known-fill source shape; its colour
    // applies to the still-selected target. Proves sampling reads the rendered canvas exactly.
    await cdp.eval("document.querySelector('.wb-color-pop .wb-color-pop-eyedrop').click()");
    await waitFor(cdp, "document.body.classList.contains('wb-sampling')", 'eyedropper armed');
    const srcPos = await cdp.eval("(() => { const api = window.__harborBoardApi; const app = api.getAppState(); const z = app.zoom.value; const el = api.getSceneElements().find((e) => e.id === 'ed-source'); return { x: Math.round((el.x + el.width/2 + app.scrollX)*z + (app.offsetLeft||0)), y: Math.round((el.y + el.height/2 + app.scrollY)*z + (app.offsetTop||0)) }; })()");
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: srcPos.x, y: srcPos.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: srcPos.x, y: srcPos.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
    const sampled = await cdp.eval("window.__harborBoardApi.getSceneElements().find((e) => e.id === 'cc-target').backgroundColor");
    results.push(`eyedropper sampled fill: ${sampled}`);
    check(sampled === '#abcdef', `eyedropper did not apply the sampled colour (got ${sampled}, expected #abcdef)`);
    check(!(await cdp.eval("document.body.classList.contains('wb-sampling')")), 'eyedropper stayed armed after one sample');
    check(await cdp.eval("JSON.parse(localStorage.getItem('harbor-board-colors') || '[]').includes('#abcdef')"), 'a sampled colour was not saved for reuse');
    await cdp.shot('23-eyedropper');

    // Sampling also reads a dropped/pasted IMAGE (data-URL, so the canvas is not tainted): it
    // must yield a hex colour without throwing. (The seeded drive-image is a data-URL image.)
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { 'cc-target': true } } })");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-float-bar'))", 'floating card for image sample');
    await cdp.eval("document.querySelector('.wb-float-bar [aria-label=\"Fill colour\"]').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-tb-menu .wb-swatch-custom'))", 'fill palette for image sample');
    await cdp.eval("document.querySelector('.wb-tb-menu .wb-swatch-custom').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-color-pop'))", 'popover for image sample');
    await cdp.eval("document.querySelector('.wb-color-pop .wb-color-pop-eyedrop').click()");
    await waitFor(cdp, "document.body.classList.contains('wb-sampling')", 'eyedropper armed for image');
    const imgPos = await cdp.eval("(() => { const api = window.__harborBoardApi; const el = api.getSceneElements().find((e) => e.id === 'cc-image'); if (!el) return null; const app = api.getAppState(); const z = app.zoom.value; return { x: Math.round((el.x + el.width/2 + app.scrollX)*z + (app.offsetLeft||0)), y: Math.round((el.y + el.height/2 + app.scrollY)*z + (app.offsetTop||0)) }; })()");
    if (imgPos) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: imgPos.x, y: imgPos.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: imgPos.x, y: imgPos.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(200);
      const imgSample = await cdp.eval("window.__harborBoardApi.getSceneElements().find((e) => e.id === 'cc-target').backgroundColor");
      results.push(`eyedropper on image: ${imgSample}`);
      check(/^#[0-9a-f]{6}$/.test(imgSample), `sampling an image did not yield a hex colour (got ${imgSample})`);
    } else {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      results.push('eyedropper on image: seeded image not present, skipped');
    }

    // A custom colour on a CONNECTOR (Pat listed connectors): select the arrow, its connector
    // bar shows a custom "+" too, and a typed hex sets the connector's stroke.
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { 'cc-arrow': true } } })");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-connector-bar .wb-swatch-custom'))", 'connector custom colour button');
    await cdp.eval("document.querySelector('.wb-connector-bar .wb-swatch-custom').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-color-pop'))", 'connector colour popover');
    await cdp.eval(setInput('.wb-color-hex', 'ff5722', true));
    await sleep(150);
    const connColor = await cdp.eval("window.__harborBoardApi.getSceneElements().find((e) => e.id === 'cc-arrow').strokeColor");
    results.push(`connector custom stroke: ${connColor}`);
    check(connColor === '#ff5722', `a custom hex did not colour the connector (got ${connColor})`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })");
    await sleep(100);

    // Pre-draw colour: choose a PEN colour BEFORE drawing (the only way pen/pencil/text colour
    // is settable), then draw a stroke and confirm it took that colour.
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /Draw/.test(b.getAttribute('aria-label') || '')).click()");
    await waitFor(cdp, "window.__harborBoardApi.getAppState().activeTool.type === 'freedraw'", 'draw (pen) tool active');
    await waitFor(cdp, "Boolean(document.querySelector('.wb-predraw-bar'))", 'pre-draw bar appears for a drawing tool');
    await cdp.eval("document.querySelector('.wb-predraw-bar .wb-swatch-custom').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-color-pop'))", 'pre-draw colour popover');
    await cdp.eval(setInput('.wb-color-hex', 'e64980', true));
    await sleep(140);
    const penDefault = await cdp.eval("window.__harborBoardApi.getAppState().currentItemStrokeColor");
    results.push(`pre-draw pen colour: ${penDefault}`);
    check(penDefault === '#e64980', `pre-draw did not set the pen colour (got ${penDefault})`);
    const beforePen = await cdp.eval('window.__harborBoardApi.getSceneElements().length');
    await dragOut(1040, 300, 1180, 380);
    await sleep(180);
    const pen = await cdp.eval("(() => { const el = [...window.__harborBoardApi.getSceneElements()].reverse().find((e) => e.type === 'freedraw'); return el ? el.strokeColor : null; })()");
    results.push(`drawn pen stroke: added=${(await cdp.eval('window.__harborBoardApi.getSceneElements().length')) - beforePen} colour=${pen}`);
    check(pen === '#e64980', `a freehand stroke did not take the pre-chosen pen colour (got ${pen})`);
    await cdp.shot('24-predraw-pen');

    // Connect-dot keep-alive corridor (Pat's report): hover a shape to raise its 4 dots, then
    // move OFF the body into the gap toward a dot; the dots must NOT vanish before you reach it.
    await cdp.eval("[...document.querySelectorAll('.wb-rail-btn')].find((b) => /Select/.test(b.getAttribute('aria-label') || '')).click()");
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} } })");
    await sleep(120);
    const ccBox = await cdp.eval("(() => { const api = window.__harborBoardApi; const app = api.getAppState(); const z = app.zoom.value; const el = api.getSceneElements().find((e) => e.id === 'cc-target'); const left = (el.x + app.scrollX)*z + (app.offsetLeft||0); const top = (el.y + app.scrollY)*z + (app.offsetTop||0); const w = el.width*z; const h = el.height*z; return { cx: Math.round(left + w/2), cy: Math.round(top + h/2), right: Math.round(left + w) }; })()");
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ccBox.cx, y: ccBox.cy, button: 'none', buttons: 0 });
    await sleep(320);
    check(await cdp.eval("document.querySelectorAll('.wb-connect-dot').length === 4"), 'hovering the shape did not raise 4 connect dots');
    // Just outside the right edge, in the gap BEFORE the dot's own hit box (the dot centre is
    // ~13px out, its box starts ~7px out, so +4px is body-off but dot-off: the corridor case).
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ccBox.right + 4, y: ccBox.cy, button: 'none', buttons: 0 });
    await sleep(320);
    const dotsInGap = await cdp.eval("document.querySelectorAll('.wb-connect-dot').length");
    results.push(`connect dots in the approach gap: ${dotsInGap}`);
    check(dotsInGap === 4, `connect dots vanished when the cursor entered the gap toward a dot (saw ${dotsInGap}) - Pat's report`);
    // Far from the shape and its dots, they retract.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ccBox.cx + 700, y: ccBox.cy - 400, button: 'none', buttons: 0 });
    await sleep(320);
    check(await cdp.eval("document.querySelectorAll('.wb-connect-dot').length === 0"), 'connect dots did not retract when the cursor left the shape and its dots');
    await cdp.shot('25-connect-corridor');

    // --- Text colour on a bound LABEL (Pat: "i still cant edit like the text color for text i
    // have like on a sticky note"). A sticky's label and a shape's caption are bound text
    // elements, so selecting the container and changing its (often transparent) border never
    // touched them. The new Text target recolours the label itself. Driven against a real bound
    // label the earlier specs already created (the "Inside" rectangle or a table cell). ---
    await cdp.eval("window.__harborBoardApi.setActiveTool({ type: 'selection' })");
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} } })");
    await sleep(120);
    const bound = await cdp.eval(`(() => {
      const els = window.__harborBoardApi.getSceneElements();
      const label = els.find((e) => e.type === 'text' && e.containerId && !e.isDeleted && els.some((c) => c.id === e.containerId && !c.isDeleted));
      if (!label) return null;
      const face = els.find((c) => c.id === label.containerId);
      window.__txFaceId = label.containerId; window.__txLblId = label.id;
      return { lbl: label.strokeColor, faceStroke: face.strokeColor };
    })()`);
    check(Boolean(bound), 'no bound label was found on the board to test text colour');
    if (bound) {
      await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { [window.__txFaceId]: true } } })");
      await waitFor(cdp, "Boolean(document.querySelector('.wb-float-bar [aria-label=\"Text colour\"]'))", 'typography row on a container with a bound label');
      results.push('bound-label typography: Text colour control present on the card');
      await cdp.eval("document.querySelector('.wb-float-bar [aria-label=\"Text colour\"]').click()");
      await waitFor(cdp, "Boolean(document.querySelector('.wb-tb-menu [aria-label=\"All colors: Dark Violet\"]'))", 'text colour popover');
      await cdp.eval("document.querySelector('.wb-tb-menu [aria-label=\"All colors: Dark Violet\"]').click()");
      await sleep(220);
      const txr = await cdp.eval("(() => { const els = window.__harborBoardApi.getSceneElements(); const face = els.find((e) => e.id === window.__txFaceId); const label = els.find((e) => e.id === window.__txLblId); return { label: label.strokeColor, faceStroke: face.strokeColor }; })()");
      results.push(`text recolour: label ${bound.lbl}->${txr.label} faceStroke ${bound.faceStroke}->${txr.faceStroke}`);
      check(txr.label === '#6631d7', `the bound label text did not recolour to Dark Violet (got ${txr.label})`);
      check(txr.faceStroke === bound.faceStroke, `recolouring the text wrongly changed the container border (${bound.faceStroke} -> ${txr.faceStroke})`);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await sleep(150);
      await cdp.shot('26-text-colour');
    }

    // --- Opacity / transparency (Pat: "add like a transparency option ... 0-100% for shapes") ---
    // Wave C: the 0-100% slider lives in the Fill popover and sets element opacity.
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: { 'cc-target': true } } })");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-float-bar'))", 'floating card for opacity');
    await cdp.eval("document.querySelector('.wb-float-bar [aria-label=\"Fill colour\"]').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.wb-tb-menu [aria-label=\"Opacity\"]'))", 'opacity slider in the fill popover');
    await cdp.eval(setInput('.wb-tb-menu [aria-label="Opacity"]', '50', false));
    await sleep(200);
    const op = await cdp.eval("window.__harborBoardApi.getSceneElements().find((e) => e.id === 'cc-target').opacity");
    results.push(`shape opacity: value=${op}`);
    check(op === 50, `the opacity slider did not set the shape to 50% (got ${op})`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.shot('27-opacity');
    await cdp.eval("window.__harborBoardApi.updateScene({ appState: { selectedElementIds: {} } })");

    await sleep(500);
    const urls = cdp.events.filter((event) => event.method === 'Network.requestWillBeSent').map((event) => event.params.request.url);
    const http = urls.filter((url) => /^https?:/i.test(url));
    const schemes = [...new Set(urls.map((url) => /^([^:]+):/.exec(url)?.[1] || 'none'))].sort();
    results.push(`network: requests=${urls.length} schemes=${schemes.join(',')} http=${http.length}`);
    check(http.length === 0, `network requests left the app: ${http.join(', ')}`);
  } finally {
    await sleep(500);
    try { child.kill(); } catch {}
  }

  const verdict = failures.length ? `FAIL\n${failures.join('\n')}` : 'PASS';
  const report = `${verdict}\n\n${results.join('\n')}\nboards: ${boardsDir}\nscreenshots: ${OUT}\n`;
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), `FAIL\n${error.stack || error}\n`);
  console.error('DRIVE FAILED:', error.stack || error);
  process.exit(2);
});
