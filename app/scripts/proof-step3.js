'use strict';
// Focused: orchestration kickoff proof with renderer console captured.
const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const APP_DIR = path.resolve(__dirname, '..');
const OUT = path.join(APP_DIR, 'verify', 'proof');
// A scratch sibling of the repo checkout (not inside it), matching the
// throwaway dir proof-pass.js uses for the same orchestration-kickoff proof.
const PROOF_DIR = path.resolve(APP_DIR, '..', '..', 'harbor-proof');
const HERDR_BIN = path.join(os.homedir(), '.local', 'bin', 'herdr');
const CACHE_USAGE_TEAM = path.join(os.homedir(), '.cache', 'harbor', 'usage-team.json');
const log = (...a) => console.log('P3', ...a);

(async () => {
  const app = await _electron.launch({ args: [APP_DIR], env: { ...process.env } });
  const page = await app.firstWindow();
  page.on('console', (m) => console.log('RENDERER', m.type(), m.text()));
  app.process().stdout?.on('data', (d) => console.log('MAIN', String(d).trim()));
  app.process().stderr?.on('data', (d) => console.log('MAIN-ERR', String(d).trim()));
  await page.waitForSelector('.sidebar-session-row, .sidebar-project-row', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 3000));

  // The harbor-proof group only exists while a live workspace carries it
  // (proof sessions are empty and rightly hidden from history). Create it.
  execFileSync(path.join(APP_DIR, 'node_modules', '.bin', 'electron'),
    [APP_DIR, '--new-session', '--home=personal', '--cwd=' + PROOF_DIR],
    { timeout: 20000 });
  log('fired new-session trigger; waiting for live group');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const found = await page.evaluate(async () => {
      const st = await window.harbor.sidebar.getState();
      return (st?.model?.projects || []).some((p) => p.label === 'harbor-proof');
    });
    if (found) { log('live group present after', (i + 1) * 1.5, 's'); break; }
  }

  const opened = await page.evaluate(async () => {
    const st = await window.harbor.sidebar.getState();
    const proj = (st?.model?.projects || []).find((p) => p.label === 'harbor-proof');
    if (!proj || !window.__openOrchForTest) return { ok: false, projects: (st?.model?.projects || []).length };
    window.__openOrchForTest(proj);
    return { ok: true, sessions: (proj.sessions || []).length };
  });
  log('panel open:', JSON.stringify(opened));
  if (!opened.ok) { await app.close(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1500));

  await page.fill('textarea', 'List the files in this directory, write PROOF.md containing the list, and finish.');
  await page.locator('button', { hasText: /start research/i }).first().click();
  log('clicked start');

  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const daemon = execFileSync(HERDR_BIN, ['agent', 'list'], { encoding: 'utf8' });
    const hasTeam = fs.existsSync(CACHE_USAGE_TEAM);
    log(`t+${(i + 1) * 5}s agents-with-proof:`, (daemon.match(/harbor-proof/g) || []).length, 'team-tee:', hasTeam);
    if (hasTeam) break;
  }
  await page.screenshot({ path: path.join(OUT, '3b-research-pane.png') });
  await page.evaluate(() => { document.querySelector('.orch-close, button')?.click?.(); });
  await page.screenshot({ path: path.join(OUT, '3c-meters-after-team.png') });
  await app.close();

  // Cleanup: exit any claude in the proof workspace, then close it.
  try {
    const list = JSON.parse(execFileSync(HERDR_BIN, ['workspace', 'list'], { encoding: 'utf8' }));
    const ws = (list?.result?.workspaces || []).find((w) => w.label === 'harbor-proof');
    if (ws) {
      const panes = JSON.parse(execFileSync(HERDR_BIN, ['pane', 'list'], { encoding: 'utf8' }));
      for (const pane of panes?.result?.panes || []) {
        if (pane.workspace_id === ws.workspace_id) {
          try {
            execFileSync(HERDR_BIN, ['pane', 'send-text', pane.pane_id, '/exit']);
            execFileSync(HERDR_BIN, ['pane', 'send-keys', pane.pane_id, 'enter']);
          } catch {}
        }
      }
      await new Promise((r) => setTimeout(r, 5000));
      execFileSync(HERDR_BIN, ['workspace', 'close', ws.workspace_id]);
      log('cleanup: closed', ws.workspace_id);
    }
  } catch (e) { log('cleanup note:', e.message); }
  log('DONE');
})().catch((e) => { console.error('P3-FATAL', e.message); process.exit(2); });
