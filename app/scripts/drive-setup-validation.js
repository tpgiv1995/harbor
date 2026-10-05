'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const appDir = path.resolve(__dirname, '..');
const work = path.join(appDir, 'verify', 'setup-validation');
const report = { checks: [], pid: process.pid };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndDrive() {
  fs.mkdirSync(work, { recursive: true });
  const html = path.join(work, 'index.html');
  fs.writeFileSync(html, '<div id="root"></div><script type="module" src="./entry.jsx"></script>');
  fs.writeFileSync(path.join(work, 'entry.jsx'), `import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SetupWizard } from '../../src/renderer/setup/SetupWizard.jsx';
    import '../../src/renderer/styles.css';
    createRoot(document.getElementById('root')).render(<SetupWizard onClose={result => { window.__completed = result.completed; }} />);`);
  fs.writeFileSync(path.join(work, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('harbor', {setup: Object.fromEntries(
      ['detect','preview','save','catalog','symlinkPlan'].map(name=>[name,payload=>ipcRenderer.invoke('setup:'+name.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),payload)])),
      session:{newOptions:async()=>({providers:{}})}});`);
  await (await import('vite')).build({ root: appDir, configFile: false, base: './',
    build: { outDir: path.join(work, 'build'), emptyOutDir: true, rollupOptions: { input: html } } });
  require('esbuild').stop();
  const env = { ...process.env, HARBOR_NO_DAEMON_START: '1' };
  for (const [key, name] of Object.entries({ HOME: 'home', USERPROFILE: 'home', APPDATA: 'roaming', LOCALAPPDATA: 'local',
    TEMP: 'tmp', TMP: 'tmp', HARBOR_USER_DATA_DIR: 'user-data', HARBOR_SESSIOND_DIR: 'sessiond', HARBOR_CONTEXT_DIR: 'context' })) {
    env[key] = path.join(work, 'isolation', name);
    fs.mkdirSync(env[key], { recursive: true });
  }
  env.HARBOR_SESSIOND_SOCKET = path.join(env.HARBOR_SESSIOND_DIR, 'unused.sock');
  delete env.HARBOR_ALLOW_REAL_SIGNALS;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], {
    cwd: appDir, env, windowsHide: true, stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill(), 90000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); })
    .finally(() => clearTimeout(timer));
  console.log(JSON.stringify({ electronPid: child.pid, closed: true, code }));
  const result = JSON.parse(fs.readFileSync(path.join(work, 'result.json'), 'utf8'));
  assert.equal(code, 0, result.error);
  assert.equal(result.ok, true, result.error);
  console.log(result.checks.join('\n'));
}

async function drive() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.setPath('home', process.env.HOME);
  app.setPath('userData', process.env.HARBOR_USER_DATA_DIR);
  app.setPath('sessionData', path.join(process.env.HARBOR_USER_DATA_DIR, 'chromium'));
  app.on('window-all-closed', () => {});
  let win;
  const finish = (code) => {
    clearTimeout(timer);
    report.processes = app.getAppMetrics().map(({ pid, type }) => ({ pid, type }));
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report, null, 2));
    app.exit(code);
  };
  const timer = setTimeout(() => { report.error = '60 second deadline'; finish(2); }, 60000);
  try {
    await app.whenReady();
    const bin = path.join(work, process.platform === 'win32' ? 'fixture.cmd' : 'fixture');
    const writeBin = () => fs.writeFileSync(bin, 'never execute this fixture', { mode: 0o755 });
    writeBin();
    const detected = { os: process.platform, homedir: work, shell: process.execPath,
      claudeHomes: [{ id: 'account', path: work, exists: true }], providers: { claude: { found: false, path: path.join(work, 'missing-cli.exe') } } };
    const model = require('../src/renderer/setup/wizard-model.cjs');
    let config = model.configFromWizard(model.initialState(detected));
    config.setup.completed = false;
    report.saves = 0;
    require('../src/main/setup/ipc.js').registerSetupIpc({
      ipcMain, getConfig: () => config,
      detectEnvironment: async () => detected,
      detectCatalog: async () => ({ commands: [], homes: [] }),
      saveConfig: async (next) => {
        config = next; report.saves += 1;
        fs.writeFileSync(path.join(work, 'saved-config.json'), JSON.stringify(next));
        return next;
      },
    });
    win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1160, height: 850,
      webPreferences: { preload: path.join(work, 'preload.cjs'), offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|devtools):/.test(details.url) }));
    const js = (code) => win.webContents.executeJavaScript(code);
    const until = async (code) => {
      const end = Date.now() + 8000;
      while (Date.now() < end) { if (await js(code)) return; await delay(80); }
      throw Error(`Timed out: ${code}; body=${await js('document.body.innerText')}`);
    };
    const shot = async (name) => {
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      win.webContents.invalidate(); await delay(200);
      fs.writeFileSync(path.join(work, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    const step = (name) => js(`document.querySelector('.setup-step[data-step="${name}"]').click()`);
    await win.loadFile(path.join(work, 'build', 'verify/setup-validation/index.html'));
    await until("Boolean(document.querySelector('.setup-step')) && document.body.textContent.includes('Install and sign in')");
    await shot('install-guidance');
    await step('defaults');
    await until("Boolean(document.querySelector('.setup-finish')) && document.body.innerText.includes('executable not found')");
    assert.equal(await js("document.querySelector('.setup-finish').disabled"), true);
    assert.equal(report.saves, 0);
    await shot('missing-executable');
    report.checks.push('missing executable keeps Finish disabled');
    assert.equal(await js("Boolean(document.querySelector('.setup-use-unverified'))"), true, 'unconfirmed path must offer an explicit override');
    await js("document.querySelector('.setup-use-unverified').click()");
    await until("!document.querySelector('.setup-finish').disabled");
    assert.equal(await js("document.body.innerText.includes('could not confirm')"), true);
    await shot('accepted-unverified-path');
    await js("document.querySelector('.setup-finish').click()");
    await until('window.__completed===true');
    assert.equal(config.setup.executableApprovals.claude, detected.providers.claude.path);
    report.checks.push('explicit path override reaches the real save handler and retains a warning');
    await win.reload();
    await until("Boolean(document.querySelector('.setup-step'))");
    await step('defaults');
    await until("Boolean(document.querySelector('.setup-use-unverified'))");
    assert.equal(await js("document.querySelector('.setup-finish').disabled"), true);
    report.checks.push('reopening setup requires a new explicit override');
    report.saves = 0;
    fs.writeFileSync(detected.providers.claude.path, 'never execute this fixture', { mode: 0o755 });
    await js("[...document.querySelectorAll('button')].find(button=>button.textContent==='Check again').click()");
    await until("!document.querySelector('.setup-finish').disabled");
    report.checks.push('Check again recognizes an installation without editing the path');
    fs.unlinkSync(detected.providers.claude.path);
    await step('claude');
    await until("Boolean(document.querySelector('input[placeholder=\"claude\"]'))");
    await js(`{ const input=document.querySelector('input[placeholder="claude"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(bin)}); input.dispatchEvent(new Event('input',{bubbles:true})); }`);
    await shot('chosen-executable');
    await step('defaults');
    await until("Boolean(document.querySelector('.setup-finish')) && !document.querySelector('.setup-finish').disabled");
    await shot('checked-executable');
    fs.unlinkSync(bin);
    await js("document.querySelector('.setup-finish').click()");
    await until("document.querySelector('.setup-foot-msg').innerText.includes('executable not found')");
    assert.equal(report.saves, 0);
    await shot('removed-before-finish');
    assert.equal(await js("Boolean(document.querySelector('.setup-use-unverified'))"), true);
    report.checks.push('deletion after preview is refused at Finish without saving');
    writeBin();
    await js("document.querySelector('.setup-finish').click()");
    await until('window.__completed===true');
    assert.equal(report.saves, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'saved-config.json'))).setup.completed, true);
    report.checks.push('restored executable allows one completed save');
    report.window = { visible: win.isVisible(), focused: win.isFocused(), rendererPid: win.webContents.getOSProcessId() };
    assert.equal(report.window.visible, false);
    assert.equal(report.window.focused, false);
    report.ok = true;
    finish(0);
  } catch (error) { report.error = error.stack; finish(1); }
}

(process.versions.electron ? drive() : buildAndDrive()).catch((error) => { console.error(error); process.exitCode = 1; });
