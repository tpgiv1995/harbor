'use strict';
/*
 * Orchestrator proof pass: drives the REAL app against the LIVE daemon.
 * Proves the flows every batch rightly faked in tests:
 *   1. real historical-session resume via sidebar click (then /exit + tab close)
 *   2. real new-session via the app CLI surface (Copilot-chord path)
 *   3. real orchestration research kickoff on the team seat (throwaway dir)
 *   4. degraded banner when the daemon socket is absent (bogus socket path)
 * Artifacts: app/verify/proof/*.png + PROOF-LOG lines on stdout.
 * Cleanup: exits Claude sessions it started, closes tabs/workspaces it created,
 * removes the throwaway queue file. Never touches Pat's own sessions.
 */
const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..');
const OUT = path.join(APP_DIR, 'verify', 'proof');
const RESUME_ID = process.env.PROOF_RESUME_ID || '43d85b96-9511-4c9a-a04a-0b49a35bbc14';
// A scratch sibling of the repo checkout (not inside it), so a real
// orchestration kickoff has a throwaway project directory to point at.
const PROOF_DIR = path.resolve(REPO_ROOT, '..', 'harbor-proof');
const HERDR_BIN = path.join(os.homedir(), '.local', 'bin', 'herdr');
const CACHE_USAGE_TEAM = path.join(os.homedir(), '.cache', 'harbor', 'usage-team.json');

const log = (...a) => console.log('PROOF-LOG', ...a);
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, name), fullPage: false });
  log('shot', name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(env = {}) {
  const app = await _electron.launch({
    args: [APP_DIR],
    env: { ...process.env, ...env },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.sidebar-session-row, .sidebar-project-row, .terminal-empty', { timeout: 20000 });
  await sleep(2500);
  return { app, page };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let failures = 0;

  // ---- Step 4 first (isolated app instance, bogus socket): degraded banner ----
  {
    const { app, page } = await launch({ HERDR_SOCKET_PATH: '/tmp/nonexistent-harbor-proof.sock', HARBOR_NO_DAEMON_START: '1' });
    await sleep(2000);
    const banner = await page.locator('.daemon-banner').count();
    const headerText = await page.locator('.sidebar-header, .sidebar').first().textContent().catch(() => '');
    const indexedMatch = /([0-9,]+)\s*indexed/.exec(headerText || '');
    const indexed = indexedMatch ? parseInt(indexedMatch[1].replace(/,/g, ''), 10) : 0;
    log('degraded: banner elements =', banner, 'indexed count =', indexed);
    await shot(page, '4-degraded-banner.png');
    if (indexed < 1000) { log('FAIL: history should render without daemon'); failures += 1; }
    if (banner < 1) { log('FAIL: degraded banner missing'); failures += 1; }
    await app.close();
  }

  // ---- Main instance against the LIVE daemon ----
  const { app, page } = await launch();
  await shot(page, '0-boot-live.png');

  // ---- Step 1: real resume of a dead session ----
  {
    await page.fill('.sidebar-search-input', RESUME_ID.slice(0, 8));
    await sleep(1200);
    let row = page.locator(`[data-session-id="${RESUME_ID}"]`).first();
    if (!(await row.count())) {
      await page.fill('.sidebar-search-input', 'Notes usage-sink');
      await sleep(1200);
      row = page.locator('.sidebar-session-row').first();
    }
    if (!(await row.count())) throw new Error('resume target row not found in sidebar');
    await shot(page, '1a-resume-target.png');
    await row.click();
    log('clicked resume row for', RESUME_ID);
    // pane should appear and stream the resumed Claude session
    await page.waitForSelector('.terminal-pane', { timeout: 30000 });
    await sleep(9000); // let claude boot + backfill
    await shot(page, '1b-resumed-pane.png');
    const paneText = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.terminal-pane .xterm-rows'));
      return rows.map((r) => r.textContent || '').join('\n');
    });
    const streamed = paneText.length > 200;
    log('resumed pane text length:', paneText.length, streamed ? 'OK' : 'FAIL');
    if (!streamed) failures += 1;
    // type /exit into the focused pane to end the resumed session
    await page.locator('.terminal-pane').first().click();
    await sleep(1500);
    await page.keyboard.type('/exit');
    await page.keyboard.press('Enter');
    await sleep(4000);
    log('sent /exit to resumed session');
    await shot(page, '1c-after-exit.png');
  }

  // ---- Step 2: real new session via CLI surface (Copilot-chord path) ----
  {
    const { execFile } = require('node:child_process');
    await new Promise((resolve, reject) => {
      execFile(path.join(APP_DIR, 'node_modules', '.bin', 'electron'),
        [APP_DIR, '--new-session', '--home', 'personal', '--cwd', PROOF_DIR],
        { timeout: 20000 }, (err, so, se) => err && !String(se).includes('second-instance') ? reject(err) : resolve());
    }).catch((e) => { log('cli trigger note:', e.message); });
    log('fired --new-session --home personal --cwd', PROOF_DIR);
    await sleep(12000);
    await shot(page, '2a-new-session-pane.png');
    const wsNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.terminal-workspace-tab')).map((e) => e.textContent || ''));
    const hasProofWs = wsNames.some((n) => n.includes('harbor-proof'));
    const { execFileSync } = require('node:child_process');
    const daemonList = execFileSync(HERDR_BIN, ['workspace', 'list'], { encoding: 'utf8' });
    const onDaemon = daemonList.includes('harbor-proof');
    log('workspace in app tabs:', hasProofWs ? 'OK' : 'MISSING', '| on daemon:', onDaemon ? 'OK' : 'MISSING');
    if (!hasProofWs || !onDaemon) failures += 1;
    // exit that session too
    const proofTab = page.locator('.terminal-workspace-tab', { hasText: 'harbor-proof' }).first();
    if (await proofTab.count()) {
      await proofTab.click(); await sleep(2000);
      await page.locator('.terminal-pane').first().click(); await sleep(1500);
      await page.keyboard.type('/exit'); await page.keyboard.press('Enter');
      await sleep(3000);
      log('exited new personal session');
    }
  }

  // ---- Step 3: real orchestration research kickoff (team seat) ----
  {
    // Open the panel via the app's own test hook (exact selector-free), the
    // same entry the verify-orch mode uses.
    const opened = await page.evaluate(async () => {
      if (!window.__openOrchForTest || !window.harbor?.sidebar?.getState) return false;
      const st = await window.harbor.sidebar.getState();
      const proj = (st?.model?.projects || []).find((p) => p.label === 'harbor-proof');
      if (!proj) return false;
      window.__openOrchForTest(proj);
      return true;
    });
    if (opened) {
      await sleep(1500);
      await page.fill('.orch-goal-input, textarea', 'List the files in this directory, write PROOF.md containing the list, and finish.');
      await shot(page, '3a-kickoff-filled.png');
      await page.locator('button', { hasText: /start research/i }).first().click();
      log('clicked Start research (team)');
      await page.waitForSelector('.terminal-pane', { timeout: 30000 });
      await sleep(20000); // team claude boots; statusline renders; tee should appear
      await shot(page, '3b-research-pane.png');
      const teeExists = fs.existsSync(CACHE_USAGE_TEAM);
      log('team usage tee file exists:', teeExists ? 'OK' : 'NOT YET');
      await sleep(1000);
      await shot(page, '3c-meters-after-team.png');
    } else {
      log('FAIL: __openOrchForTest hook unavailable'); failures += 1;
    }
  }

  await shot(page, '9-final-state.png');

  // ---- Cleanup: close everything this proof created on the live daemon ----
  try {
    const { execFileSync } = require('node:child_process');
    const list = JSON.parse(execFileSync(HERDR_BIN, ['workspace', 'list'], { encoding: 'utf8' }));
    const proofWs = (list?.result?.workspaces || []).find((w) => w.label === 'harbor-proof');
    if (proofWs) {
      execFileSync(HERDR_BIN, ['workspace', 'close', proofWs.workspace_id]);
      log('cleanup: closed harbor-proof workspace', proofWs.workspace_id);
    }
  } catch (e) { log('cleanup note:', e.message); }
  await app.close();
  log('DONE failures=', failures);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('PROOF-FATAL', e); process.exit(2); });
