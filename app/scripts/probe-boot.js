'use strict';
/* Boot-phase timing probe: where do 30 seconds go? Run under xvfb-run. */
const { _electron: electron } = require('@playwright/test');
const path = require('node:path');
const APP_ROOT = path.resolve(__dirname, '..');

(async () => {
  const t0 = Date.now();
  const mark = (label) => console.log(`[probe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
  const electronApp = await electron.launch({
    executablePath: require('electron'),
    args: [APP_ROOT],
    env: { ...process.env, HARBOR_E2E: '1', HARBOR_E2E_FAKE_LAUNCH: '1', HARBOR_SKIP_DELIVERY_CONFIRM: '1', ELECTRON_DISABLE_GPU: '1' },
    cwd: APP_ROOT,
    timeout: 120000,
  });
  mark('electron launched');
  const proc = electronApp.process();
  proc.stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`));
  proc.stderr?.on('data', (d) => process.stdout.write(`[main-err] ${d}`));
  const page = await electronApp.firstWindow({ timeout: 120000 });
  mark('first window');
  await page.waitForSelector('.rail', { timeout: 45000 });
  mark('.rail visible');
  await page.waitForFunction(() => (window.__harborSidebarStats?.indexerSessionCount ?? 0) > 0, null, { timeout: 45000 });
  mark('indexer stats > 0');
  await electronApp.close({ force: true }).catch(() => {});
  process.exit(0);
})().catch((error) => { console.error('probe failed:', error.message); process.exit(1); });
