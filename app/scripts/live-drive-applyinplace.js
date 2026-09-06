'use strict';
/* Apply-in-place, live: take a fresh Harbor-owned harbor-project session
   (mine, spawned this run), send it one innocuous message so it takes a turn
   and gains a model chip + real id, then open its config modal (must read
   "Apply", not "Start"), change effort, Apply, and confirm NO new window
   (switch in place) and the header effort badge updates. */
const fs = require('node:fs');
const { chromium } = require('@playwright/test');
const OUT = '/tmp/claude-1000/-home-you-dev-harbor/afa9ccb7-a5de-4803-8de7-c9b5a7436654/scratchpad';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TARGET = process.argv[2];

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const p = b.contexts()[0].pages()[0];
  await p.waitForSelector('.rail', { timeout: 15000 });
  const report = {};
  const note = (k, v) => { report[k] = v; console.log(k, JSON.stringify(v)); };

  await p.locator(`.win2[data-session-id="${TARGET}"] .wh`).click({ position: { x: 5, y: 5 } });
  await sleep(500);
  const state = await p.locator('.ubar-status .ustat-dot').getAttribute('aria-label').catch(() => '');
  note('selected-state', state);

  // Give it a turn so it gains a model header (chip).
  await p.locator('.ubar-input').fill('Reply with the single word READY.');
  await p.locator('.ubar .send').click();
  let chip = false;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !chip) {
    await sleep(3000);
    chip = await p.evaluate((sid) => !!document.querySelector(`.win2[data-session-id="${sid}"] .model-chip`), TARGET);
  }
  note('gained-chip', chip);
  if (!chip) { note('result', 'session never produced a model header within 120s'); fs.writeFileSync(`${OUT}/applyinplace-report.json`, JSON.stringify(report,null,2)); await b.close(); return; }

  const wc0 = await p.evaluate(() => document.querySelectorAll('.win2:not(.slot)').length);
  const effBefore = await p.evaluate((sid) => document.querySelector(`.win2[data-session-id="${sid}"] .model-chip .eff`)?.textContent, TARGET);
  await p.locator(`.win2[data-session-id="${TARGET}"] .model-chip`).click();
  await p.waitForSelector('.config-modal', { timeout: 6000 });
  const label = await p.locator('.new-session-start').textContent();
  note('button-label', label);   // must be "Apply"
  const to = await p.evaluate(() => {
    const slider = document.querySelector('.config-modal .cap-effort-slider');
    if (!slider) return null;
    return Number(slider.value) === Number(slider.max) ? 0 : Number(slider.value) + 1;
  });
  note('effort-before', effBefore); note('changing-effort-to', to);
  if (to !== null) await p.locator('.config-modal .cap-effort-slider').fill(String(to));
  await p.screenshot({ path: `${OUT}/apply-01-modal.png` });
  await p.locator('.new-session-start').click();
  await sleep(4000);
  const wc1 = await p.evaluate(() => document.querySelectorAll('.win2:not(.slot)').length);
  const effAfter = await p.evaluate((sid) => document.querySelector(`.win2[data-session-id="${sid}"] .model-chip .eff`)?.textContent, TARGET);
  note('window-count', { wc0, wc1, noRelaunch: wc0 === wc1 });
  note('effort-after', effAfter);
  await p.screenshot({ path: `${OUT}/apply-02-after.png` });
  fs.writeFileSync(`${OUT}/applyinplace-report.json`, JSON.stringify(report, null, 2));
  await b.close();
})();
