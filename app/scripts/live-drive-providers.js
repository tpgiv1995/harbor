'use strict';
/* Verify codex AND cursor launch through the new-session popover on the LIVE
   app and actually COME UP (their own interactive UI renders in the Harbor
   window), not just that an argv was emitted. For each: open popover from the
   harbor project row, pick the provider, Start, find the fresh window, switch
   it to the raw terminal, and read the pane text back through herdr to confirm
   the real tool booted. Screenshots at each step. Reports the pane markers. */
const fs = require('node:fs');
const { chromium } = require('@playwright/test');

const OUT = '/tmp/claude-1000/-home-you-dev-harbor/afa9ccb7-a5de-4803-8de7-c9b5a7436654/scratchpad';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read the rendered terminal text straight from the tile's xterm rows.
async function paneText(page, sessionId) {
  return page.evaluate((sid) => {
    const win = document.querySelector(`.win2[data-session-id="${sid}"]`);
    if (!win) return '__no_window__';
    const rows = win.querySelector('.xterm-rows');
    if (rows) return rows.innerText || rows.textContent || '';
    const screen = win.querySelector('.xterm-screen, .terminal, .tile-tty');
    return screen ? (screen.innerText || screen.textContent || '') : '__no_xterm__';
  }, sessionId);
}

async function launchProvider(page, providerBtn) {
  const wrap = page.locator('.sidebar-project-wrap', {
    has: page.locator('.pg-label', { hasText: /^harbor$/ }),
  }).first();
  await wrap.hover();
  await wrap.getByTitle('New personal session in harbor').click();
  await page.waitForSelector('.new-session-popover', { timeout: 5000 });
  await page.getByRole('button', { name: providerBtn }).click();
  await sleep(300);
  const before = await page.evaluate(() => document.querySelectorAll('.win2:not(.slot)').length);
  await page.getByRole('button', { name: 'Start' }).click();

  let win = null;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    win = await page.evaluate((prev) => {
      const wins = [...document.querySelectorAll('.win2:not(.slot)')];
      if (wins.length <= prev) return null;
      const w = wins[wins.length - 1];
      return { sessionId: w.dataset.sessionId, tty: Boolean(w.querySelector('.tile-tty, .xterm')) };
    }, before);
    if (win) break;
    await sleep(1000);
  }
  return win;
}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector('.rail', { timeout: 15000 });
  await page.locator('.rail-grouping-toggle button[data-grouping="project"]').click();
  await sleep(600);

  const report = {};
  for (const [key, btn] of [['codex', 'Codex'], ['cursor', 'Cursor']]) {
    const win = await launchProvider(page, btn);
    if (!win) { report[key] = { launched: false }; continue; }
    // Make sure the window is in the raw-terminal view (provider sessions
    // force it, but click the >_ if a conversation placeholder is showing).
    const ttyBtn = page.locator(`.win2[data-session-id="${win.sessionId}"] .ico.tty`);
    if (await ttyBtn.count() && !(await page.locator(`.win2[data-session-id="${win.sessionId}"] .xterm`).count())) {
      await ttyBtn.click().catch(() => {});
    }
    // Give the real tool time to draw its UI in the pane.
    await sleep(10000);
    await page.screenshot({ path: `${OUT}/prov-${key}-window.png` });
    const text = await paneText(page, win.sessionId);
    fs.writeFileSync(`${OUT}/prov-${key}-pane.txt`, String(text));
    const t = String(text);
    report[key] = {
      launched: true,
      sessionId: win.sessionId,
      // Tool-specific "it booted" markers, plus generic auth/error signals.
      markers: {
        codexUi: /codex|gpt-5\.6|reasoning|To get started|\/model|Ctrl\+/i.test(t),
        cursorUi: /cursor|agent|CURSOR_API_KEY|login|sign in|Ctrl\+/i.test(t),
        loginNeeded: /log ?in|sign ?in|api[_ ]?key|not authenticated|unauthor/i.test(t),
        error: /command not found|No such file|error:|failed/i.test(t),
        nonEmpty: t.trim().length > 0 && !t.startsWith('__'),
      },
      head: t.split('\n').filter((l) => l.trim()).slice(0, 6),
    };
  }

  await page.locator('.rail-grouping-toggle button[data-grouping="date"]').click();
  await sleep(300);
  fs.writeFileSync(`${OUT}/providers-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();
