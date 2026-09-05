'use strict';

const { execFileSync, execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { markdownToHtml, markdownToPlainText } = require('../src/shared/markdown-html.cjs');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const NOTES_CLI = path.resolve(APP_DIR, '..', 'bin', 'harbor-notes');
const PORT = 9337;
const OUT = path.join(os.tmpdir(), 'harbor-drive-notes');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}: ${pending.expression || ''}`));
      else pending.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, expression: params.expression?.slice(0, 120) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await cdp.eval(expression);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function key(cdp, keyName, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, modifiers });
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-notes-drive-'));
  const userData = path.join(tmp, 'userData');
  const notesFile = path.join(tmp, 'notes.json');
  fs.mkdirSync(userData, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.paths = { ...config.paths, cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json') };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  const env = {
    ...process.env,
    HARBOR_E2E: '1',
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_NOTES_FILE: notesFile,
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
  const results = [];
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const mark = (message) => {
    console.log(`[notes drive] ${message}`);
    fs.appendFileSync(path.join(OUT, 'progress.txt'), `${message}\n`);
  };
  let cdp = null;

  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json());
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* CDP is still starting */ }
    }
    if (!target) throw new Error('CDP target never appeared');
    const socket = await new Promise((resolve, reject) => {
      const candidate = new WebSocket(target.webSocketDebuggerUrl);
      candidate.addEventListener('open', () => resolve(candidate));
      candidate.addEventListener('error', () => reject(new Error('websocket connection failed')));
    });
    cdp = new Cdp(socket);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    mark('CDP connected');

    const park = `Add-Type -Name W -Namespace P -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 2560, 1600, 0x0014) }`;
    mark('parking window');
    execFileSync('powershell', ['-NoProfile', '-Command', park], { stdio: 'ignore', timeout: 10_000 });
    mark('window parked');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 2560, height: 1600, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, "Boolean(document.querySelector('.view-switch-btn'))", 'view switch');
    mark('view switch ready');

    const tabMeasures = [];
    for (const width of [292, 268, 228]) {
      const measure = await cdp.eval(`(() => {
        const rail = document.querySelector('.rail');
        rail.style.flex = '0 0 ${width}px';
        rail.style.width = '${width}px';
        rail.style.minWidth = '${width}px';
        rail.style.maxWidth = '${width}px';
        const sw = document.querySelector('.view-switch');
        const buttons = [...sw.querySelectorAll('.view-switch-btn')];
        return ({
          rail: Math.round(rail.getBoundingClientRect().width),
          control: Math.round(sw.getBoundingClientRect().width),
          scroll: sw.scrollWidth,
          client: sw.clientWidth,
          height: Math.round(sw.getBoundingClientRect().height),
          buttons: buttons.map((button) => Math.round(button.getBoundingClientRect().width)),
        });
      })()`);
      tabMeasures.push(measure);
      check(measure.scroll <= measure.client + 1, `view switch overflowed at ${width}px`);
    }
    results.push(`tabs 292/268/228: ${JSON.stringify(tabMeasures)}`);
    await cdp.shot('01-five-tabs');
    mark('tab measurements captured');

    await cdp.eval(`([...document.querySelectorAll('.view-switch-btn')].find((button) => button.textContent.trim() === 'Notes')).click()`);
    await waitFor(cdp, "Boolean(document.querySelector('.notes-view'))", 'Notes view');
    mark('Notes view open');
    await cdp.shot('02-notes-empty');
    await cdp.eval("document.querySelector('.notes-new-btn').click()");
    await waitFor(cdp, "Boolean(document.querySelector('.notes-compose-editor'))", 'note editor');
    mark('note created');
    await cdp.eval("document.querySelector('.fmt-bullets').click(); document.querySelector('.notes-compose-editor').focus()");
    await cdp.send('Input.insertText', { text: 'first item' });
    await key(cdp, 'Enter');
    await key(cdp, 'b', 2);
    await cdp.send('Input.insertText', { text: 'bold word' });
    await key(cdp, 'b', 2);
    await sleep(700);
    const markdown = await cdp.eval("document.querySelector('.notes-compose-editor').innerText");
    results.push(`real editor text: ${JSON.stringify(markdown)}`);
    await cdp.shot('03-real-editor-list-bold');
    mark('real editor input complete');

    await cdp.eval("document.querySelector('.notes-copy-primary').click()");
    await waitFor(cdp, "document.querySelector('.notes-copy-primary').textContent.includes('Copied for pasting')", 'success copy state');
    const saved = JSON.parse(fs.readFileSync(notesFile, 'utf8')).notes[0];
    const payload = { html: markdownToHtml(saved.body), text: markdownToPlainText(saved.body) };
    const channel = await cdp.eval(`window.harbor.clipboard.writeFormatted(${JSON.stringify(payload)})`);
    mark('copy channel returned');
    check(channel.ok === true, `formatted copy channel returned ${JSON.stringify(channel)}`);
    await cdp.shot('04-copy-success');

    const html = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -TextFormatType Html'], { encoding: 'utf8' });
    const text = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' });
    mark('OS clipboard read complete');
    check(/<ul[>\s]/i.test(html), 'OS clipboard HTML flavor has no ul fragment');
    check(/<strong[>\s]/i.test(html), 'OS clipboard HTML flavor has no strong fragment');
    check(/- /.test(text), 'OS clipboard text flavor has no bullet marker');
    results.push(`clipboard channel=${JSON.stringify(channel)} html ul=${/<ul[>\s]/i.test(html)} strong=${/<strong[>\s]/i.test(html)} text bullet=${/- /.test(text)}`);

    execFileSync(process.execPath, [NOTES_CLI, 'add', '--title', 'probe', 'outside edit'], { env, encoding: 'utf8' });
    await waitFor(cdp, "[...document.querySelectorAll('.notes-item-title')].some((node) => node.textContent === 'probe')", 'outside CLI note', 2000);
    mark('outside edit observed');
    await cdp.shot('05-outside-edit-live');
    results.push('outside harbor-notes add appeared within 2 seconds');
  } finally {
    await sleep(300);
    try {
      await Promise.race([
        cdp?.eval('window.harbor.e2e.quit()'),
        sleep(2000).then(() => { throw new Error('quit timed out'); }),
      ]);
    } catch { /* app may already be gone */ }
    await sleep(300);
    try { child.kill(); } catch { /* already gone */ }
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
  console.error('DRIVE FAILED:', error.stack || error.message);
  process.exit(2);
});
