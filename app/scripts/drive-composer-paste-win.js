'use strict';

// LIVE Windows proof for "it was when i highlighted text in session window of
// file path, hit ctrl + c, then in another session's textbox hit ctrl + v and it
// didnt show up. had to right click and manually hit copy and then paste for it
// to work" (Pat, 2026-11-04).
//
// Cause: the command bar arms its message box whenever the SELECTED SESSION
// changes (CommandBar's armedForRef effect, 2026-07-25). Dragging to highlight
// text in a window that is not selected ends in a click on that window, the
// click selects it, and the effect focused the message box, which moved the
// page's one selection into the box: the highlight was gone before Ctrl+C
// landed, so nothing was copied. Right-click never fires that click, which is
// why right-click Copy worked. SessionTile's own click rule already refused to
// arm while text was highlighted; the session-change effect never asked.
//
// This drive runs an ISOLATED Harbor (tmp userData, config and state, its own
// relocated sessiond that dies with this process, one plan with an empty home,
// port 9348), born hidden and shown inactive off-screen by main's HARBOR_E2E
// rule. Two test sessions are pinned through the E2E hooks. It READS the real
// clipboard and never writes it: no step presses Ctrl+C.
//
// Cases: (A) Ctrl+V into the box inserts the clipboard text; (B) right-click the
// box, then Harbor's own Paste item, inserts it; (C) drag across a path in the
// OTHER session's window: the highlight must still be there, unwiped, at the
// moment Ctrl+C would land.
//
// Usage (from app/): node scripts/drive-composer-paste-win.js [renderer index.html]
// With no argument it loads app/dist (run `npm run build` first). A path loads
// that build instead, through VITE_DEV_SERVER_URL, so a pre-fix build can be
// checked two-sided without touching app/dist.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const { SessionClient } = require('../src/daemon/client.js');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9348;
const OUT = path.join(os.tmpdir(), 'harbor-drive-composer-paste');
const RENDERER = process.argv[2] ? path.resolve(process.argv[2]) : null;

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
    if (withTarget) sessions.unshift(row('sess-focus', 'Focus proof session'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-paste-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  // An EMPTY transcript store: the session under test is a pinned test model,
  // and a cold index of the real store (tens of thousands of files) held the
  // window back for minutes.
  const projectsDir = path.join(tmp, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
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
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-paste-drive-${process.pid}`,
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
    HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-paste-drive-${process.pid}`,
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
    await waitFor(cdp, "Boolean(document.querySelector('.sr[data-session-id=\"sess-focus\"]') || document.querySelector('.pg'))", 'the test project in the rail');
    if (!(await cdp.eval("Boolean(document.querySelector('.sr[data-session-id=\"sess-focus\"]'))"))) {
      await cdp.eval("[...document.querySelectorAll('.pg')].find((g) => /focus-proof/i.test(g.innerText || ''))?.click(); true");
    }
    await waitFor(cdp, "Boolean(document.querySelector('.sr[data-session-id=\"sess-focus\"]'))", 'the test session row');
    step('row visible, selecting it');
    await cdp.eval("document.querySelector('.sr[data-session-id=\"sess-focus\"]').click(); true");
    step('row clicked');
    await waitFor(cdp, "Boolean(document.querySelector('.ubar-input[contenteditable=\"true\"]'))", 'a typeable message box');
    await sleep(800);
    await cdp.eval("(() => { const e = document.querySelector('.ubar-input'); e.focus(); return document.activeElement === e; })()");
    step('box typeable, pasting');
    const clip = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw'], { encoding: 'utf8', windowsHide: true }).replace(/\r?\n$/, '');
    facts.clipboardChars = clip.length;
    const boxText = "document.querySelector('.ubar-input').innerText.replace(/\\n$/, '')";
    const norm = (value) => String(value || '').replace(/\r/g, '').trim();
    // A: Ctrl+V, a real key event through the browser input path.
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 });
    await sleep(500);
    facts.afterCtrlV = { chars: (await cdp.eval(boxText)).length, matches: norm(await cdp.eval(boxText)) === norm(clip), focused: await cdp.eval("document.activeElement === document.querySelector('.ubar-input')") };
    // Clear, then B: right-click the box, click Paste in Harbor's own menu.
    await cdp.eval("(() => { const e = document.querySelector('.ubar-input'); e.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return e.innerText.length; })()");
    await sleep(300);
    const at = await cdp.eval("(() => { const r = document.querySelector('.ubar-input').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()");
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'right', buttons: 2, clickCount: 1 });
    }
    await sleep(800);
    facts.menu = await cdp.eval("(() => { const m = document.querySelector('.ctxmenu'); return m ? { items: [...m.querySelectorAll('button')].map((b) => b.innerText.trim()), visible: getComputedStyle(m).visibility } : null; })()");
    facts.focusWithMenu = await cdp.eval(`({ focused: document.activeElement === document.querySelector('.ubar-input'), active: document.activeElement?.tagName + '.' + (document.activeElement?.className || '') })`);
    const pasteAt = await cdp.eval("(() => { const b = [...document.querySelectorAll('.ctxmenu button')].find((x) => x.innerText.trim() === 'Paste'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await cdp.shot('menu');
    if (pasteAt) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: pasteAt.x, y: pasteAt.y, button: 'left', buttons: 1, clickCount: 1 });
      }
      await sleep(800);
      facts.afterMenuPaste = { chars: (await cdp.eval(boxText)).length, matches: norm(await cdp.eval(boxText)) === norm(clip), focused: await cdp.eval("document.activeElement === document.querySelector('.ubar-input')") };
    }
    await cdp.shot('after-paste');
    if (!clip) failure = 'the clipboard holds no text, nothing to prove';
    else if (!facts.afterCtrlV.matches) failure = `Ctrl+V left ${facts.afterCtrlV.chars} chars in the box (clipboard has ${clip.length})`;
    else if (!pasteAt) failure = `the right-click menu had no Paste: ${JSON.stringify(facts.menu)}`;
    else if (!facts.afterMenuPaste.matches) failure = `menu Paste left ${facts.afterMenuPaste.chars} chars in the box (clipboard has ${clip.length})`;
    // C: Pat's case. Highlight text in ANOTHER session's window (not the
    // selected one) by dragging, then press Ctrl+C. The highlight must still be
    // there when the key lands, or the copy has nothing to copy. Proven without
    // pressing Ctrl+C (that would overwrite the real clipboard): the selection
    // and the focused element are read at the moment the key would land.
    if (!failure) {
      step('cross-window highlight');
      await cdp.eval("document.querySelector('.sr[data-session-id=\"sess-other\"]').click(); true");
      await sleep(800);
      await cdp.eval("document.querySelector('.sr[data-session-id=\"sess-focus\"]').click(); true");
      await sleep(800);
      facts.windows = await cdp.eval("[...document.querySelectorAll('.win2')].map((w) => w.getAttribute('data-session-id') + (w.classList.contains('sel') ? '*' : ''))");
            const SAMPLE = 'C:/dev/example/docs/notes-for-copy.md';
      const spot = await cdp.eval(`(() => {
        const win = document.querySelector('.win2[data-session-id="sess-other"]');
        if (!win) return null;
        const host = win.querySelector('.conv-body') || win;
        const p = document.createElement('p');
        p.className = 'md-p copy-probe';
        p.style.cssText = 'position:relative;z-index:5;font:14px monospace;padding:6px;margin:0;background:#222;color:#eee;white-space:nowrap';
        p.textContent = '${SAMPLE}';
        host.prepend(p);
        const r = p.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(p);
        const rr = range.getBoundingClientRect();
        return { x1: rr.left + 1, x2: rr.right - 1, y: rr.top + rr.height / 2, w: r.width };
      })()`);
      facts.probeSpot = spot;
      if (!spot) failure = 'the second window never opened';
      else {
        await cdp.eval("(() => { const e = document.querySelector('.ubar-input'); e.focus(); return true; })()");
        await cdp.eval("(() => { window.__selSeen = ''; document.addEventListener('selectionchange', () => { const s = window.getSelection().toString(); if (s.length > window.__selSeen.length) window.__selSeen = s; }); return true; })()");
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x1, y: spot.y, button: 'left', buttons: 1, clickCount: 1 });
        for (let i = 1; i <= 8; i += 1) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x1 + ((spot.x2 - spot.x1) * i) / 8, y: spot.y, button: 'left', buttons: 1 });
          await sleep(30);
        }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x2, y: spot.y, button: 'left', buttons: 0, clickCount: 1 });
        facts.atRelease = await cdp.eval("({ selected: window.getSelection().toString(), longestSeenDuringDrag: window.__selSeen })");
        await sleep(600);
        facts.whenCtrlCWouldLand = await cdp.eval(`({
          selected: window.getSelection().toString(),
          active: document.activeElement?.tagName + '.' + (document.activeElement?.className || ''),
          selectedWindow: document.querySelector('.win2.sel')?.getAttribute('data-session-id') || null,
        })`);
        await cdp.shot('cross-window-highlight');
        if (!facts.atRelease.longestSeenDuringDrag.includes('notes-for-copy')) failure = `the drag never highlighted the text (${JSON.stringify(facts.atRelease)})`;
        else if (!facts.whenCtrlCWouldLand.selected.includes('notes-for-copy')) failure = `the highlight was gone before Ctrl+C could copy it: focus went to ${facts.whenCtrlCWouldLand.active}, selection now "${facts.whenCtrlCWouldLand.selected}"`;
      }
    }
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
    console.log('PROOF OK: Ctrl+V and right-click Paste both put the clipboard text in the message box, and a path highlighted in another session window survives until Ctrl+C');
  }
}

main();
