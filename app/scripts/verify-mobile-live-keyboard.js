'use strict';

/**
 * MY verification, not a worker's. Drives the LIVE harbor-server at a real
 * iPhone viewport, opens the keyboard the way iOS actually signals it
 * (visualViewport shrinks; window.innerHeight does NOT), and measures.
 *
 * The shim is the honest way to test this locally: iOS standalone PWAs ignore
 * interactive-widget=resizes-visual, so the ONLY signal the app gets is a
 * visualViewport resize. Shimming that signal tests the app's response to the
 * real event. What it cannot prove is that iOS sends it, which the codebase
 * comment and Pat's own screenshot already establish.
 *
 * Run: CLAUDE_GUI_GEOMETRY=700x1200x24 claude-gui node scripts/verify-mobile-live-keyboard.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const APP_ROOT = path.join(__dirname, '..');
const OUT = path.join(APP_ROOT, 'verify', 'my-mobile-check');
const VIEWPORT = { width: 430, height: 932 };
const KEYBOARD_H = 472;               // iPhone 14 Pro Max QWERTY, portrait
const VISUAL_H = VIEWPORT.height - KEYBOARD_H;  // 460
const SERVER = process.env.HARBOR_LIVE_SERVER || 'http://127.0.0.1:8787';
const TOKEN_FILE = path.join(os.homedir(), '.config', 'harbor', 'server-token');

const SHIM = (visualH) => {
  const vv = window.visualViewport;
  if (!vv) throw new Error('no visualViewport');
  if (!window.__kbShimmed) {
    window.__realVVHeight = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(vv), 'height',
    ) || Object.getOwnPropertyDescriptor(vv, 'height');
    window.__kbShimmed = true;
  }
  Object.defineProperty(vv, 'height', { configurable: true, get: () => window.__kbHeight });
  window.__kbHeight = visualH;
  vv.dispatchEvent(new Event('resize'));
};

const UNSHIM = () => {
  const vv = window.visualViewport;
  window.__kbHeight = window.innerHeight;
  vv.dispatchEvent(new Event('resize'));
};

const MEASURE = (keyboardTop) => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      sel, top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right),
      h: Math.round(r.height), w: Math.round(r.width),
    };
  };
  const fixed = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (s.position !== 'fixed') continue;
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    if (el.getAttribute('aria-hidden') === 'true' || s.pointerEvents === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.height < 2) continue;
    fixed.push({
      cls: String(el.className).split(/\s+/).slice(0, 2).join('.'),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
    });
  }
  let overlap = null;
  for (let i = 0; i < fixed.length; i += 1) {
    for (let j = i + 1; j < fixed.length; j += 1) {
      const a = fixed[i]; const b = fixed[j];
      const ov = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ov > 4) overlap = { a: a.cls, b: b.cls, px: Math.round(ov) };
    }
  }
  const convBlocks = document.querySelectorAll('.conv-body > *');
  const last = convBlocks.length ? convBlocks[convBlocks.length - 1].getBoundingClientRect() : null;
  return {
    innerHeight: window.innerHeight,
    visualHeight: Math.round(window.visualViewport.height),
    keyboardTop,
    shellH: Math.round(document.querySelector('.app-shell')?.getBoundingClientRect().height || 0),
    composer: box('.composer'),
    textarea: box('.composer textarea'),
    nav: box('.shell-bottom-anchor'),
    navDisplay: getComputedStyle(document.querySelector('.shell-bottom-anchor') || document.body).display,
    lastBlockBottom: last ? Math.round(last.bottom) : null,
    fixedBars: fixed,
    fixedOverlap: overlap,
    docScrollH: document.documentElement.scrollHeight,
    docClientH: document.documentElement.clientHeight,
    scrollY: window.scrollY,
  };
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mycheck-'));
  const mainPath = path.join(dir, 'main.js');
  fs.writeFileSync(mainPath, [
    "'use strict';",
    "const { app, BrowserWindow } = require('electron');",
    'app.whenReady().then(() => {',
    `  const w = new BrowserWindow({ width: ${VIEWPORT.width}, height: ${VIEWPORT.height}, useContentSize: true, show: true });`,
    "  w.loadURL('about:blank');",
    '});',
  ].join('\n'));

  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', mainPath],
    cwd: APP_ROOT,
    env: { ...process.env },
    timeout: 60000,
  });
  const page = await app.firstWindow({ timeout: 60000 });
  await page.setViewportSize(VIEWPORT);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.addInitScript(({ url, tok }) => {
    localStorage.setItem('harbor-web-server', url);
    localStorage.setItem('harbor-web-token', tok);
    localStorage.removeItem('harbor-web-open');
    localStorage.removeItem('harbor-web-active');
  }, { url: SERVER, tok: token });
  await page.goto(`${SERVER}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 25000 });
  await page.waitForTimeout(2500);

  // Open a session with real content.
  await page.locator('.hdr-session').click();
  await page.waitForSelector('.session-browser');
  const rows = page.locator('.session-browser .session-row');
  const titles = await rows.locator('.session-title').allInnerTexts();
  const idx = Math.max(0, titles.findIndex((t) => !/^✳/.test(t.trim())));
  await rows.nth(idx).click();
  await page.waitForTimeout(3000);

  const report = { server: SERVER, viewport: VIEWPORT, keyboardHeight: KEYBOARD_H };

  report.closed = await page.evaluate(MEASURE, VIEWPORT.height);
  await page.screenshot({ path: path.join(OUT, 'kb-closed.png') });

  // Focus the composer, then signal the keyboard exactly as iOS does.
  await page.locator('.composer textarea').click();
  await page.waitForTimeout(300);
  await page.evaluate(SHIM, VISUAL_H);
  await page.waitForTimeout(900);
  await page.locator('.composer textarea').fill('typing with the keyboard up, can I see this line?');
  await page.waitForTimeout(600);

  report.open = await page.evaluate(MEASURE, VISUAL_H);
  await page.screenshot({ path: path.join(OUT, 'kb-open.png'), clip: { x: 0, y: 0, width: VIEWPORT.width, height: VISUAL_H } });
  await page.screenshot({ path: path.join(OUT, 'kb-open-full.png') });

  await page.evaluate(UNSHIM);
  await page.waitForTimeout(700);
  report.reclosed = await page.evaluate(MEASURE, VIEWPORT.height);
  await page.screenshot({ path: path.join(OUT, 'kb-reclosed.png') });

  // Settings must not tear down the connection.
  const connectsBefore = await page.evaluate(() => window.__harborConnects ?? null);
  const gear = page.locator('[aria-label="Settings"], .btn-ghost').first();
  const settings = { hadControl: (await gear.count()) > 0 };
  if (settings.hadControl) {
    await gear.click();
    await page.waitForTimeout(900);
    settings.connectionWithSheet = await page.getAttribute('.app-shell', 'data-connection');
    settings.connectScreenVisible = (await page.locator('.connect-card, .connect-screen').count()) > 0;
    settings.sheetVisible = (await page.locator('.settings-sheet, .sheet-panel').count()) > 0;
    await page.screenshot({ path: path.join(OUT, 'settings-open.png') });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    settings.connectionAfter = await page.getAttribute('.app-shell', 'data-connection');
  }
  settings.connectsBefore = connectsBefore;
  report.settings = settings;
  report.consoleErrors = errors;

  // Verdict, computed here rather than asserted by prose.
  const o = report.open;
  const kbTop = VISUAL_H;
  report.checks = {
    composerFullyAboveKeyboard: Boolean(o.composer && o.composer.bottom <= kbTop + 1 && o.composer.top >= 0),
    textareaVisible: Boolean(o.textarea && o.textarea.bottom <= kbTop + 1 && o.textarea.top >= 0),
    lastBlockAboveComposer: Boolean(o.lastBlockBottom !== null && o.composer && o.lastBlockBottom <= o.composer.top + 1),
    noFixedOverlap: o.fixedOverlap === null,
    documentDoesNotScroll: o.docScrollH <= o.docClientH + 1 && o.scrollY === 0,
    shellShrankToKeyboard: Math.abs(o.shellH - kbTop) <= 2,
    settingsKeptConnection: settings.hadControl
      ? settings.connectionWithSheet === 'online' && settings.connectionAfter === 'online'
      : null,
    settingsDidNotShowTokenForm: settings.hadControl ? settings.connectScreenVisible === false : null,
    noConsoleErrors: errors.length === 0,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  const failed = Object.entries(report.checks).filter(([, v]) => v === false);
  console.log(JSON.stringify(report.checks, null, 2));
  console.log(`\nkeyboard open: shell=${o.shellH} composer=${o.composer?.top}..${o.composer?.bottom} `
    + `textarea=${o.textarea?.top}..${o.textarea?.bottom} kbTop=${kbTop} nav=${o.navDisplay}`);
  if (errors.length) console.log('console errors:', errors.slice(0, 5));

  await app.close({ force: true }).catch(() => {});
  try { app.process()?.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(dir, { recursive: true, force: true });

  if (failed.length) {
    console.error(`\nFAIL: ${failed.map(([k]) => k).join(', ')}`);
    process.exit(1);
  }
  console.log('\nPASS (my own drive, not a worker report)');
}

main().catch((e) => { console.error(e); process.exit(1); });
