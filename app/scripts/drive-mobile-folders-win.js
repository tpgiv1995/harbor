#!/usr/bin/env node
'use strict';

// 2026-10-06: prove the phone fixes from one afternoon of Pat's feedback through
// the shipped bundle, at 390x844 and at a keyboard-up 390x470:
//   - the new-session list groups sub-folders under their parent, searches,
//     drops deleted folders, and launches the folder actually picked;
//   - the side panel folds sub-projects into their parent, tags the sub-folder
//     on each row, and its stacked headers are opaque (no ghost text);
//   - the full-size image viewer closes from its button and from a tap anywhere;
//   - attaching a photo closes the tools tray, the plus stays a plus, and with
//     the keyboard up the tray and a usable text box both stay on screen.
// composeServer on loopback with relocated stores, headless Chromium, fake
// launches, no daemon, no visible window. Side-panel sessions use paths on an
// unused drive letter so the dev-root rule is exercised without touching disk;
// the new-session list needs folders that exist, so it uses a temp tree.
// Run from app (needs a built bundle): node scripts/drive-mobile-folders-win.js [distDir]

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { realTmpDir } = require('../test/support/real-tmpdir.js');

const APP_ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(APP_ROOT, 'dist-web'));
const EVIDENCE = path.join(realTmpDir(), 'harbor-drive-mobile-folders');
const VIEWPORT = { width: 390, height: 844 };
const KEYBOARD_UP = { width: 390, height: 470 };
const LIVE_ID = '33333333-3333-4333-8333-333333333333';
// A 1x1 PNG, for the attachment upload.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// A phone-shaped screenshot stand-in for the image viewer.
const TALL_IMAGE = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="2532"><rect width="1170" height="2532" fill="#2b6cb0"/><text x="80" y="300" font-size="120" fill="#fff">screenshot</text></svg>',
).toString('base64')}`;

async function screenshot(page, name) {
  const file = path.join(EVIDENCE, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

async function makeFixture(root) {
  const home = path.join(root, 'home');
  const userDataDir = path.join(root, 'user-data');
  const work = path.join(root, 'work');
  const dir = (...parts) => path.join(work, ...parts);
  const real = {
    harbor: dir('harbor'),
    harborApp: dir('harbor', 'app'),
    reports: dir('reports'),
    quarterly: dir('reports', 'quarterly'),
    orchA: dir('.orch', 'g4-core'),
    orchB: dir('.orch', 'b1-review', 'chatbot'),
  };
  const fillers = Array.from({ length: 24 }, (_, index) => dir(`project-${String(index + 1).padStart(2, '0')}`));
  const gone = dir('deleted-worktree');
  await Promise.all([home, userDataDir, ...Object.values(real), ...fillers].map((d) => fs.mkdir(d, { recursive: true })));

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
    HARBOR_PROJECT_ICONS_DIR: path.join(root, 'icons'),
    HARBOR_MODEL_CACHE_FILE: path.join(root, 'claude-models.json'),
    HARBOR_E2E_FAKE_LAUNCH: '1', HARBOR_TAILNET_LOGINS: 'none',
    HARBOR_WEB_DIST: DIST,
  });
  const { composeServer } = require('../src/server/compose.js');
  const profiles = [{ id: 'personal', label: 'Fixture', provider: 'claude', isDefault: true, email: null,
    configHome: path.join(home, 'claude-personal'), letter: 'F', color: '#437FFE' }];
  await fs.writeFile(process.env.HARBOR_CONFIG_FILE, JSON.stringify({
    setup: { completed: true }, profiles,
    providers: { claude: { enabled: true } },
    paths: { cacheDir: root, projectsDir: path.join(home, 'projects'), projectIconsDir: path.join(root, 'icons') },
  }));

  const now = Date.now();
  let tick = 0;
  const session = (project, cwd, extra = {}) => ({
    id: extra.id || `fixture-${tick}`, project, cwd, provider: 'claude', title: extra.title || `${project} work`,
    isLive: false, lastActiveMs: now - (tick++ * 60_000), ...extra,
  });
  // The side panel hides folders under a Temp directory unless searched for
  // (isScratchProject), so the temp tree feeds only the new-session list. The
  // live session is the exception (a live session is never hidden), and it is
  // what proves a temp-tree sub-folder folds under its parent in both places.
  const sessions = [
    session('harbor/app', real.harborApp, { id: LIVE_ID, title: 'Phone fixes', isLive: true, paneId: 'pane-live', workspaceId: 'ws-live', agentStatus: 'working' }),
    session('harbor', real.harbor),
    session('sheet/quarterly', real.quarterly),
    session('sheet/deleted-worktree', gone),
    session('.orch/g4-core', real.orchA),
    session('sheet/reports', real.reports),
    session('.orch/b1-review/chatbot', real.orchB),
    ...fillers.map((cwd) => session(`sheet/${path.basename(cwd)}`, cwd)),
    // Side-panel shapes on an unused drive letter: never touched on disk, and
    // dropped from the new-session list because they do not exist.
    session('studio/studio-personal', 'Q:\\dev\\studio\\studio-personal'),
    session('Proposal Kit/build/video/_naming', 'Q:\\dev\\Proposal Kit\\build\\video\\_naming'),
    session('Proposal Kit', 'Q:\\dev\\Proposal Kit'),
    session('misc-ad-hoc/tiles', 'Q:\\dev\\misc-ad-hoc\\tiles'),
    session('misc-ad-hoc/planner', 'Q:\\dev\\misc-ad-hoc\\planner'),
    session('reports/quarterly', 'Q:\\Users\\pat\\Box\\reports\\quarterly'),
    session('Box/reports', 'Q:\\Users\\pat\\Box\\reports'),
    ...Array.from({ length: 18 }, (_, index) => {
      const name = `panel-project-${String(index + 1).padStart(2, '0')}`;
      return session(name, `Q:\\dev\\${name}`);
    }),
  ];
  const state = { model: { projects: [] } };
  const byLabel = new Map();
  for (const s of sessions) {
    if (!byLabel.has(s.project)) byLabel.set(s.project, { label: s.project, sessions: [] });
    byLabel.get(s.project).sessions.push(s);
  }
  state.model.projects = [...byLabel.values()];

  const transcriptEmitter = new EventEmitter();
  const launches = [];
  const composed = await composeServer({
    userDataDir, configFile: process.env.HARBOR_CONFIG_FILE, env: process.env,
    skipDaemonStart: true, selfOriginHosts: [],
    sidebar: {
      emitter: new EventEmitter(), async start() {}, close() {},
      getState: () => state,
      getSessionMeta: async (id) => sessions.find((s) => s.id === id) || null,
      getSessionPreview: async () => null, focusLivePane: async () => ({ ok: true }),
    },
    icons: { async list() { return { icons: {} }; }, watch() {} },
    transcript: {
      emitter: transcriptEmitter,
      async open(sessionId) {
        setTimeout(() => transcriptEmitter.emit('update', {
          sessionId,
          replace: [
            { key: 'b0', kind: 'user', text: 'Here is the screenshot', images: [{ mediaType: 'image/svg+xml', dataUri: TALL_IMAGE }] },
            { key: 'b1', kind: 'assistant', text: 'Looking at it now.' },
          ],
          header: { working: true, processAlive: true },
        }), 20);
        return { ok: true };
      },
      close() {}, closeAll() {},
    },
    terminalBridge: { emitter: new EventEmitter(), async start() {}, close() {}, async sendInput() { return { ok: true }; } },
    sessionSend: {
      emitter: new EventEmitter(), getQueueState: () => ({ count: 0, items: [] }), cancelQueued: () => ({ ok: true }),
      async getMenu() { return null; }, async answerMenu() { return { ok: true }; },
      async send() { throw Error('unexpected session send'); },
    },
    tasks: { read: async () => ({ lists: [], tasks: [], version: 1 }), subscribe() {}, close() {} },
    onFakeLaunch: (record) => launches.push(record),
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  return { composed, launches, real, gone, fillers, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function sidePanel(page) {
  await page.getByRole('button', { name: 'Switch session' }).click();
  await expect(page.locator('.session-browser')).toBeVisible();
  // Every time window, so the whole fixture is listed.
  await page.locator('.browser-filter-toggle').click();
  await page.locator('.browser-filter-chip[data-filter="all"]').click();
  await page.locator('.browser-filter-toggle').click();
  const headers = await page.locator('.session-browser-list .project-header .project-label').allTextContents();
  console.log(`side panel groups: ${headers.join(' | ')}`);
  for (const stray of ['harbor/app', 'studio/studio-personal', 'Proposal Kit/build/video/_naming', 'misc-ad-hoc/tiles', 'reports/quarterly']) {
    assert.ok(!headers.includes(stray), `sub-project ${stray} must not be its own group`);
  }
  for (const parent of ['harbor', 'studio', 'Proposal Kit', 'misc-ad-hoc', 'Box/reports']) {
    assert.ok(headers.includes(parent), `parent ${parent} must be a group`);
  }
  const appRow = page.locator('.session-row', { hasText: 'Phone fixes' }).first();
  await expect(appRow.locator('.session-project')).toHaveText('app');
  await expect(page.locator('.session-row', { hasText: 'reports/quarterly work' }).locator('.session-project')).toHaveText('quarterly');
  const background = await page.locator('.session-browser-list .project-header').first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(background, 'rgb(11, 12, 15)', `stacked headers must be opaque, got ${background}`);
  await screenshot(page, '01-side-panel');
  const list = page.locator('.session-browser-list');
  await list.evaluate((el) => { el.scrollTop = 900; });
  await page.waitForTimeout(100);
  await screenshot(page, '02-side-panel-scrolled');
  console.log('PASS side panel: sub-projects folded into parents, sub-folder tag on rows, opaque stacked headers');
}

async function newSessionSheet(page, fx) {
  await page.locator('.session-browser-add').click();
  await expect(page.locator('.newsession-sheet')).toBeVisible();
  const field = page.locator('.newsession-field', { hasText: 'Project folder' });
  const labels = () => field.locator('.newsession-group-row .newsession-folder-label').allTextContents();
  await expect(field.locator('.newsession-group').first()).toBeVisible();
  const groups = await labels();
  console.log(`sheet groups (${groups.length}): ${groups.slice(0, 8).join(' | ')} ...`);
  assert.equal(groups[0], 'work/harbor', 'most recent parent first');
  assert.ok(groups.includes('Orchestration'));
  assert.ok(!groups.some((label) => label.includes('deleted-worktree')), 'a deleted folder is never offered');
  assert.equal(await field.locator('.newsession-folder-path', { hasText: 'Q:\\' }).count(), 0, 'missing-drive folders are dropped too');
  // The default is the most recent folder, a sub-folder: its group opens on it.
  await expect(field.locator('.newsession-folder.sub.on')).toHaveText(/app/);
  await expect(page.locator('.newsession-summary')).toContainText('harbor/app');
  // The accent was written rgba(<space-separated rgb>, alpha), which browsers
  // reject, so a picked folder drew a white border and no fill.
  const picked = await field.locator('.newsession-folder.sub.on')
    .evaluate((el) => ({ border: getComputedStyle(el).borderTopColor, fill: getComputedStyle(el).backgroundColor }));
  assert.deepEqual(picked, { border: 'rgba(67, 127, 254, 0.65)', fill: 'rgba(67, 127, 254, 0.12)' }, 'a picked folder wears the accent');
  await page.locator('.newsession-search input').scrollIntoViewIfNeeded();
  await page.locator('.newsession-body').evaluate((el) => { el.scrollTop = el.scrollTop + 40; });
  await screenshot(page, '03-sheet-grouped');

  const toggle = field.getByRole('button', { name: /subfolders? of work\/reports/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(field.locator('.newsession-folder.sub', { hasText: 'quarterly' })).toBeVisible();
  await screenshot(page, '04-sheet-expanded');

  const search = page.getByRole('searchbox', { name: 'Search project folders' });
  await search.fill('quart');
  await expect(field.locator('.newsession-group')).toHaveCount(1);
  await expect(field.locator('.newsession-folder.sub')).toHaveText(/quarterly/);
  await screenshot(page, '05-sheet-search-child');
  await search.fill('no such project');
  await expect(field.getByText('No project folders match.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toHaveValue('');

  await search.fill('orch');
  const heading = field.locator('.newsession-folder-heading', { hasText: 'Orchestration' });
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await heading.click();
  await field.locator('.newsession-folder.sub', { hasText: 'g4-core' }).click();
  await expect(page.locator('.newsession-summary')).toContainText('g4-core');
  await screenshot(page, '06-sheet-orchestration-picked');
  const geometry = await page.locator('.newsession-body').evaluate((body) => ({ client: body.clientWidth, scroll: body.scrollWidth }));
  assert.ok(geometry.scroll <= geometry.client + 1, `sheet must not scroll sideways: ${JSON.stringify(geometry)}`);

  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect.poll(() => fx.launches.length).toBe(1);
  assert.equal(path.normalize(fx.launches[0].options.cwd), path.normalize(fx.real.orchA), 'the picked folder is the one launched');
  await expect(page.locator('.newsession-sheet')).toHaveCount(0);
  console.log('PASS new-session sheet: grouped, parent toggles, search opens matching children, deleted folders absent, picked folder launched');
}

async function imageViewer(page) {
  await page.getByRole('button', { name: 'Switch session' }).click();
  await page.locator('.session-row', { hasText: 'Phone fixes' }).first().click();
  const thumb = page.getByRole('button', { name: 'View image full size' });
  await expect(thumb).toBeVisible({ timeout: 15000 });
  await screenshot(page, '07-chat-with-image');
  await thumb.click();
  const viewer = page.getByRole('dialog', { name: 'Image preview' });
  await expect(viewer).toBeVisible();
  const close = page.getByRole('button', { name: 'Close image' });
  const box = await close.boundingBox();
  assert.ok(box && box.y >= 0 && box.x + box.width <= VIEWPORT.width && box.width >= 44, `close button must be on screen: ${JSON.stringify(box)}`);
  const image = await page.locator('.conv-lightbox-img').boundingBox();
  assert.ok(image.y >= box.y + box.height - 1, 'the close button never covers the image');
  await screenshot(page, '08-image-viewer');
  await close.click();
  await expect(viewer).toHaveCount(0);
  await thumb.click();
  await page.locator('.conv-lightbox-img').click();
  await expect(viewer).toHaveCount(0);
  console.log('PASS image viewer: close button on screen; closes from the button and from a tap on the image');
}

async function composerAttach(page) {
  const plus = page.locator('.composer-plus');
  await plus.click();
  await expect(page.locator('.composer-tools')).toBeVisible();
  await screenshot(page, '09-tray-open');
  await page.locator('.composer-attach input').setInputFiles({ name: 'IMG_5428.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('.attach-chip')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('.composer-tools')).toHaveCount(0);
  await expect(plus).toHaveAttribute('aria-expanded', 'false');
  assert.equal(await plus.evaluate((el) => getComputedStyle(el).transform), 'none', 'the plus never turns into an x');
  await screenshot(page, '10-attached');

  await page.setViewportSize(KEYBOARD_UP);
  await page.locator('.composer-field textarea').fill('A note about this screenshot that runs long enough to wrap onto a second line');
  await plus.click();
  const tray = page.locator('.composer-tools');
  await expect(tray).toBeVisible();
  const trayBox = await tray.boundingBox();
  const attachBox = await page.locator('.composer-attach').boundingBox();
  const field = await page.locator('.composer-field textarea').boundingBox();
  assert.ok(attachBox.y >= 0 && attachBox.y + attachBox.height <= KEYBOARD_UP.height, `paperclip on screen with the keyboard up: ${JSON.stringify(attachBox)}`);
  assert.ok(field.height >= 44, `text box keeps a usable height: ${field.height}`);
  await expect(page.locator('.attach-chip')).toBeVisible();
  await screenshot(page, '11-keyboard-up-tray');
  await plus.click();
  await expect(tray).toHaveCount(0);
  const stop = await page.getByRole('button', { name: 'Stop', exact: true }).boundingBox();
  const chip = await page.locator('.attach-chip').boundingBox();
  assert.ok(Math.abs(stop.y + stop.height / 2 - (chip.y + chip.height / 2)) < 2, 'Stop shares the attachment row');
  const typing = await page.locator('.composer-field textarea').boundingBox();
  assert.ok(typing.height >= 80, `with the keyboard up the text box shows three lines: ${typing.height}`);
  await screenshot(page, '12-keyboard-up-closed');
  console.log(`PASS composer: tray closes after a pick, plus stays a plus; keyboard-up: paperclip on screen with the tray open (text box ${Math.round(field.height)}px), ${Math.round(typing.height)}px text box with it closed`);
}

async function main() {
  await fs.access(path.join(DIST, 'index.html'));
  const originalEnv = { ...process.env };
  const browserEnv = { ...originalEnv };
  delete browserEnv.ELECTRON_RUN_AS_NODE;
  const root = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-mobile-folders-'));
  await fs.mkdir(EVIDENCE, { recursive: true });
  let fx;
  let browser;
  let page;
  try {
    fx = await makeFixture(root);
    console.log(`isolated server: ${fx.baseUrl}; bundle ${DIST}; stores ${root}`);
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), env: browserEnv });
    const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce', hasTouch: true });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${fx.baseUrl}/#token=${fx.composed.token}&url=${encodeURIComponent(fx.baseUrl)}`);
    await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 20000 });
    await sidePanel(page);
    await newSessionSheet(page, fx);
    await imageViewer(page);
    await composerAttach(page);
    assert.deepEqual(errors, [], 'no browser runtime errors');
    assert.deepEqual(fx.composed.isolation.signalCalls, [], 'no process signals');
    console.log('PASS mobile folders drive: fake launches only, no daemon, no signals');
  } catch (error) {
    if (page) await screenshot(page, 'FAIL').catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    await fx?.composed.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL mobile folders drive: ${error.stack || error}`);
  process.exitCode = 1;
});
