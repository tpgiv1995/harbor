'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const appDir = path.resolve(__dirname, '..');
const work = path.join(appDir, 'verify', 'folder-labels');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function buildAndDrive() {
  fs.mkdirSync(work, { recursive: true });
  const html = path.join(work, 'index.html');
  fs.writeFileSync(html, '<div id="root"></div><script type="module" src="/scripts/folder-label-fixture.jsx"></script>');
  await (await import('vite')).build({ root: appDir, configFile: false, base: './',
    build: { outDir: path.join(work, 'build'), emptyOutDir: true, rollupOptions: { input: html } } });
  require('esbuild').stop();
  const env = { ...process.env, HARBOR_NO_DAEMON_START: '1' };
  for (const [key, name] of Object.entries({ HOME: 'home', USERPROFILE: 'home', APPDATA: 'roaming', LOCALAPPDATA: 'local',
    TEMP: 'tmp', TMP: 'tmp', HARBOR_USER_DATA_DIR: 'user-data', HARBOR_SESSIOND_DIR: 'sessiond', HARBOR_CONTEXT_DIR: 'context' })) {
    env[key] = path.join(work, 'isolation', name); fs.mkdirSync(env[key], { recursive: true });
  }
  env.HARBOR_SESSIOND_SOCKET = path.join(env.HARBOR_SESSIOND_DIR, 'unused.sock');
  for (const key of ['ELECTRON_RUN_AS_NODE', 'HARBOR_ALLOW_REAL_SIGNALS', 'HARBOR_ALLOW_REAL_LAUNCH', 'HARBOR_ALLOW_REAL_DIALOGS']) delete env[key];
  const child = require('node:child_process').spawn(require('electron'), [__filename], { cwd: appDir, env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 60000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  console.log(JSON.stringify({ electronPid: child.pid, closed: true, code }));
  const report = JSON.parse(fs.readFileSync(path.join(work, 'result.json'), 'utf8'));
  console.log(JSON.stringify(report.checks, null, 2));
  assert.equal(code, 0, report.error); assert.equal(report.ok, true);
}

async function drive() {
  const { app, BrowserWindow } = require('electron');
  const report = { checks: [], windows: [], processes: [] };
  let win;
  app.setPath('home', process.env.HOME);
  app.setPath('userData', process.env.HARBOR_USER_DATA_DIR);
  app.setPath('sessionData', path.join(process.env.HARBOR_USER_DATA_DIR, 'chromium'));
  app.on('window-all-closed', () => {});
  const finish = code => {
    clearTimeout(timer);
    report.processes = app.getAppMetrics().map(({ pid, type }) => ({ pid, type }));
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report, null, 2)); app.exit(code);
  };
  const timer = setTimeout(() => { report.error = '60 second deadline'; finish(2); }, 60000);
  try {
    await app.whenReady();
    win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1280, height: 850,
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|devtools):/.test(details.url) }));
    for (const surface of ['session', 'orch']) {
      for (const [name, folder, expected] of [
        ['drive-root', 'C:\\', 'C:/'], ['unc-folder', '\\\\server\\share\\project', '//server/share/project'],
        ['single-segment', 'project', 'project'], ['trailing-separator', 'C:\\dev\\project\\', 'dev/project'],
      ]) {
        await win.loadFile(path.join(work, 'build', 'verify/folder-labels/index.html'), { query: { surface, folder } });
        const selector = surface === 'session' ? '.config-folder' : '.orch-queue-root';
        const script = `document.querySelector('${selector}')?.textContent`;
        let actual; const deadline = Date.now() + 3000;
        do { actual = await win.webContents.executeJavaScript(script); if (actual) break; await delay(30); } while (Date.now() < deadline);
        const wanted = surface === 'session' ? 'Start in ' + expected : expected;
        report.checks.push({ surface, name, actual, expected: wanted, passed: actual === wanted });
        report.windows.push({ surface, name, rendererPid: win.webContents.getOSProcessId(), visible: win.isVisible(), focused: win.isFocused() });
        assert.equal(win.isVisible(), false); assert.equal(win.isFocused(), false);
        win.webContents.invalidate(); await delay(100);
        fs.writeFileSync(path.join(work, surface + '-' + name + '.png'), (await win.webContents.capturePage()).toPNG());
      }
    }
    report.ok = report.checks.every(check => check.passed); finish(report.ok ? 0 : 1);
  } catch (error) { report.error = error.stack; finish(1); }
}
(process.versions.electron ? drive() : buildAndDrive()).catch(error => { console.error(error); process.exitCode = 1; });
