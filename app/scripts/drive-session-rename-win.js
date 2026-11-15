'use strict';

// RENAME A SESSION, DRIVEN AS PAT WOULD (2026-11-15, Pat: "can you add a feature
// that lets me rename session/chat names in harbor? like a little pencil icon
// where i could type in a custom title").
//
// An ISOLATED Harbor (tmp userData, its own relocated sessiond that dies with
// this process, every plan on an empty home) is born offscreen by main's
// HARBOR_E2E rule. Unlike drive-look-win.js it is NOT fed a pinned model: real
// fixture transcripts sit in its projects folder, so the rail comes from the
// real history index and the real sidebar bridge, and a rename travels the
// whole path (pencil, editor, IPC, session-names.json, bridge, publish, rail
// row and window header). It never touches the real daemon, the real
// ~/.harbor or the screen.
//
// Proven, each with a capture: the rail pencil on hover; renaming from the rail
// (Enter), which writes the names file and shows in the rail AND the open
// window's header; the header pencil on hover; Escape changes nothing; an
// empty name brings the automatic title back everywhere; the right-click menu's
// Rename, saved by clicking away; and at Pat's maximized 12-window grid
// (about 272px a cell) the header pencil and every header control stay inside
// their window.
//
// Usage (from app/, after a renderer build):
//   node scripts/drive-session-rename-win.js --out <dir> [--renderer <built index.html>]

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const { SessionClient } = require('../src/daemon/client.js');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = Number(process.env.DRIVE_RENAME_PORT || 9387);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'harbor-drive-rename')));
const SIZES = {
  pat: { width: 956, height: 574, scale: 1.8 },
  max: { width: 1422, height: 889, scale: 1.8 },
};
const step = (label) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${label}\n`);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'exception');
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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout on ${method}`)); }
      }, 30_000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`page threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result.value;
  }

  async size({ width, height, scale }) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await sleep(400);
  }

  async shot(name, clip = null) {
    const params = { format: 'png' };
    if (clip) params.clip = { ...clip, scale: 1 };
    const result = await this.send('Page.captureScreenshot', params);
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    step(`captured ${name}`);
    return file;
  }

  async center(selector) {
    const box = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!box) throw new Error(`no element for ${selector}`);
    await sleep(120);
    return box;
  }

  async hover(selector) {
    const { x, y } = await this.center(selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(250);
  }

  async unhover() {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await sleep(150);
  }

  async click(selector, button = 'left') {
    const { x, y } = await this.center(selector);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
    await sleep(300);
  }

  async key(key, code, keyCode, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    await sleep(200);
  }

  async type(text) {
    await this.send('Input.insertText', { text });
    await sleep(150);
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.eval(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label} (${expression})`);
    await sleep(150);
  }
}

const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4222-8333-${String(n).padStart(12, '0')}`;
const AUTO = (n) => `Fixture session ${n}: tidy the release checklist`;

// A cwd under Temp is a scratch project, hidden from the rail by default
// (sidebar-model isScratchProject), so the fixtures name this checkout's own
// folders. Only as a label: the isolated Harbor refuses every launch.
function writeFixtures(tmp, projectsDir, count) {
  const cwds = [APP_DIR, path.resolve(APP_DIR, '..')];
  for (let n = 1; n <= count; n += 1) {
    const cwd = cwds[n % 2];
    const at = new Date(Date.now() - n * 60_000);
    const later = new Date(at.getTime() + 20_000);
    const folder = path.join(projectsDir, `fixture-${n % 2}`);
    fs.mkdirSync(folder, { recursive: true });
    const lines = [
      { type: 'user', message: { role: 'user', content: AUTO(n) }, cwd, sessionId: uuid(n), timestamp: at.toISOString(), entrypoint: 'cli', uuid: `${uuid(n)}-u` },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `Done with fixture ${n}.` }] }, cwd, sessionId: uuid(n), timestamp: later.toISOString(), uuid: `${uuid(n)}-a` },
    ];
    const file = path.join(folder, `${uuid(n)}.jsonl`);
    fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    fs.utimesSync(file, later, later);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-rename-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const projectsDir = path.join(tmp, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const claudeHome = path.join(tmp, 'claude-home');
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
  const COUNT = 12;
  writeFixtures(tmp, projectsDir, COUNT);
  const config = {
    paths: { projectsDir, cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json'), notesFile: path.join(tmp, 'notes.json'), boardsDir: path.join(tmp, 'boards'), projectIconsDir: path.join(tmp, 'project-icons') },
    profiles: [{ id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', configHome: claudeHome, email: null, isDefault: true }],
    setup: { completed: true, completedAt: null, appVersion: null },
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));
  const namesFile = path.join(userData, 'session-names.json');

  const store = path.join(tmp, 'sessiond');
  fs.mkdirSync(store, { recursive: true });
  const socketPath = path.join(store, 'daemon.sock');
  const namespace = `harbor-rename-drive-${process.pid}`;
  const daemon = spawn(guiNodeExec, [path.join(APP_DIR, 'src', 'daemon', 'daemon.js')], {
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: namespace },
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
    ...process.env, HARBOR_E2E: '1', HARBOR_E2E_USER_DATA: userData, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_SESSIOND_JOB_NAMESPACE: namespace, HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_NO_ICON_GEN: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_TITLER: '1', HARBOR_NO_VOICE: '1',
    HARBOR_CLI_UPDATES_FILE: path.join(tmp, 'cli-updates.json'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HARBOR_SESSION_NAMES_FILE;
  const renderer = arg('renderer', null);
  if (renderer) env.VITE_DEV_SERVER_URL = require('node:url').pathToFileURL(path.resolve(renderer)).href;
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env, windowsHide: true, stdio: ['ignore', fs.openSync(path.join(OUT, 'electron.log'), 'w'), fs.openSync(path.join(OUT, 'electron.err.log'), 'w')],
  });

  const checks = [];
  const check = (ok, label) => { checks.push({ ok: Boolean(ok), label }); step(`${ok ? 'ok  ' : 'FAIL'} ${label}`); };
  let failure = '';
  let cdpRef = null;
  try {
    let target = null;
    for (let i = 0; i < 720 && !target; i += 1) {
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
    cdpRef = cdp;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.size(SIZES.pat);

    const A = uuid(1);
    const B = uuid(2);
    const row = (id) => `.sr[data-session-id="${id}"]`;
    const rowTitle = (id) => `document.querySelector('${row(id)} .sr-t')?.textContent`;
    const header = (id) => `.win2[data-session-id="${id}"]`;
    const headerTitle = (id) => `document.querySelector('${header(id)} .ti')?.textContent`;
    const names = () => { try { return JSON.parse(fs.readFileSync(namesFile, 'utf8')).names || {}; } catch { return {}; } };
    const visible = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.5 && r.width > 0 && r.height > 0; })()`;
    const focusedEditor = `document.activeElement?.classList.contains('rename-field')`;

    // Expand any collapsed project so the fixture rows exist.
    await waitFor(cdp, `[...document.querySelectorAll('.pg .pg-label')].some((el) => /harbor/i.test(el.textContent))`, 'the fixture projects in the rail', 60_000);
    for (let i = 0; i < 5 && !(await cdp.eval(`Boolean(document.querySelector('${row(A)}')) && Boolean(document.querySelector('${row(B)}'))`)); i += 1) {
      await cdp.eval(`(() => { for (const el of document.querySelectorAll('.pg')) { if (/harbor/i.test(el.querySelector('.pg-label')?.textContent || '') && el.querySelector('.sidebar-caret')?.textContent === '▸') el.click(); } })()`);
      await sleep(500);
    }
    await waitFor(cdp, `Boolean(document.querySelector('${row(A)}')) && Boolean(document.querySelector('${row(B)}'))`, 'the fixture rows', 30_000);
    check((await cdp.eval(rowTitle(A))) === AUTO(1), 'the rail shows the automatic title first');

    // 1. Rail: the pencil on hover.
    check(!(await cdp.eval(visible(`.sr-rn[data-session-id="${A}"]`))), 'the rail pencil is hidden at rest');
    await cdp.hover(row(A));
    check(await cdp.eval(visible(`.sr-rn[data-session-id="${A}"]`)), 'hovering the row shows the pencil');
    await cdp.shot('01-rail-hover-pencil');

    // 2. Rail: rename with Enter.
    await cdp.click(`.sr-rn[data-session-id="${A}"]`);
    await waitFor(cdp, focusedEditor, 'the rail editor to take focus');
    check(await cdp.eval(`document.activeElement.value === ${JSON.stringify(AUTO(1))} && document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length`), 'the editor opens holding the title, all selected');
    await cdp.shot('02-rail-editor-open');
    await cdp.type('Vox: Carrier Bridge contact');
    await cdp.shot('03-rail-editor-typed');
    await cdp.key('Enter', 'Enter', 13);
    await waitFor(cdp, `${rowTitle(A)} === 'Vox: Carrier Bridge contact'`, 'the rail row to show the new name');
    check(names()[A]?.title === 'Vox: Carrier Bridge contact', 'the name was saved to session-names.json');
    check(!(await cdp.eval(`Boolean(document.querySelector('.sr-rename'))`)), 'the editor closed');
    await cdp.unhover();
    await cdp.shot('04-rail-renamed');

    // 3. Window header: opening the session shows the name; its pencil on hover.
    await cdp.click(row(A));
    await waitFor(cdp, `${headerTitle(A)} === 'Vox: Carrier Bridge contact'`, 'the window header to show the name');
    check(true, 'the window header shows the custom name');
    await cdp.unhover();
    check(!(await cdp.eval(visible(`${header(A)} .ti-rn`))), 'the header pencil is hidden at rest');
    await cdp.hover(`${header(A)} .wh`);
    check(await cdp.eval(visible(`${header(A)} .ti-rn`)), 'hovering the header shows its pencil');
    await cdp.shot('05-header-hover-pencil');

    // 4. Escape changes nothing.
    await cdp.click(`${header(A)} .ti-rn`);
    await waitFor(cdp, focusedEditor, 'the header editor to take focus');
    await cdp.shot('06-header-editor-open');
    await cdp.type('Something I will not keep');
    await cdp.key('Escape', 'Escape', 27);
    await waitFor(cdp, `!document.querySelector('${header(A)} .ti-input')`, 'the header editor to close');
    check((await cdp.eval(headerTitle(A))) === 'Vox: Carrier Bridge contact' && names()[A]?.title === 'Vox: Carrier Bridge contact', 'Escape kept the name as it was');

    // 5. An empty name brings the automatic title back, in the header and the rail.
    await cdp.hover(`${header(A)} .wh`);
    await cdp.click(`${header(A)} .ti-rn`);
    await waitFor(cdp, focusedEditor, 'the header editor again');
    await cdp.key('Backspace', 'Backspace', 8);
    await cdp.shot('07-header-editor-empty');
    await cdp.key('Enter', 'Enter', 13);
    await waitFor(cdp, `${headerTitle(A)} === ${JSON.stringify(AUTO(1))} && ${rowTitle(A)} === ${JSON.stringify(AUTO(1))}`, 'the automatic title to come back');
    check(!names()[A], 'clearing removed the saved name');

    // 6. The right-click menu's Rename, saved by clicking away.
    await cdp.click(row(B), 'right');
    await waitFor(cdp, `[...document.querySelectorAll('.sr-menu-item')].some((el) => el.textContent.trim() === 'Rename')`, 'the menu with Rename');
    await sleep(150);
    check(await cdp.eval(`(() => { const r = document.querySelector('.sr-menu').getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })()`), 'the menu opened near the bottom edge stays inside the window');
    await cdp.shot('08-rail-menu-rename');
    await cdp.eval(`[...document.querySelectorAll('.sr-menu-item')].find((el) => el.textContent.trim() === 'Rename').click()`);
    await waitFor(cdp, focusedEditor, 'the editor from the menu');
    await cdp.type('Storage cleanup agents');
    await cdp.click('.stage, main, body');
    await waitFor(cdp, `${rowTitle(B)} === 'Storage cleanup agents'`, 'the blur save');
    check(names()[B]?.title === 'Storage cleanup agents', 'clicking away saved the name');

    // 7. Pat's maximized grid: 12 windows, about 272px a cell.
    await cdp.size(SIZES.max);
    for (let n = 1; n <= COUNT; n += 1) {
      const id = uuid(n);
      if (!(await cdp.eval(`Boolean(document.querySelector('${header(id)}'))`))) {
        const ok = await cdp.eval(`(() => { const el = document.querySelector('${row(id)}'); if (!el) return false; el.scrollIntoView({ block: 'nearest' }); return true; })()`);
        if (ok) await cdp.click(row(id));
      }
    }
    const open = await cdp.eval(`document.querySelectorAll('.win2:not(.slot)').length`);
    step(`${open} windows open`);
    await cdp.hover(`${header(B)} .wh`);
    const fit = await cdp.eval(`(() => {
      const win = document.querySelector('${header(B)}');
      const wr = win.getBoundingClientRect();
      const inside = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= wr.left - 0.5 && r.right <= wr.right + 0.5 && r.top >= wr.top - 0.5 && r.bottom <= wr.bottom + 0.5; };
      const pencil = win.querySelector('.ti-rn');
      const controls = [...win.querySelectorAll('.wh-ctl button')];
      return { cell: Math.round(wr.width), pencil: Boolean(pencil) && inside(pencil), controls: controls.length, controlsInside: controls.every(inside), title: win.querySelector('.ti')?.textContent };
    })()`);
    step(`grid cell ${fit.cell}px, ${fit.controls} header controls`);
    check(open >= 9 && fit.pencil && fit.controlsInside && fit.title === 'Storage cleanup agents', `at ${fit.cell}px a cell the pencil and all ${fit.controls} header controls stay inside the window`);
    const rect = await cdp.eval(`(() => { const r = document.querySelector('${header(B)}').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: Math.min(r.height, 160) }; })()`);
    await cdp.shot('09-grid-header-hover', rect);
    await cdp.click(`${header(B)} .ti-rn`);
    await waitFor(cdp, focusedEditor, 'the editor in a narrow cell');
    await cdp.shot('10-grid-header-editor', rect);
    await cdp.key('Escape', 'Escape', 27);
    await cdp.unhover();
    await cdp.shot('11-grid-full');

    check(cdp.errors.length === 0, `no page exceptions${cdp.errors.length ? `: ${cdp.errors.join(' | ')}` : ''}`);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) failure = failed.map((c) => c.label).join('; ');
  } catch (error) {
    failure = error.stack || String(error);
    // What the page showed when it failed: a capture and the visible text.
    try {
      await cdpRef?.shot('zz-failure');
      fs.writeFileSync(path.join(OUT, 'zz-failure.txt'), String(await cdpRef?.eval('document.body.innerText.slice(0, 4000)')));
    } catch { /* the page is gone */ }
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
    try { daemon.kill(); } catch { /* already gone */ }
    await sleep(500);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  process.stdout.write(`${failure ? 'FAIL' : 'PASS'} (${checks.filter((c) => c.ok).length}/${checks.length} checks)\nfailure: ${failure || '(none)'}\nscreenshots: ${OUT}\n`);
  process.exit(failure ? 1 : 0);
}

main();
