'use strict';

/**
 * The mobile client as PAT sees it: the real harbor-server, his real sessions,
 * at a real iPhone viewport, on a real clock. The gate's screenshots are all
 * fixture data ("Measured mobile line 21", a project called
 * harbor-mobile-e2e-project), which is exactly how a client can be 11/0 green
 * and still be unusable.
 *
 * Read-only: it browses and screenshots, it never sends.
 *
 * Run: CLAUDE_GUI_GEOMETRY=600x1100x24 claude-gui node scripts/capture-mobile-live.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const APP_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_ROOT, 'verify', 'mobile-live');
const VIEWPORT = { width: 430, height: 932 };
const SERVER = process.env.HARBOR_LIVE_SERVER || 'http://127.0.0.1:8787';
const TOKEN_FILE = path.join(os.homedir(), '.config', 'harbor', 'server-token');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mobile-live-'));

  const mainPath = path.join(dir, 'main.js');
  fs.writeFileSync(mainPath, [
    "'use strict';",
    "const { app, BrowserWindow } = require('electron');",
    'app.whenReady().then(() => {',
    `  const win = new BrowserWindow({ width: ${VIEWPORT.width}, height: ${VIEWPORT.height}, useContentSize: true, show: true });`,
    "  win.loadURL('about:blank');",
    '});',
  ].join('\n'));

  const electronApp = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', mainPath],
    cwd: APP_ROOT,
    env: { ...process.env },
    timeout: 60000,
  });
  const page = await electronApp.firstWindow({ timeout: 60000 });
  await page.setViewportSize(VIEWPORT);
  page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') console.error('CONSOLE:', msg.text()); });
  await page.addInitScript(({ serverUrl, tok }) => {
    localStorage.setItem('harbor-web-server', serverUrl);
    localStorage.setItem('harbor-web-token', tok);
    localStorage.removeItem('harbor-web-open');
    localStorage.removeItem('harbor-web-active');
    // This drive reuses the default Electron profile, so browser prefs SURVIVE
    // between runs. Leaving them made a second run start on whatever filter the
    // first run clicked, and "48h -> All changed nothing" was my own harness
    // lying to me, not the control being dead.
    localStorage.removeItem('harbor-web-browser-prefs');
    localStorage.removeItem('harbor-web-browser-collapse');
  }, { serverUrl: SERVER, tok: token });

  await page.goto(`${SERVER}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 25000 });
  await page.waitForTimeout(2500);

  const shot = async (name) => {
    const target = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: target });
    const overflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    console.log(`  ${name}.png  (scrollWidth ${overflow.scrollW} / ${overflow.clientW})`);
  };

  await shot('01-landing');

  // The session browser.
  const browserBtn = page.locator('.hdr-session, [aria-label="Switch session"]').first();
  if (await browserBtn.count()) {
    await browserBtn.click();
    await page.waitForTimeout(1200);
    await shot('02-session-browser');

    // Drive the new controls rather than admiring them.
    const before = await page.locator('.session-browser .session-row').count();
    const filterBtn = page.locator('.browser-filter-toggle');
    if (await filterBtn.count()) {
      await filterBtn.click();
      await page.waitForTimeout(500);
      await shot('02b-filter-panel');
      const allChip = page.locator('.browser-filter-chip', { hasText: 'All' }).first();
      if (await allChip.count()) {
        await allChip.click();
        await page.waitForTimeout(900);
        const after = await page.locator('.session-browser .session-row').count();
        console.log(`  filter 48h->All changed rows: ${before} -> ${after} ${after > before ? 'OK' : 'NO CHANGE (suspect)'}`);
      }
      await filterBtn.click();
      await page.waitForTimeout(400);
    }
    const header = page.locator('.session-browser .project-header').first();
    if (await header.count()) {
      const rowsBefore = await page.locator('.session-browser .session-row').count();
      await header.click();
      await page.waitForTimeout(600);
      const rowsAfter = await page.locator('.session-browser .session-row').count();
      console.log(`  collapse first project: ${rowsBefore} -> ${rowsAfter} rows ${rowsAfter < rowsBefore ? 'OK' : 'NO CHANGE (suspect)'}`);
      await shot('02c-group-collapsed');
      await header.click();
      await page.waitForTimeout(500);
    }

    // Open the first real session row.
    // Skip fresh "✳ Claude Code" rows: a session with no transcript shows the
    // empty state, which is not what the conversation surface needs proving.
    const rows = page.locator('.session-browser .session-row');
    const titles = await rows.locator('.session-title').allInnerTexts();
    const index = Math.max(0, titles.findIndex((t) => !/^✳/.test(t.trim())));
    const row = rows.nth(index);
    if (await row.count()) {
      await row.click();
      await page.waitForTimeout(3500);
      await shot('03-conversation');
    }
  }

  // Scrolled into the conversation body, where message rendering shows.
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(800);
  await shot('04-conversation-scrolled');

  // Tasks.
  const tasksTab = page.locator('.nav-item', { hasText: 'Tasks' }).first();
  if (await tasksTab.count()) {
    await tasksTab.click();
    await page.waitForTimeout(1500);
    await shot('05-tasks');
  }

  // Whatever else the bottom nav offers.
  const navLabels = await page.$$eval('.nav-item', (els) => els.map((el) => el.textContent.trim()));
  console.log('bottom nav:', JSON.stringify(navLabels));

  const dom = await page.evaluate(() => ({
    classes: Array.from(document.querySelectorAll('[class]'))
      .flatMap((el) => Array.from(el.classList))
      .filter((c, i, a) => a.indexOf(c) === i).sort(),
  }));
  fs.writeFileSync(path.join(OUT_DIR, 'dom-classes.json'), JSON.stringify(dom, null, 2));

  await electronApp.close({ force: true }).catch(() => {});
  try { electronApp.process()?.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nwrote ${OUT_DIR}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
