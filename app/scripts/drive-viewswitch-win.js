'use strict';

// Windows production drive for the six-view rail switch. It uses an isolated
// userData directory and writable stores, then measures the real rendered row.

const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasksModel = require('../src/shared/tasks-model.cjs');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9339;
const OUT = path.join(os.tmpdir(), 'harbor-drive-viewswitch');
const LABELS = ['Agents', 'Tasks', 'Notes', 'Board', 'Orch', 'Files'];

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
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-viewswitch-drive-'));
  const userData = path.join(tmp, 'userData');
  const notesFile = path.join(tmp, 'notes.json');
  const boardsDir = path.join(tmp, 'boards');
  const tasksFile = path.join(tmp, 'tasks.json');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });

  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.orchestration = { ...config.orchestration, enabled: true };
  config.paths = {
    ...config.paths,
    cacheDir: path.join(tmp, 'cache'), tasksFile,
    projectIconsDir: path.join(tmp, 'project-icons'), notesFile, boardsDir,
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  const now = Date.now();
  const doc = tasksModel.emptyDoc(now);
  doc.tasks.push({
    id: 'drive-overdue', listId: doc.lists[0].id, parentId: null, depth: 0,
    title: 'Overdue drive task', notes: '', done: false, completedAt: null,
    completedBy: null, starred: false, myDayDate: null, dueDate: '2020-01-01',
    tags: [], createdAt: now, updatedAt: now, order: 0,
  });
  fs.writeFileSync(tasksFile, JSON.stringify(doc, null, 2));

  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env: {
      ...process.env,
      HARBOR_E2E: '1', HARBOR_E2E_USER_DATA: userData,
      HARBOR_NO_DAEMON_START: '1', HARBOR_NO_ICON_GEN: '1',
      HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_TITLER: '1',
      HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
      HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
      HARBOR_TASKS_FILE: tasksFile, HARBOR_NOTES_FILE: notesFile,
      HARBOR_BOARDS_DIR: boardsDir,
    },
    stdio: 'ignore',
  });

  const results = [];
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };

  try {
    let target;
    for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
      await sleep(500);
      try {
        const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json());
        target = targets.find((item) => item.type === 'page' && !item.url.startsWith('devtools:'));
      } catch {}
    }
    if (!target) throw new Error('CDP target never appeared');
    const socket = await new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.addEventListener('open', () => resolve(ws));
      ws.addEventListener('error', reject);
    });
    const cdp = new Cdp(socket);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // Park the window off the visible desktop WITHOUT activating it
    // (SWP_NOACTIVATE|SWP_NOZORDER). --no-focus-steal only spawns inactive; it
    // does not keep a 1600x1000 window off Pat's screen. Never over the game.
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`, { stdio: 'ignore' });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, "document.querySelectorAll('.view-switch-btn').length === 6", 'six view tabs');
    await waitFor(cdp, "document.querySelector('.view-switch-badge')?.textContent.trim() === '1'", 'overdue badge');

    const initial = await cdp.eval(`([...document.querySelectorAll('.view-switch-btn')].map((button) => ({
      label: button.getAttribute('aria-label'), title: button.title,
      paths: button.querySelectorAll('.vs-glyph path').length,
    })))`);
    results.push(`tabs: ${JSON.stringify(initial)}`);
    check(JSON.stringify(initial.map((item) => item.label)) === JSON.stringify(LABELS), 'tab labels are missing, duplicated, or reordered');
    check(initial.every((item) => item.title && item.paths > 0), 'a tab lost its tooltip or glyph paths');

    const views = [
      ['Agents', '.stagewrap'], ['Tasks', '.tasks-view'], ['Notes', '.notes-view'],
      ['Board', '.excalidraw canvas'], ['Orch', '.orch-picker'], ['Files', '.artifacts-view'],
    ];
    for (const [label, selector] of views) {
      await waitFor(cdp, "document.querySelectorAll('.view-switch-btn').length === 6", `view tabs before ${label}`);
      await cdp.eval(`document.querySelector('.view-switch-btn[aria-label="${label}"]').click(); true`);
      await waitFor(cdp, `Boolean(document.querySelector('${selector}'))`, `${label} pane`, label === 'Board' ? 45000 : 30000);
      const stored = await cdp.eval("localStorage.getItem('harbor-view')");
      check(stored === label.toLowerCase().replace('files', 'artifacts'), `${label} did not persist before reload: ${stored}`);
      await cdp.send('Page.reload');
      await waitFor(cdp, `Boolean(document.querySelector('${selector}'))`, `${label} pane after reload`, label === 'Board' ? 45000 : 30000);
      const active = await cdp.eval("document.querySelector('.view-switch-btn.active')?.getAttribute('aria-label')");
      check(active === label, `${label} did not restore as active after reload: ${active}`);
    }
    results.push('view swaps and reload persistence: six of six');

    for (const width of [292, 268, 228, 190]) {
      await cdp.eval(`(() => {
        const raw = JSON.parse(localStorage.getItem('harbor-rail') || '{}');
        localStorage.setItem('harbor-rail', JSON.stringify({ ...raw, v: 3, width: ${width}, hidden: false }));
        return true;
      })()`);
      await cdp.send('Page.reload');
      await waitFor(cdp, `Math.round(document.querySelector('.rail')?.getBoundingClientRect().width || 0) === ${width}`, `${width}px rail`);
      await sleep(250);
      const measured = await cdp.eval(`(() => {
        const row = document.querySelector('.view-switch');
        const buttons = [...row.querySelectorAll('.view-switch-btn')];
        const active = row.querySelector('.view-switch-btn.active');
        const label = active.querySelector('.vs-label');
        const badge = row.querySelector('.view-switch-badge');
        const glyphs = buttons.map((button) => {
          const box = button.querySelector('.vs-glyph').getBoundingClientRect();
          return { label: button.ariaLabel, w: box.width, h: box.height };
        });
        const badgeBox = badge.getBoundingClientRect();
        const taskBox = row.querySelector('[aria-label="Tasks"]').getBoundingClientRect();
        return {
          rail: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
          client: row.clientWidth, scroll: row.scrollWidth,
          rowHeight: Math.round(row.getBoundingClientRect().height),
          rows: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size,
          active: active.ariaLabel, labelDisplay: getComputedStyle(label).display,
          labelOpacity: Number(getComputedStyle(label).opacity), labelWidth: label.getBoundingClientRect().width,
          glyphs, badge: badge.textContent.trim(),
          badgeInsideTask: badgeBox.right <= taskBox.right + 3,
        };
      })()`);
      results.push(`${width}px: rail=${measured.rail} row=${measured.client}px scroll=${measured.scroll}px height=${measured.rowHeight}px rows=${measured.rows} active=${measured.active} labelWidth=${measured.labelWidth.toFixed(1)} opacity=${measured.labelOpacity} badge=${measured.badge}`);
      check(measured.scroll <= measured.client + 1, `switch overflows at ${width}px: ${measured.scroll}/${measured.client}`);
      check(measured.rows === 1, `switch wraps to ${measured.rows} rows at ${width}px`);
      check(measured.glyphs.every((glyph) => glyph.w > 0 && glyph.h > 0), `a glyph vanished at ${width}px`);
      check(width >= 268 ? measured.labelWidth > 0 && measured.labelOpacity > 0.9 : measured.labelWidth < 1 && measured.labelOpacity < 0.1,
        `active label visibility is wrong at ${width}px`);
      check(measured.badge === '1' && measured.badgeInsideTask, `task badge is missing or misplaced at ${width}px`);
      await cdp.shot(`rail-${width}`);
    }
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
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), `FAIL\n${error.stack || error}\n`);
  console.error('DRIVE FAILED:', error.stack || error);
  process.exit(2);
});
