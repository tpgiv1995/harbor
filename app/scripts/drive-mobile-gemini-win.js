#!/usr/bin/env node
'use strict';

// 2026-11-23: prove, through the SHIPPED phone bundle (HARBOR-MAP G7, providers.md P60), that the phone names and
// marks Gemini (Google's Antigravity CLI) everywhere it names the other three: the New session sheet's tabs carry
// each provider's mark and Gemini's models and efforts, an open Gemini session's "New <provider> session" button
// says Gemini, and no Gemini surface says Claude.
// Same posture as drive-mobile-newsession-win.js: composeServer on loopback, every store relocated into a temp
// folder, headless Chromium at 390x844, no daemon, no launch, no visible window. The registry's Gemini entry is
// added by wrapping newSessionOptions BEFORE the server is required, in the shape the launch side sends
// (a Default row, then each model family with its own efforts); it is only added when the real registry has none.
//   node scripts/drive-mobile-gemini-win.js [distDir] [evidenceDir]      (from app/, needs a built dist-web)
// Pass a dist built in a scratch folder to leave the live bundle alone.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium, expect } = require('@playwright/test');
const { realTmpDir } = require('../test/support/real-tmpdir.js');

const APP_ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(APP_ROOT, 'dist-web'));
const EVIDENCE = path.resolve(process.argv[3] || path.join(APP_ROOT, 'verify', 'mobile-gemini'));
const VIEWPORT = { width: 390, height: 844 };
const GEMINI_ID = '33333333-3333-4333-8333-333333333333';
const CLAUDE_ID = '11111111-1111-4111-8111-111111111111';

const GEMINI_REGISTRY = {
  defaultModel: 'default',
  models: [
    { value: 'default', label: 'Gemini default' },
    { value: 'gemini-4-neon', label: 'Gemini 4 Neon' },
    { value: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh'],
  effortsByModel: {
    default: ['low', 'medium', 'high', 'xhigh'],
    'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'],
    'gemini-4-hydrogen': ['low', 'medium'],
  },
  defaultEffort: 'high',
  bin: 'agy',
};

async function screenshot(page, name) {
  const file = path.join(EVIDENCE, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
}

async function makeFixture(root) {
  const home = path.join(root, 'home');
  const cacheDir = path.join(root, 'cache');
  const userDataDir = path.join(root, 'user-data');
  const folders = ['lighthouse', 'harbor-notes'].map((name) => path.join(root, name));
  await Promise.all([home, cacheDir, userDataDir, path.join(home, 'codex-empty'), ...folders]
    .map((dir) => fs.mkdir(dir, { recursive: true })));
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
    HARBOR_ARTIFACTS_CACHE: path.join(cacheDir, 'artifacts.json'),
    HARBOR_TASKS_FILE: path.join(userDataDir, 'tasks.json'),
    HARBOR_PROJECT_ICONS_DIR: path.join(root, 'icons'),
    HARBOR_MODEL_CACHE_FILE: path.join(cacheDir, 'claude-models.json'),
    HARBOR_E2E_FAKE_LAUNCH: '1', HARBOR_TAILNET_LOGINS: 'none',
    HARBOR_WEB_DIST: DIST,
  });
  assert.equal(os.homedir(), home, 'all default-home reads must be relocated');

  // The Gemini registry entry, added only when the real one is absent (see the header).
  const capabilities = require('../src/main/providers/capabilities.js');
  const realOptions = capabilities.newSessionOptions;
  let realHadGemini = null;
  capabilities.newSessionOptions = (config, deps) => {
    const options = realOptions(config, deps);
    if (realHadGemini === null) realHadGemini = Boolean(options.providers.gemini);
    if (!options.providers.gemini) {
      options.providers.gemini = { ...GEMINI_REGISTRY, profiles: [], defaultProfile: null };
    }
    return options;
  };
  const { composeServer } = require('../src/server/compose.js');

  const profiles = ['personal', 'team'].map((id, index) => ({
    id, label: `Fixture ${index + 1}`, provider: 'claude', isDefault: index === 0, email: null,
    configHome: path.join(home, `claude-${id}`), letter: String(index + 1), color: '#437FFE',
  }));
  const config = {
    setup: { completed: true }, profiles,
    providers: { claude: { enabled: true }, codex: { enabled: true }, cursor: { enabled: true } },
    paths: { cacheDir, projectsDir: path.join(home, 'projects'), projectIconsDir: path.join(root, 'icons') },
  };
  await fs.writeFile(process.env.HARBOR_CONFIG_FILE, JSON.stringify(config));
  // Made-up project folders that are never created: a path with a Temp segment hides a FINISHED row by design.
  const demo = (name) => path.join(path.parse(root).root, 'Users', 'demo', 'dev', name);
  const sessions = [
    { id: GEMINI_ID, cwd: demo('lighthouse'), provider: 'gemini', title: 'Plan the harbor migration', isLive: false, lastActiveMs: Date.now() - 60_000 },
    { id: CLAUDE_ID, cwd: demo('harbor-notes'), provider: 'claude', title: 'Tidy the notes', isLive: false, lastActiveMs: Date.now() - 120_000 },
    // Old rows in real folders: they only give the New session sheet project folders to list.
    { id: 'fixture-1', cwd: folders[0], provider: 'claude', title: 'Old one', isLive: false, lastActiveMs: 10 },
    { id: 'fixture-2', cwd: folders[1], provider: 'claude', title: 'Old two', isLive: false, lastActiveMs: 9 },
  ];
  const state = { model: { projects: [{ label: 'lighthouse', sessions }] } };
  const sidebar = {
    emitter: new EventEmitter(), async start() {}, close() {},
    getState: () => state,
    getSessionMeta: async (id) => sessions.find((session) => session.id === id) || null,
    getSessionPreview: async () => null, focusLivePane: async () => ({ ok: true }),
  };
  const composed = await composeServer({
    userDataDir, configFile: process.env.HARBOR_CONFIG_FILE, env: process.env,
    skipDaemonStart: true, selfOriginHosts: [], sidebar,
    icons: { async list() { return { icons: {} }; }, watch() {} },
    transcript: { emitter: new EventEmitter(), async open() { return { ok: true }; }, close() {}, closeAll() {} },
    terminalBridge: { emitter: new EventEmitter(), async start() {}, close() {} },
    sessionSend: {
      emitter: new EventEmitter(), getQueueState: () => ({ count: 0, items: [] }),
      async getMenu() { return null; }, async send() { throw Error('unexpected session send'); },
    },
    tasks: { read: async () => ({ lists: [], tasks: [], version: 1 }), subscribe() {}, close() {} },
    onFakeLaunch: () => { throw new Error('this drive must never launch'); },
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  assert.equal(address.address, '127.0.0.1');
  return { composed, baseUrl: `http://127.0.0.1:${address.port}`, folders, realHadGemini: () => realHadGemini };
}

async function drive(page, fx) {
  await page.goto(`${fx.baseUrl}/#token=${fx.composed.token}&url=${encodeURIComponent(fx.baseUrl)}`);
  await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 20000 });

  // 1. The New session sheet: four tabs, each with its mark; Gemini's models and efforts.
  await page.getByRole('button', { name: 'Switch session' }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const tabs = page.locator('.newsession-provider');
  await expect(tabs).toHaveCount(4);
  assert.deepEqual(await tabs.allTextContents(), ['Claude', 'Codex', 'Cursor', 'Gemini']);
  const marks = await tabs.evaluateAll(async (buttons) => Promise.all(buttons.map(async (button) => {
    const mark = button.querySelector('.newsession-provider-mark');
    const url = (getComputedStyle(mark).backgroundImage.match(/url\("?([^"]+)"?\)/) || [])[1] || null;
    const loaded = url ? await new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img.naturalWidth > 0); img.onerror = () => resolve(false); img.src = url; }) : false;
    return { loaded, width: mark.getBoundingClientRect().width, svg: decodeURIComponent(url || '').match(/<title>([^<]+)<\/title>/)?.[1] || null };
  })));
  assert.deepEqual(marks.map((mark) => mark.loaded), [true, true, true, true], 'every tab carries a loaded mark');
  assert.equal(marks[3].svg, 'Gemini', 'the Gemini tab draws the Gemini mark');
  assert.ok(marks.every((mark) => mark.width === 16), 'all four marks share one size');
  console.log(`PASS tabs: ${(await tabs.allTextContents()).join(', ')}; marks loaded, Gemini's titled "${marks[3].svg}"`);

  await page.getByRole('button', { name: 'Gemini', exact: true }).click();
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toHaveValue('default');
  assert.deepEqual(await model.locator('option').allTextContents(), ['Gemini default', 'Gemini 4 Neon', 'Gemini 4 Hydrogen']);
  await expect(page.locator('.newsession-effort')).toHaveText(['low', 'medium', 'high', 'xhigh']);
  // The phone carries a still-valid effort across a provider switch (Claude's xhigh is also a Gemini level); it
  // is the same rule Codex gets, so only that exactly one level is chosen and it is one Gemini offers.
  await expect(page.locator('.newsession-effort.on')).toHaveCount(1);
  assert.ok(['low', 'medium', 'high', 'xhigh'].includes(await page.locator('.newsession-effort.on').textContent()));
  await expect(page.locator('.newsession-field', { hasText: 'Plan' })).toHaveCount(0);
  const summary = await page.locator('.newsession-summary').textContent();
  assert.match(summary, /^Gemini · Gemini default/);
  assert.doesNotMatch(summary, /Claude/);
  await screenshot(page, '01-gemini-tab');
  await model.selectOption('gemini-4-hydrogen');
  await expect(page.locator('.newsession-effort')).toHaveText(['low', 'medium']);
  await expect(page.locator('.newsession-effort.on')).toHaveCount(1);
  await screenshot(page, '02-gemini-hydrogen');
  const geometry = await page.locator('.newsession-panel').evaluate((panel) => {
    const body = panel.querySelector('.newsession-body');
    const row = panel.querySelector('.newsession-providers').getBoundingClientRect();
    const buttons = [...panel.querySelectorAll('.newsession-provider')].map((b) => b.getBoundingClientRect());
    return { right: panel.getBoundingClientRect().right, bodyWidth: body.clientWidth, contentWidth: body.scrollWidth,
      rowRight: row.right, lastRight: Math.max(...buttons.map((b) => b.right)), rows: new Set(buttons.map((b) => Math.round(b.top))).size };
  });
  assert.ok(geometry.right <= VIEWPORT.width && geometry.contentWidth <= geometry.bodyWidth + 1, `sheet overflows: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.lastRight <= geometry.rowRight + 1, `a provider tab is clipped: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.rows, 1, `four provider tabs wrap at 390px: ${JSON.stringify(geometry)}`);
  console.log(`PASS Gemini sheet: Default + two families, Hydrogen cut to low/medium, no Plan row for a lone root, no overflow (all four tabs on one row)`);
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // 2. An open Gemini session: the header's "New ... session" button names Gemini, and nothing says Claude.
  // The phone opens on the newest session, which is the Gemini one; leave the Sessions drawer the sheet came from.
  await page.getByRole('button', { name: 'Back' }).first().click().catch(() => {});
  await expect(page.getByRole('button', { name: /Switch session \(now: Plan the harbor migration\)/ })).toBeVisible();
  const hereLabel = await page.locator('[aria-label^="New "][aria-label*="session"]').first().getAttribute('aria-label');
  assert.match(hereLabel, /^New Gemini session in /, hereLabel);
  assert.doesNotMatch(hereLabel, /Claude/);
  await screenshot(page, '03-gemini-session');
  console.log(`PASS open Gemini session: header button reads "${hereLabel}"`);
  const shell = await page.locator('.app-shell').innerText();
  assert.doesNotMatch(shell, /Claude/, 'no Gemini surface says Claude');
  console.log('PASS the Gemini session screen never says Claude');
  return { realHadGemini: fx.realHadGemini() };
}

async function main() {
  await fs.access(path.join(DIST, 'index.html'));
  const originalEnv = { ...process.env };
  const executablePath = chromium.executablePath();
  const browserEnv = { ...originalEnv };
  delete browserEnv.ELECTRON_RUN_AS_NODE;
  const root = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-mobile-gemini-fixture-'));
  await fs.mkdir(EVIDENCE, { recursive: true });
  let fx;
  let browser;
  let page;
  try {
    fx = await makeFixture(root);
    console.log(`isolated server: ${fx.baseUrl}; viewport 390x844; stores: ${root}`);
    browser = await chromium.launch({ headless: true, executablePath, env: browserEnv });
    const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const result = await drive(page, fx);
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log(`PASS mobile Gemini drive (registry entry came from ${result.realHadGemini ? 'the server' : 'the fixture wrapper'}): no launches, no daemon`);
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
  console.error(`FAIL mobile Gemini drive: ${error.stack || error}`);
  process.exitCode = 1;
});
