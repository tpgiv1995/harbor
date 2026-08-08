'use strict';
/*
 * Batch-13 cold-start drive: a new user's first five minutes.
 *
 * Launches a FRESH CLONE against a THROWAWAY HOME that has no Harbor config,
 * no ~/.cache/harbor and (by default) no ~/.claude, then walks the seven-step
 * first-run wizard and screenshots every screen.
 *
 * Safety, because this runs on Pat's live machine:
 *   - HOME is the throwaway, so userData, the config file, the herdr dir and
 *     the caches all move with it (and resolveUnitPolicy now refuses to manage
 *     the real systemd unit from a relocated HOME).
 *   - HARBOR_NO_DAEMON_START=1: never start or recover the real herdr daemon.
 *   - HARBOR_CONTEXT_DIR under the throwaway HOME: the takeover owner lookup
 *     can never learn a real pid, so no real session can be signalled.
 *   - The caller wraps this in `env -u DISPLAY -u WAYLAND_DISPLAY xvfb-run -a`
 *     AND `dbus-run-session`, because the wizard has a folder picker and a
 *     portal call would otherwise draw on Pat's real desktop.
 *
 * Usage: node cold-start-drive.js <repoRoot> <fakeHome> <shotDir> [--with-account]
 */
const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const [, , REPO, HOME_DIR, SHOTS, ...flags] = process.argv;
if (!REPO || !HOME_DIR || !SHOTS) {
  console.error('usage: cold-start-drive.js <repoRoot> <fakeHome> <shotDir> [--with-account]');
  process.exit(2);
}
const WITH_ACCOUNT = flags.includes('--with-account');
const APP_ROOT = path.join(REPO, 'app');
fs.mkdirSync(SHOTS, { recursive: true });

const log = [];
const say = (msg) => { console.log(msg); log.push(msg); };
let shotNum = 0;
async function shot(page, label) {
  shotNum += 1;
  const file = path.join(SHOTS, `${String(shotNum).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: file }).catch((e) => say(`  screenshot failed: ${e.message}`));
  say(`  [shot] ${file}`);
  return file;
}

// What the wizard shows right now: step id, title, whether Next is enabled,
// and any field-level errors it is refusing to advance past.
async function readStep(page) {
  return page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const active = document.querySelector('.setup-step.is-active, .setup-step[aria-current="step"]');
    const nextBtn = document.querySelector('.setup-next');
    const finishBtn = document.querySelector('.setup-finish');
    return {
      title: text('.setup-title'),
      subtitle: text('.setup-sub'),
      activeRailStep: active?.textContent?.trim() || null,
      steps: [...document.querySelectorAll('.setup-step')].map((n) => n.textContent.trim()),
      nextLabel: nextBtn?.textContent?.trim() || null,
      nextDisabled: nextBtn ? nextBtn.disabled === true : null,
      finishPresent: Boolean(finishBtn),
      finishDisabled: finishBtn ? finishBtn.disabled === true : null,
      errors: [...document.querySelectorAll('.setup-error')].map((n) => n.textContent.trim()),
      footMsg: text('.setup-foot-msg'),
      bodyText: text('.setup-body')?.slice(0, 400) || null,
    };
  });
}

(async () => {
  const env = {
    ...process.env,
    HOME: HOME_DIR,
    XDG_CONFIG_HOME: path.join(HOME_DIR, '.config'),
    XDG_CACHE_HOME: path.join(HOME_DIR, '.cache'),
    XDG_DATA_HOME: path.join(HOME_DIR, '.local', 'share'),
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_CONTEXT_DIR: path.join(HOME_DIR, '.cache', 'harbor', 'context'),
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_VOICE: '1',
    HARBOR_NO_TITLER: '1',
    ELECTRON_DISABLE_GPU: '1',
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.HARBOR_CONFIG_FILE;
  delete env.HERDR_PANE_ID;

  say(`cold start: repo=${REPO}`);
  say(`cold start: HOME=${HOME_DIR} (with-account=${WITH_ACCOUNT})`);
  say(`cold start: HOME contents before launch: ${fs.readdirSync(HOME_DIR).join(', ') || '(empty)'}`);

  const app = await electron.launch({
    executablePath: require(path.join(APP_ROOT, 'node_modules', 'electron')),
    args: [APP_ROOT],
    env,
    cwd: APP_ROOT,
    timeout: 180000,
  });
  const proc = app.process();
  proc.stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`));
  proc.stderr?.on('data', (d) => process.stdout.write(`[main-err] ${d}`));

  const page = await app.firstWindow({ timeout: 180000 });
  await page.waitForLoadState('domcontentloaded');
  say('window opened');

  // The wizard is the whole point: it must appear on its own on a cold HOME.
  let wizardAppeared = true;
  try {
    await page.waitForSelector('.setup-root', { timeout: 60000 });
  } catch {
    wizardAppeared = false;
  }
  say(`FINDING: wizard auto-opened on a cold HOME: ${wizardAppeared}`);
  await shot(page, wizardAppeared ? 'wizard-opened' : 'NO-WIZARD');

  if (!wizardAppeared) {
    const state = await page.evaluate(async () => {
      try { return await window.harbor.setup.state(); } catch (e) { return { error: String(e) }; }
    });
    say(`setup.state() said: ${JSON.stringify(state)}`);
    await app.close({ force: true }).catch(() => {});
    fs.writeFileSync(path.join(SHOTS, 'drive-log.txt'), log.join('\n'));
    process.exit(1);
  }

  // Walk every step. Never force past a refusal: a blocked Next is a FINDING,
  // which is the whole point of driving this rather than reading the code.
  const visited = [];
  for (let i = 0; i < 12; i += 1) {
    const step = await readStep(page);
    visited.push(step);
    say(`step ${i + 1}: "${step.title}" next=${step.nextLabel} disabled=${step.nextDisabled} finish=${step.finishPresent} errors=${JSON.stringify(step.errors)}`);
    await shot(page, `step-${i + 1}-${(step.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);

    if (step.finishPresent && !step.finishDisabled) {
      say('  clicking Finish');
      await page.click('.setup-finish');
      break;
    }
    if (step.nextDisabled) {
      say(`  BLOCKED at "${step.title}": ${JSON.stringify(step.errors)}`);
      break;
    }
    if (!step.nextLabel) {
      say('  no Next control found; stopping');
      break;
    }
    await page.click('.setup-next');
    await page.waitForTimeout(700);
  }

  await page.waitForTimeout(3000);
  await shot(page, 'after-wizard');

  const after = await page.evaluate(async () => {
    let state = null;
    try { state = await window.harbor.setup.state(); } catch (e) { state = { error: String(e) }; }
    return {
      setupState: state,
      railPresent: Boolean(document.querySelector('.rail')),
      wizardStillOpen: Boolean(document.querySelector('.setup-root')),
    };
  });
  say(`after wizard: ${JSON.stringify(after)}`);

  const cfg = path.join(HOME_DIR, '.config', 'Harbor', 'config.json');
  const cfgAlt = path.join(HOME_DIR, '.config', 'harbor', 'config.json');
  for (const p of [cfg, cfgAlt]) {
    if (fs.existsSync(p)) say(`config written: ${p}\n${fs.readFileSync(p, 'utf8').slice(0, 1500)}`);
  }
  say(`HOME contents after: ${fs.readdirSync(HOME_DIR).join(', ')}`);

  await app.close({ force: true }).catch(() => {});
  fs.writeFileSync(path.join(SHOTS, 'drive-log.txt'), log.join('\n'));
  say(`drive log: ${path.join(SHOTS, 'drive-log.txt')}`);
  process.exit(0);
})().catch(async (error) => {
  say(`DRIVE FAILED: ${error.message}`);
  fs.writeFileSync(path.join(SHOTS, 'drive-log.txt'), log.join('\n'));
  process.exit(1);
});
