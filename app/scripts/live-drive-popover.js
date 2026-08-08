'use strict';
/* Drive the new-session popover on the LIVE app as the user would:
   switch the rail to Project grouping (restored to Date at the end),
   open the harbor project's +P popover, screenshot default state,
   switch provider to Codex, screenshot, START a real codex session,
   verify the new provider-tagged tty window appears, screenshot. */
const { chromium } = require('@playwright/test');
const OUT = '/tmp/claude-1000/-home-you-dev-harbor/afa9ccb7-a5de-4803-8de7-c9b5a7436654/scratchpad';

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('.rail', { timeout: 15000 });

  const before = await page.evaluate(() => ({
    windows: document.querySelectorAll('.win2:not(.slot)').length,
  }));

  await page.locator('.rail-grouping-toggle button[data-grouping="project"]').click();
  await page.waitForTimeout(600);

  const wrap = page.locator('.sidebar-project-wrap', {
    has: page.locator('.pg-label', { hasText: /^harbor$/ }),
  }).first();
  await wrap.hover();
  await wrap.getByTitle('New personal session in harbor').click();
  await page.waitForSelector('.new-session-popover', { timeout: 5000 });
  await page.screenshot({ path: `${OUT}/live-03-popover-default.png` });

  const defaults = await page.evaluate(() => ({
    model: document.querySelector('.new-session-popover select')?.value,
    folder: document.querySelector('.new-session-folder')?.textContent,
    account: document.querySelector('.new-session-segments .active')?.textContent,
  }));

  await page.getByRole('button', { name: 'Codex' }).click();
  await page.waitForTimeout(300);
  const codexState = await page.evaluate(() => ({
    model: document.querySelector('.new-session-popover select')?.value,
    effort: document.querySelectorAll('.new-session-popover select')[1]?.value,
  }));
  await page.screenshot({ path: `${OUT}/live-04-popover-codex.png` });

  await page.getByRole('button', { name: 'Start' }).click();
  await page.waitForTimeout(500);

  // The fresh codex pane becomes a provider-tagged tty window.
  let newWindow = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    newWindow = await page.evaluate((prevCount) => {
      const wins = document.querySelectorAll('.win2:not(.slot)');
      if (wins.length <= prevCount) return null;
      const w = wins[wins.length - 1];
      return {
        count: wins.length,
        hasTerminal: Boolean(w.querySelector('.tile-tty, .terminal-pane, .xterm')),
        sessionId: w.dataset.sessionId,
      };
    }, before.windows);
    if (newWindow) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/live-05-codex-window.png` });

  await page.locator('.rail-grouping-toggle button[data-grouping="date"]').click();
  await page.waitForTimeout(300);

  console.log(JSON.stringify({ before, defaults, codexState, newWindow }, null, 2));
  await browser.close();
})();
