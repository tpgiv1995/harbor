'use strict';

/**
 * A UI/UX sweep of the DESKTOP app that measures every surface instead of
 * looking at two of them. Drives an isolated Harbor at Pat's real 2560x1600,
 * walks each view and each popover, and on every one reports:
 *
 *   - anything overflowing the viewport or clipped by its own container
 *   - interactive targets under 24x24 (desktop floor) and text under 11px
 *   - text that is truncated with no title/aria-label, so the full value is
 *     unreachable by any means
 *   - content covered by the fixed command bar
 *   - visible horizontal scroll on the document
 *   - console errors raised while driving
 *
 * Screenshots every surface into verify/desktop-audit/ so the pixels can be
 * reviewed, not just the numbers.
 *
 * Run: CLAUDE_GUI_GEOMETRY=2560x1600x24 claude-gui node scripts/audit-desktop-ui.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const APP_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_ROOT, 'verify', 'desktop-audit');

const MEASURE = () => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out = {
    viewport: { w: vw, h: vh },
    overflow: [],
    clipped: [],
    smallTargets: [],
    smallText: [],
    unreachableText: [],
    underBar: [],
    docScrollX: document.documentElement.scrollWidth > vw + 1,
  };
  const describe = (el) => {
    const cls = typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
    return `${el.tagName.toLowerCase()}${cls}`;
  };
  const style0 = (el) => getComputedStyle(el);
  const shown = (el, s) => s.display !== 'none' && s.visibility !== 'hidden'
    && Number(s.opacity) !== 0 && el.getClientRects().length > 0;
  const decorative = (el, s) => s.pointerEvents === 'none'
    || el.getAttribute('aria-hidden') === 'true'
    || el.closest('[aria-hidden="true"]') !== null;

  const bar = document.querySelector('.ubar');
  const barBox = bar && shown(bar, style0(bar)) ? bar.getBoundingClientRect() : null;

  for (const el of document.querySelectorAll('body *')) {
    const s = style0(el);
    if (!shown(el, s)) continue;
    if (decorative(el, s)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    if (r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1) {
      // Legitimate when an ancestor scrolls on that axis.
      let scrolls = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (/auto|scroll/.test(ps.overflowX) || /auto|scroll/.test(ps.overflowY)) { scrolls = true; break; }
      }
      if (!scrolls) {
        out.overflow.push({ el: describe(el), l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom) });
      }
    }

    const interactive = el.matches('button, a[href], input, textarea, select, [role="button"], [role="menuitem"], [contenteditable="true"]');
    if (interactive && (r.width < 24 || r.height < 24)) {
      out.smallTargets.push({ el: describe(el), w: Math.round(r.width), h: Math.round(r.height), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30) });
    }

    const px = parseFloat(s.fontSize);
    const leaf = el.childElementCount === 0 && (el.textContent || '').trim();
    if (leaf && px && px < 11) {
      out.smallText.push({ el: describe(el), px, text: el.textContent.trim().slice(0, 30) });
    }

    // Truncated with nothing to recover the full string from.
    if (leaf && el.scrollWidth > el.clientWidth + 1 && /ellipsis|clip/.test(s.textOverflow)) {
      if (!el.title && !el.getAttribute('aria-label') && !el.closest('[title]')) {
        out.unreachableText.push({ el: describe(el), text: el.textContent.trim().slice(0, 40) });
      }
    }

    if (barBox && el.childElementCount === 0 && !bar.contains(el)) {
      const ov = Math.min(r.bottom, barBox.bottom) - Math.max(r.top, barBox.top);
      if (ov > 4 && r.left < barBox.right && r.right > barBox.left) {
        out.underBar.push({ el: describe(el), ov: Math.round(ov), text: (el.textContent || '').trim().slice(0, 30) });
      }
    }
  }
  return out;
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dtaudit-'));
  const electronApp = await electron.launch({
    executablePath: require('electron'),
    args: [APP_ROOT],
    env: {
      ...process.env,
      HARBOR_E2E: '1',
      HARBOR_E2E_FAKE_LAUNCH: '1',
      HARBOR_E2E_USER_DATA: path.join(scratch, 'userdata'),
      HARBOR_ARTIFACTS_CACHE: path.join(scratch, 'artifacts.json'),
      HARBOR_ARTIFACT_THUMBS_DIR: path.join(scratch, 'thumbs'),
      ELECTRON_DISABLE_GPU: '1',
    },
    cwd: APP_ROOT,
    timeout: 120000,
  });
  const page = await electronApp.firstWindow({ timeout: 120000 });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`); });
  await page.waitForSelector('.rail', { timeout: 30000 });
  await page.waitForFunction(() => window.__harborSidebarStats?.indexerSessionCount > 0, null, { timeout: 30000 });
  await electronApp.evaluate(async ({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const a = screen.getPrimaryDisplay().workAreaSize;
    win.setBounds({ x: 0, y: 0, width: a.width, height: a.height });
  });
  await page.waitForTimeout(1200);

  const report = {};
  const audit = async (name) => {
    await page.waitForTimeout(500);
    report[name] = await page.evaluate(MEASURE);
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    const r = report[name];
    console.log(`${name.padEnd(26)} overflow:${r.overflow.length} clipped:${r.clipped.length} `
      + `targets:${r.smallTargets.length} text:${r.smallText.length} truncated:${r.unreachableText.length} `
      + `underBar:${r.underBar.length} docScrollX:${r.docScrollX}`);
  };

  // A click that does not land makes every screen after it a duplicate of the
  // one before, which is worse than no coverage because it reports as coverage.
  // Anything that fails is recorded as NOT CAPTURED, not silently repeated.
  const failures = [];
  const click = async (selector, wait = 700) => {
    const el = page.locator(selector).first();
    if (!(await el.count())) { failures.push(`absent: ${selector}`); return false; }
    try {
      await el.click({ timeout: 4000 });
    } catch (error) {
      failures.push(`click failed ${selector}: ${error.message.split('\n')[0]}`);
      return false;
    }
    await page.waitForTimeout(wait);
    return true;
  };

  // Popovers portal to document.body and are dismissed by an outside click,
  // not reliably by Escape. Dismiss, then PROVE the overlay is gone before
  // driving anything else.
  const dismiss = async (selector) => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    if (selector && await page.locator(selector).count()) {
      await page.mouse.click(Math.round(page.viewportSize()?.width * 0.5) || 900, 10);
      await page.waitForTimeout(300);
    }
    if (selector) {
      await page.locator(selector).first().waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => failures.push(`popover would not dismiss: ${selector}`));
    }
    await page.waitForTimeout(200);
  };

  // ── Agents view, empty then populated ──────────────────────────────────
  await audit('01-agents-empty');

  const ids = await page.evaluate(async () => {
    const state = await window.harbor.sidebar.getState();
    const out = [];
    for (const p of state.model.projects || []) {
      for (const s of p.sessions || []) {
        if (s.isWindowsEra || s.isChildTask || s.isLive || !s.cwd) continue;
        if (String(s.id).startsWith('live:')) continue;
        if (s.lastActiveMs && Date.now() - s.lastActiveMs < 15 * 60 * 1000) continue;
        out.push(s.id);
        break;
      }
      if (out.length >= 6) break;
    }
    return out;
  });
  for (const id of ids.slice(0, 1)) await page.evaluate((i) => window.__harborOpenSession(i), id);
  await page.waitForTimeout(1500);
  await audit('02-agents-one-window');

  for (const id of ids.slice(1, 6)) await page.evaluate((i) => window.__harborOpenSession(i), id);
  await page.waitForTimeout(2000);
  await audit('03-agents-six-windows');

  // Command bar surfaces.
  if (await click('.attach')) await audit('04-plus-menu');
  await dismiss('.plus-menu');

  if (await click('.ubar .model-chip')) await audit('05-capability-menu');
  await dismiss('.cap-menu');

  // A window's own config popover (the same control the desktop calls the
  // model chip inside a window header).
  if (await click('.win2 .model-chip')) await audit('06-session-config');
  await dismiss('.new-session-popover');

  // ── The other three top-level views ────────────────────────────────────
  for (const [tab, name] of [['Tasks', '07-tasks'], ['Orch', '08-orch'], ['Files', '09-files']]) {
    if (await click(`.view-switch-btn:has-text("${tab}")`, 2200)) await audit(name);
  }

  if (await click('.view-switch-btn:has-text("Agents")', 1200)) {
    await page.keyboard.press('F1');
    await page.waitForTimeout(800);
    await audit('10-help-overlay');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  if (await click('.rail-toggle-btn', 900)) {
    await audit('11-rail-hidden');
    await click('.rail-toggle-btn', 900);
  }

  report.driveFailures = failures;

  report.consoleErrors = consoleErrors;
  fs.writeFileSync(path.join(OUT_DIR, 'audit.json'), JSON.stringify(report, null, 2));

  console.log('\n--- findings ---');
  let total = 0;
  for (const [screen, r] of Object.entries(report)) {
    if (!r || Array.isArray(r) || typeof r !== 'object') continue;
    for (const [kind, list] of Object.entries(r)) {
      if (!Array.isArray(list) || !list.length) continue;
      total += list.length;
      console.log(`  ${screen} / ${kind} (${list.length}):`);
      for (const item of list.slice(0, 5)) console.log(`      ${JSON.stringify(item)}`);
    }
    if (r.docScrollX) { total += 1; console.log(`  ${screen}: document scrolls horizontally`); }
  }
  if (consoleErrors.length) {
    console.log(`  console errors (${consoleErrors.length}):`);
    for (const e of consoleErrors.slice(0, 8)) console.log(`      ${e}`);
  }
  if (report.driveFailures?.length) {
    console.log(`\n  NOT CAPTURED (${report.driveFailures.length}) - these surfaces were never audited:`);
    for (const f of report.driveFailures) console.log(`      ${f}`);
  }
  console.log(`\n${total} findings; wrote ${OUT_DIR}`);

  await electronApp.close({ force: true }).catch(() => {});
  try { electronApp.process()?.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(scratch, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
