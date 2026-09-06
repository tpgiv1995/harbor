#!/usr/bin/env node
'use strict';

// THE PUBLISHED DESKTOP SCREENSHOTS, from FIXTURE data rather than the real corpus.
//
// The end-to-end gate already takes screenshots, and not one of them can be
// published: it drives the real `~/.claude/projects`, so every capture carries
// real project names, real client names and, in at least one case, real PHI.
// This script builds the synthetic corpus in scripts/lib/demo-corpus.cjs, points
// a fully isolated Harbor at it (its own config, caches, session store, daemon
// and HOME), drives the four views, and captures them. Nothing it renders exists
// outside the run.
//
//   env -u DISPLAY -u WAYLAND_DISPLAY node scripts/capture-screenshot.js
//
// Writes docs/screenshot.png plus docs/screenshots/*.png. Runs under xvfb by
// default, on purpose: a window that opens on the real desktop steals focus
// from whatever is there. HARBOR_SHOT_HEADED=1 is the only way to watch it.
//
// WHY THE PICTURES LOOK LIKE THIS, which is a requirement and not a preference:
//
// - EVERY PROVIDER IS ON THE STAGE. The first four windows opened are claude,
//   codex, cursor, claude, because a picture of a stage full of one vendor's
//   sessions describes a different product from the one this is. The corpus
//   plants real codex rollouts and cursor transcripts in the fixture HOME and
//   the real scanners find them; nothing here fakes a provider row.
// - CAPTURED AT 2x, VIA THE WINDOW AND NEVER VIA THE VIEWPORT.
//   --force-device-scale-factor=2 gives a 1600x1000 layout a 3200x2000 backing
//   store, which is what makes README text sharp. `page.setViewportSize()`
//   SILENTLY UNDOES IT: on Electron it goes through the CDP emulation override,
//   which resets devicePixelRatio to 1 (measured: dpr 2 before the call, 1
//   after, and the screenshot halves from 1600x1000 to 800x500 on a 400x300
//   window). Resize the BrowserWindow instead. The xvfb screen also has to
//   exceed the backing store, or the window is clipped to the screen.
// - NO ABSOLUTE PATH MAY BE VISIBLE. The corpus lives at a root with no
//   username in it, and `assertNoIdentity` fails the run if the real home or
//   user name reaches the rendered text of any shot. The first multi-provider
//   capture put the author's checkout path into three conversation windows and
//   across the top of the Orch panel.
//
// Every capture must still be LOOKED AT before it is published. A grep cannot
// read a PNG, which is how a screenshot carrying a real employer department and
// a real internal project name survived every text sweep and shipped. The guard
// above narrows what a human has to catch; it does not replace them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  prepareRoot, buildCorpus, buildVideoArtifacts, buildConfig, seedTasks, seedUsage, DEFAULT_ROOT,
} = require('./lib/demo-corpus.cjs');
const { renderHtmlToPng } = require('./lib/render-html.cjs');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const OUT = path.join(REPO_ROOT, 'docs', 'screenshot.png');
const SHOT_DIR = path.join(REPO_ROOT, 'docs', 'screenshots');
const LAYOUT = { width: 1600, height: 1000 };
const SCALE = 2;
// GitHub renders a README image into an 880px column, so 1760 is exactly 2x
// what a retina reader sees and every pixel past it is weight nobody looks at.
// Rendering at 3200 and coming down to 1760 supersamples: the text is sharper
// than a native 1760 render, and the file is a third of the size of the 3200.
// PNG on purpose. WebP would be a quarter of the bytes at the same quality,
// and GitHub's supported-image list does not include it, so the one thing it
// buys is a README with holes in it.
const PRESENT_WIDTH = 1760;

// Re-exec under a scrubbed X server unless we are already inside one, or the
// caller has explicitly asked to watch it. The screen must exceed the 2x
// backing store (3200x2000) or the window is clipped to the screen instead.
if (!process.env.HARBOR_SHOT_INNER && !process.env.HARBOR_SHOT_HEADED) {
  const result = spawnSync(
    'env',
    ['-u', 'DISPLAY', '-u', 'WAYLAND_DISPLAY', 'xvfb-run', '-a',
      `--server-args=-screen 0 ${LAYOUT.width * SCALE + 200}x${LAYOUT.height * SCALE + 200}x24`,
      process.execPath, __filename],
    { stdio: 'inherit', env: { ...process.env, HARBOR_SHOT_INNER: '1' }, cwd: APP_ROOT },
  );
  process.exit(result.status ?? 1);
}

// A published screenshot may not contain the person who took it. The corpus is
// built somewhere anonymous precisely so this can be a hard gate rather than an
// intention, and it reads the RENDERED text, which is the thing a PNG carries.
//
// KNOWN BLIND SPOT, stated so the next person does not mistake this for total
// coverage: it reads `innerText`, and xterm.js draws to a CANVAS. Nothing in a
// `>_` terminal view would be seen here. No capture opens one today; anything
// that does needs its own check (read the pane's text through the terminal
// bridge, not the DOM) before it may be published.
const REAL_HOME = os.homedir();
const REAL_USER = (() => {
  try { return os.userInfo().username; } catch { return path.basename(REAL_HOME); }
})();

async function assertNoIdentity(page, label) {
  const text = await page.evaluate(() => document.body.innerText || '');
  const needles = [REAL_HOME, REAL_USER].filter((needle) => needle && needle.length > 2);
  for (const needle of needles) {
    if (!text.includes(needle)) continue;
    const line = text.split('\n').find((candidate) => candidate.includes(needle)) || '';
    throw new Error(
      `${label}: rendered text contains '${needle}', which would publish the author's identity. `
      + `Offending line: ${line.trim().slice(0, 200)}`,
    );
  }
}

// Down to the presentation width, in place. ffmpeg is the one image tool this
// machine class can rely on; without it the files stay at 3200 wide, which is
// heavy but never broken, so a missing binary degrades rather than fails.
//
// Every shot is taken into a STAGING directory and only published to docs/ once
// the whole run has succeeded and been scaled. A run that fails part way used to
// leave the gallery mixed: the shots taken before the failure were already in
// docs/ at the raw 3200px capture size, because the scaling step never ran.
// Caught by deliberately tripping the identity guard, which is exactly the kind
// of failure this has to survive.
function present(files) {
  for (const file of files) {
    const temp = `${file}.scaled.png`;
    const result = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', file,
      '-vf', `scale=${PRESENT_WIDTH}:-1:flags=lanczos`,
      '-compression_level', '100', temp,
    ]);
    if (result.status === 0 && fs.existsSync(temp)) {
      fs.renameSync(temp, file);
      process.stdout.write(`scaled ${path.basename(file)} to ${PRESENT_WIDTH}px (${Math.round(fs.statSync(file).size / 1024)}KB)\n`);
    } else {
      fs.rmSync(temp, { force: true });
      process.stdout.write(`left ${path.basename(file)} at full size (ffmpeg: ${result.error?.code || result.status})\n`);
    }
  }
}

async function main() {
  const { _electron: electron } = require('@playwright/test');
  // NOT os.tmpdir() and NOT under the checkout: a cwd under a temp root is a
  // scratch session the rail hides by design, and a cwd under the checkout
  // carries the author's home directory into every rendered path. See the
  // header of scripts/lib/demo-corpus.cjs.
  const root = prepareRoot(process.env.HARBOR_SHOT_ROOT || DEFAULT_ROOT);

  const userData = path.join(root, 'userData');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const corpus = buildCorpus(root);
  const { projectsDir, home, sessions } = corpus;
  const configFile = path.join(userData, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(
    buildConfig(root, { projectsDir, home, cacheDir, userData }), null, 2,
  ));
  seedTasks(REPO_ROOT, path.join(root, 'tasks.json'));
  seedUsage(cacheDir);
  await buildVideoArtifacts(sessions, { renderHtmlToPng });

  // Its own daemon, in its own directory, so the shot shows a connected app and
  // still cannot touch the real session store.
  const daemon = require('node:child_process').spawn(
    process.execPath,
    [path.join(APP_ROOT, 'src', 'daemon', 'daemon.js')],
    {
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
        HARBOR_SESSIOND_SOCKET: path.join(root, 'sessiond', 'sessiond.sock'),
      },
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [APP_ROOT, `--user-data-dir=${userData}`, `--force-device-scale-factor=${SCALE}`],
    cwd: APP_ROOT,
    timeout: 120000,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      HARBOR_E2E: '1',
      HARBOR_E2E_FAKE_LAUNCH: '1',
      HARBOR_E2E_USER_DATA: userData,
      // The answer the OS folder picker would have given, so the rail head's
      // +P reaches the configuration form without a portal call.
      HARBOR_E2E_FAKE_DIALOG: path.join(home, 'demo', 'harbor'),
      HARBOR_CONFIG_FILE: configFile,
      HARBOR_CONTEXT_DIR: path.join(root, 'context'),
      // ROOTS ARE TRANSCRIPT ROOTS. Pointing this at the directory holding the
      // artifact FILES finds no *.jsonl at all, so the Files view was honestly
      // empty and this script skipped its own screenshot for weeks.
      HARBOR_ARTIFACTS_ROOTS: projectsDir,
      HARBOR_ARTIFACTS_CACHE: path.join(cacheDir, 'artifacts-index.json'),
      HARBOR_ARTIFACT_THUMBS_DIR: path.join(cacheDir, 'thumbs'),
      HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
      HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
      HARBOR_SESSIOND_SOCKET: path.join(root, 'sessiond', 'sessiond.sock'),
      HARBOR_DELEGATE_STATE_DIR: path.join(root, 'delegate'),
      HARBOR_NO_USAGE_FETCH: '1',
      HARBOR_NO_MODEL_DISCOVERY: '1',
      HARBOR_NO_TITLER: '1',
      HARBOR_NO_VOICE: '1',
      ELECTRON_DISABLE_GPU: '1',
    },
  });

  try {
    const page = await app.firstWindow({ timeout: 120000 });
    await page.waitForSelector('.rail', { timeout: 60000 });
    // Resize the WINDOW, never the viewport: setViewportSize goes through the
    // emulation override and takes the 2x backing store with it (see header).
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(size.width, size.height);
    }, LAYOUT);
    await page.waitForTimeout(600);
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    if (dpr !== SCALE) {
      throw new Error(`expected a ${SCALE}x backing store, got devicePixelRatio ${dpr}; the README images would ship soft`);
    }
    // The index scans the fixture corpus cold, so wait for rail ROWS rather
    // than for a fixed delay: a screenshot taken before they land shows an
    // empty rail, which is the app's signature surface missing from its own
    // picture.
    await page.locator('[data-filter="all"]').click().catch(() => {});
    await page.waitForSelector('.sr', { timeout: 45000 }).catch(() => {});
    // Codex and cursor rows arrive from a second scanner (provider-history),
    // so wait for the rail to hold as many rows as the corpus has sessions
    // rather than for the first one.
    await page.waitForFunction(
      (want) => document.querySelectorAll('.sr').length >= want,
      sessions.length,
      { timeout: 45000 },
    ).catch(() => {});
    await page.waitForTimeout(1200);
    // Expand the project groups so the rail shows sessions, not just headings.
    for (const handle of await page.locator('.sidebar-project-wrap .pg-label').all()) {
      await handle.click().catch(() => {});
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(800);

    const railRows = await page.locator('.sr').count();
    process.stdout.write(`rail rows: ${railRows} (corpus sessions: ${sessions.length})\n`);
    if (railRows < sessions.length) {
      throw new Error(
        `the rail listed ${railRows} of ${sessions.length} sessions; the codex and cursor rows come from a`
        + ' second scanner (provider-history) and a picture missing them is the single-vendor stage this'
        + ' capture exists to replace',
      );
    }

    const stage = path.join(root, 'shots');
    fs.mkdirSync(stage, { recursive: true });
    // name -> where it is published once the whole run succeeds.
    const publish = new Map();
    const written = [];
    const shot = async (name, target) => {
      await assertNoIdentity(page, name);
      const file = path.join(stage, `${name}.png`);
      await (target || page).screenshot({ path: file });
      written.push(file);
      publish.set(file, path.join(SHOT_DIR, `${name}.png`));
      process.stdout.write(`took ${name}.png\n`);
    };
    const openSession = async (id) => {
      await page.evaluate((sessionId) => window.__harborOpenSession(sessionId), id);
      await page.waitForTimeout(1200);
    };

    // 1. The stage: four conversation windows in a 2x2, and deliberately NOT
    //    four of the same provider. This is docs/screenshot.png, which the
    //    README embeds.
    for (const { id } of sessions.slice(0, 4)) await openSession(id);
    await page.waitForTimeout(2500);
    // THE ONE REQUIREMENT THIS PICTURE EXISTS FOR, asserted rather than hoped
    // for. The stage shot that shipped before this one held four windows and
    // every single one was Claude, which is a picture of a different product.
    // If a provider scanner ever goes quiet again, this fails loudly instead of
    // publishing a single-vendor stage that looks fine.
    const onStage = await page.evaluate(() => document.body.innerText || '');
    const missing = ['CLAUDE', 'CODEX', 'CURSOR'].filter((who) => !onStage.toUpperCase().includes(who));
    if (missing.length) {
      throw new Error(`the stage does not show ${missing.join(' or ')}; a single-vendor stage is exactly what this capture replaced`);
    }
    await shot('stage');
    // docs/screenshot.png is what the README embeds; it is the same picture.
    publish.set(path.join(stage, 'stage.png'), OUT);

    // 2. The adaptive grid. Opening the rest of the corpus moves the stage from
    //    a 2x2 to a 3x2, which is the claim in the README about up to sixteen
    //    windows; four do not show the header wrapping that density needs.
    for (const { id } of sessions.slice(4)) await openSession(id);
    await page.waitForTimeout(2000);
    await shot('grid');

    // 3. The capability surface: provider, account, model, effort, permission
    //    mode, plugins and slash commands. Opened from a PROJECT's own launch
    //    chip rather than from the command bar's model chip, which is the same
    //    component in reconfigure mode. Two reasons, and both are about what the
    //    picture says. The launch form carries the Account row (several Claude
    //    plans in one rail) and reads "Start in demo/harbor" rather than "Changes
    //    apply to this session", so the frame is a decision rather than an audit.
    //    It is the RAIL HEAD's +P, not a project row's: a project row launches
    //    IMMEDIATELY with the saved defaults and never draws the form. The head
    //    button asks for a folder first, which an isolated Harbor refuses to open
    //    a native picker for, so HARBOR_E2E_FAKE_DIALOG supplies the answer the
    //    OS would have given (checked before the guard, so no portal call is
    //    made at all).
    await page.locator('.sidebar-global-new').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.new-session-popover', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1600);
    if (await page.locator('.new-session-popover').count()) await shot('session-config');
    else process.stdout.write('SKIPPED session-config: the launch popover did not open\n');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);

    // 4. The Tasks view, seeded through the real CLI before launch so what is
    //    on screen came through the same writer an agent would use.
    await page.locator('.view-switch-btn', { hasText: 'Tasks' }).first()
      .click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // Land on the seeded LIST, not on My Day. My Day is empty by design until
    // you put something in it, and an empty pane is a poor picture of a feature.
    await page.locator('.tasks-nav-btn', { hasText: 'Harbor' }).first()
      .click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await shot('tasks');

    // 5. Orchestration: the queue for the project the stage is already showing,
    //    read from a delegate state directory this run owns.
    await page.locator('.view-switch-btn', { hasText: 'Orch' }).first()
      .click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(900);
    await page.locator('.orch-picker-row').filter({ hasText: 'harbor' }).first()
      .click({ timeout: 8000 }).catch(() => {});
    await page.waitForSelector('.orch-batch-card', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const batchCards = await page.locator('.orch-batch-card').count();
    if (batchCards > 0) await shot('orch');
    else process.stdout.write('SKIPPED orch: no batch cards rendered\n');

    // 6. Files (Artifacts): discovered from transcripts, rendered inline. The
    //    thumbnails are generated on demand by the main side, so wait for the
    //    IMAGES rather than for the cards, or the picture is a grid of glyphs.
    await page.locator('.view-switch-btn', { hasText: 'Files' }).first()
      .click({ timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.artifact-card', { timeout: 45000 }).catch(() => {});
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('.artifact-card')];
      if (!cards.length) return false;
      const withImages = cards.filter((card) => card.querySelector('.artifact-thumb img'));
      return withImages.length >= Math.min(cards.length, 4);
    }, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const artifactCount = await page.locator('.artifact-card').count();
    const thumbCount = await page.locator('.artifact-card .artifact-thumb img').count();
    process.stdout.write(`artifacts: ${artifactCount} cards, ${thumbCount} with previews\n`);
    if (artifactCount > 0) await shot('files');
    else process.stdout.write('SKIPPED files: artifact index still empty\n');

    // EVERY shot, or none of them. Only the stage had a hard guard; the rest
    // wrap their selectors in .catch(() => {}) so a click that stops matching
    // prints SKIPPED and the run still exits 0, which for a file the README
    // links means a broken image and a generator that reported success.
    const expected = ['stage', 'grid', 'session-config', 'tasks', 'orch', 'files'];
    const missed = expected.filter((name) => !fs.existsSync(path.join(stage, `${name}.png`)));
    if (missed.length) {
      throw new Error(`${missed.join(', ')} were never taken; the README links every one of these, so nothing is published`);
    }

    present(written);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    for (const [staged, target] of publish) {
      if (!fs.existsSync(staged)) continue;
      fs.copyFileSync(staged, target);
      process.stdout.write(`published ${target}\n`);
    }
  } finally {
    await app.close({ force: true }).catch(() => {});
    try { process.kill(-daemon.pid, 'SIGTERM'); } catch { try { daemon.kill('SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`capture-screenshot failed: ${error.message}\n`);
  process.exit(1);
});
