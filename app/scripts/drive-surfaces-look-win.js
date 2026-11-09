'use strict';

// Visual capture drive for the page surfaces, menus, dialogs and cards of the desktop look. An ISOLATED Harbor (tmp userData and
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
//   node scripts/drive-surfaces-look-win.js --out <dir> [--scenes pages,menus,cards,explore] [--sizes pat,mock]
// Scenes: pages (Tasks, Notes, Files, Orch), menus (every menu and dialog), cards (answer sheet,
// permission, question forms, window states). Its data is synthetic: tasks, notes and files are
// written into the throwaway profile. The captures are read by a person; assertions are geometry only.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const { SessionClient } = require('../src/daemon/client.js');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = Number(process.env.DRIVE_LOOK_PORT || 9391);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'harbor-drive-look')));
const SCENES = arg('scenes', 'pages,menus,cards').split(',');
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
  ['renew', 'Renew', 'R', '#E5484D', null, 'claude'],
  ['green', 'Green', 'G', '#3EA86F', null, 'claude'],
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

// ---- Synthetic data for the page surfaces -------------------------------------------------

const TASKS = require('../src/shared/tasks-model.cjs');
const NOTES = require('../src/shared/notes-model.cjs');

function seedTasks(file) {
  let doc = TASKS.emptyDoc();
  const ok = (r) => { if (!r.ok) throw new Error(`seed op failed: ${r.reason || r.error}`); return r; };
  const op = (o) => { const r = ok(TASKS.applyOp(doc, o)); doc = r.doc; return r; };
  const work = doc.lists[0].id;
  op({ type: 'list.rename', listId: work, name: 'Work' });
  const home = op({ type: 'list.add', name: 'Home', color: '#6fd39d' }).listId;
  const reading = op({ type: 'list.add', name: 'Reading queue', color: '#a98bff' }).listId;
  const today = TASKS.dayKey(new Date());
  const t1 = op({ type: 'task.add', listId: work, title: 'Reply to the carrier about the renewal packet', myDay: true, starred: true, dueDate: today, tags: ['carriers', 'urgent'], notes: 'They need the signed form back before Thursday.' });
  op({ type: 'task.add', listId: work, parentId: t1.taskId, title: 'Find the signed form', myDay: true });
  const sub = op({ type: 'task.add', listId: work, parentId: t1.taskId, title: 'Attach the loss runs and send', dueDate: today });
  op({ type: 'task.add', listId: work, parentId: sub.taskId, title: 'Check the policy numbers match' });
  op({ type: 'task.add', listId: work, title: 'Review the commission one-pager with a title long enough that it has to wrap onto a second line in a narrow pane', dueDate: TASKS.shiftDay(today, 2), tags: ['reports'] });
  op({ type: 'task.add', listId: work, title: 'Draft the monthly status update', myDay: true });
  const done = op({ type: 'task.add', listId: work, title: 'Send the survey results' });
  op({ type: 'task.setDone', taskId: done.taskId, done: true });
  op({ type: 'task.add', listId: work, title: 'Book the offsite room', starred: true, dueDate: TASKS.shiftDay(today, -2) });
  op({ type: 'task.add', listId: home, title: 'Pick up the dry cleaning', myDay: true });
  op({ type: 'task.add', listId: home, title: 'Call about the gutters', dueDate: TASKS.shiftDay(today, 5) });
  op({ type: 'task.add', listId: reading, title: 'Finish the typography chapter', starred: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

function seedNotes(file) {
  let doc = NOTES.emptyDoc();
  const op = (o) => { const r = NOTES.applyOp(doc, o); if (!r.ok) throw new Error(`seed note op failed: ${r.reason || r.error}`); doc = r.doc; return r; };
  const g0 = doc.groups[0].id;
  const g1 = op({ type: 'group.add', name: 'Replies', color: '#6fa8d8' }).groupId;
  const g2 = op({ type: 'group.add', name: 'Ideas', color: '#e9c46a' }).groupId;
  const n1 = op({ type: 'note.add', groupId: g1, title: 'Reply to the renewals team', tags: ['email', 'renewals'], body: 'Thanks for the quick turnaround on this.\n\n- the loss runs are attached\n- the **effective date** moved to the first\n- please confirm the **new limits**\n\nLet me know if the broker needs anything else before Friday.' });
  op({ type: 'note.pin', noteId: n1.noteId, pinned: true });
  op({ type: 'note.add', groupId: g1, title: 'Teams message about the outage', tags: ['teams'], body: 'Short version: the sync is back, nothing was lost, and we added a check so it pages us next time.' });
  op({ type: 'note.add', groupId: g2, title: 'A calmer way to show plan usage', tags: ['ideas'], body: 'Show one line per plan, the 5-hour window first, then the week. Colour only when it is close to the cap.' });
  op({ type: 'note.add', groupId: g0, title: 'Meeting prep for Thursday', body: '1. open with the numbers\n2. the two risks\n3. what we need from them' });
  op({ type: 'note.add', groupId: g0, title: '', body: 'Untitled scratch note with a long first line that should be cut off at the edge of the list instead of wrapping into three rows' });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

function seedFiles(tmp) {
  const roots = path.join(tmp, 'artroots');
  const out = path.join(tmp, 'deliverables');
  fs.mkdirSync(out, { recursive: true });
  const shots = path.resolve(APP_DIR, '..', 'docs', 'screenshots');
  const pngs = fs.existsSync(shots) ? fs.readdirSync(shots).filter((n) => /\.png$/i.test(n)).slice(0, 4) : [];
  const files = [];
  const html = (name, title, body) => {
    const f = path.join(out, name);
    fs.writeFileSync(f, `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:40px;background:#fff;color:#111"><h1>${title}</h1><p>${body}</p>`);
    files.push(f);
  };
  html('commission-onepager.html', 'Commission one-pager', 'Totals by group, before and after.');
  html('renewal-timeline.html', 'Renewal timeline', 'Every account, by month.');
  html('survey-themes.html', 'Exit interview themes', 'What people said, in their words.');
  for (const [i, name] of pngs.entries()) { const f = path.join(out, `screen-${i + 1}.png`); fs.copyFileSync(path.join(shots, name), f); files.push(f); }
  const pdf = path.join(out, 'status-report.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 52>>stream\nBT /F1 24 Tf 72 700 Td (Status report) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  files.push(pdf);
  const projects = [['/work/console', 0], ['/work/reports', 1], ['/work/surveys', 2]];
  for (const [i, [cwd]] of projects.entries()) {
    const dir = path.join(roots, `proj-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const mine = files.filter((_, j) => j % projects.length === i);
    const start = new Date(Date.now() - 3600_000).toISOString();
    const lines = [{ type: 'user', timestamp: start, cwd, message: { role: 'user', content: 'make the deliverables' } }];
    for (const f of mine) lines.push({ type: 'assistant', timestamp: new Date().toISOString(), cwd, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: f, content: 'x' } }] } });
    fs.writeFileSync(path.join(dir, `sess-${i}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return roots;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-surfaces-drive-'));
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
    setup: { completed: !SCENES.includes('setup'), completedAt: null, appVersion: null },
    orchestration: { enabled: true },
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));
  seedTasks(config.paths.tasksFile);
  seedNotes(config.paths.notesFile);
  const artRoots = seedFiles(tmp);
  fs.mkdirSync(config.paths.cacheDir, { recursive: true });
  const fiveHours = (Date.now() + 5400_000) / 1000;
  const week = (Date.now() + 86400_000 * 4) / 1000;
  [[0, 44], [0, 100], [51, 51], [0, 99], [7, 56], [31, 60], [0, 71]].forEach(([fh, wk], i) => {
    fs.writeFileSync(path.join(config.paths.cacheDir, `usage-${PROFILES[i][0]}.json`), JSON.stringify({
      updated_at: new Date().toISOString(), account_email: null,
      rate_limits: { five_hour: { used_percentage: fh, resets_at: fiveHours }, seven_day: { used_percentage: wk, resets_at: week } },
      cost: { total_cost_usd: 1.25 },
    }));
  });

  const store = path.join(tmp, 'sessiond');
  fs.mkdirSync(store, { recursive: true });
  const socketPath = path.join(store, 'daemon.sock');
  const namespace = `harbor-surfaces-drive-${process.pid}`;
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
    HARBOR_ARTIFACTS_ROOTS: artRoots, HARBOR_ARTIFACTS_CACHE: path.join(tmp, 'cache', 'artifacts-index.json'), HARBOR_ARTIFACT_THUMBS_DIR: path.join(tmp, 'thumbs'),
    HARBOR_TASKS_FILE: config.paths.tasksFile, HARBOR_NOTES_FILE: config.paths.notesFile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.writeFileSync(path.join(store, '..', 'cli-updates.json'), JSON.stringify({
    checkedAt: Date.now(),
    providers: { claude: { id: 'claude', label: 'Claude Code', installed: '2.1.300', latest: '2.1.310', updateAvailable: true }, codex: { id: 'codex', label: 'Codex', installed: '0.140.0', latest: '0.140.0', updateAvailable: false } },
  }));
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
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

    const click = async (selector, { quiet = false } = {}) => {
      const box = await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!box) { if (!quiet) problems.push(`nothing to click: ${selector}`); return false; }
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(350);
      return true;
    };
    const clickText = async (scope, text) => {
      const ok = await cdp.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((n) => n.textContent.trim().startsWith(${JSON.stringify(text)})); if (!el) return false; el.setAttribute('data-drive-hit', '1'); return true; })()`);
      if (!ok) { problems.push(`no ${scope} with text ${text}`); return false; }
      const r = await click('[data-drive-hit="1"]');
      await cdp.eval("document.querySelector('[data-drive-hit]')?.removeAttribute('data-drive-hit')");
      return r;
    };
    const esc = async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(250);
    };
    const setValue = (selector, value) => cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement; Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const view = async (name) => { await click(`.view-switch-btn[aria-label="${name}"]`); await sleep(600); };
    const windows = async (count, size) => {
      await cdp.eval("(() => { for (const el of document.querySelectorAll('.new-session-backdrop, .menu-backdrop, .help-overlay')) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()");
      await cdp.eval('window.__look.close()');
      await sleep(200);
      await cdp.eval(`window.__look.install(${Math.max(count, 3)})`);
      await sleep(250);
      await cdp.eval(`window.__look.feed(${Math.max(count, 3)})`);
      await cdp.eval(`window.__look.open(${count})`);
      await cdp.size(size);
      await sleep(700);
      if (count) { try { await waitFor(cdp, `document.querySelectorAll('.win2').length >= ${count}`, `${count} windows`, 12_000); } catch (e) { const have = await cdp.eval("document.querySelectorAll('.win2').length + ' windows, tiles: ' + document.querySelectorAll('.tile').length + ', modal: ' + Boolean(document.querySelector('.new-session-backdrop'))"); problems.push(e.message + ' (' + have + ')'); } }
    };

    if (SCENES.includes('explore')) {
      await windows(2, SIZE_TABLE.pat);
      const dump = await cdp.eval(`[...document.querySelectorAll('button, [role=button], select, input')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 60), label: e.getAttribute('aria-label') || e.title || (e.textContent || '').trim().slice(0, 24), y: Math.round(e.getBoundingClientRect().top) }))`);
      fs.writeFileSync(path.join(OUT, 'explore.json'), JSON.stringify(dump, null, 1));
    }

    for (const sizeName of SIZES) {
      const size = SIZE_TABLE[sizeName];
      if (SCENES.includes('pages')) {
        await windows(0, size);
        await cdp.shot(`stage-empty-${sizeName}`);
        await view('Tasks');
        await cdp.shot(`tasks-${sizeName}`);
        if (await click('.task-main')) { await sleep(500); await cdp.shot(`tasks-editor-${sizeName}`); await esc(); }
        await view('Tasks');
        await view('Notes');
        await cdp.shot(`notes-${sizeName}`);
        await clickText('.notes-item', 'Reply to the renewals team');
        await sleep(500);
        await cdp.shot(`notes-open-${sizeName}`);
        await view('Files');
        await sleep(1500);
        await cdp.shot(`files-${sizeName}`);
        await view('Orch');
        await sleep(1200);
        await cdp.shot(`orch-${sizeName}`);
        await view('Agents');
      }
    }
    for (const sizeName of SIZES) {
      const size = SIZE_TABLE[sizeName];
      const tag = (name) => `${name}-${sizeName}`;
      const closeMenus = async () => { await esc(); await esc(); await cdp.unhover(); };
      const rightClick = async (selector) => {
        const ok = await cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + r.height / 2, button: 2 })); return true; })()`);
        if (!ok) problems.push(`no right-click target ${selector}`);
        await sleep(350);
        return ok;
      };
      const menu = async (name, trigger, opts = {}) => {
        const opened = await click(trigger);
        if (!opened) return;
        await sleep(opts.wait || 350);
        await cdp.shot(tag(name));
        if (opts.hoverFirst) { await cdp.hover(opts.hoverFirst); await cdp.shot(tag(`${name}-hover`)); }
        await closeMenus();
      };

      if (SCENES.includes('menus')) {
        await windows(2, size);
        await menu('menu-app', '.app-menu-btn');
        await menu('menu-updates', '.updates-chip');
        await menu('menu-planusage', '.titlebar-btn[aria-label="Plan usage"]');
        await menu('menu-help', '.titlebar-btn[aria-label="Help"]');
        await menu('menu-rail-sort', '.rail-opt-chip[title^="Sort"]');
        await menu('menu-rail-projects', '.rail-opt-chip[title^="Show only"]');
        if (await rightClick('.sr.live')) { await cdp.shot(tag('menu-session-row')); await closeMenus(); }
        await menu('menu-plus', '.ubar .attach');
        await menu('menu-launch-other', '.sidebar-global-new.launch-other');
        // The new-session dialog and the session configuration dialog.
        if (await click('.ubar .mswitch')) { await sleep(600); await cdp.shot(tag('dialog-config')); if (await click('.model-select')) { await sleep(350); await cdp.shot(tag('dialog-config-model-list')); await esc(); } await esc(); await cdp.eval("document.querySelector('.new-session-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))"); await sleep(250); }
        // Right-click menu in the composer, the format strip, the slash popup.
        {
          // The text box's menu comes from the main process, so it needs a real right click.
          const box = await cdp.eval("(() => { const r = document.querySelector('.ubar-input').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()");
          for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'right', buttons: 2, clickCount: 1 });
          await sleep(700);
          await cdp.shot(tag('menu-context'));
          await closeMenus();
        }
        if (await click('.compose-format-toggle')) { await sleep(300); await cdp.shot(tag('composer-format-open')); await click('.compose-format-toggle'); }
        await click('.ubar-input');
        await cdp.send('Input.insertText', { text: '/co' });
        await sleep(500);
        await cdp.shot(tag('composer-slash'));
        await cdp.eval("(() => { const el = document.querySelector('.ubar-input'); if (el) { el.textContent = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()");
        await closeMenus();
        // The terminal view of a window, and the connections panel.
        if (await click('.win2 .ico.tty')) { await sleep(900); await cdp.shot(tag('window-terminal')); await click('.win2 .ico.tty'); }
      }

      if (SCENES.includes('cards')) {
        await windows(3, size);
        const hookAsk = (id, sessionId, extra) => ({ id, sessionId, paneId: null, workspaceId: null, cwd: '/work/harbor', at: Date.now(), answered: false, ...extra });
        await cdp.eval(`window.__setAsksForTest(${JSON.stringify([
          hookAsk('ask-1', 'look-01', {
            kind: 'ask',
            questions: [
              { index: 0, header: 'Publication', question: 'How should the release workflow publish installers?', multiSelect: false, options: [
                { index: 0, label: 'Draft release', description: 'Attach installers and wait for a maintainer to publish.', preview: null },
                { index: 1, label: 'Workflow artifacts', description: 'Keep downloads attached to the build run.', preview: null },
                { index: 2, label: 'Publish at once', description: 'Create the release and make it public right away.', preview: null }] },
              { index: 1, header: 'Checks', question: 'Which checks belong on the release checklist?', multiSelect: true, options: [
                { index: 0, label: 'Installer smoke test', description: 'Open each installer on its target platform.', preview: null },
                { index: 1, label: 'Release notes', description: 'Document known limits and the manual publish step.', preview: null },
                { index: 2, label: 'Checksums', description: 'Compare the uploaded files with the build outputs.', preview: null }] },
            ],
          }),
          hookAsk('perm-1', 'look-02', {
            kind: 'permission',
            prompt: { toolName: 'Bash', displayTool: 'Bash', persistent: { label: 'Yes, and do not ask again for npm test commands', updates: [] }, toolInput: { command: 'npm test -- main', description: 'Run the main-process suite' } },
            questions: [],
          }),
          hookAsk('elic-1', 'look-03', {
            kind: 'elicitation',
            prompt: { serverName: 'files', mode: 'form', message: 'Choose where the export should go.', schema: { type: 'object', required: ['folder'], properties: { folder: { type: 'string', title: 'Folder', description: 'A folder on this machine.' }, format: { type: 'string', title: 'Format', enum: ['csv', 'xlsx'] }, overwrite: { type: 'boolean', title: 'Replace an existing file' } } } },
            questions: [],
          }),
        ])})`);
        await sleep(900);
        await cdp.shot(tag('cards-ask-permission-elicit'));
        // One window per card, for a full-size read.
        const ask2 = hookAsk('ask-2', 'look-01', { kind: 'ask', questions: [
          { index: 0, header: 'Publication', question: 'How should the release workflow publish installers?', multiSelect: false, options: [
            { index: 0, label: 'Draft release', description: 'Attach installers and wait for a maintainer to publish.', preview: null },
            { index: 1, label: 'Workflow artifacts', description: 'Keep downloads attached to the build run.', preview: null }] },
          { index: 1, header: 'Checks', question: 'Which checks belong on the release checklist?', multiSelect: true, options: [
            { index: 0, label: 'Installer smoke test', description: 'Open each installer on its target platform.', preview: null },
            { index: 1, label: 'Release notes', description: 'Document known limits and the manual publish step.', preview: null }] },
        ] });
        const perm2 = hookAsk('perm-2', 'look-01', { kind: 'permission', prompt: { toolName: 'Edit', displayTool: 'Edit', persistent: { label: 'Yes, and allow edits for this session', updates: [] }, toolInput: { file_path: 'src/main/sidebar-bridge.js', old_string: 'send(\'sidebar:model\', next);', new_string: 'if (delta.changed) send(\'sidebar:patch\', delta);' } }, questions: [] });
        const elic2 = hookAsk('elic-2', 'look-01', { kind: 'elicitation', prompt: { serverName: 'files', mode: 'form', message: 'Choose where the export should go.', schema: { type: 'object', required: ['folder'], properties: { folder: { type: 'string', title: 'Folder', description: 'A folder on this machine.' }, format: { type: 'string', title: 'Format', enum: ['csv', 'xlsx'] }, overwrite: { type: 'boolean', title: 'Replace an existing file' } } } }, questions: [] });
        for (const [name, card] of [['ask', ask2], ['permission', perm2], ['elicitation', elic2]]) {
          await windows(1, size);
          await cdp.eval(`window.__setAsksForTest(${JSON.stringify([card])})`);
          await sleep(700);
          await cdp.shot(tag(`cards-${name}-solo`));
        }
        await cdp.eval('window.__setAsksForTest([])');
        await sleep(300);
      }
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
