'use strict';

// Drive the renderer heap under sustained sidebar + transcript churn and demand
// that it stays FLAT (2026-09-06 renderer OOM, 0xE0000008).
//
// The heap snapshot that named the leak (renderer-1788724715976-1745MB) was
// ~2000 retained copies of the sidebar model: millions of plain session-row
// objects reachable only through a chain of V8 closure contexts. Every render
// of the root App allocates one context holding EVERY captured variable (the
// fresh model, its sessions-by-id Map, the transcripts Map), and a memoized
// callback from an older render keeps that older context alive; with dozens
// of memoized callbacks whose deps change at different times, the chain runs
// back to boot. Main publishes a full model ~2/sec under live sessions, so the
// renderer retained ~0.25-0.7MB per update until the 3.5GB V8 ceiling.
//
// This drive is the proof: push N fresh models and transcript updates through
// the real App (via the HARBOR_E2E test hooks), force a GC over CDP, and
// measure the heap. At pre-fix HEAD the heap grows linearly with pushes; with
// the chain broken it must stay within a couple of model sizes. Isolated
// userData + offscreen (HARBOR_E2E) throughout, port 9342. No window is ever
// shown or focused.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9342;
const ROWS = Number(process.env.LEAK_ROWS || 2000);
const WARMUP = Number(process.env.LEAK_WARMUP || 40);
const PUSHES = Number(process.env.LEAK_PUSHES || 200);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function connect(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const target = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
      if (target) return target;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  throw new Error('no CDP page target');
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

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }

  async heapMB() {
    // Two full GCs: the first drops the App's dead render contexts, the second
    // collects what the first freed (weak maps, finalizers).
    await this.send('HeapProfiler.collectGarbage');
    await sleep(200);
    await this.send('HeapProfiler.collectGarbage');
    const usage = await this.send('Runtime.getHeapUsage');
    return usage.usedSize / 1048576;
  }
}

// Installed in the page: builds a FRESH model each call (new objects, new
// strings, the way IPC structured-clone delivers one) and pushes it through the
// same setter the real sidebar:update path uses, then pushes a transcript
// update so the render cadence mixes the two the way live sessions do.
const PAGE_DRIVER = `
(() => {
  const ROWS = ${ROWS};
  const PROJECTS = 40;
  const prompt = 'You are writing a session journal for a Claude Code session. '.repeat(8);
  let seq = 0;
  function freshModel() {
    seq += 1;
    const projects = [];
    for (let p = 0; p < PROJECTS; p++) {
      const sessions = [];
      const perProject = Math.floor(ROWS / PROJECTS);
      for (let s = 0; s < perProject; s++) {
        const n = p * perProject + s;
        sessions.push({
          id: 'sess-' + n,
          project: 'proj-' + p,
          title: 'Session ' + n + ' title',
          firstPrompt: prompt,
          lastActive: new Date(1700000000000 + n * 1000).toISOString(),
          lastActiveMs: 1700000000000 + n * 1000 + seq,
          home: ['personal', 'team', 'work'][n % 3],
          provider: n % 5 === 0 ? 'codex' : 'claude',
          model: null,
          isLive: n % 97 === 0,
          paneId: n % 97 === 0 ? 'pane-' + n : null,
          workspaceId: n % 97 === 0 ? 'ws-' + n : null,
          agentStatus: n % 97 === 0 ? (seq % 2 ? 'working' : 'idle') : null,
          isWindowsEra: true,
          isChildTask: false,
          childTitle: null,
          cwd: 'C:/dev/proj-' + p,
          isHistorical: true,
        });
      }
      projects.push({
        label: 'proj-' + p, sessions, sessionCount: sessions.length,
        lastActiveMs: sessions[sessions.length - 1].lastActiveMs,
        hasLive: sessions.some((s) => s.isLive), isWindowsEra: true, isOrchestration: false,
        isDateGroup: false, displayDayMs: null, newSessionCwd: 'C:/dev/proj-' + p,
      });
    }
    // Round-trip through JSON so every string is a fresh heap string, as a
    // structured-clone IPC delivery makes them.
    return JSON.parse(JSON.stringify({ projects, liveProjects: ['proj-0'], grouping: 'project' }));
  }
  let blocks = [];
  function freshTranscript() {
    blocks = blocks.concat([{ key: 'b' + seq, kind: 'assistant', text: 'assistant prose ' + seq }]).slice(-240);
    return { blocks: blocks.slice(), header: { model: 'claude-opus-4-8' } };
  }
  // MessageChannel, not setTimeout: the E2E window is offscreen, and Chromium
  // throttles hidden-page timers to one per second (one per minute after five
  // minutes), which turned 480 ticks into an eight-minute crawl. React's own
  // scheduler posts on a MessageChannel for the same reason, and FIFO ordering
  // means its already-queued render task runs before this tick resolves.
  const tick = () => new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); r(); };
    ch.port2.postMessage(0);
  });
  window.__leakDrive = {
    async push(count) {
      for (let i = 0; i < count; i++) {
        window.__setSidebarModelForTest(freshModel());
        await tick();
        window.__setTranscriptForTest('sess-0', freshTranscript());
        await tick();
      }
      return seq;
    },
  };
  return 'installed';
})()
`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-render-leak-'));
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
  try {
    child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
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

    const target = await connect(PORT);
    const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('HeapProfiler.enable');

    // Wait for the App to mount and expose its test hooks.
    let ready = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !ready) {
      await sleep(500);
      ready = await cdp.evaluate('typeof window.__setSidebarModelForTest === "function" && typeof window.__setTranscriptForTest === "function"').catch(() => false);
    }
    check(ready, 'App mounted with the HARBOR_E2E test hooks');
    if (!ready) throw new Error('renderer never exposed the test hooks');

    check((await cdp.evaluate(PAGE_DRIVER)) === 'installed', 'page driver installed');

    // Measure one model's own weight so the bound is stated in model sizes.
    const empty = await cdp.heapMB();
    await cdp.evaluate('window.__leakDrive.push(1)');
    const one = await cdp.heapMB();
    const modelMB = Math.max(0.5, one - empty);
    console.log(`heap after mount ${empty.toFixed(1)}MB; one model ~${modelMB.toFixed(2)}MB (${ROWS} rows)`);

    await cdp.evaluate(`window.__leakDrive.push(${WARMUP})`);
    const base = await cdp.heapMB();
    await cdp.evaluate(`window.__leakDrive.push(${PUSHES})`);
    const after = await cdp.heapMB();
    const growth = after - base;
    const perPush = growth / PUSHES;
    console.log(`heap after ${WARMUP} pushes ${base.toFixed(1)}MB; after ${WARMUP + PUSHES} pushes ${after.toFixed(1)}MB; growth ${growth.toFixed(1)}MB = ${(perPush * 1024).toFixed(0)}KB per push`);

    // Bounded retention: a few models' worth of slack for React's double
    // buffering and the deferred cleanup, never a linear climb. At pre-fix HEAD
    // this reads ~one model per push.
    check(growth < 3 * modelMB + 8, `heap growth over ${PUSHES} model+transcript pushes stays under 3 model sizes (+8MB): ${growth.toFixed(1)}MB vs ${(3 * modelMB + 8).toFixed(1)}MB`);
    check(perPush < 0.1, `retained per push under 100KB: ${(perPush * 1024).toFixed(0)}KB`);
  } finally {
    try { child?.kill(); } catch { /* already gone */ }
    await sleep(400);
    try { child?.kill('SIGKILL'); } catch { /* fine */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S)`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('DRIVE FAILED:', error.message);
  process.exit(1);
});
