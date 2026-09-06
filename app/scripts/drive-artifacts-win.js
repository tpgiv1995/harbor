'use strict';

// Windows prod-drive for the Artifacts view: spawns an ISOLATED Harbor
// instance (tmp userData so every isolation guard engages, tmp caches, no
// daemon start, real transcript roots read-only), parks its window off the
// visible desktop, and drives the real renderer over CDP with Node's global
// WebSocket. This is the seed of the Windows e2e port: the Linux xvfb harness
// runs on no machine, and "the gate will catch it" is false for anything only
// a live window can show (2026-08-22, the Files-view convoy).
//
// Usage: node scripts/drive-artifacts-win.js  (from app/; writes screenshots
// and a verdict to %TEMP%\harbor-drive-artifacts\)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9333;
const OUT = path.join(os.tmpdir(), 'harbor-drive-artifacts');

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
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    return r.result.value;
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
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

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });

  // Seed config from the real shared file with every writable path redirected
  // into the sandbox; transcripts stay the REAL corpus, read-only by role.
  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  const cacheDir = path.join(tmp, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  realConfig.paths = {
    ...realConfig.paths,
    cacheDir,
    tasksFile: path.join(tmp, 'tasks.json'),
    projectIconsDir: path.join(tmp, 'project-icons'),
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(realConfig, null, 2));
  const artifactsCache = path.join(cacheDir, 'artifacts-index.json');
  try {
    fs.copyFileSync(path.join(os.homedir(), '.cache', 'harbor', 'artifacts-index.json'), artifactsCache);
  } catch { /* cold is fine, just slower */ }

  const env = {
    ...process.env,
    HARBOR_E2E: '1',
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_ARTIFACTS_ROOTS: path.join(os.homedir(), '.claude', 'projects'),
    HARBOR_ARTIFACTS_CACHE: artifactsCache,
    HARBOR_ARTIFACT_THUMBS_DIR: path.join(tmp, 'thumbs'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
  };
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env, stdio: 'ignore', detached: false,
  });
  const results = [];
  const fail = [];
  try {
    // Attach to the app page.
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
        target = list.find((t) => t.type === 'page' && !/devtools/.test(t.url));
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

    // Electron implements no CDP window management on either endpoint, so the
    // park is Win32: move the window off the visible desktop without
    // activating it (SWP_NOACTIVATE|SWP_NOZORDER), the same never-over-the-
    // game posture as every scripted relaunch on this machine.
    const { execSync } = require('node:child_process');
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1900, 1200, 0x0014) }"`, { stdio: 'ignore' });

    await waitFor(cdp, "document.querySelector('.view-switch-btn') ? true : false", 'view switch');
    await cdp.eval("document.querySelector('.view-switch-btn[aria-label=\"Files\"]').click(); true");

    // The headline claim: cards must paint promptly from the warm cache.
    const t0 = Date.now();
    await waitFor(cdp, "document.querySelectorAll('.artifact-card').length > 0", 'first cards', 20_000);
    const firstPaintMs = Date.now() - t0;
    const baseCards = await cdp.eval("document.querySelectorAll('.artifact-card').length");
    results.push(`first cards in ${firstPaintMs}ms (visible=${baseCards})`);
    if (firstPaintMs > 3000) fail.push(`first paint took ${firstPaintMs}ms`);
    await cdp.shot('1-project-grouping');

    // Search narrows and the subtitle reports the match count.
    await cdp.eval(`(() => {
      const input = document.querySelector('.artifacts-search');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'png');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    const searched = await cdp.eval("document.querySelectorAll('.artifact-card').length");
    const subtitle = await cdp.eval("document.querySelector('.artifacts-subtitle').textContent");
    results.push(`search 'png': visible=${searched}, subtitle='${subtitle.trim()}'`);
    if (!/matching/.test(subtitle)) fail.push('subtitle missing match count');
    if (!(searched > 0 && searched <= baseCards)) fail.push('search did not narrow');
    await cdp.shot('2-search-png');
    await cdp.eval(`(() => {
      const input = document.querySelector('.artifacts-search');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    // Group by day: date headers, no project icons.
    await cdp.eval("[...document.querySelectorAll('.artifacts-opts button')].find(b => b.textContent.trim() === 'Day').click(); true");
    await sleep(400);
    const dayHeads = await cdp.eval("[...document.querySelectorAll('.artifacts-group-label')].map(e => e.textContent.trim()).slice(0, 4)");
    results.push(`day groups: ${JSON.stringify(dayHeads)}`);
    if (!dayHeads.some((h) => /Today|Yesterday|, /.test(h))) fail.push('day headers not date-shaped');
    await cdp.shot('3-group-day');

    // Flat + oldest: no headers, order flips.
    await cdp.eval("[...document.querySelectorAll('.artifacts-opts button')].find(b => b.textContent.trim() === 'None').click(); true");
    await sleep(300);
    const flatHeads = await cdp.eval("document.querySelectorAll('.artifacts-group-head').length");
    const firstNewest = await cdp.eval("document.querySelector('.artifact-card .artifact-name')?.textContent");
    await cdp.eval("[...document.querySelectorAll('.artifacts-opts button')].find(b => b.textContent.trim() === 'Oldest').click(); true");
    await sleep(300);
    const firstOldest = await cdp.eval("document.querySelector('.artifact-card .artifact-name')?.textContent");
    results.push(`flat: headers=${flatHeads}, first(newest)='${firstNewest}', first(oldest)='${firstOldest}'`);
    if (flatHeads !== 0) fail.push('flat mode still shows group headers');
    if (firstNewest === firstOldest) fail.push('sort flip did not reorder');
    await cdp.shot('4-flat-oldest');

    // Persistence: reload keeps Day+Oldest? We left groupBy=None; reload and check.
    await cdp.send('Page.reload');
    await sleep(3000);
    await waitFor(cdp, "document.querySelector('.view-switch-btn') ? true : false", 'view switch after reload');
    await cdp.eval("document.querySelector('.view-switch-btn[aria-label=\"Files\"]').click(); true");
    await waitFor(cdp, "document.querySelectorAll('.artifacts-opts button').length > 0", 'toolbar after reload');
    const persisted = await cdp.eval("[...document.querySelectorAll('.artifacts-opts button.active')].map(b => b.textContent.trim())");
    results.push(`persisted after reload: ${JSON.stringify(persisted)}`);
    if (!persisted.includes('None') || !persisted.includes('Oldest')) fail.push('group/sort choice did not persist');
    await cdp.shot('5-persisted');

    // No CDP Browser.close in Electron either; the finally block kills the child.
  } finally {
    await sleep(1000);
    try { child.kill(); } catch { /* already gone */ }
  }

  const verdict = fail.length ? `FAIL\n${fail.join('\n')}` : 'PASS';
  const report = `${verdict}\n\n${results.join('\n')}\nscreenshots: ${OUT}\n`;
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('DRIVE FAILED:', e.message); process.exit(2); });
