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

async function renderHtmlToPng({ html, width, height, scale = 2, out, themeSource = null }) {
  const { _electron: electron } = require('@playwright/test');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-render-'));
  const page = path.join(dir, 'page.html');
  const main = path.join(dir, 'main.js');
  fs.writeFileSync(page, html);
  fs.writeFileSync(main, `'use strict';
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: ${width}, height: ${height}, useContentSize: true, show: true,
    frame: false, backgroundColor: '#00000000',
  });
  win.loadFile(${JSON.stringify(page)});
});
`);
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', `--force-device-scale-factor=${scale}`, main],
    cwd: path.resolve(__dirname, '../..'),
    timeout: 60000,
  });
  try {
    const view = await app.firstWindow({ timeout: 60000 });
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
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await view.screenshot({ path: out });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

function dataUri(file, mime) {
  const type = mime || (file.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

module.exports = { renderHtmlToPng, dataUri };
