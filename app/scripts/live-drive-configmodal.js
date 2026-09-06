'use strict';
/* Verify the instant-launch + provider-aware config modal on the LIVE app.
   1. Project-row +P launches INSTANTLY (no popover) as claude/opus/high.
   2. The launched window's model chip opens the config modal.
   3. The modal is provider-aware: Claude/Codex/Cursor swap the settings.
   4. On the live session, change effort and Apply => no relaunch (window count
      stable), i.e. it switches in place.
   Screenshots at each state. Returns the facts + the spawned pid to reap. */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');

const OUT = '/tmp/claude-1000/-home-you-dev-harbor/afa9ccb7-a5de-4803-8de7-c9b5a7436654/scratchpad';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('.rail', { timeout: 15000 });
  await page.locator('.rail-grouping-toggle button[data-grouping="project"]').click();
  await sleep(600);
  const report = { steps: [] };
  const note = (k, v) => { report.steps.push({ [k]: v }); console.log(k, JSON.stringify(v)); };

  const before = await page.evaluate(() => document.querySelectorAll('.win2:not(.slot)').length);

  // 1. INSTANT LAUNCH: project-row +P, expect NO popover, a launch happens.
  const wrap = page.locator('.sidebar-project-wrap', {
    has: page.locator('.pg-label', { hasText: /^harbor$/ }),
  }).first();
  await wrap.hover();
  await wrap.getByTitle('New personal session in harbor').click();
  await sleep(1200);
  note('popover-appeared', await page.locator('.new-session-popover').count() > 0);

  // The fresh window shows up within a few seconds (real pane).
  let launched = null;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    launched = await page.evaluate((prev) => {
      const wins = [...document.querySelectorAll('.win2:not(.slot)')];
      if (wins.length <= prev) return null;
      const w = wins[wins.length - 1];
      return { sessionId: w.dataset.sessionId, count: wins.length };
    }, before);
    if (launched) break;
    await sleep(1000);
  }
  note('instant-launch-window', launched);
  await page.screenshot({ path: `${OUT}/cfg-01-instant-launch.png` });

  // Confirm the real claude process launched with --model opus.
  let claudeArgv = '';
  try {
    claudeArgv = execFileSync('bash', ['-lc', "pgrep -af -- '--model opus' | grep -iE 'claude' | grep -v pgrep | head -1"], { encoding: 'utf8' }).trim();
  } catch { claudeArgv = '(none found via pgrep)'; }
  note('spawned-claude-argv', claudeArgv.slice(0, 160));

  // 2. Open the config modal from the launched window's model chip (fall back
  //    to the command-bar chip if the header chip isn't present yet).
  const chip = page.locator('.win2 .model-chip').first();
  await chip.click();
  await page.waitForSelector('.config-modal', { timeout: 6000 });
  note('modal-opened', true);
  await page.screenshot({ path: `${OUT}/cfg-02-modal-claude.png` });

  const claudeState = await page.evaluate(() => ({
    heads: [...document.querySelectorAll('.config-modal .cap-sec-h')].map((h) => h.textContent),
    modelValue: document.querySelector('.config-modal select[aria-label="Model"]')?.value,
    provider: document.querySelector('.new-session-providers button.active')?.textContent?.trim(),
  }));
  note('claude-modal', claudeState);

  // 3. Provider-aware: switch to Codex, settings adapt.
  await page.locator('.new-session-providers button', { hasText: 'Codex' }).click();
  await sleep(400);
  const codexState = await page.evaluate(() => ({
    modelValue: document.querySelector('.config-modal select[aria-label="Model"]')?.value,
    effortCurrent: document.querySelector('.config-modal .cap-effort-slider')?.getAttribute('aria-valuetext'),
    hasPermission: [...document.querySelectorAll('.config-modal .cap-sec-h')].some((h) => /permission/i.test(h.textContent)),
    actionLabel: document.querySelector('.new-session-start')?.textContent,
  }));
  note('codex-modal', codexState);
  await page.screenshot({ path: `${OUT}/cfg-03-modal-codex.png` });
  await page.locator('.new-session-providers button', { hasText: 'Cursor' }).click();
  await sleep(300);
  await page.screenshot({ path: `${OUT}/cfg-04-modal-cursor.png` });
  await page.keyboard.press('Escape');
  await sleep(300);

  // 4. Same-provider effort change applies in place (no relaunch).
  const wc0 = await page.evaluate(() => document.querySelectorAll('.win2:not(.slot)').length);
  if (await chip.count()) {
    await chip.click();
    await page.waitForSelector('.config-modal', { timeout: 6000 });
    // pick a different effort than current
    const target = await page.evaluate(() => {
      const slider = document.querySelector('.config-modal .cap-effort-slider');
      if (!slider) return null;
      return Number(slider.value) === Number(slider.max) ? 0 : Number(slider.value) + 1;
    });
    if (target !== null) await page.locator('.config-modal .cap-effort-slider').fill(String(target));
    const applyLabel = await page.locator('.new-session-start').textContent();
    note('apply-button-label', applyLabel);
    await page.locator('.new-session-start').click();
    await sleep(1800);
    const wc1 = await page.evaluate(() => document.querySelectorAll('.win2:not(.slot)').length);
    note('window-count-before-after-apply', { wc0, wc1, noRelaunch: wc0 === wc1 });
  }
  await page.screenshot({ path: `${OUT}/cfg-05-after-apply.png` });

  await page.locator('.rail-grouping-toggle button[data-grouping="date"]').click();
  await sleep(300);
  fs.writeFileSync(`${OUT}/configmodal-report.json`, JSON.stringify(report, null, 2));
  console.log('SPAWNED_SESSION', launched?.sessionId || 'none');
  await browser.close();
})();
