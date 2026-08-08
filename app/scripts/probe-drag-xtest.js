'use strict';
/* REAL-INPUT drag proof: XTEST events through the X server (xdotool), not
   browser-injected input. Run: xvfb-run -a node scripts/probe-drag-xtest.js */
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('@playwright/test');
const APP_ROOT = path.resolve(__dirname, '..');

const xdo = (...args) => execFileSync('xdotool', args, { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!process.env.DISPLAY) { console.error('needs a DISPLAY (run under xvfb-run)'); process.exit(1); }
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [APP_ROOT],
    env: { ...process.env, HARBOR_E2E: '1', HARBOR_E2E_FAKE_LAUNCH: '1', ELECTRON_DISABLE_GPU: '1' },
    cwd: APP_ROOT,
    timeout: 120000,
  });
  const page = await app.firstWindow({ timeout: 120000 });
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
        if (out.length >= 4) break;
      }
      if (out.length >= 4) break;
    }
    return out;
  });
  for (const id of ids) await page.evaluate((sid) => window.__harborOpenSession(sid), id);
  await page.waitForFunction(() => document.querySelectorAll('.win2:not(.slot)').length === 4, null, { timeout: 15000 });
  await sleep(500);

  // Window origin on the X display (frameless: content == window). Poll the
  // search (never --sync: it blocks forever on a class mismatch).
  let winId = null;
  for (let i = 0; i < 40 && !winId; i += 1) {
    for (const sel of [['--class', 'electron'], ['--class', 'Electron'], ['--name', 'Harbor']]) {
      try {
        const hits = xdo('search', '--onlyvisible', ...sel);
        if (hits) { winId = hits.split('\n').pop(); break; }
      } catch { /* not mapped yet */ }
    }
    if (!winId) await sleep(250);
  }
  if (!winId) throw new Error('app window never appeared on the X display');
  const geo = xdo('getwindowgeometry', '--shell', winId);
  const winX = Number(/X=(\-?\d+)/.exec(geo)[1]);
  const winY = Number(/Y=(\-?\d+)/.exec(geo)[1]);

  const before = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => el.dataset.sessionId));
  // Pat's exact move: bottom-left window to bottom-right, grabbing the header.
  const grab = await page.evaluate((id) => {
    const el = document.querySelector(`.win2[data-session-id="${id}"] .wh`);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 10 };
  }, before[2]);
  const drop = await page.evaluate((id) => {
    const el = document.querySelector(`.win2[data-session-id="${id}"]`);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 10 };
  }, before[3]);

  xdo('mousemove', '--sync', String(Math.round(winX + grab.x)), String(Math.round(winY + grab.y)));
  await sleep(150);
  xdo('mousedown', '1');
  const steps = 25;
  for (let i = 1; i <= steps; i += 1) {
    xdo('mousemove', '--sync',
      String(Math.round(winX + grab.x + (drop.x - grab.x) * (i / steps))),
      String(Math.round(winY + grab.y + (drop.y - grab.y) * (i / steps))));
    await sleep(25);
  }
  const midLift = await page.evaluate(() => Boolean(document.querySelector('.win2.dragging')));
  xdo('mouseup', '1');
  await sleep(400);

  const after = await page.$$eval('.win2:not(.slot)', (els) => els.map((el) => el.dataset.sessionId));
  const moved = after[3] === before[2];
  console.log(JSON.stringify({ input: 'XTEST(real X server events)', before, after, liftedDuringDrag: midLift, reordered: moved }, null, 2));
  await app.close({ force: true }).catch(() => {});
  process.exit(moved && midLift ? 0 : 1);
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
