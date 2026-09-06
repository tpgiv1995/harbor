'use strict';
const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages()[0];
  const info = await page.evaluate(() => ({
    grouping: document.querySelector('.rail')?.dataset.grouping,
    labels: [...document.querySelectorAll('.pg-label')].slice(0, 8).map((el) => JSON.stringify(el.textContent)),
    wraps: document.querySelectorAll('.sidebar-project-wrap').length,
  }));
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
