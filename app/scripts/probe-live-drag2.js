'use strict';
/* Live drag via XTEST on :0 with CDP observation. Physical = CSS * 2 here. */
const { execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const xdo = (...a) => execFileSync('xdotool', a, { encoding: 'utf8', env: { ...process.env, DISPLAY: ':0' } }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages()[0];
  await page.evaluate(() => { window.__tap = []; });
  const state = await page.evaluate(() => ({
    tiles: [...document.querySelectorAll('.win2:not(.slot)')].map((el) => el.dataset.sessionId),
    dpr: window.devicePixelRatio,
  }));
  if (state.tiles.length < 2) { console.log('need 2+ windows'); process.exit(2); }
  const src = await page.evaluate((id) => {
    const r = document.querySelector(`.win2[data-session-id="${id}"] .wh`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  }, state.tiles[state.tiles.length - 1]);
  const dst = await page.evaluate((id) => {
    const r = document.querySelector(`.win2[data-session-id="${id}"]`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  }, state.tiles[0]);
  const S = state.dpr;
  const sx = Math.round(src.x * S); const sy = Math.round(src.y * S);
  const dx = Math.round(dst.x * S); const dy = Math.round(dst.y * S);
  console.log(`XTEST drag (${sx},${sy}) -> (${dx},${dy})`);

  xdo('mousemove', '--sync', String(sx), String(sy));
  await sleep(250);
  const hover = await page.evaluate(() => window.__tap.length);
  console.log('hover events before press:', hover);
  xdo('mousedown', '1');
  for (let i = 1; i <= 20; i += 1) {
    xdo('mousemove', '--sync', String(Math.round(sx + (dx - sx) * (i / 20))), String(Math.round(sy + (dy - sy) * (i / 20))));
    await sleep(30);
  }
  const mid = await page.evaluate(() => Boolean(document.querySelector('.win2.dragging')));
  xdo('mouseup', '1');
  await sleep(400);
  const after = await page.evaluate(() => [...document.querySelectorAll('.win2:not(.slot)')].map((el) => el.dataset.sessionId));
  const tap = await page.evaluate(() => window.__tap.slice(0, 30));
  console.log(JSON.stringify({ before: state.tiles, after, lifted: mid, reordered: after[0] === state.tiles[state.tiles.length - 1], tapCount: tap.length, tap: tap.slice(0, 12) }, null, 2));
  await browser.close().catch(() => {});
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
