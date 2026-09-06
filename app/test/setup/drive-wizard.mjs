// Drives the first-run wizard end to end and screenshots every step.
//
// Run it through the wrapper, never directly:
//   node test/setup/run-drive.cjs [full|minimum|codex-only|all]
// which supplies xvfb and its own session bus. Both matter and neither is
// optional: an Electron window on the live display steals focus from whatever
// the user is doing, and Electron routes file dialogs through the desktop
// PORTAL over the session bus, which xvfb does not isolate, so a picker would
// open on the real desktop and block the main process until a human answered.
//
// Everything real about this machine is fenced off:
//   HOME                   a synthetic home with synthetic config homes
//   PATH                   a fake bin dir first, so detection is deterministic
//                          and never reports the real machine's binaries
//   HARBOR_CONFIG_FILE     a throwaway config the drive owns
//   HARBOR_E2E_USER_DATA   a throwaway profile, which also makes the isolation
//                          policies refuse real signals, launches and dialogs
//   HARBOR_CONTEXT_DIR     a throwaway statusline tee, so no real pid is even
//                          learnable
//   HARBOR_E2E_FAKE_DIALOG the answer the OS would have given the folder picker
//   HARBOR_NO_DAEMON_START the real Herdr daemon is never touched

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(APP_ROOT, 'verify', 'setup');

const failures = [];
let scenario = 'full';

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failures.push(`${scenario}: ${label}`);
  return ok;
}

// A synthetic machine: fake binaries so detection is deterministic, and only
// the config homes this scenario wants.
async function buildSandbox({ claudeHomes, extraHome, binaries }) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `harbor-wizard-${scenario}-`));
  const home = path.join(sandbox, 'home');
  const bin = path.join(sandbox, 'bin');
  await fs.mkdir(bin, { recursive: true });
  // Only the binaries this scenario wants exist, so what the wizard enables by
  // default is a property of the scenario and not of the real machine's PATH.
  for (const name of binaries) {
    const file = path.join(bin, name);
    await fs.writeFile(file, '#!/bin/sh\necho "0.7.4"\n');
    await fs.chmod(file, 0o755);
  }
  for (const [dir, email] of claudeHomes) {
    const target = path.join(home, dir);
    await fs.mkdir(path.join(target, 'commands'), { recursive: true });
    await fs.mkdir(path.join(target, 'skills', 'demo-skill'), { recursive: true });
    await fs.writeFile(
      path.join(target, '.claude.json'),
      JSON.stringify(email ? { oauthAccount: { emailAddress: email } } : { projects: {} }),
    );
    await fs.writeFile(path.join(target, 'commands', 'ship.md'), '---\ndescription: Ship the thing\n---\n');
    await fs.writeFile(path.join(target, 'skills', 'demo-skill', 'SKILL.md'), '---\ndescription: A demo skill\n---\n');
    await fs.writeFile(path.join(target, 'CLAUDE.md'), '# demo\n');
  }
  if (extraHome) {
    // Outside the three candidate names on purpose, so detection does not find
    // it and the only way it can reach the wizard is through Browse.
    await fs.mkdir(path.join(home, extraHome), { recursive: true });
    await fs.writeFile(
      path.join(home, extraHome, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'third@example.com' } }),
    );
  }
  if (scenario === 'codex-only') await fs.mkdir(path.join(home, '.codex'), { recursive: true });

  const configFile = path.join(sandbox, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({
    version: 1,
    setup: { completed: false, completedAt: null, appVersion: null },
    profiles: [{
      id: 'personal',
      label: 'Personal',
      letter: 'P',
      color: '#6fa8d8',
      provider: 'claude',
      configHome: path.join(home, '.claude'),
      email: null,
      isDefault: true,
    }],
  }, null, 2));
  return { sandbox, home, bin, configFile };
}

async function launch({ sandbox, home, bin, configFile, fakeDialog }) {
  // Inheriting process.env wholesale leaked the REAL machine into the sandbox:
  // this session exports HERDR_SOCKET_PATH, the linux adapter prefers it over
  // anything derived from HOME, and the wizard's socket field came up showing
  // the user's actual daemon socket. Scrub the whole family, the same way test
  // agents need CLAUDE/HERDR/ANTHROPIC scrubbed before they are launched.
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (/^(HERDR_|CLAUDE_|ANTHROPIC_)/.test(key)) delete inherited[key];
  }

  const app = await electron.launch({
    executablePath: (await import('electron')).default,
    args: [APP_ROOT],
    cwd: APP_ROOT,
    timeout: 120000,
    env: {
      ...inherited,
      HOME: home,
      // EXCLUSIVE on purpose. Appending the real PATH here let the machine's
      // own codex and cursor-agent be discovered, so a scenario that was
      // supposed to have neither silently enabled both and the drive proved
      // the wrong thing. Only the fake bin plus the system dirs Electron might
      // need for a helper.
      PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter),
      HARBOR_E2E: '1',
      HARBOR_E2E_USER_DATA: path.join(sandbox, 'userData'),
      HARBOR_CONFIG_FILE: configFile,
      HARBOR_CONTEXT_DIR: path.join(sandbox, 'context'),
      HARBOR_E2E_FAKE_DIALOG: fakeDialog || path.join(sandbox, 'unused'),
      HARBOR_E2E_FAKE_LAUNCH: '1',
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_NO_VOICE: '1',
      HARBOR_NO_USAGE_FETCH: '1',
      HARBOR_NO_MODEL_DISCOVERY: '1',
      ELECTRON_DISABLE_GPU: '1',
    },
  });
  const page = await app.firstWindow({ timeout: 120000 });
  await page.setViewportSize({ width: 1600, height: 1000 });
  return { app, page };
}

function tools(page) {
  return {
    shot: async (name) => {
      const file = path.join(SHOTS, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(`        shot: ${file}`);
    },
    blocked: () => page.locator('.setup-next').isDisabled(),
    stepIs: async (id) => (await page.locator(`.setup-shell[data-step="${id}"]`).count()) === 1,
    settle: (ms = 250) => page.waitForTimeout(ms),
  };
}

// ── the full three-plan path ────────────────────────────────────────────────
async function driveFull() {
  const box = await buildSandbox({
    claudeHomes: [['.claude', 'first@example.com'], ['.claude-team', null]],
    extraHome: 'third-plan',
    binaries: ['herdr', 'claude', 'codex', 'cursor-agent'],
  });
  const { app, page } = await launch({ ...box, fakeDialog: path.join(box.home, 'third-plan') });
  const { shot, blocked, stepIs, settle } = tools(page);
  const homeInput = (n) => page.locator('.setup-profile').nth(n).locator('input.mono').first();

  try {
    await page.waitForSelector('.setup-root', { timeout: 30000 });
    check('the wizard auto-opens on a config with setup.completed false', await stepIs('platform'));
    check('detection found herdr on the fake PATH', (await page.locator('.sf-detect[data-found="1"]').count()) > 0);
    await shot('01-platform');

    // FAILURE STATE 1: no herdr path.
    await page.fill('.setup-body input.mono >> nth=0', '');
    await settle();
    check('step 1 blocks Next with no herdr path', await blocked());
    await shot('01b-platform-blocked');
    await page.fill('.setup-body input.mono >> nth=0', path.join(box.bin, 'herdr'));
    await settle();
    check('step 1 re-enables Next once a path is given', !(await blocked()));
    await page.click('.setup-next');

    check('step 2 is the Claude plans step', await stepIs('claude'));
    check('both detected homes were seeded', (await page.locator('.setup-profile').count()) === 2);
    const email = await page.locator('.setup-account-email').first().innerText();
    check('the account email is read back from the picked home', email === 'first@example.com', email);
    check('a home with no oauthAccount is NOT claimed as signed in',
      (await page.locator('.setup-account[data-authed="0"]').count()) === 1);
    await shot('02-claude');

    // FAILURE STATE 2: a third plan with no config home.
    await page.click('.setup-add-profile');
    await settle();
    check('step 2 blocks Next on a plan with no config home', await blocked());
    await shot('02b-claude-blocked-empty');

    // Browse answers with a folder detection never offered, so this proves the
    // picker path is really reached rather than dead-ending silently.
    await page.locator('.setup-profile').nth(2).locator('.sf-browse').click();
    await settle(600);
    const picked = await homeInput(2).inputValue();
    check('Browse fills the config home from the picker', picked.endsWith('third-plan'), picked);
    check('a third plan with a real home clears the block', !(await blocked()));

    // FAILURE STATE 3: two plans on one config home.
    await homeInput(2).fill(path.join(box.home, '.claude'));
    await settle(400);
    check('step 2 blocks Next on a duplicate config home', await blocked());
    await shot('02c-claude-blocked-duplicate');
    await homeInput(2).fill(path.join(box.home, 'third-plan'));
    await settle(400);
    check('step 2 re-enables Next once the homes differ', !(await blocked()));
    check('the seeded badges are P, T, S by index',
      (await page.locator('.setup-badge').allInnerTexts()).join('') === 'PTS');
    await shot('02d-claude-three-plans');
    await page.click('.setup-next');

    check('step 3 is the providers step', await stepIs('providers'));
    // Both binaries are on the fake PATH, so both arrive enabled with their
    // conventional homes pre-filled, and the step opens usable.
    check('a detected Codex is on with its home pre-filled',
      (await page.locator('.sf-switch[data-name="codex"][data-on="1"]').count()) === 1);
    check('a detected Cursor is on too',
      (await page.locator('.sf-switch[data-name="cursor"][data-on="1"]').count()) === 1);
    check('step 3 opens valid rather than blocked on an empty required field', !(await blocked()));

    // FAILURE STATE: clear the enabled Codex account's home.
    const codexHome = page.locator('[data-provider="codex"] input.mono').nth(1);
    const codexHomeValue = await codexHome.inputValue();
    await codexHome.fill('');
    await settle(300);
    check('an enabled Codex with no home blocks Next', await blocked());
    await shot('03b-providers-blocked');
    await codexHome.fill(codexHomeValue);
    await settle(300);
    check('restoring the Codex home clears the block', !(await blocked()));
    await shot('03-providers');
    await page.click('.setup-next');

    check('step 4 is the catalog step', await stepIs('catalog'));
    await settle(900);
    const rows = await page.locator('.setup-cat-row').count();
    check('the catalogue lists the REAL commands from the picked homes', rows > 0, `${rows} rows`);
    await page.fill('.setup-card input[aria-label="Search commands"]', 'ship');
    await settle(300);
    check('typeahead finds the user’s own command',
      (await page.locator('.setup-cat-name', { hasText: '/ship' }).count()) > 0);
    await page.locator('.setup-cat-row').first().click();
    await settle(300);
    check('picking a command adds it as a quick command',
      (await page.locator('.setup-subcard').count()) > 0);

    // FAILURE STATE 4: a quick command with no command text.
    await page.locator('.setup-subcard input.mono').last().fill('');
    await settle(300);
    check('step 4 blocks Next on a quick command with no command', await blocked());
    await shot('04b-catalog-blocked');
    await page.locator('.setup-subcard input.mono').last().fill('/ship');
    await settle(300);
    check('restoring the command clears the block', !(await blocked()));
    await shot('04-catalog');
    await page.click('.setup-next');

    check('step 5 is the shared-config step', await stepIs('symlinks'));
    check('sharing is OFF by default',
      (await page.locator('.sf-switch[data-name="symlinks"][data-on="1"]').count()) === 0);
    check('step 5 passes while sharing is off', !(await blocked()));
    const never = await page.locator('.setup-list.never code').allInnerTexts();
    check('the never-shared split is stated on screen',
      never.includes('.credentials.json') && never.includes('.claude.json'), never.join(' '));

    // FAILURE STATE 5: sharing on with every target unchecked.
    await page.click('.sf-switch[data-name="symlinks"]');
    await settle(500);
    const boxes = page.locator('.setup-radio input[type="checkbox"]');
    for (let i = 0; i < await boxes.count(); i += 1) await boxes.nth(i).uncheck();
    await settle(400);
    check('sharing on with nothing to share into blocks Next', await blocked());
    await shot('05b-symlinks-blocked');
    await boxes.first().check();
    await settle(900);
    check('choosing a target re-enables Next', !(await blocked()));
    check('the plan says exactly what will happen before anything is applied',
      (await page.locator('.setup-plan-list li').count()) > 0);
    await shot('05-symlinks');
    await page.click('.setup-next');

    check('step 6 is the orchestration step', await stepIs('orchestration'));
    check('orchestration is OFF by default and passes', !(await blocked()));

    // FAILURE STATE 6: enabled with the launcher cleared, then a command with
    // no slash. Enabling alone does not block, because the field is pre-filled
    // with the conventional launcher path the same way the codex home is.
    await page.click('.sf-switch[data-name="orchestration"]');
    await settle(400);
    check('enabling orchestration pre-fills the launcher rather than blocking', !(await blocked()));
    await page.locator('.sf.wide input.mono').first().fill('');
    await settle(300);
    check('clearing the launcher blocks Next', await blocked());
    await shot('06b-orch-blocked');
    await page.locator('.sf.wide input.mono').first().fill(path.join(box.bin, 'claude-go'));
    await settle(300);
    check('a launcher path re-enables Next', !(await blocked()));
    await page.locator('.setup-grid input.mono').first().fill('orchestrate-research');
    await settle(300);
    check('a command without a leading slash blocks Next', await blocked());
    await shot('06c-orch-blocked-slash');
    await page.locator('.setup-grid input.mono').first().fill('/orchestrate-research');
    await settle(300);
    check('restoring the slash clears the block', !(await blocked()));
    await shot('06-orchestration');
    await page.click('.setup-next');

    check('step 7 is the defaults step', await stepIs('defaults'));
    await settle(1200);
    const review = await page.locator('.setup-json').innerText();
    check('the review shows the exact config that will be written', review.includes('"setup"'), `${review.length} chars`);
    check('the review carries no credential-shaped key',
      !/api[-_]?key|secret|token|password|credential/i.test(review));
    await shot('07-defaults-review');

    // FAILURE STATE 7: break an EARLIER step and prove Finish is not reachable.
    await page.click('.setup-step[data-step="platform"]');
    await settle(300);
    await page.fill('.setup-body input.mono >> nth=0', '');
    await settle(300);
    await page.click('.setup-step[data-step="defaults"]');
    await settle(400);
    check('jumping forward past a broken earlier step is refused', await stepIs('platform'));
    await shot('07b-finish-blocked');
    await page.fill('.setup-body input.mono >> nth=0', path.join(box.bin, 'herdr'));
    await settle(300);
    await page.click('.setup-step[data-step="defaults"]');
    await settle(800);
    check('fixing it lets the wizard reach the last step again', await stepIs('defaults'));
    check('Finish is enabled', !(await page.locator('.setup-finish').isDisabled()));

    await page.click('.setup-finish');
    await page.waitForTimeout(3000);
    const written = JSON.parse(await fs.readFile(box.configFile, 'utf8'));
    check('setup.completed is now true on disk', written.setup.completed === true);
    check('the completion is stamped', Boolean(written.setup.completedAt));
    check('three Claude plans were written',
      written.profiles.filter((p) => p.provider === 'claude').length === 3);
    check('the Codex account was written as a profile',
      written.profiles.some((p) => p.provider === 'codex'));
    check('the Cursor account was written as a profile',
      written.profiles.some((p) => p.provider === 'cursor'));
    check('exactly one profile is the default',
      written.profiles.filter((p) => p.isDefault).length === 1);
    check('the picked quick command was written', written.workflows.length === 1,
      JSON.stringify(written.workflows.map((w) => w.command)));
    check('orchestration was enabled as chosen', written.orchestration.enabled === true);
    check('no credential reached the config file',
      !/api[-_]?key|secret|token|password|credential/i.test(JSON.stringify(written)));
    await fs.writeFile(path.join(SHOTS, 'config-full-three-plan.json'), JSON.stringify(written, null, 2));
    console.log(`        config: ${path.join(SHOTS, 'config-full-three-plan.json')}`);

    // The app boots into a correct state from what was just written.
    await page.waitForTimeout(2000);
    check('after finishing, the wizard does NOT re-open on its own',
      (await page.locator('.setup-root').count()) === 0);
    check('the app itself is up behind it', (await page.locator('.rail').count()) === 1);
    await shot('08-app-after-setup');

    // Re-openable from the app menu, for the life of the install. Driven
    // through the REAL menu item, not a synthetic IPC send: sending the channel
    // directly would prove the listener works while a missing or mislabelled
    // menu entry left the user with no way to reach it.
    const menu = await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((top) => top.submenu?.items || [])
        .find((entry) => /setup/i.test(entry.label || ''));
      if (!item) return { found: false };
      item.click();
      return { found: true, label: item.label };
    });
    check('the application menu carries a Setup item', menu.found, menu.label || 'not found');
    await page.waitForSelector('.setup-root', { timeout: 10000 });
    check('the app menu re-opens the wizard on a completed install', await stepIs('platform'));
    check('a re-opened wizard can be closed without saving',
      (await page.locator('.setup-dismiss').count()) === 1);
    // MEASURED, not eyeballed: the re-opened wizard must wear the same Slate
    // material as the first run. A screenshot showed the primary button reading
    // light rather than accent-blue, and the only way to know whether that is a
    // real regression is to read the computed style.
    const btn = await page.evaluate(() => {
      const el = document.querySelector('.setup-next');
      const s = getComputedStyle(el);
      const root = getComputedStyle(document.documentElement);
      return {
        image: s.backgroundImage,
        bg: s.backgroundColor,
        color: s.color,
        accent: root.getPropertyValue('--ac').trim(),
        accent2: root.getPropertyValue('--ac2').trim(),
        cls: el.className,
      };
    });
    check('the primary button still wears the accent gradient after a re-open',
      btn.image.includes('gradient') && btn.accent === '#437ffe', JSON.stringify(btn));
    await shot('09-reopened-from-menu');
  } catch (error) {
    failures.push(`${scenario}: drive threw: ${error.message}`);
    console.error(error);
    await page.screenshot({ path: path.join(SHOTS, `error-${scenario}.png`) }).catch(() => {});
  } finally {
    await app.close({ force: true }).catch(() => {});
    try { app.process()?.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

// ── the minimum path: one Claude account, nothing else ──────────────────────
async function driveMinimum() {
  // Only herdr and claude exist here, so nothing else can be enabled by
  // detection and "one account, nothing else" is really what gets driven.
  const box = await buildSandbox({
    claudeHomes: [['.claude', 'only@example.com']],
    binaries: ['herdr', 'claude'],
  });
  const { app, page } = await launch(box);
  const { shot, blocked, stepIs, settle } = tools(page);
  try {
    await page.waitForSelector('.setup-root', { timeout: 30000 });
    check('the one detected home was seeded', (await page.locator('.setup-profile').count()) <= 1);
    for (const step of ['platform', 'claude', 'providers', 'catalog', 'symlinks', 'orchestration']) {
      check(`${step} accepts the minimum answer`, (await stepIs(step)) && !(await blocked()));
      if (step === 'symlinks') {
        check('with one plan there is nothing to share, and the step says so',
          (await page.locator('.setup-pane').innerText()).includes('at least two Claude plans'));
        await shot('min-05-symlinks-single-plan');
      }
      await page.click('.setup-next');
      await settle(300);
    }
    check('the last step is reachable with the minimum answer', await stepIs('defaults'));
    await settle(1200);
    await shot('min-07-defaults-review');
    check('Finish is enabled on the minimum path', !(await page.locator('.setup-finish').isDisabled()));
    await page.click('.setup-finish');
    await page.waitForTimeout(3000);

    const written = JSON.parse(await fs.readFile(box.configFile, 'utf8'));
    check('the minimum path wrote a completed config', written.setup.completed === true);
    check('exactly one profile', written.profiles.length === 1, JSON.stringify(written.profiles.map((p) => p.id)));
    check('codex and cursor are off', !written.providers.codex.enabled && !written.providers.cursor.enabled);
    check('orchestration is off', written.orchestration.enabled === false);
    check('no quick commands were invented', written.workflows.length === 0);
    await fs.writeFile(path.join(SHOTS, 'config-minimum.json'), JSON.stringify(written, null, 2));
    console.log(`        config: ${path.join(SHOTS, 'config-minimum.json')}`);
    await page.waitForTimeout(1500);
    await shot('min-08-app-after-setup');
  } catch (error) {
    failures.push(`${scenario}: drive threw: ${error.message}`);
    console.error(error);
    await page.screenshot({ path: path.join(SHOTS, `error-${scenario}.png`) }).catch(() => {});
  } finally {
    await app.close({ force: true }).catch(() => {});
    try { app.process()?.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

// ── the zero-Claude path: codex only ────────────────────────────────────────
async function driveCodexOnly() {
  // No claude binary and no claude home at all: the zero-Claude shape.
  const box = await buildSandbox({ claudeHomes: [], binaries: ['herdr', 'codex'] });
  const { app, page } = await launch(box);
  const { shot, blocked, stepIs, settle } = tools(page);
  try {
    await page.waitForSelector('.setup-root', { timeout: 30000 });
    check('the wizard opens with no Claude home on the machine', await stepIs('platform'));
    check('step 1 passes on the detected herdr', !(await blocked()));
    await page.click('.setup-next');

    check('step 2 offers zero Claude plans and does not demand one',
      (await stepIs('claude')) && (await page.locator('.setup-profile').count()) === 0 && !(await blocked()));
    await shot('codex-02-claude-empty');
    await page.click('.setup-next');

    // THE FLOOR: with zero Claude plans, turning the only other provider off
    // leaves no account at all, and that is the one place setup refuses.
    check('step 3 starts valid because Codex was detected', !(await blocked()));
    await page.click('.sf-switch[data-name="codex"]');
    await settle(500);
    check('step 3 blocks Next with zero accounts anywhere', await blocked());
    check('and says exactly why',
      (await page.locator('.setup-error').innerText()).includes('at least one account'));
    await shot('codex-03b-zero-accounts-blocked');

    await page.click('.sf-switch[data-name="codex"]');
    await settle(500);
    check('re-enabling Codex alone clears the floor', !(await blocked()));
    await shot('codex-03-providers');
    await page.click('.setup-next');

    for (const step of ['catalog', 'symlinks', 'orchestration']) {
      check(`${step} passes with no Claude home`, (await stepIs(step)) && !(await blocked()));
      await page.click('.setup-next');
      await settle(300);
    }
    check('the defaults step re-points itself at Codex', await stepIs('defaults'));
    await settle(1200);
    const provider = await page.locator('.sf-seg-btn[data-active="1"]').first().innerText();
    check('the default provider followed the accounts that exist', provider === 'Codex', provider);
    await shot('codex-07-defaults-review');
    check('Finish is enabled on the codex-only path', !(await page.locator('.setup-finish').isDisabled()));
    await page.click('.setup-finish');
    await page.waitForTimeout(3000);

    const written = JSON.parse(await fs.readFile(box.configFile, 'utf8'));
    check('the codex-only path wrote a completed config', written.setup.completed === true);
    check('the schema-required profile list is a CODEX profile', written.profiles.length === 1
      && written.profiles[0].provider === 'codex', JSON.stringify(written.profiles));
    check('claude is disabled', written.providers.claude.enabled === false);
    check('new sessions default to codex', written.newSessionDefaults.provider === 'codex');
    await fs.writeFile(path.join(SHOTS, 'config-codex-only.json'), JSON.stringify(written, null, 2));
    console.log(`        config: ${path.join(SHOTS, 'config-codex-only.json')}`);
    await page.waitForTimeout(1500);
    await shot('codex-08-app-after-setup');
  } catch (error) {
    failures.push(`${scenario}: drive threw: ${error.message}`);
    console.error(error);
    await page.screenshot({ path: path.join(SHOTS, `error-${scenario}.png`) }).catch(() => {});
  } finally {
    await app.close({ force: true }).catch(() => {});
    try { app.process()?.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

const RUNS = { full: driveFull, minimum: driveMinimum, 'codex-only': driveCodexOnly };

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const requested = process.argv[2] || 'all';
  const names = requested === 'all' ? Object.keys(RUNS) : [requested];
  for (const name of names) {
    if (!RUNS[name]) throw new Error(`unknown scenario: ${name}`);
    scenario = name;
    console.log(`\n=== ${name} ===`);
    await RUNS[name]();
  }
  console.log(`\n${failures.length ? `FAILED (${failures.length}):\n  ${failures.join('\n  ')}` : 'ALL CHECKS PASSED'}`);
  process.exit(failures.length ? 1 : 0);
}

main();
