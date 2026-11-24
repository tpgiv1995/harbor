#!/usr/bin/env node
'use strict';

// LIVE PROOF of the Gemini setup card (2026-11-24, Pat, on a new Gemini window that opened on Antigravity's raw
// colour-scheme page: "you didn't even bother to build out a harbor screen for gemini").
//
// The REAL app (built renderer, real main process) runs hidden and offscreen against an ISOLATED store, config,
// session daemon and profile (scripts/lib/capture-runtime.cjs), with HARBOR_ALLOW_REAL_LAUNCH=1 so New session
// starts the installed agy. agy runs in a SCRATCH profile with NO onboarding seeded, so it opens on Google's
// first-run pages exactly as a never-used profile does. The drive proves, through the UI a person uses:
//   1. the new Gemini window is the designed window (no raw terminal) with the setup card at step 1;
//   2. a scheme click lands on agy's Terms page (read off the real pane) and the card moves to step 2;
//   3. the data-sharing box click toggles agy's own box, and the Done button names the choice;
//   4. Back returns agy and the card to the colour page.
// It NEVER presses Done: that is Google's consent, and a person's (the walk to Done is covered by
// test/main/gemini-first-run.test.js against the measured keys). Screenshots: C:\dev\.orch\harbor\gemini-setup\.
//
//   node scripts/drive-gemini-setup-win.js        (from app/; needs a renderer build: npm run build)
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { captureEnv, hiddenMain, closeApp, stopChild, assertHidden, ownedRoot, VERIFY } = require('./lib/capture-runtime.cjs');
const { prepareRoot, buildCorpus, buildConfig, seedUsage } = require('./lib/demo-corpus.cjs');
const { resolveGeminiConfigSync } = require('../src/main/providers/gemini-config.js');
const { SessionClient } = require('../src/daemon/client.js');
const { parseGeminiFirstRun } = require('../src/main/gemini-first-run.js');

const APP_ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.HARBOR_GEMINI_SETUP_SHOTS || 'C:\\dev\\.orch\\harbor\\gemini-setup';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const check = (name, passed, detail = '') => { checks.push({ name, passed: Boolean(passed), detail }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`); };

async function until(fn, what, timeoutMs, stepMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error.message; }
    await sleep(stepMs);
  }
  throw new Error(`timed out waiting for ${what} (${typeof last === 'string' ? last : JSON.stringify(last)})`);
}

async function main() {
  const real = resolveGeminiConfigSync();
  if (!real) throw new Error('agy is not installed here; nothing to prove');
  fs.mkdirSync(SHOTS, { recursive: true });
  const root = prepareRoot(path.join(VERIFY, 'harbor-gemini-setup'));
  const home = ownedRoot(root);
  const env = captureEnv(root);
  env.HARBOR_E2E_FAKE_LAUNCH = '0';
  env.HARBOR_ALLOW_REAL_LAUNCH = '1';
  env.HARBOR_AGY_BIN = real.bin;
  // No onboarding.json: this scratch profile has never run agy, so it opens on the first-run pages.
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });

  const userData = path.join(root, 'userData');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const corpus = buildCorpus(root);
  const workspace = path.join(corpus.home, 'demo', 'gemini-setup');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(buildConfig(root, { projectsDir: corpus.projectsDir, home: corpus.home, cacheDir, userData }), null, 2));
  seedUsage(cacheDir);
  const { createGeminiModelCatalog } = require('../src/main/providers/gemini-model-catalog.js');
  await createGeminiModelCatalog({
    cacheFile: path.join(cacheDir, 'gemini-models.json'), bin: real.bin,
    env: { ...process.env, USERPROFILE: home, HARBOR_E2E: '', HARBOR_NO_MODEL_DISCOVERY: '' },
  }).refresh();

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
    const page = await app.firstWindow({ timeout: 60000 });
    page.setDefaultTimeout(15000);
    await page.waitForSelector('.rail', { timeout: 60000 });
    const size = async (w, h) => app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h]);
    await size(1600, 1000);
    await assertHidden(app);
    const shot = async (name) => {
      await assertHidden(app);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.invalidate());
      await sleep(250);
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };

    await page.locator('.sidebar-global-new').first().click({ timeout: 5000 });
    await page.waitForSelector('.new-session-popover', { timeout: 15000 });
    await page.locator('.new-session-providers button', { hasText: 'Gemini' }).first().click();
    await page.locator('.new-session-start').first().click();

    const pane = await until(async () => (await client.request('list')).sessions.find((s) => /gemini|agy/i.test(`${s.agent || ''} ${(s.argv || s.command || []).join?.(' ') || s.command || ''}`)), 'the agy pane', 60000);
    const agyPage = async () => parseGeminiFirstRun((await client.request('screen', { id: pane.id, scrollback: 0 })).visible || '');
    const first = await until(agyPage, "agy's colour-scheme page in the pane", 90000);
    check('agy opened on its colour-scheme page (a never-used profile)', first.page === 'scheme', first.schemes.map((s) => s.label).join(', '));

    // 1. The designed window with the setup card, never the raw terminal.
    const card = await until(() => page.evaluate(() => {
      const win = document.querySelector('.win2 .model-chip[data-provider="gemini"]')?.closest('.win2');
      const el = win?.querySelector('.gemini-setup-card');
      if (!el) return null;
      return {
        eyebrow: el.querySelector('.gemini-setup-eyebrow')?.textContent,
        schemes: [...el.querySelectorAll('.gemini-setup-schemes button')].map((b) => ({ label: b.querySelector('.gemini-setup-label')?.textContent, current: b.getAttribute('aria-current') === 'true' })),
        terminal: Boolean(win.querySelector('.tile-tty')),
        note: win.querySelector('.terminal-provider-note')?.textContent || '',
      };
    }), 'the setup card in the Gemini window', 30000);
    check('the new Gemini window is the designed window, no raw terminal', !card.terminal && !card.note, card.note);
    check('the card shows step 1 with the eight schemes agy drew, the pointed one marked', card.eyebrow === 'Gemini setup · step 1 of 2' && card.schemes.length === 8 && card.schemes.find((s) => s.current)?.label === first.schemes.find((s) => s.selected).label, JSON.stringify(card.schemes.map((s) => s.label)));
    await shot('01-step1-colour-scheme');
    await page.locator('.gemini-setup-schemes button', { hasText: 'tokyo night' }).hover();
    await shot('02-step1-hover');

    // 2. A scheme click: agy reaches its Terms page and the card follows.
    await page.locator('.gemini-setup-schemes button', { hasText: /^dark$/ }).first().click();
    const terms = await until(async () => { const p = await agyPage(); return p?.page === 'terms' ? p : null; }, "agy's Terms page after the click", 15000);
    check('clicking "dark" moved agy to its Terms page', terms.checked === true && terms.focus === 'box', JSON.stringify({ checked: terms.checked, focus: terms.focus }));
    const step2 = await until(() => page.evaluate(() => {
      const el = document.querySelector('.gemini-setup-card');
      if (!el || !/step 2/.test(el.querySelector('.gemini-setup-eyebrow')?.textContent || '')) return null;
      return {
        consent: el.querySelector('.gemini-setup-consent')?.textContent,
        checked: el.querySelector('.gemini-setup-consent')?.getAttribute('aria-checked'),
        links: [...el.querySelectorAll('.gemini-setup-links a')].map((a) => a.getAttribute('href')),
        done: el.querySelector('.gemini-setup-done')?.textContent,
      };
    }), 'the card at step 2', 15000);
    check('the card shows step 2 with agy\'s consent sentence, the box ticked, both links', step2.checked === 'true' && /Yes, I agree to help improve Antigravity CLI/.test(step2.consent) && step2.links.length === 2, step2.done);
    await shot('03-step2-terms-ticked');

    // 3. The box: agy's own box toggles, and Done names the choice.
    await page.locator('.gemini-setup-consent').click();
    const off = await until(async () => { const p = await agyPage(); return p?.page === 'terms' && p.checked === false ? p : null; }, "agy's box to untick", 10000);
    const label = await until(() => page.evaluate(() => {
      const el = document.querySelector('.gemini-setup-card');
      return el?.querySelector('.gemini-setup-consent')?.getAttribute('aria-checked') === 'false' ? el.querySelector('.gemini-setup-done')?.textContent : null;
    }), 'the card to show the box unticked', 10000);
    check('the box click unticked agy\'s own box and Done now says "not sharing"', off.checked === false && label === 'Done, not sharing data', label);
    await shot('04-step2-terms-unticked');
    await page.locator('.gemini-setup-done').hover();
    await shot('05-step2-done-hover');

    // 4. Back: agy and the card return to the colour page. Done is never pressed.
    await page.locator('.gemini-setup-back').click();
    const back = await until(async () => { const p = await agyPage(); return p?.page === 'scheme' ? p : null; }, "agy's colour page after Back", 15000);
    const step1 = await until(() => page.evaluate(() => /step 1/.test(document.querySelector('.gemini-setup-eyebrow')?.textContent || '') || null), 'the card back at step 1', 15000);
    check('Back returned agy and the card to the colour page', back.page === 'scheme' && step1 === true);

    // The command bar still refuses to type into a first-run page, and says where to answer.
    const editor = page.getByRole('textbox', { name: 'Message the selected session' });
    await editor.click();
    await editor.pressSequentially('hello', { delay: 5 });
    await editor.press('Enter');
    const refusal = await until(() => page.evaluate(() => {
      const text = document.body.innerText;
      const m = /Gemini is on its first-run screens[^\n]*/.exec(text);
      return m ? m[0] : null;
    }), 'the send refusal', 15000).catch((e) => e.message);
    check('a send on a first-run page types nothing and points at the setup card', /setup card in this window/.test(refusal), refusal);
    const still = await agyPage();
    check('agy is still on its colour page after the refused send', still?.page === 'scheme');
    await shot('06-send-refused');

    await size(1000, 720);
    await sleep(600);
    await shot('07-small-window');
  } catch (error) {
    check('drive finished', false, error.stack || error.message);
    try { const pages = app ? app.windows() : []; if (pages[0]) await pages[0].screenshot({ path: path.join(SHOTS, 'zz-failure.png') }); } catch { /* app gone */ }
  } finally {
    try { for (const s of (await client.request('list')).sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {}); } catch { /* going away */ }
    client.close();
    await closeApp(app);
    await stopChild(daemon);
    await sleep(1500);
    for (let i = 0; i < 10; i += 1) { try { fs.rmSync(home, { recursive: true, force: true }); break; } catch { await sleep(500); } }
    console.log(fs.existsSync(home) ? `scratch root still present: ${home}` : 'scratch root deleted');
  }
  const failed = checks.filter((c) => !c.passed);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${SHOTS}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
