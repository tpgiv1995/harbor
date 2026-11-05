'use strict';

// LIVE Windows proof for on-demand transcript images (2026-11-05, Pat: images
// are "a common pain point in harbor").
//
// A conversation block used to carry every image as a base64 data URI, held in
// main's heap, copied into the renderer's heap and sent whole to the phone; to
// bound that, each chat kept only its 32 newest image blocks. Now a block
// carries { mediaType, id, size }, the bytes live once in
// src/main/providers/image-store.js, and a window loads an image through the
// harbor-image:// protocol only when it draws it.
//
// This drive runs an ISOLATED Harbor (tmp userData, config, transcript store and
// sessiond; port 9349), born hidden and shown inactive off-screen. Its history
// index reads a synthetic chat written into its own transcript folder: two
// 480x320 PNGs in one prompt and a 1600x1000 PNG in another. Pass: all three
// draw from harbor-image:// at their real sizes, no image bytes sit in the
// page, an unknown id answers 404, clicking the large one opens it full size,
// and an image whose bytes are gone shows the plain fallback line.
// Screenshots: window.png, lightbox.png and image-gone.png in the output folder.
//
// Usage (from app/): node scripts/drive-transcript-images-win.js [renderer index.html]
// With no argument it loads app/dist (run `npm run build` first). A path loads
// that build instead, through VITE_DEV_SERVER_URL.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const { SessionClient } = require('../src/daemon/client.js');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9349;
const OUT = path.join(os.tmpdir(), 'harbor-drive-transcript-images');
const RENDERER = process.argv[2] ? path.resolve(process.argv[2]) : null;

const SESSION_ID = '5e551011-0000-4000-8000-00000000a11e';
const mungeCwd = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');
const zlib = require('node:zlib');
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// A solid-color RGB PNG, so the fixture is synthetic and its size is known.
function png(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const step = (label) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${label}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, timeoutMs = 20_000) {
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`page did not answer within ${timeoutMs} ms: ${expression.slice(0, 60)}`)), timeoutMs); });
    const result = await Promise.race([this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), deadline]).finally(() => clearTimeout(timer));
    if (result.exceptionDetails) {
      throw new Error(`page threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
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

async function waitFor(cdp, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.eval(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

async function type(cdp, value) {
  for (const character of value) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character, unmodifiedText: character });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(40);
  }
}

// Installed in the page: a pinned test model with the session under test, and
// the same model WITHOUT it, built fresh each push the way IPC delivers one.
const PAGE_DRIVER = `
(() => {
  const NOW = Date.now();
  const row = (id, title) => ({
    id, project: 'focus-proof', title, firstPrompt: title,
    lastActive: new Date(NOW).toISOString(), lastActiveMs: NOW,
    home: 'personal', provider: 'claude', model: null, isLive: false, paneId: null, workspaceId: null,
    agentStatus: null, isWindowsEra: false, isChildTask: false, childTitle: null,
    cwd: ${JSON.stringify(APP_DIR.replace(/\\/g, '/'))}, isHistorical: true,
  });
  const model = (withTarget) => {
    const sessions = [row('sess-other', 'Other session')];
    if (withTarget) sessions.unshift(row(${JSON.stringify(SESSION_ID)}, 'Image proof session'));
    return JSON.parse(JSON.stringify({
      projects: [{ label: 'focus-proof', sessions, sessionCount: sessions.length, lastActiveMs: NOW,
        hasLive: false, isWindowsEra: false, isOrchestration: false, isDateGroup: false, displayDayMs: null,
        newSessionCwd: ${JSON.stringify(APP_DIR.replace(/\\/g, '/'))} }],
      liveProjects: [], grouping: 'project',
    }));
  };
  // The App (stage, command bar) and the rail each hold their own pinned model;
  // a real publish reaches both, so every push here sets both.
  const push = (m) => { window.__setSidebarModelForTest(m); window.__setRailModelForTest?.(structuredClone(m)); };
  window.__focusDrive = {
    lockSeen: false,
    install() { push(model(true)); return true; },
    watch() {
      const box = document.querySelector('.ubar-input');
      const observer = new MutationObserver(() => { if (box.getAttribute('contenteditable') === 'false') window.__focusDrive.lockSeen = true; });
      observer.observe(box, { attributes: true, attributeFilter: ['contenteditable'] });
      return true;
    },
    drop() { push(model(false)); return true; },
    restore() { push(model(true)); return true; },
  };
  return 'installed';
})()
`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-images-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  // An EMPTY transcript store: the session under test is a pinned test model,
  // and a cold index of the real store (tens of thousands of files) held the
  // window back for minutes.
  const projectsDir = path.join(tmp, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  // The test chat: synthetic solid-color PNGs (two small, one large), written
  // where THIS harness's history index reads (its own projectsDir), never into
  // the real transcript store.
  const fixtureDir = path.join(projectsDir, mungeCwd(APP_DIR));
  fs.mkdirSync(fixtureDir, { recursive: true });
  const at = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const base = { sessionId: SESSION_ID, cwd: APP_DIR, version: '2.1.316', userType: 'external', isSidechain: false };
  const records = [
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: at(0), message: { role: 'user', content: [
      { type: 'text', text: 'Here are two screenshots' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(480, 320, [200, 60, 60]).toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(480, 320, [60, 160, 90]).toString('base64') } },
    ] } },
    { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at(2), message: { id: 'msg1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Got both of them.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } },
    { ...base, type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: at(4), message: { role: 'user', content: [
      { type: 'text', text: 'And a large one' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(1600, 1000, [60, 90, 200]).toString('base64') } },
    ] } },
    { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: at(6), message: { id: 'msg2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'That one is 1600 by 1000.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  fs.writeFileSync(path.join(fixtureDir, `${SESSION_ID}.jsonl`), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  realConfig.paths = {
    ...realConfig.paths,
    projectsDir,
    cacheDir: path.join(tmp, 'cache'),
    tasksFile: path.join(tmp, 'tasks.json'),
    notesFile: path.join(tmp, 'notes.json'),
    boardsDir: path.join(tmp, 'boards'),
    projectIconsDir: path.join(tmp, 'project-icons'),
  };
  // One plan with an empty home: every real plan's home leads into the real
  // transcript store, and the index reads each one before the window opens.
  const claudeHome = path.join(tmp, 'claude-home');
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
  realConfig.profiles = [{ id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', configHome: claudeHome, email: null, isDefault: true }];
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(realConfig, null, 2));

  // Startup waits on a session daemon, so the harness brings its own: an empty
  // relocated store that dies with this process (HARBOR_SESSIOND_PARENT_PID).
  const store = path.join(tmp, 'sessiond');
  fs.mkdirSync(store, { recursive: true });
  const socketPath = path.join(store, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [path.join(APP_DIR, 'src', 'daemon', 'daemon.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_PARENT_PID: String(process.pid),
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-images-drive-${process.pid}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let daemonErr = '';
  daemon.stderr.on('data', (chunk) => { daemonErr += chunk; });
  for (const deadline = Date.now() + 15_000; ;) {
    try { const probe = new SessionClient({ socketPath }); const r = await probe.request('health'); probe.close(); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`isolated daemon never answered: ${daemonErr}`);
    await sleep(100);
  }

  const env = {
    ...process.env,
    HARBOR_E2E: '1',
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: store,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-images-drive-${process.pid}`,
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
    HARBOR_NO_VOICE: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (RENDERER) env.VITE_DEV_SERVER_URL = pathToFileURL(RENDERER).href;
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env,
    windowsHide: true,
    stdio: ['ignore', fs.openSync(path.join(OUT, 'electron.log'), 'w'), fs.openSync(path.join(OUT, 'electron.err.log'), 'w')],
  });

  const facts = { renderer: RENDERER || 'app/dist' };
  let failure = '';
  let cdpRef = null;
  try {
    let target = null;
    for (let i = 0; i < 240 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        facts.targets = list.map((item) => `${item.type} ${String(item.url).slice(0, 80)}`);
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('CDP target never appeared');
    step('window up');
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);
    cdpRef = cdp;
    await cdp.send('Runtime.enable');
    await waitFor(cdp, 'typeof window.__setSidebarModelForTest === "function" && typeof window.__setRailModelForTest === "function"', 'the E2E model hooks', 60_000);
    await cdp.eval(PAGE_DRIVER);
    await cdp.eval('window.__focusDrive.install()');
    step('test model pinned');
    await cdp.eval("[...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'All')?.click(); true");
    await sleep(400);
    // Open the project group if it is folded, then select the session.
    await waitFor(cdp, "Boolean(document.querySelector('.sr[data-session-id=\"" + SESSION_ID + "\"]') || document.querySelector('.pg'))", 'the test project in the rail');
    if (!(await cdp.eval("Boolean(document.querySelector('.sr[data-session-id=\"" + SESSION_ID + "\"]'))"))) {
      await cdp.eval("[...document.querySelectorAll('.pg')].find((g) => /focus-proof/i.test(g.innerText || ''))?.click(); true");
    }
    await waitFor(cdp, "Boolean(document.querySelector('.sr[data-session-id=\"" + SESSION_ID + "\"]'))", 'the test session row');
    step('row visible, selecting it');
    await cdp.eval("document.querySelector('.sr[data-session-id=\"" + SESSION_ID + "\"]').click(); true");
    step('row clicked');
    step('window opening; waiting for its images');
    await waitFor(cdp, "document.querySelectorAll('.conv-img').length >= 3", 'three images in the window', 45_000);
    await waitFor(cdp, "[...document.querySelectorAll('.conv-img')].every((i) => i.complete)", 'the images to finish loading', 20_000);
    facts.images = await cdp.eval("[...document.querySelectorAll('.conv-img')].map((i) => ({ src: i.getAttribute('src').slice(0, 40), width: i.naturalWidth, height: i.naturalHeight }))");
    facts.dataUriImages = await cdp.eval("[...document.querySelectorAll('.conv-img')].filter((i) => (i.getAttribute('src') || '').startsWith('data:')).length");
    facts.srcChars = await cdp.eval("[...document.querySelectorAll('.conv-img')].reduce((n, i) => n + (i.getAttribute('src') || '').length, 0)");
    facts.missingStatus = await cdp.eval(`fetch('harbor-image://img/${'0'.repeat(32)}').then((r) => r.status).catch((e) => 'threw ' + e.message)`);
    await cdp.shot('window');
    step('opening the large image full size');
    await cdp.eval("document.querySelectorAll('.conv-img-btn')[2].click(); true");
    await waitFor(cdp, "Boolean(document.querySelector('.conv-lightbox-img')?.complete && document.querySelector('.conv-lightbox-img').naturalWidth)", 'the full-size image', 15_000);
    facts.lightbox = await cdp.eval("(() => { const i = document.querySelector('.conv-lightbox-img'); return { src: i.getAttribute('src').slice(0, 40), width: i.naturalWidth, height: i.naturalHeight }; })()");
    await cdp.shot('lightbox');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    // An image whose bytes the store evicted: point the first one at an id the
    // real protocol does not hold (it answers 404, checked above) and require
    // the plain fallback line in its place, not a broken-image box.
    step('an image whose bytes are gone shows the fallback line');
    await waitFor(cdp, "!document.querySelector('.conv-lightbox-img')", 'the full-size view to close', 5_000);
    await cdp.eval(`document.querySelectorAll('.conv-img')[0].setAttribute('src', 'harbor-image://img/${'0'.repeat(32)}'); true`);
    await waitFor(cdp, "Boolean(document.querySelector('.conv-img-gone'))", 'the fallback line', 10_000);
    facts.goneText = await cdp.eval("document.querySelector('.conv-img-gone').textContent");
    facts.imagesAfterGone = await cdp.eval("document.querySelectorAll('.conv-img').length");
    await cdp.eval("document.querySelector('.conv-img-gone').scrollIntoView({ block: 'center' }); true");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cdp.shot('image-gone');
    const widths = facts.images.map((i) => i.width).join(',');
    if (facts.images.length < 3) failure = `only ${facts.images.length} images rendered`;
    else if (!facts.images.every((i) => i.src.startsWith('harbor-image://img/'))) failure = `an image did not load through harbor-image:// (${JSON.stringify(facts.images)})`;
    else if (widths !== '480,480,1600') failure = `images decoded at the wrong sizes: ${widths}`;
    else if (facts.dataUriImages !== 0) failure = `${facts.dataUriImages} images still carry their bytes in the page`;
    else if (facts.missingStatus !== 404) failure = `an unknown image id answered ${facts.missingStatus}, not 404`;
    else if (facts.lightbox.width !== 1600 || !facts.lightbox.src.startsWith('harbor-image://img/')) failure = `the full-size view showed ${JSON.stringify(facts.lightbox)}`;
    else if (facts.goneText !== 'Image no longer loaded. Reopen this window to see it.') failure = `a missing image showed ${JSON.stringify(facts.goneText)}`;
    else if (facts.imagesAfterGone !== 2) failure = `the missing image's neighbours changed: ${facts.imagesAfterGone} images left, expected 2`;
    try { await cdp.eval('window.harbor.e2e.quit()'); } catch { /* quitting */ }
  } catch (error) {
    failure = `drive error: ${error.message}`;
    if (cdpRef) {
      try { facts.failShot = await cdpRef.shot('failure'); } catch { /* window gone */ }
      try { facts.rail = await cdpRef.eval("[...document.querySelectorAll('.pg, .sr')].slice(0, 12).map((e) => e.className + ' ' + (e.getAttribute('data-session-id') || '') + ' ' + (e.innerText || '').slice(0, 40).replace(/\\n/g, ' '))"); } catch { /* window gone */ }
    }
  } finally {
    await sleep(800);
    try { child.kill(); } catch { /* gone */ }
    try { daemon.kill(); } catch { /* gone */ }
  }
  fs.writeFileSync(path.join(OUT, 'verdict.json'), JSON.stringify({ facts, failure }, null, 2));
  console.log(JSON.stringify(facts, null, 2));
  if (failure) {
    console.log(`PROOF FAILED: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('PROOF OK: the window drew all three images from harbor-image:// at their real sizes, held no image bytes, 404ed an unknown id, and opened the large one full size');
  }
}

main();
