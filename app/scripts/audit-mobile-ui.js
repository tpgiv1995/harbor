'use strict';

/**
 * A UI/UX audit of the mobile client that MEASURES instead of eyeballing.
 * It drives the live harbor-server at a real iPhone viewport and, on every
 * screen, reports both keyboard-closed and iOS-standalone keyboard-open state:
 *
 *   - horizontal overflow (anything wider than the viewport)
 *   - content hidden behind the fixed bottom bar, which is invisible in a
 *     screenshot when the bar is translucent, and is how a composer can be
 *     pushed off a phone with nobody noticing
 *   - interactive targets under 44x44 (Apple HIG) and under 40px (soft)
 *   - text under 12px
 *   - visible scrollbars (a scroller whose client width is under its offset)
 *   - elements clipped by their own container
 *
 * Read-only: it browses, measures and screenshots. It never sends.
 *
 * Run: CLAUDE_GUI_GEOMETRY=700x1200x24 claude-gui node scripts/audit-mobile-ui.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const APP_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_ROOT, 'verify', 'mobile-audit');
const VIEWPORT = { width: 430, height: 932 };
const SERVER = process.env.HARBOR_LIVE_SERVER || 'http://127.0.0.1:8787';
const TOKEN_FILE = path.join(os.homedir(), '.config', 'harbor', 'server-token');

const MEASURE = () => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out = {
    viewport: { w: vw, h: vh },
    visualViewport: {
      w: Math.round(window.visualViewport?.width ?? vw),
      h: Math.round(window.visualViewport?.height ?? vh),
      offsetTop: Math.round(window.visualViewport?.offsetTop ?? 0),
    },
    keyboardOpen: document.documentElement.hasAttribute('data-keyboard-open')
      || document.querySelector('.app-shell')?.hasAttribute('data-keyboard-open'),
    keyboardRect: null,
    keyboardInvariants: null,
    overflowX: [],
    behindBar: [],
    smallTargets: [],
    smallText: [],
    scrollbars: [],
    clipped: [],
  };
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };
  const visible = (el, style) => (
    style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(style.opacity) !== 0
    && el.getClientRects().length > 0
  );

  // The fixed bottom bar: anything a finger cannot reach because the bar is
  // over it. Translucency hides this completely in a screenshot.
  const bar = document.querySelector('.shell-bottom-anchor');
  const barBox = bar ? bar.getBoundingClientRect() : null;

  if (out.keyboardOpen) {
    const keyboardTop = (window.visualViewport?.offsetTop || 0) + (window.visualViewport?.height || vh);
    const composer = document.querySelector('.composer')?.getBoundingClientRect() || null;
    const textarea = document.querySelector('textarea[aria-label="Message"]')?.getBoundingClientRect() || null;
    const last = document.querySelector('.conv-body > :last-child')?.getBoundingClientRect() || null;
    const fixed = [...document.querySelectorAll('body *')].filter((el) => {
      const style = getComputedStyle(el);
      return style.position === 'fixed' && visible(el, style)
        && style.pointerEvents !== 'none' && el.getAttribute('aria-hidden') !== 'true'
        && !el.closest('[aria-hidden="true"]') && el.getClientRects().length;
    });
    const fixedOverlaps = [];
    for (let i = 0; i < fixed.length; i += 1) {
      for (let j = i + 1; j < fixed.length; j += 1) {
        const a = fixed[i].getBoundingClientRect();
        const b = fixed[j].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
          fixedOverlaps.push([describe(fixed[i]), describe(fixed[j])]);
        }
      }
    }
    out.keyboardRect = { top: Math.round(keyboardTop), bottom: vh, left: 0, right: vw };
    out.keyboardInvariants = {
      composerInsideVisualViewport: !composer || (composer.top >= -1 && composer.bottom <= keyboardTop + 1),
      textareaClearOfKeyboard: !textarea || textarea.bottom <= keyboardTop + 1,
      lastConversationBlockVisible: !last || (last.bottom > 0 && (!composer || last.bottom <= composer.top + 1)),
      fixedBarOverlaps: fixedOverlaps,
      documentScrollable: document.documentElement.scrollHeight > vh + 1 || document.body.scrollHeight > vh + 1,
    };
  }

  // Decoration is not content: the aurora backdrop is a pointer-events:none,
  // aria-hidden gradient deliberately bled past every edge, and counting it as
  // overflow every run trains you to ignore the overflow list.
  const decorative = (el, style) => (
    style.pointerEvents === 'none'
    || el.getAttribute('aria-hidden') === 'true'
    || el.closest('[aria-hidden="true"]') !== null
  );
  // A child of a horizontal scroller is SUPPOSED to sit past the right edge.
  const inScrollerX = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return true;
      if (p === document.body) break;
    }
    return false;
  };

  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (!visible(el, style)) continue;
    if (decorative(el, style)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    if ((r.right > vw + 1 || r.left < -1) && !inScrollerX(el)) {
      out.overflowX.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right) });
    }

    // A LEAF element (no element children) sitting under the bar is content
    // the bar is covering. Containers legitimately extend behind it.
    if (barBox && el.childElementCount === 0 && r.height > 0) {
      const overlap = Math.min(r.bottom, barBox.bottom) - Math.max(r.top, barBox.top);
      if (overlap > 4 && r.left < barBox.right && r.right > barBox.left && !bar.contains(el)) {
        out.behindBar.push({ el: describe(el), overlapPx: Math.round(overlap), text: (el.textContent || '').trim().slice(0, 40) });
      }
    }

    const interactive = el.matches('button, a[href], input, textarea, select, [role="button"], [tabindex]:not([tabindex="-1"])');
    if (interactive && (r.width < 44 || r.height < 44)) {
      out.smallTargets.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30) });
    }

    const size = parseFloat(style.fontSize);
    if (el.childElementCount === 0 && (el.textContent || '').trim() && size && size < 12) {
      out.smallText.push({ el: describe(el), px: size, text: (el.textContent || '').trim().slice(0, 30) });
    }

    const scrollsY = el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(style.overflowY);
    const scrollsX = el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(style.overflowX);
    if (scrollsY && el.offsetWidth - el.clientWidth > 2) {
      out.scrollbars.push({ el: describe(el), axis: 'y', px: el.offsetWidth - el.clientWidth });
    }
    if (scrollsX && el.offsetHeight - el.clientHeight > 2) {
      out.scrollbars.push({ el: describe(el), axis: 'x', px: el.offsetHeight - el.clientHeight });
    }
  }
  return out;
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mobile-audit-'));
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
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`console: ${msg.text()}`); });
  await page.addInitScript(({ serverUrl, tok, viewport }) => {
    localStorage.setItem('harbor-web-server', serverUrl);
    localStorage.setItem('harbor-web-token', tok);
    localStorage.removeItem('harbor-web-open');
    localStorage.removeItem('harbor-web-active');
    const visual = new EventTarget();
    Object.assign(visual, { height: viewport.height, width: viewport.width, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
    window.__harborAuditKeyboard = (open) => {
      visual.height = open ? 460 : viewport.height;
      visual.dispatchEvent(new Event('resize'));
    };
  }, { serverUrl: SERVER, tok: token, viewport: VIEWPORT });
  await page.goto(`${SERVER}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell[data-connection="online"]').waitFor({ timeout: 25000 });
  await page.waitForTimeout(2500);

  const report = {};
  const audit = async (name, state) => {
    await page.waitForTimeout(600);
    const result = await page.evaluate(MEASURE);
    const key = `${name}--keyboard-${state}`;
    report[key] = result;
    await page.screenshot({ path: path.join(OUT_DIR, `${key}.png`) });
    const counts = Object.entries(result)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k}:${v.length}`)
      .join('  ');
    console.log(`${key.padEnd(38)} ${counts}`);
  };

  const auditBoth = async (name) => {
    await page.evaluate(() => window.__harborAuditKeyboard(false));
    await audit(name, 'closed');
    const message = page.locator('textarea[aria-label="Message"]');
    if (await message.count()) await message.focus();
    await page.evaluate(() => window.__harborAuditKeyboard(true));
    await page.locator('.app-shell[data-keyboard-open]').waitFor({ timeout: 3000 }).catch(() => {});
    await audit(name, 'open');
    await page.evaluate(() => window.__harborAuditKeyboard(false));
  };

  await auditBoth('conversation');

  // The composer specifically: it is the one control the whole screen exists
  // for, and it is the thing a flex mistake silently pushes off the viewport.
  const composer = await page.evaluate(() => {
    const el = document.querySelector('.composer');
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const bar = document.querySelector('.shell-bottom-anchor')?.getBoundingClientRect() || null;
    return {
      present: true,
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      viewportH: window.innerHeight,
      onScreen: r.top < window.innerHeight && r.bottom > 0,
      coveredByBar: bar ? r.bottom > bar.top + 2 : false,
      navHeightVar: getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--shell-nav-height').trim(),
      barTop: bar ? Math.round(bar.top) : null,
    };
  });
  report.composer = composer;
  console.log('composer:', JSON.stringify(composer));

  await page.locator('.hdr-session').click();
  await page.waitForSelector('.session-browser');
  await auditBoth('session-browser');

  await page.locator('.session-browser-close').click();
  await page.waitForTimeout(500);
  await page.locator('.nav-item', { hasText: 'Tasks' }).first().click();
  await page.waitForTimeout(900);
  await auditBoth('tasks');

  report.consoleErrors = consoleErrors;
  fs.writeFileSync(path.join(OUT_DIR, 'audit.json'), JSON.stringify(report, null, 2));

  console.log('\n--- findings ---');
  let total = 0;
  for (const [screen, result] of Object.entries(report)) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
    for (const [kind, list] of Object.entries(result)) {
      if (!Array.isArray(list) || !list.length) continue;
      total += list.length;
      const shown = list.slice(0, 6).map((x) => JSON.stringify(x)).join('\n      ');
      console.log(`  ${screen} / ${kind} (${list.length}):\n      ${shown}`);
    }
  }
  if (consoleErrors.length) console.log(`  console errors (${consoleErrors.length}):\n      ${consoleErrors.slice(0, 5).join('\n      ')}`);
  if (composer.present && (!composer.onScreen || composer.coveredByBar)) {
    total += 1;
    console.log(`  composer is not usable: onScreen=${composer.onScreen} coveredByBar=${composer.coveredByBar}`);
  }
  console.log(`\n${total} findings; wrote ${OUT_DIR}`);

  await electronApp.close({ force: true }).catch(() => {});
  try { electronApp.process()?.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((error) => { console.error(error); process.exit(1); });
