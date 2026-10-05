'use strict';

// Never open test windows on the live desktop (they steal focus from whatever
// the user is doing): re-exec under xvfb unless explicitly headed.
if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  && process.env.HARBOR_E2E_HEADED !== '1' && !process.env.__HARBOR_XVFB) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, __HARBOR_XVFB: '1' };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const res = spawnSync('xvfb-run', ['-a', process.execPath, __filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(res.status == null ? 1 : res.status);
}

// COMPREHENSIVE end-to-end driven verification of the Slate UI. Clicks /
// exercises every feature and clickable element in Harbor against an ISOLATED
// herdr session, with native/destructive actions (folder picker, about dialog,
// reload, devtools, real resume/new-session) stubbed in the main process so
// they are testable without side effects. EVERY await is time-bounded so a
// stuck step fails that one section instead of hanging the run; sections are
// independent so one run surfaces every failure. Run under xvfb (never the
// live desktop):
//   env -u DISPLAY -u WAYLAND_DISPLAY xvfb-run -a node scripts/verify-all.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchHarbor, closeHarbor, screenshot } = require('../test/e2e/helpers/electron.js');
const { expectedSidebarRows, indexerCounts } = require('../test/e2e/helpers/indexer.js');
const { startHarness, teardownHarness } = require('../test/e2e/helpers/terminal-harness.js');
const { sessionProcessAlive } = require('../test/e2e/helpers/session-liveness.js');
const { HerdrClient } = require('../src/main/herdr/client.js');
const { queuePath } = require('../src/main/providers/delegate.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const passes = [];
const skips = [];
const fails = [];
const ok = (m) => { passes.push(m); console.log('OK  ' + m); };
const skip = (m) => { skips.push(m); console.log('--  SKIP ' + m); };

const withTimeout = (p, ms, tag) => Promise.race([
  Promise.resolve(p),
  new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT ' + tag + ' (' + ms + 'ms)')), ms)),
]);

// --section <substring> (repeatable, case-insensitive) runs only matching
// sections so a batch gate answers its own question in minutes instead of
// rerunning the whole wall. A filtered run is NEVER the ship gate: the
// summary says loudly how much was filtered out.
const sectionFilters = [];
for (let argIndex = 0; argIndex < process.argv.length; argIndex += 1) {
  if (process.argv[argIndex] === '--section' && process.argv[argIndex + 1]) {
    sectionFilters.push(process.argv[argIndex + 1].toLowerCase());
  }
}
const filteredOut = [];

async function section(name, fn) {
  if (sectionFilters.length
    && !sectionFilters.some((needle) => name.toLowerCase().includes(needle))) {
    filteredOut.push(name);
    return;
  }
  try {
    await withTimeout(fn(), 90000, 'section:' + name);
    console.log('== section ok: ' + name);
  } catch (e) {
    fails.push(name + ' -> ' + e.message);
    console.log('XX  FAIL [' + name + ']: ' + e.message);
  }
}

async function main() {
  const harness = await startHarness({ stress: false });
  const delegateFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-delegate-'));
  const workspace = REPO_ROOT;
  const queueFile = queuePath(workspace, delegateFixtureDir);
  const queueId = 'verify-orch-queue';
  const now = Date.now();
  const batches = Array.from({ length: 8 }, (_, index) => ({
    id: `verify-${index + 1}`,
    title: `Fixture batch ${index + 1}`,
    worker: index === 4 ? 'claude-worker-sol' : 'claude-worker',
    worker_engine: index === 4 ? 'sol' : null,
    status: index < 4 ? 'done' : index === 4 ? 'active' : 'pending',
    started_at: index < 4 ? new Date(now - (index + 2) * 600000).toISOString() : null,
    completed_at: index < 4 ? new Date(now - (index + 1) * 600000).toISOString() : null,
    updated_at: new Date(now - index * 1000).toISOString(),
    last_event: index === 4 ? 'Worker is implementing the queue status UI' : null,
  }));
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  fs.writeFileSync(queueFile, JSON.stringify({ queue_id: queueId, workspace, batches }), 'utf8');
  const eventsDir = path.join(delegateFixtureDir, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.writeFileSync(path.join(eventsDir, `${queueId}.jsonl`), [
    JSON.stringify({ t: '10:00', msg: 'Queue fixture started' }),
    JSON.stringify({ t: '10:05', msg: 'Fixture batch 4 completed' }),
  ].join('\n') + '\n', 'utf8');
  const { electronApp, page } = await launchHarbor({
    HERDR_SOCKET_PATH: harness.socketPath,
    CLAUDE_DELEGATE_DRY_RUN: '1',
    HARBOR_FRESH_PANE_TIMEOUT_MS: '1500',
    HARBOR_DELEGATE_STATE_DIR: delegateFixtureDir,
  });
  page.setDefaultTimeout(15000);
  if (process.env.HARBOR_SEND_DEBUG === '1') {
    electronApp.process().stdout?.on('data', (d) => process.stdout.write('[main] ' + d));
    electronApp.process().stderr?.on('data', (d) => process.stdout.write('[main!] ' + d));
    page.on('console', (message) => console.log(`[page:${message.type()}] ${message.text()}`));
    await page.evaluate(() => { window.__harborUiDebug = true; });
  }

  const ev = (fn, arg) => withTimeout(page.evaluate(fn, arg), 15000, 'page.evaluate');
  const eev = (fn) => withTimeout(electronApp.evaluate(fn), 15000, 'electron.evaluate');
  const probe = () => eev(() => (globalThis.__probe ? globalThis.__probe.calls.slice() : []));
  const clearProbe = () => eev(() => { if (globalThis.__probe) globalThis.__probe.calls = []; });
  const launches = () => ev(() => window.harbor.e2e.getLaunchCalls());
  const waitForAiLaunch = async (before) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const calls = (await launches()).filter((c) => String(c.command).endsWith('/ai'));
      if (calls.length > before) return calls[before];
      await page.waitForTimeout(100);
    }
    return null;
  };
  const verifyClient = new HerdrClient({ socketPath: harness.socketPath });

  // Stubs: NOT app.quit (teardown's e2e:quit needs the real one) and window
  // methods are record-only (never actually minimize/maximize/close/fullscreen
  // under a WM-less xvfb display, which would wedge the window).
  // electronApp.evaluate runs in the Electron main process, a separate
  // context that cannot close over this script's outer variables (see the
  // sessionId arg on the adopt-setup evaluate below), so REPO_ROOT has to be
  // passed in explicitly rather than referenced from the closure.
  await electronApp.evaluate(({ dialog, BrowserWindow }, repoRoot) => {
    globalThis.__probe = { calls: [] };
    const rec = (n) => globalThis.__probe.calls.push(n);
    dialog.showOpenDialog = async () => { rec('showOpenDialog'); return { canceled: false, filePaths: [repoRoot] }; };
    dialog.showMessageBox = async () => { rec('showMessageBox'); return { response: 0 }; };
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.reload = () => rec('reload');
    w.webContents.toggleDevTools = () => rec('toggleDevTools');
    for (const m of ['minimize', 'maximize', 'unmaximize', 'setFullScreen', 'close']) w[m] = () => rec(m);
  }, REPO_ROOT);

  const openMenu = async () => {
    if (await page.locator('.app-menu-dropdown').count() === 0) await page.locator('.app-menu-btn').click();
    await page.waitForSelector('.app-menu-dropdown');
  };
  const menuClick = async (action) => {
    await openMenu();
    await page.locator(`.app-menu-item[data-action="${action}"]`).click();
    await page.waitForTimeout(120);
  };

  // Dead, settled sessions among the rows the rail currently renders. Recency
  // alone is not death: an outside-terminal session keeps a live process while
  // its transcript sits quiet, and its window flips to watch-only when the
  // process-alive probe lands; the tee-pid filter runs node-side over a
  // larger DOM pool (live-caught 2026-07-20).
  const renderedDead = async (max) => {
    const pool = await ev((m) => {
      return (async () => {
        const state = await window.harbor.sidebar.getState();
        const byId = new Map();
        for (const proj of state.model.projects || []) {
          for (const s of proj.sessions || []) byId.set(s.id, s);
        }
        const picked = [];
        for (const el of document.querySelectorAll('.sr')) {
          const s = byId.get(el.dataset.sessionId);
          if (!s || s.isWindowsEra || s.isChildTask || s.isLive) continue;
          if (String(s.id).startsWith('live:')) continue;
          if (s.lastActiveMs && Date.now() - s.lastActiveMs < 15 * 60 * 1000) continue;
          picked.push({ id: s.id, home: s.home, title: s.title });
          if (picked.length >= m) break;
        }
        return picked;
      })();
    }, max * 4);
    return pool.filter((s) => !sessionProcessAlive(s.id)).slice(0, max);
  };

  const openById = async (id) => {
    await ev((sessionId) => window.__harborOpenSession(sessionId), id);
    await page.waitForSelector(`.win2[data-session-id="${id}"]`, { timeout: 10000 });
  };

  // Some dead sessions in the corpus are THIN: a launch that booted but never
  // completed a turn (no assistant block, hence no parsed model header and no
  // who-row logo). Instant-launch sections earlier in THIS run leave exactly
  // such sessions at the top of the recency-sorted rail, so `renderedDead(1)`
  // can land on one, and then `.mswitch` (needs header.model) and
  // `.conv-assistant-who .conv-sig` never render. Pick the first dead session
  // that actually has assistant content; probe by opening then closing each.
  const richDeadId = async (poolSize = 8, exclude = new Set()) => {
    const cands = (await renderedDead(poolSize)).filter((c) => !exclude.has(c.id));
    for (const c of cands) {
      await openById(c.id);
      const rich = await page.locator(`.win2[data-session-id="${c.id}"] .conv-assistant`).count();
      // Drivability probe: a candidate that flips to watch-only (outside-live
      // without a tee) disables the bar and offers no Resume chip; rotate.
      await page.waitForTimeout(400);
      const barEnabled = await page.locator('.ubar-input').isEnabled().catch(() => false);
      await page.locator(`.win2[data-session-id="${c.id}"] .tile-close`).click().catch(() => {});
      await page.waitForSelector(`.win2[data-session-id="${c.id}"]`, { state: 'detached', timeout: 4000 }).catch(() => {});
      if (rich > 0 && barEnabled) return c;
    }
    return cands[0] || null;
  };

  const closeAllTiles = async () => {
    if (await page.locator('.new-session-popover').count() > 0) {
      await page.keyboard.press('Escape');
      await page.waitForSelector('.new-session-popover', { state: 'detached', timeout: 4000 }).catch(() => {});
    }
    for (let i = 0; i < 20; i += 1) {
      const btn = page.locator('.win2 .tile-close').first();
      if (await btn.count() === 0) break;
      await btn.click();
      await page.waitForTimeout(150);
    }
  };

  try {
    await page.waitForSelector('.titlebar', { timeout: 15000 });

    // ═══════════ TITLEBAR APP MENU ═══════════
    await section('app-menu structure', async () => {
      await openMenu();
      const secs = await page.$$eval('.app-menu-section', (els) => els.map((e) => e.textContent));
      assert.deepEqual(secs, ['File', 'View', 'Help'], `sections: ${secs}`);
      const acts = await page.$$eval('.app-menu-item', (els) => els.map((e) => e.getAttribute('data-action')));
      // The File section is one row PER CONFIGURED PROFILE now, so its length is
      // a property of this machine rather than a constant. It used to be two
      // hardcoded rows naming two specific accounts, and this was the last
      // surface still doing that.
      const sessionActs = acts.filter((action) => String(action).startsWith('new-session:'));
      assert.ok(sessionActs.length >= 1, `expected at least one new-session row, got ${acts}`);
      assert.deepEqual(
        acts.slice(sessionActs.length),
        ['quit', 'reload', 'zoom-in', 'zoom-out', 'zoom-reset', 'fullscreen', 'devtools', 'help', 'about'],
      );
      ok(`app menu opens with File/View/Help, ${sessionActs.length} plan row(s) and the 9 fixed items`);
      await screenshot(page, 'all-appmenu-open.png');
      await page.keyboard.press('Escape');
    });

    await section('app-menu actions', async () => {
      const zoom = () => eev(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel());
      await menuClick('zoom-in'); assert.ok(await zoom() > 0, 'zoom-in raised zoom');
      await menuClick('zoom-out'); await menuClick('zoom-out'); assert.ok(await zoom() < 0, 'zoom-out lowered zoom');
      await menuClick('zoom-reset'); assert.equal(await zoom(), 0, 'zoom-reset zeroed zoom');
      ok('menu: zoom in / out / reset change the real zoom level');
      await clearProbe();
      await menuClick('reload'); assert.ok((await probe()).includes('reload'), 'reload wired');
      await menuClick('devtools'); assert.ok((await probe()).includes('toggleDevTools'), 'devtools wired');
      await menuClick('fullscreen'); assert.ok((await probe()).includes('setFullScreen'), 'fullscreen wired');
      await menuClick('about'); assert.ok((await probe()).includes('showMessageBox'), 'about wired');
      ok('menu: reload / devtools / fullscreen / about each fire their action');
    });

    await section('app-menu new session', async () => {
      await clearProbe();
      const before = (await launches()).filter((c) => String(c.command).endsWith('/ai')).length;
      const firstPlan = await page.$eval('.app-menu-item[data-action^="new-session:"]', (el) => el.getAttribute('data-action'));
      await menuClick(firstPlan);
      await page.waitForTimeout(400);
      assert.ok((await probe()).includes('showOpenDialog'), 'folder picker shown');
      assert.equal(await page.locator('.new-session-popover').count(), 1, 'session config opened');
      assert.equal((await launches()).filter((c) => String(c.command).endsWith('/ai')).length, before, 'opening config does not launch');
      await page.getByRole('button', { name: 'Start Claude session' }).click();
      const newCall = await waitForAiLaunch(before);
      assert.ok(newCall, 'bin/ai launch recorded');
      ok('menu: New session (first plan) walks folder picker -> config -> bin/ai launch');
    });

    // ═══════════ TITLEBAR STATUS ═══════════
    await section('titlebar status cluster', async () => {
      assert.equal(await page.locator('.titlebar .ring').count(), 0, 'no titlebar usage rings');
      await page.locator('.live-pill').waitFor();
      const liveText = await page.locator('.live-pill').innerText();
      assert.match(liveText, /\d+ live/, 'live pill counts');
      ok(`titlebar: live pill only ("${liveText.trim()}")`);
    });

    await section('rail toggle button vertically centered in titlebar', async () => {
      const align = await ev(() => {
        const toggle = document.querySelector('.rail-toggle-btn');
        const bar = document.querySelector('.titlebar');
        const tb = toggle.getBoundingClientRect();
        const bb = bar.getBoundingClientRect();
        return { delta: Math.abs((tb.top + tb.height / 2) - (bb.top + bb.height / 2)) };
      });
      assert.ok(align.delta <= 2, `toggle center delta ${align.delta}px from titlebar center`);
      ok(`rail toggle vertically centered in titlebar (delta ${align.delta.toFixed(1)}px)`);
    });

    await section('rail meters fit inside the rail with nothing clipped', async () => {
      await eev(({ ipcMain, BrowserWindow }) => {
        const fiveHourResetsAt = Math.floor(new Date(2026, 6, 18, 15, 30).getTime() / 1000);
        const weeklyResetsAt = Math.floor(new Date(2026, 6, 24, 9, 0).getTime() / 1000);
        const sample = { fiveHourPct: 42, weeklyPct: 63, fiveHourResetsAt, weeklyResetsAt };
        ipcMain.removeHandler('usage:get-all');
        ipcMain.handle('usage:get-all', async () => ({ team: sample, personal: sample, plan3: sample }));
        BrowserWindow.getAllWindows()[0].webContents.send('usage:update');
      });
      await page.waitForSelector('.rail-meters', { timeout: 10000 });
      await page.waitForFunction(() => [...document.querySelectorAll('.rm-g em')].some((el) => /^↻\d{1,2}\/\d{1,2}$/.test(el.textContent)));
      const geom = await ev(() => {
        const rail = document.querySelector('.rail').getBoundingClientRect();
        const meters = document.querySelector('.rail-meters').getBoundingClientRect();
        const clipped = [...document.querySelectorAll('.rm-g em, .rm-g b, .rm-row')]
          .filter((el) => el.scrollWidth > el.clientWidth + 0.5).length;
        return { inside: meters.right <= rail.right + 0.5, clipped, rows: document.querySelectorAll('.rm-row').length };
      });
      assert.equal(geom.rows, 3, 'all three plans shown (personal, team, Third)');
      assert.ok(geom.inside, 'meters bleed past the rail edge');
      assert.equal(geom.clipped, 0, `${geom.clipped} meter cells are clipped`);
      const resetTexts = await page.$$eval('.rm-g em', (els) => els.map((el) => el.textContent));
      assert.equal(resetTexts.filter((text) => /^↻\d{1,2}\/\d{1,2}$/.test(text)).length, 3, `weekly resets use M/D: ${resetTexts}`);
      assert.equal(resetTexts.filter((text) => /[A-Za-z]{3}\s+\d/.test(text)).length, 0, `no month-name reset dates: ${resetTexts}`);
      const fonts = await ev(() => {
        const pct = document.querySelector('.rm-g b');
        const reset = document.querySelector('.rm-g em');
        return {
          pct: pct ? parseFloat(getComputedStyle(pct).fontSize) : 0,
          reset: reset ? parseFloat(getComputedStyle(reset).fontSize) : 0,
        };
      });
      assert.ok(fonts.pct >= 11, `meter pct font ${fonts.pct}px (want >= 11px)`);
      assert.ok(fonts.reset >= 10, `meter reset font ${fonts.reset}px (want >= 10px)`);
      ok(`rail meters: P+T rows fit, weekly resets use M/D, enlarged type (${fonts.pct}/${fonts.reset}px), no clipped text (${resetTexts.join(', ')})`);
    });

    await section('window controls fire', async () => {
      await clearProbe();
      await page.locator('.titlebar-btn[aria-label="Minimize"]').click();
      await page.locator('.titlebar-btn[aria-label="Maximize"], .titlebar-btn[aria-label="Restore"]').first().click();
      await page.locator('.titlebar-btn-close').click();
      const calls = await probe();
      assert.ok(calls.includes('minimize'), 'minimize fired');
      assert.ok(calls.includes('maximize') || calls.includes('unmaximize'), 'maximize toggled');
      assert.ok(calls.includes('close'), 'close fired');
      ok('window controls: minimize / maximize / close each reach the window');
    });

    // ═══════════ RAIL ═══════════
    await section('rail project and date grouping toggle', async () => {
      assert.equal(await page.locator('.rail').getAttribute('data-grouping'), 'project', 'project is the default');
      assert.equal(await page.locator('button[data-grouping="project"]').getAttribute('aria-pressed'), 'true');
      assert.match(await page.locator('[data-filter="48h"]').getAttribute('class'), /\bactive\b/, '48h is the default filter');
      const projectDump = await ev(() => ({
        grouping: document.querySelector('.rail')?.dataset.grouping,
        headers: [...document.querySelectorAll('.pg-label')].slice(0, 4).map((el) => el.textContent),
        rows: [...document.querySelectorAll('.sr')].slice(0, 4).map((el) => el.textContent.trim()),
      }));
      await screenshot(page, 'all-rail-project.png');
      await page.locator('button[data-grouping="date"]').click();
      await page.waitForFunction(() => document.querySelector('.rail')?.dataset.grouping === 'date');
      assert.equal(await page.locator('.pg-label').first().textContent(), 'Today', 'newest display day is Today');
      assert.ok(await page.locator('.sr-project').count() > 0, 'date rows show project labels');
      const dateDump = await ev(() => ({
        grouping: document.querySelector('.rail')?.dataset.grouping,
        headers: [...document.querySelectorAll('.pg-label')].slice(0, 4).map((el) => el.textContent),
        projects: [...document.querySelectorAll('.sr-project')].slice(0, 4).map((el) => el.textContent),
      }));
      await screenshot(page, 'all-rail-date.png');
      ok(`rail grouping: project ${JSON.stringify(projectDump)}; date ${JSON.stringify(dateDump)}`);
      await page.locator('button[data-grouping="project"]').click();
    });

    await section('rail resize clamps, meters fit at both extremes, and width persists', async () => {
      const dragTo = async (targetWidth) => {
        const rail = page.locator('.rail');
        const before = await rail.boundingBox();
        const handle = await page.locator('.rail-resize-handle').boundingBox();
        assert.ok(before && handle, 'rail and resize handle have geometry');
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 40);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2 + targetWidth - before.width, handle.y + 40, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(100);
      };
      const assertRailFit = async (expectedWidth) => {
        const geometry = await ev(() => {
          const rail = document.querySelector('.rail').getBoundingClientRect();
          const workspace = document.querySelector('.workspace').getBoundingClientRect();
          const clipped = [...document.querySelectorAll('.rm-g em, .rm-g b, .rm-row')]
            .filter((el) => el.scrollWidth > el.clientWidth + 0.5).length;
          return { width: rail.width, workspaceLeft: workspace.left, railRight: rail.right, clipped };
        });
        assert.ok(Math.abs(geometry.width - expectedWidth) <= 1, `rail width ${geometry.width}, wanted ${expectedWidth}`);
        assert.ok(Math.abs(geometry.workspaceLeft - geometry.railRight) <= 1, 'stage reflows against rail edge');
        assert.equal(geometry.clipped, 0, `${geometry.clipped} meter cells clipped at ${expectedWidth}px`);
      };
      await dragTo(100);
      await assertRailFit(190);
      await dragTo(500);
      await assertRailFit(420);
      const stored = await ev(() => JSON.parse(localStorage.getItem('harbor-rail')));
      assert.deepEqual(stored, { width: 420, hidden: false, grouping: 'project' });
      await screenshot(page, 'all-rail-resized.png');
      await ev(() => window.location.reload());
      await page.waitForSelector('.rail', { timeout: 20000 });
      await assertRailFit(420);
      assert.deepEqual(await ev(() => JSON.parse(localStorage.getItem('harbor-rail'))), stored);
      ok(`rail resize: 190px and 420px fit with zero clipped cells; reload restored ${JSON.stringify(stored)}`);
    });

    await section('rail collapse and reopen by mouse, Ctrl+B, and Ctrl+K', async () => {
      // The hide control lives in the TITLE BAR (.rail-toggle-btn), not the
      // rail itself; the old .rail-collapse selector matched nothing.
      await page.locator('.rail-toggle-btn').click();
      await page.waitForSelector('.rail-reopen-strip');
      const stripWidth = await page.locator('.rail-reopen-strip').evaluate((el) => el.getBoundingClientRect().width);
      assert.equal(stripWidth, 24, 'hidden rail is a 24px strip');
      await screenshot(page, 'all-rail-collapsed.png');
      await page.locator('.rail-reopen').click();
      await page.waitForSelector('.rail');
      await page.keyboard.press('Control+b');
      await page.waitForSelector('.rail-reopen-strip');
      await page.keyboard.press('Control+b');
      await page.waitForSelector('.rail');
      await page.keyboard.press('Control+b');
      await page.waitForSelector('.rail-reopen-strip');
      await page.keyboard.press('Control+k');
      await page.waitForSelector('.rail');
      await page.waitForFunction(
        () => document.activeElement?.classList?.contains('rail-find'),
        { timeout: 3000 },
      ).catch(() => {});
      assert.equal(await ev(() => document.activeElement?.classList?.contains('rail-find')), true, '^K reopens and focuses search');
      const stored = await ev(() => JSON.parse(localStorage.getItem('harbor-rail')));
      assert.equal(stored.hidden, false, 'reopened state persisted');
      ok('rail collapse: mouse and Ctrl+B close/reopen; Ctrl+K auto-expands and focuses search');
    });

    await section('rail grouping persists across renderer reload', async () => {
      await page.locator('button[data-grouping="date"]').click();
      await page.waitForFunction(() => document.querySelector('.rail')?.dataset.grouping === 'date');
      await ev(() => window.location.reload());
      await page.waitForSelector('.rail[data-grouping="date"]', { timeout: 20000 });
      const stored = await ev(() => JSON.parse(localStorage.getItem('harbor-rail')));
      assert.deepEqual(stored, { width: 420, hidden: false, grouping: 'date' });
      assert.equal(await page.locator('.pg-label').first().textContent(), 'Today');
      await page.locator('button[data-grouping="project"]').click();
      ok(`rail persistence: grouping and width survive reload as ${JSON.stringify(stored)}`);
    });

    await section('rail search + ^K + clear', async () => {
      await page.keyboard.press('Control+k');
      assert.equal(await ev(() => document.activeElement?.classList?.contains('rail-find')), true, '^K focuses search');
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(600);
      assert.ok(await page.locator('.sr').count() > 0, 'search shows rows');
      await page.locator('.sidebar-search-clear').click();
      assert.equal(await ev(() => document.querySelector('.rail-find').value), '', 'clear empties search');
      ok('rail: ^K focus, search narrows, clear button empties');
    });

    await section('rail filters', async () => {
      await page.locator('button[data-grouping="project"]').click();
      await page.waitForFunction(() => document.querySelector('.rail')?.dataset.grouping === 'project');
      await page.locator('[data-filter="all"]').click();
      await page.waitForTimeout(500);
      await ev(() => {
        for (const btn of document.querySelectorAll('.sidebar-project-wrap .pg')) {
          const caret = btn.querySelector('.sidebar-caret');
          if (caret?.textContent === '▾') btn.click();
        }
      });
      await page.waitForTimeout(300);
      const expectedAll = expectedSidebarRows({ filter: { kind: 'all' } });
      const expectedToday = expectedSidebarRows({ filter: { kind: 'today' } });
      const indexerTotal = indexerCounts().emitAll;
      const before = await ev(() => ({
        rows: document.querySelectorAll('.sr').length,
        count: document.querySelector('.rail-count')?.textContent?.trim() || '',
      }));
      await page.locator('[data-filter="today"]').click();
      await page.waitForTimeout(500);
      const after = await ev(() => ({
        rows: document.querySelectorAll('.sr').length,
        count: document.querySelector('.rail-count')?.textContent?.trim() || '',
      }));
      assert.ok(
        expectedToday.sessionRowCount < expectedAll.sessionRowCount,
        `today narrows indexer sessions (${expectedToday.sessionRowCount} < ${expectedAll.sessionRowCount})`,
      );
      assert.match(after.count, /^\d+ \/ \d+$/, 'rail count shows filtered fraction');
      const [shown, total] = after.count.split('/').map((part) => parseInt(part.trim(), 10));
      assert.equal(shown, expectedToday.sessionRowCount, 'rail count matches filtered flatten total');
      assert.equal(total, indexerTotal, 'rail total matches indexer emit --all');
      assert.ok(after.rows > 0, 'today renders filtered sessions in the virtual viewport');
      assert.ok(shown < total, 'today count is narrower than the full indexer total');
      await screenshot(page, 'all-rail-project-today.png');
      await page.locator('[data-filter="all"]').click();
      await page.waitForTimeout(500);
      ok(`rail: project+today rows ${before.rows}->${after.rows}, count ${before.count}->${after.count}`);
    });

    await section('rail project collapse + hover actions', async () => {
      await page.locator('[data-filter="all"]').click();
      await page.waitForTimeout(300);
      await ev(() => {
        const list = document.querySelector('.sidebar-virtual-list');
        if (list) list.scrollTop = 0;
      });
      await page.waitForTimeout(150);
      const wrap = page.locator('.sidebar-project-wrap').first();
      const caretBefore = await wrap.locator('.sidebar-caret').innerText();
      await wrap.locator('.pg').click();
      await page.waitForTimeout(200);
      const caretAfter = await wrap.locator('.sidebar-caret').innerText();
      assert.notEqual(caretBefore, caretAfter, 'caret toggled');
      await wrap.locator('.pg').click();
      await page.waitForTimeout(200);
      // Hover a project that must carry the P/T/S launch actions (the first
      // wrap under the all filter can be a windows-era or anchorless group,
      // where actions are deliberately hidden). Match the header LABEL, not
      // subtree text: half the corpus session titles contain "harbor".
      const harborWrap = page.locator('.sidebar-project-wrap')
        .filter({ has: page.locator('.pg .pg-label', { hasText: /^harbor$/i }) })
        .first();
      await harborWrap.hover();
      await page.waitForTimeout(150);
      assert.ok(await harborWrap.locator('.sidebar-proj-new').count() >= 3, 'hover reveals +P/+T/+S');
      ok('rail: project collapse toggles; hover reveals per-project P/T/S actions');
    });

    await section('rail head new session opens prefilled config before launch', async () => {
      await clearProbe();
      const before = (await launches()).filter((c) => String(c.command).endsWith('/ai')).length;
      await page.locator('.sidebar-global-new.team').click();
      await page.waitForTimeout(300);
      assert.ok((await probe()).includes('showOpenDialog'), 'rail head walked the folder picker');
      assert.equal(await page.locator('.new-session-popover').count(), 1, 'create-time config dialog opened');
      assert.equal(await page.getByLabel('Model').inputValue(), 'opus', 'stored model prefills the dialog');
      assert.equal(await page.getByLabel('Effort').getAttribute('aria-valuetext'), 'high', 'stored effort prefills the dialog');
      assert.equal(await page.getByRole('group', { name: 'Account' }).getByRole('button', { name: 'Team' }).getAttribute('aria-pressed'), 'true', 'entry-point account prefills the dialog');
      assert.equal((await launches()).filter((c) => String(c.command).endsWith('/ai')).length, before, 'opening config does not launch');
      await page.getByRole('button', { name: 'Start Claude session' }).click();
      const call = await waitForAiLaunch(before);
      assert.ok(call, 'bin/ai launch recorded');
      assert.deepEqual(call.argv, ['--team', '--model', 'opus', '--effort', 'high']);
      ok('rail head +T: folder picker then prefilled config, Start launches claude/opus with explicit effort');
    });

    await section('provider logos render in rail row and conversation who-row', async () => {
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(500);
      const railLogo = page.locator('.sr .sr-provider').first();
      assert.ok(await railLogo.count() > 0, 'rail row has a provider logo');
      const railSrc = await railLogo.getAttribute('src');
      assert.ok(railSrc, 'rail provider logo has src');
      const meta = await richDeadId();
      assert.ok(meta, 'a dead session with assistant content exists');
      await openById(meta.id);
      await page.waitForSelector('.conv-assistant-who .conv-sig', { timeout: 10000 });
      const convSrc = await page.locator('.conv-assistant-who .conv-sig').first().getAttribute('src');
      assert.ok(convSrc, 'conversation who-row logo has src');
      ok('provider logos: .sr-provider in the rail and .conv-sig in the assistant who-row');
      await closeAllTiles();
    });

    await section('rail right-click menu copies resume command', async () => {
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(500);
      const [meta] = await renderedDead(1);
      assert.ok(meta, 'a dead session row rendered');
      await page.locator(`.sr[data-session-id="${meta.id}"]`).click({ button: 'right' });
      await page.waitForSelector('.sr-menu', { timeout: 4000 });
      await page.locator('.sr-menu .sr-menu-item', { hasText: 'Copy resume command' }).click();
      // writeText resolves a beat after the click; poll rather than read once.
      let clip = '';
      const clipDeadline = Date.now() + 3000;
      while (Date.now() < clipDeadline && !clip.includes(`--resume ${meta.id}`)) {
        await page.waitForTimeout(150);
        clip = await eev(({ clipboard }) => clipboard.readText());
      }
      assert.ok(clip.includes(`--resume ${meta.id}`), `clipboard has resume command (${clip.slice(0, 60)})`);
      ok('rail: right-click menu copies a paste-ready resume command');
      await page.locator('.sidebar-search-clear').click();
    });

    await section('rail: archive hides live and dead sessions, archived view restores them, delete arms', async () => {
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(500);
      const archiveCandidates = await renderedDead(8);
      const meta = archiveCandidates[0];
      const sentinel = archiveCandidates.find((candidate) => candidate.id !== meta?.id);
      assert.ok(meta, 'a dead session row rendered');
      assert.ok(sentinel, 'a second distinct dead session keeps archived navigation deterministic');
      const row = `.sr[data-session-id="${meta.id}"]`;
      const wrap = `.sr-wrap:has(${row})`;
      const win = `.win2[data-session-id="${meta.id}"]`;
      assert.ok(await page.locator(row).count() > 0, 'row present before archive');
      // Open it as a stage window first: archiving must remove the row AND its
      // window (hiding from the rail while it lingers on the stage is wrong).
      await openById(meta.id);
      assert.ok(await page.locator(win).count() > 0, 'window open before archive');
      // The hover x archives (hides) the row.
      await page.locator(wrap).hover();
      await page.locator(`${wrap} .sr-x`).click();
      await page.waitForSelector(row, { state: 'detached', timeout: 4000 });
      await page.waitForSelector(win, { state: 'detached', timeout: 4000 });
      ok('rail: the row x archives the session and removes its stage window');

      // Keep one unrelated row archived for the rest of this scenario. Without
      // it, unarchiving the sole row removes the Archived toggle while the
      // section is still in archived-only mode, making the next navigation
      // click depend on the surrounding corpus.
      const sentinelRow = `.sr[data-session-id="${sentinel.id}"]`;
      const sentinelWrap = `.sr-wrap:has(${sentinelRow})`;
      await page.locator('.rail-find').fill(sentinel.title);
      await page.waitForSelector(sentinelRow, { timeout: 4000 });
      await page.locator(sentinelWrap).hover();
      await page.locator(`${sentinelWrap} .sr-x`).click();
      await page.waitForSelector(sentinelRow, { state: 'detached', timeout: 4000 });
      await page.locator('.rail-find').fill('harbor');
      // The "Archived N" toggle appears and reveals the archived row on click.
      const toggle = page.locator('.rail-archived-toggle');
      await page.waitForSelector('.rail-archived-toggle', { timeout: 3000 });
      await toggle.click();
      await page.waitForSelector(`.sr-wrap.archived ${row}`, { timeout: 4000 });
      ok('rail: the archived toggle reveals archived sessions');
      // Unarchive via the row control removes it from the archived-only view;
      // returning to the default view shows the restored normal row.
      await page.locator(`.sr-wrap.archived:has(${row})`).hover();
      await page.locator(`.sr-wrap.archived:has(${row}) .sr-x`).click();
      await page.waitForSelector(row, { state: 'detached', timeout: 4000 });
      await toggle.click();
      await page.waitForSelector(`.sr-wrap:not(.archived) ${row}`, { timeout: 4000 });
      ok('rail: unarchive restores the session to the rail');

      // The original regression: live sessions must obey archive exactly like
      // dead ones. Ambient live rows are corpus-dependent (every live agent
      // can be transcript-quiet during this run), so mark a real dead row live
      // in the model: the interaction under test only needs the row to RENDER
      // live at the moment the x is clicked. Post-archive assertions drop the
      // .live selector because a real sidebar refresh replaces the fabricated
      // model while the archive store keeps the id.
      const liveCandidates = await renderedDead(4);
      const liveSeed = liveCandidates.find((candidate) => candidate.id !== sentinel.id && candidate.id !== meta.id);
      assert.ok(liveSeed, 'a session exists to mark live for the archive check');
      const liveRow = `.sr.live[data-session-id="${liveSeed.id}"]`;
      const liveRowAny = `.sr[data-session-id="${liveSeed.id}"]`;
      const liveWrap = `.sr-wrap:has(${liveRowAny})`;
      try {
        await ev((id) => window.harbor.sidebar.getState().then((state) => {
          const fabricated = {
            ...state.model,
            projects: (state.model.projects || []).map((project) => ({
              ...project,
              sessions: (project.sessions || []).map((session) => (session.id === id
                ? { ...session, isLive: true } : session)),
            })),
          };
          // The rail keeps its own model copy; fabricate into BOTH stores.
          window.__setSidebarModelForTest(fabricated);
          window.__setRailModelForTest(fabricated);
        }), liveSeed.id);
        // No re-filter: liveSeed came from rows ALREADY rendered under the
        // current 'harbor' search. It can sit below the virtual-list fold
        // (it is a deep candidate), so scroll it into view before waiting.
        await page.waitForSelector(liveRowAny, { state: 'attached', timeout: 4000 });
        await page.locator(liveRowAny).scrollIntoViewIfNeeded();
        await page.waitForSelector(liveRow, { timeout: 4000 });
        await page.locator(liveWrap).hover();
        await page.locator(`${liveWrap} .sr-x`).click();
        await page.waitForSelector(liveRowAny, { state: 'detached', timeout: 4000 });
        await page.locator('.rail-archived-toggle').click();
        await page.waitForSelector(`.sr-wrap.archived ${liveRowAny}`, { timeout: 4000 });
        await page.locator(`.sr-wrap.archived:has(${liveRowAny})`).scrollIntoViewIfNeeded();
        await page.locator(`.sr-wrap.archived:has(${liveRowAny}) .sr-x`).click();
        await page.waitForSelector(liveRowAny, { state: 'detached', timeout: 4000 });
        await page.locator('.rail-archived-toggle').click();
      } finally {
        // Release both fabrication pins EVEN ON FAILURE: a held pin leaks a
        // stale model into every later section (live-caught: tty echo died
        // downstream whenever this section aborted mid-fabrication).
        await ev(() => {
          window.__setRailModelForTest(null);
          window.__setSidebarModelForTest(null);
        }).catch(() => {});
      }
      // After the unpin the row returns as a plain (no longer live) row.
      await page.waitForSelector(liveRowAny, { timeout: 4000 });
      ok('rail: archiving a live session hides it by default and archived view can unarchive it');

      // The cleanup affordance archives the entire current search result, not
      // just whichever rows happen to be inside the virtualized viewport.
      await page.locator('.rail-find').fill(meta.title);
      await page.waitForTimeout(200);
      const filteredIds = await page.locator('.sr').evaluateAll((elements) => elements.map((element) => element.dataset.sessionId));
      assert.ok(filteredIds.length > 0, 'filtered cleanup has sessions to archive');
      await page.locator('.rail-archive-filtered').click();
      for (const id of filteredIds) {
        await page.waitForSelector(`.sr[data-session-id="${id}"]`, { state: 'detached', timeout: 4000 });
      }
      await page.locator('.rail-archived-toggle').click();
      for (const id of filteredIds) {
        await page.waitForSelector(`.sr-wrap.archived .sr[data-session-id="${id}"]`, { timeout: 4000 });
      }
      for (const id of filteredIds) {
        const archived = page.locator(`.sr-wrap.archived:has(.sr[data-session-id="${id}"]) .sr-x`);
        if (await archived.count() > 0) await archived.click();
      }
      ok(`rail: Archive ${filteredIds.length} clears the current filtered set and remains reversible`);

      // Return to the default view while the sentinel still guarantees the
      // toggle exists. It remains archived only in this isolated harness state.
      await page.locator('.rail-archived-toggle').click();

      // The delete menu item ARMS on first click; the second click (a real
      // transcript move) is NOT exercised here against the live corpus.
      await page.locator('.rail-find').fill('harbor');
      await page.waitForSelector(row, { timeout: 4000 });
      await page.locator(row).click({ button: 'right' });
      await page.waitForSelector('.sr-menu', { timeout: 4000 });
      const del = page.locator('.sr-menu .sr-menu-item.danger');
      await del.click();
      await page.waitForSelector('.sr-menu .sr-menu-item.danger.armed', { timeout: 3000 });
      assert.match(await del.innerText(), /again/i, 'delete arms with a confirm step');
      ok('rail: delete requires a second armed click (guarded)');
      await page.keyboard.press('Escape');
      await page.locator('.sidebar-search-clear').click();
    });

    // ═══════════ STAGE: WINDOWS ═══════════
    let deadSessions = [];
    await section('open windows: 1 full-stage, 2 split, adaptive grid', async () => {
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(500);
      // The inline-image section later opens and then CLOSES the image fixture
      // session's window; if it were also a deadSessions member, its close
      // would silently remove a window the run-state section still needs
      // (live-caught: tonight's tee-alive filter pushed the fixture to the top
      // of the dead pool).
      deadSessions = (await renderedDead(6))
        .filter((candidate) => candidate.id !== 'afa9ccb7-a5de-4803-8de7-c9b5a7436654')
        .slice(0, 4);
      assert.ok(deadSessions.length >= 3, `need 3+ dead sessions, got ${deadSessions.length}`);
      await openById(deadSessions[0].id);
      assert.equal(await page.locator('.grid4[data-grid-cols="1"]').count(), 1, 'one window fills the stage');
      await openById(deadSessions[1].id);
      assert.equal(await page.locator('.grid4[data-grid-cols="2"][data-grid-rows="1"]').count(), 1, 'two windows split');
      await openById(deadSessions[2].id);
      assert.equal(await page.locator('.grid4[data-grid-cols="2"][data-grid-rows="2"]').count(), 1, 'three windows tile 2x2');
      assert.equal(await page.locator('.win2.slot').count(), 1, 'dashed new-session slot fills the gap');
      ok('stage: adaptive grid 1 -> full, 2 -> split, 3 -> 2x2 + slot');
      await screenshot(page, 'all-grid-3.png');
    });

    await section('command bar: per-session drafts restore on window switch', async () => {
      assert.ok(deadSessions.length >= 2, 'need two open windows for draft swap');
      const sessionA = deadSessions[0].id;
      const sessionB = deadSessions[1].id;
      const draftA = `draft-a-${Date.now()}`;
      const draftB = `draft-b-${Date.now()}`;
      const selectWindow = async (sessionId) => {
        await page.locator(`.win2[data-session-id="${sessionId}"] .wh`).click({ position: { x: 6, y: 6 } });
        await page.waitForFunction((id) => document.querySelector(`.win2[data-session-id="${id}"]`)?.classList.contains('sel'), sessionId, { timeout: 5000 });
      };

      await selectWindow(sessionA);
      await page.locator('.ubar-input').fill(draftA);

      await selectWindow(sessionB);
      assert.equal(await page.locator('.ubar-input').inputValue(), '', 'window B starts empty');
      await page.locator('.ubar-input').fill(draftB);

      await selectWindow(sessionA);
      assert.equal(await page.locator('.ubar-input').inputValue(), draftA, 'window A draft restored');

      await selectWindow(sessionB);
      assert.equal(await page.locator('.ubar-input').inputValue(), draftB, 'window B draft retained');

      const stored = await ev(() => {
        try { return JSON.parse(localStorage.getItem('harbor-drafts') || '{}'); }
        catch { return {}; }
      });
      assert.equal(stored[sessionA]?.text, draftA);
      assert.equal(stored[sessionB]?.text, draftB);
      ok('command bar: per-session drafts swap across windows and persist to localStorage');
    });

    await section('conversation renders real transcript blocks', async () => {
      const blocks = await ev((id) => document.querySelector(`.win2[data-session-id="${id}"]`)
        ?.querySelectorAll('.conv-user, .conv-assistant, .conv-act, .conv-act-group').length, deadSessions[0].id);
      assert.ok(blocks > 0, `blocks rendered (${blocks})`);
      ok(`conversation: real transcript renders (${blocks} blocks in window 1)`);
    });

    await section('conversation collapses tool-action groups with stable expand state', async () => {
      const meta = await richDeadId();
      assert.ok(meta, 'rich dead session exists');
      await openById(meta.id);
      const sessionId = meta.id;
      const scope = `.win2[data-session-id="${sessionId}"]`;

      const initialBlocks = [
        { key: 'g1b0', kind: 'assistant', text: 'Starting work on the renderer.' },
        { key: 'g1b1', kind: 'action', verb: 'Ran', chip: 'npm test', status: 'ok' },
        { key: 'g1b2', kind: 'action', verb: 'Ran', chip: 'npm run build', status: 'ok' },
        { key: 'g1b3', kind: 'action', verb: 'Edited', chip: 'Conversation.jsx', status: 'ok' },
        { key: 'g2b0', kind: 'assistant', text: 'Reviewing the styles next.' },
        { key: 'g2b1', kind: 'action', verb: 'Read', chip: 'styles.css', status: 'ok' },
        { key: 'g2b2', kind: 'action', verb: 'Read', chip: 'index.jsx', status: 'ok' },
      ];
      const fabricate = (blocks, working = false) => ev(({ id, blocks, working }) => {
        window.__setTranscriptForTest(id, { header: { working }, blocks });
      }, { id: sessionId, blocks, working });

      const waitFabricated = async (predicate, blocks, tag) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          await fabricate(blocks);
          if (await predicate()) return;
          await page.waitForTimeout(120);
        }
        assert.fail(`fabricated groups never rendered: ${tag}`);
      };

      const firstSummary = 'Ran 2 commands, edited 1 file';
      await waitFabricated(async () => {
        const groups = page.locator(`${scope} .conv-act-group`);
        if (await groups.count() !== 2) return false;
        const summary = await groups.first().locator('.conv-act-group-summary').textContent();
        if (summary !== firstSummary) return false;
        if (await groups.first().getAttribute('data-expanded') !== 'false') return false;
        return (await page.locator(`${scope} .conv-act-group[data-expanded="false"] .conv-act`).count()) === 0;
      }, initialBlocks, 'collapsed groups');

      const firstGroupKey = await page.locator(`${scope} .conv-act-group`).first().getAttribute('data-group-key');
      assert.equal(firstGroupKey, 'g1b1', 'fabricated first group key');

      await ev(({ id, blocks, groupKey }) => {
        window.__setTranscriptForTest(id, { header: { working: false }, blocks });
        document.querySelector(`.win2[data-session-id="${id}"] .conv-act-group[data-group-key="${groupKey}"] .conv-act-group-toggle`)?.click();
      }, { id: sessionId, blocks: initialBlocks, groupKey: firstGroupKey });
      await waitFabricated(async () => {
        const group = page.locator(`${scope} .conv-act-group[data-group-key="${firstGroupKey}"]`);
        if (await group.count() !== 1) return false;
        if (await group.getAttribute('data-expanded') !== 'true') return false;
        return (await group.locator('.conv-act').count()) === 3;
      }, initialBlocks, 'expanded first group');

      const streamedBlocks = [
        ...initialBlocks.slice(0, 4),
        { key: 'g1b4', kind: 'action', verb: 'Ran', chip: 'npm lint', status: 'run' },
        ...initialBlocks.slice(4),
      ];
      await waitFabricated(async () => {
        const group = page.locator(`${scope} .conv-act-group[data-group-key="${firstGroupKey}"]`);
        if (await group.count() !== 1) return false;
        if (await group.getAttribute('data-expanded') !== 'true') return false;
        return (await group.locator('.conv-act').count()) === 4;
      }, streamedBlocks, 'streamed group stays expanded');

      const denseBlocks = [
        { key: 'd0', kind: 'user', text: 'Ship the grouping UI.' },
        { key: 'd1', kind: 'assistant', text: 'Running the full verification pass.' },
        { key: 'd2', kind: 'action', verb: 'Ran', chip: 'npm test', status: 'ok' },
        { key: 'd3', kind: 'action', verb: 'Ran', chip: 'npm run build', status: 'ok' },
        { key: 'd4', kind: 'action', verb: 'Edited', chip: 'Conversation.jsx', status: 'ok' },
        { key: 'd5', kind: 'action', verb: 'Edited', chip: 'styles.css', status: 'ok' },
        { key: 'd6', kind: 'action', verb: 'Read', chip: 'verify-all.js', status: 'ok' },
        { key: 'd7', kind: 'assistant', text: 'Styles and tests are aligned.' },
        { key: 'd8', kind: 'action', verb: 'Globbed', chip: '**/*.test.js', status: 'ok' },
        { key: 'd9', kind: 'action', verb: 'Searched', chip: 'conv-act-group', status: 'ok' },
        { key: 'd10', kind: 'action', verb: 'Fetched', chip: 'docs', status: 'ok' },
        { key: 'd11', kind: 'assistant', text: 'Ready for review.' },
      ];
      await waitFabricated(async () => {
        const summary = await page.locator(`${scope} .conv-act-group`).first().locator('.conv-act-group-summary').textContent();
        return summary === 'Ran 2 commands, edited 2 files, read 1 file' && (await page.locator(`${scope} .conv-act-group`).count()) >= 2;
      }, denseBlocks, 'dense screenshot groups');
      // The live transcript tail can overwrite fabricated blocks between the
      // assertion and the capture, yielding a groupless screenshot. Retry the
      // inject-scroll-capture-verify cycle until one frame provably held the
      // fabricated summary; a race loses a round, never the section.
      let framedGroups = false;
      for (let attempt = 0; attempt < 6 && !framedGroups; attempt += 1) {
        await ev(({ id, blocks }) => {
          window.__setTranscriptForTest(id, { header: { working: false }, blocks });
          document.querySelector(`.win2[data-session-id="${id}"] .conv-act-group`)?.scrollIntoView({ block: 'center' });
        }, { id: sessionId, blocks: denseBlocks });
        await page.waitForTimeout(120);
        await screenshot(page, 'all-conversation-action-groups.png');
        framedGroups = (await page.locator(`${scope} .conv-act-group-summary`, { hasText: 'Ran 2 commands, edited 2 files, read 1 file' }).count()) >= 1;
      }
      assert.ok(framedGroups, 'a captured frame provably held the fabricated group summary');
      ok('conversation: tool-action groups collapse by default and stay expanded while streaming');

      await page.locator(`${scope} .tile-close`).click().catch(() => {});
      await page.waitForSelector(scope, { state: 'detached', timeout: 4000 }).catch(() => {});
    });

    await section('conversation renders inline images from transcript', async () => {
      const imageSessionId = 'afa9ccb7-a5de-4803-8de7-c9b5a7436654';
      await page.locator('.rail-find').fill('UI bugs');
      await page.waitForTimeout(500);
      await openById(imageSessionId);
      await page.waitForFunction(
        (id) => document.querySelector(`.win2[data-session-id="${id}"] .conv-img`) != null,
        imageSessionId,
        { timeout: 20000 },
      );
      const src = await page.locator(`.win2[data-session-id="${imageSessionId}"] .conv-img`).first()
        .getAttribute('src');
      assert.match(src, /^data:image\/(png|jpeg);base64,/);
      // Prove the image actually DECODES and displays (not just that an <img>
      // with a data URI exists): scroll it into view and assert naturalWidth>0.
      const imgEl = page.locator(`.win2[data-session-id="${imageSessionId}"] .conv-img`).first();
      await imgEl.scrollIntoViewIfNeeded();
      await page.waitForFunction((id) => {
        const el = document.querySelector(`.win2[data-session-id="${id}"] .conv-img`);
        return el && el.complete && el.naturalWidth > 0;
      }, imageSessionId, { timeout: 10000 });
      ok('conversation: inline image renders AND decodes from transcript (.conv-img, naturalWidth>0)');
      await page.waitForTimeout(300);
      await screenshot(page, 'all-conversation-inline-image.png');
      // Restore the shared state the window sections rely on: close only THIS
      // extra window (the 3 windows from "open windows" must stay open for
      // run-state/focus/etc.) and put the rail search back to 'harbor'.
      await page.keyboard.press('Escape'); // close the lightbox if open
      await page.locator(`.win2[data-session-id="${imageSessionId}"] .tile-close`).click().catch(() => {});
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(400);
    });

    await section('run-state: RUNNING chip + glow vs DONE ready chip', async () => {
      const runningId = deadSessions[0].id;
      const readyId = deadSessions[1].id;
      // Earlier conversation sections may open and close either fixture
      // session while probing the corpus. Restore both explicit subjects and
      // select the running one before fabricating state.
      await openById(runningId);
      await openById(readyId);
      await page.locator(`.win2[data-session-id="${runningId}"] .wh`).click({ position: { x: 6, y: 6 } });
      await page.waitForFunction((id) => document.querySelector(`.win2[data-session-id="${id}"]`)?.classList.contains('sel'), runningId, { timeout: 5000 });
      const paneInfos = await ev(() => (async () => {
        const state = await window.harbor.terminal.getState();
        const layout = Object.values(state.layouts || {})[0];
        const tab = (state.tabs || []).find((t) => t.tab_id === layout?.tab_id);
        return (layout?.panes || []).slice(0, 2).map((pane) => ({
          paneId: pane.pane_id,
          workspaceId: tab?.workspace_id || null,
        }));
      })());
      assert.equal(paneInfos.length, 2, 'harness panes exist for running and ready states');
      await ev((p) => window.harbor.e2e.setLink(p), { sessionId: runningId, ...paneInfos[0] });
      await ev((p) => window.harbor.e2e.setLink(p), { sessionId: readyId, ...paneInfos[1] });
      // The fabricated states race the windows' REAL transcript parses (a
      // giant corpus file finishes seconds later and overwrites the header),
      // so pushing once is not enough: re-fabricate until the DOM shows it.
      const fabricateRunState = () => ev((args) => {
        return window.harbor.sidebar.getState().then((state) => {
          const statuses = new Map([[args.runningId, 'working'], [args.readyId, 'idle']]);
          const model = {
            ...state.model,
            projects: (state.model.projects || []).map((project) => ({
              ...project,
              sessions: (project.sessions || []).map((session) => (statuses.has(session.id)
                ? { ...session, agentStatus: statuses.get(session.id) }
                : session)),
            })),
          };
          window.__setSidebarModelForTest(model);
          window.__setTranscriptForTest(args.runningId, {
            header: { working: true, workingText: 'Editing styles.css' },
            blocks: [],
          });
          window.__setTranscriptForTest(args.readyId, {
            header: { working: false },
            blocks: [],
          });
        });
      }, { runningId, readyId });
      let runStateShown = false;
      for (let attempt = 0; attempt < 4 && !runStateShown; attempt += 1) {
        await fabricateRunState();
        runStateShown = await page.waitForFunction((args) => {
          const running = document.querySelector(`.win2[data-session-id="${args.runningId}"]`);
          const ready = document.querySelector(`.win2[data-session-id="${args.readyId}"]`);
          return running?.classList.contains('working')
            && running.querySelector('.runstate-running .runstate-verb')?.textContent === 'Editing styles.css'
            && ready?.querySelector('.runstate-ready .runstate-verb')?.textContent === 'ready';
        }, { runningId, readyId }, { timeout: 2500 }).then(() => true).catch(() => false);
      }
      if (!runStateShown) {
        const dump = await ev((args) => {
          const grab = (id) => {
            const win = document.querySelector(`.win2[data-session-id="${id}"]`);
            return win
              ? { cls: win.className, runstate: win.querySelector('.runstate')?.outerHTML || '(none)' }
              : '(no window)';
          };
          return { running: grab(args.runningId), ready: grab(args.readyId) };
        }, { runningId, readyId });
        assert.fail(`fabricated run states never rendered: ${JSON.stringify(dump)}`);
      }
      const readyChip = await page.locator(`.win2[data-session-id="${readyId}"] .runstate-ready .runstate-verb`).innerText();
      assert.equal(readyChip, 'ready', 'idle live window shows ready chip');
      assert.equal(await page.locator(`.win2[data-session-id="${readyId}"]`).evaluate((el) => el.classList.contains('working')), false, 'ready window has no working glow');
      assert.equal(await page.locator(`.win2[data-session-id="${runningId}"] .selflag`).count(), 1, 'selection pill unchanged on active window');
      assert.equal(await page.locator(`.win2[data-session-id="${readyId}"] .selflag`).count(), 0, 'non-selected window keeps live pill not active');
      ok('run-state: RUNNING verb chip + window glow; DONE ready chip; selection pill separate');
      await screenshot(page, 'all-runstate-running-ready.png');
    });

    await section('selection: click + Ctrl+digits + command bar retarget', async () => {
      const firstSlotId = await page.locator('.win2:not(.slot)').first().getAttribute('data-session-id');
      assert.ok(firstSlotId, 'window 1 has a session id');
      await page.keyboard.press('Control+1');
      await page.waitForFunction((id) => document.querySelector(`.win2[data-session-id="${id}"]`)?.classList.contains('sel'), firstSlotId, { timeout: 4000 });
      const t1 = await page.locator('.ubar-status .ustat-title').innerText();
      const w1 = await page.locator(`.win2[data-session-id="${firstSlotId}"] .ti`).innerText();
      assert.equal(t1, w1, 'command bar targets window 1');
      await page.locator(`.win2[data-session-id="${deadSessions[1].id}"] .conv`).click();
      await page.waitForTimeout(150);
      assert.ok(await ev((id) => document.querySelector(`.win2[data-session-id="${id}"]`)?.classList.contains('sel'), deadSessions[1].id), 'clicking a window selects it');
      const renderedTileCount = await page.locator('.win2:not(.slot)').count();
      const keycaps = await page.$$eval('.win2:not(.slot) .kc', (els) => els.map((e) => e.textContent.trim()));
      const expectedKeycaps = Array.from({ length: Math.min(9, renderedTileCount) }, (_, index) => `^${index + 1}`);
      assert.deepEqual(keycaps, expectedKeycaps, 'keycaps label each rendered tile binding in rank order');
      ok('selection: Ctrl+1..9 and clicks move ACTIVE; the bar retargets');
    });

    await section('new-session slot opens config before launch', async () => {
      await clearProbe();
      // Earlier create-session entry-point checks legitimately leave newly
      // launched windows on the shared stage. Establish the three-tile layout
      // this scenario requires instead of depending on that accumulated state.
      await closeAllTiles();
      for (const session of deadSessions.slice(0, 3)) await openById(session.id);
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 3
        && document.querySelectorAll('.win2.slot').length === 1, null, { timeout: 10000 });
      const slot = page.locator('.win2.slot');
      assert.equal(await slot.locator('.slot-btn').count(), 3, 'dashed slot renders Team, Personal, and Third buttons');
      const before = (await launches()).filter((c) => String(c.command).endsWith('/ai')).length;
      await page.locator('.win2.slot .slot-btn.t').click();
      await page.waitForSelector('.new-session-popover');
      assert.equal((await launches()).filter((c) => String(c.command).endsWith('/ai')).length, before, 'opening slot config does not launch');
      assert.equal(await page.getByRole('group', { name: 'Account' }).getByRole('button', { name: 'Team' }).getAttribute('aria-pressed'), 'true', 'slot account prefills the dialog');
      await page.getByRole('button', { name: 'Start Claude session' }).click();
      assert.ok(await waitForAiLaunch(before), 'slot Start fired bin/ai');
      ok('stage: dashed slot renders both actions and walks config -> Start -> bin/ai');
    });

    await section('adaptive grid: 6-window 3x2 layout', async () => {
      await closeAllTiles();
      const more = await renderedDead(6);
      assert.ok(more.length >= 6, `need 6 dead sessions, got ${more.length}`);
      for (const s of more.slice(0, 6)) await openById(s.id);
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 6, null, { timeout: 15000 });
      assert.equal(await page.locator('.grid4[data-grid-cols="3"][data-grid-rows="2"]').count(), 1, 'six windows use 3x2');
      assert.equal(await page.locator('.win2.slot').count(), 0, 'no filler slots at 6 windows');
      await screenshot(page, 'all-grid-6.png');
      ok('stage: six windows tile 3x2 with equal geometry');
    });

    await section('right-drag placement preserves left-drag text selection', async () => {
      const before = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => ({ id: el.dataset.sessionId, slot: el.dataset.slot })));
      assert.equal(before.length, 6);
      const mover = before.find((w) => w.slot === '2');
      const target = before.find((w) => w.slot === '0');
      // Transcript richness is unrelated to placement. Give the mover a known
      // paragraph so this interaction never depends on which corpus session
      // happens to occupy slot 2 under xvfb.
      await ev((id) => window.__setTranscriptForTest(id, {
        header: { working: false },
        blocks: [{ key: 'verify-selectable', kind: 'assistant', text: 'Selectable conversation text for native drag coverage.' }],
      }), mover.id);
      const conversationText = page.locator(`.win2[data-session-id="${mover.id}"] .conv p`).filter({ hasText: /\S/ }).first();
      await conversationText.waitFor({ state: 'visible', timeout: 4000 });
      const leftPointerAllowed = await ev((id) => document.querySelector(`.win2[data-session-id="${id}"] .conv p`)
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })), mover.id);
      assert.equal(leftPointerAllowed, true, 'left pointerdown remains native and is not prevented by tile dragging');
      const selectedText = await ev((id) => {
        const paragraph = document.querySelector(`.win2[data-session-id="${id}"] .conv p`);
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString();
      }, mover.id);
      assert.match(selectedText, /Selectable conversation text/, 'native browser selection covers conversation text');
      assert.equal(await page.locator('.win2.dragging').count(), 0, 'left-drag does not lift a window');

      const contextMenuAllowed = await ev((id) => document.querySelector(`.win2[data-session-id="${id}"]`)
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })), mover.id);
      assert.equal(contextMenuAllowed, false, 'tile suppresses the native context menu');

      const src = await page.locator(`.win2[data-session-id="${mover.id}"] .wh`).boundingBox();
      const dst = await page.locator(`.win2[data-session-id="${target.id}"]`).boundingBox();
      assert.ok(src && dst, 'drag source and target have geometry');
      await page.mouse.move(src.x + src.width / 2, src.y + 12);
      await page.mouse.down({ button: 'right' });
      for (let i = 1; i <= 20; i += 1) {
        await page.mouse.move(
          src.x + src.width / 2 + ((dst.x + dst.width / 2) - (src.x + src.width / 2)) * (i / 20),
          src.y + 12 + ((dst.y + 12) - (src.y + 12)) * (i / 20),
        );
        await page.waitForTimeout(12);
        if (i === 10) {
          const vis = await ev((id) => getComputedStyle(document.querySelector(`.win2[data-session-id="${id}"]`)).visibility, mover.id);
          assert.equal(vis, 'visible', 'lifted tile is visible mid-drag');
        }
      }
      await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(300);
      const after = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => ({ id: el.dataset.sessionId, slot: el.dataset.slot })));
      assert.equal(after.find((w) => w.id === mover.id).slot, '0', 'mover owns cell 0');
      assert.equal(after.find((w) => w.id === target.id).slot, '2', 'occupant swapped to cell 2');
      ok('stage: left-drag selects text; right-drag swaps cells with visible lift; native context menu suppressed');
    });

    await section('focus mode: one window takes the stage, collapse restores the grid', async () => {
      const wins = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => el.dataset.sessionId));
      assert.ok(wins.length >= 2, `needs 2+ open windows, has ${wins.length}`);
      const target = wins[1];
      await page.locator(`.win2[data-session-id="${target}"] .tile-focus`).click();
      await page.waitForSelector('.grid4.focus-mode', { timeout: 5000 });
      const visible = await page.$$eval('.win2:not(.slot)', (els) => els.filter((el) => el.offsetParent !== null).map((el) => el.dataset.sessionId));
      assert.deepEqual(visible, [target], 'only the focused window is visible');
      // The focused window fills the grid: its box matches the grid's inner box.
      const boxes = await page.evaluate((id) => {
        const g = document.querySelector('.grid4').getBoundingClientRect();
        const w = document.querySelector(`.win2[data-session-id="${id}"]`).getBoundingClientRect();
        return { gw: g.width, ww: w.width };
      }, target);
      assert.ok(boxes.ww > boxes.gw * 0.9, 'focused window spans the stage');
      // Persists across reload.
      await ev(() => window.location.reload());
      await page.waitForSelector('.grid4.focus-mode', { timeout: 20000 });
      ok('focus mode: focused window survives reload');
      await screenshot(page, 'all-focus-mode.png');
      await page.locator(`.win2[data-session-id="${target}"] .tile-focus`).click();
      await page.waitForFunction(() => !document.querySelector('.grid4.focus-mode'), null, { timeout: 5000 });
      const backCount = await page.$$eval('.win2:not(.slot)', (els) => els.filter((el) => el.offsetParent !== null).length);
      assert.ok(backCount >= 2, 'collapse restores the grid with every window back');
      ok('focus mode: expand button focuses, collapse returns to the grid');
    });

    await section('rail toggle button in the title bar hides and restores the rail', async () => {
      assert.ok(await page.locator('.rail-toggle-btn').count() === 1, 'rail toggle button present');
      await page.locator('.rail-toggle-btn').click();
      await page.waitForSelector('.rail-reopen-strip', { timeout: 5000 });
      assert.equal(await page.locator('.rail').count(), 0, 'rail hidden after button click');
      await page.locator('.rail-toggle-btn').click();
      await page.waitForSelector('.rail', { timeout: 5000 });
      ok('rail toggle button: one click hides, one click restores (mirrors Ctrl+B)');
    });

    await section('closing windows compacts slots and reflows the grid', async () => {
      await closeAllTiles();
      for (const session of deadSessions.slice(0, 4)) await openById(session.id);
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 4, null, { timeout: 10000 });

      const assertCompactStage = async (count, cols, rows, slots) => {
        assert.equal(await page.locator(`.grid4[data-grid-cols="${cols}"][data-grid-rows="${rows}"]`).count(), 1,
          `${count} windows use the ${cols}x${rows} layout`);
        assert.deepEqual(await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => Number(el.dataset.slot))), slots,
          `${count} survivors own compact slots`);
        const stored = await ev(() => JSON.parse(localStorage.getItem('harbor-slate-stage')));
        assert.deepEqual(stored.tiles.map((tile) => tile.slot).sort((a, b) => a - b), slots,
          `${count}-window compact slots are persisted`);
      };

      await assertCompactStage(4, 2, 2, [0, 1, 2, 3]);
      await page.locator(`.win2[data-slot="1"] .tile-close`).click();
      await assertCompactStage(3, 2, 2, [0, 1, 2]);
      assert.equal(await page.locator('.win2.slot').count(), 1, 'three windows retain the intentional new-session slot');

      await page.locator(`.win2[data-slot="1"] .tile-close`).click();
      await assertCompactStage(2, 2, 1, [0, 1]);
      assert.equal(await page.locator('.win2.slot').count(), 0, 'two windows have no stale new-session slot');

      await page.locator(`.win2[data-slot="0"] .tile-close`).click();
      await assertCompactStage(1, 1, 1, [0]);
      assert.equal(await page.locator('.win2.slot').count(), 0, 'one window has no stale new-session slot');
      ok('stage: close reflows 4 -> 3 -> 2 -> 1 and persists compact survivor slots');
    });

    await section('close windows back to empty stage', async () => {
      await closeAllTiles();
      await page.waitForSelector('.stage-empty', { timeout: 5000 });
      assert.equal(await page.locator('.ubar .send').isDisabled(), true, 'send disabled with no target');
      ok('stage: closing every window returns the empty stage; bar disarms');
    });

    await section('command bar: status row layout stays stable while typing', async () => {
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(500);
      // A rich dead session (real conversation, not hot) so the command bar is
      // stably drivable: a thin/hot pick can flip to watch-only mid-section and
      // disable the input.
      const meta = await richDeadId();
      assert.ok(meta, 'a dead session with assistant content exists');
      await openById(meta.id);
      await page.waitForSelector('.ubar-status .ustat-title', { timeout: 5000 });
      const title = await page.locator('.ubar-status .ustat-title').innerText();
      assert.ok(title.length > 0, 'status row shows session title');
      const project = await page.locator('.ubar-status .ustat-pj-name').innerText();
      assert.ok(project.length > 0, 'status row shows project');
      assert.equal(await page.locator('.ubar .hint').count(), 0, 'hint block removed');
      assert.equal(await page.locator('.ubar .tgt').count(), 0, 'target chip removed');
      const beforeStatus = await page.locator('.ubar-status').boundingBox();
      const beforeRow = await page.locator('.ubar-row').boundingBox();
      await page.locator('.ubar-input').type('x');
      const afterStatus = await page.locator('.ubar-status').boundingBox();
      const afterRow = await page.locator('.ubar-row').boundingBox();
      assert.deepEqual(afterStatus, beforeStatus, 'status row box stable across keystroke');
      assert.deepEqual(afterRow, beforeRow, 'input row box stable across keystroke');
      await screenshot(page, 'all-command-bar.png');
      ok('command bar: two-row layout; status row populated; typing does not shift layout');
      await page.locator('.ubar-input').fill('');
      await ev(() => {
        const png = Uint8Array.from([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
          0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
          0, 0, 0, 13, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 240,
          31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69,
          78, 68, 174, 66, 96, 130,
        ]);
        const transfer = new DataTransfer();
        transfer.items.add(new File([png], 'paste.png', { type: 'image/png' }));
        document.querySelector('.ubar-input').dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }));
      });
      await page.waitForSelector('.compose-attachments .image-chip img', { timeout: 5000 });
      assert.equal(await page.locator('.ubar-input').inputValue(), '', 'image paste does not insert a file path');
      assert.equal(await page.locator('.image-chip button').count(), 1, 'thumbnail chip has a remove button');
      await screenshot(page, 'all-command-bar-image-chip.png');
      // Clear the attachment so it does not ride along on later sections' sends
      // (a lingering image would make every subsequent text send try to attach
      // it, and the harness bash pane never confirms [Image #N]).
      await page.locator('.image-chip button').first().click();
      await page.waitForSelector('.compose-attachments', { state: 'detached', timeout: 4000 }).catch(() => {});
      assert.equal(await page.locator('.image-chip').count(), 0, 'attachment cleared after remove');
      ok('command bar: pasted image renders as a removable thumbnail chip, not path text');
      await closeAllTiles();
    });

    // ═══════════ COMMAND BAR: OUTSIDE-SESSION ADOPT REFUSAL ═══════════
    await section('adopt-on-send refusal renders honest error without context tee', async () => {
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(500);
      // Earlier sections setLink top-of-rail candidates to harness panes; a
      // linked session resolves a pane and can never arm the takeover chip
      // (diagnosed from the bar dump: enabled composer, zero chips). Pick a
      // candidate no prior section linked.
      const linked = new Set(Object.keys(await ev(() => window.harbor.links.get())));
      const meta = (await renderedDead(6)).find((candidate) => !linked.has(candidate.id));
      assert.ok(meta, 'an unlinked dead session available for takeover probe');
      await openById(meta.id);
      const teePath = path.join(os.homedir(), '.cache/harbor/context', `${meta.id}.json`);
      try { fs.unlinkSync(teePath); } catch { /* missing tee is the case under test */ }
      // The fabricated processAlive header races the window's REAL transcript
      // parse (a giant corpus file lands seconds later and overwrites it), so
      // re-push until the composer flips to the outside-session placeholder.
      let outside = false;
      for (let attempt = 0; attempt < 4 && !outside; attempt += 1) {
        await withTimeout(electronApp.evaluate(({ BrowserWindow }, sessionId) => {
          BrowserWindow.getAllWindows()[0].webContents.send('transcript:update', {
            sessionId,
            header: { processAlive: true, model: { name: 'Opus', id: 'claude-opus-4-8' } },
          });
        }, meta.id), 15000, 'electron.evaluate:adopt-setup');
        outside = await page.waitForFunction(
          () => /ends its outside terminal/.test(document.querySelector('.ubar-input')?.placeholder || ''),
          null, { timeout: 2500 },
        ).then(() => true).catch(() => false);
      }
      if (!outside) {
        const bar = await ev(() => ({
          chips: [...document.querySelectorAll('.resume-chip')].map((el) => el.className),
          placeholder: document.querySelector('.ubar-input')?.placeholder || null,
          disabled: document.querySelector('.ubar-input')?.disabled ?? null,
          selected: document.querySelector('.win2.sel')?.dataset.sessionId || null,
        }));
        assert.fail(`outside-session composer never appeared; bar state: ${JSON.stringify(bar)}`);
      }
      // There is no Take over chip: the send itself adopts (Pat's veto,
      // 2026-07-20), and a session Harbor cannot identify refuses honestly.
      assert.equal(await page.locator('.takeover-chip').count(), 0, 'no Take over chip renders');
      await page.locator('.ubar-input').fill('adopt probe');
      await page.locator('.ubar-input').press('Enter');
      await page.waitForFunction(
        () => {
          const phase = document.querySelector('.ubar-status .ustat-phase')?.textContent || '';
          return /cannot identify the owning process/i.test(phase);
        },
        null,
        { timeout: 15000 },
      );
      const phase = await page.locator('.ustat-phase').innerText();
      assert.match(phase, /cannot identify the owning process/i, `honest error surfaced: ${phase}`);
      ok('adopt-on-send: missing context tee refuses with cannot identify the owning process');

      // Changing a model on an outside session must SWITCH that session, not
      // launch a brand-new one (live-caught 2026-07-20, Pat: "the only route is
      // to create a new session"). The config modal gated its Apply-vs-Start
      // decision on a live drivable pane, so every outside/dead session silently
      // fell to "Start a new session". The button must now read Apply, and
      // clicking through must route the switch through the adopt IPC (which
      // refuses honestly here, proving it is NOT the new-session path).
      if (await page.locator('.mswitch').count()) {
        await page.locator('.mswitch').click();
        await page.waitForSelector('.config-modal select[aria-label="Model"]', { timeout: 15000 });
        const actionLabel = await page.locator('.new-session-start').innerText();
        assert.match(actionLabel, /^Apply$/i, `outside session reconfigures (button: "${actionLabel}", not "Start … session")`);
        await page.selectOption('.config-modal select[aria-label="Model"]', 'fable').catch(() => {});
        await page.locator('.new-session-start').click();
        await page.waitForFunction(
          () => /cannot identify the owning process/i.test(
            document.querySelector('.ubar-status .ustat-phase')?.textContent || ''),
          null, { timeout: 15000 },
        );
        ok('outside-session model switch reconfigures via adopt, never launches a new session');
      }
      await closeAllTiles();
    });

    // ═══════════ COMMAND BAR: DEAD SESSION ═══════════
    await section('dead session: Resume chip + typed send fire the resume path', async () => {
      // State hygiene: a failed earlier section can leave a window open with a
      // fabricated watch-only header, which would suppress the Resume chip.
      await closeAllTiles();
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(500);
      // A session linked to a harness pane by an earlier section resolves a
      // pane and shows a live bar, never the Resume chip; exclude them.
      const linkedIds = new Set(Object.keys(await ev(() => window.harbor.links.get())));
      const meta = await richDeadId(8, linkedIds);
      assert.ok(meta, 'an unlinked dead session with assistant content exists');
      await openById(meta.id);
      const resumeChip = await page.waitForSelector('.resume-chip', { timeout: 5000 })
        .then(() => true).catch(() => false);
      if (!resumeChip) {
        const bar = await ev(() => ({
          placeholder: document.querySelector('.ubar-input')?.placeholder || null,
          disabled: document.querySelector('.ubar-input')?.disabled ?? null,
          outside: /ends its outside terminal/.test(document.querySelector('.ubar-input')?.placeholder || ''),
        }));
        assert.fail(`Resume chip never rendered for ${meta.id}; bar state: ${JSON.stringify(bar)}`);
      }
      await page.locator('.resume-chip').click();
      // Poll for the launch instead of a single fixed check: the resume fires
      // after pane resolution + session-meta lookup, which is not instant on a
      // busy corpus. A launch that lands at 900ms is still correct.
      let fired = false;
      const resumeDeadline = Date.now() + 6000;
      while (Date.now() < resumeDeadline && !fired) {
        const calls = await launches();
        fired = calls.some((c) => Array.isArray(c.argv) && c.argv[0] === '--resume-id' && c.argv[1] === meta.id);
        if (!fired) await page.waitForTimeout(200);
      }
      assert.ok(fired, 'Resume chip fired claude-sessions --resume-id');
      // Let the doomed resume settle (fake exec spawns no pane, so it errors
      // after the shortened discovery timeout); a send for this session is
      // correctly refused while its resume is in flight.
      await page.waitForFunction(
        () => document.querySelector('.ubar-status .ustat-phase')?.textContent?.trim().startsWith('failed'),
        null, { timeout: 20000 },
      );
      ok('command bar: Resume chip resumes through bin/claude-sessions and narrates the failure honestly');
      await closeAllTiles();
    });

    // ═══════════ COMMAND BAR: LIVE PATH (isolated pty) ═══════════
    let liveMeta = null;
    let livePane = null;
    await section('live link: send delivers bytes; input clears', async () => {
      const paneInfo = await ev(() => (async () => {
        const state = await window.harbor.terminal.getState();
        const layout = Object.values(state.layouts || {})[0];
        const tab = (state.tabs || []).find((t) => t.tab_id === layout?.tab_id);
        return { paneId: layout?.panes?.[0]?.pane_id, workspaceId: tab?.workspace_id || null };
      })());
      assert.ok(paneInfo.paneId, 'harness pane exists');
      livePane = paneInfo;
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(500);
      // A rich dead session (has an assistant block, hence a model header) so
      // the config-modal sections that reuse liveMeta find the .mswitch chip
      // (which renders only when header.model is set), not a thin launch.
      const meta = await richDeadId();
      assert.ok(meta, 'a dead session with assistant content exists');
      liveMeta = meta;
      await openById(meta.id);
      await ev((p) => window.harbor.e2e.setLink(p), { sessionId: meta.id, ...paneInfo });
      await page.waitForSelector(`.win2[data-session-id="${meta.id}"] .ico.tty`, { timeout: 5000 });
      const marker = `harbor_verify_${Date.now()}`;
      // The send button disables while a prior send/resume for this session is
      // in flight; wait until the bar is genuinely armed.
      await page.waitForFunction(() => !document.querySelector('.ubar .send')?.disabled, null, { timeout: 10000 });
      await page.locator('.ubar-input').fill(marker);
      await page.keyboard.press('Enter');
      // The input clears ONLY on a successful send; if it doesn't, surface the
      // command bar's own failure line instead of a blind timeout.
      try {
        await page.waitForFunction(() => document.querySelector('.ubar-input')?.value === '', null, { timeout: 8000 });
      } catch {
        const status = await ev(() => document.querySelector('.ubar-status .ustat-phase')?.textContent?.trim() || '(no status)');
        const mainLinks = await ev(() => window.harbor.links.get());
        const hasSwitch = await page.locator('.mswitch').count();
        throw new Error(`send did not complete; bar says: ${status}; links=${JSON.stringify(mainLinks)}; mswitch=${hasSwitch}`);
      }
      let seen = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !seen) {
        try {
          const res = await verifyClient.readPane(paneInfo.paneId, { source: 'recent', lines: 30, strip_ansi: true });
          seen = (res?.read?.text || '').replace(/\s+/g, '').includes(marker);
        } catch { /* poll */ }
        if (!seen) await new Promise((r) => setTimeout(r, 300));
      }
      assert.ok(seen, 'typed marker reached the real pty');
      assert.equal(await ev(() => document.querySelector('.ubar-input').value), '', 'input cleared after send');
      ok('command bar: Enter delivers real bytes to the linked pty and clears');

      const linkedIds = new Set(Object.keys(await ev(() => window.harbor.links.get())));
      const second = (await renderedDead(8)).find((s) => s.id !== liveMeta.id && !linkedIds.has(s.id));
      if (second) {
        await openById(second.id);
        const draftB = `draft-b-${Date.now()}`;
        await page.locator(`.win2[data-session-id="${second.id}"] .conv`).click();
        await page.locator('.ubar-input').fill(draftB);
        await page.locator(`.win2[data-session-id="${liveMeta.id}"] .conv`).click();
        const marker2 = `draft_send_${Date.now()}`;
        await page.waitForFunction(() => !document.querySelector('.ubar .send')?.disabled, null, { timeout: 10000 });
        await page.locator('.ubar-input').fill(marker2);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.ubar-input')?.value === '', null, { timeout: 8000 });
        await page.locator(`.win2[data-session-id="${second.id}"] .conv`).click();
        assert.equal(await page.locator('.ubar-input').inputValue(), draftB, 'other window draft untouched after send');
        ok('command bar: send clears only the active session draft');
      } else {
        skip('send clears only active draft: no second session available');
      }
    });

    const openCapMenu = async () => {
      if (await page.locator('.config-modal').count() === 0) {
        await page.locator('.mswitch').click();
      }
      await page.waitForSelector('.config-modal', { timeout: 5000 });
      await page.waitForSelector('.config-modal .cap-sec-h', { timeout: 15000 });
      // The provider option lists and the session capabilities load async over
      // IPC; wait for the options-driven Effort section before asserting.
      await page.waitForFunction(() => [...document.querySelectorAll('.config-modal .cap-sec-h')]
        .some((h) => (h.textContent || '').toLowerCase().includes('effort')), { timeout: 15000 }).catch(() => {});
    };
    const ptySees = async (needle) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          const res = await verifyClient.readPane(livePane.paneId, { source: 'recent', lines: 100, strip_ansi: true });
          // The harness pane prints 'pane-N tick' noise every second, and a
          // narrow render wraps input mid-word: drop noise lines, join hard.
          if (((res?.read?.text || '').replace(/pane-\d+ tick \d{2}:\d{2}:\d{2}/g, '').replace(/\s+/g, '')).includes(needle)) return true;
        } catch { /* poll */ }
        await new Promise((r) => setTimeout(r, 300));
      }
      return false;
    };

    await section('provider config modal: all seven Claude sections render', async () => {
      assert.ok(liveMeta, 'live link established');
      await page.waitForSelector('.mswitch', { timeout: 8000 });
      await openCapMenu();
      const heads = await page.locator('.config-modal .cap-sec-h').allInnerTexts();
      // Section headers render uppercase via CSS text-transform; compare lower.
      const joined = heads.join(' | ').toLowerCase();
      for (const need of ['model', 'effort', 'permission mode', 'fast mode', 'workflow', 'plugins', 'slash commands']) {
        assert.ok(joined.includes(need), `capability section "${need}" present (saw: ${joined})`);
      }
      // Honesty rows: fast mode disabled with a reason; permission mode shows a read.
      assert.ok(await page.locator('.cap-row.disabled .cap-row-reason, .cap-action:has-text("/fast")').count() > 0, 'fast-mode row honest (disabled+reason or enabled insert)');
      assert.ok(await page.locator('.cap-status-val').count() > 0, 'permission-mode status row rendered');
      await screenshot(page, 'config-modal-claude.png');
      ok('config modal: models, effort, permission mode, fast mode, workflow, plugins, slash commands all render');
    });

    await section('config modal: slash-command search filters, and clicking inserts (never sends)', async () => {
      await openCapMenu();
      await page.waitForFunction(() => {
        const el = document.querySelector('.cap-sec-count');
        return el && Number((el.textContent || '0/0').split('/')[1]) > 0;
      }, { timeout: 15000 });
      const total = Number((await page.locator('.cap-sec-count').first().innerText()).split('/')[1]);
      assert.ok(total > 0, 'slash-command list built live');
      await page.locator('.cap-search').fill('model');
      // Filtering narrows the list (matches name OR description) while keeping
      // the /model builtin; that proves the live search works.
      await page.waitForFunction((t) => {
        const rows = [...document.querySelectorAll('.cap-cmd')];
        const names = rows.map((r) => r.querySelector('.cap-cmd-name')?.textContent || '');
        return rows.length > 0 && rows.length < t && names.includes('/model');
      }, total, { timeout: 5000 });
      ok('capability menu: command search filters the live list');
      // Insert-not-send: clicking a command drops "/name " into the draft and
      // closes the menu; that exact command must NOT reach the pty (no
      // auto-send). The model-switch section that DOES type /model runs later,
      // so /model cannot already be in this pane's recent output.
      await page.locator('.ubar-input').fill('');
      await page.locator('.cap-cmd', { hasText: '/model' }).first().click();
      await page.waitForSelector('.config-modal', { state: 'detached', timeout: 4000 });
      const draft = await page.locator('.ubar-input').inputValue();
      assert.match(draft, /\/model\s$/, `draft got the inserted command ("${draft}")`);
      await new Promise((r) => setTimeout(r, 700));
      const after = await verifyClient.readPane(livePane.paneId, { source: 'recent', lines: 40, strip_ansi: true }).then((r) => (r?.read?.text || '')).catch(() => '');
      assert.ok(!after.replace(/\s+/g, '').includes('/model'), 'insert did NOT type the command into the pty (never auto-sends)');
      await page.locator('.ubar-input').fill('');
      ok('capability menu: clicking a slash command inserts into the draft and never auto-sends');
    });

    await section('command bar: plus menu opens; slash insert does not send', async () => {
      assert.ok(liveMeta, 'live link established');
      await page.locator('.ubar-input').fill('');
      await page.locator('.ubar .attach').click();
      await page.waitForSelector('.plus-menu', { timeout: 5000 });
      const heads = await page.locator('.plus-menu .cap-sec-h, .plus-menu .plus-sec-label').allInnerTexts();
      const joined = heads.join(' | ').toLowerCase();
      for (const need of ['workflows', 'slash commands', 'connectors', 'plugins']) {
        assert.ok(joined.includes(need), `plus menu section "${need}" present (saw: ${joined})`);
      }
      assert.ok(await page.locator('.plus-action').count() >= 2, 'add files and folder actions present');
      assert.ok(await page.locator('.compose-mic').count() === 1, 'mic icon lives inside the composer row');
      assert.equal(await page.locator('.plus-menu .cap-search').count(), 0, 'slash commands collapsed by default');
      assert.equal(await page.locator('.plus-menu .plus-sec-toggle[aria-expanded="false"]').count(), 3,
        'slash, connectors, and plugins carets start collapsed');
      await screenshot(page, 'command-bar-mic.png');
      await page.locator('.plus-menu .plus-sec-toggle', { hasText: 'Slash commands' }).click();
      await page.waitForSelector('.plus-menu .cap-search', { timeout: 4000 });
      await screenshot(page, 'plus-menu-open.png');
      await page.waitForFunction(() => {
        const el = document.querySelector('.plus-menu .cap-sec-count');
        return el && Number((el.textContent || '0/0').split('/')[1]) > 0;
      }, { timeout: 15000 });
      await page.locator('.plus-menu .cap-search').fill('model');
      await page.locator('.plus-menu .cap-cmd', { hasText: '/model' }).first().click();
      await page.waitForSelector('.plus-menu', { state: 'detached', timeout: 4000 });
      const draft = await page.locator('.ubar-input').inputValue();
      assert.match(draft, /\/model\s$/, `plus menu inserted command into draft ("${draft}")`);
      await new Promise((r) => setTimeout(r, 700));
      const after = await verifyClient.readPane(livePane.paneId, { source: 'recent', lines: 40, strip_ansi: true }).then((r) => (r?.read?.text || '')).catch(() => '');
      assert.ok(!after.replace(/\s+/g, '').includes('/model'), 'plus menu insert did NOT type into the pty');
      await page.locator('.ubar-input').fill('');
      ok('command bar: plus menu caret sections collapse by default; slash insert is draft-only');
    });

    const ptyOrSendError = async (needle) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await ptySees1(needle)) return { ok: true };
        const phase = await page.locator('.ustat-phase').textContent().catch(() => '');
        if (/failed:/i.test(phase || '')) return { ok: false, error: phase };
        await new Promise((r) => setTimeout(r, 250));
      }
      const lastPhase = await page.locator('.ustat-phase').textContent().catch(() => '?');
      const linkMap = await page.evaluate(() => window.harbor.links.get()).catch(() => null);
      const screenTail = await verifyClient.readPane(linkMap?.[liveMeta.id]?.paneId || livePane.paneId, { source: 'recent', lines: 8, strip_ansi: true })
        .then((r) => JSON.stringify((r?.read?.text || '').split('\n').slice(-8))).catch((e) => `unreadable: ${e.message}`);
      return { ok: false, error: `no pty text within 10s; phase="${lastPhase}"; link=${JSON.stringify(linkMap?.[liveMeta.id] || null)}; screen=${screenTail}` };
    };
    const ptySees1 = async (needle) => {
      // Read the pane the APP is actually targeting right now (its live link
      // for the session), not the pane this harness captured earlier: launch
      // flows in between can legitimately re-link the session.
      let target = livePane.paneId;
      try {
        const linkMap = await page.evaluate(() => window.harbor.links.get());
        target = linkMap?.[liveMeta.id]?.paneId || target;
      } catch { /* fall back to the captured pane */ }
      try {
        const res = await verifyClient.readPane(target, { source: 'recent', lines: 100, strip_ansi: true });
        return ((res?.read?.text || '').replace(/pane-\d+ tick \d{2}:\d{2}:\d{2}/g, '').replace(/\s+/g, '')).includes(needle);
      } catch { return false; }
    };

    // The submit button reads "Apply" only while reconfiguring an existing
    // same-provider Claude session; when it does not, fail with the ACTUAL
    // button label and folder line so the state that broke it is named
    // instead of a bare locator timeout.
    const clickApply = async () => {
      const applyReady = await page.waitForFunction(
        () => document.querySelector('.config-modal .new-session-start')?.textContent === 'Apply',
        null, { timeout: 8000 },
      ).then(() => true).catch(() => false);
      if (!applyReady) {
        const state = await ev(() => ({
          button: document.querySelector('.config-modal .new-session-start')?.textContent || '(no button)',
          folder: document.querySelector('.config-folder')?.textContent || '(no folder line)',
          modalOpen: Boolean(document.querySelector('.config-modal')),
        }));
        assert.fail(`Apply not available: button="${state.button}" folder="${state.folder}" modalOpen=${state.modalOpen}`);
      }
      await page.locator('.config-modal .new-session-start').click();
    };

    await section('config modal: Apply sends /model and /effort in place', async () => {
      // The sequential harness exercises other modal/selection flows before
      // this section. Retarget the command bar to the known live linked session
      // so Apply is tested against a real drivable pane, never incidental state.
      await page.locator(`.win2[data-session-id="${liveMeta.id}"] .wh`).click({ position: { x: 6, y: 6 } });
      await page.waitForFunction((sessionId) => {
        const selected = document.querySelector(`.win2[data-session-id="${sessionId}"]`);
        return selected?.classList.contains('sel')
          && window.harbor.links.get().then((links) => Boolean(links?.[sessionId]?.paneId));
      }, liveMeta.id, { timeout: 10000 });
      assert.ok((await ev(() => window.harbor.links.get()))[liveMeta.id]?.paneId,
        'Apply target has a resolved live pane');
      // The main-process link registry updates before React necessarily commits
      // the matching selectedPane. The tty control is rendered from that same
      // resolved pane and is therefore the deterministic UI-side readiness
      // signal for the config request.
      await page.waitForSelector(`.win2[data-session-id="${liveMeta.id}"] .ico.tty`, { timeout: 10000 });
      await openCapMenu();
      await page.waitForFunction(() => document.querySelector('.config-folder')?.textContent
        ?.includes('Changes apply to this session'), null, { timeout: 5000 });
      await page.locator('.config-modal select[aria-label="Model"]').selectOption('haiku');
      const afterSelect = await ev(() => ({
        open: Boolean(document.querySelector('.config-modal')),
        btn: document.querySelector('.config-modal .new-session-start')?.textContent || null,
      }));
      assert.ok(afterSelect.open, `config modal closed by the model select itself: ${JSON.stringify(afterSelect)}`);
      await clickApply();
      // The submit stays open ("Working…") until the /model send completes,
      // then closes itself. Wait for THAT close before reopening: a reopened
      // modal would otherwise be killed by the first submit's trailing
      // onClose when it finally resolves (live-caught as "Apply not
      // available: modalOpen=false" on slow runs).
      await page.waitForSelector('.config-modal', { state: 'detached', timeout: 25000 });
      // bash's error line is the oracle: contiguous, noise-free, and it only
      // prints after Enter, so it proves the submit too.
      const m = await ptyOrSendError('bash:/model:');
      assert.ok(m.ok, `"/model haiku" reached the pty and submitted (${m.error || ''})`);
      ok('capability menu: model row sends /model to the session');

      // The first send stays in-flight through its delivery confirm (~3s); a
      // second send to the same session inside that window returns the first
      // send's promise (single-writer guard) and never delivers. Two SEPARATE
      // Applies is a test artifice (the modal's real single Apply sends model
      // then effort sequentially in one submit); wait for the first to settle.
      await page.waitForTimeout(3500);
      await openCapMenu();
      await page.waitForFunction(() => document.querySelector('.config-folder')?.textContent
        ?.includes('Changes apply to this session'), null, { timeout: 5000 });
      // Pick an effort DIFFERENT from the session's current one (clicking the
      // already-selected level is a no-op and sends nothing).
      const { chosen, index } = await page.evaluate(() => {
        const slider = document.querySelector('.config-modal .cap-effort-slider');
        const labels = [...document.querySelectorAll('.config-modal .cap-effort-ticks span')].map((node) => node.textContent.trim());
        const next = Number(slider?.value || 0) === labels.length - 1 ? 0 : Number(slider?.value || 0) + 1;
        return { chosen: labels[next], index: next };
      });
      await page.locator('.config-modal .cap-effort-slider').fill(String(index));
      assert.equal(await page.locator('.config-modal .cap-effort-slider').getAttribute('aria-valuetext'), chosen);
      await clickApply();
      await page.waitForSelector('.config-modal', { state: 'detached', timeout: 25000 });
      const e = await ptyOrSendError('bash:/effort:');
      assert.ok(e.ok, `"/effort ${chosen}" reached the pty and submitted (${e.error || ''})`);
      ok('capability menu: effort row sends /effort to the session');
    });

    await section('command bar: slash autocomplete flags valid vs unknown commands', async () => {
      // Reuse the live-linked session: capabilities (the slash-command list) are
      // loaded and the pane is a real pty, so the autocomplete is live and a
      // send actually delivers.
      await page.locator(`.win2[data-session-id="${liveMeta.id}"] .wh`).click({ position: { x: 6, y: 6 } });
      await page.waitForFunction(() => !document.querySelector('.ubar-input')?.disabled, null, { timeout: 8000 });
      const input = page.locator('.ubar-input');
      // V23: ordinary wrapped text must be painted only by the textarea. Slash
      // text uses the mirror, whose complete text geometry must match it.
      await input.fill('ordinary composer text\nwrapped onto a second line');
      assert.equal(await page.locator('.ubar-input-mirror').count(), 0,
        'ordinary multiline text does not render a duplicate mirror');
      assert.notEqual(await input.evaluate((node) => getComputedStyle(node).color), 'rgba(0, 0, 0, 0)',
        'ordinary multiline textarea remains visible');
      await input.fill('/model opus\nwith a wrapped slash-command argument');
      await page.waitForSelector('.ubar-input-mirror', { timeout: 4000 });
      const mirrorGeometry = await page.evaluate(() => {
        const inputNode = document.querySelector('.ubar-input');
        const mirror = document.querySelector('.ubar-input-mirror');
        const inputStyle = getComputedStyle(inputNode);
        const mirrorStyle = getComputedStyle(mirror);
        const inputRect = inputNode.getBoundingClientRect();
        const mirrorRect = mirror.getBoundingClientRect();
        const properties = ['fontFamily', 'fontSize', 'lineHeight', 'paddingTop', 'paddingRight',
          'paddingBottom', 'paddingLeft', 'whiteSpace', 'wordBreak', 'overflowWrap'];
        return {
          sameRect: Math.abs(inputRect.width - mirrorRect.width) < 0.5
            && Math.abs(inputRect.height - mirrorRect.height) < 0.5,
          rects: `input ${inputRect.width.toFixed(1)}x${inputRect.height.toFixed(1)} vs mirror ${mirrorRect.width.toFixed(1)}x${mirrorRect.height.toFixed(1)}`,
          differences: properties.filter((property) => inputStyle[property] !== mirrorStyle[property])
            .map((property) => `${property}: ${inputStyle[property]} != ${mirrorStyle[property]}`),
          token: mirror.querySelector('.slash-token')?.textContent || '',
        };
      });
      assert.equal(mirrorGeometry.sameRect, true, `slash mirror and textarea share width and height (${mirrorGeometry.rects})`);
      assert.deepEqual(mirrorGeometry.differences, [], `slash mirror wrapping styles align: ${mirrorGeometry.differences}`);
      assert.equal(mirrorGeometry.token, '/model', 'slash token remains separately colorable');
      // Typing a leading slash opens a live portal dropdown filtered against the
      // loaded commands; Tab completes to the real command and the hint reads ok.
      await input.fill('');
      await input.type('/mod');
      await page.waitForSelector('.slash-ac', { timeout: 8000 });
      assert.ok(await page.locator('.slash-ac .slash-ac-row').count() > 0, 'slash dropdown lists matching commands');
      await input.press('Tab');
      await page.waitForFunction(() => /\/model\s?$/.test(document.querySelector('.ubar-input')?.value || ''), null, { timeout: 4000 });
      await page.waitForSelector('.slash-hint.ok', { timeout: 4000 });
      // Completing the command SETS it and closes the popup (terminal behavior):
      // once a space moves past the command name, the dropdown is gone.
      await page.waitForSelector('.slash-ac', { state: 'detached', timeout: 4000 });
      // An unknown command flips the hint to bad and lists nothing.
      await input.fill('');
      await input.type('/zzznope');
      await page.waitForSelector('.slash-hint.bad', { timeout: 4000 });
      assert.equal(await page.locator('.slash-ac').count(), 0, 'no dropdown for an unknown command');
      await input.fill('');
      ok('command bar: slash autocomplete lists valid commands and flags unknown ones');
      // Send a marker so the next section starts from a clean input, and let the
      // delivery settle + control release before the tty section reuses this pane
      // (the send holds exclusive control through delivery; blur release is
      // debounced).
      await input.fill(`slash_probe_${Date.now()}`);
      await page.locator('.ubar .send').click();
      await page.waitForFunction(() => document.querySelector('.ubar-input')?.value === '', null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
    });

    await section('tty toggle: raw terminal renders and echoes typed input', async () => {
      await page.locator(`.win2[data-session-id="${liveMeta.id}"] .ico.tty`).click();
      await page.waitForSelector(`.win2[data-session-id="${liveMeta.id}"] .terminal-pane`, { timeout: 8000 });
      const rowsPainted = await page.waitForFunction((id) => {
        const rows = document.querySelector(`.win2[data-session-id="${id}"] .xterm-rows`);
        return rows && (rows.textContent || '').trim().length > 0;
      }, liveMeta.id, { timeout: 12000 }).then(() => true).catch(() => false);
      assert.ok(rowsPainted, 'tty: xterm rows never painted any pty content');
      // Input written before the control child's grant completes is dropped
      // silently by the daemon, and the toggle plus the preceding config/slash
      // sends churn acquire/release on this exact pane (live-caught: control
      // held, xterm focused, zero bytes echoed). Type-and-verify, retrying.
      const marker = `tty_echo_${Date.now()}`;
      let echoed = false;
      for (let attempt = 0; attempt < 3 && !echoed; attempt += 1) {
        await page.locator(`.win2[data-session-id="${liveMeta.id}"] .terminal-pane`).click();
        await page.waitForTimeout(900);
        await page.keyboard.type(`echo ${marker}`);
        await page.keyboard.press('Enter');
        echoed = await page.waitForFunction(({ id, m }) => {
          const rows = document.querySelector(`.win2[data-session-id="${id}"] .xterm-rows`);
          return rows && (rows.textContent || '').includes(m);
        }, { id: liveMeta.id, m: marker }, { timeout: 5000 }).then(() => true).catch(() => false);
      }
      if (!echoed) {
        const state = await ev(async (id) => ({
          controlled: (await window.harbor.terminal.getState())?.controlledPaneId || null,
          active: `${document.activeElement?.tagName}.${document.activeElement?.className || ''}`.slice(0, 60),
          rowsTail: (document.querySelector(`.win2[data-session-id="${id}"] .xterm-rows`)?.textContent || '').slice(-120),
        }), liveMeta.id);
        assert.fail(`tty: typed echo never came back through the pty; ${JSON.stringify(state)}`);
      }
      ok('tty: toggle shows the real terminal; typing echoes through the pty');
      await screenshot(page, 'all-tty-mode.png');
      await page.locator(`.win2[data-session-id="${liveMeta.id}"] .ico.tty`).click();
      await page.waitForSelector(`.win2[data-session-id="${liveMeta.id}"] .conv`, { timeout: 5000 });
      ok('tty: toggling back restores the conversation view');
      await closeAllTiles();
    });

    // ═══════════ STAGE PERSISTENCE ═══════════
    await section('stage restores across a renderer reload', async () => {
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(500);
      const picked = await renderedDead(2);
      await openById(picked[0].id);
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(500);
      await openById(picked[1].id);
      const orderBefore = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => el.dataset.sessionId));
      await ev(() => window.location.reload());
      await page.waitForSelector('.rail', { timeout: 20000 });
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 2, null, { timeout: 20000 });
      const orderAfter = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => el.dataset.sessionId));
      assert.deepEqual(orderAfter, orderBefore, 'reload preserves tile order');
      ok('stage: open windows and order survive a reload (localStorage restore)');
      await closeAllTiles();
    });

    await section('stage restores more than four windows across reload', async () => {
      const many = await ev(async () => {
        const state = await window.harbor.sidebar.getState();
        const picked = [];
        for (const proj of state.model.projects || []) {
          for (const s of proj.sessions || []) {
            if (s.isWindowsEra || s.isChildTask || s.isLive) continue;
            if (String(s.id).startsWith('live:')) continue;
            if (s.lastActiveMs && Date.now() - s.lastActiveMs < 15 * 60 * 1000) continue;
            picked.push({ id: s.id });
            if (picked.length >= 6) break;
          }
          if (picked.length >= 6) break;
        }
        return picked;
      });
      assert.ok(many.length >= 6, `need 6 sessions for restore test, got ${many.length}`);
      for (const s of many.slice(0, 6)) await openById(s.id);
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 6, null, { timeout: 15000 });
      const orderBefore = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => el.dataset.sessionId));
      const stored = await ev(() => JSON.parse(localStorage.getItem('harbor-slate-stage')));
      assert.equal(stored.tiles.length, 6, 'localStorage holds all six tiles');
      await ev(() => window.location.reload());
      await page.waitForSelector('.rail', { timeout: 20000 });
      await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 6, null, { timeout: 20000 });
      const orderAfter = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => el.dataset.sessionId));
      assert.deepEqual(orderAfter, orderBefore, 'six-window order survives reload');
      ok('stage: six open windows restore above the old cap of four');
      await closeAllTiles();
    });

    // ═══════════ ORCHESTRATION PANEL ═══════════
    await section('orchestration queue pill opens batch detail with ETA and events', async () => {
      await closeAllTiles();
      await page.locator('.rail-find').fill('harbor');
      await page.waitForTimeout(400);
      const meta = (await renderedDead(8)).find((session) => session.id);
      assert.ok(meta, 'fixture workspace has a session to open');
      await openById(meta.id);
      await page.waitForSelector('.orch-pill', { timeout: 10000 });
      assert.match(await page.locator('.orch-pill').innerText(), /Orch 4\/8.*sol/);
      await screenshot(page, 'all-orch-status-pill.png');
      await page.locator('.orch-pill').click();
      await page.waitForSelector('.orch-panel', { timeout: 10000 });
      // The panel loads its queue async; counting during the Loading state
      // reads 0 (live-caught). Wait for the populated card list.
      await page.waitForFunction(
        () => document.querySelectorAll('.orch-batch-card').length === 8,
        null,
        { timeout: 10000 },
      );
      assert.equal(await page.locator('.orch-batch-card').count(), 8, 'all fixture batches render');
      assert.match(await page.locator('.orch-eta').innerText(), /4\/8 complete.*ETA estimate:/s);
      assert.equal(await page.locator('.orch-event-row').count(), 2, 'event sidecar renders');
      assert.match(await page.locator('.orch-event-row').first().innerText(), /Fixture batch 4 completed/);
      ok('orchestration: workspace queue pill opens 8 batch rows, ETA, and newest-first events');
      await screenshot(page, 'all-orch-queue-detail.png');
      await page.locator('.orch-close-btn').click();
      await closeAllTiles();
    });

    await section('orchestration panel opens read-only with mutex refusal', async () => {
      await ev(() => (async () => {
        const state = await window.harbor.sidebar.getState();
        const project = (state.model.projects || []).find((p) => p.label === 'harbor');
        window.__openOrchForTest(project);
      })());
      await page.waitForSelector('.orch-panel', { timeout: 10000 });
      await ev(() => window.__forceOrchMutex('An orchestrate-execution session is already open in this workspace.'));
      await page.waitForTimeout(300);
      assert.ok(await page.locator('.orch-mutex-reason').count() > 0, 'mutex reason surfaced');
      assert.equal(await page.locator('.orch-execute-btn').isDisabled(), true, 'execute disabled under mutex');
      ok('orchestration: panel renders; mutex refusal disables execute');
      await screenshot(page, 'all-orch-panel.png');
      await page.locator('.orch-close-btn').click();
      await page.waitForSelector('.stage-empty', { timeout: 5000 });
    });

    // ═══════════ BANNERS + HELP ═══════════
    await section('update banner appears and dismisses', async () => {
      await eev(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:update-available'));
      await page.waitForSelector('.update-banner', { timeout: 5000 });
      await page.locator('.update-banner-dismiss').click();
      assert.equal(await page.locator('.update-banner').count(), 0, 'banner dismissed');
      ok('update banner: shows on dist change signal, dismisses');
    });

    await section('help overlay: F1 opens, content matches the Slate UI, Escape closes', async () => {
      await page.keyboard.press('F1');
      await page.waitForSelector('.help-panel', { timeout: 5000 });
      const text = await page.locator('.help-panel').innerText();
      assert.ok(/Ctrl\+1–4/.test(text), 'help teaches Ctrl+1-4');
      assert.ok(/command bar|Command bar/i.test(text), 'help teaches the command bar');
      await screenshot(page, 'all-help.png');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      assert.equal(await page.locator('.help-panel').count(), 0, 'Escape closes');
      ok('help overlay: F1 / content / Escape all correct');
    });

    // ═══════════ WORKERS (best effort: needs live workers) ═══════════
    await section('workers chip (skips without live workers)', async () => {
      if (await page.locator('.workers-chip').count() === 0) {
        skip('workers chip: no live orchestration workers in this run');
        return;
      }
      await page.locator('.workers-chip').click();
      await page.waitForSelector('.workers-menu', { timeout: 4000 });
      assert.ok(await page.locator('.workers-menu-item').count() > 0, 'worker rows listed');
      const closeBtn = page.locator('.workers-menu-close').first();
      await closeBtn.click();
      assert.ok((await closeBtn.innerText()).includes('close?'), 'first click arms, never kills');
      await page.keyboard.press('Escape');
      await ev(() => document.querySelector('.menu-backdrop')?.click());
      ok('workers chip: menu lists workers; close is two-click armed');
    });
  } finally {
    try { await closeHarbor(electronApp, page); } catch { /* teardown */ }
    try { harness.child.kill('SIGTERM'); } catch { /* teardown */ }
    teardownHarness();
    fs.rmSync(delegateFixtureDir, { recursive: true, force: true });
  }

  console.log('\n════════ SUMMARY ════════');
  console.log(`passed:  ${passes.length}`);
  console.log(`skipped: ${skips.length}`);
  console.log(`failed:  ${fails.length}`);
  if (sectionFilters.length) {
    console.log(`filtered: ${filteredOut.length} sections NOT run (--section ${sectionFilters.join(', ')})`);
    console.log('NOTE: a filtered run is a batch gate, never the ship gate.');
  }
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('verify-all crashed:', e);
  teardownHarness();
  process.exit(1);
});
