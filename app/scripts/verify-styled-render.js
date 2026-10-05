'use strict';

// Never open test windows on the live desktop (they steal focus from whatever
// the user is doing): re-exec under xvfb unless explicitly headed.
if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  && process.env.HARBOR_E2E_HEADED !== '1' && !process.env.__HARBOR_XVFB) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, __HARBOR_XVFB: '1' };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const res = spawnSync('xvfb-run', ['-a', process.execPath, __filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(res.status == null ? 1 : res.status);
}

// Standalone driven proof that the BUILT app renders with the Slate stylesheet
// applied, not as raw HTML. Exists because batch-10 (2026-07-28) deleted
// `import './styles.css'` from index.jsx, the bundle shipped with 2.5KB of
// xterm CSS instead of the 129KB token sheet, and every unit test stayed
// green while the app was unusable. Asserts the COMPUTED style, from inside
// the real window, so it cannot pass on a build that lost its CSS.

const assert = require('node:assert/strict');
const { launchHarbor, closeHarbor } = require('../test/e2e/helpers/electron.js');
const { startHarness, teardownHarness } = require('../test/e2e/helpers/terminal-harness.js');

async function main() {
  const harness = await startHarness({ stress: false });
  const { electronApp, page } = await launchHarbor({ HERDR_SOCKET_PATH: harness.socketPath });
  try {
    const probe = await page.evaluate(() => {
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      const railWidth = document.querySelector('.rail')
        ? getComputedStyle(document.querySelector('.rail')).width : null;
      const cssBytes = Array.from(document.styleSheets).reduce((n, s) => {
        try { return n + Array.from(s.cssRules).length; } catch { return n; }
      }, 0);
      return { bodyBg, railWidth, cssRuleCount: cssBytes };
    });
    // --bg is #0b0c0f; an unstyled document computes rgba(0, 0, 0, 0).
    assert.equal(probe.bodyBg, 'rgb(11, 12, 15)', `body background must be the Slate --bg token, got ${probe.bodyBg}`);
    assert.ok(probe.cssRuleCount > 500, `expected the full token sheet (>500 rules), got ${probe.cssRuleCount}`);
    assert.ok(probe.railWidth && probe.railWidth !== 'auto', `rail must have a styled width, got ${probe.railWidth}`);
    if (process.env.VERIFY_SHOT) await page.screenshot({ path: process.env.VERIFY_SHOT });
    console.log(`OK styled render: body ${probe.bodyBg}, ${probe.cssRuleCount} CSS rules, rail ${probe.railWidth}`);
  } finally {
    await closeHarbor(electronApp, page);
    await teardownHarness(harness);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
