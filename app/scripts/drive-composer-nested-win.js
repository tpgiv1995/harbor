'use strict';

// Windows prod-drive for nested list composition (Pat, 2026-08-25). Same
// posture as drive-rail-controls-win.js: an ISOLATED Harbor instance with tmp
// userData and state, the real transcript corpus read-only, no daemon start,
// and a window parked off the visible desktop without activating it.
//
// Usage: node scripts/drive-composer-nested-win.js   (from app/)
// Writes screenshots and a verdict to %TEMP%\harbor-drive-composer\

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9336;
const OUT = path.join(os.tmpdir(), 'harbor-drive-composer');
const TYPED = ['- one', 'one-a', 'one-b', 'two'];
const EXPECTED = '- one\n  - one-a\n  - one-b\n- two';
const METHOD = 'CDP key events for text, Runtime execCommand for list structure';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

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

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
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

async function key(cdp, keyName, { text = '', modifiers = 0, code = '' } = {}) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: keyName, code, text, unmodifiedText: text, modifiers,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: keyName, code, modifiers,
  });
  await sleep(45);
}

async function typeText(cdp, value) {
  for (const character of value) {
    const keyName = character === ' ' ? ' ' : character;
    await key(cdp, keyName, { text: character });
  }
}

async function editCommand(cdp, command) {
  const applied = await cdp.eval(`(() => {
    const editor = document.querySelector('.ubar-input[contenteditable="true"]');
    editor.focus();
    const applied = document.execCommand(${JSON.stringify(command)}, false, null);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'formatIndent' }));
    return applied;
  })()`);
  if (!applied) throw new Error(`execCommand(${command}) was refused`);
  await sleep(90);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-composer-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });

  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  realConfig.paths = {
    ...realConfig.paths,
    cacheDir: path.join(tmp, 'cache'),
    tasksFile: path.join(tmp, 'tasks.json'),
    projectIconsDir: path.join(tmp, 'project-icons'),
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(realConfig, null, 2));

  const env = {
    ...process.env,
    HARBOR_E2E: '1',
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
  };
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env, stdio: 'ignore', detached: false,
  });

  let serialized = '';
  let dom = '';
  let selectedSession = '';
  let failure = '';
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('CDP target never appeared');
    const connect = (url) => new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', () => reject(new Error('ws failed')));
    });
    const cdp = new Cdp(await connect(target.webSocketDebuggerUrl));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // SWP_NOACTIVATE | SWP_NOZORDER keeps the proof away from the desktop.
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`, { stdio: 'ignore' });

    await waitFor(cdp, "document.querySelector('.sidebar-filter-chip') ? true : false", 'the session filter');
    await cdp.eval(`(() => {
      const all = [...document.querySelectorAll('.sidebar-filter-chip')]
        .find((item) => item.textContent.trim() === 'All');
      if (all) all.click();
      return Boolean(all);
    })()`);
    await waitFor(cdp, "document.querySelector('.pg') ? true : false", 'a project row');
    await cdp.eval("document.querySelector('.pg').click(); true");
    await waitFor(cdp, "document.querySelector('.sr:not(:disabled)') ? true : false", 'a real session row');
    selectedSession = await cdp.eval(`(() => {
      const row = document.querySelector('.sr:not(:disabled)');
      row.click();
      return row.getAttribute('data-session-id') || row.dataset.sessionId || '';
    })()`);
    await waitFor(cdp, "document.querySelector('.ubar-input[contenteditable=\"true\"]') ? true : false", 'the real composer');
    await cdp.eval(`(() => {
      const editor = document.querySelector('.ubar-input[contenteditable="true"]');
      editor.focus();
      return document.activeElement === editor;
    })()`);

    await editCommand(cdp, 'insertUnorderedList');
    await typeText(cdp, 'one');
    await editCommand(cdp, 'insertParagraph');
    await editCommand(cdp, 'indent');
    await typeText(cdp, 'one-a');
    await editCommand(cdp, 'insertParagraph');
    await typeText(cdp, 'one-b');
    await editCommand(cdp, 'insertParagraph');
    await editCommand(cdp, 'outdent');
    await typeText(cdp, 'two');
    await sleep(700);

    dom = await cdp.eval("document.querySelector('.ubar-input').innerHTML");
    const stored = await cdp.eval(`(() => {
      const drafts = JSON.parse(localStorage.getItem('harbor-drafts') || '{}');
      const entries = Object.entries(drafts).filter(([, value]) => value && value.text);
      return entries.length ? { id: entries[0][0], text: entries[0][1].text } : { id: '', text: '' };
    })()`);
    selectedSession = stored.id || selectedSession;
    serialized = stored.text;
    await cdp.shot('composer-nested-final');
    if (serialized !== EXPECTED) {
      throw new Error(`serialized draft differed from expected markdown`);
    }
  } catch (error) {
    failure = error.message;
  } finally {
    await sleep(300);
    try { child.kill(); } catch { /* already gone */ }
  }

  const verdict = failure ? 'FAIL' : 'PASS';
  const report = [
    verdict,
    '',
    `typed lines: ${JSON.stringify(TYPED)}`,
    `drive method: ${METHOD}`,
    `expected markdown: ${JSON.stringify(EXPECTED)}`,
    `serialized draft: ${JSON.stringify(serialized)}`,
    `selected session: ${selectedSession || '(unknown)'}`,
    `editor DOM: ${dom || '(unread)'}`,
    `failure: ${failure || '(none)'}`,
    `screenshots: ${OUT}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(failure ? 1 : 0);
}

main().catch((error) => { console.error('DRIVE FAILED:', error.message); process.exit(2); });
