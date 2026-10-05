'use strict';

// Drive the taskbar badge end to end and record what actually reaches the
// window (2026-10-04, Pat: "i dont get the blue / yellow alert numbers
// anymore").
//
// The badge has three stages, and a missing badge can die in any of them: the
// renderer must decide to send a plan, main must accept it, and main must call
// setOverlayIcon. This drive boots the real App offscreen (isolated userData,
// no daemon, HARBOR_E2E), attaches to BOTH processes over CDP (the page for
// state, main's Node inspector for the IPC and the overlay call), and records
// every taskbar-badge:set and every setOverlayIcon while it walks a session
// through blocked -> clear -> blocked under transcript churn. No window is
// ever shown or focused.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PAGE_PORT = 9345;
const MAIN_PORT = 9346;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function target(port, pick, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const found = targets.find(pick);
      if (found) return found;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  throw new Error(`no CDP target on ${port}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  }

  static async open(url) {
    const ws = new globalThis.WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  // cli: main's Node inspector only has require() through the command line API.
  async evaluate(expression, { awaitPromise = false, cli = false } = {}) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, includeCommandLineAPI: cli });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed');
    return result.result.value;
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

// Main process: record every badge IPC and every overlay call, in order.
const MAIN_PROBE = `
(() => {
  const { ipcMain, BrowserWindow } = require('electron');
  const log = globalThis.__badgeLog = [];
  ipcMain.on('taskbar-badge:set', (_event, payload) => {
    log.push({ t: Date.now(), stage: 'ipc', image: Boolean(payload && payload.dataUrl), d: payload && payload.description });
  });
  for (const win of BrowserWindow.getAllWindows()) {
    const original = win.setOverlayIcon.bind(win);
    win.setOverlayIcon = (image, description) => {
      log.push({ t: Date.now(), stage: 'overlay', image: Boolean(image), d: description });
      return original(image, description);
    };
  }
  return BrowserWindow.getAllWindows().length;
})()
`;

// Page: a two-session model, both live and open as windows.
const PAGE_DRIVER = `
(() => {
  const now = Date.now();
  const row = (id, status) => ({
    id, project: 'badge-proj', title: 'Badge ' + id, firstPrompt: 'probe',
    lastActive: new Date(now).toISOString(), lastActiveMs: now,
    home: 'personal', provider: 'claude', model: null,
    isLive: true, paneId: 'pane-' + id, workspaceId: 'ws-' + id, agentStatus: status,
    isWindowsEra: true, isChildTask: false, childTitle: null, cwd: 'C:/dev/badge-proj', isHistorical: true,
  });
  const model = (statusA) => JSON.parse(JSON.stringify({
    projects: [{
      label: 'badge-proj', sessions: [row('sess-a', statusA), row('sess-b', 'working')], sessionCount: 2,
      lastActiveMs: now, hasLive: true, isWindowsEra: true, isOrchestration: false,
      isDateGroup: false, displayDayMs: null, newSessionCwd: 'C:/dev/badge-proj',
    }],
    liveProjects: ['badge-proj'], grouping: 'project',
  }));
  let seq = 0;
  const transcript = (blocked) => {
    seq += 1;
    return { blocks: [{ key: 'b' + seq, kind: 'assistant', text: 'prose ' + seq }], header: { model: 'claude-opus-5-5', blocked } };
  };
  window.__badgeDrive = {
    setup() {
      window.__setSidebarModelForTest(model('idle'));
      return true;
    },
    open() {
      window.__harborOpenSession('sess-a');
      window.__harborOpenSession('sess-b');
      return true;
    },
    // sess-a's question state, through the open transcript's header (the path an open window uses).
    blockA(blocked) {
      window.__setTranscriptForTest('sess-a', transcript(blocked));
      return true;
    },
    // Live churn on the OTHER window, the way a working session streams.
    async churnB(ms, everyMs) {
      const end = Date.now() + ms;
      let n = 0;
      while (Date.now() < end) {
        window.__setTranscriptForTest('sess-b', transcript(false));
        n += 1;
        await new Promise((r) => setTimeout(r, everyMs));
      }
      return n;
    },
    attention() { return window.__harborAttention; },
  };
  return 'installed';
})()
`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-badge-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.paths = {
    ...config.paths,
    cacheDir: path.join(tmp, 'cache'),
    tasksFile: path.join(tmp, 'tasks.json'),
    projectIconsDir: path.join(tmp, 'project-icons'),
    boardsDir: path.join(tmp, 'boards'),
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  const failures = [];
  const check = (condition, message) => {
    console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
    if (!condition) failures.push(message);
  };

  let child = null;
  let page = null;
  let main = null;
  try {
    child = spawn(ELECTRON, [
      `--inspect=${MAIN_PORT}`, APP_DIR, `--remote-debugging-port=${PAGE_PORT}`, '--no-focus-steal',
      // The E2E window is offscreen; without these Chromium throttles hidden-page
      // timers to one per second, which would starve the badge's 250ms coalescing
      // timer for a reason the visible app does not have.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ], {
      env: {
        ...process.env,
        HARBOR_E2E: '1',
        HARBOR_E2E_USER_DATA: userData,
        HARBOR_NO_DAEMON_START: '1',
        HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
        HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
        HARBOR_NO_ICON_GEN: '1',
        HARBOR_NO_USAGE_FETCH: '1',
        HARBOR_NO_TITLER: '1',
        HARBOR_NO_VOICE: '1',
      },
      stdio: 'ignore',
    });

    const pageTarget = await target(PAGE_PORT, (t) => t.type === 'page' && !t.url.startsWith('devtools:'));
    page = await Cdp.open(pageTarget.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    let ready = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !ready) {
      await sleep(500);
      ready = await page.evaluate('typeof window.__setSidebarModelForTest === "function" && typeof window.__harborOpenSession === "function"').catch(() => false);
    }
    check(ready, 'App mounted with the HARBOR_E2E test hooks');
    if (!ready) throw new Error('renderer never exposed the test hooks');

    const mainTarget = await target(MAIN_PORT, () => true);
    main = await Cdp.open(mainTarget.webSocketDebuggerUrl);
    await main.send('Runtime.enable');
    const windows = await main.evaluate(MAIN_PROBE, { cli: true });
    check(windows >= 1, `main probe installed on ${windows} window(s)`);

    check((await page.evaluate(PAGE_DRIVER)) === 'installed', 'page driver installed');
    await page.evaluate('window.__badgeDrive.setup()');
    await sleep(500);
    await page.evaluate('window.__badgeDrive.open()');
    await sleep(1500);

    const logSince = async (t0) => (await main.evaluate('globalThis.__badgeLog')).filter((e) => e.t >= t0);

    // 1. A quiet question: nothing else is moving.
    let t0 = Date.now();
    await page.evaluate('window.__badgeDrive.blockA(true)');
    await sleep(1500);
    let log = await logSince(t0);
    console.log('  quiet blocked:', JSON.stringify(log));
    check(log.some((e) => e.stage === 'ipc' && e.image), 'quiet question: renderer sends an amber badge');
    check(log.some((e) => e.stage === 'overlay' && e.image), 'quiet question: main sets the overlay');

    // 2. Answered: the amber goes. sess-a moved on after the watermark, so it now
    // reads as finished and the badge turns blue rather than clearing.
    t0 = Date.now();
    await page.evaluate('window.__badgeDrive.blockA(false)');
    await sleep(1500);
    log = await logSince(t0);
    console.log('  answered:', JSON.stringify(log));
    check(log.some((e) => e.stage === 'overlay' && String(e.d).startsWith('0 sessions waiting')), 'answered: main replaces the amber overlay');

    // 3. A question while another window streams (a transcript update every 100ms for 4s).
    t0 = Date.now();
    await page.evaluate('window.__badgeDrive.blockA(true)');
    const pushes = await page.evaluate('window.__badgeDrive.churnB(4000, 100)', { awaitPromise: true });
    log = await logSince(t0);
    console.log(`  blocked under churn (${pushes} pushes):`, JSON.stringify(log));
    check(log.some((e) => e.stage === 'ipc' && e.image), 'question under churn: renderer sends the amber badge while the other window streams');
    check(log.some((e) => e.stage === 'overlay' && e.image), 'question under churn: main sets the overlay while the other window streams');
    console.log('  attention:', JSON.stringify(await page.evaluate('window.__badgeDrive.attention()')));
  } finally {
    // The app exits mid-call and never answers, so do not wait on the reply.
    try { page?.send('Runtime.evaluate', { expression: 'window.harbor.e2e && window.harbor.e2e.quit()' }).catch(() => {}); } catch { /* exiting */ }
    page?.close();
    main?.close();
    await sleep(800);
    if (child && child.exitCode === null) { try { child.kill(); } catch { /* gone */ } }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
