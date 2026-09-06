'use strict';

// Drive the black-screen boot recovery end to end (2026-08-29 incident shape).
//
// Pat launched Harbor at 23:15:35 while an agent session's `npm run build` was
// replacing dist/: index.html loaded, its hashed main chunk did not, React
// never mounted, and the window sat on the body background (#0b0c0f) forever.
// dist/ was whole again at 23:19:53 and the window was STILL black at 23:26,
// because the only recovery paths (the renderer's update ribbon, the
// render-process-gone reload) all need a renderer that mounted.
//
// This drive reproduces that state against the REAL dist (main chunk briefly
// renamed aside), asserts the black window, restores the chunk, and then
// demands the app heal ITSELF: no reload is ever injected over CDP. At
// pre-fix HEAD the heal step fails; with main/boot-recovery.js wired it must
// pass. Isolated userData + offscreen (HARBOR_E2E) throughout, port 9341.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const DIST = path.join(APP_DIR, 'dist');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9341;

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

  async mounted() {
    // Passive read only: the page must never be nudged by the probe itself.
    const result = await this.send('Runtime.evaluate', {
      expression: '(() => { const r = document.getElementById("root"); return r ? r.children.length : -1; })()',
      returnByValue: true,
    }).catch(() => null);
    return (result?.result?.value ?? -1) > 0;
  }
}

async function main() {
  const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const chunkMatch = indexHtml.match(/src="\.\/(assets\/main-[^"]+\.js)"/);
  if (!chunkMatch) throw new Error('dist/index.html has no main chunk reference; run npm run build first');
  const chunk = path.join(DIST, chunkMatch[1]);
  const hidden = `${chunk}.drive-hidden`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-boot-recovery-'));
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

  fs.renameSync(chunk, hidden);
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

    // 1. The incident state: index.html up, main chunk missing, nothing mounts.
    await sleep(6000);
    check(!(await cdp.mounted()), 'broken dist boots to an unmounted (black) window');

    // 2. The build "finishes": dist is whole again. Nobody clicks anything.
    fs.renameSync(hidden, chunk);

    // 3. The app must come back on its own.
    let healed = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !healed) {
      await sleep(1000);
      healed = await cdp.mounted();
    }
    check(healed, 'window heals itself within 45s of dist returning (no manual reload)');

    // 4. The crash door (adversarial review, 2026-08-30): a HEALTHY window
    // whose renderer dies while a build is mid-wipe gets reloaded by the
    // crash recovery onto the broken dist. The boot watch must re-arm on
    // that path, or this is the same black window through a different door.
    if (healed) {
      fs.renameSync(chunk, hidden);
      await cdp.send('Page.crash').catch(() => { /* the target dies with the renderer */ });
      await sleep(3000); // let render-process-gone fire and the reload land broken
      fs.renameSync(hidden, chunk);

      // The crash may have torn down the CDP target; reconnect fresh.
      let rehealed = false;
      const crashDeadline = Date.now() + 60000;
      while (Date.now() < crashDeadline && !rehealed) {
        await sleep(1500);
        try {
          const t2 = await connect(PORT, 5000);
          const ws2 = new globalThis.WebSocket(t2.webSocketDebuggerUrl);
          await new Promise((res, rej) => { ws2.addEventListener('open', res); ws2.addEventListener('error', rej); });
          const cdp2 = new Cdp(ws2);
          rehealed = await cdp2.mounted();
          ws2.close();
        } catch { /* renderer still down; keep waiting */ }
      }
      check(rehealed, 'a crash-reload onto a broken dist still heals once dist returns');
    }
  } finally {
    if (fs.existsSync(hidden)) fs.renameSync(hidden, chunk);
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
