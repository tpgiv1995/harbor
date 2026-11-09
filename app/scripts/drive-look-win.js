'use strict';

// Visual capture drive for the desktop look. An ISOLATED Harbor (tmp userData and
// state, its own relocated sessiond that dies with this process, every plan on an
// empty home) is born offscreen by main's HARBOR_E2E rule, fed one pinned test model
// through the E2E hooks, and photographed at every size and layout that matters. It
// never touches the real daemon, the real ~/.harbor or the screen.
//
// The sizes are the ones the user runs: 956x574 at 1.8 (a 1721x1033 window at 120%
// zoom), about 1422x889 at 1.8 (maximized), 1906x908 and 1600x1000. Emulation carries
// the device scale; Playwright's setViewportSize silently resets it.
//
// Usage (from app/, after `npx vite build`):
//   node scripts/drive-look-win.js --out <dir> [--scenes s1,s2] [--sizes pat,max,mock,wide]
// Scenes: windows (0,1,2,6,16 windows at each size), rail (hidden, widest, long titles),
// states (run states, stop, queued, attachments, slash, question), menus, surfaces.
// A scene's assertions are geometry only; the captures are read by a person.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const { SessionClient } = require('../src/daemon/client.js');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = Number(process.env.DRIVE_LOOK_PORT || 9383);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'harbor-drive-look')));
const SCENES = arg('scenes', 'windows,rail,states,menus,cards').split(',');
const SIZE_TABLE = {
  pat: { width: 956, height: 574, scale: 1.8 },
  max: { width: 1422, height: 889, scale: 1.8 },
  mock: { width: 1906, height: 908, scale: 1 },
  wide: { width: 1600, height: 1000, scale: 1 },
};
const SIZES = arg('sizes', 'pat,max,mock,wide').split(',').filter((s) => SIZE_TABLE[s]);
const step = (label) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${label}\n`);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'exception');
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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout on ${method}`)); }
      }, 30_000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`page threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result.value;
  }

  async size({ width, height, scale }) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await sleep(350);
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    step(`captured ${name}`);
    return file;
  }

  async hover(selector) {
    const box = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!box) return false;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(220);
    return true;
  }

  async unhover() {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await sleep(120);
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.eval(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(200);
  }
}

// Plan letters and colours exercise every badge style, including the black plan with
// white text. Provider profiles carry no real account.
const PROFILES = [
  ['personal', 'Personal', 'P', '#6FA8D8', null, 'claude', true],
  ['team', 'Team', 'T', '#D68A5A', null, 'claude'],
  ['work', 'Work', 'S', '#F962BA', null, 'claude'],
  ['renew', 'Renew', 'R', '#2563FF', null, 'claude'],
  ['green', 'Green', 'G', '#0A843D', null, 'claude'],
  ['ivory', 'Ivory', 'I', '#E8E6DF', null, 'claude'],
  ['black', 'Black', 'X', '#000000', '#FFFFFF', 'claude'],
  ['codex', 'Codex', 'C', '#10A37F', null, 'codex'],
  ['codex2', 'Codex 2', 'H', '#7E8CF0', null, 'codex'],
];

const PROJECTS = ['harbor', 'console', 'reports', 'sweeps', 'survey-tools', 'tpg', 'mobile', 'site', 'pipeline', 'billing', 'data-maps', 'carrier-tools', 'notes-wiki', 'media', 'loss-runs', 'renewals'];
const TITLES = [
  'Harbor perf hunt: poll storm and the 15 MB list',
  'Carrier console cut 3: rail and top bar',
  'Renewals board filter',
  'Commission one-pager, version 3',
  'Exit interview themes for October',
  'Hero text jumps on first load',
  'Phone composer one card',
  'Marketing page recut with a very long title that has to clip at the edge of the header',
  'Pipeline retries',
  'Billing corrections packet',
  'Census diagnostics',
  'Login manager adds a new carrier and a much longer name than usual',
  'Wiki lint',
  'Launch film storyboard',
  'Loss run importer',
  'Renewal reminders',
];
const MODELS = [['Opus 5.5', 'opus', 'xhigh'], ['Fable 5.1', 'opus', 'xhigh'], ['Sonnet 5.5', 'sonnet', 'high'], ['GPT-6 Astra', 'other', 'high'], ['Composer', 'other', null], ['Opus 5.5', 'opus', 'high']];

const PAGE_DRIVER = (appDir) => `
(() => {
  const NOW = Date.now();
  const CWD = ${JSON.stringify(appDir.replace(/\\/g, '/'))};
  const PROJECTS = ${JSON.stringify(PROJECTS)};
  const TITLES = ${JSON.stringify(TITLES)};
  const MODELS = ${JSON.stringify(MODELS)};
  const HOMES = ['personal', 'team', 'work', 'renew', 'green', 'ivory', 'black', 'codex', 'codex2', 'personal', 'green', 'black', 'team', 'work', 'ivory', 'personal'];
  const providerFor = (i) => (i === 7 || i === 8 ? 'codex' : i === 4 ? 'cursor' : 'claude');
  const sid = (i) => 'look-' + String(i + 1).padStart(2, '0');
  const row = (i, extra = {}) => {
    const provider = providerFor(i);
    return {
      id: sid(i), project: PROJECTS[i % PROJECTS.length], title: TITLES[i % TITLES.length], firstPrompt: TITLES[i % TITLES.length],
      lastActive: new Date(NOW - i * 240000).toISOString(), lastActiveMs: NOW - i * 240000,
      home: provider === 'cursor' ? null : HOMES[i % HOMES.length], provider, model: null,
      isLive: i % 5 !== 3, paneId: i % 5 !== 3 ? 'p' + i : null, workspaceId: i % 5 !== 3 ? 'w' + i : null,
      agentStatus: null, isWindowsEra: false, isChildTask: false, childTitle: null, cwd: CWD + '/' + i, isHistorical: true, dormant: i % 5 === 3,
      ...extra,
    };
  };
  const model = (count, extra = {}) => {
    const rows = Array.from({ length: Math.max(count, 16) }, (_, i) => row(i, extra[i] || {}));
    const groups = new Map();
    for (const s of rows) { if (!groups.has(s.project)) groups.set(s.project, []); groups.get(s.project).push(s); }
    return JSON.parse(JSON.stringify({
      projects: [...groups].map(([label, sessions]) => ({ label, sessions, sessionCount: sessions.length, lastActiveMs: sessions[0].lastActiveMs,
        hasLive: sessions.some((s) => s.isLive), isWindowsEra: false, isOrchestration: false, isDateGroup: false, displayDayMs: null, newSessionCwd: CWD })),
      liveProjects: [], grouping: 'project',
    }));
  };
  const DIFF = [
    { t: 'ctx', s: '  function publishModel(next) {' },
    { t: 'del', s: "-   send('sidebar:model', next);" },
    { t: 'add', s: '+   const delta = diffModel(lastSent, next);' },
    { t: 'add', s: '+   if (!delta.changed) return;' },
    { t: 'add', s: "+   send('sidebar:patch', delta);" },
    { t: 'ctx', s: '    lastSent = next;' },
    { t: 'ctx', s: '  }' },
  ];
  const blocks = (i) => {
    let k = 0;
    const key = () => sid(i) + '-b' + (k += 1);
    const out = [];
    if (i % 3 === 2) out.push({ key: key(), kind: 'user', text: 'The team wants this filtered by account manager, and the filter should stick per user.', ts: new Date(NOW - 600000).toISOString(), turnMeta: { outputTokens: 7800, durationMs: 110000 } });
    out.push({ key: key(), kind: 'assistant', text: 'Two things account for nearly all of it. The rail asks for the whole session list on a timer even when nothing changed, and each answer is about 15 MB, so the main process builds and copies it twice a second.' });
    out.push({ key: key(), kind: 'action', verb: 'Read', chip: 'sidebar-bridge.js', status: 'done' }, { key: key(), kind: 'action', verb: 'Ran', chip: 'npm test -- main', status: 'done', pill: { tone: 'good', text: '412 passed' } });
    out.push({ key: key(), kind: 'assistant', text: 'The rail now gets only **what changed**. A refresh with nothing new sends nothing at all, and the fix is in \`docs/orchestration/perf\`:\\n\\n- one list per process\\n- no timer when idle' });
    out.push({ key: key(), kind: 'action', verb: 'Edited', chip: 'app/src/main/sidebar-bridge.js', status: 'done', cv: '+38 -11', diff: DIFF });
    out.push({ key: key(), kind: 'user', text: 'Round 3 review: file identity holds on every fast path. One defect remains; details are in reviews/round-3.md.', peer: true, peerFrom: 'Reviewer' });
    out.push({ key: key(), kind: 'assistant', text: 'Reviewer is right about the older answer. I reproduced it and fixed the reset, then ran the main-process suite and the live probe with ten windows open.' });
    if (i % 2 === 0) out.push({ key: key(), kind: 'note', text: 'Context compacted. Earlier turns are summarized.' });
    return out;
  };
  const header = (i, extra = {}) => {
    const [name, tone, effort] = MODELS[i % MODELS.length];
    return { model: { name, tone }, effort, contextPct: [53, 12, 74, 18, 41, 9][i % 6], contextTokens: 200000, working: false, processAlive: true, lastWriteMs: NOW - 30000, cacheTouchedMs: NOW - 400000, cacheTtlMs: 3600000, ...extra };
  };
  const push = (m) => { window.__setSidebarModelForTest(m); window.__setRailModelForTest?.(structuredClone(m)); };
  window.__look = {
    sid, row, model, blocks, header, push,
    install(count) { push(model(count)); return true; },
    feed(count, opts = {}) {
      for (let i = 0; i < count; i += 1) window.__setTranscriptForTest(sid(i), { blocks: opts.blocks?.[i] || blocks(i), header: header(i, opts.header?.[i] || {}) });
      return true;
    },
    open(count) {
      for (let i = 0; i < count; i += 1) window.__harborOpenSession(sid(i));
      return true;
    },
    close() { for (const b of document.querySelectorAll('.win2 .tile-close')) b.click(); return true; },
  };
  return 'installed';
})()
`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-look-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const projectsDir = path.join(tmp, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const claudeHome = path.join(tmp, 'claude-home');
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
  const config = {
    paths: { projectsDir, cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json'), notesFile: path.join(tmp, 'notes.json'), boardsDir: path.join(tmp, 'boards'), projectIconsDir: path.join(tmp, 'project-icons') },
    profiles: PROFILES.map(([id, label, letter, color, textColor, provider, isDefault]) => ({
      id, label, letter, color, ...(textColor ? { textColor } : {}), provider, configHome: claudeHome, email: null, isDefault: Boolean(isDefault),
    })),
    setup: { completed: true, completedAt: null, appVersion: null },
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));
  // Statusline tee samples, so the Plans panel shows real bars, including a nearly
  // full plan and a capped one.
  fs.mkdirSync(config.paths.cacheDir, { recursive: true });
  const fiveHours = (Date.now() + 5400_000) / 1000;
  const week = (Date.now() + 86400_000 * 4) / 1000;
  [[0, 44], [0, 100], [51, 51], [0, 99], [7, 56], [31, 60], [0, 71]].forEach(([fh, wk], i) => {
    fs.writeFileSync(path.join(config.paths.cacheDir, `usage-${PROFILES[i][0]}.json`), JSON.stringify({
      updated_at: new Date().toISOString(),
      account_email: null,
      rate_limits: { five_hour: { used_percentage: fh, resets_at: fiveHours }, seven_day: { used_percentage: wk, resets_at: week } },
      cost: { total_cost_usd: 1.25 },
    }));
  });

  const store = path.join(tmp, 'sessiond');
  fs.mkdirSync(store, { recursive: true });
  const socketPath = path.join(store, 'daemon.sock');
  const namespace = `harbor-look-drive-${process.pid}`;
  const daemon = spawn(guiNodeExec, [path.join(APP_DIR, 'src', 'daemon', 'daemon.js')], {
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: namespace },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let daemonErr = '';
  daemon.stderr.on('data', (chunk) => { daemonErr += chunk; });
  for (const deadline = Date.now() + 15_000; ;) {
    try { const probe = new SessionClient({ socketPath }); const r = await probe.request('health'); probe.close(); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`isolated daemon never answered: ${daemonErr}`);
    await sleep(100);
  }

  const env = {
    ...process.env, HARBOR_E2E: '1', HARBOR_E2E_USER_DATA: userData, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_SESSIOND_JOB_NAMESPACE: namespace, HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_NO_ICON_GEN: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_TITLER: '1', HARBOR_NO_VOICE: '1',
    HARBOR_CLI_UPDATES_FILE: path.join(tmp, 'cli-updates.json'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const renderer = arg('renderer', null);
  if (renderer) env.VITE_DEV_SERVER_URL = require('node:url').pathToFileURL(path.resolve(renderer)).href;
  const antiThrottle = SCENES.includes('gpu') ? ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'] : [];
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal', ...antiThrottle], {
    env, windowsHide: true, stdio: ['ignore', fs.openSync(path.join(OUT, 'electron.log'), 'w'), fs.openSync(path.join(OUT, 'electron.err.log'), 'w')],
  });

  let failure = '';
  const problems = [];
  try {
    let target = null;
    for (let i = 0; i < 720 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('the isolated Harbor never exposed a page');
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitFor(cdp, 'typeof window.__setSidebarModelForTest === "function" && typeof window.__setRailModelForTest === "function"', 'the E2E model hooks', 90_000);
    await cdp.eval(PAGE_DRIVER(APP_DIR));
    step('harness installed');

    const show = async (count, size, opts = {}) => {
      await cdp.eval('window.__look.close()');
      await sleep(200);
      await cdp.eval(`window.__look.install(${count})`);
      await sleep(250);
      await cdp.eval(`window.__look.feed(${count}, ${JSON.stringify(opts)})`);
      await cdp.eval(`window.__look.open(${count})`);
      await cdp.size(size);
      await sleep(count > 2 ? 700 : 400);
      if (count) await waitFor(cdp, `document.querySelectorAll('.win2').length === ${count}`, `${count} windows`, 20_000);
      await sleep(300);
    };
    const geometry = () => cdp.eval(`(() => {
      const out = [];
      for (const w of document.querySelectorAll('.win2')) {
        const r = w.getBoundingClientRect();
        for (const name of ['.pj', '.ti', '.tile-close']) {
          const el = w.querySelector(name);
          if (!el) { out.push(name + ' missing'); continue; }
          const b = el.getBoundingClientRect();
          if (b.right > r.right + 0.5 || b.left < r.left - 0.5 || b.width <= 0) out.push(name + ' outside window ' + w.dataset.sessionId);
        }
      }
      return out;
    })()`);

    if (SCENES.includes('windows')) {
      for (const sizeName of SIZES) {
        for (const count of [0, 1, 2, 6, 16]) {
          await show(count, SIZE_TABLE[sizeName]);
          for (const p of await geometry()) problems.push(`${sizeName}/${count}: ${p}`);
          await cdp.shot(`win-${sizeName}-${String(count).padStart(2, '0')}`);
        }
      }
    }
    if (SCENES.includes('rail')) {
      const size = SIZE_TABLE.pat;
      await show(6, size);
      await cdp.eval("document.querySelector('.rail')?.style.setProperty('--rail-width', '278px')");
      await sleep(200);
      await cdp.shot('rail-pat-278');
      await cdp.eval("document.querySelector('.rail')?.style.setProperty('--rail-width', '420px')");
      await sleep(200);
      await cdp.shot('rail-pat-420');
      await cdp.eval("document.querySelector('.rail')?.style.removeProperty('--rail-width')");
      await cdp.eval("window.dispatchEvent(new CustomEvent('harbor-rail-toggle'))");
      await sleep(300);
      await cdp.shot('rail-hidden');
      await cdp.eval("window.dispatchEvent(new CustomEvent('harbor-rail-toggle'))");
      await sleep(300);
    }
    if (SCENES.includes('menus')) {
      for (const [sizeName, size] of [['pat', SIZE_TABLE.pat], ['mock', SIZE_TABLE.mock]]) {
        await show(2, size);
        const click = (sel) => cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
        const esc = async () => { await cdp.eval("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"); await sleep(250); };
        for (const [name, sel] of [['plus', '.ubar .attach'], ['cap', '.ubar-status .mswitch'], ['app', '.app-menu-btn'], ['planusage', 'button[aria-label="Plan usage"]']]) {
          if (!await click(sel)) { problems.push(`${sizeName}: no ${sel}`); continue; }
          await sleep(700);
          await cdp.shot(`menu-${sizeName}-${name}`);
          await esc();
          await cdp.eval("for (const b of document.querySelectorAll('.menu-backdrop,.app-menu-backdrop')) b.click();");
          await sleep(200);
        }
        await click('.compose-format-toggle');
        await sleep(250);
        await cdp.shot(`composer-${sizeName}-format-open`);
        await click('.compose-format-toggle');
        await sleep(200);
      }
    }
    if (SCENES.includes('states')) {
      const size = SIZE_TABLE.mock;
      await show(6, size, { header: { 0: { working: true, workingText: 'Running npm test' }, 1: { blocked: true }, 3: { processAlive: false, working: false, lastWriteMs: Date.now() - 3600000 } } });
      await cdp.eval("document.querySelector('.win2[data-session-id=\"look-01\"]').click();");
      await sleep(400);
      await cdp.shot('states-working-selected-stop');
      await cdp.eval("document.querySelector('.win2[data-session-id=\"look-02\"]').click();");
      await sleep(400);
      await cdp.shot('states-blocked-selected');
      await cdp.eval("document.querySelector('.win2[data-session-id=\"look-04\"]').click();");
      await sleep(400);
      await cdp.shot('states-dead-resume');
      await cdp.hover('.titlebar-btn-close');
      await cdp.shot('states-hover-close');
      await cdp.unhover();
      await cdp.hover('.rm-row');
      await cdp.hover('.sr');
      await cdp.shot('states-hover-row');
      await cdp.unhover();
    }
    if (SCENES.includes('cards')) {
      const size = SIZE_TABLE.mock;
      const askFor = (id) => ({ id: `ask-${id}`, sessionId: id, kind: 'ask', answered: false, questions: [
        { question: 'Which plans should the renewal filter apply to?', header: 'Plans', multiSelect: true, options: [{ index: 0, label: 'Medical', description: 'Fully insured and level funded' }, { index: 1, label: 'Dental', description: 'All carriers' }, { index: 2, label: 'Vision', description: 'All carriers' }] },
        { question: 'Should the filter stay on between visits?', header: 'Sticky', multiSelect: false, options: [{ index: 0, label: 'Keep it per user (Recommended)', description: 'Each person sees their last choice' }, { index: 1, label: 'Reset each visit', description: 'Always starts empty' }] },
      ] });
      const permFor = (id) => ({ id: `perm-${id}`, sessionId: id, kind: 'permission', answered: false, prompt: { toolName: 'Edit', displayTool: 'Edit file', persistent: { label: 'Yes, and allow edits this session' }, toolInput: { file_path: 'app/src/main/sidebar-bridge.js', old_string: "send('sidebar:model', next);", new_string: "send('sidebar:patch', delta);" } } });
      await show(2, size, { header: { 0: { blocked: true }, 1: { blocked: true } } });
      await cdp.eval(`window.__setAsksForTest(${JSON.stringify([askFor('look-01'), permFor('look-02')])})`);
      await sleep(500);
      await cdp.shot('cards-ask-and-permission');
      await cdp.eval("[...document.querySelectorAll('.askf-chat')][0]?.click()");
      await sleep(500);
      await cdp.shot('cards-question-reply-banner');
      await cdp.eval('window.__setAsksForTest([])');
      await sleep(200);
      await show(2, size, { header: { 0: { working: true, workingText: 'Running npm test' } } });
      await cdp.eval("document.querySelector('.win2[data-session-id=\"look-01\"]').click();");
      await cdp.eval(`window.__setSendStateForTest('look-01', { phase: 'idle', queue: { items: [{ id: 'q1', status: 'queued', textPreview: 'Also rerun the phone checks when that finishes' }] } })`);
      await sleep(500);
      await cdp.shot('composer-queued-stop');
      await cdp.eval("window.__setSendStateForTest('look-01', null)");
      await show(2, size);
      await cdp.eval("document.querySelector('.win2[data-session-id=\"look-02\"]').click(); window.dispatchEvent(new CustomEvent('harbor-focus-composer'));");
      await sleep(300);
      await cdp.eval(`(() => {
        const el = document.querySelector('.ubar [contenteditable="true"]');
        el.focus();
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([png], 'renewal-board.png', { type: 'image/png' }));
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      })()`);
      await sleep(900);
      await cdp.send('Input.insertText', { text: 'Add this to the renewal board and check the filter still sticks.' });
      await sleep(400);
      await cdp.shot('composer-attachment-typed');
      await cdp.eval("document.querySelector('.ubar [contenteditable=\"true\"]').textContent=''; document.querySelector('.ubar [contenteditable=\"true\"]').dispatchEvent(new InputEvent('input',{bubbles:true}));");
      await sleep(200);
      await cdp.send('Input.insertText', { text: '/' });
      await sleep(700);
      await cdp.shot('composer-slash-suggestions');
      await show(2, size, {});
      await cdp.eval("window.__look.push(window.__look.model(2, { 1: { isChildTask: true, isLive: false, paneId: null } }))");
      await sleep(600);
      await cdp.eval("document.querySelector('.win2[data-session-id=\"look-02\"]').click();");
      await sleep(400);
      await cdp.shot('window-read-only-worker');
      await show(2, size, {});
      await cdp.eval("[...document.querySelectorAll('.win2[data-session-id=\"look-01\"] .wh-ctl button')].find((b) => b.textContent.trim() === '>_')?.click()");
      await sleep(1200);
      await cdp.shot('window-terminal-view');
    }
    if (SCENES.includes('contrast')) {
      // Writes the background with all text hidden, plus every visible text run with
      // its colour and box. contrast-check (a separate reader) compares the two.
      for (const sizeName of SIZES) {
        for (const count of [1, 2, 6]) {
          await show(count, SIZE_TABLE[sizeName], { header: { 0: { working: true, workingText: 'Running npm test' }, 1: { blocked: true } } });
          const runs = await cdp.eval(`(() => {
            const out = [];
            // Colours from color-mix arrive as oklab(); the canvas hands back plain sRGB.
            const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
            const toRgb = (color) => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = color; paint.fillRect(0, 0, 1, 1); const d = paint.getImageData(0, 0, 1, 1).data; return 'rgba(' + d[0] + ', ' + d[1] + ', ' + d[2] + ', ' + (d[3] / 255) + ')'; };
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
              const text = n.textContent.trim();
              if (!text) continue;
              const el = n.parentElement;
              const cs = getComputedStyle(el);
              if (cs.visibility === 'hidden' || cs.display === 'none') continue;
              const range = document.createRange();
              range.selectNodeContents(n);
              const b = range.getBoundingClientRect();
              if (b.width < 2 || b.height < 2 || b.right <= 0 || b.bottom <= 0 || b.left >= innerWidth || b.top >= innerHeight) continue;
              let opacity = 1;
              for (let e = el; e; e = e.parentElement) opacity *= parseFloat(getComputedStyle(e).opacity);
              if (opacity <= 0.01) continue;
              // Text scrolled out of its pane sits under whatever covers that spot; only
              // text the eye can see counts.
              const hit = document.elementFromPoint(Math.min(b.left + b.width / 2, innerWidth - 1), Math.min(b.top + b.height / 2, innerHeight - 1));
              if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
              out.push({ text: text.slice(0, 40), cls: String(el.className || '').slice(0, 60), tag: el.tagName, x: b.left, y: b.top, w: b.width, h: b.height, color: toRgb(cs.color), size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), opacity });
            }
            return JSON.stringify({ dpr: devicePixelRatio, width: innerWidth, height: innerHeight, runs: out });
          })()`);
          fs.writeFileSync(path.join(OUT, `contrast-${sizeName}-${count}.json`), runs);
          await cdp.eval(`(() => { const s = document.createElement('style'); s.id = 'contrast-hide'; s.textContent = '*{color:transparent!important;-webkit-text-fill-color:transparent!important;caret-color:transparent!important;text-shadow:none!important}'; document.head.appendChild(s); })()`);
          await sleep(250);
          await cdp.shot(`contrast-${sizeName}-${count}`);
          await cdp.eval("document.getElementById('contrast-hide').remove()");
        }
      }
    }
    if (SCENES.includes('shortcut')) {
      const size = SIZE_TABLE.mock;
      await show(2, size);
      await cdp.eval("document.querySelector('.win2[data-session-id=\"look-02\"]').click(); window.dispatchEvent(new CustomEvent('harbor-focus-composer'));");
      await sleep(400);
      await cdp.send('Input.insertText', { text: 'draft stays put' });
      await sleep(200);
      const press = async () => {
        for (const type of ['rawKeyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 1 });
        await sleep(450);
      };
      const state = () => cdp.eval(`(() => { const on = document.querySelector('.grid4.focus-mode'); const shown = [...document.querySelectorAll('.win2')].filter((w) => w.getBoundingClientRect().width > 0).map((w) => w.dataset.sessionId); const box = document.querySelector('.ubar [contenteditable="true"]'); return JSON.stringify({ on: Boolean(on), shown, draft: box.innerText.trim(), active: document.activeElement?.className || '', fullscreen: Boolean(document.fullscreenElement) }); })()`);
      const before = JSON.parse(await state());
      await press();
      const inComposer = JSON.parse(await state());
      await cdp.shot('shortcut-alt-enter-focused');
      await press();
      const back = JSON.parse(await state());
      await cdp.eval("[...document.querySelectorAll('.win2[data-session-id=\"look-02\"] .wh-ctl button')].find((b) => b.textContent.trim() === '>_')?.click()");
      await sleep(900);
      await cdp.eval("document.querySelector('.win2[data-session-id=\"look-02\"] .terminal-pane textarea')?.focus()");
      await sleep(200);
      const inTerminalFocus = await cdp.eval("document.activeElement?.tagName + '.' + document.activeElement?.className");
      await press();
      const inTerminal = JSON.parse(await state());
      await press();
      step(JSON.stringify({ before, inComposer, back, inTerminalFocus, inTerminal }));
      if (before.on) problems.push('focus mode was already on');
      if (!inComposer.on || inComposer.shown.join() !== 'look-02') problems.push(`Alt+Enter from the composer did not focus the selected window: ${JSON.stringify(inComposer)}`);
      if (inComposer.draft !== 'draft stays put') problems.push(`Alt+Enter changed the draft: ${JSON.stringify(inComposer.draft)}`);
      if (back.on || back.shown.length !== 2) problems.push(`a second Alt+Enter did not restore the grid: ${JSON.stringify(back)}`);
      if (!inTerminal.on) problems.push(`Alt+Enter from a raw terminal did not focus the window (focus was on ${inTerminalFocus})`);
    }
    if (SCENES.includes('drag')) {
      // A window held mid-drag: the glass must stay in register with the ground.
      await show(6, SIZE_TABLE.mock);
      const from = await cdp.eval("(() => { const r = document.querySelector('.win2[data-session-id=\"look-02\"] .wh-top .pj').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()");
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'right', buttons: 2, clickCount: 1 });
      for (let i = 1; i <= 12; i += 1) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 22, y: from.y + i * 26, button: 'right', buttons: 2 });
        await sleep(30);
      }
      await sleep(300);
      step(`dragging class present: ${await cdp.eval("Boolean(document.querySelector('.win2.dragging'))")}`);
      await cdp.shot('window-mid-drag');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x + 264, y: from.y + 312, button: 'right', buttons: 0, clickCount: 1 });
      await sleep(400);
    }
    if (SCENES.includes('gpu')) {
      // Six windows, one working, then the same with one conversation scrolling.
      // Off-screen compositing needs the anti-throttle switches set at launch.
      const measure = (label) => {
        const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(APP_DIR, 'scripts', 'measure-process-gpu.ps1')}" -Match "${APP_DIR.replace(/\\/g, '\\')}" -Seconds 16`, { encoding: 'utf8', windowsHide: true }).trim();
        step(`GPU ${label}: ${out}`);
      };
      await show(6, SIZE_TABLE.mock, { header: { 0: { working: true, workingText: 'Running npm test' } } });
      await sleep(4000);
      measure('idle six windows');
      await cdp.eval(`(() => { const el = [...document.querySelectorAll('.win2')][1].querySelector('.conv-body, .conv, [class*=conv]'); const scrollers = [...document.querySelectorAll('.win2 *')].filter((n) => n.scrollHeight > n.clientHeight + 20 && getComputedStyle(n).overflowY !== 'visible'); window.__s = scrollers[0]; let d = 1; window.__t = setInterval(() => { if (!window.__s) return; window.__s.scrollTop += d * 40; if (window.__s.scrollTop <= 0 || window.__s.scrollTop + window.__s.clientHeight >= window.__s.scrollHeight - 1) d = -d; }, 16); return Boolean(window.__s); })()`);
      await sleep(1000);
      measure('one conversation scrolling');
      await cdp.eval('clearInterval(window.__t)');
    }
    failure = problems.join('; ');
    if (cdp.errors.length) step(`page errors: ${cdp.errors.slice(-5).join(' | ')}`);
    ws.close();
  } catch (error) {
    failure = [error.message, ...problems].join('; ');
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch { /* already gone */ }
    try { daemon.kill(); } catch { /* already gone */ }
    await sleep(500);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  process.stdout.write(`${failure ? 'FAIL' : 'PASS'}\nfailure: ${failure || '(none)'}\nscreenshots: ${OUT}\n`);
  process.exit(failure ? 1 : 0);
}

main();
