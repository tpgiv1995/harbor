'use strict';

// Render a self-contained HTML string to a PNG at an exact size and scale.
//
// Used to COMPOSE published images (the README hero, the phone shots on their
// ground) rather than to photograph the product. Everything the page needs has
// to be inline or a data: URI, because this loads over file:// with no server
// and no network.
//
// Electron rather than a headless browser on purpose: Electron is already a
// dependency of this repo, Playwright's browsers are not necessarily installed,
// and `--force-device-scale-factor` is the same lever the app captures use, so
// one mechanism produces every published pixel.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VERIFY, ownedRoot, captureEnv, hiddenMain, closeApp, assertHidden, reportIsolation } = require('./capture-runtime.cjs');

async function renderHtmlToPng({ html, width, height, scale = 2, out, themeSource = null, inspect = null }) {
  const { _electron: electron } = require('@playwright/test');
  fs.mkdirSync(VERIFY, { recursive: true });
  const dir = ownedRoot(fs.mkdtempSync(path.join(VERIFY, 'harbor-render-')));
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(page, html);
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--disable-gpu', `--force-device-scale-factor=${scale}`, hiddenMain],
    cwd: path.resolve(__dirname, '../..'),
    timeout: 60000,
    env: { ...captureEnv(dir), HARBOR_SHOT_ROOT: dir, HARBOR_CAPTURE_HTML: page,
      HARBOR_CAPTURE_WIDTH: String(width), HARBOR_CAPTURE_HEIGHT: String(height) },
  });
  try {
    const view = await app.firstWindow({ timeout: 60000 });
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
    }, { width, height });
    // The colour scheme is EMULATED, not set on nativeTheme. `themeSource =
    // 'dark'` is the obvious lever and it does nothing here: measured under
    // xvfb, a page whose only dark rule is `@media (prefers-color-scheme:dark)`
    // still painted white with themeSource set both ways. emulateMedia goes
    // through CDP's media override, which the media query does honour, and
    // unlike setViewportSize it leaves the device scale factor alone.
    if (themeSource) await view.emulateMedia({ colorScheme: themeSource });
    await view.waitForLoadState('load');
    // Web fonts are inlined or absent here, but layout still settles a frame
    // after load; a screenshot taken in the same tick catches an unstyled pass.
    await view.waitForTimeout(700);
    const dpr = await view.evaluate(() => window.devicePixelRatio);
    if (dpr !== scale) throw new Error(`render-html: expected ${scale}x, got devicePixelRatio ${dpr}`);
    const viewport = await view.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (viewport.width !== width || viewport.height !== height) throw new Error(`render-html: viewport was clamped: ${JSON.stringify(viewport)}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await assertHidden(app);
    if (inspect) await inspect(view);
    await view.screenshot({ path: out });
  } finally {
    await closeApp(app);
    reportIsolation(dir);
    fs.rmSync(ownedRoot(dir), { recursive: true, force: true });
  }
  return out;
}

function dataUri(file, mime) {
  const type = mime || (file.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

module.exports = { renderHtmlToPng, dataUri };
