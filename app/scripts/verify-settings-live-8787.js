'use strict';

const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const APP_ROOT = path.join(__dirname, '..');
const OUT = path.join(APP_ROOT, 'verify', 'settings', '04-live-8787-settings.png');
const VIEWPORT = { width: 430, height: 932 };

async function main() {
  const base = 'http://127.0.0.1:8787';
  const token = process.env.TOKEN;
  if (!token) throw new Error('TOKEN env required');

  const dir = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'harbor-live-settings-'));
  const em = path.join(dir, 'e.js');
  require('node:fs').writeFileSync(em, `'use strict';
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  new BrowserWindow({ width: ${VIEWPORT.width}, height: ${VIEWPORT.height}, show: true }).loadURL('about:blank');
});`);

  const electronApp = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', em],
    cwd: APP_ROOT,
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize(VIEWPORT);

  await page.addInitScript(({ serverUrl, tok }) => {
    localStorage.setItem('harbor-web-server', serverUrl);
    localStorage.setItem('harbor-web-token', tok);
    window.__harborConnectCount = 0;
    const NativeWS = window.WebSocket;
    window.WebSocket = class extends NativeWS {
      constructor(...args) {
        super(...args);
        window.__harborConnectCount += 1;
      }
    };
  }, { serverUrl: base, tok: token });

  await page.goto(`${base}/`);
  await page.waitForSelector('.app-shell[data-connection=online]', { timeout: 30000 });
  await page.waitForTimeout(4000);

  const before = await page.evaluate(() => ({
    connection: document.querySelector('.app-shell').getAttribute('data-connection'),
    connectCount: window.__harborConnectCount,
    title: document.querySelector('.hdr-title')?.textContent,
  }));

  await page.locator('.hdr-settings').click();
  await page.waitForSelector('.settings-panel');
  await page.screenshot({ path: OUT, fullPage: true });

  const open = await page.evaluate(() => ({
    connection: document.querySelector('.app-shell').getAttribute('data-connection'),
    connectCount: window.__harborConnectCount,
    connectScreen: document.querySelectorAll('.connect-screen').length,
  }));

  await page.locator('.settings-close').click();
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => ({
    connection: document.querySelector('.app-shell').getAttribute('data-connection'),
    connectCount: window.__harborConnectCount,
  }));

  console.log(JSON.stringify({ before, open, after, screenshot: OUT }, null, 2));

  await electronApp.close();
  require('node:fs').rmSync(dir, { recursive: true, force: true });

  const failures = [];
  if (before.connection !== 'online') failures.push('before not online');
  if (open.connection !== 'online') failures.push('open not online');
  if (after.connection !== 'online') failures.push('after not online');
  if (open.connectCount !== before.connectCount) failures.push('reconnect on open');
  if (after.connectCount !== before.connectCount) failures.push('reconnect after close');
  if (open.connectScreen > 0) failures.push('connect screen visible');
  if (failures.length) throw new Error(failures.join('; '));
  console.log('PASS: live 8787 settings sheet');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
