#!/usr/bin/env node
'use strict';

// Drive: the phone's Sessions list must name every Codex session (2026-10-31).
//
// Pat, with a phone screenshot: "Codex (or any non-Claude) sessions don't show
// up in mobile but I think they show up like as a perpetually 'hung' live
// session." The phone server built its rail with no `profiles`, so provider
// history and the linker saw only the default ~/.codex and every live Codex pane
// in another Codex home was a row titled "Live session".
//
// This composes the REAL harbor-server (the real sidebar bridge, real provider
// history over real rollout files, no stubbed rail) on loopback against a fake
// daemon on an isolated pipe, with synthetic data only: two Codex homes, a
// Cursor session, and a Claude session for contrast. It serves the SHIPPED
// phone bundle and drives headless Chromium at an iPhone 14 Pro Max size, opens
// the Sessions list, taps a Codex row and screenshots each step.
//
// Run from app, against a bundle built OUTSIDE the live one:
//   node scripts/drive-phone-codex-rows-win.js <distDir> <evidenceDir> --label=after
// Prove the old wiring by pointing --compose at a copy of the pre-fix compose.js
// that sits beside the current one (it needs the same relative requires), and
// pass --expect=nameless: the drive then requires the bug instead of its absence.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { realTmpDir } = require('../test/support/real-tmpdir.js');
const { startFakeSessiond } = require('../test/support/fake-sessiond.js');

const APP_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const flag = (name, fallback) => (argv.find((arg) => arg.startsWith(`--${name}=`)) || '').slice(name.length + 3) || fallback;
const DIST = path.resolve(positional[0] || path.join(APP_ROOT, 'dist-web'));
const EVIDENCE = path.resolve(positional[1] || path.join(realTmpDir(), 'harbor-drive-phone-codex-rows'));
const LABEL = flag('label', 'run');
const COMPOSE = path.resolve(flag('compose', path.join(APP_ROOT, 'src', 'server', 'compose.js')));
const EXPECT = flag('expect', 'named');
const PHONE = { width: 430, height: 932 };
const SAFE = { top: 47, bottom: 34 };

const CLAUDE_LIVE = '11111111-1111-4111-8111-111111111111';
const CLAUDE_OLD = '22222222-2222-4222-8222-222222222222';
const CODEX_DEFAULT = '01900000-aaaa-7000-8000-00000000000a';
const CODEX_OTHER_1 = '01900000-bbbb-7000-8000-00000000000b';
const CODEX_OTHER_2 = '01900000-cccc-7000-8000-00000000000c';
const CODEX_OLD = '01900000-dddd-7000-8000-00000000000d';
const CURSOR_OLD = '4692b1ae-1af9-4147-879c-65c0b0b48ca2';

const PROMPTS = {
  [CODEX_DEFAULT]: 'Draft the release checklist for the widget',
  [CODEX_OTHER_1]: 'Summarize the quarterly widget report',
  [CODEX_OTHER_2]: 'Compare the gadget pricing tiers',
  [CODEX_OLD]: 'Archived question about the gadget spec',
};

function iso(minutesAgo) { return new Date(Date.now() - minutesAgo * 60_000).toISOString(); }

async function makeFixture(root) {
  const home = path.join(root, 'home');
  // A made-up project folder that is never created. It cannot sit under the
  // scratch root: a path with a Temp/tmp segment makes its FINISHED rows hidden
  // by design (isScratchSession), and one under .orch is grouped as
  // Orchestration, either of which would hide or rename what this drive checks.
  const work = path.join(path.parse(root).root, 'Users', 'demo', 'dev', 'demo-site');
  const userDataDir = path.join(root, 'user-data');
  const cacheDir = path.join(root, 'cache');
  const projectsDir = path.join(root, 'projects');
  const contextDir = path.join(root, 'context');
  const codexDefault = path.join(home, '.codex');
  const codexOther = path.join(root, 'codex-other');
  await Promise.all([home, userDataDir, cacheDir, contextDir, path.join(root, 'sessiond')]
    .map((dir) => fs.mkdir(dir, { recursive: true })));
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('HARBOR_') || key.startsWith('CLAUDE_') || key.startsWith('CODEX_')) delete process.env[key];
  }
  const socket = path.join(root, 'sessiond', 'isolated.sock');
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home,
    HARBOR_CONFIG_FILE: path.join(root, 'config.json'),
    HARBOR_NO_DAEMON_START: '1', HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_MODEL_DISCOVERY: '1', HARBOR_NO_TITLER: '1', HARBOR_NO_VOICE: '1',
    HARBOR_CONTEXT_DIR: contextDir,
    HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
    HARBOR_SESSIOND_SOCKET: socket,
    HARBOR_ARTIFACTS_ROOTS: path.join(root, 'artifacts'),
    HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifacts.json'),
    HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
    HARBOR_NOTES_FILE: path.join(root, 'notes.json'),
    HARBOR_PROJECT_ICONS_DIR: path.join(root, 'icons'),
    HARBOR_E2E_FAKE_LAUNCH: '1', HARBOR_TAILNET_LOGINS: 'none',
    HARBOR_WEB_DIST: DIST,
  });
  await fs.writeFile(process.env.HARBOR_CONFIG_FILE, JSON.stringify({
    version: 1,
    setup: { completed: true },
    profiles: [
      { id: 'personal', label: 'Personal', letter: 'P', color: '#437FFE', provider: 'claude', configHome: path.join(home, 'claude-personal'), email: null, isDefault: true },
      { id: 'codex-main', label: 'Codex', letter: 'X', color: '#10A37F', provider: 'codex', configHome: codexDefault, email: null, isDefault: true },
      { id: 'codex-other', label: 'Codex Other', letter: 'O', color: '#7A5AF8', provider: 'codex', configHome: codexOther, email: null, isDefault: false },
    ],
    providers: { claude: { enabled: true }, codex: { enabled: true }, cursor: { enabled: true } },
    paths: { cacheDir, projectsDir, projectIconsDir: path.join(root, 'icons') },
  }, null, 2));

  // Codex rollouts: one in the default home, three in the second home.
  const rollout = (id, prompt, minutesAgo) => [
    JSON.stringify({ timestamp: iso(minutesAgo), type: 'session_meta', payload: { id, session_id: id, cwd: work, originator: 'codex_cli_rs', source: 'cli' } }),
    JSON.stringify({ timestamp: iso(minutesAgo), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
    JSON.stringify({ timestamp: iso(minutesAgo), type: 'event_msg', payload: { type: 'user_message', message: prompt } }),
    JSON.stringify({ timestamp: iso(minutesAgo - 1), type: 'event_msg', payload: { type: 'agent_message', message: `Here is the answer for: ${prompt}` } }),
  ].join('\n') + '\n';
  const writeRollout = async (codexHome, id, minutesAgo) => {
    const day = path.join(codexHome, 'sessions', '2026', '10', '31');
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(path.join(day, `rollout-2026-10-31T10-00-00-${id}.jsonl`), rollout(id, PROMPTS[id], minutesAgo));
  };
  await writeRollout(codexDefault, CODEX_DEFAULT, 6);
  await writeRollout(codexOther, CODEX_OTHER_1, 4);
  await writeRollout(codexOther, CODEX_OTHER_2, 3);
  await writeRollout(codexOther, CODEX_OLD, 90);

  // Cursor: a finished session (its cwd is un-munged from a folder Harbor knows).
  const { mungeCwd } = require('../src/main/providers/provider-history.js');
  const cursorDir = path.join(home, '.cursor', 'projects', mungeCwd(work), 'agent-transcripts', CURSOR_OLD);
  await fs.mkdir(cursorDir, { recursive: true });
  await fs.writeFile(path.join(cursorDir, `${CURSOR_OLD}.jsonl`), [
    JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>x</timestamp>\n<user_query>\nReview the widget auth flow.\n</user_query>' }] } }),
    JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Looking now.' }] } }),
  ].join('\n'));

  // Claude: one live, one finished, for contrast with the Codex rows.
  const claudeDir = path.join(projectsDir, work.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(claudeDir, { recursive: true });
  const claudeLines = (id, prompt, minutesAgo) => [
    JSON.stringify({ type: 'user', uuid: `${id}-u`, sessionId: id, cwd: work, timestamp: iso(minutesAgo), message: { role: 'user', content: prompt } }),
    JSON.stringify({ type: 'assistant', uuid: `${id}-a`, sessionId: id, cwd: work, timestamp: iso(minutesAgo - 1), message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }),
  ].join('\n') + '\n';
  await fs.writeFile(path.join(claudeDir, `${CLAUDE_LIVE}.jsonl`), claudeLines(CLAUDE_LIVE, 'Fix the flaky widget test', 8));
  await fs.writeFile(path.join(claudeDir, `${CLAUDE_OLD}.jsonl`), claudeLines(CLAUDE_OLD, 'Rename the gadget helper', 200));
  await fs.writeFile(path.join(contextDir, `${CLAUDE_LIVE}.json`), JSON.stringify({ used_percentage: 43 }));

  const pane = (id, agent, sessionId) => ({
    id, cwd: work, pid: 5000 + id.length, agent, agent_session: sessionId, argv: [agent], created_at: iso(30),
  });
  const daemon = await startFakeSessiond(socket, [
    pane('pane-claude', 'claude', CLAUDE_LIVE),
    pane('pane-codex-default', 'codex', CODEX_DEFAULT),
    pane('pane-codex-other-1', 'codex', CODEX_OTHER_1),
    pane('pane-codex-other-2', 'codex', CODEX_OTHER_2),
  ]);

  const { composeServer } = require(COMPOSE);
  const composed = await composeServer({
    userDataDir, configFile: process.env.HARBOR_CONFIG_FILE, env: process.env,
    selfOriginHosts: [],
    terminalBridge: { emitter: new EventEmitter(), async start() {}, close() {}, async sendInput() { return { ok: true }; } },
    // Not under test; the sidebar bridge, provider history and linker are real.
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable: () => true },
    icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
  });
  const address = await composed.listen({ host: '127.0.0.1', port: 0 });
  return { composed, daemon, baseUrl: `http://127.0.0.1:${address.port}`, work };
}

async function shot(page, name) {
  const file = path.join(EVIDENCE, `${LABEL}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`screenshot: ${file}`);
  return file;
}

async function applyInsets(page) {
  await page.addStyleTag({ content: `:root { --safe-top: ${SAFE.top}px !important; --safe-bottom: ${SAFE.bottom}px !important; }` });
}

async function main() {
  await fs.access(path.join(DIST, 'index.html'));
  const originalEnv = { ...process.env };
  const browserEnv = { ...originalEnv };
  delete browserEnv.ELECTRON_RUN_AS_NODE;
  const root = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-phone-codex-rows-'));
  await fs.mkdir(EVIDENCE, { recursive: true });
  let fx; let browser;
  try {
    fx = await makeFixture(root);
    console.log(`isolated server: ${fx.baseUrl}; bundle ${DIST}; compose ${COMPOSE}; expect ${EXPECT}`);
    const served = await fx.composed.router.call('sidebar:get-state', { days: 'all' });
    const modelRows = served.model.projects.flatMap((project) => project.sessions.map((session) => ({ provider: session.provider, live: Boolean(session.isLive), title: session.title, project: project.label, lastActive: session.lastActive })));
    console.log('server model rows (days all): ' + JSON.stringify(modelRows));
    browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), env: browserEnv });
    const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${fx.baseUrl}/#token=${fx.composed.token}&url=${encodeURIComponent(fx.baseUrl)}`);
    await applyInsets(page);
    await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: /Switch session/ }).click();
    await page.locator('.session-row').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    const rows = await page.locator('.session-row').evaluateAll((nodes) => nodes.map((node) => ({
      title: node.querySelector('.session-title')?.textContent || '',
      live: Boolean(node.querySelector('.session-dot.live')),
      meta: node.querySelector('.session-meta')?.textContent || '',
    })));
    console.log(`rows: ${JSON.stringify(rows)}`);
    await shot(page, '01-sessions-list');

    const nameless = rows.filter((row) => row.title === 'Live session');
    const named = (prompt) => rows.some((row) => row.title.includes(prompt));
    if (EXPECT === 'nameless') {
      assert.equal(nameless.length, 2, 'the old wiring leaves both second-home Codex panes nameless');
      assert.ok(!named(PROMPTS[CODEX_OTHER_1]), 'and the second home is invisible');
      assert.ok(named(PROMPTS[CODEX_DEFAULT]), 'the default home was always visible');
    } else {
      assert.equal(nameless.length, 0, 'no live row is a nameless "Live session"');
      for (const id of [CODEX_DEFAULT, CODEX_OTHER_1, CODEX_OTHER_2]) assert.ok(named(PROMPTS[id]), `Codex row "${PROMPTS[id]}" is listed`);
      assert.ok(rows.some((row) => /widget auth flow/.test(row.title)), 'the Cursor session is listed');
      assert.ok(rows.some((row) => /flaky widget test/.test(row.title)), 'the Claude session is listed');
      // A tap opens a real conversation, not the "has not named its session" stub.
      await page.locator('.session-row', { hasText: PROMPTS[CODEX_OTHER_1] }).first().click();
      await page.waitForTimeout(1500);
      const body = await page.locator('.conv-pane').innerText().catch(() => '');
      console.log(`opened conversation text: ${JSON.stringify(body.slice(0, 160))}`);
      await shot(page, '02-codex-conversation');
      assert.match(body, /Here is the answer for: Summarize the quarterly widget report/, 'the tapped Codex row opens its own transcript');
    }
    assert.deepEqual(errors, [], 'no browser runtime errors');
    assert.deepEqual(fx.composed.isolation.signalCalls, [], 'no process signals');
    await context.close();
    console.log(`PASS phone codex rows drive (${LABEL}, expect ${EXPECT})`);
  } finally {
    await browser?.close();
    await fx?.composed.close();
    await fx?.daemon.shutdown();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL phone codex rows drive: ${error.stack || error}`);
  process.exitCode = 1;
});
