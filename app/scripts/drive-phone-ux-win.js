#!/usr/bin/env node
'use strict';

// The phone UX sweep drive (2026-10-21, Pat: "whenever i opened it and it has to
// connect to server or if it disconnects then theres this massive fucking pinned
// header section that takes up over half the screen and then if i try to type
// anything then the keyboard takes up the other half").
//
// Composes harbor-server on loopback with relocated stores, synthetic sessions,
// fake launches and no daemon, serves the SHIPPED bundle (dist-web), and drives
// headless Chromium at iPhone 14 Pro Max size (430x932) with the notch and home
// bar insets an installed iOS web app gets. Every screen and connection state is
// captured to the evidence folder, and the layout is asserted where a number can
// say it: with the keyboard up the text you are typing is on screen and nothing
// covers it, and a dropped connection costs one header row, never half the
// screen.
//
// Keyboard emulation, both ways iOS can do it: RESIZE shrinks the layout and the
// visual viewport together (standalone mode on recent iOS); OVERLAY keeps the
// layout viewport full height and shrinks only window.visualViewport (Safari's
// classic behaviour). The visible area is 552px tall in both, measured off Pat's
// 2026-10-21 screenshot (keyboard plus accessory bar start at 59% of 932). A
// third, PANNED, is overlay plus the visual viewport scrolled down (offsetTop
// 338, Pat's 2026-11-09 screenshot), which is what Safari really does when the
// tapped field sits low on the screen; see typingPanned.
//
// Run from app (needs a built bundle): node scripts/drive-phone-ux-win.js [distDir] [evidenceDir] [--only=a,b]

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit, expect } = require('@playwright/test');

// --engine=webkit drives Safari's engine instead of Chromium (2026-11-01: the
// phone message box became a contenteditable, whose editing rules are the
// engine's own, and the phone is Safari). Needs `npx playwright install webkit`.
const ENGINE = (process.argv.find((arg) => arg.startsWith('--engine=')) || '--engine=chromium').slice(9);
function launchBrowser(env) {
  if (ENGINE === 'webkit') return webkit.launch({ headless: true, env });
  if (ENGINE !== 'chromium') throw new Error(`unknown --engine=${ENGINE} (chromium or webkit)`);
  return chromium.launch({ headless: true, executablePath: chromium.executablePath(), env });
}
const { realTmpDir } = require('../test/support/real-tmpdir.js');
const { parseMenu } = require('../src/main/menu-parse.js');

const APP_ROOT = path.resolve(__dirname, '..');
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const ONLY = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const DIST = path.resolve(positional[0] || path.join(APP_ROOT, 'dist-web'));
const EVIDENCE = path.resolve(positional[1] || path.join(realTmpDir(), 'harbor-drive-phone-ux'));
const PHONE = { width: 430, height: 932 };
const VISIBLE_WITH_KEYBOARD = 552;
// How far Safari scrolled the visual viewport down in Pat's 2026-11-09 screenshot.
const PANNED_OFFSET = 338;
const SAFE = { top: 47, bottom: 34 };
const LIVE_ID = '11111111-1111-4111-8111-111111111111';
const ASK_ID = '22222222-2222-4222-8222-222222222222';
const IDLE_ID = '33333333-3333-4333-8333-333333333333';
const TALL_ID = '55555555-5555-4555-8555-555555555555';
const FALLBACK_ID = '66666666-6666-4666-8666-666666666666';

const LONG_DRAFT = 'On that SSN one-digit-off example: these are exactly the kinds of things we absolutely have to catch before push 17 ships, so add a check that flags any dependent whose SSN differs from the employee record by one digit, and show me three real examples from the last run.';

async function shot(page, name, { clip } = {}) {
  const file = path.join(EVIDENCE, `${name}.png`);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log(`screenshot: ${file}`);
  return file;
}

function minutesAgo(minutes) { return Date.now() - minutes * 60_000; }

// A synthetic 320x200 PNG put in the server process's image store, the way the
// transcript provider stores every image since 2026-11-05: blocks carry the
// reference, the phone fetches /transcript-images/<id> when it draws it.
function solidPng(width, height, [r, g, b]) {
  const zlib = require('node:zlib');
  const crc32 = (buf) => { let crc = 0xffffffff; for (const byte of buf) { let c = (crc ^ byte) & 0xff; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const PHONE_IMAGE = (() => {
  const { imageStore } = require('../src/main/providers/image-store.js');
  const data = solidPng(320, 200, [235, 140, 40]).toString('base64');
  return { mediaType: 'image/png', ...imageStore.put('image/png', data) };
})();

function transcriptBlocks() {
  const ts = (minutes) => new Date(minutesAgo(minutes)).toISOString();
  // Earlier turns, so the conversation is long enough to scroll well away
  // from the latest message (the "Latest" pill needs a screenful).
  const earlier = Array.from({ length: 10 }, (_, index) => [
    { key: `eu${index}`, kind: 'user', text: `Status on run batch ${index + 1}?`, ts: ts(120 - index * 6) },
    { key: `ea${index}`, kind: 'assistant', text: `Batch ${index + 1} finished: ${8 + index} runs passed, ${index % 3} need a second look. The failures are in Merge, where two dependents share a name with the employee, and in Prep, where one file lists a child twice.`, ts: ts(119 - index * 6) },
  ]).flat();
  return [
    ...earlier,
    { key: 'img1', kind: 'user', text: 'Here is the screenshot of the failing row.', images: [PHONE_IMAGE], ts: ts(60) },
    { key: 'u1', kind: 'user', text: 'Kick off push 16 and tell me what is still open on Prep.', ts: ts(42) },
    { key: 'a1', kind: 'assistant', text: 'Starting push 16. Three things are still open on Prep:\n\n1. **Dependents written only as children.** One run showed it and it never repeated.\n2. **The wage column on Edit.** Fixed in 16h, waiting on a second run.\n3. **Column inventory.** Only matters for parity, not for the release.\n\nI will queue the runs that cover every passing result first.', ts: ts(41) },
    { key: 't1', kind: 'action', verb: 'Read', chip: 'MAP-push16-blast-radius.md', status: 'ok', ts: ts(40) },
    { key: 't2', kind: 'action', verb: 'Ran', chip: 'node scripts/queue-runs.mjs --push 16 --modes prep,edit,merge', status: 'ok', ts: ts(40) },
    { key: 't3', kind: 'action', verb: 'Edited', chip: 'state.md', pill: { text: '+12 −4', tone: 'ok' }, status: 'ok', ts: ts(39) },
    { key: 'a2', kind: 'assistant', text: 'Queued 14 runs. The first results land in about ten minutes.\n\n```\npush 16: 14 runs queued (prep 6, edit 4, merge 4)\n```', ts: ts(38) },
    { key: 'u2', kind: 'user', text: 'Good. When the map lands, check Prep first since it is the only mode still signed off.', ts: ts(12) },
    { key: 'a3', kind: 'assistant', text: 'I ruled on the push 17 risk map. Three changes come out of push 17 and wait for push 18, because each rests on a single run and could break something that passes today. Everything else stays: the fixes with repeated evidence, the Edit wage fix, and the two Merge fixes.\n\nPush 17 ships once those three changes are reverted and the extra runs are queued.', ts: ts(2) },
  ];
}

function headerFor(sessionId) {
  const now = Date.now();
  if (sessionId === LIVE_ID) {
    return { working: false, processAlive: true, contextPct: 21, model: { id: 'claude-opus-5-5', label: 'Opus 5.5' }, effort: 'medium', cacheTouchedMs: minutesAgo(2), cacheTtlMs: 3_600_000, lastWriteMs: minutesAgo(2) };
  }
  if (sessionId === ASK_ID) {
    return { working: false, blocked: true, processAlive: true, contextPct: 64, model: { id: 'claude-opus-5-5', label: 'Opus 5.5' }, effort: 'high', cacheTouchedMs: now - 30_000, cacheTtlMs: 3_600_000, lastWriteMs: now - 30_000 };
  }
  return { working: false, processAlive: false, contextTokens: 48_000, model: { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, lastWriteMs: minutesAgo(300) };
}

async function makeFixture(root) {
  const home = path.join(root, 'home');
  const userDataDir = path.join(root, 'user-data');
  const work = path.join(root, 'work');
  await Promise.all([home, userDataDir, work].map((dir) => fs.mkdir(dir, { recursive: true })));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('HARBOR_') || key.startsWith('CLAUDE_') || key.startsWith('CODEX_')) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home,
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
    { id: 'gordon', label: 'Gordon', provider: 'claude', isDefault: false, email: null, configHome: path.join(home, 'claude-gordon'), letter: 'G', color: '#2E8B57' },
  ];
  await fs.writeFile(process.env.HARBOR_CONFIG_FILE, JSON.stringify({
    setup: { completed: true }, profiles,
    providers: { claude: { enabled: true } },
    paths: { cacheDir: root, projectsDir: path.join(home, 'projects'), projectIconsDir: path.join(root, 'icons') },
  }));
  const now = Date.now();
  await fs.writeFile(process.env.HARBOR_TASKS_FILE, JSON.stringify({
    version: 1,
    lists: [{ id: 'l1', name: 'Work', color: '#437FFE', createdAt: now, order: 0 }, { id: 'l2', name: 'Home', color: '#24B27C', createdAt: now, order: 1 }],
    tasks: [
      ['Review push 17 risk map', 'l1', false, true], ['Send the census fix to the carrier team', 'l1', false, false],
      ['Approve the Prep re-runs', 'l1', true, false], ['Renew the domain', 'l2', false, false], ['Book the dentist', 'l2', false, false],
    ].map(([title, listId, done, starred], order) => ({ id: `t${order}`, listId, parentId: null, depth: 0, title, notes: '', done, completedAt: done ? now : null, completedBy: null, starred, myDayDate: null, dueDate: null, tags: [], createdAt: now, updatedAt: now, order })),
  }));
  await fs.writeFile(process.env.HARBOR_NOTES_FILE, JSON.stringify({
    version: 1,
    groups: [{ id: 'g1', name: 'Drafts', color: null, createdAt: now, order: 0 }],
    notes: [
      { id: 'n1', groupId: 'g1', title: 'Reply to the carrier', body: 'Thanks for the file. The corrected census is attached; two dependents were listed twice.', tags: [], pinned: true, createdAt: now, updatedAt: now },
      { id: 'n2', groupId: 'g1', title: 'Push 17 notes', body: 'Hold 16k, 16h part 2 and 16j for push 18.', tags: [], pinned: false, createdAt: now, updatedAt: now - 3_600_000 },
    ],
  }));

  const sessions = [
    { id: LIVE_ID, project: 'cdt-app', cwd: path.join(work, 'cdt-app'), provider: 'claude', title: 'Orchestrating cdt-app push 16 kickoff', isLive: true, paneId: 'pane-live', workspaceId: 'ws-live', agentStatus: 'idle', home: 'gordon', model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', effort: 'medium', contextPct: 21, lastActiveMs: minutesAgo(2), firstPrompt: 'Kick off push 16' },
    { id: ASK_ID, project: 'cdt-app', cwd: path.join(work, 'cdt-app'), provider: 'claude', title: 'Kill and resume queued Claude sessions', isLive: true, paneId: 'pane-ask', workspaceId: 'ws-ask', agentStatus: 'blocked', needsAnswer: true, home: 'personal', model: 'claude-opus-5-5', effort: 'high', contextPct: 64, lastActiveMs: minutesAgo(1), firstPrompt: 'Kill and resume' },
    { id: TALL_ID, project: 'census-tool', cwd: path.join(work, 'census-tool'), provider: 'claude', title: 'Pick the Prep fix to ship', isLive: true, paneId: 'pane-tall', workspaceId: 'ws-tall', agentStatus: 'blocked', needsAnswer: true, home: 'personal', model: 'claude-opus-5-5', effort: 'high', lastActiveMs: minutesAgo(1), firstPrompt: 'Prep' },
    { id: FALLBACK_ID, project: 'census-tool', cwd: path.join(work, 'census-tool'), provider: 'claude', title: 'Unknown dialog on screen', isLive: true, paneId: 'pane-fallback', workspaceId: 'ws-fallback', agentStatus: 'blocked', needsAnswer: true, home: 'personal', model: 'claude-opus-5-5', effort: 'high', lastActiveMs: minutesAgo(1), firstPrompt: 'x' },
    { id: IDLE_ID, project: 'harbor', cwd: path.join(work, 'harbor'), provider: 'claude', title: 'Phone server keeps restarting', isLive: false, home: 'personal', lastActiveMs: minutesAgo(300), firstPrompt: 'harbor mobile' },
    ...Array.from({ length: 9 }, (_, index) => ({ id: `4444444${index}-4444-4444-8444-444444444444`, project: ['harbor', 'census-tool', 'eb-smart'][index % 3], cwd: path.join(work, ['harbor', 'census-tool', 'eb-smart'][index % 3]), provider: 'claude', title: ['Sidebar typing lag', 'Fix SSN validation in Prep', 'Requests board sync', 'Release v0.2.0 notes', 'Column inventory parity', 'Guide FAQ refresh', 'Daemon stall profile', 'Merge fixes for dependents', 'What is new page'][index], isLive: false, home: index % 2 ? 'gordon' : 'personal', lastActiveMs: minutesAgo(30 + index * 70), firstPrompt: 'x' })),
  ];
  const state = { model: { projects: [] } };
  const byLabel = new Map();
  for (const s of sessions) {
    if (!byLabel.has(s.project)) byLabel.set(s.project, { label: s.project, sessions: [] });
    byLabel.get(s.project).sessions.push(s);
  }
  state.model.projects = [...byLabel.values()];

  const effortScreen = await fs.readFile(path.join(APP_ROOT, 'test/fixtures/effort-switch/claude-2.1.303-effort-xhigh-120.txt'), 'utf8');
  const askMenu = parseMenu(effortScreen);
  // A question whose explanation alone outgrows the card's cap, with ten choices.
  const tallMenu = {
    ...askMenu,
    question: 'Which Prep fix ships in push 17?',
    questionParagraphs: ['Which Prep fix ships in push 17?', ...Array.from({ length: 7 }, (_, i) => `Paragraph ${i + 1} of the explanation: the evidence for each candidate fix is a single run, so the choice decides which passing results could break and which test runs in push 17 would catch that.`)],
    options: Array.from({ length: 10 }, (_, i) => ({ index: i + 1, label: `Choice ${i + 1}`, description: '', recommended: false, selected: i === 0, isText: false })),
    selectedIndex: 0,
  };
  const fallbackMenu = { fallback: true, screen: ['  Some dialog Harbor has not seen before', '  > 1. Keep going', '    2. Stop here'], options: [] };
  const sends = [];
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
    terminalBridge: { emitter: new EventEmitter(), async start() {}, close() {}, async sendInput() { return { ok: true }; } },
    sessionSend: {
      emitter: new EventEmitter(), getQueueState: () => ({ count: 0, items: [] }), cancelQueued: () => ({ ok: true }),
      async getMenu({ pane } = {}) { return { 'pane-ask': askMenu, 'pane-tall': tallMenu, 'pane-fallback': fallbackMenu }[pane?.paneId] || null; },
      async answerMenu() { return { ok: true }; },
      async getWorkMeter() { return null; },
      async readPermissionMode() { return { mode: 'default' }; },
      // Slow on purpose, so a draft can be typed while a send is in flight.
      async send(payload) { sends.push(payload); await new Promise((resolve) => setTimeout(resolve, 1200)); return { ok: true }; },
    },
    capabilities: { async get() { return { models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], commands: [{ name: '/compact', description: 'Compact the conversation' }, { name: '/effort', description: 'Set reasoning effort' }], plugins: [] }; } },
    usage: { async getUsage(id) { return { ok: true, fiveHour: { pct: id === 'gordon' ? 58 : 12 }, weekly: { pct: id === 'gordon' ? 19 : 66 } }; } },
    accounts: { readEmails: async () => ({}) },
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  return { composed, sends, baseUrl: `http://127.0.0.1:${address.port}` };
}

// The insets an installed iOS web app gets on a notched phone. Chromium reports
// env(safe-area-inset-*) as 0, so the tokens are overridden after load.
async function applyInsets(page) {
  await page.addStyleTag({ content: `:root { --safe-top: ${SAFE.top}px !important; --safe-bottom: ${SAFE.bottom}px !important; }` });
}

// One switchable link: while `online` the phone's socket passes through to the
// real server; otherwise every attempt is refused, and drop() closes the live one.
async function routeLink(page) {
  const link = { online: true, current: null };
  await page.routeWebSocket(/\/ws/, (ws) => {
    if (!link.online) { ws.close({ code: 1006, reason: '' }); return; }
    link.current = ws;
    ws.connectToServer();
  });
  link.drop = async () => { link.online = false; await link.current?.close({ code: 1006, reason: '' }).catch(() => {}); };
  link.restore = () => { link.online = true; };
  return link;
}

async function geometry(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const visible = getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && r.height > 0;
      return visible ? { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } : null;
    };
    return {
      visibleHeight: Math.round(window.visualViewport?.height || window.innerHeight),
      header: box('.app-header'),
      nav: box('.bottom-nav'),
      composer: box('.composer'),
      textarea: box('.composer-field .composer-input'),
      conversation: box('.conv-scroll') || box('.conversation') || box('.conv-pane'),
      offlinePanel: box('.offline-panel'),
    };
  });
}

// The proof Pat's screenshot failed: with the keyboard up, the box you are
// typing in sits inside the visible area and nothing is drawn over it.
async function assertTypingVisible(page, label) {
  const g = await geometry(page);
  console.log(`${label} geometry: ${JSON.stringify(g)}`);
  assert.ok(g.textarea, `${label}: the text box is on screen`);
  assert.ok(g.textarea.bottom <= g.visibleHeight + 1, `${label}: text box bottom ${g.textarea.bottom} is above the keyboard (${g.visibleHeight})`);
  assert.ok(g.textarea.height >= 40, `${label}: text box shows at least a line (${g.textarea.height}px)`);
  const covered = await page.evaluate(() => {
    const t = document.querySelector('.composer-field .composer-input').getBoundingClientRect();
    const points = [[t.left + 12, t.top + 8], [t.left + t.width / 2, t.top + t.height / 2], [t.right - 12, t.bottom - 8]];
    return points.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit && (hit.closest('.composer-field') ? null : (hit.className || hit.tagName));
    }).filter(Boolean);
  });
  assert.deepEqual(covered, [], `${label}: nothing is drawn over the text box`);
  return g;
}

// Safari's visual viewport over a full-height layout, scrolled down by `offsetTop`.
async function panKeyboard(page, offsetTop) {
  await page.evaluate(({ visible, top }) => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => visible });
    Object.defineProperty(vv, 'offsetTop', { configurable: true, get: () => top });
    vv.dispatchEvent(new Event('resize'));
    vv.dispatchEvent(new Event('scroll'));
  }, { visible: VISIBLE_WITH_KEYBOARD, top: offsetTop });
  await page.waitForTimeout(300);
}

// Each selector must sit inside the visible band [offsetTop, offsetTop + visible]
// and actually be hit at three points down its visible part. Hit-testing honours
// clipping; a bounding box does not.
async function assertPannedVisible(page, label, selectors) {
  const report = await page.evaluate(({ selectors: list, top, visible }) => list.map((selector) => {
    const el = document.querySelector(selector);
    if (!el) return { selector, missing: true };
    const r = el.getBoundingClientRect();
    const from = Math.max(r.top, top) + 6;
    const to = Math.min(r.bottom, top + visible) - 6;
    const xs = r.left + Math.min(24, r.width / 2);
    const misses = [from, (from + to) / 2, to].filter((y) => {
      const hit = document.elementFromPoint(xs, y);
      return !(hit && hit.closest(selector));
    }).map((y) => {
      const hit = document.elementFromPoint(xs, y);
      return `${Math.round(y)}:${hit ? (hit.id ? `#${hit.id}` : hit.className || hit.tagName) : 'nothing'}`;
    });
    return { selector, top: Math.round(r.top), bottom: Math.round(r.bottom), misses };
  }), { selectors, top: PANNED_OFFSET, visible: VISIBLE_WITH_KEYBOARD });
  console.log(`${label} geometry: ${JSON.stringify(report)}`);
  for (const entry of report) {
    assert.ok(!entry.missing, `${label}: ${entry.selector} is on the page`);
    assert.ok(entry.top >= PANNED_OFFSET - 1 && entry.bottom <= PANNED_OFFSET + VISIBLE_WITH_KEYBOARD + 1, `${label}: ${entry.selector} ${entry.top}..${entry.bottom} sits inside the visible band ${PANNED_OFFSET}..${PANNED_OFFSET + VISIBLE_WITH_KEYBOARD}`);
    assert.deepEqual(entry.misses, [], `${label}: ${entry.selector} is drawn, not clipped or covered`);
  }
}

async function openChat(page, title) {
  await page.getByRole('button', { name: 'Switch session' }).click();
  await page.locator('.session-row', { hasText: title }).first().click();
  await expect(page.locator('.app-header')).toContainText(title);
  await page.waitForTimeout(400);
}

const STATES = {
  async images(page) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    const img = page.locator('.conv-img').first();
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth), { timeout: 10000 }).toBe(320);
    const src = await img.getAttribute('src');
    assert.ok(src.startsWith('/transcript-images/'), `the phone image loads from the image route (${src})`);
    assert.equal(await page.locator('.conv-img[src^="data:"]').count(), 0, 'no image bytes ride in the page');
    await shot(page, '20-image-in-chat');
    await page.locator('.conv-img-btn').first().click();
    await expect.poll(() => page.locator('.conv-lightbox-img').evaluate((el) => el.complete && el.naturalWidth), { timeout: 10000 }).toBe(320);
    await shot(page, '21-image-full-size');
  },
  async chat(page) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await expect(page.locator('.conv-pane')).toContainText('Push 17 ships once');
    const g = await geometry(page);
    console.log(`chat geometry: ${JSON.stringify(g)}`);
    await shot(page, '01-chat');
  },
  async typingResize(page) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await page.locator('.composer-field .composer-input').click();
    await page.locator('.composer-field .composer-input').fill(LONG_DRAFT);
    await page.setViewportSize({ width: PHONE.width, height: VISIBLE_WITH_KEYBOARD });
    await page.waitForTimeout(300);
    await assertTypingVisible(page, 'keyboard (resize)');
    await shot(page, '02-typing-keyboard-resize');
    await page.setViewportSize(PHONE);
  },
  async typingOverlay(page) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await page.locator('.composer-field .composer-input').click();
    await page.locator('.composer-field .composer-input').fill(LONG_DRAFT);
    // Shrink only the visual viewport, as Safari does over a full-height layout.
    await page.evaluate((visible) => {
      const vv = window.visualViewport;
      Object.defineProperty(vv, 'height', { configurable: true, get: () => visible });
      vv.dispatchEvent(new Event('resize'));
    }, VISIBLE_WITH_KEYBOARD);
    await page.waitForTimeout(300);
    await assertTypingVisible(page, 'keyboard (overlay)');
    await shot(page, '03-typing-keyboard-overlay', { clip: { x: 0, y: 0, width: PHONE.width, height: VISIBLE_WITH_KEYBOARD } });
  },
  // THE PANNED KEYBOARD (Pat's phone, 2026-11-09). Safari does not only shrink
  // the visual viewport: it also SCROLLS it down the full-height layout so the
  // field you tapped sits above the keyboard. visualViewport.offsetTop was 338 in
  // Pat's screenshot, and the shell follows it (top: --app-offset-top). The
  // Lighthouse reskin made #root a positioned box, so the shell was positioned
  // inside #root, which is only --app-h tall and clips: everything below 552
  // vanished, the composer with it, and the bare ground showed through. Neither
  // mode above pans, which is how it shipped. Asserted by hit-testing, because a
  // clipped element still reports its full rectangle.
  async typingPanned(page) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await page.locator('.composer-field .composer-input').click();
    await page.locator('.composer-field .composer-input').fill(LONG_DRAFT);
    await panKeyboard(page, PANNED_OFFSET);
    await assertPannedVisible(page, 'keyboard (panned)', ['.composer-field', '.conv-pane']);
    await shot(page, '03b-typing-keyboard-panned', { clip: { x: 0, y: PANNED_OFFSET, width: PHONE.width, height: VISIBLE_WITH_KEYBOARD } });
  },
  async noteEditorPanned(page) {
    await page.getByRole('button', { name: 'Notes' }).click();
    await page.locator('.notes-mobile').getByText('Reply to the carrier').first().click();
    await page.waitForTimeout(400);
    await page.locator('.ne-body').click();
    await panKeyboard(page, PANNED_OFFSET);
    await assertPannedVisible(page, 'note editor (panned)', ['.ne-body', '.ne-tags']);
    await shot(page, '19b-note-editing-keyboard-panned', { clip: { x: 0, y: PANNED_OFFSET, width: PHONE.width, height: VISIBLE_WITH_KEYBOARD } });
  },
  async reconnecting(page, { link }) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    const before = await geometry(page);
    await link.drop();
    await page.locator('.app-shell[data-connection="offline"]').waitFor({ timeout: 5000 });
    await page.waitForTimeout(300);
    const after = await geometry(page);
    console.log(`reconnecting geometry: ${JSON.stringify(after)}`);
    assert.ok(after.header.height <= before.header.height + 1, `a drop costs no header height (${before.header.height} -> ${after.header.height})`);
    await shot(page, '04-reconnecting');
  },
  async offline(page, { link }) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await link.drop();
    await page.locator('.app-shell[data-connection="offline"]').waitFor({ timeout: 5000 });
    await page.waitForTimeout(6500);
    const g = await geometry(page);
    console.log(`offline geometry: ${JSON.stringify(g)}`);
    assert.equal(g.offlinePanel, null, 'no error card over a conversation the phone already has');
    // Two blocks, session and facts strip. 96 until 2026-10-31, when the project line grew
    // to hold the new-session and copy-id buttons (44px targets on a 36px line) and the
    // title moved to its own row below it: one-line title 105px, two lines 124px.
    assert.ok(g.header.height <= 112, `offline, the header stays two blocks (${g.header.height}px)`);
    await shot(page, '05-offline');
    await page.locator('.composer-field .composer-input').click();
    await page.locator('.composer-field .composer-input').fill(LONG_DRAFT);
    await page.setViewportSize({ width: PHONE.width, height: VISIBLE_WITH_KEYBOARD });
    await page.waitForTimeout(300);
    await shot(page, '06-offline-typing');
    await assertTypingVisible(page, 'offline keyboard (resize)');
    await page.setViewportSize(PHONE);
    link.restore();
    await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 15000 });
    await shot(page, '07-reconnected');
  },
  async ask(page) {
    await openChat(page, 'Kill and resume queued Claude sessions');
    await page.waitForTimeout(1500);
    await expect(page.locator('.ask-card')).toBeVisible();
    await shot(page, '08-ask-card');
  },
  // The review's other P0: a question card plus the keyboard pushed the
  // composer under the keyboard even with the frame fixed.
  async askKeyboard(page) {
    await openChat(page, 'Kill and resume queued Claude sessions');
    await expect(page.locator('.ask-card')).toBeVisible({ timeout: 5000 });
    await page.locator('.composer-field .composer-input').click();
    await page.locator('.composer-field .composer-input').fill(LONG_DRAFT);
    await page.setViewportSize({ width: PHONE.width, height: VISIBLE_WITH_KEYBOARD });
    await page.waitForTimeout(300);
    await assertTypingVisible(page, 'question card + keyboard');
    await expect(page.locator('.question-fold')).toBeVisible();
    await expect(page.locator('.ask-card')).toBeHidden();
    await shot(page, '08b-ask-card-keyboard');
    // Answer puts the keyboard away and the whole card, choices included, returns.
    await page.locator('.question-fold-open').click();
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(300);
    await expect(page.locator('.ask-card').getByText('Yes, switch to xhigh')).toBeVisible();
    await expect(page.locator('.question-fold')).toBeHidden();
    await shot(page, '08c-ask-card-after-answer-tap');
  },
  // The review reproduced it: type, switch sessions or tabs, come back, and the
  // draft was gone.
  async draft(page) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await page.locator('.composer-field .composer-input').fill('half-written thought about push 17');
    await openChat(page, 'Kill and resume queued Claude sessions');
    await expect(page.locator('.composer-field .composer-input')).toHaveText('');
    await page.getByRole('button', { name: 'Tasks' }).click();
    await page.getByRole('button', { name: 'Chat' }).click();
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await expect(page.locator('.composer-field .composer-input')).toHaveText('half-written thought about push 17');
  },
  // Second review, P1: the first tap on Send was lost to a layout jump.
  async sendTap(page, { fx }) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await page.locator('.composer-field .composer-input').click();
    await page.locator('.composer-field .composer-input').fill('one tap please');
    await page.setViewportSize({ width: PHONE.width, height: VISIBLE_WITH_KEYBOARD });
    await page.waitForTimeout(300);
    const before = fx.sends.length;
    const send = await page.locator('.composer-send').boundingBox();
    await page.touchscreen.tap(send.x + send.width / 2, send.y + send.height / 2);
    await expect.poll(() => fx.sends.length, { timeout: 4000 }).toBe(before + 1);
    assert.equal(await page.locator('.app-shell').getAttribute('data-typing'), 'true', 'a send keeps the keyboard up');
    await page.setViewportSize(PHONE);
  },
  // Second review, P1: a late acknowledgment wiped text typed after the send.
  async draftInFlight(page, { fx }) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    const box = page.locator('.composer-field .composer-input');
    await box.fill('first message');
    await page.locator('.composer-send').click();
    await expect.poll(() => fx.sends.at(-1)?.text, { timeout: 3000 }).toBe('first message');
    await box.fill('second thought, typed while the first was sending');
    await page.waitForTimeout(1600);
    await expect(box).toHaveText('second thought, typed while the first was sending');
  },
  // 2026-11-01: the message box became a plain-text editable element so Safari
  // stops offering AutoFill Contact (web/src/composer/plain-text.cjs). What goes
  // out must be exactly what was typed, line breaks included, whichever way the
  // engine stored them, and the box must behave like the textarea it replaced.
  async plainBox(page, { fx }) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    const box = page.locator('.composer-field .composer-input');
    const sendAndExpect = async (expected, label) => {
      const before = fx.sends.length;
      await page.locator('.composer-send').click();
      await expect.poll(() => fx.sends.length, { timeout: 4000 }).toBe(before + 1);
      assert.equal(fx.sends.at(-1).text, expected, `${label}: the sent text is exactly what was typed`);
      await expect(box).toHaveText('');
      await expect(page.locator('.composer-input[data-empty]')).toHaveCount(1);
    };
    assert.equal(await page.locator('textarea[aria-label="Message"], .composer textarea').count(), 0, 'the message box is not a textarea');
    assert.equal(await box.getAttribute('contenteditable'), 'plaintext-only');
    await expect(page.locator('.composer-input[data-empty]')).toHaveCount(1);
    await shot(page, '21-plain-box-empty', { clip: { x: 0, y: PHONE.height - 260, width: PHONE.width, height: 260 } });

    // Typed with the keyboard: Enter makes a line, a trailing Enter is kept.
    await box.click();
    await page.keyboard.type('first line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second line');
    await expect(page.locator('.composer-input[data-empty]')).toHaveCount(0);
    await shot(page, '22-plain-box-two-lines', { clip: { x: 0, y: PHONE.height - 300, width: PHONE.width, height: 300 } });
    await sendAndExpect('first line\nsecond line', 'typed lines');
    await box.click();
    await page.keyboard.type('ends on an empty line');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('after two');
    await sendAndExpect('ends on an empty line\n\nafter two', 'blank line kept');

    // Inserted multi-line text (a paste does the same) arrives as blocks.
    await box.fill('alpha\nbeta\ngamma');
    await sendAndExpect('alpha\nbeta\ngamma', 'inserted lines');

    // Formatting a selection works by character offsets, as on the textarea.
    await box.fill('make this bold');
    await page.getByRole('button', { name: 'Show composer tools' }).click();
    await page.getByRole('button', { name: 'Show formatting options' }).click();
    await box.evaluate((el) => {
      const node = el.firstChild;
      const range = document.createRange();
      range.setStart(node, 10);
      range.setEnd(node, 14);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(box).toHaveText('make this **bold**');
    // The selection lands where the format put it (the wrapped word), and the
    // caret carries on from its end.
    assert.equal(await page.evaluate(() => getSelection().toString()), '**bold**', 'the formatted text stays selected');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('!');
    await expect(box).toHaveText('make this **bold**!');
    await page.getByRole('button', { name: 'Hide formatting options' }).click();
    await sendAndExpect('make this **bold**!', 'formatted');
  },
  // Second review, P1: focus with no keyboard (hardware keyboard), or a keyboard
  // put away while focus stays, must not hide the tabs.
  async hardwareKeyboard(page) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await page.locator('.composer-field .composer-input').click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.app-shell').getAttribute('data-typing'), 'false', 'focus with no keyboard is not typing mode');
    await expect(page.locator('.bottom-nav')).toBeVisible();
    await page.setViewportSize({ width: PHONE.width, height: VISIBLE_WITH_KEYBOARD });
    await page.waitForTimeout(200);
    await expect(page.locator('.bottom-nav')).toBeHidden();
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(200);
    await expect(page.locator('.bottom-nav')).toBeVisible();
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('composer-input')), true, 'focus stayed in the box');
  },
  // Second review, P0: a long explanation left the choices zero pixels tall.
  async tallQuestion(page) {
    await openChat(page, 'Pick the Prep fix to ship');
    const card = page.locator('.ask-card');
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(150);
    const last = await card.getByText('Choice 10').boundingBox();
    const cardBox = await card.boundingBox();
    assert.ok(last && last.height > 10 && last.y >= cardBox.y && last.y + last.height <= cardBox.y + cardBox.height + 1, `the last choice can be scrolled into view: ${JSON.stringify(last)} in ${JSON.stringify(cardBox)}`);
    await shot(page, '20-tall-question-scrolled');
  },
  // Second review, P1: folding hid the raw-screen fallback with no way back.
  async fallbackFold(page) {
    await openChat(page, 'Unknown dialog on screen');
    await expect(page.locator('.ask-screen')).toBeVisible({ timeout: 5000 });
    await page.locator('.composer-field .composer-input').click();
    await page.setViewportSize({ width: PHONE.width, height: VISIBLE_WITH_KEYBOARD });
    await page.waitForTimeout(300);
    await expect(page.locator('.question-fold')).toBeVisible();
    await expect(page.locator('.ask-screen')).toBeHidden();
    await page.locator('.question-fold-open').click();
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(300);
    await expect(page.locator('.ask-screen')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send Enter to the prompt' })).toBeVisible();
  },
  async jump(page) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await expect(page.locator('.conv-jump')).toHaveCount(0);
    await page.locator('.conv').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await expect(page.locator('.conv-jump')).toBeVisible();
    await shot(page, '17-scrolled-up-latest-pill');
    await page.locator('.conv-jump').click();
    await page.waitForTimeout(300);
    const gap = await page.locator('.conv').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    assert.ok(gap < 60, `Latest returns to the bottom (gap ${gap})`);
    await expect(page.locator('.conv-jump')).toHaveCount(0);
  },
  async noteEditor(page) {
    await page.getByRole('button', { name: 'Notes' }).click();
    await page.locator('.notes-mobile').getByText('Reply to the carrier').first().click();
    await page.waitForTimeout(400);
    const focused = await page.evaluate(() => document.activeElement?.tagName || '');
    assert.ok(!['TEXTAREA', 'INPUT'].includes(focused), `a saved note opens for reading, not with the keyboard up (focused ${focused})`);
    await shot(page, '18-note-reading');
    await page.locator('.ne-body').click();
    await page.evaluate((visible) => {
      const vv = window.visualViewport;
      Object.defineProperty(vv, 'height', { configurable: true, get: () => visible });
      vv.dispatchEvent(new Event('resize'));
    }, VISIBLE_WITH_KEYBOARD);
    await page.waitForTimeout(300);
    const tags = await page.locator('.ne-tags').boundingBox();
    assert.ok(tags && tags.y + tags.height <= VISIBLE_WITH_KEYBOARD + 1, `the editor's bottom bar stays above the keyboard: ${JSON.stringify(tags)}`);
    await shot(page, '19-note-editing-keyboard', { clip: { x: 0, y: 0, width: PHONE.width, height: VISIBLE_WITH_KEYBOARD } });
  },
  async browser(page) {
    await page.getByRole('button', { name: 'Switch session' }).click();
    await expect(page.locator('.session-browser')).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, '09-session-browser');
    await page.locator('.session-browser-add').click();
    await expect(page.locator('.newsession-sheet')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, '10-new-session');
  },
  async sheets(page) {
    await openChat(page, 'Orchestrating cdt-app push 16 kickoff');
    await page.locator('.hdr-model-chip').click();
    await page.waitForTimeout(600);
    await shot(page, '11-capability-sheet');
    await page.keyboard.press('Escape');
    await page.mouse.click(PHONE.width / 2, 120);
    await page.waitForTimeout(300);
    await page.locator('.hdr-plan-chip').click().catch(() => {});
    await page.waitForTimeout(600);
    await shot(page, '12-plan-sheet');
    await page.keyboard.press('Escape');
    await page.mouse.click(PHONE.width / 2, 120);
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Settings' }).click().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, '13-settings');
  },
  async tasks(page) {
    await page.getByRole('button', { name: 'Tasks' }).click();
    await page.waitForTimeout(600);
    await shot(page, '14-tasks');
  },
  async notes(page) {
    await page.getByRole('button', { name: 'Notes' }).click();
    await page.waitForTimeout(600);
    await shot(page, '15-notes');
  },
};

async function coldOffline(browser, baseUrl, token) {
  const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.routeWebSocket(/\/ws/, (ws) => ws.close({ code: 1006, reason: '' }));
  await page.goto(`${baseUrl}/#token=${token}&url=${encodeURIComponent(baseUrl)}`);
  await applyInsets(page);
  await page.waitForTimeout(7000);
  await shot(page, '16-cold-boot-offline');
  await context.close();
}

async function main() {
  await fs.access(path.join(DIST, 'index.html'));
  const originalEnv = { ...process.env };
  const browserEnv = { ...originalEnv };
  delete browserEnv.ELECTRON_RUN_AS_NODE;
  const root = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-phone-ux-'));
  await fs.mkdir(EVIDENCE, { recursive: true });
  let fx;
  let browser;
  const failures = [];
  try {
    fx = await makeFixture(root);
    console.log(`isolated server: ${fx.baseUrl}; bundle ${DIST}; evidence ${EVIDENCE}`);
    browser = await launchBrowser(browserEnv);
    for (const [name, run] of Object.entries(STATES)) {
      if (ONLY.length && !ONLY.includes(name)) continue;
      // A fresh context per state, so one state's storage, focus and socket can
      // never leak into the next.
      const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const link = await routeLink(page);
      try {
        await page.goto(`${fx.baseUrl}/#token=${fx.composed.token}&url=${encodeURIComponent(fx.baseUrl)}`);
        await applyInsets(page);
        await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 20000 });
        await run(page, { link, fx });
        assert.deepEqual(errors, [], `${name}: no browser runtime errors`);
        console.log(`PASS ${name}`);
      } catch (error) {
        failures.push(`${name}: ${error.message.split('\n')[0]}`);
        console.log(`FAIL ${name}: ${error.message}`);
        await shot(page, `FAIL-${name}`).catch(() => {});
      } finally {
        await context.close();
      }
    }
    if (!ONLY.length || ONLY.includes('cold')) await coldOffline(browser, fx.baseUrl, fx.composed.token);
    assert.deepEqual(fx.composed.isolation.signalCalls, [], 'no process signals');
  } finally {
    await browser?.close();
    await fx?.composed.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(root, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`FAIL phone ux drive:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS phone ux drive');
  }
}

main().catch((error) => {
  console.error(`FAIL phone ux drive: ${error.stack || error}`);
  process.exitCode = 1;
});
