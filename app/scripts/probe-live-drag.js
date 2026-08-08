'use strict';
/* Live-desktop drag diagnosis: CDP-instrument the REAL running app, then
   drive a REAL kernel-level drag with ydotool. Reports where input dies. */
const { execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');

const ydo = (...args) => execFileSync('ydotool', args, { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages()[0];

  // New-build marker + event tap at capture phase.
  const marker = await page.evaluate(() => ({
    grip: document.querySelectorAll('.wh-grip').length,
    tiles: [...document.querySelectorAll('.win2:not(.slot)')].map((el) => el.dataset.sessionId),
    focusMode: Boolean(document.querySelector('.grid4.focus-mode')),
    screenX: window.screenX,
    screenY: window.screenY,
    dpr: window.devicePixelRatio,
  }));
  console.log('marker:', JSON.stringify(marker));
  if (marker.tiles.length < 2) { console.log('NEED 2+ open windows on the stage to test'); process.exit(2); }
  if (marker.focusMode) { console.log('stage is in FOCUS MODE: drag is disabled by design there'); process.exit(3); }

  await page.evaluate(() => {
    window.__tap = [];
    const rec = (e) => window.__tap.push({
      t: e.type,
      target: (e.target?.className || e.target?.nodeName || '?').toString().slice(0, 60),
      x: Math.round(e.clientX || 0),
      y: Math.round(e.clientY || 0),
    });
    for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'dragstart', 'mousedown']) {
      window.addEventListener(t, rec, true);
    }
    let moves = 0;
    window.addEventListener('pointermove', (e) => {
      moves += 1;
      if (moves % 10 === 1) rec(e);
    }, true);
  });

  const src = await page.evaluate((id) => {
    const r = document.querySelector(`.win2[data-session-id="${id}"] .wh`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  }, marker.tiles[marker.tiles.length - 1]);
  const dst = await page.evaluate((id) => {
    const r = document.querySelector(`.win2[data-session-id="${id}"]`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  }, marker.tiles[0]);

  // The app draws at CSS pixels; the screen is physical. ydotool absolute
  // coordinates are physical pixels on the full screen.
  const sx = Math.round((marker.screenX + src.x) * marker.dpr);
  const sy = Math.round((marker.screenY + src.y) * marker.dpr);
  const dx = Math.round((marker.screenX + dst.x) * marker.dpr);
  const dy = Math.round((marker.screenY + dst.y) * marker.dpr);
  console.log(`real drag: (${sx},${sy}) -> (${dx},${dy}) dpr=${marker.dpr}`);

  const before = marker.tiles;
  ydo('mousemove', '--absolute', '-x', String(sx), '-y', String(sy));
  await sleep(250);
  ydo('click', '-D', '40', '0x40'); // press left button, hold
  const steps = 20;
  for (let i = 1; i <= steps; i += 1) {
    ydo('mousemove', '--absolute', '-x', String(Math.round(sx + (dx - sx) * (i / steps))), '-y', String(Math.round(sy + (dy - sy) * (i / steps))));
    await sleep(30);
  }
  const mid = await page.evaluate(() => Boolean(document.querySelector('.win2.dragging')));
  ydo('click', '0x80'); // release left button
  await sleep(400);

  const after = await page.evaluate(() => [...document.querySelectorAll('.win2:not(.slot)')].map((el) => el.dataset.sessionId));
  const tap = await page.evaluate(() => window.__tap.slice(0, 40));
  console.log(JSON.stringify({ before, after, liftedDuringDrag: mid, reordered: after[0] === before[before.length - 1], tap }, null, 2));
  await browser.close().catch(() => {});
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
