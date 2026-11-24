#!/usr/bin/env node
'use strict';

// LIVE END-TO-END PROOF that Gemini is a real Harbor provider (2026-11-23, Pat: "Make Gemini a Harbor provider
// first"; "be sure we get the gemini icon like we have for claude / codex / cursor for those sessions").
//
// The REAL app (built renderer, real main process) runs hidden and offscreen against an ISOLATED store, config,
// session daemon and profile (the README capture's isolation, scripts/lib/capture-runtime.cjs), with ONE escape:
// HARBOR_ALLOW_REAL_LAUNCH=1, so its New session button really starts the installed Antigravity CLI (agy) in a pane.
// agy runs in the scratch profile (USERPROFILE is the fixture root): its consent screens are seeded there, never in a
// person's profile, and the conversation is deleted with the root. One tiny turn on gemini-4-hydrogen low.
//
// It proves, through the UI a person uses:
//   1. New session offers a Gemini tab with its mark, Hydrogen and its efforts, and starts a Gemini session;
//   2. the window opens with the Gemini mark on its model chip, and the pane draws agy's input line;
//   3. a message typed in the command bar reaches agy (its own transcript records it) and the reply renders in the
//      conversation window;
//   4. the window upgrades from its provisional pane id to the conversation id, and the rail lists the session with
//      the Gemini mark.
// Screenshots go to C:\dev\.orch\harbor\gemini-live\ (outside the deleted root).
//
//   node scripts/drive-gemini-live-win.js        (from app/; needs a renderer build: npm run build)
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { captureEnv, hiddenMain, closeApp, stopChild, assertHidden, ownedRoot, VERIFY } = require('./lib/capture-runtime.cjs');
const { prepareRoot, buildCorpus, buildConfig, seedUsage } = require('./lib/demo-corpus.cjs');
const { resolveGeminiConfigSync } = require('../src/main/providers/gemini-config.js');
const { SessionClient } = require('../src/daemon/client.js');

const APP_ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.HARBOR_GEMINI_LIVE_SHOTS || 'C:\\dev\\.orch\\harbor\\gemini-live';
const PROMPT = 'Reply with exactly the word PONG and nothing else. Use no tools.';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const check = (name, passed, detail = '') => { checks.push({ name, passed: Boolean(passed), detail }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`); };

async function until(fn, what, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(stepMs);
  }
  throw new Error(`timed out waiting for ${what} (${typeof last === 'string' ? last : JSON.stringify(last)})`);
}

async function main() {
  // Resolve the real CLI BEFORE the profile moves: the resolver reads ~/.harbor/gemini.json under the real profile.
  const real = resolveGeminiConfigSync();
  if (!real) throw new Error('agy is not installed here; nothing to prove');
  fs.mkdirSync(SHOTS, { recursive: true });
  const root = prepareRoot(path.join(VERIFY, 'harbor-gemini-live'));
  const home = ownedRoot(root);
  const env = captureEnv(root);
  env.HARBOR_E2E_FAKE_LAUNCH = '0'; // harness mode fakes launches unless this is '0' (isolation.js)
  env.HARBOR_ALLOW_REAL_LAUNCH = '1';
  env.HARBOR_AGY_BIN = real.bin;
  // agy's consent screens are seeded in this SCRATCH profile only (AGY-FACTS 0.3): a person's are theirs to answer.
  const agyCache = path.join(home, '.gemini', 'antigravity-cli', 'cache');
  fs.mkdirSync(agyCache, { recursive: true });
  fs.writeFileSync(path.join(agyCache, 'onboarding.json'), JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: true, onboardingComplete: true }));

  const userData = path.join(root, 'userData');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const corpus = buildCorpus(root);
  const workspace = path.join(corpus.home, 'demo', 'gemini-live');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(buildConfig(root, { projectsDir: corpus.projectsDir, home: corpus.home, cacheDir, userData }), null, 2));
  seedUsage(cacheDir);
  // The isolated app skips model discovery (HARBOR_E2E), so fill its catalog cache once with Harbor's own refresh,
  // run here against the real agy in the scratch profile: the menu then offers exactly what `agy models` lists.
  const { createGeminiModelCatalog } = require('../src/main/providers/gemini-model-catalog.js');
  const seeded = await createGeminiModelCatalog({
    cacheFile: path.join(cacheDir, 'gemini-models.json'), bin: real.bin,
    env: { ...process.env, USERPROFILE: home, HARBOR_E2E: '', HARBOR_NO_MODEL_DISCOVERY: '' },
  }).refresh();
  check("Harbor's catalog refresh reads agy's real model list", seeded.ok, seeded.reason || 'gemini-models.json written');

  const daemon = spawn(process.execPath, [path.join(APP_ROOT, 'src', 'daemon', 'daemon.js')], { stdio: 'ignore', windowsHide: true, env: { ...env, HARBOR_SESSIOND_PARENT_PID: String(process.pid) } });
  const client = new SessionClient({ socketPath: env.HARBOR_SESSIOND_SOCKET, requestTimeoutMs: 15000 });
  await until(async () => (await client.request('health')).ok, 'the isolated daemon', 20000);
  check('the daemon is the isolated one', /harbor-shot-/.test(env.HARBOR_SESSIOND_SOCKET), env.HARBOR_SESSIOND_SOCKET);

  const { _electron: electron } = require('@playwright/test');
  let app;
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [hiddenMain, `--user-data-dir=${userData}`],
      cwd: APP_ROOT,
      timeout: 120000,
      env: { ...env, HARBOR_SHOT_ROOT: root, HARBOR_E2E_FAKE_DIALOG: workspace },
    });
    const proc = app.process();
    const electronLog = fs.createWriteStream(path.join(SHOTS, 'electron-output.log'));
    proc.stdout?.on('data', (d) => electronLog.write(d));
    proc.stderr?.on('data', (d) => electronLog.write(d));
    const page = await app.firstWindow({ timeout: 60000 });
    page.setDefaultTimeout(15000);
    await page.waitForSelector('.rail', { timeout: 60000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await assertHidden(app);
    const shot = async (name) => {
      await assertHidden(app);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.invalidate());
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };

    // 1. New session: the Gemini tab, Hydrogen, low.
    await page.locator('.sidebar-global-new').first().click({ timeout: 5000 });
    await page.waitForSelector('.new-session-popover', { timeout: 15000 });
    const geminiTab = page.locator('.new-session-providers button', { hasText: 'Gemini' }).first();
    await geminiTab.click();
    const tab = await geminiTab.evaluate((b) => ({ active: b.classList.contains('active'), logo: decodeURIComponent(b.querySelector('img')?.getAttribute('src') || ''), loaded: (() => { const i = b.querySelector('img'); return Boolean(i && i.complete && i.naturalWidth > 0); })() }));
    check('New session has a Gemini tab with the Gemini mark', tab.active && tab.loaded && /gemini/i.test(tab.logo) && !/claude/i.test(tab.logo), tab.logo.slice(0, 80));
    await page.locator('.model-select').first().click();
    await page.locator('.model-select-row', { hasText: 'Hydrogen' }).first().click();
    await page.locator('.cap-seg button', { hasText: 'low' }).first().click();
    const start = await page.locator('.new-session-start').first().textContent();
    check('the start button says Start Gemini session', start.trim() === 'Start Gemini session', start);
    await shot('01-new-session-gemini');
    await page.locator('.new-session-start').first().click();

    // 2. The window opens with the Gemini mark, and the pane draws agy's input line.
    const chip = await until(() => page.evaluate(() => {
      const el = document.querySelector('.win2 .model-chip[data-provider="gemini"]');
      if (!el) return null;
      const img = el.querySelector('img.logomk');
      return { name: el.querySelector('.model-name')?.textContent, logo: decodeURIComponent(img?.getAttribute('src') || '').slice(0, 300), loaded: Boolean(img && img.complete && img.naturalWidth > 0), id: el.closest('[data-session-id]')?.dataset.sessionId };
    }), 'a Gemini window', 60000);
    check('a Gemini window opened with the Gemini mark on its chip', chip.loaded && /gemini/i.test(chip.logo), JSON.stringify({ name: chip.name, id: chip.id }));
    const pane = await until(async () => (await client.request('list')).sessions.find((s) => /gemini|agy/i.test(`${s.agent || ''} ${(s.argv || s.command || []).join?.(' ') || s.command || ''}`)), 'the agy pane in the isolated daemon', 60000);
    const screen = await until(async () => {
      const text = (await client.request('screen', { id: pane.id, scrollback: 40 })).visible || '';
      return /(^|\n)> /.test(text) && /─{40,}/.test(text) ? text : null;
    }, "agy's input line in the pane", 90000);
    check("the pane draws agy's input line (no consent screen in the way)", Boolean(screen), screen.split('\n').filter(Boolean).slice(-3).join(' | '));
    await shot('02-gemini-window-open');

    // 3. A message from the command bar reaches agy, and the reply renders in the window.
    const editor = page.getByRole('textbox', { name: 'Message the selected session' });
    await editor.click();
    await editor.pressSequentially(PROMPT, { delay: 5 });
    await editor.press('Enter');
    const reply = await until(() => page.evaluate(() => {
      const win = document.querySelector('.win2 .model-chip[data-provider="gemini"]')?.closest('.win2');
      const text = win ? [...win.querySelectorAll('.conv-assistant')].map((n) => n.textContent).join('\n') : '';
      return /PONG/.test(text) ? { text: text.slice(-200), id: win.querySelector('[data-session-id]')?.dataset.sessionId || win.dataset.sessionId } : null;
    }), "Gemini's reply in the conversation window", 180000, 1000);
    check("Gemini's reply renders in the conversation window", true, reply.text);
    const convId = await until(() => page.evaluate(() => {
      const el = document.querySelector('.win2 .model-chip[data-provider="gemini"]')?.closest('[data-session-id]');
      const id = el?.dataset.sessionId || '';
      return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id : null;
    }), 'the window to upgrade to the conversation id', 60000);
    check('the window upgraded from its pane id to the conversation id', /^[0-9a-f-]{36}$/i.test(convId), convId);
    const transcript = path.join(home, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs', 'transcript_full.jsonl');
    const recorded = fs.existsSync(transcript) && fs.readFileSync(transcript, 'utf8').split('\n').some((line) => line.includes('USER_INPUT') && line.includes('PONG and nothing else'));
    check("agy's own transcript records the message exactly once typed", recorded, transcript.replace(home, '<root>'));

    // 4. The rail lists the session with the Gemini mark.
    await page.locator('[data-filter="all"]').click().catch(() => {});
    const row = await until(() => page.evaluate((id) => {
      const el = document.querySelector(`.sr[data-session-id="${id}"]`);
      if (!el) { for (const label of document.querySelectorAll('.sidebar-project-wrap .pg-label')) label.click(); return null; }
      const img = el.querySelector('img.sr-provider');
      return { logo: decodeURIComponent(img?.getAttribute('src') || '').slice(0, 300), loaded: Boolean(img && img.complete && img.naturalWidth > 0), title: el.querySelector('.sr-t')?.textContent };
    }, convId), 'the Gemini session on the rail', 60000, 1500);
    check('the rail lists the Gemini session with the Gemini mark', row.loaded && /gemini/i.test(row.logo) && !/claude/i.test(row.logo), row.title);
    // ONE row per session (views.md: one status light per rail row): the live pane must merge into its conversation's
    // row once the linker annotates the keeper with the conversation id, never stay a second "Live session" row.
    const mergeStart = Date.now();
    const merged = await until(async () => {
      const rows = await page.evaluate(() => [...document.querySelectorAll('.sr')].map((el) => ({ id: el.dataset.sessionId || '', title: el.querySelector('.sr-t')?.textContent || '' })));
      const own = rows.filter((row) => row.id === convId);
      const loose = rows.filter((row) => /^(live|pane):/.test(row.id) || row.title === 'Live session');
      return own.length === 1 && loose.length === 0 ? { rows, mergedAfterMs: Date.now() - mergeStart } : null;
    }, 'the live pane to merge into its conversation row', 90000, 2000).catch(async (error) => {
      const sessions = (await client.request('list')).sessions.map((x) => ({ id: x.id, agent: x.agent, agent_session: x.agent_session, cwd: x.cwd }));
      const rows = await page.evaluate(() => [...document.querySelectorAll('.sr')].map((el) => ({ id: el.dataset.sessionId, title: el.querySelector('.sr-t')?.textContent })));
      return { error: error.message, sessions, rows };
    });
    fs.writeFileSync(path.join(SHOTS, 'merge-debug.json'), JSON.stringify(merged, null, 2));
    check('the rail shows ONE row for the session: the live pane merged into its conversation', Boolean(merged?.mergedAfterMs !== undefined), merged?.mergedAfterMs !== undefined ? `merged ${merged.mergedAfterMs} ms after the rail check` : 'rows in merge-debug.json');
    await shot('03-gemini-reply-and-rail');
  } catch (error) {
    check('drive finished', false, error.stack || error.message);
    try { console.log('daemon sessions at failure:', JSON.stringify((await client.request('list')).sessions.map((x) => ({ id: x.id, agent: x.agent, state: x.state, cwd: x.cwd, argv: x.argv || x.command })), null, 1).slice(0, 2000)); } catch (e) { console.log('daemon list failed', e.message); }
    try { const pages = app ? app.windows() : []; if (pages[0]) await pages[0].screenshot({ path: path.join(SHOTS, 'zz-failure.png') }); } catch { /* app gone */ }
  } finally {
    try { for (const s of (await client.request('list')).sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {}); } catch { /* going away */ }
    client.close();
    await closeApp(app);
    await stopChild(daemon);
    await sleep(1500);
    for (let i = 0; i < 10; i += 1) { try { fs.rmSync(home, { recursive: true, force: true }); break; } catch { await sleep(500); } }
    console.log(fs.existsSync(home) ? `scratch root still present: ${home}` : 'scratch root deleted (the Gemini conversation went with it)');
  }
  const failed = checks.filter((c) => !c.passed);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
