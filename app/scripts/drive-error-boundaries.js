'use strict';

// Real renderer components, fixture data, compile-time fault injection. Every
// BrowserWindow stays hidden; this drive never loads the product main process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const appDir = path.resolve(__dirname, '..');
const work = path.join(appDir, 'verify', 'error-boundaries');
const report = { checks: [], windows: [], processes: [] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndDrive() {
  const { build } = await import('vite');
  fs.mkdirSync(work, { recursive: true });
  const phone = path.join(work, 'phone.html');
  fs.writeFileSync(phone, '<div id="root"></div><script type="module" src="/scripts/error-boundary-fixture.jsx"></script>');
  await build({
    root: appDir, configFile: false, base: './',
    plugins: [{
      name: 'boundary-faults', enforce: 'pre',
      transform(source, id) {
        const file = id.replace(/\\/g, '/');
        const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11);
        if (baseline && file.endsWith('/src/renderer/error-boundary.css')) {
          assert.match(baseline, /^[a-f0-9]{40}$/);
          const read = require('node:child_process').spawnSync('git', ['show', `${baseline}:app/src/renderer/error-boundary.css`], { cwd: appDir, windowsHide: true, timeout: 10000, encoding: 'utf8' });
          console.log(`baseline CSS pid: ${read.pid} exited ${read.status}`);
          assert.equal(read.status, 0, read.stderr);
          return read.stdout;
        }
        if (file.endsWith('/src/renderer/index.jsx')) {
          return `import '/scripts/error-boundary-fixture.jsx';\n${source}`;
        }
        if (file.endsWith('/src/renderer/ErrorBoundary.jsx')) {
          return source.replace('export class ErrorBoundary', 'class ProtectedBoundary')
            + '\nexport function ErrorBoundary(props) { return window.__withoutBoundary ? props.children : <ProtectedBoundary {...props} />; }';
        }
        if (file.endsWith('/notes/NotesView.jsx')) {
          return source.replace(/(export function NotesView\([^)]*\) \{)/, '$1\nif(window.__throwView) throw Error("Forced Notes render failure");');
        }
        if (file.endsWith('/src/renderer/stage/SessionTile.jsx')) {
          return source.replace('}, ref) {', '}, ref) {\nif(window.__throwTile === session.id) throw Error("Forced tile render failure");');
        }
        if (file.endsWith('/web/src/rpc/client.js')) {
          return source.replace('export function createRpcClient(', 'function unusedRpcClient(')
            + `\nexport function createRpcClient(options) { return {
              connect: () => options.onConnectionChange('connected'), disconnect: () => {},
              getState: () => 'connected', call: window.__boundaryCall,
              onChannel: () => () => {}, onConnection: () => () => {},
            }; }`;
        }
        return null;
      },
    }],
    build: { outDir: path.join(work, 'build'), emptyOutDir: true,
      rollupOptions: { input: { desktop: path.join(appDir, 'index.html'), phone } } },
  });
  // Vite's service has finished its work before Electron starts.
  require('esbuild').stop();
  const env = { ...process.env, HARBOR_NO_DAEMON_START: '1' };
  for (const [key, subdir] of Object.entries({
    HOME: 'home', USERPROFILE: 'home', APPDATA: 'roaming', LOCALAPPDATA: 'local',
    TEMP: 'tmp', TMP: 'tmp', HARBOR_USER_DATA_DIR: 'user-data',
    HARBOR_SESSIOND_DIR: 'sessiond', HARBOR_CONTEXT_DIR: 'context',
  })) {
    env[key] = path.join(work, 'isolation', subdir);
    fs.mkdirSync(env[key], { recursive: true });
  }
  env.HARBOR_SESSIOND_SOCKET = path.join(env.HARBOR_SESSIOND_DIR, 'unused.sock');
  delete env.HARBOR_ALLOW_REAL_SIGNALS;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], {
    cwd: appDir, env, windowsHide: true, stdio: 'inherit',
  });
  const timer = setTimeout(() => child.kill(), 120000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => clearTimeout(timer));
  console.log(JSON.stringify({ electronPid: child.pid, closed: true, code }));
  const result = JSON.parse(fs.readFileSync(path.join(work, 'result.json'), 'utf8'));
  console.log(JSON.stringify(result.palette, null, 2));
  assert.equal(code, 0);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.checks.length, 7);
  console.log(result.checks.join('\n'));
}

async function drive() {
  const { app, BrowserWindow, session } = require('electron');
  app.on('window-all-closed', () => {});
  app.setPath('home', process.env.HOME);
  app.setPath('userData', process.env.HARBOR_USER_DATA_DIR);
  app.setPath('sessionData', path.join(process.env.HARBOR_USER_DATA_DIR, 'chromium'));
  const timer = setTimeout(() => { report.error = '90 second deadline'; finish(2); }, 90000);
  const windows = [];
  const finish = (code) => {
    clearTimeout(timer);
    report.processes = app.getAppMetrics().map(({ pid, type }) => ({ pid, type }));
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report, null, 2));
    app.exit(code);
  };
  try {
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !/^(file|data|devtools):/.test(details.url) });
    });
    for (const phone of [false, true]) {
      for (const withoutBoundary of [true, false]) {
        const label = `${phone ? 'phone' : 'desktop'}-${withoutBoundary ? 'without' : 'with'}`;
        const win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true,
          width: phone ? 390 : 1280, height: phone ? 844 : 850,
          webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, partition: label } });
        win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
          callback({ cancel: !/^(file|data|devtools):/.test(details.url) });
        });
        windows.push(win);
        const js = (code) => win.webContents.executeJavaScript(code);
        const until = async (code) => {
          const end = Date.now() + 12000;
          while (Date.now() < end) { if (await js(code)) return; await delay(80); }
          report.failedBody = await js('document.body.innerText');
          fs.writeFileSync(path.join(work, `${label}-failed.png`), (await win.webContents.capturePage()).toPNG());
          throw Error(`Timed out (${label}): ${code}`);
        };
        const shot = async (suffix) => {
          await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
          win.webContents.invalidate();
          await delay(200);
          fs.writeFileSync(path.join(work, `${label}-${suffix}.png`), (await win.webContents.capturePage()).toPNG());
          (report.states ||= []).push({ label, suffix, rootChildren: await js("document.querySelector('#root').childElementCount"), text: await js('document.body.innerText') });
        };
        const nav = phone ? '.bottom-nav' : '.rail';
        const select = (name) => js(phone
          ? `[...document.querySelectorAll('.bottom-nav-item')].find(b=>b.textContent===${JSON.stringify(name)}).click()`
          : `document.querySelector('.view-switch-btn[aria-label="${name}"]').click()`);
        win.webContents.on('console-message', (_event, level, message) => {
          if (level >= 2) (report.console ||= []).push({ label, message });
        });
        await win.loadFile(path.join(work, 'build', phone ? 'verify/error-boundaries/phone.html' : 'index.html'), { query: phone ? { phone: '1' } : {} });
        await until(`Boolean(document.querySelector('${nav}'))`);
        await js(`window.__withoutBoundary=${withoutBoundary}; window.__throwView=true;`);
        await select('Notes');
        if (withoutBoundary) {
          await until("document.querySelector('#root').childElementCount===0");
          assert.equal(await js(`Boolean(document.querySelector('${nav}'))`), false);
          report.checks.push(`${label}: root unmounted`);
          await shot('blank');
        } else {
          await until("Boolean(document.querySelector('[aria-label=\"Notes error\"]'))");
          assert.equal(await js(`Boolean(document.querySelector('${nav}'))`), true);
          assert.match(await js("document.querySelector('.view-error').textContent"), /Forced Notes render failure/);
          await shot('error');
          // Force only this hidden renderer's pseudo-state. No OS window focus.
          win.webContents.debugger.attach('1.3');
          await win.webContents.debugger.sendCommand('DOM.enable');
          await win.webContents.debugger.sendCommand('CSS.enable');
          const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
          const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.view-error-retry' });
          await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus-visible'] });
          for (const variant of ['tokens', 'changed-tokens']) {
            const palette = await js(`(() => {
              const root = document.documentElement;
              if (${JSON.stringify(variant)} === 'changed-tokens') {
                root.style.setProperty('--ln', 'rgb(71, 82, 93)');
                root.style.setProperty('--bg', 'rgb(21, 32, 43)');
                root.style.setProperty('--tx', 'rgb(231, 242, 253)');
              }
              const probe = document.createElement('div');
              probe.style.cssText = 'border:1px solid var(--ln);background:var(--bg);color:var(--tx)';
              document.body.append(probe);
              const expected = getComputedStyle(probe), actual = getComputedStyle(document.querySelector('.view-error'));
              const fields = ['borderTopColor', 'backgroundColor', 'color'];
              const result = Object.fromEntries(fields.map(field => [field, { expected: expected[field], actual: actual[field] }]));
              result.focusOutline = { expected: expected.color, actual: getComputedStyle(document.querySelector('.view-error-retry')).outlineColor };
              probe.remove();
              for (const key of ['--ln', '--bg', '--tx']) root.style.removeProperty(key);
              return result;
            })()`);
            (report.palette ||= []).push({ label, variant, fields: palette, passed: Object.values(palette).every(value => value.actual === value.expected) });
          }
          win.webContents.debugger.detach();
          report.checks.push(`${label}: palette checked against current and changed tokens`);
          await js("window.__throwView=false; document.querySelector('.view-error-retry').click()");
          await until(`!document.querySelector('.view-error') && Boolean(document.querySelector('${phone ? '.notes-mobile' : '.notes-view'}'))`);
          await shot('retry');
          await select('Tasks');
          await until(`Boolean(document.querySelector('${phone ? '.tasks-mobile' : '.tasks-view'}'))`);
          await shot('tasks');
          report.checks.push(`${label}: error card, navigation, retry, and Tasks passed`);
          if (!phone) {
            await select('Agents');
            const sessions = ['one', 'two'].map((id) => ({ id, title: id, project: 'fixture', provider: 'claude', isLive: false, lastActiveMs: Date.now(), lastActive: new Date().toISOString() }));
            await js(`{ const model={projects:[{label:'fixture',hasLive:true,sessionCount:2,sessions:${JSON.stringify(sessions)}}],liveProjects:['fixture']}; window.__setSidebarModelForTest(model); window.__setRailModelForTest(model); }`);
            // Open the real sidebar rows, then fault only one tile on its next render.
            await until("document.querySelectorAll('[data-session-id]').length>=2");
            await js("document.querySelector('[data-session-id=\"one\"]').click(); document.querySelector('[data-session-id=\"two\"]').click()");
            await until("document.querySelectorAll('.win2').length===2");
            await js("window.__throwTile='one'; window.__setTranscriptForTest('one',{blocks:[]})");
            await until("Boolean(document.querySelector('[aria-label=\"Session: one error\"]'))");
            assert.equal(await js("document.querySelectorAll('.win2').length"), 1);
            await shot('tile');
            await js("window.__throwTile=null; document.querySelector('.view-error-retry').click()");
            await until("document.querySelectorAll('.win2').length===2");
            report.checks.push('desktop: one failed tile preserves sibling; Retry restores both');
          }
        }
        report.windows.push({ label, rendererPid: win.webContents.getOSProcessId(), visible: win.isVisible(), focused: win.isFocused() });
        assert.equal(win.isVisible(), false);
        assert.equal(win.isFocused(), false);
        win.destroy();
      }
    }
    report.ok = report.palette.every(check => check.passed);
    finish(report.ok ? 0 : 1);
  } catch (error) { report.error = error.stack; finish(1); }
}

(process.versions.electron ? drive() : buildAndDrive()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
