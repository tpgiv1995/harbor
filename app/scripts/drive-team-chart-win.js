'use strict';

// Drive the Orch view's team chart against the LIVE machine (2026-11-02).
//
// Boots this checkout's Harbor in its own profile (HARBOR_E2E with a relocated
// userData, so the isolation guards refuse every signal, launch and dialog),
// off screen and without focus, reading the real session daemon, the real
// transcripts, the real launch records and the real usage files. It never
// starts or stops the daemon. Then, in the real window, it:
//   - screenshots the chart at the owner's geometry,
//   - sets every value of every filter and records what each shows,
//   - opens a card's drawer and closes it with Escape,
//   - opens the idle row and the ended strip,
//   - clicks Copy session id and reads the OS clipboard back (the previous
//     clipboard text is restored after),
//   - shows an INVENTED deep team (four levels, a parent whose children wrap
//     onto several rows while those children have children of their own, and
//     cross-level review and keeps-alive lines) through the e2e-only fixture
//     hook, and checks every line geometrically at several zooms and under a
//     filter: each arrow ends on its child's top edge, each drop hangs from a
//     bus its parent feeds, and no line passes through any card,
//   - with --session: starts one tiny real worker through claude-worker (Haiku,
//     a 20 second sleep) and watches it appear under this session and then move
//     to the ended strip, with no reload.
//
// Output (screenshots, results.json, electron.log) goes to TEAM_DRIVE_OUT, else
// %TEMP%\harbor-drive-team. Screens show real session names: keep them out of
// the public repo.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = Number(process.env.TEAM_DRIVE_PORT || 9351);
const OUT = process.env.TEAM_DRIVE_OUT || path.join(os.tmpdir(), 'harbor-drive-team');
const START_SESSION = process.argv.includes('--session');
const SCALE = 1.8; // 150% display x 120% Harbor zoom
const WIDTH = 1422;
const HEIGHT = 868;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// The invented team for the deep-tree check. Names are lighthouse words; ids
// are obviously fake. Nothing here is real.
function fixtureTeam(now) {
  const members = {};
  const edges = [];
  const projects = new Map();
  let n = 0;
  const kinds = ['working', 'tool', 'idle', 'working', 'quiet', 'working', 'starting'];
  const add = (id, name, { parent = null, project, pane = false, provider = 'claude' } = {}) => {
    n += 1;
    const kind = kinds[n % kinds.length];
    members[id] = {
      id, name, provider, home: null,
      model: provider === 'codex' ? 'gpt-6' : 'claude-sonnet-5-5', modelLabel: provider === 'codex' ? 'GPT-6' : 'Sonnet 5.5', effort: ['low', 'medium', 'high', 'xhigh', 'max'][n % 5],
      status: { kind, sinceMs: now - (n % 9 + 1) * 60000, tool: kind === 'tool' ? 'Bash' : undefined },
      description: `${['Polishing', 'Checking', 'Logging', 'Testing', 'Fixing'][n % 5]} the ${name.toLowerCase()} and reporting what it finds to the crew above it.`,
      sessionId: `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      runMode: pane ? 'pane' : undefined, launcher: pane ? undefined : 'claude-worker',
      parent, parentSource: parent ? 'launch' : undefined, children: [], warnings: [], helpers: [], subWorkers: [],
      teamProject: project, project, cwd: `C:\\work\\${project}`, createdMs: now - n * 600000, lastEventMs: now - n * 30000,
    };
    if (parent) { members[parent].children.push(id); edges.push({ from: parent, to: id, kind: 'directs', source: 'launch' }); }
    if (!projects.has(project)) projects.set(project, { project, roots: [], idle: [], memberIds: [], warningIds: [] });
    const entry = projects.get(project);
    entry.memberIds.push(id);
    if (!parent) entry.roots.push(id);
  };
  const L = { project: 'lighthouse' };
  add('keeper', 'Keeper', { ...L, pane: true });
  add('lens', 'Lens crew', { ...L, parent: 'keeper' });
  add('prism', 'Prism polish', { ...L, parent: 'lens' });
  add('glass', 'Glass check', { ...L, parent: 'prism' });
  add('bulb', 'Bulb test', { ...L, parent: 'lens' });
  add('lamp', 'Lamp crew', { ...L, parent: 'keeper', provider: 'codex' });
  add('mantle', 'Mantle swap', { ...L, parent: 'lamp' });
  add('fog', 'Fog signal', { ...L, parent: 'keeper' });
  add('supply', 'Supply run', { ...L, parent: 'keeper' });
  add('oil', 'Oil barrels', { ...L, parent: 'supply' });
  add('wicks', 'Wick count', { ...L, parent: 'supply' });
  add('paint', 'Paint the tower', { ...L, parent: 'supply' });
  add('logbook', 'Logbook', { ...L, parent: 'keeper' });
  add('radio', 'Radio watch', { ...L, parent: 'keeper', provider: 'codex' });
  const Y = { project: 'harbour-yard' };
  add('captain', 'Captain', { ...Y, pane: true });
  add('mate', 'First mate', { ...Y, parent: 'captain' });
  add('deckhand', 'Deckhand', { ...Y, parent: 'mate' });
  add('cabin', 'Cabin hand', { ...Y, parent: 'deckhand' });
  add('night', 'Night watch', { ...Y });
  // Sub-worker trays (2026-11-03): a small one, one past the four-card cap
  // (its "Show more" opens it), one on a leaf, and a loose row in a frame.
  const subs = (owner, names, { running = 1, provider = 'codex' } = {}) => names.map((name, i) => ({
    key: `session:${owner}-${i}`, kind: provider === 'codex' ? 'sub-agent' : 'headless Claude', kindText: provider === 'codex' ? 'Sub-agent' : 'Headless run',
    provider, name, sessionId: `f1000000-0000-4000-8000-${String(i).padStart(4, '0')}${owner.slice(0, 8).padEnd(8, '0').replace(/[^0-9a-f]/g, 'a')}`,
    startedMs: now - (i + 2) * 60000, lastEventMs: i < running ? now - 20000 : now - (i + 3) * 60000, finished: false, working: false, openTool: null, source: 'spawned',
  }));
  members.lens.subWorkers = subs('lens', ['Tide check', 'Beacon log', 'Rope count'], { running: 1 });
  members.lamp.subWorkers = subs('lamp', ['Gull', 'Tern', 'Heron', 'Petrel', 'Puffin', 'Skua'], { running: 2 });
  members.glass.subWorkers = subs('glass', ['Message to lighthouse-7'], { running: 0, provider: 'claude' });
  const yardLoose = subs('yard', ['Sort the driftwood', 'Tar the hull'], { running: 1, provider: 'claude' }).map((entry) => ({ ...entry, source: null }));
  edges.push({ from: 'radio', to: 'lens', kind: 'reviews', source: 'declared' });
  edges.push({ from: 'logbook', to: 'glass', kind: 'keeps-alive', source: 'process' });
  const list = [...projects.values()].map((p) => {
    const counts = { working: 0, tool: 0, idle: 0, quiet: 0, starting: 0, total: 0 };
    for (const id of p.memberIds) { counts.total += 1; counts[members[id].status.kind] += 1; }
    return { ...p, counts, loose: p.project === 'harbour-yard' ? yardLoose : [] };
  });
  return { members, edges, projects: list, warnings: [], runs: [], ended: [], fixture: true };
}

// Every reporting line on the board, checked against the measured cards.
const LINES = `(() => {
  const inner = document.querySelector('.tc-board-inner');
  const base = inner.getBoundingClientRect();
  // A card's unit (the card and its sub-worker tray) is what lines meet.
  const cards = [...document.querySelectorAll('.tc-card[data-member-id]')].map((c) => {
    const r = (c.closest('.tc-unit') || c).getBoundingClientRect();
    const own = c.getBoundingClientRect();
    return { id: c.dataset.memberId, l: r.left - base.left, t: r.top - base.top, r: r.right - base.left, b: r.bottom - base.top, mid: (own.top + own.bottom) / 2 - base.top };
  });
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  const near = (a, b) => Math.abs(a - b) <= 1.5;
  const busSegs = []; const drops = []; let curves = 0; const problems = [];
  for (const g of document.querySelectorAll('.tc-edge')) {
    const line = g.querySelector('.tc-line');
    const d = line.getAttribute('d');
    const isCross = g.classList.contains('reviews') || g.classList.contains('keeps-alive');
    if (d.includes('C')) { curves += 1; problems.push('a cross line fell back to a curve: ' + d.slice(0, 60)); continue; }
    const segs = []; let x = 0; let y = 0;
    for (const m of d.matchAll(/([MHVQ])(-?[0-9.]+)(?: (-?[0-9.]+))?(?: (-?[0-9.]+))?(?: (-?[0-9.]+))?/g)) {
      const n = m.slice(2).filter((v) => v !== undefined).map(Number);
      if (m[1] === 'M') { x = n[0]; y = n[1]; segs.push({ move: true, x, y }); }
      else if (m[1] === 'H') { segs.push({ x1: x, y1: y, x2: n[0], y2: y }); x = n[0]; }
      else if (m[1] === 'V') { segs.push({ x1: x, y1: y, x2: x, y2: n[0] }); y = n[0]; }
      else { segs.push({ x1: x, y1: y, x2: n[0], y2: n[1] }, { x1: n[0], y1: n[1], x2: n[2], y2: n[3] }); x = n[2]; y = n[3]; }
    }
    const real = segs.filter((s) => !s.move);
    if (isCross) {
      curves += 1;
      const first = segs[0]; const last = real.at(-1);
      // Cross lines meet a card's side at the card's own middle, above its tray.
      const onSide = (px, py, offset) => cards.some((c) => near(py, c.mid) && (near(px, c.l - offset) || near(px, c.r + offset)));
      if (!onSide(first.x, first.y, 0)) problems.push('a cross line does not leave from the side of a card: ' + d.slice(0, 60));
      if (!onSide(last.x2, last.y2, 1)) problems.push('a cross line does not end on the side of a card: ' + d.slice(-60));
    } else if (line.getAttribute('marker-end')) drops.push(...real); else busSegs.push(...real);
    for (const s of real) for (const c of cards) {
      const lo = (a, b) => Math.min(a, b); const hi = (a, b) => Math.max(a, b);
      const inside = lo(s.x1, s.x2) < c.r - 2 && hi(s.x1, s.x2) > c.l + 2 && lo(s.y1, s.y2) < c.b - 2 && hi(s.y1, s.y2) > c.t + 2;
      if (inside) problems.push('a line passes through ' + c.id + ' (' + d.slice(0, 60) + ')');
    }
  }
  const onBus = (px, py) => busSegs.some((s) => (near(s.y1, s.y2) && near(s.y1, py) && px >= Math.min(s.x1, s.x2) - 1.5 && px <= Math.max(s.x1, s.x2) + 1.5)
    || (near(s.x1, s.x2) && near(s.x1, px) && py >= Math.min(s.y1, s.y2) - 1.5 && py <= Math.max(s.y1, s.y2) + 1.5));
  const expected = [];
  for (const c of cards) {
    const member = window.__harborTeamFixture?.members?.[c.id];
    for (const kid of member?.children || []) if (byId[kid]) expected.push([c.id, kid]);
  }
  for (const [parent, kid] of expected) {
    const k = byId[kid]; const p = byId[parent];
    const drop = drops.find((s) => near(s.x2, (k.l + k.r) / 2) && near(s.y2, k.t - 1));
    if (!drop) { problems.push('no arrow ends on ' + kid); continue; }
    if (!onBus(drop.x1, drop.y1)) problems.push('the arrow into ' + kid + ' hangs from nothing');
    if (!busSegs.some((s) => near(s.x1, (p.l + p.r) / 2) && near(s.y1, p.b))) problems.push(parent + ' has no line leaving its bottom edge');
  }
  return { cards: cards.length, relations: expected.length, arrows: drops.length, curves, problems };
})()`;

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'page evaluation failed');
    return response.result.value;
  }
  async shot(name, { full = true } = {}) {
    let clip;
    if (full) {
      const size = await this.eval(`(() => { const el = document.querySelector('.orch-overview'); return el ? { w: el.clientWidth, h: el.scrollHeight } : null; })()`);
      if (size) clip = undefined;
    }
    const response = await this.send('Page.captureScreenshot', { format: 'png', clip });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(response.data, 'base64'));
    return file;
  }
  async click(selector) {
    const box = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!box) throw new Error(`nothing to click: ${selector}`);
    await sleep(150);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }
  async key(key, code) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0 });
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await cdp.eval(expression)) return; } catch { /* page still loading */ }
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
}

const STATE = `(() => {
  const cards = [...document.querySelectorAll('.tc-card')];
  return {
    cards: cards.length,
    dim: cards.filter((c) => c.classList.contains('dim')).length,
    chips: document.querySelectorAll('.tc-chip').length,
    projects: [...document.querySelectorAll('.tc-project-head h3')].map((h) => h.textContent),
    empty: document.querySelector('.tc-empty')?.textContent || null,
    lines: document.querySelectorAll('.tc-edge').length,
    drawer: Boolean(document.querySelector('.tc-drawer')),
    trays: document.querySelectorAll('.tc-subs:not(.loose)').length,
    looseTrays: document.querySelectorAll('.tc-subs.loose').length,
    subs: document.querySelectorAll('.tc-sub').length,
    subNames: [...document.querySelectorAll('.tc-sub-name')].slice(0, 40).map((el) => el.textContent),
    subListMounted: Boolean(document.querySelector('.sub-sessions')),
  };
})()`;

function setSelect(label) {
  return `(value) => {
    const select = [...document.querySelectorAll('.tc-filter')].find((el) => el.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of fs.readdirSync(OUT)) if (name.endsWith('.png')) fs.rmSync(path.join(OUT, name), { force: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-team-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.orchestration = { ...config.orchestration, enabled: true };
  config.paths = { ...config.paths, tasksFile: path.join(tmp, 'tasks.json'), projectIconsDir: config.paths?.projectIconsDir || path.join(os.homedir(), '.harbor', 'project-icons') };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(userData, 'local-storage-seed.json'), '{}');

  const log = fs.openSync(path.join(OUT, 'electron.log'), 'w');
  // An off-screen window counts as occluded on Windows, and Chromium then
  // delivers no wheel input to it (clicks still arrive). These switches keep
  // it live for the Ctrl+wheel check (opt-in with TEAM_DRIVE_UNOCCLUDE=1:
  // one boot with them never opened a page, cause not yet isolated).
  const unocclude = process.env.TEAM_DRIVE_UNOCCLUDE === '1' ? ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] : [];
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal', ...unocclude], {
    // The one opt-in: read the real session store (panes are read, never
    // driven: no window opens on a pane, the pane size sweep is off under
    // E2E). Signals, launches and dialogs stay refused, and the takeover
    // owner lookup gets a throwaway context dir so it cannot learn a real pid.
    env: { ...process.env, HARBOR_E2E: '1', HARBOR_E2E_USER_DATA: userData, HARBOR_NO_DAEMON_START: '1', HARBOR_ALLOW_REAL_SESSION_STORE: '1',
      HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_NO_ICON_GEN: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_DESCRIBER_FORCE: '1' },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  const results = { steps: [], failures: [] };
  const check = (ok, message) => { if (!ok) results.failures.push(message); };
  let savedClipboard = null;
  try {
    let target;
    for (let index = 0; index < 1000 && !target; index += 1) {
      await sleep(500);
      try { target = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((item) => item.type === 'page' && !item.url.startsWith('devtools:')); } catch { /* not up yet */ }
    }
    if (!target) throw new Error('CDP target never appeared');
    const ws = await new Promise((resolve, reject) => { const socket = new WebSocket(target.webSocketDebuggerUrl); socket.addEventListener('open', () => resolve(socket)); socket.addEventListener('error', reject); });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    powershell(`Add-Type -Name W -Namespace P -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) | Out-Null }`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    await cdp.eval(`localStorage.removeItem('harbor-team-filters'); localStorage.removeItem('harbor-team-zoom'); localStorage.removeItem('harbor-slate-stage'); true`);
    await waitFor(cdp, `Boolean(document.querySelector('.view-switch-btn[aria-label="Orch"]'))`, 'Orch tab', 400000);
    await cdp.click('.view-switch-btn[aria-label="Orch"]');
    await waitFor(cdp, `Boolean(document.querySelector('.team-chart'))`, 'team chart');
    await waitFor(cdp, `document.querySelectorAll('.tc-card').length > 0`, 'a card', 180000);
    // Let the transcript tailer, usage and descriptions land.
    await sleep(Number(process.env.TEAM_DRIVE_SETTLE_MS || 20000));
    fs.writeFileSync(path.join(OUT, 'team.json'), JSON.stringify(await cdp.eval('window.harbor.orchestration.team()'), null, 2));
    const first = await cdp.eval(STATE);
    results.steps.push({ step: 'overview', ...first });
    await cdp.shot('01-overview');
    check(first.cards > 0, 'no cards on the live chart');
    check(!first.subListMounted, 'the sub-sessions list is mounted under the chart while folded shut');
    // The live trays, close up, and one live sub-worker opened.
    if (first.trays + first.looseTrays) {
      await cdp.eval(`document.querySelector('.tc-subs').scrollIntoView({ block: 'center' }); true`);
      await sleep(300);
      await cdp.shot('01d-live-tray');
    }

    // The board: Fit is the default; zoom out, Ctrl+wheel, 100%, and back to
    // Fit. At every zoom no two cards may overlap and every card keeps the
    // short, wide shape (Pat: "a little more 'horizontal' even than in miro").
    const BOARD = `(() => {
      const b = document.querySelector('.tc-board'); const br = b.getBoundingClientRect();
      const cards = [...document.querySelectorAll('.tc-card')];
      // Units, so a tray overlapping another card counts.
      const boxes = cards.map((c) => (c.closest('.tc-unit') || c).getBoundingClientRect());
      const cardBox = cards[0]?.getBoundingClientRect();
      const overlaps = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]; const c = boxes[j];
        if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) overlaps.push([cards[i].dataset.memberId, cards[j].dataset.memberId]);
      }
      return {
        zoom: document.querySelector('.tc-zoom-pct')?.textContent, fit: document.querySelector('.tc-zoom-fit')?.getAttribute('aria-pressed'),
        cards: cards.length, inView: boxes.filter((r) => r.top >= br.top - 1 && r.bottom <= br.bottom + 1).length,
        cardPx: cardBox ? [Math.round(cardBox.width), Math.round(cardBox.height)] : null,
        overflow: b.scrollHeight > b.clientHeight + 1, lines: document.querySelectorAll('.tc-edge').length, overlaps,
      };
    })()`;
    const fitState = await cdp.eval(BOARD);
    results.steps.push({ step: 'board fit', ...fitState });
    check(fitState.fit === 'true', 'the board did not open in Fit');
    check(!fitState.overlaps.length, `cards overlap at fit: ${JSON.stringify(fitState.overlaps)}`);
    check(fitState.cardPx && fitState.cardPx[0] / fitState.cardPx[1] > 1.8, `cards are not wide enough: ${JSON.stringify(fitState.cardPx)}`);
    await cdp.click('.tc-zoom [aria-label="Zoom out"]');
    await sleep(250);
    await cdp.click('.tc-zoom [aria-label="Zoom out"]');
    await sleep(400);
    const outState = await cdp.eval(BOARD);
    results.steps.push({ step: 'board zoomed out', ...outState });
    await cdp.shot('01b-zoom-out');
    check(!outState.overlaps.length, `cards overlap zoomed out: ${JSON.stringify(outState.overlaps)}`);
    check(outState.fit === 'false' && outState.zoom !== fitState.zoom, 'Zoom out did not change the zoom');
    const center = await cdp.eval(`(() => { const r = document.querySelector('.tc-board').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 40 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY: -240, modifiers: 2 });
    await sleep(400);
    const wheelState = await cdp.eval(BOARD);
    results.steps.push({ step: 'board ctrl+wheel in', ...wheelState });
    if (!(parseInt(wheelState.zoom, 10) > parseInt(outState.zoom, 10))) results.steps.push({ step: 'ctrl+wheel in: no real wheel input reached the window (checked again below)' });
    await cdp.click('.tc-zoom-pct');
    await sleep(400);
    const fullState = await cdp.eval(BOARD);
    results.steps.push({ step: 'board 100%', ...fullState });
    await cdp.shot('01c-zoom-100');
    check(fullState.zoom === '100%' && !fullState.overlaps.length, `100% failed: ${JSON.stringify(fullState)}`);
    await cdp.click('.tc-zoom-fit');
    await sleep(400);
    const refit = await cdp.eval(BOARD);
    results.steps.push({ step: 'board back to fit', ...refit });
    check(refit.fit === 'true' && refit.zoom === fitState.zoom, `Fit did not come back to ${fitState.zoom}: ${JSON.stringify(refit)}`);

    // Ctrl+wheel, recorded: what the page itself receives, so a failure says
    // whether the event never arrived, arrived without ctrlKey, or arrived and
    // did not zoom. The recorder listens in the BUBBLE phase on window, after
    // the board's own handler, so `prevented` says whether the board took it.
    await cdp.eval(`window.__wheelSeen = []; window.addEventListener('wheel', (e) => window.__wheelSeen.push({ ctrl: e.ctrlKey, dy: e.deltaY, target: e.target.className && String(e.target.className).slice(0, 40), prevented: e.defaultPrevented })); true`);
    const wheelAt = await cdp.eval(`(() => { const r = document.querySelector('.tc-board').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 60) }; })()`);
    const zoomBefore = await cdp.eval(`document.querySelector('.tc-zoom-pct').textContent`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: wheelAt.x, y: wheelAt.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelAt.x, y: wheelAt.y, deltaX: 0, deltaY: 240, modifiers: 2 });
    await sleep(500);
    const wheel = { before: zoomBefore, after: await cdp.eval(`document.querySelector('.tc-zoom-pct').textContent`), seen: await cdp.eval('window.__wheelSeen'), input: 'real' };
    if (!wheel.seen.length) {
      // No wheel reached the page at all: the harness, not the chart. Prove
      // the handler with the same event the OS would deliver, and say so.
      await cdp.eval(`document.querySelector('.tc-board').dispatchEvent(new WheelEvent('wheel', { deltaY: 240, ctrlKey: true, bubbles: true, cancelable: true, clientX: ${wheelAt.x}, clientY: ${wheelAt.y} })); true`);
      await sleep(400);
      Object.assign(wheel, { input: 'synthetic (no real wheel input reached the off-screen window)', after: await cdp.eval(`document.querySelector('.tc-zoom-pct').textContent`), seen: await cdp.eval('window.__wheelSeen') });
    }
    results.steps.push({ step: 'ctrl+wheel out, recorded', ...wheel });
    check(parseInt(wheel.after, 10) < parseInt(wheel.before, 10), `Ctrl+wheel did not zoom out: ${JSON.stringify(wheel)}`);
    check(wheel.seen.every((e) => e.prevented), 'a Ctrl+wheel reached the page without being taken, so the page would zoom instead');
    await cdp.click('.tc-zoom-fit');
    await sleep(300);

    // Deeper than one level (Pat: "ensure that the draw arrows work properly
    // beyond just 1 level"): the invented team, its lines checked at every zoom.
    const team = fixtureTeam(Date.now());
    await cdp.eval(`window.__harborTeamFixture = ${JSON.stringify(team)}; window.dispatchEvent(new Event('harbor-team-fixture')); true`);
    await waitFor(cdp, `Boolean(document.querySelector('.tc-card[data-member-id="cabin"]'))`, 'the invented team');
    await sleep(600);
    for (const [label, action] of [['fit', null], ['100', '.tc-zoom-pct'], ['130', '.tc-zoom [aria-label="Zoom in"]'], ['50', 'out3'], ['fit-again', '.tc-zoom-fit']]) {
      if (action === 'out3') { for (let i = 0; i < 7; i += 1) { await cdp.click('.tc-zoom [aria-label="Zoom out"]'); await sleep(200); } }
      else if (action === '.tc-zoom [aria-label="Zoom in"]') { await cdp.click(action); await sleep(200); await cdp.click(action); }
      else if (action) await cdp.click(action);
      await sleep(500);
      await cdp.eval(`document.querySelector('.tc-board').scrollTo(0, 0); document.querySelector('.orch-overview').scrollTo(0, 0); true`);
      await sleep(200);
      const lines = await cdp.eval(LINES);
      const board = await cdp.eval(BOARD);
      results.steps.push({ step: `deep tree at ${label}`, zoom: board.zoom, overlaps: board.overlaps, ...lines });
      await cdp.shot(`10-deep-tree-${label}`);
      check(lines.relations === 16, `deep tree at ${label}: expected 16 reporting lines on screen, saw ${lines.relations}`);
      check(lines.curves === 2, `deep tree at ${label}: expected 2 cross-level curves, saw ${lines.curves}`);
      check(!lines.problems.length, `deep tree at ${label}: ${lines.problems.join('; ')}`);
      check(!board.overlaps.length, `deep tree at ${label}: cards overlap ${JSON.stringify(board.overlaps)}`);
    }
    // A tray past its cap opens with "Show N more"; the lines move with it.
    await cdp.click('.tc-unit[data-unit-id="lamp"] .tc-subs-more');
    await sleep(500);
    await cdp.eval(`document.querySelector('.tc-board').scrollTo(0, 0); document.querySelector('.orch-overview').scrollTo(0, 0); true`);
    const trayOpen = { lines: await cdp.eval(LINES), board: await cdp.eval(BOARD), subs: await cdp.eval(`document.querySelectorAll('.tc-unit[data-unit-id="lamp"] .tc-sub').length`), more: await cdp.eval(`document.querySelector('.tc-unit[data-unit-id="lamp"] .tc-subs-more')?.textContent`) };
    results.steps.push({ step: 'deep tree, a tray opened', ...trayOpen });
    await cdp.shot('10-deep-tree-tray-open');
    check(trayOpen.subs === 6 && trayOpen.more === 'Show fewer', `the lamp tray did not open to all six: ${JSON.stringify({ subs: trayOpen.subs, more: trayOpen.more })}`);
    check(!trayOpen.lines.problems.length, `deep tree with a tray open: ${trayOpen.lines.problems.join('; ')}`);
    check(!trayOpen.board.overlaps.length, `deep tree with a tray open: units overlap ${JSON.stringify(trayOpen.board.overlaps)}`);
    check(await cdp.eval(`document.querySelectorAll('.tc-subs.loose .tc-sub').length`) === 2, 'the loose row of the harbour-yard frame is missing');
    await cdp.click('.tc-unit[data-unit-id="lamp"] .tc-subs-more');
    await sleep(300);
    // A filter keeps the matches' ancestors on the board; the lines still meet.
    await cdp.eval(`(${setSelect('State')})('idle')`);
    await sleep(500);
    const filtered = await cdp.eval(LINES);
    results.steps.push({ step: 'deep tree, State = idle', ...filtered });
    await cdp.shot('10-deep-tree-filter-idle');
    check(!filtered.problems.length, `deep tree under a filter: ${filtered.problems.join('; ')}`);
    await cdp.eval(`(${setSelect('State')})('all')`);
    await cdp.eval(`window.__harborTeamFixture = null; window.dispatchEvent(new Event('harbor-team-fixture')); true`);
    await waitFor(cdp, `!document.querySelector('.tc-card[data-member-id="cabin"]') && document.querySelectorAll('.tc-card').length > 0`, 'the live team again');
    await sleep(400);

    // Every value of every filter.
    for (const label of ['Project', 'Plan', 'Provider', 'State']) {
      const values = await cdp.eval(`[...document.querySelectorAll('.tc-filter')].find((el) => el.querySelector('span')?.textContent === ${JSON.stringify(label)})?.querySelector('select') ? [...[...document.querySelectorAll('.tc-filter')].find((el) => el.querySelector('span')?.textContent === ${JSON.stringify(label)}).querySelector('select').options].map((o) => o.value) : []`);
      for (const value of values) {
        await cdp.eval(`(${setSelect(label)})(${JSON.stringify(value)})`);
        await sleep(400);
        const state = await cdp.eval(STATE);
        results.steps.push({ step: `filter ${label}=${value}`, ...state });
        await cdp.shot(`02-filter-${label.toLowerCase()}-${String(value).replace(/[^a-z0-9-]+/gi, '_')}`);
        if (value !== 'all') check(state.cards + state.chips > 0 || Boolean(state.empty), `${label}=${value} showed nothing and no empty message`);
      }
      await cdp.eval(`(${setSelect(label)})('all')`);
      await sleep(300);
    }
    await cdp.click('.tc-toggle input');
    await sleep(400);
    results.steps.push({ step: 'filter warnings only', ...(await cdp.eval(STATE)) });
    await cdp.shot('03-filter-warnings-only');
    await cdp.click('.tc-toggle input');
    await sleep(400);

    // Expand: open the first card's drawer, read it, close with Escape.
    await cdp.click('.tc-card .tc-open');
    await waitFor(cdp, `Boolean(document.querySelector('.tc-drawer'))`, 'drawer');
    await sleep(300);
    const drawer = await cdp.eval(`(() => { const d = document.querySelector('.tc-drawer'); return { title: d.querySelector('h2')?.textContent, sections: [...d.querySelectorAll('h3')].map((h) => h.textContent), copy: Boolean(d.querySelector('[aria-label="Copy session id"]')) }; })()`);
    results.steps.push({ step: 'drawer open', drawer });
    await cdp.shot('04-drawer');
    check(drawer.copy, 'the drawer has no Copy session id control');
    await cdp.key('Escape', 'Escape');
    await sleep(300);
    check(!(await cdp.eval(STATE)).drawer, 'Escape did not close the drawer');

    // Idle row and ended strip.
    for (const [selector, name] of [['.tc-idle summary', '05-idle-open'], ['.tc-ended summary', '06-ended-open']]) {
      if (await cdp.eval(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
        await cdp.click(selector);
        await sleep(300);
        await cdp.shot(name);
        results.steps.push({ step: name, ...(await cdp.eval(STATE)) });
      } else results.steps.push({ step: `${name}: none on screen` });
    }

    // Copy session id, read back from the OS clipboard.
    savedClipboard = powershell('Get-Clipboard -Raw');
    const expected = await cdp.eval(`(() => { const card = [...document.querySelectorAll('.tc-card')].find((c) => c.querySelector('[aria-label="Copy session id"]')); return card ? card.dataset.memberId : null; })()`);
    if (expected) {
      await cdp.click(`.tc-card[data-member-id="${expected}"] [aria-label="Copy session id"]`);
      await sleep(300);
      const tick = await cdp.eval(`document.querySelector('.tc-card[data-member-id="${expected}"] [aria-label="Copy session id"]').textContent`);
      const clip = powershell('Get-Clipboard -Raw').trim();
      results.steps.push({ step: 'copy session id', expected, tick, clipboard: clip });
      await cdp.shot('07-copied');
      check(tick === '✓', 'the copy control did not show its tick');
      check(clip === expected, `clipboard holds ${clip}, expected ${expected}`);
    } else check(false, 'no card with a copyable session id');

    // A live sub-worker with a session opens its conversation from the tray.
    const subTarget = await cdp.eval(`(() => { const li = [...document.querySelectorAll('.tc-sub')].find((el) => el.querySelector('.tc-sub-copy')); if (!li) return null; li.setAttribute('data-drive-sub', '1'); return { key: li.dataset.subKey, name: li.querySelector('.tc-sub-name').textContent }; })()`);
    if (subTarget) {
      const sessionId = subTarget.key.replace(/^session:/, '');
      await cdp.click('[data-drive-sub="1"] .tc-sub-open');
      await sleep(1500);
      // The requested session, in a real conversation window (a stage tile,
      // not a rail row), marked read-only like the old list opened it.
      const opened = await cdp.eval(`(() => { const tile = document.querySelector('.win2[data-session-id="${sessionId}"]'); return { chart: Boolean(document.querySelector('.team-chart')), tile: Boolean(tile), readOnly: Boolean(tile?.querySelector('.ro-flag')) }; })()`);
      results.steps.push({ step: 'open a live sub-worker', ...subTarget, ...opened });
      await cdp.shot('08-sub-opened');
      check(opened.tile, `opening sub-worker ${subTarget.name} did not open its own conversation window: ${JSON.stringify(opened)}`);
      check(opened.readOnly, `sub-worker ${subTarget.name} opened writable; machine-made sessions open read-only`);
      if (!opened.chart) {
        await cdp.click('.view-switch-btn[aria-label="Orch"]');
        await waitFor(cdp, `Boolean(document.querySelector('.team-chart'))`, 'team chart again');
      }
    } else results.steps.push({ step: 'open a live sub-worker: NOT CHECKED, none with a session on the board right now' });

    if (START_SESSION) {
      const parent = process.env.CLAUDE_CODE_SESSION_ID;
      const before = new Set(await cdp.eval(`[...document.querySelectorAll('.tc-card')].map((c) => c.dataset.memberId)`));
      const worker = spawn(process.execPath, ['C:/tools/claude-worker/claude-worker.mjs', '--cd', path.resolve(APP_DIR, '..'), '--model', 'haiku', '--effort', 'low', '--max-turns', '4',
        '--prompt', 'Team chart drive check. Run the shell command `sleep 25` once with the Bash tool, then reply with the single word done.'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      worker.stderr.on('data', (chunk) => { stderr += chunk; });
      const exited = new Promise((resolve) => worker.on('exit', resolve));
      let sessionId = null;
      for (let i = 0; i < 60 && !sessionId; i += 1) { await sleep(500); sessionId = /session id: ([0-9a-f-]{36})/.exec(stderr)?.[1] || null; }
      check(Boolean(sessionId), 'the worker never printed its session id');
      await waitFor(cdp, `Boolean(document.querySelector('.tc-card[data-member-id="${sessionId}"]'))`, 'the new worker card', 90000);
      await sleep(1500);
      const card = await cdp.eval(`(() => { const c = document.querySelector('.tc-card[data-member-id="${sessionId}"]'); return { text: c.innerText, parentRendered: Boolean(document.querySelector('.tc-card[data-member-id="${parent}"]')) }; })()`);
      results.steps.push({ step: 'session started', sessionId, parent, card, newCards: (await cdp.eval(`[...document.querySelectorAll('.tc-card')].map((c) => c.dataset.memberId)`)).filter((id) => !before.has(id)) });
      await cdp.eval(`document.querySelector('.tc-card[data-member-id="${sessionId}"]').scrollIntoView({ block: 'center' }); true`);
      await sleep(400);
      await cdp.shot('08-session-started');
      await exited;
      await waitFor(cdp, `!document.querySelector('.tc-card[data-member-id="${sessionId}"]')`, 'the worker card to leave', 90000);
      await waitFor(cdp, `[...document.querySelectorAll('.tc-ended li')].length > 0`, 'the ended strip', 30000);
      if (!(await cdp.eval(`Boolean(document.querySelector('.tc-ended[open]'))`))) await cdp.click('.tc-ended summary');
      await sleep(400);
      await cdp.eval(`document.querySelector('.tc-ended').scrollIntoView({ block: 'center' }); true`);
      await sleep(300);
      const endedText = await cdp.eval(`document.querySelector('.tc-ended').innerText`);
      results.steps.push({ step: 'session ended', endedText: endedText.slice(0, 600) });
      await cdp.shot('09-session-ended');
    }
  } catch (error) {
    results.failures.push(`drive stopped: ${error.message}`);
  } finally {
    if (savedClipboard != null) { try { fs.writeFileSync(path.join(tmp, 'clip.txt'), savedClipboard); powershell(`Set-Clipboard -Value (Get-Content -Raw -LiteralPath '${path.join(tmp, 'clip.txt').replace(/'/g, "''")}')`); } catch { /* best effort */ } }
    child.kill();
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ out: OUT, failures: results.failures, steps: results.steps.length }, null, 2));
    setTimeout(() => process.exit(results.failures.length ? 1 : 0), 500);
  }
}

main();
