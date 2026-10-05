'use strict';

// Visual verification for MISSION-2 chrome polish: rail toggle alignment,
// home-dir header label, rail meter legibility. Runs under xvfb via verify-all
// pattern; never touches the live desktop or user daemon.

if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  && process.env.HARBOR_E2E_HEADED !== '1' && !process.env.__HARBOR_XVFB) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, __HARBOR_XVFB: '1' };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const res = spawnSync('xvfb-run', ['-a', process.execPath, __filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(res.status == null ? 1 : res.status);
}

const fs = require('node:fs');
const path = require('node:path');
const { launchHarbor, closeHarbor } = require('../test/e2e/helpers/electron.js');
const { startHarness, teardownHarness } = require('../test/e2e/helpers/terminal-harness.js');
const { APP_ROOT } = require('../test/e2e/helpers/paths.js');

const OUT = path.join(APP_ROOT, 'verify', 'chrome-polish');
fs.mkdirSync(OUT, { recursive: true });

async function shot(page, name) {
  const p = path.join(OUT, name);
  await page.screenshot({ path: p, fullPage: false });
  console.log('SHOT', p);
  return p;
}

async function openHomeSessions(page, count) {
  return page.evaluate(async (max) => {
    localStorage.removeItem('harbor-slate-stage');
    const state = await window.harbor.sidebar.getState();
    const home = [];
    for (const proj of state.model.projects || []) {
      for (const s of proj.sessions || []) {
        if (s.isWindowsEra || s.isChildTask || s.isLive) continue;
        if (String(s.id).startsWith('live:')) continue;
        if (s.project === '~' || !s.project) home.push(s.id);
        if (home.length >= max) break;
      }
      if (home.length >= max) break;
    }
    return home;
  }, count);
}

async function clickSessions(page, ids) {
  for (const id of ids) {
    const row = page.locator(`.sr[data-session-id="${id}"]`);
    if (await row.count() === 0) {
      await page.locator('.rail-find').fill('~');
      await page.waitForTimeout(400);
    }
    await page.locator(`.sr[data-session-id="${id}"]`).click({ timeout: 15000 });
    await page.waitForSelector(`.win2[data-session-id="${id}"]`, { timeout: 15000 });
  }
}

async function main() {
  const harness = await startHarness({ stress: false });
  const { electronApp, page } = await launchHarbor({ HERDR_SOCKET_PATH: harness.socketPath });
  page.setDefaultTimeout(20000);

  try {
    await page.evaluate(() => localStorage.removeItem('harbor-slate-stage'));

    // Rail toggle vertical alignment vs app menu
    const toggleAlign = await page.evaluate(() => {
      const menu = document.querySelector('.app-menu-btn');
      const toggle = document.querySelector('.rail-toggle-btn');
      const bar = document.querySelector('.titlebar');
      const mb = menu.getBoundingClientRect();
      const tb = toggle.getBoundingClientRect();
      const bb = bar.getBoundingClientRect();
      const menuCenter = mb.top + mb.height / 2;
      const toggleCenter = tb.top + tb.height / 2;
      const barCenter = bb.top + bb.height / 2;
      return {
        titlebarHeight: bb.height,
        menu: { top: mb.top, height: mb.height, centerY: menuCenter },
        toggle: { top: tb.top, height: tb.height, centerY: toggleCenter },
        barCenterY: barCenter,
        menuDeltaFromBarCenter: Math.abs(menuCenter - barCenter),
        toggleDeltaFromBarCenter: Math.abs(toggleCenter - barCenter),
        menuToggleCenterDelta: Math.abs(menuCenter - toggleCenter),
      };
    });
    console.log('RAIL_TOGGLE_ALIGN', JSON.stringify(toggleAlign, null, 2));
    await shot(page, 'rail-toggle-alignment.png');

    // Home-dir header blip: open up to 4 home sessions for 2x2 grid
    const homeIds = await openHomeSessions(page, 4);
    console.log('HOME_SESSION_IDS', homeIds);
    if (homeIds.length < 2) {
      console.log('WARN: fewer than 2 home sessions; opening whatever dead sessions exist');
      const fallback = await page.evaluate(async () => {
        const state = await window.harbor.sidebar.getState();
        const ids = [];
        for (const proj of state.model.projects || []) {
          for (const s of proj.sessions || []) {
            if (s.isWindowsEra || s.isChildTask || s.isLive) continue;
            if (String(s.id).startsWith('live:')) continue;
            ids.push(s.id);
            if (ids.length >= 4) break;
          }
          if (ids.length >= 4) break;
        }
        return ids;
      });
      await clickSessions(page, fallback.slice(0, 4));
    } else {
      await clickSessions(page, homeIds);
    }

    await page.waitForSelector('.grid4[data-grid-cols="2"][data-grid-rows="2"]', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);

    const pjInspect = await page.evaluate(() => {
      return [...document.querySelectorAll('.win2 .wh .pj')].map((el) => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return {
          element: '.wh .pj',
          textContent: el.textContent,
          color: style.color,
          font: style.font,
          fontWeight: style.fontWeight,
          boundingBox: { x: box.x, y: box.y, width: box.width, height: box.height },
        };
      });
    });
    console.log('PJ_DOM_INSPECTION', JSON.stringify(pjInspect, null, 2));
    await shot(page, 'home-header-2x2-after.png');

    // Rail meters at three widths
    for (const width of [190, 236, 420]) {
      await page.evaluate((w) => {
        const rail = document.querySelector('.rail');
        if (rail) rail.style.width = `${w}px`;
        window.dispatchEvent(new Event('resize'));
      }, width);
      await page.waitForTimeout(200);
      await shot(page, `rail-meters-${width}px.png`);
    }

    const meterFonts = await page.evaluate(() => {
      const b = document.querySelector('.rm-g b');
      const em = document.querySelector('.rm-g em');
      const donut = document.querySelector('.rm-donut');
      return {
        pctFont: b ? getComputedStyle(b).fontSize : null,
        resetFont: em ? getComputedStyle(em).fontSize : null,
        donutSize: donut ? `${donut.getBoundingClientRect().width}px` : null,
      };
    });
    console.log('RAIL_METER_SIZES', JSON.stringify(meterFonts, null, 2));

    const rings = await page.locator('.titlebar .ring').count();
    console.log('TITLEBAR_RING_COUNT', rings);
    if (rings !== 0) throw new Error(`expected 0 titlebar rings, got ${rings}`);
    if (toggleAlign.menuToggleCenterDelta > 0.5) {
      throw new Error(`rail toggle not vertically aligned with app menu: delta ${toggleAlign.menuToggleCenterDelta}px`);
    }
    if (toggleAlign.toggleDeltaFromBarCenter > 0.5) {
      throw new Error(`rail toggle not centered in titlebar: delta ${toggleAlign.toggleDeltaFromBarCenter}px`);
    }
  } finally {
    await closeHarbor(electronApp, page);
    try { harness?.child.kill('SIGTERM'); } catch { /* */ }
    teardownHarness();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
