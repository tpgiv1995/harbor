'use strict';
/* Drag diagnostic: reproduce the real-mouse drag at DPR 1 and DPR 2 under
   xvfb, capturing console errors. Usage: xvfb-run -a node scripts/probe-drag.js [dpr] */
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');
const APP_ROOT = path.resolve(__dirname, '..');

(async () => {
  const dpr = process.argv[2] || '1';
  const args = [APP_ROOT];
  if (dpr !== '1') args.push(`--force-device-scale-factor=${dpr}`);
  const app = await electron.launch({
    executablePath: require('electron'),
    args,
    env: { ...process.env, HARBOR_E2E: '1', HARBOR_E2E_FAKE_LAUNCH: '1', ELECTRON_DISABLE_GPU: '1' },
    cwd: APP_ROOT,
    timeout: 120000,
  });
  const page = await app.firstWindow({ timeout: 120000 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.waitForSelector('.rail', { timeout: 30000 });
  await page.waitForFunction(() => (window.__harborSidebarStats?.indexerSessionCount ?? 0) > 0, null, { timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem('harbor-slate-stage'));

  const ids = await page.evaluate(async () => {
    const state = await window.harbor.sidebar.getState();
    const out = [];
    for (const proj of state.model.projects || []) {
      for (const s of proj.sessions || []) {
        if (s.isWindowsEra || s.isChildTask || s.isLive) continue;
        if (String(s.id).startsWith('live:')) continue;
        if (s.lastActiveMs && Date.now() - s.lastActiveMs < 15 * 60 * 1000) continue;
        out.push(s.id);
        if (out.length >= 3) break;
      }
      if (out.length >= 3) break;
    }
    return out;
  });
  for (const id of ids) await page.evaluate((sid) => window.__harborOpenSession(sid), id);
  await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 3, null, { timeout: 15000 });

  const before = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => el.dataset.sessionId));
  const third = await page.locator(`.win2[data-session-id="${ids[2]}"] .wh`).boundingBox();
  const first = await page.locator(`.win2[data-session-id="${ids[0]}"]`).boundingBox();

  // Slow, human-like drag: 40 small moves with pauses.
  await page.mouse.move(third.x + third.width / 2, third.y + 10);
  await page.mouse.down();
  const steps = 40;
  for (let i = 1; i <= steps; i += 1) {
    const x = third.x + third.width / 2 + ((first.x + first.width / 2) - (third.x + third.width / 2)) * (i / steps);
    const y = third.y + 10 + ((first.y + 10) - (third.y + 10)) * (i / steps);
    await page.mouse.move(x, y);
    await page.waitForTimeout(12);
  }
  // Mid-drag observations before release
  const midState = await page.evaluate(() => ({
    hasFixedTile: Boolean(document.querySelector('.win2[style*="fixed"]')),
    placeholder: Boolean(document.querySelector('.win2.drag-placeholder')),
  }));
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => el.dataset.sessionId));

  console.log(JSON.stringify({
    dpr,
    before,
    after,
    reordered: after[0] === ids[2],
    midState,
    consoleErrors: errors.slice(0, 5),
  }, null, 2));
  await app.close({ force: true }).catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
