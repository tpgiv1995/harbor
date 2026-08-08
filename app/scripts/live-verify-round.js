'use strict';
/* Live verification drive for the 2026-07-19 round: connects to the REAL
   deployed Harbor over CDP, screenshots the app, and reports the facts the
   round claims: no titlebar rings, centered rail toggle, enlarged meters,
   provider logos in rail + conversation, 'home' header label, popover
   opens from a project row. Read-only except opening/closing the popover. */
const fs = require('node:fs');
const { chromium } = require('@playwright/test');

const OUT = '/tmp/claude-1000/-home-you-dev-harbor/afa9ccb7-a5de-4803-8de7-c9b5a7436654/scratchpad';

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('.rail', { timeout: 20000 });
  await page.waitForTimeout(2500);

  const facts = await page.evaluate(() => {
    const tb = document.querySelector('.titlebar')?.getBoundingClientRect();
    const tg = document.querySelector('.rail-toggle-btn')?.getBoundingClientRect();
    const meterB = document.querySelector('.rm-g b');
    const railLogos = [...document.querySelectorAll('.sr-provider')];
    const convWho = document.querySelector('.conv-assistant-who');
    const convImg = document.querySelector('.conv-assistant-who img.conv-sig');
    const convProv = document.querySelector('.conv-provider');
    const pjLabels = [...document.querySelectorAll('.wh .pj')].map((el) => el.textContent);
    return {
      rings: document.querySelectorAll('.titlebar .ring').length,
      toggleCenteredDelta: tb && tg ? Math.abs((tg.top + tg.height / 2) - (tb.top + tb.height / 2)) : null,
      meterFontPx: meterB ? getComputedStyle(meterB).fontSize : null,
      railLogoCount: railLogos.length,
      railLogoVisible: railLogos.length ? railLogos.every((el) => el.getBoundingClientRect().width > 6) : false,
      convWhoText: convWho ? convWho.textContent.trim() : null,
      convHasLogoImg: Boolean(convImg),
      convProviderColor: convProv ? getComputedStyle(convProv).color : null,
      windowProjectLabels: pjLabels,
      openWindows: document.querySelectorAll('.win2:not(.slot)').length,
      takeoverChips: document.querySelectorAll('.takeover-chip').length,
    };
  });

  await page.screenshot({ path: `${OUT}/live-01-overview.png` });

  // Popover from a project row: hover the harbor project, click +P, screenshot, Escape.
  const wrap = page.locator('.sidebar-project-wrap', {
    has: page.locator('.pg-label', { hasText: /^harbor$/ }),
  }).first();
  let popover = null;
  try {
    await wrap.hover();
    await wrap.getByTitle('New personal session in harbor').click();
    await page.waitForSelector('.new-session-popover', { timeout: 5000 });
    popover = await page.evaluate(() => {
      const models = [...document.querySelectorAll('.new-session-popover select')[0].options].map((o) => o.value);
      const providers = [...document.querySelectorAll('.new-session-providers button')].map((b) => b.textContent.trim());
      return { models, providers };
    });
    await page.screenshot({ path: `${OUT}/live-02-popover.png` });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } catch (error) {
    popover = { error: String(error.message).slice(0, 200) };
  }

  fs.writeFileSync(`${OUT}/live-verify-facts.json`, JSON.stringify({ facts, popover }, null, 2));
  console.log(JSON.stringify({ facts, popover }, null, 2));
  await browser.close();
})();
