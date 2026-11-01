#!/usr/bin/env node
'use strict';

// The phone quality-of-life drive (2026-10-31, Pat, from a screenshot of a
// working session on his iPhone): the composer as one card (Stop beside Send on
// its toolbar, no row of its own), a "new session here" button and a one-tap
// "copy session id" button in the header.
//
// Composes harbor-server on loopback with relocated stores, synthetic sessions,
// fake launches and no daemon, serves a BUILT phone bundle (pass its folder; build
// it into a scratch folder, never `npm run build:web`, whose output is what the
// live phone server serves), and drives headless Chromium with touch taps at the
// three widths Pat's phone can be (375, 390, 430). Every state screenshots into
// the evidence folder and asserts where a number can say it.
//
//   node scripts/drive-phone-qol-win.js <distDir> <evidenceDir> [--only=a,b]
//   node scripts/drive-phone-qol-win.js <distDir> <evidenceDir> --measure
//
// --measure takes only the geometry (text box width per state, header title
// width and row-two room) and asserts nothing; it writes measure.json next to the
// shots. The checking run holds the header title to the widths the shipped bundle
// gave before this change, in BASE_TITLE_WIDTH below: it must not lose a pixel.
// (Before the change the text box measured 255, 270 and 310px at 375, 390 and
// 430, and a working chat added a Stop row above it.)

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { realTmpDir } = require('../test/support/real-tmpdir.js');

const APP_ROOT = path.resolve(__dirname, '..');
const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const flag = (name) => (flags.find((arg) => arg.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const ONLY = flag('only').split(',').filter(Boolean);
const MEASURE = flags.includes('--measure');
const DIST = path.resolve(positional[0] || path.join(APP_ROOT, 'dist-web'));
const EVIDENCE = path.resolve(positional[1] || path.join(realTmpDir(), 'harbor-drive-phone-qol'));
const SIZES = [
  { name: '375', width: 375, height: 812 },
  { name: '390', width: 390, height: 844 },
  { name: '430', width: 430, height: 932 },
];
const SAFE = { top: 47, bottom: 34 };
// The keyboard and its accessory bar start at 59% of the screen (measured off a
// real screenshot on 2026-10-21), so the visible area is 41%.
const visibleWithKeyboard = (size) => Math.round(size.height * 0.59);

const WORKING_ID = '71111111-1111-4111-8111-111111111111';
const IDLE_ID = '72222222-2222-4222-8222-222222222222';
const WORKTREE_ID = '73333333-3333-4333-8333-333333333333';
const CODEX_ID = '74444444-4444-4444-8444-444444444444';
const PROVISIONAL_ID = 'pane:fixture-7';
const OTHER_ID = '75555555-5555-4555-8555-555555555555';
const LONG_TITLE = 'Orchestrating cdt-app push 16 kickoff and the follow-up review of the Prep fixes before release';
const DRAFT = 'Also queue the second pass for the Merge mode once the first batch lands.';

async function shot(page, name, { clip } = {}) {
  const file = path.join(EVIDENCE, `${name}.png`);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(`screenshot: ${file}`);
  return file;
}

function minutesAgo(minutes) { return Date.now() - minutes * 60_000; }

function transcriptBlocks() {
  const ts = (minutes) => new Date(minutesAgo(minutes)).toISOString();
  return [
    { key: 'u1', kind: 'user', text: 'Kick off push 16 and tell me what is still open on Prep.', ts: ts(42) },
    { key: 'a1', kind: 'assistant', text: 'Starting push 16. Three things are still open on Prep:\n\n1. **Dependents written only as children.** One run showed it and it never repeated.\n2. **The wage column on Edit.** Fixed in 16h, waiting on a second run.\n3. **Column inventory.** Only matters for parity, not for the release.', ts: ts(41) },
    { key: 't1', kind: 'action', verb: 'Read', chip: 'MAP-push16-blast-radius.md', status: 'ok', ts: ts(40) },
    { key: 't2', kind: 'action', verb: 'Ran', chip: 'node scripts/queue-runs.mjs --push 16 --modes prep,edit,merge', status: 'ok', ts: ts(40) },
    { key: 'a2', kind: 'assistant', text: 'Queued 14 runs. The first results land in about ten minutes.', ts: ts(38) },
    { key: 'u2', kind: 'user', text: 'Good. When the map lands, check Prep first.', ts: ts(12) },
  ];
}

// A state can start or end a turn in any chat (fx.setWorking); otherwise only the
// working fixture is working.
const workingNow = new Map();
function headerFor(sessionId) {
  const base = {
    processAlive: true, contextPct: 21, model: { id: 'claude-opus-5-5', label: 'Opus 5.5' }, effort: 'xhigh',
    cacheTouchedMs: minutesAgo(2), cacheTtlMs: 3_600_000, lastWriteMs: minutesAgo(2),
  };
  return { ...base, working: workingNow.has(sessionId) ? workingNow.get(sessionId) : sessionId === WORKING_ID };
}

async function makeFixture(root) {
  const home = path.join(root, 'home');
  const userDataDir = path.join(root, 'user-data');
  const work = path.join(root, 'work');
  const dirs = {
    cdt: path.join(work, 'cdt-app'),
    worktree: path.join(work, 'cdt-app-prep-worktree'),
    codex: path.join(work, 'codex-sandbox'),
    harbor: path.join(work, 'harbor'),
    census: path.join(work, 'census-tool'),
  };
  await Promise.all([home, userDataDir, ...Object.values(dirs)].map((dir) => fs.mkdir(dir, { recursive: true })));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('HARBOR_') || key.startsWith('CLAUDE_') || key.startsWith('CODEX_')) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex-empty'),
    HARBOR_CONFIG_FILE: path.join(userDataDir, 'config.json'),
    HARBOR_NO_DAEMON_START: '1', HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_MODEL_DISCOVERY: '1', HARBOR_NO_TITLER: '1', HARBOR_NO_VOICE: '1',
    HARBOR_CONTEXT_DIR: path.join(root, 'context'),
    HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
    HARBOR_SESSIOND_SOCKET: path.join(root, 'sessiond', 'isolated.sock'),
    HARBOR_ARTIFACTS_ROOTS: path.join(root, 'artifacts'),
    HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifacts.json'),
    HARBOR_TASKS_FILE: path.join(userDataDir, 'tasks.json'),
    HARBOR_NOTES_FILE: path.join(userDataDir, 'notes.json'),
    HARBOR_PROJECT_ICONS_DIR: path.join(root, 'icons'),
    HARBOR_MODEL_CACHE_FILE: path.join(root, 'claude-models.json'),
    HARBOR_ASK_DIR: path.join(root, 'asks'),
    HARBOR_E2E_FAKE_LAUNCH: '1', HARBOR_TAILNET_LOGINS: 'none',
    HARBOR_WEB_DIST: DIST,
  });
  const { composeServer } = require('../src/server/compose.js');
  const profiles = [
    { id: 'personal', label: 'Personal', provider: 'claude', isDefault: true, email: null, configHome: path.join(home, 'claude-personal'), letter: 'P', color: '#437FFE' },
    { id: 'alpha', label: 'Alpha', provider: 'claude', isDefault: false, email: null, configHome: path.join(home, 'claude-alpha'), letter: 'S', color: '#2E8B57' },
    { id: 'team', label: 'Team', provider: 'claude', isDefault: false, email: null, configHome: path.join(home, 'claude-team'), letter: 'T', color: '#D4A537' },
  ];
  await fs.writeFile(process.env.HARBOR_CONFIG_FILE, JSON.stringify({
    setup: { completed: true }, profiles,
    providers: { claude: { enabled: true }, codex: { enabled: true } },
    paths: { cacheDir: root, projectsDir: path.join(home, 'projects'), projectIconsDir: path.join(root, 'icons') },
  }));

  const sessions = [
    { id: WORKING_ID, project: 'cdt-app', cwd: dirs.cdt, provider: 'claude', title: LONG_TITLE, isLive: true, paneId: 'pane-work', workspaceId: 'ws-work', agentStatus: 'working', home: 'alpha', model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', effort: 'xhigh', contextPct: 21, lastActiveMs: minutesAgo(1), firstPrompt: 'Kick off push 16' },
    { id: IDLE_ID, project: 'harbor', cwd: dirs.harbor, provider: 'claude', title: 'Phone server restarts', isLive: true, paneId: 'pane-idle', workspaceId: 'ws-idle', agentStatus: 'idle', home: 'alpha', model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', effort: 'xhigh', contextPct: 21, lastActiveMs: minutesAgo(3), firstPrompt: 'harbor mobile' },
    { id: WORKTREE_ID, project: 'cdt-app', cwd: dirs.worktree, provider: 'claude', title: 'Prep fixes in a worktree', isLive: true, paneId: 'pane-wt', workspaceId: 'ws-wt', agentStatus: 'idle', home: 'team', model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', effort: 'high', contextPct: 21, lastActiveMs: minutesAgo(4), firstPrompt: 'worktree' },
    { id: CODEX_ID, project: 'codex-sandbox', cwd: dirs.codex, provider: 'codex', title: 'Codex scratch session', isLive: true, paneId: 'pane-codex', workspaceId: 'ws-codex', agentStatus: 'idle', model: 'gpt-5.5', modelLabel: 'GPT 5.5', effort: 'high', lastActiveMs: minutesAgo(5), firstPrompt: 'codex' },
    { id: PROVISIONAL_ID, project: 'census-tool', cwd: dirs.census, provider: 'claude', title: 'New window just opened', isLive: true, paneId: 'pane-prov', workspaceId: 'ws-prov', agentStatus: 'idle', home: 'personal', model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', effort: 'high', lastActiveMs: minutesAgo(6), firstPrompt: 'x' },
    { id: OTHER_ID, project: 'census-tool', cwd: dirs.census, provider: 'claude', title: 'Another census session', isLive: false, home: 'personal', lastActiveMs: minutesAgo(300), firstPrompt: 'x' },
  ];
  const state = { model: { projects: [] } };
  const byLabel = new Map();
  for (const s of sessions) {
    if (!byLabel.has(s.project)) byLabel.set(s.project, { label: s.project, sessions: [] });
    byLabel.get(s.project).sessions.push(s);
  }
  state.model.projects = [...byLabel.values()];

  const sends = [];
  const interrupts = [];
  const launches = [];
  let lastLaunchAt = 0;
  const transcriptEmitter = new EventEmitter();
  const composed = await composeServer({
    userDataDir, configFile: process.env.HARBOR_CONFIG_FILE, env: process.env,
    skipDaemonStart: true, selfOriginHosts: [],
    sidebar: {
      emitter: new EventEmitter(), async start() {}, close() {},
      getState: () => state,
      getSessionMeta: async (id) => sessions.find((s) => s.id === id) || null,
      getSessionPreview: async () => null, focusLivePane: async () => ({ ok: true }),
      isDelegated: () => false, isDelegatedPane: () => false,
    },
    icons: { async list() { return { icons: {} }; }, watch() {} },
    transcript: {
      emitter: transcriptEmitter,
      async open(sessionId) {
        setTimeout(() => transcriptEmitter.emit('update', { sessionId, replace: transcriptBlocks(), header: headerFor(sessionId) }), 20);
        return { ok: true };
      },
      close() {}, closeAll() {},
    },
    terminalBridge: { emitter: new EventEmitter(), async start() {}, close() {}, async sendInput(paneId, data) { interrupts.push({ paneId, data }); return { ok: true }; } },
    sessionSend: {
      emitter: new EventEmitter(), getQueueState: () => ({ count: 0, items: [] }), cancelQueued: () => ({ ok: true }),
      async getMenu() { return null; },
      async answerMenu() { return { ok: true }; },
      async getWorkMeter() { return null; },
      async readPermissionMode() { return { mode: 'default' }; },
      async send(payload) { sends.push(payload); await new Promise((resolve) => setTimeout(resolve, 900)); return { ok: true }; },
    },
    capabilities: { async get() { return { models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], commands: [{ name: '/model', source: 'built-in', description: 'Switch the model' }, { name: '/compact', source: 'built-in', description: 'Summarize the conversation so far' }, { name: '/review', source: 'skill', description: 'Review the pending changes' }], plugins: [] }; } },
    usage: { async getUsage() { return { ok: true, fiveHour: { pct: 12 }, weekly: { pct: 66 } }; } },
    accounts: { readEmails: async () => ({}) },
    onFakeLaunch: (record) => { launches.push(record); lastLaunchAt = Date.now(); },
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  // The server answers a second new-session within 3s of the last with the FIRST
  // one's result (a double-tap guard in actions/launch.js), so a state that starts
  // a session waits that out first.
  const untilLaunchAllowed = async () => {
    const wait = 3300 - (Date.now() - lastLaunchAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
  const setWorking = (sessionId, value) => {
    if (value === undefined) workingNow.delete(sessionId); else workingNow.set(sessionId, value);
    transcriptEmitter.emit('update', { sessionId, replace: transcriptBlocks(), header: headerFor(sessionId) });
  };
  return { composed, sends, interrupts, launches, untilLaunchAllowed, setWorking, dirs, baseUrl: `http://127.0.0.1:${address.port}` };
}

// The insets an installed iOS web app gets on a notched phone. Chromium reports
// env(safe-area-inset-*) as 0, so the tokens are overridden after load.
async function applyInsets(page) {
  await page.addStyleTag({ content: `:root { --safe-top: ${SAFE.top}px !important; --safe-bottom: ${SAFE.bottom}px !important; }` });
}

// The phone's socket passes through to the real server. It is routed so a state
// can (a) take a folder out of the candidate list the server answers, to prove
// the sheet shows and uses a chat's folder the server did not list, (b) drop the
// link, and (c) record exactly what the phone asked for.
async function routeLink(page) {
  const link = { online: true, current: null, hideFolder: null, calls: [] };
  await page.routeWebSocket(/\/ws/, (ws) => {
    if (!link.online) { ws.close({ code: 1006, reason: '' }); return; }
    link.current = ws;
    const server = ws.connectToServer();
    const methods = new Map();
    ws.onMessage((message) => {
      try {
        const parsed = JSON.parse(String(message));
        if (parsed?.id != null && parsed.method) {
          methods.set(parsed.id, parsed.method);
          link.calls.push({ method: parsed.method, payload: parsed.payload });
        }
      } catch { /* pass it through untouched */ }
      server.send(message);
    });
    server.onMessage((message) => {
      try {
        const parsed = JSON.parse(String(message));
        if (parsed?.type === 'response' && methods.get(parsed.id) === 'new-session:folder' && link.delayFolderMs) {
          setTimeout(() => ws.send(message), link.delayFolderMs);
          return;
        }
        if (parsed?.type === 'response' && methods.get(parsed.id) === 'new-session:folder' && link.hideFolder && Array.isArray(parsed.result)) {
          parsed.result = parsed.result.filter((folder) => folder !== link.hideFolder);
          link.lastFolderList = parsed.result;
          ws.send(JSON.stringify(parsed));
          return;
        }
      } catch { /* pass it through untouched */ }
      ws.send(message);
    });
  });
  link.drop = async () => { link.online = false; await link.current?.close({ code: 1006, reason: '' }).catch(() => {}); };
  link.restore = () => { link.online = true; };
  return link;
}

async function newPage(browser, fx, size, { clipboard = true, initScript = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
  });
  if (clipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fx.baseUrl });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  currentPage = page;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const link = await routeLink(page);
  await page.goto(`${fx.baseUrl}/#token=${fx.composed.token}&url=${encodeURIComponent(fx.baseUrl)}`);
  await applyInsets(page);
  await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 20000 });
  return { context, page, errors, link };
}

async function openChat(page, title) {
  await page.getByRole('button', { name: /Switch session/ }).first().click();
  await page.locator('.session-row', { hasText: title }).first().click();
  await expect(page.locator('.app-header')).toContainText(title);
  await page.waitForTimeout(450);
}

async function tap(page, locator) {
  const box = await locator.boundingBox();
  assert.ok(box, 'the control to tap is on screen');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function keyboardUp(page, size) {
  await page.setViewportSize({ width: size.width, height: visibleWithKeyboard(size) });
  await page.waitForTimeout(350);
}

async function keyboardDown(page, size) {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.waitForTimeout(250);
}

const RECT = `(el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || r.height === 0) return null;
  return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) };
}`;

// The composer, measured. The card is the unit: the text box fills it edge to
// edge, the toolbar sits along its bottom edge, and every toolbar circle shares a
// size and a centre line.
async function composerGeometry(page) {
  return page.evaluate(`(() => {
    const rect = ${RECT};
    const q = (selector) => document.querySelector(selector);
    const card = q('.composer-card');
    const cardStyle = card ? getComputedStyle(card) : null;
    const field = q('.composer-field textarea');
    const fieldStyle = field ? getComputedStyle(field) : null;
    const stops = [...document.querySelectorAll('.composer button')].filter((b) => /^stop$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
    const send = q('.composer-send');
    return {
      composer: rect(q('.composer')),
      card: rect(card),
      cardRadius: cardStyle ? parseFloat(cardStyle.borderTopLeftRadius) : null,
      cardBorder: cardStyle ? parseFloat(cardStyle.borderTopWidth) : null,
      textarea: rect(field),
      textareaPadLeft: fieldStyle ? parseFloat(fieldStyle.paddingLeft) : null,
      textareaFont: fieldStyle ? parseFloat(fieldStyle.fontSize) : null,
      bar: rect(q('.composer-bar')),
      plus: rect(q('.composer-plus')),
      send: rect(send),
      sendDisabled: send ? send.disabled : null,
      sendInBar: Boolean(send && send.closest('.composer-bar')),
      strip: rect(q('.composer-strip')),
      stops: stops.map((b) => ({ ...rect(b), inBar: Boolean(b.closest('.composer-bar')) })),
      outsideCard: [...document.querySelectorAll('.composer-stop, .composer-send, .composer-plus')].filter((b) => !b.closest('.composer-card')).length,
      visible: Math.round(window.visualViewport?.height || window.innerHeight),
    };
  })()`);
}

// Two boxes are the same place and size, to a sub-pixel of rounding.
function sameBox(a, b, label, tolerance = 0.6) {
  assert.ok(a && b, `${label}: both boxes exist`);
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(a[key] - b[key]) <= tolerance, `${label}: ${key} moved, ${a[key]} vs ${b[key]}`);
  }
}

// The card pattern, asserted on one measurement: one card, 24px corners, a thin
// border, the text box at the card's FULL inner width with 24px of padding, the
// toolbar 12px in from the card's left, right and bottom edges, and the toolbar
// circles one size (40px) on one centre line, all inside the card.
function assertCardPattern(g, label) {
  assert.ok(g.card, `${label}: one composer card`);
  assert.equal(g.cardRadius, 24, `${label}: the card has 24px corners`);
  assert.equal(g.cardBorder, 1, `${label}: the card has a thin border`);
  assert.equal(g.outsideCard, 0, `${label}: no composer button sits outside the card`);
  assert.ok(Math.abs(g.textarea.x - (g.card.x + 1)) <= 0.6 && Math.abs(g.textarea.width - (g.card.width - 2)) <= 0.6,
    `${label}: the text box fills the card's inner width (box ${g.textarea.x}+${g.textarea.width}, card ${g.card.x}+${g.card.width})`);
  assert.equal(g.textareaPadLeft, 24, `${label}: 24px of padding before the text`);
  assert.equal(g.textareaFont, 16, `${label}: 16px text (iOS does not zoom)`);
  assert.ok(g.sendInBar && g.plus && g.send, `${label}: tools toggle and Send are on the toolbar`);
  assert.ok(Math.abs(g.plus.x - (g.card.x + 1 + 12)) <= 0.6, `${label}: the plus is 12px from the card's left edge (${g.plus.x - g.card.x - 1})`);
  assert.ok(Math.abs((g.card.right - 1 - 12) - g.send.right) <= 0.6, `${label}: Send is 12px from the card's right edge (${g.card.right - 1 - g.send.right})`);
  assert.ok(Math.abs((g.card.bottom - 1 - 12) - g.send.bottom) <= 0.6, `${label}: Send is 12px from the card's bottom edge (${g.card.bottom - 1 - g.send.bottom})`);
  const circles = [g.plus, g.send, ...g.stops];
  for (const circle of circles) {
    assert.equal(circle.width, 40, `${label}: every toolbar circle is 40px wide`);
    assert.equal(circle.height, 40, `${label}: every toolbar circle is 40px tall`);
    assert.ok(Math.abs((circle.y + circle.height / 2) - (g.plus.y + g.plus.height / 2)) <= 0.6, `${label}: the circles share one centre line`);
  }
  for (const stop of g.stops) assert.equal(stop.inBar, true, `${label}: Stop is on the toolbar`);
}

// What is under nine points of a 44px square centred on `rect` (corners at 18px:
// the control's corners are rounded): every one must resolve to `selector` (or a
// child of it), so the tap area really is 44px.
async function assertTapArea(page, rect, selector, label, { round = false } = {}) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const misses = await page.evaluate(({ cx, cy, selector, round }) => {
    // A round control (Send) has no corners: its diagonals are tested on the circle.
    const diagonal = round ? 14 : 18;
    const offsets = [[-diagonal, -diagonal], [diagonal, -diagonal], [-diagonal, diagonal], [diagonal, diagonal], [0, 0], [-21, 0], [21, 0], [0, -21], [0, 21]];
    return offsets.map(([dx, dy]) => {
      const hit = document.elementFromPoint(cx + dx, cy + dy);
      return hit && hit.closest(selector) ? null : `${dx},${dy} -> ${hit ? (hit.className || hit.tagName) : 'nothing'}`;
    }).filter(Boolean);
  }, { cx, cy, selector, round });
  assert.deepEqual(misses, [], `${label}: a 44px square around the control is all its tap area`);
}

// The header, measured against the title it must not shrink.
async function headerGeometry(page) {
  return page.evaluate(`(() => {
    const rect = ${RECT};
    const title = document.querySelector('.hdr-title');
    const strip = document.querySelector('.hdr-strip');
    const stripKids = strip ? [...strip.querySelectorAll(':scope > *')].map((el) => ({ cls: el.className.toString().slice(0, 40), ...rect(el) })) : [];
    const used = stripKids.filter((k) => k.width != null);
    return {
      header: rect(document.querySelector('.app-header')),
      headerTop: rect(document.querySelector('.header-top')),
      session: rect(document.querySelector('.hdr-session')),
      kicker: rect(document.querySelector('.hdr-kicker')),
      icon: rect(document.querySelector('.hdr-session .project-icon, .hdr-session .project-dot')),
      tools: rect(document.querySelector('.hdr-tools')),
      newBtn: rect(document.querySelector('.hdr-act-new')),
      idBtn: rect(document.querySelector('.hdr-act-id')),
      settings: rect(document.querySelector('.hdr-settings')),
      title: rect(title),
      titleLines: title ? Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)) : null,
      titleClamped: title ? title.scrollHeight > title.clientHeight + 1 : null,
      strip: rect(strip),
      stripOverflow: strip ? strip.scrollWidth - strip.clientWidth : null,
      stripKids,
      stripRightmost: used.length ? Math.max(...used.map((k) => k.right)) : null,
    };
  })()`);
}

// What the title had before this change, measured off the shipped bundle at the
// base commit with --measure (long title, 2-line clamp): it must not lose a pixel.
const BASE_TITLE_WIDTH = { 375: 227, 390: 242, 430: 282 };

// A failing state leaves its last screen behind (and the sheet's own error, if any).
async function failShot(page, error) {
  const text = await page.locator('.newsession-error').allTextContents().catch(() => []);
  if (text.length) console.log(`  sheet error: ${text.join(' | ')}`);
  await shot(page, `FAIL-${String(error?.message || error).slice(0, 24).replace(/[^a-z0-9]+/gi, '-')}`).catch(() => {});
}

let currentPage = null;
const results = { composer: {}, header: {} };

const STATES = {
  // -------------------------------------------------- composer: the numbers
  // The card pattern in three states and a keyboard: idle (Send), working with an
  // empty box ([Stop][Send], Send muted), working with a draft ([Stop][Send], Send
  // ready). The toolbar must not move between them.
  async composerWidths(browser, fx) {
    for (const size of SIZES) {
      const { context, page, errors } = await newPage(browser, fx, size);
      try {
        await openChat(page, 'Phone server restarts');
        const idle = await composerGeometry(page);
        await shot(page, `c1-idle-${size.name}`, { clip: { x: 0, y: size.height - 240, width: size.width, height: 240 } });
        await tap(page, page.locator('.composer-field textarea'));
        await keyboardUp(page, size);
        const idleKeyboard = await composerGeometry(page);
        await shot(page, `k3-idle-keyboard-${size.name}`, { clip: { x: 0, y: 0, width: size.width, height: visibleWithKeyboard(size) } });
        await keyboardDown(page, size);
        await page.locator('.composer-field textarea').blur();
        await openChat(page, LONG_TITLE);
        await page.waitForTimeout(400);
        const working = await composerGeometry(page);
        await shot(page, `c2-working-empty-${size.name}`, { clip: { x: 0, y: size.height - 240, width: size.width, height: 240 } });
        await page.locator('.composer-field textarea').fill(DRAFT);
        await page.waitForTimeout(250);
        const draft = await composerGeometry(page);
        await shot(page, `c3-working-draft-${size.name}`, { clip: { x: 0, y: size.height - 260, width: size.width, height: 260 } });
        await tap(page, page.locator('.composer-field textarea'));
        await keyboardUp(page, size);
        const draftKeyboard = await composerGeometry(page);
        await keyboardDown(page, size);
        const px = (g) => ({ textarea: g.textarea?.width, card: g.card?.width, composerHeight: g.composer?.height, stops: g.stops.length });
        results.composer[size.name] = {
          idle: px(idle), idleKeyboard: px(idleKeyboard), workingEmpty: px(working), workingDraft: px(draft), workingDraftKeyboard: px(draftKeyboard),
          toolbar: { plus: working.plus, stop: working.stops[0], send: working.send },
        };
        console.log(`composer widths ${size.name}: ${JSON.stringify(results.composer[size.name])}`);
        if (!MEASURE) {
          for (const [label, g] of Object.entries({ idle, idleKeyboard, working, draft, draftKeyboard })) assertCardPattern(g, `${size.name} ${label}`);
          // Idle: Send alone, muted without a draft; no Stop; no extra row.
          assert.equal(idle.stops.length, 0, `${size.name} idle: no Stop`);
          assert.equal(idle.sendDisabled, true, `${size.name} idle, empty: Send is muted`);
          assert.equal(idle.strip, null, `${size.name} idle: no chip strip`);
          // Working: both buttons, always, in that order, Stop left of Send.
          for (const [label, g] of Object.entries({ working, draft, draftKeyboard })) {
            assert.equal(g.stops.length, 1, `${size.name} ${label}: exactly one Stop`);
            assert.ok(Math.abs(g.send.x - (g.stops[0].right + 16)) <= 0.6, `${size.name} ${label}: Stop is just left of Send with the 16px gap (${g.stops[0].right} -> ${g.send.x})`);
            // Stop is the one action with no undo: 12px between the two 44px tap areas.
            assert.ok((g.send.x - 2) - (g.stops[0].right + 2) >= 12, `${size.name} ${label}: 12px between the Stop and Send tap areas`);
          }
          assert.equal(working.sendDisabled, true, `${size.name} working, empty box: Send is muted`);
          assert.equal(draft.sendDisabled, false, `${size.name} working, draft: Send is ready (a draft queues behind the turn)`);
          // The toolbar never moves: the same boxes in idle, working-empty and working-draft.
          sameBox(working.stops[0], draft.stops[0], `${size.name} Stop, working-empty vs working-draft`);
          sameBox(working.send, draft.send, `${size.name} Send, working-empty vs working-draft`);
          sameBox(working.plus, draft.plus, `${size.name} plus, working-empty vs working-draft`);
          for (const key of ['x', 'width', 'height']) assert.ok(Math.abs(idle.send[key] - working.send[key]) <= 0.6, `${size.name}: Send ${key} is the same idle and working`);
          // No row was spent on Stop, and a running turn adds nothing to the composer.
          assert.equal(working.composer.height, idle.composer.height, `${size.name}: a running turn adds no height (${working.composer.height} vs ${idle.composer.height})`);
          assert.equal(working.textarea.width, idle.textarea.width, `${size.name}: the text box keeps its width while working`);
          assert.equal(draft.textarea.width, idle.textarea.width, `${size.name}: and with a draft`);
          // The keyboard-up composer keeps the full width too and stays on screen.
          assert.ok(draftKeyboard.bar.bottom <= draftKeyboard.visible + 0.5, `${size.name} keyboard up: the toolbar is above the keyboard (${draftKeyboard.bar.bottom} of ${draftKeyboard.visible})`);
          assert.ok(draftKeyboard.composer.height <= draftKeyboard.visible * 0.4 + 1, `${size.name} keyboard up: the composer keeps to 40% of what is visible (${draftKeyboard.composer.height} of ${draftKeyboard.visible})`);
          for (const [label, g] of Object.entries({ idle, working, draft })) {
            await assertTapArea(page, g.plus, '.composer-plus', `${size.name} ${label} plus`, { round: true });
            await assertTapArea(page, g.send, '.composer-send', `${size.name} ${label} Send`, { round: true });
          }
          await assertTapArea(page, working.stops[0], '.composer-stop', `${size.name} Stop`, { round: true });
          // The gap between them belongs to neither: a stray tap there cannot stop the turn.
          const gapHit = await page.evaluate(({ x, y }) => { const hit = document.elementFromPoint(x, y); return hit?.closest('.composer-stop, .composer-send') ? (hit.className || hit.tagName) : null; }, { x: working.stops[0].right + 8, y: working.stops[0].y + 20 });
          assert.equal(gapHit, null, `${size.name}: the gap between Stop and Send is a dead zone`);
        }
        assert.deepEqual(errors, [], 'no browser runtime errors');
      } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
    }
  },
  // Touch taps on Stop in every state it can be in: box empty or holding a draft,
  // keyboard down or up. Stop never changes place, so there is nothing to guard.
  async stopTaps(browser, fx) {
    for (const size of SIZES) {
      const { context, page, errors } = await newPage(browser, fx, size);
      try {
        await openChat(page, LONG_TITLE);
        const box = page.locator('.composer-field textarea');
        const stopBtn = page.getByRole('button', { name: 'Stop', exact: true });
        // Empty box, keyboard down.
        await expect(stopBtn).toHaveCount(1);
        const emptyDown = await composerGeometry(page);
        let before = fx.interrupts.length;
        await tap(page, stopBtn);
        await expect.poll(() => fx.interrupts.length, { timeout: 3000 }).toBe(before + 1);
        assert.deepEqual(fx.interrupts.at(-1), { paneId: 'pane-work', data: '\x1b' }, `${size.name}: the tap sent Escape to the working pane`);
        // A draft, keyboard down: the same Stop in the same place.
        await box.fill(DRAFT);
        await page.waitForTimeout(200);
        sameBox((await composerGeometry(page)).stops[0], emptyDown.stops[0], `${size.name} Stop with a draft vs without`);
        before = fx.interrupts.length;
        await tap(page, stopBtn);
        await expect.poll(() => fx.interrupts.length, { timeout: 3000 }).toBe(before + 1);
        await expect(box).toHaveValue(DRAFT);
        // Keyboard up, draft in the box.
        await tap(page, box);
        await keyboardUp(page, size);
        assert.equal(await page.locator('.app-shell').getAttribute('data-typing'), 'true', `${size.name}: typing mode with the keyboard up`);
        const g = await composerGeometry(page);
        assert.equal(g.stops.length, 1);
        assert.ok(g.stops[0].bottom <= g.visible + 0.5 && g.stops[0].y >= 0, `${size.name}: Stop is inside the visible area (${g.stops[0].y}..${g.stops[0].bottom} of ${g.visible})`);
        const covered = await page.evaluate(({ x, y, w, h }) => {
          const hit = document.elementFromPoint(x + w / 2, y + h / 2);
          return hit?.closest('.composer-stop') ? null : (hit?.className || hit?.tagName || 'nothing');
        }, { x: g.stops[0].x, y: g.stops[0].y, w: g.stops[0].width, h: g.stops[0].height });
        assert.equal(covered, null, `${size.name}: nothing covers Stop with the keyboard up`);
        await shot(page, `k1-working-draft-keyboard-${size.name}`, { clip: { x: 0, y: 0, width: size.width, height: visibleWithKeyboard(size) } });
        before = fx.interrupts.length;
        await tap(page, stopBtn);
        await expect.poll(() => fx.interrupts.length, { timeout: 3000 }).toBe(before + 1);
        assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', `${size.name}: tapping Stop leaves focus in the box (no lost first tap)`);
        assert.equal(await page.locator('.app-shell').getAttribute('data-typing'), 'true', `${size.name}: tapping Stop keeps the keyboard up`);
        // Keyboard up, empty box: Stop has not moved.
        await box.fill('');
        await page.waitForTimeout(250);
        const g2 = await composerGeometry(page);
        assert.equal(g2.stops.length, 1, `${size.name}: empty box, keyboard up: Stop is there`);
        assert.ok(g2.stops[0].bottom <= g2.visible + 0.5, `${size.name}: Stop reachable, empty box, keyboard up`);
        assert.ok(Math.abs(g2.stops[0].x - g.stops[0].x) <= 0.6 && Math.abs(g2.stops[0].bottom - g.stops[0].bottom) <= 0.6, `${size.name}: Stop did not move when the draft went`);
        await shot(page, `k2-working-empty-keyboard-${size.name}`, { clip: { x: 0, y: 0, width: size.width, height: visibleWithKeyboard(size) } });
        before = fx.interrupts.length;
        await tap(page, stopBtn);
        await expect.poll(() => fx.interrupts.length, { timeout: 3000 }).toBe(before + 1);
        assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', `${size.name}: focus stays in the box after Stop`);
        assert.deepEqual(errors, [], 'no browser runtime errors');
      } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
    }
  },
  // The reason the old 500 ms guard existed was a double tap on Send landing on a
  // Stop that had taken its place. Send never gives its place away now: the second
  // tap lands on Send (muted by then) and does nothing.
  async sendDoubleTap(browser, fx) {
    const size = SIZES[1];
    const { context, page, errors } = await newPage(browser, fx, size);
    try {
      await openChat(page, LONG_TITLE);
      await page.locator('.composer-field textarea').fill(DRAFT);
      const before = await composerGeometry(page);
      const sends = fx.sends.length;
      const interrupts = fx.interrupts.length;
      const spot = { x: before.send.x + before.send.width / 2, y: before.send.y + before.send.height / 2 };
      await page.touchscreen.tap(spot.x, spot.y);
      await page.touchscreen.tap(spot.x, spot.y); // the second tap of a double tap, right where Send is
      await expect.poll(() => fx.sends.length, { timeout: 3000 }).toBe(sends + 1);
      await page.waitForTimeout(700);
      assert.equal(fx.sends.length, sends + 1, 'a double tap on Send sends once');
      assert.equal(fx.interrupts.length, interrupts, 'a double tap on Send does not stop the turn');
      await expect(page.locator('.composer-field textarea')).toHaveValue('');
      const after = await composerGeometry(page);
      sameBox(after.send, before.send, 'Send after sending');
      sameBox(after.stops[0], before.stops[0], 'Stop after sending');
      assert.equal(after.sendDisabled, true, 'Send is muted again once the draft is gone');
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
  },
  // Attachments are the card's header: chips on top, inside the card, and the
  // toolbar does not move for them. An attachment alone is a draft.
  async attachments(browser, fx) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    for (const size of SIZES) for (const [kind, title] of [['idle', 'Phone server restarts'], ['working', LONG_TITLE]]) {
      const { context, page, errors } = await newPage(browser, fx, size);
      try {
        await openChat(page, title);
        const bare = await composerGeometry(page);
        await tap(page, page.getByRole('button', { name: 'Show composer tools' }));
        await page.locator('.composer-attach input').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png });
        await expect(page.locator('.attach-chip')).toHaveCount(1, { timeout: 8000 });
        await page.waitForTimeout(300);
        const g = await composerGeometry(page);
        assertCardPattern(g, `${size.name} ${kind} with an attachment`);
        assert.ok(g.strip, `${size.name} ${kind}: the chip strip is drawn while there is an attachment`);
        assert.ok(g.strip.y >= g.card.y && g.strip.bottom <= g.textarea.y + 0.5, `${size.name} ${kind}: the chips sit inside the card, above the text box`);
        assert.equal(g.sendDisabled, false, `${size.name} ${kind}: an attachment alone is a draft, Send is ready`);
        sameBox(g.send, bare.send, `${size.name} ${kind}: Send with and without an attachment`);
        sameBox(g.plus, bare.plus, `${size.name} ${kind}: plus with and without an attachment`);
        if (kind === 'working') {
          assert.equal(g.stops.length, 1, `${size.name} working with an attachment: Stop beside Send`);
          sameBox(g.stops[0], bare.stops[0], `${size.name} Stop with and without an attachment`);
        } else {
          assert.equal(g.stops.length, 0, `${size.name} idle with an attachment: no Stop`);
        }
        await shot(page, `a1-${kind}-attachment-${size.name}`, { clip: { x: 0, y: size.height - 270, width: size.width, height: 270 } });
        await tap(page, page.locator('.composer-field textarea'));
        await keyboardUp(page, size);
        const typing = await composerGeometry(page);
        assert.ok(typing.bar.bottom <= typing.visible + 0.5, `${size.name} ${kind}: the toolbar is above the keyboard with an attachment`);
        assert.ok(typing.composer.height <= typing.visible * 0.4 + 1, `${size.name} ${kind}: the composer keeps to 40% of what is visible (${typing.composer.height} of ${typing.visible})`);
        assert.ok(typing.textarea.height >= 44, `${size.name} ${kind}: the text box still shows a line (${typing.textarea.height}px)`);
        await shot(page, `a2-${kind}-attachment-keyboard-${size.name}`, { clip: { x: 0, y: 0, width: size.width, height: visibleWithKeyboard(size) } });
        assert.deepEqual(errors, [], 'no browser runtime errors');
      } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
    }
  },
  // ------------------------------------------------------------------ header
  async headerWidths(browser, fx) {
    for (const size of SIZES) {
      const { context, page, errors } = await newPage(browser, fx, size);
      try {
        await openChat(page, LONG_TITLE);
        const g = await headerGeometry(page);
        // Typing: the same chat with the keyboard up.
        await page.locator('.composer-field textarea').click();
        await keyboardUp(page, size);
        const typing = await headerGeometry(page);
        await keyboardDown(page, size);
        await page.locator('.composer-field textarea').blur();
        await page.waitForTimeout(250);
        results.header[size.name] = {
          title: g.title, titleLines: g.titleLines, titleClamped: g.titleClamped, header: g.header, headerTop: g.headerTop,
          stripOverflow: g.stripOverflow, stripKids: g.stripKids, stripRightmost: g.stripRightmost, strip: g.strip, tools: g.tools, kicker: g.kicker,
          typing: { header: typing.header, title: typing.title, titleLines: typing.titleLines },
        };
        console.log(`header ${size.name}: title ${g.title?.width}px x ${g.titleLines} lines (clamped ${g.titleClamped}); header ${g.header?.height}px; strip overflow ${g.stripOverflow}px; typing header ${typing.header?.height}px, title ${typing.title?.width}px`);
        await shot(page, `h1-header-${size.name}`, { clip: { x: 0, y: 0, width: size.width, height: 190 } });
        if (!MEASURE) {
          assert.ok(g.title.width >= BASE_TITLE_WIDTH[size.name], `${size.name}: the title is ${g.title.width}px, was ${BASE_TITLE_WIDTH[size.name]}px: it must not lose a pixel`);
          assert.ok(g.titleLines <= 2, `${size.name}: title stays within two lines`);
          assert.equal(g.stripOverflow, 0, `${size.name}: row two clips nothing`);
          assert.ok(g.newBtn && g.idBtn && g.settings, `${size.name}: new, id and settings are all there`);
          for (const [name, rect, selector] of [['new session here', g.newBtn, '.hdr-act-new'], ['copy id', g.idBtn, '.hdr-act-id'], ['settings', g.settings, '.hdr-settings']]) {
            assert.ok(rect.width >= 44 && rect.height >= 44, `${size.name}: ${name} is ${rect.width}x${rect.height}`);
            await assertTapArea(page, rect, selector, `${size.name} ${name}`);
          }
          assert.ok(g.kicker.right <= g.tools.x + 1, `${size.name}: the project line stops short of the buttons (${g.kicker.right} vs ${g.tools.x})`);
          assert.ok(g.tools.right <= size.width, `${size.name}: the buttons are on screen`);
          // Typing: one line, the two session buttons gone, the title still there.
          assert.ok(typing.header.height <= 70, `${size.name}: typing header is one line (${typing.header.height}px)`);
          assert.equal(typing.titleLines, 1, `${size.name}: typing title is one line`);
          assert.equal(typing.newBtn, null, `${size.name}: typing hides new session here`);
          assert.equal(typing.idBtn, null, `${size.name}: typing hides copy id`);
          assert.ok(typing.settings, `${size.name}: settings stays while typing`);
          assert.ok(typing.title.right <= typing.settings.x + 1, `${size.name}: the typing title does not run under settings`);
          // The whole header is still the session switcher: the title and the icon open it.
          await tap(page, page.locator('.hdr-title'));
          await expect(page.locator('.session-browser')).toBeVisible();
          await page.getByRole('button', { name: 'Close sessions' }).click({ force: true }).catch(() => {});
          await page.waitForTimeout(300);
        }
        assert.deepEqual(errors, [], 'no browser runtime errors');
      } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
    }
  },
  // A short title, and every status the project line can carry, at the narrowest width.
  async headerVariants(browser, fx) {
    const size = SIZES[0];
    const { context, page, errors } = await newPage(browser, fx, size);
    try {
      await openChat(page, 'Phone server restarts');
      const g = await headerGeometry(page);
      console.log(`short title 375: header ${g.header.height}px, title ${g.title.width}px x ${g.titleLines}, kicker ${g.kicker.width}px`);
      await shot(page, 'h2-header-short-375', { clip: { x: 0, y: 0, width: size.width, height: 190 } });
      await openChat(page, 'New window just opened');
      const p = await headerGeometry(page);
      await shot(page, 'h3-header-provisional-375', { clip: { x: 0, y: 0, width: size.width, height: 190 } });
      assert.ok(p.idBtn, 'the id button keeps its place for a provisional session');
      await expect(page.locator('.hdr-act-id')).toBeDisabled();
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
  },
  async headerOffline(browser, fx) {
    for (const size of [SIZES[0], SIZES[2]]) {
      const { context, page, link, errors } = await newPage(browser, fx, size);
      try {
        await openChat(page, 'Phone server restarts');
        const before = await headerGeometry(page);
        await link.drop();
        await page.locator('.app-shell[data-connection="offline"]').waitFor({ timeout: 8000 });
        await page.waitForTimeout(600);
        const after = await headerGeometry(page);
        await shot(page, `h4-header-reconnecting-${size.name}`, { clip: { x: 0, y: 0, width: size.width, height: 190 } });
        const reconnecting = await page.evaluate(() => {
          const project = document.querySelector('.hdr-project');
          const status = document.querySelector('.hdr-status');
          return { project: project.scrollWidth - project.clientWidth, status: status ? status.scrollWidth - status.clientWidth : 0, projectText: project.textContent };
        });
        console.log(`reconnecting kicker ${size.name}: ${JSON.stringify(reconnecting)}`);
        assert.ok(reconnecting.project <= 1, `${size.name}: the project name reads in full while reconnecting (${reconnecting.projectText}, ${reconnecting.project}px clipped)`);
        await page.waitForTimeout(5500);
        await shot(page, `h5-header-offline-${size.name}`, { clip: { x: 0, y: 0, width: size.width, height: 190 } });
        assert.ok(after.header.height <= before.header.height + 1, `${size.name}: a drop costs no header height (${before.header.height} -> ${after.header.height})`);
        // Offline both session buttons step aside for the pill: a new session needs
        // the host, and at 375 the pill's words plus two more buttons squeezed the
        // project name to "HAR...".
        await expect(page.locator('.hdr-act-new')).toHaveCount(0);
        await expect(page.locator('.hdr-act-id')).toHaveCount(0);
        const kickerNow = await headerGeometry(page);
        assert.ok(kickerNow.kicker.right <= kickerNow.tools.x + 1, `${size.name}: the project line stops short of the pill and buttons`);
        const clipped = await page.evaluate(() => {
          const project = document.querySelector('.hdr-project');
          const status = document.querySelector('.hdr-status');
          return { project: project.scrollWidth - project.clientWidth, status: status ? status.scrollWidth - status.clientWidth : 0, projectText: project.textContent, statusText: status?.textContent };
        });
        console.log(`offline kicker ${size.name}: ${JSON.stringify(clipped)}`);
        assert.ok(clipped.project <= 1, `${size.name}: the project name reads in full offline (${clipped.projectText}, ${clipped.project}px clipped)`);
        // The pill's card opens inside the screen.
        await tap(page, page.locator('.conn-pill'));
        await page.waitForTimeout(200);
        const pop = await page.locator('.conn-pop').boundingBox();
        assert.ok(pop && pop.x >= 0 && pop.x + pop.width <= size.width + 0.5, `${size.name}: the connection card is on screen: ${JSON.stringify(pop)}`);
        await shot(page, `h6-offline-card-${size.name}`, { clip: { x: 0, y: 0, width: size.width, height: 330 } });
        assert.deepEqual(errors, [], 'no browser runtime errors');
      } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
    }
  },
  // ---------------------------------------------------- new session from a chat
  async newSessionHere(browser, fx) {
    for (const size of [SIZES[1], SIZES[2]]) {
      const { context, page, link, errors } = await newPage(browser, fx, size);
      try {
        fx.launches.length = 0;
        await openChat(page, 'Phone server restarts');
        await tap(page, page.getByRole('button', { name: /^New Claude session \(Alpha\) in harbor$/ }));
        const sheet = page.locator('.newsession-sheet');
        await expect(sheet).toBeVisible();
        await expect(page.locator('.newsession-provider')).not.toHaveCount(0);
        await page.waitForTimeout(500);
        // The folder, provider and plan are the chat's. Model and effort are the sheet's defaults.
        await expect(page.locator('.newsession-chosen')).toContainText('harbor');
        await expect(page.locator('.newsession-chosen')).toContainText(fx.dirs.harbor);
        await expect(page.locator('.newsession-provider.on')).toHaveText('Claude');
        await expect(page.locator('.plan-choices button[aria-pressed="true"]')).toContainText('Alpha');
        await expect(page.locator('.newsession-select')).toBeVisible();
        await expect(page.locator('.newsession-effort.on')).toHaveCount(1);
        await expect(page.locator('.newsession-folder-list')).toHaveCount(0);
        await expect(page.locator('.newsession-summary')).toContainText('Alpha');
        await expect(page.locator('.newsession-summary')).toContainText('harbor');
        const modelValue = await page.locator('.newsession-select').inputValue();
        const effortOn = await page.locator('.newsession-effort.on').textContent();
        console.log(`sheet from chat ${size.name}: model ${modelValue}, effort ${effortOn}`);
        await shot(page, `n1-sheet-from-chat-${size.name}`);
        // The folder can still be changed.
        await tap(page, page.getByRole('button', { name: 'Change', exact: true }));
        await expect(page.locator('.newsession-folder-list')).toBeVisible();
        await shot(page, `n2-sheet-change-folder-${size.name}`);
        await tap(page, page.locator('.newsession-folder', { hasText: 'census-tool' }).first());
        await expect(page.locator('.newsession-chosen')).toContainText('census-tool');
        await expect(page.locator('.newsession-folder-list')).toHaveCount(0);
        // Back to the chat's own folder and start.
        await tap(page, page.getByRole('button', { name: 'Change', exact: true }));
        await tap(page, page.locator('.newsession-folder', { hasText: 'harbor' }).first());
        await expect(page.locator('.newsession-chosen')).toContainText(fx.dirs.harbor);
        await fx.untilLaunchAllowed();
        await tap(page, page.getByRole('button', { name: 'Start session', exact: true }));
        await expect.poll(() => fx.launches.length, { timeout: 5000 }).toBe(1);
        const launch = fx.launches[0];
        assert.equal(path.normalize(launch.options.cwd), path.normalize(fx.dirs.harbor), `${size.name}: the session starts in the chat's folder`);
        const arg = (flagName) => launch.argv[launch.argv.indexOf(flagName) + 1];
        assert.ok(String(arg('--home')).endsWith('claude-alpha'), `${size.name}: on the chat's plan (${arg('--home')})`);
        assert.equal(arg('--model'), modelValue === 'default' ? undefined : modelValue, `${size.name}: the sheet's default model`);
        const request = link.calls.filter((c) => c.method === 'new-session').at(-1)?.payload;
        assert.equal(request.folder, fx.dirs.harbor);
        assert.equal(request.sessionId, IDLE_ID);
        await expect(sheet).toHaveCount(0);
        const active = await page.evaluate(() => localStorage.getItem('harbor-web-active'));
        assert.equal(active, arg('--session-id'), `${size.name}: the new session is the one that opens`);
        assert.deepEqual(errors, [], 'no browser runtime errors');
      } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
    }
  },
  // The chat's folder is not in the server's candidate list: still shown, still used.
  async newSessionHereUnlisted(browser, fx) {
    const size = SIZES[1];
    const { context, page, link, errors } = await newPage(browser, fx, size);
    try {
      fx.launches.length = 0;
      link.hideFolder = fx.dirs.worktree;
      await openChat(page, 'Prep fixes in a worktree');
      await tap(page, page.locator('.hdr-act-new'));
      await expect(page.locator('.newsession-chosen')).toContainText('cdt-app-prep-worktree');
      await expect(page.locator('.newsession-chosen')).toContainText(fx.dirs.worktree);
      await expect(page.locator('.plan-choices button[aria-pressed="true"]')).toContainText('Team');
      // The list the server answered really left it out.
      assert.ok(Array.isArray(link.lastFolderList) && !link.lastFolderList.includes(fx.dirs.worktree), 'the candidate list did not hold the chat folder');
      await tap(page, page.getByRole('button', { name: 'Change', exact: true }));
      await expect(page.locator('.newsession-folder.on')).toContainText(fx.dirs.worktree);
      await shot(page, 'n3-unlisted-folder-picker-390');
      await tap(page, page.getByRole('button', { name: 'Done', exact: true }));
      await expect(page.locator('.newsession-folder-list')).toHaveCount(0);
      await fx.untilLaunchAllowed();
        await tap(page, page.getByRole('button', { name: 'Start session', exact: true }));
      await expect.poll(() => fx.launches.length, { timeout: 5000 }).toBe(1);
      assert.equal(path.normalize(fx.launches[0].options.cwd), path.normalize(fx.dirs.worktree), 'it starts in the unlisted folder');
      const folderResponse = link.calls.find((c) => c.method === 'new-session:folder');
      assert.deepEqual(folderResponse.payload, { sessionId: WORKTREE_ID }, 'the phone tells the server which chat the folder came from');
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
  },
  async newSessionHereCodex(browser, fx) {
    const size = SIZES[1];
    const { context, page, errors } = await newPage(browser, fx, size);
    try {
      fx.launches.length = 0;
      await openChat(page, 'Codex scratch session');
      // A chat with no plan of its own names none.
      await tap(page, page.getByRole('button', { name: 'New Codex session in codex-sandbox', exact: true }));
      await expect(page.locator('.newsession-provider.on')).toHaveText('Codex');
      await expect(page.locator('.newsession-chosen')).toContainText('codex-sandbox');
      await shot(page, 'n4-sheet-from-codex-chat-390');
      await fx.untilLaunchAllowed();
        await tap(page, page.getByRole('button', { name: 'Start session', exact: true }));
      await expect.poll(() => fx.launches.length, { timeout: 5000 }).toBe(1);
      assert.equal(fx.launches[0].argv[fx.launches[0].argv.indexOf('--provider') + 1], 'codex');
      assert.equal(path.normalize(fx.launches[0].options.cwd), path.normalize(fx.dirs.codex));
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
  },
  // The session browser's plus is unchanged: its defaults, its list at the bottom.
  async newSessionBrowserUnchanged(browser, fx) {
    const size = SIZES[1];
    const { context, page, errors } = await newPage(browser, fx, size);
    try {
      await openChat(page, 'Phone server restarts');
      await page.getByRole('button', { name: /Switch session/ }).first().click();
      await tap(page, page.locator('.session-browser-add'));
      await expect(page.locator('.newsession-sheet')).toBeVisible();
      await page.waitForTimeout(500);
      await expect(page.locator('.newsession-chosen')).toHaveCount(0);
      await expect(page.locator('.newsession-folder-list')).toBeVisible();
      await expect(page.locator('.plan-choices button[aria-pressed="true"]')).toContainText('Personal');
      await shot(page, 'n5-sheet-from-browser-390');
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
  },
  // A multi-line draft is in the box when a turn starts (and again when it ends):
  // the last line must not clip. In the old layout Stop appeared beside the box and
  // narrowed it; in the card the box keeps its width, and the effect also
  // remeasures if the width ever does change.
  async draftClip(browser, fx) {
    const draft = 'First line of a longer message.\nSecond line, long enough to wrap onto another row at a phone width.\nThird line that ends the draft: LAST WORDS';
    for (const size of SIZES) {
      const { context, page, errors } = await newPage(browser, fx, size);
      try {
        await openChat(page, 'Phone server restarts');
        const box = page.locator('.composer-field textarea');
        await box.fill(draft);
        await page.waitForTimeout(250);
        const idle = await composerGeometry(page);
        const clipped = () => page.evaluate(() => { const t = document.querySelector('.composer-field textarea'); return { scroll: t.scrollHeight, client: t.clientHeight, width: t.offsetWidth, overflowY: getComputedStyle(t).overflowY }; });
        const before = await clipped();
        assert.ok(before.scroll <= before.client + 1, `${size.name} idle: the whole draft shows (${before.scroll} in ${before.client})`);
        assert.ok(idle.textarea.height > 80, `${size.name}: it really is several lines (${idle.textarea.height}px)`);
        await shot(page, `d1-draft-idle-${size.name}`, { clip: { x: 0, y: size.height - 300, width: size.width, height: 300 } });
        fx.setWorking(IDLE_ID, true);
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(1, { timeout: 5000 });
        await page.waitForTimeout(300);
        const working = await composerGeometry(page);
        const during = await clipped();
        assert.ok(during.scroll <= during.client + 1, `${size.name} a turn starts: the last line does not clip (${during.scroll} in ${during.client})`);
        assert.equal(during.width, before.width, `${size.name}: the box did not change width when the turn started`);
        assert.ok(Math.abs(working.textarea.height - idle.textarea.height) <= 1, `${size.name}: the box kept its height (${idle.textarea.height} -> ${working.textarea.height})`);
        assert.equal(await box.inputValue(), draft, `${size.name}: the draft is untouched`);
        await shot(page, `d2-draft-turn-starts-${size.name}`, { clip: { x: 0, y: size.height - 300, width: size.width, height: 300 } });
        // With the keyboard up the budget is tighter: still no clipped last line.
        await tap(page, box);
        await keyboardUp(page, size);
        const typing = await clipped();
        const typingGeo = await composerGeometry(page);
        assert.ok(typing.scroll <= typing.client + 1 || typing.overflowY === 'auto', `${size.name} keyboard up: the draft shows or scrolls (${typing.scroll} in ${typing.client})`);
        assert.ok(typingGeo.bar.bottom <= typingGeo.visible + 0.5, `${size.name} keyboard up: the toolbar is above the keyboard`);
        await shot(page, `d3-draft-turn-keyboard-${size.name}`, { clip: { x: 0, y: 0, width: size.width, height: visibleWithKeyboard(size) } });
        await keyboardDown(page, size);
        fx.setWorking(IDLE_ID, false);
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 5000 });
        await page.waitForTimeout(300);
        const after = await clipped();
        assert.ok(after.scroll <= after.client + 1, `${size.name} the turn ends: the last line does not clip (${after.scroll} in ${after.client})`);
        assert.equal(after.width, before.width, `${size.name}: the box kept its width when the turn ended`);
        assert.deepEqual(errors, [], 'no browser runtime errors');
      } catch (error) { await failShot(page, error); throw error; } finally { fx.setWorking(IDLE_ID, undefined); await context.close(); }
    }
  },
  // The sheet belongs to ONE open: a second open from another chat must not show the
  // first one's folder (with Start live) while its own list loads, and a first open
  // must not flash "No candidate folders" before the list arrives (2026-10-31 review).
  async sheetFirstOpen(browser, fx) {
    const size = SIZES[1];
    const { context, page, link, errors } = await newPage(browser, fx, size);
    try {
      const start = page.getByRole('button', { name: 'Start session', exact: true });
      await openChat(page, 'Phone server restarts');
      link.delayFolderMs = 1800;
      await page.getByRole('button', { name: /Switch session/ }).first().click();
      await tap(page, page.locator('.session-browser-add'));
      await expect(page.locator('.newsession-sheet')).toBeVisible();
      await page.waitForTimeout(500);
      assert.equal(await page.locator('.newsession-empty', { hasText: 'No candidate folders' }).count(), 0, 'no "No candidate folders" flash while the list loads');
      await expect(page.locator('.newsession-empty')).toContainText('Loading folders');
      await expect(start).toBeDisabled();
      await shot(page, 'n6-sheet-first-open-loading-390');
      await expect(page.locator('.newsession-folder-list')).toBeVisible({ timeout: 8000 });
      await expect(start).toBeEnabled();
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
  },
  async sheetSecondOpen(browser, fx) {
    const size = SIZES[1];
    const { context, page, link, errors } = await newPage(browser, fx, size);
    try {
      const start = page.getByRole('button', { name: 'Start session', exact: true });
      await openChat(page, 'Phone server restarts');
      await tap(page, page.locator('.hdr-act-new'));
      await expect(page.locator('.newsession-chosen')).toContainText(fx.dirs.harbor);
      await expect(start).toBeEnabled({ timeout: 5000 });
      await tap(page, page.getByRole('button', { name: 'Close', exact: true }));
      await expect(page.locator('.newsession-sheet')).toHaveCount(0);
      await openChat(page, 'Prep fixes in a worktree');
      link.delayFolderMs = 1800;
      await tap(page, page.locator('.hdr-act-new'));
      await expect(page.locator('.newsession-sheet')).toBeVisible();
      await page.waitForTimeout(400);
      const chosen = await page.locator('.newsession-chosen').textContent();
      assert.ok(chosen.includes(path.basename(fx.dirs.worktree)), `the second open shows its own chat's folder (${chosen})`);
      assert.ok(!chosen.includes(fx.dirs.harbor), 'and not the first open\'s folder');
      await expect(start).toBeDisabled();
      await shot(page, 'n7-sheet-second-open-loading-390');
      await expect(start).toBeEnabled({ timeout: 8000 });
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
  },
  // The slash palette opens over the card at the card's width, and the card's border
  // (not a bar down the text box) says whether the command is known.
  async slashCard(browser, fx) {
    for (const size of SIZES) {
      const { context, page, errors } = await newPage(browser, fx, size);
      try {
        await openChat(page, 'Phone server restarts');
        const box = page.locator('.composer-field textarea');
        await tap(page, box);
        await box.fill('/mod');
        await expect(page.locator('.slash-palette')).toBeVisible();
        const card = await composerGeometry(page);
        const palette = await page.locator('.slash-palette').boundingBox();
        assert.ok(Math.abs(palette.x - card.textarea.x) <= 1 && Math.abs(palette.width - card.textarea.width) <= 1, `${size.name}: the palette is as wide as the card (${palette.width} vs ${card.textarea.width})`);
        assert.ok(palette.y + palette.height <= card.card.y + 0.5, `${size.name}: the palette sits above the card, covering nothing of it`);
        await page.waitForTimeout(400);
        await shot(page, `s1-slash-palette-${size.name}`, { clip: { x: 0, y: Math.max(0, size.height - 520), width: size.width, height: 520 } });
        await box.fill('/model ');
        await page.waitForTimeout(300); // the border eases its colour in 120ms
        const valid = await page.evaluate(() => getComputedStyle(document.querySelector('.composer-card')).borderTopColor);
        await box.fill('/nosuchthing ');
        await page.waitForTimeout(300); // the border eases its colour in 120ms
        const invalid = await page.evaluate(() => getComputedStyle(document.querySelector('.composer-card')).borderTopColor);
        await box.fill('plain words');
        await page.waitForTimeout(300); // the border eases its colour in 120ms
        const plain = await page.evaluate(() => getComputedStyle(document.querySelector('.composer-card')).borderTopColor);
        assert.notEqual(valid, invalid, `${size.name}: a known and an unknown command read differently (${valid} / ${invalid})`);
        assert.notEqual(valid, plain);
        assert.notEqual(invalid, plain);
        await box.fill('/model ');
        await page.waitForTimeout(300);
        await shot(page, `s2-slash-valid-${size.name}`, { clip: { x: 0, y: size.height - 240, width: size.width, height: 240 } });
        await box.fill('/nosuchthing ');
        await page.waitForTimeout(300);
        await shot(page, `s3-slash-invalid-${size.name}`, { clip: { x: 0, y: size.height - 240, width: size.width, height: 240 } });
        assert.deepEqual(errors, [], 'no browser runtime errors');
      } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
    }
  },
  // -------------------------------------------------------------- copy the id
  async copyId(browser, fx) {
    for (const size of SIZES) {
      const { context, page, errors } = await newPage(browser, fx, size);
      try {
        await openChat(page, 'Phone server restarts');
        await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
        const button = page.locator('.hdr-act-id');
        await expect(button).toHaveAttribute('data-copy-state', 'idle');
        await tap(page, button);
        await expect(button).toHaveAttribute('data-copy-state', 'copied');
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        assert.equal(clip, IDLE_ID, `${size.name}: the clipboard holds the session id`);
        await expect(button).toHaveAccessibleName('Session id copied');
        await expect(page.locator('.hdr-live')).toHaveText('Session id copied');
        assert.equal(await page.locator('.hdr-live').getAttribute('aria-live'), 'polite', `${size.name}: the status is a polite live region`);
        await shot(page, `i1-copied-${size.name}`, { clip: { x: 0, y: 0, width: size.width, height: 190 } });
        await expect(button).toHaveAttribute('data-copy-state', 'idle', { timeout: 3000 });
        await expect(page.locator('.hdr-live')).toHaveText('');
        assert.deepEqual(errors, [], 'no browser runtime errors');
      } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
    }
  },
  // No async clipboard (an http address): the textarea copy runs inside the tap.
  async copyIdFallback(browser, fx) {
    const size = SIZES[1];
    const { context, page, errors } = await newPage(browser, fx, size, {
      clipboard: false,
      initScript: () => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        document.execCommand = (command) => {
          if (command !== 'copy') return false;
          const area = [...document.querySelectorAll('body > textarea')].pop();
          window.__copied = area ? area.value.substring(area.selectionStart, area.selectionEnd) : null;
          return true;
        };
      },
    });
    try {
      await openChat(page, 'Phone server restarts');
      await tap(page, page.locator('.hdr-act-id'));
      await expect(page.locator('.hdr-act-id')).toHaveAttribute('data-copy-state', 'copied');
      assert.equal(await page.evaluate(() => window.__copied), IDLE_ID, 'the fallback selected and copied the id');
      assert.equal(await page.locator('body > textarea').count(), 0, 'the hidden textarea is removed');
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
  },
  // Neither path lands: the check must not show.
  async copyIdFails(browser, fx) {
    const size = SIZES[1];
    const { context, page, errors } = await newPage(browser, fx, size, {
      clipboard: false,
      initScript: () => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
        document.execCommand = () => false;
      },
    });
    try {
      await openChat(page, 'Phone server restarts');
      await tap(page, page.locator('.hdr-act-id'));
      await expect(page.locator('.hdr-act-id')).toHaveAttribute('data-copy-state', 'failed');
      await expect(page.locator('.hdr-act-id')).toHaveAccessibleName('Could not copy the session id');
      await expect(page.locator('.hdr-live')).toHaveText('Could not copy the session id');
      await shot(page, 'i2-copy-failed-390', { clip: { x: 0, y: 0, width: size.width, height: 190 } });
      assert.equal(await page.locator('.hdr-act-id.is-copied').count(), 0, 'no check for a copy that did not land');
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
  },
  async copyIdProvisional(browser, fx) {
    const size = SIZES[1];
    const { context, page, errors } = await newPage(browser, fx, size);
    try {
      await openChat(page, 'New window just opened');
      await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
      const button = page.locator('.hdr-act-id');
      await expect(button).toBeDisabled();
      await expect(button).toHaveAccessibleName('Session id not available yet');
      await button.click({ force: true }).catch(() => {});
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'sentinel', 'nothing was copied for a provisional id');
      // New session here still works from a provisional window: it has a folder.
      await expect(page.locator('.hdr-act-new')).toBeEnabled();
      assert.deepEqual(errors, [], 'no browser runtime errors');
    } catch (error) { await failShot(page, error); throw error; } finally { await context.close(); }
  },
};

async function main() {
  await fs.access(path.join(DIST, 'index.html'));
  const originalEnv = { ...process.env };
  const browserEnv = { ...originalEnv };
  delete browserEnv.ELECTRON_RUN_AS_NODE;
  const root = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-phone-qol-'));
  await fs.mkdir(EVIDENCE, { recursive: true });
  let fx;
  let browser;
  const failures = [];
  try {
    fx = await makeFixture(root);
    console.log(`isolated server: ${fx.baseUrl}; bundle ${DIST}; evidence ${EVIDENCE}${MEASURE ? '; MEASURE only' : ''}`);
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), env: browserEnv });
    const names = Object.keys(STATES).filter((name) => (!ONLY.length || ONLY.includes(name)) && (!MEASURE || /Widths$/.test(name)));
    for (const name of names) {
      try {
        await STATES[name](browser, fx);
        console.log(`PASS ${name}`);
      } catch (error) {
        failures.push(`${name}: ${error.message.split('\n')[0]}`);
        console.log(`FAIL ${name}: ${error.stack || error.message}`);
        if (currentPage) {
          await shot(currentPage, `FAIL-${name}`).catch(() => {});
          const text = await currentPage.locator('.newsession-error').allTextContents().catch(() => []);
          if (text.length) console.log(`  sheet error: ${text.join(' | ')}`);
        }
      }
    }
    await fs.writeFile(path.join(EVIDENCE, 'measure.json'), JSON.stringify(results, null, 2));
    assert.deepEqual(fx.composed.isolation.signalCalls, [], 'no process signals');
  } finally {
    await browser?.close();
    await fx?.composed.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(root, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`FAIL phone qol drive:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS phone qol drive');
  }
}

main().catch((error) => {
  console.error(`FAIL phone qol drive: ${error.stack || error}`);
  process.exitCode = 1;
});
