'use strict';

// Synthetic images, shipped renderer/preload, real context-menu event and OS
// clipboard. No product lifecycle or session daemon starts. Clipboard snapshots
// stay in memory and are restored in finally, including a failed assertion.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const APP = path.resolve(__dirname, '..');
const OUT = path.resolve(APP, '../_astra/copy-image-drive');
const ID = 'copy-image-fixture';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function host() {
  const { app, BrowserWindow, ipcMain, session, clipboard, nativeImage, protocol } = require('electron');
  const root = process.env.HARBOR_DRIVE_ROOT;
  assert.ok(root && path.resolve(root).startsWith(OUT + path.sep), 'isolated drive root required');
  for (const [name, value] of Object.entries({ home: root, appData: process.env.APPDATA,
    userData: path.join(root, 'userData'), crashDumps: path.join(root, 'crashes') })) app.setPath(name, value);
  // Keep pixel checks deterministic without changing any real display setting.
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.focus = app.relaunch = () => { throw Error('Drive cannot activate the desktop'); };
  protocol.registerSchemesAsPrivileged([{ scheme: 'harbor-artifact', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1200, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true,
      preload: path.join(APP, 'src/preload/index.js') } });
  for (const method of ['show', 'showInactive', 'focus', 'maximize', 'restore', 'moveTop', 'setAlwaysOnTop', 'setFullScreen', 'setKiosk']) {
    win[method] = () => { throw Error(`Drive refuses ${method}`); };
  }
  win.webContents.focus = () => { throw Error('Drive refuses WebContents focus'); };
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const { mergeSidebarModel } = require('../src/shared/sidebar-model.cjs');
  const { emptyDoc } = require('../src/shared/tasks-model.cjs');
  const { METHOD_CHANNELS } = require('../src/main/rpc/channels.js');
  const { createContextMenuHandlers, attachContextMenu } = require('../src/main/context-menu.js');
  const contextHandlers = createContextMenuHandlers({ getWebContents: () => win.webContents,
    getSession: () => win.webContents.session, userDataPath: path.join(root, 'userData') });
  const model = mergeSidebarModel({ historySessions: [{ id: ID, provider: 'claude', project: 'Image copy demo',
    title: 'Original image clipboard proof', cwd: root, lastActive: new Date().toISOString(), isHistorical: true }], livePanes: [], workspaces: [] });
  let blocks = [];
  const answers = {
    'sidebar:get-state': () => ({ model }),
    'terminal:get-state': () => ({ panes: [], workspaces: [], tabs: [], connected: false }),
    'new-session:options': () => ({ profiles: [{ id: 'fixture', label: 'Demo', letter: 'D', provider: 'claude', isDefault: true }], providers: {}, defaults: {} }),
    'setup:state': () => ({ completed: true, orchestrationEnabled: false }),
    'tasks:read': () => emptyDoc(), 'ask:list': () => [], 'project-icons:list': () => [],
    'links:get': () => ({}), 'usage:get-all': () => ({}), 'accounts:read-emails': () => ({}), 'orchestration:list-runs': () => [],
    'orchestration:list-delegations': () => [], 'session:send-queue': () => ({ queued: [] }),
    'session:workflow-runs': () => [],
    'transcript:open': () => { win.webContents.send('transcript:update', { sessionId: ID, replace: blocks, header: { working: false } }); return { ok: true }; },
  };
  // Execute the production handler registration without booting the application.
  // This keeps its validation and nativeImage decode exactly as shipped.
  const mainSource = fs.readFileSync(path.join(APP, 'src/main/index.js'), 'utf8');
  const artifactFile = path.join(root, 'fixture.svg');
  fs.writeFileSync(artifactFile, '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="240"><rect width="420" height="240" fill="#37649e"/><circle cx="210" cy="120" r="80" fill="#f3f5fb"/></svg>');
  const { artifactUrl, filePathFromUrlPath } = require('../src/shared/artifact-url.cjs');
  const artifactStart = mainSource.indexOf('  protocol.handle(ARTIFACT_SCHEME,');
  assert.ok(artifactStart >= 0);
  const artifactEnd = mainSource.indexOf('\n  });', artifactStart);
  assert.ok(artifactEnd > artifactStart);
  require('node:vm').runInNewContext(mainSource.slice(artifactStart, artifactEnd + 6), {
    protocol, ARTIFACT_SCHEME: 'harbor-artifact', fs: fs.promises, path, Buffer, URL, Response,
    filePathFromUrlPath, artifactThumbs: { cacheDir: path.join(root, 'thumbs') },
    artifactsProvider: { isServable: (file) => file === artifactFile }, ARTIFACT_MIME: { svg: 'image/svg+xml' },
  });
  const start = mainSource.indexOf("  ipcMain.handle('clipboard:write-image',");
  assert.ok(start >= 0);
  const end = mainSource.indexOf('\n  });', start);
  assert.ok(end > start);
  let writeImage;
  require('node:vm').runInNewContext(mainSource.slice(start, end + 6), {
    ipcMain: { handle: (_channel, fn) => { writeImage = fn; } }, nativeImage, clipboard,
  });
  let failCopy = false;
  const writes = [];
  for (const { method } of METHOD_CHANNELS) {
    ipcMain.handle(method, (event, payload) => {
      if (contextHandlers[method]) return contextHandlers[method](event, payload);
      if (method === 'clipboard:write-image') {
        writes.push(payload.dataURL.split(',')[0]);
        return failCopy ? { ok: false } : writeImage(event, payload);
      }
      return (answers[method] || (() => null))(payload);
    });
  }
  const detach = attachContextMenu(win.webContents);
  const events = [];
  win.webContents.on('context-menu', (_event, params) => events.push({ mediaType: params.mediaType,
    hasImageContents: params.hasImageContents, x: params.x, y: params.y }));
  const evaluate = (code) => win.webContents.executeJavaScript(code).catch((error) => {
    console.error('Failed fixture script:', code);
    throw error;
  });
  async function waitFor(code) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await evaluate(code)) return; await sleep(50); }
    console.error('Drive diagnostics', JSON.stringify({ events, dom: await evaluate(`({ menu: !!document.querySelector('.ctxmenu'), clicks: window.__driveClicks, size: [innerWidth,innerHeight,devicePixelRatio], body:document.body.innerText.slice(0,1500) })`) }));
    throw Error(`Timed out: ${code}`);
  }
  const screenshots = [];
  async function shot(name) {
    const expected = await evaluate(`(() => {
      const image = document.querySelector('.conv-lightbox-img');
      if (!image) return { images: [...document.querySelectorAll('.conv-img')]
        .filter(i => !i.style.position).map(i => { const r=i.getBoundingClientRect();
          return { x: Math.round(r.left+20), y: Math.round(r.top+20) }; }) };
      const r = image.getBoundingClientRect();
      const b = document.querySelector('.conv-lightbox-copy').getBoundingClientRect();
      return { images: [{ x: Math.round(r.left+20), y: Math.round(r.top+20) }],
        button: { x: Math.ceil(b.left+8), y: Math.ceil(b.top+4), right: Math.floor(b.right-8), bottom: Math.floor(b.bottom-4) } };
    })()`);
    // Check the serialized PNG for image pixels and button lettering, rather
    // than accepting DOM geometry or a successful capture as visual proof.
    let png;
    let complete = false;
    for (let attempt = 0; attempt < 8 && !complete; attempt++) {
      win.webContents.invalidate();
      await sleep(75);
      const captured = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      png = captured.toPNG();
      const frame = nativeImage.createFromBuffer(png);
      complete = !expected;
      if (expected) {
        const pixels = frame.toBitmap();
        const width = frame.getSize().width;
        const imageVisible = expected.images.every(({ x, y }) => {
          const offset = (y * width + x) * 4;
          return Math.max(...pixels.subarray(offset, offset+3)) > 100;
        });
        let letters = 0;
        const b = expected.button;
        if (b) for (let y = b.y; y < b.bottom; y++) for (let x = b.x; x < b.right; x++) {
          const at = (y * width + x) * 4;
          if (Math.min(...pixels.subarray(at, at+3)) > 140) letters++;
        }
        complete = imageVisible && (!b || letters > 20);
      }
    }
    assert.ok(complete, `${name}: complete hidden frame with image and button`);
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, png);
    screenshots.push(file);
  }
  async function mouse(selector, button = 'left') {
    const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
      { type, ...point, button, clickCount: 1 });
  }
  const proof = [];
  async function readImage(name, width, height, pixels = false) {
    const deadline = Date.now() + 3000;
    let image;
    do {
      image = clipboard.readImage();
      if (!image.isEmpty() && image.getSize().width === width && image.getSize().height === height) break;
      await sleep(50);
    } while (Date.now() < deadline);
    assert.deepEqual(image.getSize(), { width, height }, name);
    const sampled = [];
    if (pixels) {
      const bitmap = image.toBitmap();
      for (const [x, y, bgra] of [[10, 10, [40, 30, 220, 255]], [400, 20, [90, 180, 20, 255]], [10, 300, [230, 90, 30, 255]]]) {
        const actual = [...bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
        assert.deepEqual(actual, bgra, `${name} pixel ${x},${y}`);
        sampled.push({ x, y, bgra: actual });
      }
    }
    proof.push({ name, width, height, sampled });
  }
  // Electron can restore its supported formats together in a single write.
  // Do not serialize the user's clipboard into fixtures, screenshots or logs.
  const saved = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
  const bookmark = clipboard.readBookmark();
  if (bookmark.url) {
    // Electron writes the bookmark URL from data.text. Refuse before changing
    // the clipboard if those two independent values cannot be restored together.
    assert.equal(saved.text, bookmark.url, 'Cannot preserve a bookmark URL that differs from clipboard text');
    saved.bookmark = bookmark.title;
  }
  let restored = false;
  let intentionalFailure = false;
  let timer;
  let result;
  try {
    const exercise = async () => {
      await win.loadFile(path.join(APP, 'dist/index.html'));
      await waitFor(`!!document.querySelector('.rail')`);
      const fixtures = await evaluate(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgb(220,30,40)'; ctx.fillRect(0,0,640,400);
        ctx.fillStyle = 'rgb(20,180,90)'; ctx.fillRect(320,0,320,200);
        ctx.fillStyle = 'rgb(30,90,230)'; ctx.fillRect(0,200,640,200);
        const png = canvas.toDataURL('image/png');
        canvas.width = 720; canvas.height = 480;
        ctx.fillStyle = '#37649e'; ctx.fillRect(0,0,720,480);
        ctx.fillStyle = '#f3f5fb'; ctx.fillRect(72,72,576,336);
        ctx.fillStyle = '#37649e'; ctx.font = '32px sans-serif'; ctx.fillText('WEBP original 720 x 480', 150, 248);
        return { png, webp: canvas.toDataURL('image/webp') };
      })()`);
      assert.ok(fixtures.webp.startsWith('data:image/webp;'));
      blocks = [{ key: 'prompt', kind: 'user', text: 'Copy the original image from this conversation.' },
        { key: 'images', kind: 'assistant', text: 'PNG and WEBP fixtures for clipboard verification.',
          images: [{ dataUri: fixtures.png, mediaType: 'image/png' }, { dataUri: fixtures.webp, mediaType: 'image/webp' }] }];
      await evaluate(`localStorage.setItem('harbor-slate-stage', ${JSON.stringify(JSON.stringify({ tiles: [{ sessionId: ID, slot: 0 }], selectedId: ID }))});
        localStorage.setItem('harbor-view', 'agents')`);
      await win.reload();
      await waitFor(`document.querySelectorAll('.conv-img').length === 2 && [...document.querySelectorAll('.conv-img')].every(i => i.complete && i.naturalWidth)`);
      win.webContents.debugger.attach('1.3');
      await evaluate(`window.__driveClicks = []; for (const type of ['mousedown','mouseup','contextmenu']) document.addEventListener(type, e => window.__driveClicks.push({ type, target:e.target.className, x:e.clientX,y:e.clientY, prevented:e.defaultPrevented }), true)`);
      const thumbnail = await evaluate(`(() => {const i=document.querySelector('.conv-img');return {width:i.clientWidth,height:i.clientHeight};})()`);
      assert.ok(thumbnail.width < 640 && thumbnail.height < 400);
      await shot('conversation');
      clipboard.writeText('synthetic sentinel');
      await mouse('.conv-img', 'right');
      await waitFor(`document.querySelector('.ctxmenu')?.style.visibility === 'visible'`);
      assert.equal(events.at(-1).mediaType, 'image');
      assert.equal(events.at(-1).hasImageContents, true);
      assert.equal(await evaluate(`document.querySelector('.ctxmenu [role=menuitem]').textContent`), 'Copy image');
      await shot('thumbnail-menu');
      await mouse('.ctxmenu [role=menuitem]');
      await readImage('PNG thumbnail right-click', 640, 400, true);
      if (process.env.HARBOR_COPY_DRIVE_FAIL === '1') {
        intentionalFailure = true;
        throw Error('Intentional failure after clipboard mutation');
      }
      // The image can also be inside selected text. Both actions stay available.
      await evaluate(`(() => {const node=document.querySelector('.conv-assistant'); const range=document.createRange();
        range.selectNodeContents(node); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range);})()`);
      await mouse('.conv-img', 'right');
      await waitFor(`document.querySelectorAll('.ctxmenu [role=menuitem]').length === 2`);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('.ctxmenu [role=menuitem]')].map(e=>e.textContent)`), ['Copy image', 'Copy']);
      await shot('image-and-text-menu');
      await mouse('.ctxmenu [role=menuitem]:last-child');
      for (let i = 0; i < 60 && !clipboard.readText().includes('PNG and WEBP fixtures'); i++) await sleep(50);
      assert.ok(clipboard.readText().includes('PNG and WEBP fixtures'));
      await evaluate(`getSelection().removeAllRanges()`);
      // A streaming scroll invalidates the original hit-test coordinates.
      await mouse('.conv-img', 'right');
      await waitFor(`!!document.querySelector('.ctxmenu')`);
      win.webContents.send('transcript:update', { sessionId: ID, append: [{ key: 'streamed', kind: 'assistant', text: 'Streaming update.\n\n'.repeat(70) }] });
      await waitFor(`!document.querySelector('.ctxmenu')`);
      win.webContents.send('transcript:update', { sessionId: ID, replace: blocks });
      await waitFor(`document.querySelectorAll('.conv-assistant').length === 1`);
      await evaluate(`document.querySelector('.conv-img').scrollIntoView({block:'center'})`);
      // A menu clamped over the target must disappear before copyImageAt runs.
      await evaluate(`document.querySelector('.conv-img').style.cssText='position:fixed;right:8px;bottom:8px;width:64px;height:40px;z-index:9999'`);
      await mouse('.conv-img', 'right');
      await waitFor(`document.querySelector('.ctxmenu')?.style.visibility === 'visible'`);
      assert.equal(await evaluate(`(() => {const r=document.querySelector('.ctxmenu').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;})()`), true);
      await shot('edge-menu');
      clipboard.writeText('synthetic sentinel');
      await mouse('.ctxmenu [role=menuitem]');
      await readImage('PNG edge-clamped menu', 640, 400, true);
      await evaluate(`document.querySelector('.conv-img').removeAttribute('style')`);
      await mouse('.conv-img');
      await waitFor(`!!document.querySelector('.conv-lightbox-copy')`);
      await mouse('.conv-lightbox-img', 'right');
      await waitFor(`!!document.querySelector('.ctxmenu')`);
      await shot('lightbox-menu');
      clipboard.writeText('synthetic sentinel');
      await mouse('.ctxmenu [role=menuitem]');
      await readImage('PNG lightbox right-click', 640, 400, true);
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`);
      await waitFor(`!document.querySelector('.conv-lightbox-backdrop')`);
      await mouse('.conv-img-btn:nth-child(2) .conv-img');
      await waitFor(`document.querySelector('.conv-lightbox-img')?.naturalWidth === 720`);
      const geometry = await evaluate(`(() => {
        const b=document.querySelector('.conv-lightbox-copy').getBoundingClientRect();
        const i=document.querySelector('.conv-lightbox-img').getBoundingClientRect();
        return { buttonInBounds: b.left >= 0 && b.right <= innerWidth && b.top >= 0,
          imageInBounds: i.left >= 0 && i.right <= innerWidth && i.bottom <= innerHeight,
          separated: b.bottom < i.top };
      })()`);
      assert.deepEqual(geometry, { buttonInBounds: true, imageInBounds: true, separated: true });
      await shot('webp-lightbox');
      clipboard.writeText('synthetic sentinel');
      await mouse('.conv-lightbox-copy');
      await waitFor(`document.querySelector('.conv-lightbox-copy')?.textContent === 'Copied'`);
      await readImage('WEBP lightbox Copy', 720, 480);
      assert.equal(writes.at(-1), 'data:image/png;base64');
      await shot('webp-copied');
      await waitFor(`document.querySelector('.conv-lightbox-copy')?.textContent === 'Copy'`);
      failCopy = true;
      await mouse('.conv-lightbox-copy');
      await waitFor(`document.querySelector('.conv-lightbox-copy')?.textContent === 'Copy failed'`);
      await shot('copy-failed');
      await waitFor(`document.querySelector('.conv-lightbox-copy')?.textContent === 'Copy'`);
      failCopy = false;
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`);
      // Rail icons are chrome: the session-row menu wins on every row target.
      await evaluate(`(() => { const input=document.querySelector('.rail-find'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'Original image'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await waitFor(`!!document.querySelector('.sr-provider')`);
      const logoSize = await evaluate(`(() => {const i=document.querySelector('.sr-provider');return {width:i.naturalWidth,height:i.naturalHeight};})()`);
      const logoURL = await evaluate(`document.querySelector('.sr-provider').src`);
      await mouse('.sr-provider', 'right');
      await waitFor(`!!document.querySelector('.sr-menu')`);
      const sidebarMenu = await evaluate(`[...document.querySelectorAll('.sr-menu [role=menuitem]')].map(e => e.textContent.trim())`);
      assert.deepEqual(sidebarMenu, ['Copy resume command', 'Archive (hide from rail)', 'Delete\u2026']);
      assert.equal(await evaluate(`!!document.querySelector('.ctxmenu')`), false, 'rail image must not open Copy image');
      await shot('sidebar-image-menu');
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`);
      await waitFor(`!document.querySelector('.sr-menu')`);
      // Preserve the SVG clipboard assertions on content inside the conversation.
      await evaluate(`document.querySelector('.conv-img').src = ${JSON.stringify(logoURL)}`);
      await waitFor(`document.querySelector('.conv-img')?.naturalWidth === ${logoSize.width}`);
      await mouse('.conv-img', 'right');
      await waitFor(`document.querySelector('.ctxmenu [role=menuitem]')?.textContent === 'Copy image'`);
      clipboard.writeText('synthetic sentinel');
      await mouse('.ctxmenu [role=menuitem]');
      await readImage('Conversation SVG fixture', logoSize.width, logoSize.height);
      // Files-view SVGs cross from file:// into the real artifact protocol.
      // Exercise its shipped allowlist/CORS response, with one synthetic file.
      await evaluate(`document.querySelector('.conv-img').src = ${JSON.stringify(artifactUrl(artifactFile))}`);
      await waitFor(`document.querySelector('.conv-img')?.naturalWidth === 420`);
      await mouse('.conv-img', 'right');
      await waitFor(`!!document.querySelector('.ctxmenu')`);
      clipboard.writeText('synthetic sentinel');
      await mouse('.ctxmenu [role=menuitem]');
      await readImage('Artifact-protocol SVG', 420, 240);
      assert.equal(win.isVisible(), false);
      return { thumbnail, geometry, sidebarMenu };
    };
    result = await Promise.race([exercise(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Hidden image drive exceeded 45 seconds')), 45000);
    })]);
  } catch (error) {
    console.error('Drive assertion:', error.message);
    throw error;
  } finally {
    clearTimeout(timer);
    try {
      clipboard.write(saved);
      assert.equal(clipboard.readText(), saved.text, 'restore text');
      assert.equal(clipboard.readRTF(), saved.rtf, 'restore RTF');
      assert.equal(clipboard.readHTML(), saved.html, 'restore HTML');
      assert.deepEqual(clipboard.readImage().toPNG(), saved.image.toPNG(), 'restore image');
      if (bookmark.url) assert.deepEqual(clipboard.readBookmark(), bookmark, 'restore bookmark');
      restored = true;
    } finally {
      fs.writeFileSync(path.join(OUT, 'clipboard-restored.json'), JSON.stringify({ restored, intentionalFailure, root }));
      detach();
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
      win.destroy();
    }
  }
  fs.writeFileSync(path.join(OUT, 'verdict.json'), JSON.stringify({ result: 'PASS', restored, ...result, events, proof, screenshots }, null, 2));
  console.log(JSON.stringify({ result: 'PASS', restored, ...result, proof, screenshots }));
  app.quit();
}

async function drive() {
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(OUT, 'state-'));
  for (const name of ['appData', 'localAppData', 'userData', 'crashes', 'tmp']) fs.mkdirSync(path.join(root, name));
  const env = { ...process.env, HARBOR_DRIVE_ROOT: root, HOME: root, USERPROFILE: root,
    APPDATA: path.join(root, 'appData'), LOCALAPPDATA: path.join(root, 'localAppData'),
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), CODEX_HOME: path.join(root, 'codex'),
    HARBOR_USER_DATA_DIR: path.join(root, 'userData'), HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
    HARBOR_CONTEXT_DIR: path.join(root, 'context'), HARBOR_CONFIG_FILE: path.join(root, 'config.json'),
    HARBOR_NO_DAEMON_START: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_TITLER: '1',
    HARBOR_NO_MODEL_DISCOVERY: '1', HARBOR_NO_VOICE: '1', HARBOR_NO_PERF_LOG: '1' };
  if (process.argv.includes('--fail-after-copy')) env.HARBOR_COPY_DRIVE_FAIL = '1';
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(APP, 'node_modules/electron/dist/electron.exe'), [__filename, '--host'],
    { env, windowsHide: true, stdio: 'pipe' });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  // The host owns its deadline so failure unwinds through clipboard restoration.
  // Never kill the host while it owns the user's clipboard snapshot.
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  if (process.argv.includes('--fail-after-copy')) {
    assert.equal(code, 1, 'intentional failure must fail the host');
    const restoration = JSON.parse(fs.readFileSync(path.join(OUT, 'clipboard-restored.json'), 'utf8'));
    assert.equal(restoration.root, root, 'restoration belongs to this run');
    assert.equal(restoration.intentionalFailure, true, 'failure followed the verified clipboard mutation');
    assert.equal(restoration.restored, true);
    console.log('PASS: clipboard restored after intentional assertion failure');
  } else assert.equal(code, 0, 'hidden image drive failed');
}

(process.argv.includes('--host') ? host() : drive()).catch((error) => {
  console.error(error); process.exitCode = 1;
  if (process.versions.electron) require('electron').app.exit(1);
});
