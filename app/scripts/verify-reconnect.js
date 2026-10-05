'use strict';
if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && !process.env.__HARBOR_XVFB) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, __HARBOR_XVFB: '1' };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const res = spawnSync('xvfb-run', ['-a', process.execPath, __filename], { stdio: 'inherit', env });
  process.exit(res.status == null ? 1 : res.status);
}
const path = require('node:path');
const APP = path.resolve(__dirname, '..');
const { _electron: electron } = require(APP + '/node_modules/@playwright/test');
const MARK = '/tmp/harbor-reconnect-test-sock-does-not-exist';
async function main() {
  setTimeout(() => { console.error('WATCHDOG'); process.exit(2); }, 180000).unref();
  const env = { ...process.env, HERDR_SOCKET_PATH: MARK, HARBOR_NO_DAEMON_START: '1', HARBOR_NO_TITLER: '1', HARBOR_E2E: '1' };
  const electronApp = await electron.launch({ executablePath: require(APP + '/node_modules/electron'), args: [APP], env, cwd: APP, timeout: 60000 });
  const page = await electronApp.firstWindow({ timeout: 60000 });
  await page.waitForSelector('.daemon-banner', { timeout: 30000 });
  const text = await page.locator('.daemon-banner-text').innerText();
  if (!/unreachable/i.test(text)) throw new Error('banner text wrong: ' + text);
  console.log('OK  degraded banner shows with honest text:', JSON.stringify(text.slice(0, 60)));
  const btn = page.locator('.daemon-banner-retry');
  if (!(await btn.count())) throw new Error('no reconnect button');
  await btn.click();
  console.log('OK  Reconnect clicked (app relaunches by design)');
  await new Promise((r) => setTimeout(r, 6000));
  await electronApp.close().catch(() => {});
  process.exit(0);
}
main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
