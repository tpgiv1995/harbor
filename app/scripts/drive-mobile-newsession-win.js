#!/usr/bin/env node
'use strict';

// 2026-09-20: prove the shipped phone bundle through its real WebSocket RPCs.
// Like drive-mobile-win.js: composeServer on loopback, fully relocated stores,
// headless Chromium at 390x844, fake launches, no daemon or visible window.
// CODEX_HOME is a fixture because model discovery must work without this
// machine's Codex login, profiles or cache. The empty-home pass is the control.
// Only Cursor's public model cache is copied read-only, falling back to the
// captured CLI fixture. Everything written stays in the temporary directory.
// Run from app: npm run drive:mobile-newsession-win (requires built dist-web).

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { realTmpDir } = require('../test/support/real-tmpdir.js');

const APP_ROOT = path.resolve(__dirname, '..');
const EVIDENCE = path.join(realTmpDir(), 'harbor-drive-mobile-newsession');
const VIEWPORT = { width: 390, height: 844 };
const OLD_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const LISTED = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5'];

async function screenshot(page, name) {
  const file = path.join(EVIDENCE, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

async function makeFixture(root, realHome) {
  const home = path.join(root, 'home');
  const cacheDir = path.join(root, 'cache');
  const codexHome = path.join(home, 'codex-fixture');
  const emptyCodexHome = path.join(home, 'codex-empty');
  const userDataDir = path.join(root, 'user-data');
  const folders = Array.from({ length: 5 }, (_, index) => path.join(root, `project-${index + 1}`));
  await Promise.all([home, cacheDir, codexHome, emptyCodexHome, userDataDir, ...folders]
    .map((dir) => fs.mkdir(dir, { recursive: true })));

  // Relocate before importing server modules: several providers initialize
  // default caches at require time, and config-load forensics uses os.homedir.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('HARBOR_') || key.startsWith('CLAUDE_') || key.startsWith('CODEX_')) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
    HARBOR_CONFIG_FILE: path.join(userDataDir, 'config.json'),
    HARBOR_NO_DAEMON_START: '1', HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_MODEL_DISCOVERY: '1', HARBOR_NO_TITLER: '1', HARBOR_NO_VOICE: '1',
    HARBOR_CONTEXT_DIR: path.join(root, 'context'),
    HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
    HARBOR_SESSIOND_SOCKET: path.join(root, 'sessiond', 'isolated.sock'),
    HARBOR_ARTIFACTS_ROOTS: path.join(root, 'artifacts'),
    HARBOR_ARTIFACTS_CACHE: path.join(cacheDir, 'artifacts.json'),
    HARBOR_TASKS_FILE: path.join(userDataDir, 'tasks.json'),
    HARBOR_PROJECT_ICONS_DIR: path.join(root, 'icons'),
    HARBOR_MODEL_CACHE_FILE: path.join(cacheDir, 'claude-models.json'),
    HARBOR_E2E_FAKE_LAUNCH: '1', HARBOR_TAILNET_LOGINS: 'none',
    HARBOR_WEB_DIST: path.join(APP_ROOT, 'dist-web'),
  });
  assert.equal(os.homedir(), home, 'all default-home reads must be relocated');
  const { composeServer } = require('../src/server/compose.js');
  const { parseCursorModels, cursorModelOptions } = require('../src/main/providers/cursor-model-catalog.js');
  const cursorCache = path.join(cacheDir, 'cursor-models.json');
  let cursorSource = 'real cache (read-only copy)';
  try {
    await fs.copyFile(path.join(realHome, '.cache', 'harbor', 'cursor-models.json'), cursorCache);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    cursorSource = 'captured CLI fixture';
    const text = await fs.readFile(path.join(APP_ROOT, 'test/fixtures/cursor-models-2026-09-20.txt'), 'utf8');
    await fs.writeFile(cursorCache, JSON.stringify({ models: parseCursorModels(text) }));
  }
  const cursorModels = cursorModelOptions(cursorCache);
  assert.ok(cursorModels.length > 80, 'the Cursor drive must exercise a long list');
  const models = [...LISTED, 'hidden-drive-model'].map((slug, index) => ({
    slug, display_name: slug, priority: index,
    visibility: index === LISTED.length ? 'hide' : 'list',
    supported_reasoning_levels: LEVELS.slice(0, slug === 'gpt-5.5' ? 4 : slug === 'gpt-5.6-luna' ? 5 : 6)
      .map((effort) => ({ effort, description: effort })),
  }));
  await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({ client_version: '0.155.1', models }));
  // Same profile shape as the user's setup, with generic fixture identities.
  const profiles = ['personal', 'team', 'third'].map((id, index) => ({
    id, label: `Fixture ${index + 1}`, provider: 'claude', isDefault: index === 0, email: null,
    configHome: path.join(home, `claude-${id}`), letter: String(index + 1), color: '#437FFE',
  }));
  const config = {
    setup: { completed: true }, profiles,
    providers: { claude: { enabled: true }, codex: { enabled: true }, cursor: { enabled: true } },
    paths: { cacheDir, projectsDir: path.join(home, 'projects'), projectIconsDir: path.join(root, 'icons') },
  };
  await fs.writeFile(process.env.HARBOR_CONFIG_FILE, JSON.stringify(config));
  const sessions = folders.map((cwd, index) => ({
    id: index === 0 ? OLD_ID : `fixture-${index}`, cwd, provider: 'claude',
    title: `Fixture project ${index + 1}`, isLive: false, lastActiveMs: 100 - index,
  }));
  const state = { model: { projects: [{ label: 'Model menu drive', sessions }] } };
  const sidebar = {
    emitter: new EventEmitter(), async start() {}, close() {},
    getState: () => state,
    getSessionMeta: async (id) => sessions.find((session) => session.id === id) || null,
    getSessionPreview: async () => null, focusLivePane: async () => ({ ok: true }),
  };
  const launches = [];
  const composed = await composeServer({
    userDataDir, configFile: process.env.HARBOR_CONFIG_FILE, env: process.env,
    skipDaemonStart: true, selfOriginHosts: [], sidebar,
    // composeServer does not own the icon watch's unsubscribe. This drive does
    // not test icons, so omit that watch instead of leaving a live test handle.
    icons: { async list() { return { icons: {} }; }, watch() {} },
    transcript: { emitter: new EventEmitter(), async open() { return { ok: true }; }, close() {}, closeAll() {} },
    terminalBridge: { emitter: new EventEmitter(), async start() {}, close() {} },
    sessionSend: {
      emitter: new EventEmitter(), getQueueState: () => ({ count: 0, items: [] }),
      async getMenu() { return null; }, async send() { throw Error('unexpected session send'); },
    },
    tasks: { read: async () => ({ lists: [], tasks: [], version: 1 }), subscribe() {}, close() {} },
    onFakeLaunch: (record) => {
      launches.push(record);
      sessions.unshift({ id: NEW_ID, cwd: record.options.cwd, provider: 'codex',
        title: 'Fake Codex launch', isLive: true, lastActiveMs: Date.now() });
      sidebar.emitter.emit('update', state);
    },
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  assert.equal(address.address, '127.0.0.1');
  return { composed, launches, cursorModels, cursorSource, emptyCodexHome,
    baseUrl: `http://127.0.0.1:${address.port}` };
}

async function openSheet(page) {
  if (!await page.locator('.session-browser-add').isVisible()) {
    await page.getByRole('button', { name: 'Switch session' }).click();
  }
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await expect(page.locator('.newsession-provider')).toHaveCount(3);
  await expect(page.getByRole('combobox', { name: 'Account', exact: true }).locator('option')).toHaveCount(3);
}

async function assertLayout(page, label) {
  const geometry = await page.locator('.newsession-panel').evaluate((panel) => {
    const body = panel.querySelector('.newsession-body');
    const bounds = panel.getBoundingClientRect();
    const buttons = [...panel.querySelectorAll('.newsession-effort')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    });
    return { left: bounds.left, right: bounds.right, width: bounds.width,
      bodyWidth: body.clientWidth, contentWidth: body.scrollWidth, buttons };
  });
  assert.ok(geometry.left >= 0 && geometry.right <= VIEWPORT.width, `${label}: panel outside viewport: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.contentWidth <= geometry.bodyWidth + 1, `${label}: sheet scrolls horizontally: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.buttons.every((button) => button.left >= 0 && button.right <= VIEWPORT.width && button.height >= 40), `${label}: clipped effort buttons`);
  console.log(`PASS layout ${label}: body ${geometry.bodyWidth}px, content ${geometry.contentWidth}px, panel ${geometry.width}px`);
}

async function drive(page, fx) {
  await page.goto(`${fx.baseUrl}/#token=${fx.composed.token}&url=${encodeURIComponent(fx.baseUrl)}`);
  await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 20000 });
  await openSheet(page);
  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  const values = () => model.locator('option').evaluateAll((options) => options.map((option) => option.value));
  assert.deepEqual(await values(), ['default', ...LISTED]);
  await model.selectOption('gpt-6-astra');
  await expect(page.locator('.newsession-effort')).toHaveText(LEVELS);
  await page.getByRole('button', { name: 'ultra', exact: true }).click();
  await screenshot(page, '01-astra-ultra');
  await assertLayout(page, 'Astra');
  await model.selectOption('gpt-5.5');
  await expect(page.locator('.newsession-effort')).toHaveText(LEVELS.slice(0, 4));
  await expect(page.locator('.newsession-effort.on')).toHaveText(/^(low|medium|high|xhigh)$/);
  const submittedEffort = await page.locator('.newsession-effort.on').textContent();
  await screenshot(page, '02-gpt55-coerced');
  await assertLayout(page, 'GPT-5.5');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect.poll(() => fx.launches.length).toBe(1);
  const argv = fx.launches[0].argv;
  const arg = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(arg('--provider'), 'codex');
  assert.equal(arg('--model'), 'gpt-5.5');
  assert.equal(arg('--effort'), submittedEffort);
  assert.ok(LEVELS.slice(0, 4).includes(arg('--effort')));
  await expect(page.locator('.newsession-sheet')).toHaveCount(0);
  console.log(`PASS Codex: all four visible fixture models plus Default; hidden row absent; Astra Ultra; GPT-5.5 stops at XHIGH; fake launch submitted gpt-5.5/${submittedEffort}`);

  await openSheet(page);
  await page.getByRole('button', { name: 'Cursor', exact: true }).click();
  assert.deepEqual(await values(), fx.cursorModels.map((row) => row.value));
  await expect(model.locator('option').first()).toHaveText('Default');
  await model.scrollIntoViewIfNeeded();
  await screenshot(page, '03-cursor-before-scroll');
  await assertLayout(page, 'Cursor');
  // Real wheel input into the sheet, not assigning scrollTop. The native select
  // owns its option popup; End scrolls it to the final entry without changing
  // the production control into a test-only listbox.
  const body = page.locator('.newsession-body');
  await body.evaluate((element) => { element.scrollTop = 0; });
  await body.hover();
  await page.mouse.wheel(0, 1800);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await model.click();
  await screenshot(page, '03a-cursor-picker');
  // Chromium's native popup is outside the page DOM. Open it by keyboard and
  // use End to scroll to the last entry, without selectOption bypassing it.
  await model.press('Escape');
  await model.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('End');
  await screenshot(page, '03b-cursor-picker-end');
  await page.keyboard.press('Enter');
  await expect(model).toHaveValue(fx.cursorModels.at(-1).value);
  await screenshot(page, '04-cursor-last-model');
  await assertLayout(page, 'Cursor last model');
  console.log(`PASS Cursor: ${fx.cursorModels.length} rows from ${fx.cursorSource}; Default first; sheet wheel scroll; native picker final row reachable: ${fx.cursorModels.at(-1).value}`);

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  process.env.CODEX_HOME = fx.emptyCodexHome;
  await openSheet(page);
  await page.getByRole('button', { name: 'Codex', exact: true }).click();
  assert.deepEqual(await values(), ['default', 'gpt-5.6-sol']);
  await model.selectOption('gpt-5.6-sol');
  await expect(page.locator('.newsession-effort')).toHaveText(LEVELS.slice(0, 4));
  await page.locator('.newsession-effort').last().scrollIntoViewIfNeeded();
  await screenshot(page, '05-empty-home-fallback');
  await assertLayout(page, 'empty-home fallback');
  console.log('PASS empty Codex home: Default plus Sol only, low through xhigh; same server and three Claude-only profiles');
}

async function main() {
  await fs.access(path.join(APP_ROOT, 'dist-web', 'index.html'));
  const originalEnv = { ...process.env };
  const realHome = os.homedir();
  const executablePath = chromium.executablePath();
  const browserEnv = { ...originalEnv };
  delete browserEnv.ELECTRON_RUN_AS_NODE;
  const root = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-mobile-model-fixture-'));
  await fs.mkdir(EVIDENCE, { recursive: true });
  let fx;
  let browser;
  let page;
  try {
    fx = await makeFixture(root, realHome);
    console.log(`isolated server: ${fx.baseUrl}; viewport 390x844; stores: ${root}`);
    browser = await chromium.launch({ headless: true, executablePath, env: browserEnv });
    const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await drive(page, fx);
    assert.deepEqual(errors, [], 'no browser runtime errors');
    assert.deepEqual(fx.composed.isolation.signalCalls, [], 'no process signals');
    console.log('PASS mobile new-session drive: no real launches, no daemon, no process signals');
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
  console.error(`FAIL mobile new-session drive: ${error.stack || error}`);
  process.exitCode = 1;
});
