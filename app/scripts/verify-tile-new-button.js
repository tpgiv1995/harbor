'use strict';

/**
 * The window header's + button, measured at Pat's real geometry (2560x1600)
 * rather than eyeballed. Two questions the gate cannot answer, because the gate
 * runs under a default xvfb screen:
 *
 *   1. At every grid density, does every window still show project, title, a
 *      close button AND the new +, all inside its own box?
 *   2. Does clicking + record a launch carrying THIS window's folder and plan
 *      with the saved defaults, and no folder picker?
 *
 * Run: CLAUDE_GUI_GEOMETRY=2560x1600x24 claude-gui node scripts/verify-tile-new-button.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const APP_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_ROOT, 'verify', 'tile-new');

async function closeAllWindows(page) {
  for (let i = 0; i < 20; i += 1) {
    const closers = await page.locator('.win2:not(.slot) .tile-close').count();
    if (!closers) return;
    await page.locator('.win2:not(.slot) .tile-close').first().click();
    await page.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-tilenew-'));

  const electronApp = await electron.launch({
    executablePath: require('electron'),
    args: [APP_ROOT],
    env: {
      ...process.env,
      HARBOR_E2E: '1',
      HARBOR_E2E_FAKE_LAUNCH: '1',
      HARBOR_E2E_USER_DATA: path.join(scratch, 'userdata'),
      // The desktop harness spreads process.env and isolates neither of these,
      // so a drive run beside harbor-server reads a cache another process is
      // writing. Point them at scratch (handoff to-do 3).
      HARBOR_CONTEXT_DIR: path.join(scratch, 'context'),
      HARBOR_ARTIFACTS_CACHE: path.join(scratch, 'artifacts.json'),
      ELECTRON_DISABLE_GPU: '1',
    },
    cwd: APP_ROOT,
    timeout: 120000,
  });
  const page = await electronApp.firstWindow({ timeout: 120000 });
  await page.waitForSelector('.rail', { timeout: 30000 });
  await page.waitForFunction(() => window.__harborSidebarStats?.indexerSessionCount > 0, null, { timeout: 30000 });

  let viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

  const ids = await page.evaluate(async () => {
    const state = await window.harbor.sidebar.getState();
    const out = [];
    for (const proj of state.model.projects || []) {
      for (const s of proj.sessions || []) {
        if (s.isWindowsEra || s.isChildTask || s.isLive) continue;
        if (String(s.id).startsWith('live:')) continue;
        if (s.lastActiveMs && Date.now() - s.lastActiveMs < 15 * 60 * 1000) continue;
        out.push({ id: s.id, cwd: s.cwd, home: s.home, project: s.project });
        break; // one per project, so the grid shows distinct identities
      }
      if (out.length >= 12) break;
    }
    return out;
  });
  if (ids.length < 4) throw new Error(`need at least 4 candidate sessions, got ${ids.length}`);

  const failures = [];
  let launchCalls = [];

  // Pat's real geometry. He runs Harbor maximized on a 2560x1600 panel and
  // the header density rules are exactly what behaves differently at a
  // different width, so the measurement cannot be taken at the default size.
  // Bare Xvfb has no window manager, so maximize() does nothing; set bounds.
  await electronApp.evaluate(async ({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const area = screen.getPrimaryDisplay().workAreaSize;
    win.setBounds({ x: 0, y: 0, width: area.width, height: area.height });
  });
  await page.waitForTimeout(800);
  viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  console.log(`measuring at ${viewport.w}x${viewport.h}`);

  // Measure at each density the header rules key off: 1, 2, 3 and 4 columns.
  // Windows are only ever ADDED, so nothing depends on closing them cleanly.
  for (const count of [1, 2, 6, 12].filter((n) => n <= ids.length)) {
    await page.evaluate(async (list) => {
      for (const s of list) await window.__harborOpenSession(s.id);
    }, ids.slice(0, count));
    await page.waitForFunction(
      (n) => document.querySelectorAll('.win2:not(.slot)').length === n,
      count,
      { timeout: 20000 },
    );
    await page.waitForTimeout(400);

    const cols = await page.getAttribute('.grid4', 'data-grid-cols');
    const rows = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => {
      const box = el.getBoundingClientRect();
      const pick = (sel) => {
        const node = el.querySelector(sel);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
      };
      return {
        project: el.querySelector('.pj')?.textContent || '',
        title: el.querySelector('.ti')?.textContent || '',
        box: { x: Math.round(box.x), right: Math.round(box.right), w: Math.round(box.width) },
        plus: pick('.tile-new'),
        close: pick('.tile-close'),
        who: pick('.who'),
        headerScrollW: Math.round(el.querySelector('.wh').scrollWidth),
        headerClientW: Math.round(el.querySelector('.wh').clientWidth),
      };
    }));

    for (const [i, r] of rows.entries()) {
      const where = `${count} windows (cols=${cols}) window ${i}`;
      if (!r.plus) failures.push(`${where}: no + button`);
      if (!r.close) failures.push(`${where}: no close button`);
      if (!r.project) failures.push(`${where}: project name empty`);
      if (!r.title) failures.push(`${where}: title empty`);
      if (r.who && r.who.w < 40) failures.push(`${where}: identity squeezed to ${r.who.w}px`);
      for (const [name, m] of [['plus', r.plus], ['close', r.close]]) {
        if (!m) continue;
        if (m.w < 12 || m.h < 12) failures.push(`${where}: ${name} collapsed to ${m.w}x${m.h}`);
        if (m.right > r.box.right + 1 || m.x < r.box.x - 1) {
          failures.push(`${where}: ${name} outside the window box (${m.x}..${m.right} vs ${r.box.x}..${r.box.right})`);
        }
      }
      if (r.headerScrollW > r.headerClientW + 1) {
        failures.push(`${where}: header overflows (${r.headerScrollW} > ${r.headerClientW})`);
      }
    }
    console.log(`${count} windows, cols=${cols}: + present on ${rows.filter((r) => r.plus).length}/${rows.length}, `
      + `close on ${rows.filter((r) => r.close).length}/${rows.length}, `
      + `narrowest identity ${Math.min(...rows.map((r) => r.who?.w ?? 0))}px`);
    await page.screenshot({ path: path.join(OUT_DIR, `tile-new-${count}-windows.png`) });
  }

  // The click proof runs LAST, deliberately. launchNewSession asks the daemon
  // for its pane set before it shells out, so a click fired seconds after boot
  // never reaches the launch at all: an earlier version of this drive read
  // that as "the button is not wired" and, worse, hid it behind a direct-IPC
  // fallback that reported PASS. By here the app has been up through four
  // density measurements.
  await closeAllWindows(page);
  await proveLaunch();

  fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify({ viewport, launchCalls, failures }, null, 2));

  await electronApp.close({ force: true }).catch(() => {});
  try { electronApp.process()?.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(scratch, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\nFAIL (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nPASS: + present and inside the box at every density; launch carries the clicked window\'s project and plan and the saved defaults');

  // The launch itself: click + on the SECOND window while the FIRST is
  // selected, so a launch that read the SELECTION instead of the clicked
  // window is caught rather than passing by coincidence.
  async function proveLaunch() {
  const pair = ids.slice(0, 2);
  await page.evaluate(async (list) => {
    for (const s of list) await window.__harborOpenSession(s.id);
  }, pair);
  await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 2, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.locator(`.win2[data-session-id="${pair[0].id}"]`).click({ position: { x: 200, y: 200 } });
  await page.waitForTimeout(200);

  console.log(`+ clicked on ${pair[1].project} (${pair[1].home}) while ${pair[0].project} is selected`);
  const before = (await page.evaluate(() => window.harbor.e2e.getLaunchCalls())).length;
  page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));
  await page.locator(`.win2[data-session-id="${pair[1].id}"] .tile-new`).click();
  // The launch is async behind IPC. NOTE: a waitForFunction predicate that
  // RETURNS a promise is always truthy and so never waits at all, which is how
  // this drive twice reported "clicking + recorded no launch" against a button
  // that worked. Poll the resolved value.
  for (let i = 0; i < 60; i += 1) {
    const n = (await page.evaluate(() => window.harbor.e2e.getLaunchCalls())).length;
    if (n > before) break;
    await page.waitForTimeout(250);
  }
  // No fallback path here on purpose. The first run of this drive papered over
  // a click that never fired by calling the IPC directly, and reported PASS.
  const calls = await page.evaluate(() => window.harbor.e2e.getLaunchCalls());
  launchCalls = calls;
  const call = calls[calls.length - 1];
  const target = pair[1];
  if (calls.length <= before) { failures.push('clicking + recorded no launch at all'); return; }
  if (calls.length > before + 1) failures.push(`one click recorded ${calls.length - before} launches`);

  const argv = (call.argv || []).join(' ');
  const cwd = call.options?.cwd;
  const homeDir = await page.evaluate(async (home) => {
    const options = await window.harbor.session.newOptions();
    const list = options?.profiles || [];
    return (list.find((p) => p.id === home) || list.find((p) => p.isDefault) || list[0])?.configHome || null;
  }, target.home);
  console.log(`  argv: ${argv}`);
  console.log(`  cwd:  ${cwd}`);
  if (cwd !== target.cwd) failures.push(`launch cwd ${cwd} is not the clicked window's ${target.cwd}`);
  if (homeDir && !argv.includes(`--home ${homeDir}`)) {
    failures.push(`launch is not on the clicked window's plan (${target.home} -> ${homeDir}): ${argv}`);
  }
  if (!/--model opus/.test(argv)) failures.push(`launch argv missing the default model: ${argv}`);
  if (!/--effort xhigh/.test(argv)) failures.push(`launch argv missing the default effort: ${argv}`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
