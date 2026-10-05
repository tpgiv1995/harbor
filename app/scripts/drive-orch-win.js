'use strict';

const { spawn, execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9340;
const OUT = path.join(os.tmpdir(), 'harbor-drive-orch');
const SESSION_ID = 'a1000000-0000-4000-8000-000000000001';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'page evaluation failed');
    return response.result.value;
  }
  async shot(name) {
    const response = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(response.data, 'base64'));
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

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-orch-drive-'));
  const userData = path.join(tmp, 'userData');
  const projectsDir = path.join(tmp, 'projects');
  const delegateDir = path.join(tmp, 'delegate');
  const workspace = fs.realpathSync(path.resolve(APP_DIR, '..'));
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(delegateDir, 'queues'), { recursive: true });
  fs.mkdirSync(path.join(delegateDir, 'events'), { recursive: true });
  const transcriptDir = path.join(projectsDir, 'drive-project');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(transcriptDir, `${SESSION_ID}.jsonl`), [
    { type: 'user', sessionId: SESSION_ID, cwd: workspace, timestamp: new Date(now - 60_000).toISOString(), message: { role: 'user', content: 'Drive orchestration status' } },
    { type: 'assistant', sessionId: SESSION_ID, cwd: workspace, timestamp: new Date(now - 50_000).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ready.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');

  const queue = {
    queue_id: 'drive-orch-run', workspace, goal: 'Prove every active batch wears the age of its evidence',
    created_at: new Date(now - 60 * 60_000).toISOString(), updated_at: new Date(now - 2 * 60_000).toISOString(),
    batches: [
      { id: 'working', title: 'Working batch', status: 'active', worker_engine: 'codex', last_dispatched_at: new Date(now - 15 * 60_000).toISOString() },
      { id: 'review', title: 'Finished unreviewed batch', status: 'active', worker_engine: 'claude', last_dispatched_at: new Date(now - 30 * 60_000).toISOString() },
      { id: 'quiet', title: 'Quiet batch', status: 'active', worker_engine: 'cursor', last_dispatched_at: new Date(now - 55 * 60_000).toISOString() },
    ],
  };
  const digest = crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(delegateDir, 'queues', `${digest}.json`), JSON.stringify(queue, null, 2));
  fs.writeFileSync(path.join(delegateDir, 'events', 'drive-orch-run.jsonl'), [
    { t: new Date(now - 2 * 60_000).toISOString(), msg: 'working active signal' },
    { t: new Date(now - 10 * 60_000).toISOString(), msg: 'review worker finished' },
    { t: new Date(now - 45 * 60_000).toISOString(), msg: 'quiet last worker signal' },
  ].map(JSON.stringify).join('\n') + '\n');

  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.orchestration = { ...config.orchestration, enabled: true };
  config.paths = { ...config.paths, projectsDir, delegateStateDir: delegateDir, cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json'), projectIconsDir: path.join(tmp, 'icons') };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env: { ...process.env, HARBOR_E2E: '1', HARBOR_E2E_USER_DATA: userData, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'), HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_NO_ICON_GEN: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_TITLER: '1' },
    stdio: 'ignore',
  });
  const results = [];
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  try {
    let target;
    for (let index = 0; index < 60 && !target; index += 1) {
      await sleep(500);
      try { target = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json())).find((item) => item.type === 'page' && !item.url.startsWith('devtools:')); } catch {}
    }
    if (!target) throw new Error('CDP target never appeared');
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`, { stdio: 'ignore' });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, "[...document.querySelectorAll('.view-switch-btn')].some((button) => button.textContent.trim() === 'Orch')", 'Orch tab');
    await cdp.eval(`localStorage.setItem('harbor-slate-stage', ${JSON.stringify(JSON.stringify({ tiles: [{ sessionId: SESSION_ID, slot: 0 }], selectedId: SESSION_ID }))}); localStorage.setItem('harbor-view', 'orch'); location.reload()`);
    await waitFor(cdp, "document.querySelectorAll('.orch-run-batch').length === 3", 'three overview batches');
    const overview = await cdp.eval("[...document.querySelectorAll('.orch-run-batch')].map((row) => ({ text: row.textContent, quiet: row.classList.contains('quiet') }))");
    const text = overview.map((row) => row.text).join('\n');
    results.push(`overview: ${text}`);
    check(text.includes('working, last signal'), 'working state or signal age missing');
    check(text.includes('awaiting review, last signal'), 'awaiting review state or signal age missing');
    check(text.includes('quiet 45m, possibly hung'), 'quiet state missing');
    check(overview.some((row) => row.quiet), 'quiet batch is not amber');
    await cdp.shot('1-live-runs-overview');

    await cdp.eval("[...document.querySelectorAll('.view-switch-btn')].find((button) => button.textContent.trim() === 'Agents').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.orch-pill'))", 'session orchestration pill');
    const pill = await cdp.eval("({ text: document.querySelector('.orch-pill').textContent, quiet: document.querySelector('.orch-pill').classList.contains('quiet') })");
    results.push(`pill: ${pill.text}`);
    check(/^Orch 0\/3/.test(pill.text), 'pill does not show Orch done/total');
    check(pill.text.includes('last signal'), 'pill omits signal age');
    await cdp.shot('2-session-pill');
    await cdp.eval("document.querySelector('.orch-pill').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.orch-panel') && document.querySelectorAll('.orch-batch-card').length === 3)", 'focused run panel');
    // The fixture workspace is derived from wherever this repo checkout lives,
    // so the assertion must be too; a literal folder name pinned the drive to
    // the worktree it was authored in (caught on the first main-tree run).
    check(await cdp.eval(`document.querySelector('.orch-panel-title').textContent.includes(${JSON.stringify(path.basename(workspace))})`), 'pill did not focus the matching run');
    await cdp.shot('3-pill-focused-run');
  } finally {
    await sleep(500);
    try { child.kill(); } catch {}
  }
  const verdict = failures.length ? `FAIL\n${failures.join('\n')}` : 'PASS';
  const report = `${verdict}\n\n${results.join('\n')}\nscreenshots: ${OUT}\n`;
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), `FAIL\n${error.stack || error.message}\n`);
  console.error(error);
  process.exit(2);
});
