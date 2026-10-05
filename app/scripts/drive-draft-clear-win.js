'use strict';

// LIVE Windows proof for "the message I sent stays in the text box" (Pat,
// 2026-09-28, desktop, while working across many windows).
//
// The composer clears a draft only after the send resolves. The root App's
// callbacks come from renderer/use-callback.js, which always runs the LATEST
// closure, so a clear that ran after an await used whatever window was selected
// THEN, not the window the message was sent from. Switch windows while a send is
// in flight and the sent window keeps its text while the window you switched to
// loses its draft.
//
// This drive reproduces exactly that in the real app: an ISOLATED Harbor
// (tmp userData and state, the real transcript corpus read-only, no daemon
// start), window parked off the visible desktop WITHOUT activating it. The only
// substitution is HARBOR_E2E_FAKE_SEND_MS, which makes main report a send as
// delivered after a delay without touching any pane, so the in-flight window is
// real and deterministic. Everything in the renderer is production code.
//
// Steps: type KEEP-B into window B; select window A, type SENT-A, press Enter;
// switch to B while the send is in flight; after it resolves, B must still hold
// KEEP-B and A must be empty.
//
// Usage (from app/, after `npm run build`):  node scripts/drive-draft-clear-win.js
// Writes screenshots and a verdict to %TEMP%\harbor-drive-draft-clear\

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9338;
const OUT = path.join(os.tmpdir(), 'harbor-drive-draft-clear');
const SEND_MS = 2500;
const KEEP_B = 'KEEPB';
const SENT_A = 'SENTA';

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

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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

async function key(cdp, keyName, { text = '', code = '' } = {}) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, text, unmodifiedText: text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code });
  await sleep(40);
}

const composerReady = "document.querySelector('.ubar-input[contenteditable=\"true\"]') ? true : false";
const composerText = "(document.querySelector('.ubar-input')?.innerText || '').trim()";

// Walk the rail and return the ids of the first N sessions that arm a typeable composer.
async function pickTypeableSessions(cdp, count) {
  const found = [];
  const groups = await cdp.eval("document.querySelectorAll('.pg').length");
  for (let group = 0; group < Math.min(groups, 8) && found.length < count; group += 1) {
    await cdp.eval(`document.querySelectorAll('.pg')[${group}]?.click(); true`);
    await sleep(500);
    const rows = await cdp.eval("document.querySelectorAll('.sr:not(:disabled)').length");
    for (let row = 0; row < Math.min(rows, 12) && found.length < count; row += 1) {
      const id = await cdp.eval(`(() => {
        const target = document.querySelectorAll('.sr:not(:disabled)')[${row}];
        if (!target) return '';
        const sid = target.getAttribute('data-session-id') || '';
        if (!sid || ${JSON.stringify(found)}.includes(sid)) return '';
        target.click();
        return sid;
      })()`);
      if (!id) continue;
      for (let wait = 0; wait < 12; wait += 1) {
        await sleep(250);
        if (await cdp.eval(composerReady)) {
          // A session live in an outside terminal sends through takeover, not the
          // normal send path this drive exercises; skip it.
          await sleep(2000); // liveness settles after selection
          const outside = await cdp.eval("/outside terminal/i.test(document.querySelector('.ubar-input')?.getAttribute('data-placeholder') || '')");
          if (!outside) found.push(id);
          break;
        }
      }
    }
  }
  return found;
}

async function select(cdp, id) {
  const clicked = await cdp.eval(`(() => {
    const row = document.querySelector('.sr[data-session-id=${JSON.stringify(id)}]');
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`rail row for ${id} not visible`);
}

async function typeInto(cdp, value) {
  await cdp.eval("(() => { const e = document.querySelector('.ubar-input[contenteditable=\"true\"]'); e.focus(); return document.activeElement === e; })()");
  for (const character of value) await key(cdp, character, { text: character });
}

const storedDraft = (id) => `(() => {
  const drafts = JSON.parse(localStorage.getItem('harbor-drafts') || '{}');
  return (drafts[${JSON.stringify(id)}] && drafts[${JSON.stringify(id)}].text) || '';
})()`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-draft-drive-'));
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
    HARBOR_E2E_FAKE_SEND_MS: String(SEND_MS),
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
    HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-draft-drive-${process.pid}`,
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
    HARBOR_NO_VOICE: '1',
  };
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], { env, stdio: ['ignore', fs.openSync(path.join(OUT, 'electron.log'), 'w'), fs.openSync(path.join(OUT, 'electron.err.log'), 'w')], detached: false });

  const facts = {};
  let failure = '';
  let live = null;
  try {
    let target = null;
    for (let i = 0; i < 120 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('CDP target never appeared');
    const socket = await new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.addEventListener('open', () => resolve(ws));
      ws.addEventListener('error', () => reject(new Error('ws failed')));
    });
    const cdp = new Cdp(socket);
    live = cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // SWP_NOACTIVATE | SWP_NOZORDER keeps the proof off the visible desktop.
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`, { stdio: 'ignore' });

    await waitFor(cdp, "document.querySelector('.sidebar-filter-chip') ? true : false", 'the session filter');
    await cdp.eval(`(() => {
      const all = [...document.querySelectorAll('.sidebar-filter-chip')].find((i) => i.textContent.trim() === 'All');
      if (all) all.click();
      return Boolean(all);
    })()`);
    await waitFor(cdp, "document.querySelector('.pg') ? true : false", 'a project row');
    const [a, b] = await pickTypeableSessions(cdp, 2);
    if (!a || !b) throw new Error('could not find two sessions with a typeable composer');
    facts.a = a;
    facts.b = b;

    // Window B holds an unsent draft.
    await select(cdp, b);
    await waitFor(cdp, composerReady, 'window B composer');
    await typeInto(cdp, KEEP_B);
    await sleep(300);
    facts.bBefore = await cdp.eval(composerText);

    // Window A: type and send.
    await select(cdp, a);
    await waitFor(cdp, composerReady, 'window A composer');
    await typeInto(cdp, SENT_A);
    await sleep(200);
    facts.aTyped = await cdp.eval(composerText);
    facts.aPlaceholder = await cdp.eval("document.querySelector('.ubar-input')?.getAttribute('data-placeholder') || ''");
    if (/outside terminal/i.test(facts.aPlaceholder)) {
      throw new Error('window A turned out to be live in another terminal; its send would go through takeover, not the path under test');
    }
    await key(cdp, 'Enter', { code: 'Enter', text: '\r' });

    // Switch to B while the send is still in flight.
    await sleep(150);
    await select(cdp, b);
    await sleep(SEND_MS + 1500);
    facts.bComposerAfter = await cdp.eval(composerText);
    facts.bStoredAfter = await cdp.eval(storedDraft(b));
    await cdp.shot('01-window-b-after-send');

    // Back to A: the sent text must be gone.
    await select(cdp, a);
    await sleep(600);
    facts.aComposerAfter = await cdp.eval(composerText);
    facts.aStoredAfter = await cdp.eval(storedDraft(a));
    await cdp.shot('02-window-a-after-send');

    const checks = {
      draftsTyped: facts.bBefore === KEEP_B && facts.aTyped === SENT_A,
      sentWindowCleared: facts.aComposerAfter === '' && facts.aStoredAfter === '',
      otherWindowDraftKept: facts.bComposerAfter === KEEP_B && facts.bStoredAfter === KEEP_B,
    };
    facts.checks = checks;
    const bad = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
    if (bad.length) failure = `failed checks: ${bad.join(', ')}`;
  } catch (error) {
    failure = error.message;
    if (live) { try { await live.shot('99-failure'); } catch { /* page may be gone */ } }
  } finally {
    await sleep(300);
    try { child.kill(); } catch { /* already gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmpdir */ }
  }

  const verdict = failure ? 'FAIL' : 'PASS';
  const report = [
    verdict,
    `window A (sent from): ${facts.a || '?'}  composer after: ${JSON.stringify(facts.aComposerAfter ?? '')}  stored: ${JSON.stringify(facts.aStoredAfter ?? '')}`,
    `window B (switched to): ${facts.b || '?'}  composer after: ${JSON.stringify(facts.bComposerAfter ?? '')}  stored: ${JSON.stringify(facts.bStoredAfter ?? '')}`,
    `checks: ${JSON.stringify(facts.checks || {})}`,
    `failure: ${failure || '(none)'}`,
    `screenshots: ${OUT}`,
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(failure ? 1 : 0);
}

main().catch((error) => { console.error('DRIVE FAILED:', error.message); process.exit(2); });
