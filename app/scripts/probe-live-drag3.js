'use strict';
/* Kernel-real drag on the live desktop: ydotool with feedback aiming
   (its absolute space is letterboxed; iterate until the REAL cursor,
   read back via XWayland, sits on target). CDP observes the app. */
const { execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const ydo = (...a) => execFileSync('ydotool', a, { encoding: 'utf8' });
const xloc = () => {
  const out = execFileSync('xdotool', ['getmouselocation'], { encoding: 'utf8', env: { ...process.env, DISPLAY: ':0' } });
  const m = /x:(\d+) y:(\d+)/.exec(out);
  return { x: Number(m[1]), y: Number(m[2]) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Empirical linear seed from calibration, corrected by feedback per shot.
let sx = 3.9663; let ox = -792.3; let sy = 2.6767; let oy = -107.6;
async function aim(tx, ty) {
  let gx = (tx - ox) / sx; let gy = (ty - oy) / sy;
  for (let i = 0; i < 6; i += 1) {
    ydo('mousemove', '--absolute', '-x', String(Math.round(gx)), '-y', String(Math.round(gy)));
    await sleep(120);
    const at = xloc();
    const ex = tx - at.x; const ey = ty - at.y;
    if (Math.abs(ex) <= 4 && Math.abs(ey) <= 4) return at;
    gx += ex / sx; gy += ey / sy;
  }
  return xloc();
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages()[0];
  const state = await page.evaluate(() => ({
    tiles: [...document.querySelectorAll('.win2:not(.slot)')].map((el) => el.dataset.sessionId),
    dpr: window.devicePixelRatio,
  }));
  const holes = await page.evaluate(() => {
    const grid = document.querySelector('.grid4');
    const cols = Number(grid?.dataset.gridCols) || 1;
    const rows = Number(grid?.dataset.gridRows) || 1;
    const occ = new Set([...document.querySelectorAll('.win2[data-slot]')].map((el) => Number(el.dataset.slot)));
    return Array.from({ length: cols * rows }, (_, c) => c).filter((c) => !occ.has(c));
  });
  const from = state.tiles[state.tiles.length - 1];
  const src = await page.evaluate((id) => {
    // Grab the conversation BODY, exactly where Pat grabs.
    const el = document.querySelector(`.win2[data-session-id="${id}"] .conv`)
      || document.querySelector(`.win2[data-session-id="${id}"]`);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, from);
  // Pat's case: prefer dropping into a HOLE (empty cell); else swap onto cell 0.
  const dst = await page.evaluate(({ id, holes }) => {
    const grid = document.querySelector('.grid4');
    if (holes.length) {
      const cols = Number(grid.dataset.gridCols) || 1;
      const rows = Number(grid.dataset.gridRows) || 1;
      const g = grid.getBoundingClientRect();
      const st = getComputedStyle(grid);
      const padL = parseFloat(st.paddingLeft) || 0;
      const padT = parseFloat(st.paddingTop) || 0;
      const gap = parseFloat(st.gap) || 0;
      const innerW = g.width - padL - (parseFloat(st.paddingRight) || 0);
      const innerH = g.height - padT - (parseFloat(st.paddingBottom) || 0);
      const cw = (innerW - gap * (cols - 1)) / cols;
      const ch = (innerH - gap * (rows - 1)) / rows;
      const cell = holes[0];
      return {
        x: g.left + padL + (cell % cols) * (cw + gap) + cw / 2,
        y: g.top + padT + Math.floor(cell / cols) * (ch + gap) + ch / 2,
        cell,
      };
    }
    const r = document.querySelector(`.win2[data-session-id="${id}"]`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12, cell: 0 };
  }, { id: state.tiles[0], holes });
  const slotBefore = await page.evaluate((id) => document.querySelector(`.win2[data-session-id="${id}"]`)?.dataset.slot, from);
  const S = state.dpr;

  const landed = await aim(Math.round(src.x * S), Math.round(src.y * S));
  console.log('cursor on src:', JSON.stringify(landed));
  await sleep(200);

  ydo('click', '-D', '30', '0x40'); // hold left
  await sleep(120);
  // Waypoints with feedback: plenty of real pointermove along the way.
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    await aim(
      Math.round((src.x + (dst.x - src.x) * (i / steps)) * S),
      Math.round((src.y + (dst.y - src.y) * (i / steps)) * S),
    );
  }
  const mid = await page.evaluate(() => Boolean(document.querySelector('.win2.dragging')));
  ydo('click', '0x80'); // release
  await sleep(500);

  const slotAfter = await page.evaluate((id) => document.querySelector(`.win2[data-session-id="${id}"]`)?.dataset.slot, from);
  console.log(JSON.stringify({
    draggedWindow: String(from).slice(0, 8),
    targetCell: dst.cell,
    slotBefore,
    slotAfter,
    lifted: mid,
    placed: String(dst.cell) === slotAfter && slotAfter !== slotBefore,
  }, null, 2));
  await browser.close().catch(() => {});
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
