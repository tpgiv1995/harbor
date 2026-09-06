'use strict';

// Drive the restored stage end to end (2026-09-04 incident shape, second act).
//
// The store holds N tiles whose sessions exist in the history corpus. Harbor
// boots, the sidebar model arrives, and the tiles must be ON SCREEN without
// any click. The first fix that evening kept the tiles in the store but Pat's
// restart still showed "Nothing on the stage" until he clicked a rail row, so
// this drive watches the DOM second by second from a cold boot and reports
// when (if ever) the windows appear, and whether the store survived.
//
// Isolated userData + offscreen (HARBOR_E2E), no daemon, a relocated cache so
// the real corpus is scanned cold, port 9342. Tile session ids come from argv
// (real transcript ids from ~/.claude/projects) or default to three of Pat's.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9342;
const IDS = process.argv.slice(2).length ? process.argv.slice(2) : [
  '19e8f9e0-c58c-4ae1-841a-6eda2ad33ca4',
  '0764a849-bd26-47cd-9b8c-962cccd11175',
  '6d4a3451-9eb4-4e25-ad4a-4826693a6e81',
];

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
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
    return result?.result?.value;
  }
}

const PROBE = `(() => {
  const root = document.getElementById('root');
  const grid = document.querySelector('.grid4');
  return {
    mounted: Boolean(root && root.children.length),
    empty: Boolean(document.querySelector('.stage-empty')),
    gridCount: grid ? Number(grid.dataset.gridCount) : 0,
    tiles: document.querySelectorAll('.win2').length,
    railRows: document.querySelectorAll('.sr').length,
    store: localStorage.getItem('harbor-slate-stage'),
    view: localStorage.getItem('harbor-view'),
  };
})()`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-stage-restore-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.paths = {
    ...config.paths,
    cacheDir: path.join(tmp, 'cache'),
    tasksFile: path.join(tmp, 'tasks.json'),
    notesFile: path.join(tmp, 'notes.json'),
    projectIconsDir: path.join(tmp, 'project-icons'),
    boardsDir: path.join(tmp, 'boards'),
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  const failures = [];
  const check = (condition, message) => {
    console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
    if (!condition) failures.push(message);
  };

  const env = {
    ...process.env,
    HARBOR_E2E: '1',
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_PERF_LOG_DIR: path.join(tmp, 'perf'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
    HARBOR_NO_VOICE: '1',
  };

  let child = null;
  try {
    child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], { env, stdio: 'ignore' });
    const target = await connect(PORT);
    const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    // Renderer exceptions and console errors are the only way to see a render
    // that threw; capture them from the start.
    const rendererErrors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') rendererErrors.push(`exception: ${msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text}`);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') rendererErrors.push(`console.error: ${(msg.params.args || []).map((a) => a.value ?? a.description).join(' ')}`);
    });
    await cdp.send('Runtime.enable');

    // Fresh profile: wait for a mount, then seed the store the way a previous
    // run would have left it, and boot again from that store.
    for (let i = 0; i < 40 && !(await cdp.evaluate(PROBE)).mounted; i += 1) await sleep(500);
    const seed = JSON.stringify({
      tiles: IDS.map((sessionId, slot) => ({ sessionId, slot })),
      selectedId: IDS[0],
      focusedId: null,
    });
    const seeded = await cdp.evaluate(`(() => { localStorage.setItem('harbor-slate-stage', ${JSON.stringify(seed)}); localStorage.setItem('harbor-view', 'agents'); return localStorage.getItem('harbor-slate-stage'); })()`);
    check(seeded && JSON.parse(seeded).tiles.length === IDS.length, 'the store was seeded before the reload');
    await cdp.send('Page.reload');
    await sleep(1500);
    await cdp.send('Runtime.enable');

    // Watch the DOM from the reload with NO interaction.
    let first = null;
    let last = null;
    for (let t = 0; t < 40; t += 1) {
      await sleep(1000);
      let probe;
      try { probe = await cdp.evaluate(PROBE); } catch { continue; }
      let mainRows = -1;
      try { mainRows = await cdp.evaluate('window.harbor.sidebar.getState().then((s) => s.historyCount)'); } catch { /* not ready */ }
      last = probe;
      const storeTiles = (() => { try { return JSON.parse(probe.store || 'null')?.tiles?.length ?? 'none'; } catch { return 'bad'; } })();
      console.log(`t=${t + 1}s mounted=${probe.mounted} empty=${probe.empty} grid=${probe.gridCount} tiles=${probe.tiles} railRows=${probe.railRows} mainHistoryRows=${mainRows} storeTiles=${storeTiles} errors=${rendererErrors.length}`);
      if (probe.tiles > 0 && first === null) first = t + 1;
      if (probe.tiles >= IDS.length && probe.railRows > 0) break;
    }
    for (const line of rendererErrors.slice(0, 8)) console.log(`  renderer: ${line.slice(0, 300)}`);
    try {
      const lifecycle = fs.readFileSync(path.join(tmp, 'perf', 'lifecycle.jsonl'), 'utf8').trim().split('\n');
      for (const line of lifecycle.slice(-8)) console.log(`  lifecycle: ${line.slice(0, 300)}`);
    } catch { console.log('  lifecycle: (no file)'); }
    check(last && last.mounted, 'the app mounted after the reload');
    check(last && last.railRows > 0, 'the rail shows session rows (the model arrived)');
    check(first !== null, `restored windows appear on their own (first seen at ${first ?? 'never'}s)`);
    check(last && last.tiles === IDS.length, `all ${IDS.length} restored windows are on screen (saw ${last?.tiles ?? 0})`);
    const stored = last && last.store ? JSON.parse(last.store) : null;
    check(stored && stored.tiles.length === IDS.length, `the store still holds ${IDS.length} tiles (has ${stored?.tiles?.length ?? 0})`);
  } finally {
    if (child) { try { child.kill(); } catch { /* gone */ } }
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (failures.length) {
    console.log(`\n${failures.length} FAILED`);
    process.exit(1);
  }
  console.log('\nALL PASS');
}

main().catch((error) => { console.error(error); process.exit(1); });
