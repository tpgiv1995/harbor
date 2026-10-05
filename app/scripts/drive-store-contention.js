'use strict';

// Actual views and hooks with deterministic refused IPC results. No product
// main, provider process, network connection, or visible window is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const appDir = path.resolve(__dirname, '..');
const work = path.join(appDir, 'verify', 'store-contention');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndDrive() {
  fs.mkdirSync(work, { recursive: true });
  const html = path.join(work, 'index.html');
  fs.writeFileSync(html, '<div id="root"></div><script type="module" src="/scripts/store-contention-fixture.jsx"></script>');
  fs.writeFileSync(path.join(work, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('reviewStore',{call:(channel,op)=>ipcRenderer.invoke('review:store',channel,op)});`);
  await (await import('vite')).build({ root: appDir, configFile: false, base: './',
    plugins: [{ name: 'observe-store-hooks', enforce: 'pre', transform(source, id) {
      if (/\/(use-notes|use-tasks|useNotes|useTasks)\.js$/.test(id.replace(/\\/g, '/'))) {
        return source.replace(/\r\n/g, '\n').replace('return {\n    doc,', 'return window.__storeState = {\n    doc,');
      }
      return null;
    } }],
    build: { outDir: path.join(work, 'build'), emptyOutDir: true, rollupOptions: { input: html } },
  });
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
  const report = JSON.parse(fs.readFileSync(path.join(work, 'result.json'), 'utf8'));
  console.log(JSON.stringify(report.checks, null, 2));
  assert.equal(code, 0, report.error);
  assert.equal(report.ok, true);
}

async function drive() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const report = { checks: [], windows: [], processes: [] };
  const windows = [];
  app.setPath('userData', process.env.HARBOR_USER_DATA_DIR);
  app.setPath('sessionData', path.join(process.env.HARBOR_USER_DATA_DIR, 'chromium'));
  app.on('window-all-closed', () => {});
  const finish = (code) => {
    clearTimeout(timer);
    report.processes = app.getAppMetrics().map(({ pid, type }) => ({ pid, type }));
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report, null, 2));
    app.exit(code);
  };
  const timer = setTimeout(() => { report.error = '60 second deadline'; finish(2); }, 60000);
  try {
    await app.whenReady();
    const models = { notes: require('../src/shared/notes-model.cjs'), tasks: require('../src/shared/tasks-model.cjs') };
    const docs = Object.fromEntries(Object.entries(models).map(([kind, model]) => [kind,
      model.applyOp(model.emptyDoc(), { type: `${kind === 'notes' ? 'note' : 'task'}.add`, title: 'Saved work', body: 'Saved body', myDay: true }).doc,
    ]));
    let mode = 'error';
    let writes = 0;
    ipcMain.handle('review:store', (_event, channel, op) => {
      const [kind, operation] = channel.split(':');
      if (operation === 'read') return mode === 'error'
        ? { ok: false, retryable: true, reason: 'Store busy; retry the change' }
        : { ok: true, doc: docs[kind], repairDeferred: mode === 'deferred' };
      writes += 1;
      if (mode === 'allow') {
        const result = models[kind].applyOp(docs[kind], op);
        if (result.ok) docs[kind] = result.doc;
        return result;
      }
      // A failed operation may carry a fallback document. It is not a new
      // authoritative snapshot and must not erase the view or an editor.
      return { ok: false, retryable: true, reason: 'Store busy; retry the change', doc: models[kind].emptyDoc() };
    });
    for (const surface of ['desktop-notes', 'desktop-tasks', 'phone-notes', 'phone-tasks']) {
      const phone = surface.startsWith('phone');
      const kind = surface.endsWith('notes') ? 'notes' : 'tasks';
      const win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: phone ? 390 : 1280, height: 850,
        webPreferences: { preload: path.join(work, 'preload.cjs'), offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, partition: surface } });
      windows.push(win);
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|devtools):/.test(details.url) }));
      const js = (source) => win.webContents.executeJavaScript(source);
      const until = async (source) => {
        const end = Date.now() + 5000;
        while (Date.now() < end) { if (await js(source)) return; await delay(40); }
        throw Error(`${surface}: timed out: ${source}`);
      };
      const shot = async (suffix) => {
        await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
        win.webContents.invalidate(); await delay(120);
        fs.writeFileSync(path.join(work, `${surface}-${suffix}.png`), (await win.webContents.capturePage()).toPNG());
      };
      const check = async (name, source) => report.checks.push({ surface, name, passed: Boolean(await js(source)) });
      const load = async (next) => {
        mode = next;
        await win.loadFile(path.join(work, 'build', 'verify/store-contention/index.html'), { query: { surface } });
        await until('Boolean(window.__storeState?.error || window.__storeState?.doc)');
      };
      await load('error');
      await check('initial refusal displays its retry reason', "document.body.innerText.includes('Store busy; retry the change')");
      await shot('initial-error');
      await load('deferred');
      await check('read-only snapshot displays saved work and a busy notice', `window.__storeState.doc.${kind}[0]?.title==='Saved work' && /busy/i.test(document.body.innerText)`);
      await shot('snapshot');
      await js(`window.__storeState.mutate({type:'${kind === 'notes' ? 'note' : 'task'}.update'})`);
      await delay(100);
      await check('refused mutation preserves saved work and displays retry', `window.__storeState.doc.${kind}[0]?.title==='Saved work' && document.body.innerText.includes('Store busy; retry the change')`);
      await shot('mutation-refused');
      if (surface === 'phone-notes' || surface === 'desktop-tasks') {
        await load('normal');
        await js(`document.querySelector('${phone ? '.note-row' : '.task-title'}').click()`);
        const selector = phone ? '.ne-title' : '.task-editor-title';
        await until(`Boolean(document.querySelector('${selector}'))`);
        await js(`{ const input=document.querySelector('${selector}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Unsaved draft'); input.dispatchEvent(new Event('input',{bubbles:true})); }`);
        const before = writes;
        await js(`document.querySelector('${phone ? '.ne-back' : '.task-editor-close'}').click()`);
        const deadline = Date.now() + 3000;
        while (writes === before && Date.now() < deadline) await delay(30);
        await delay(150);
        await check('refused editor save retains its draft and retry message', `document.querySelector('${selector}')?.value==='Unsaved draft' && document.body.innerText.includes('Store busy; retry the change')`);
        await shot('editor-refused');
        mode = 'allow';
        await js(`document.querySelector('${phone ? '.ne-back' : '.task-editor-close'}').click()`);
        await until(`!document.querySelector('${selector}')`);
        await check('retry saves the retained draft before closing', `window.__storeState.doc.${kind}[0]?.title==='Unsaved draft'`);
        await shot('editor-retried');
        docs[kind] = models[kind].applyOp(models[kind].emptyDoc(), { type: `${kind === 'notes' ? 'note' : 'task'}.add`, title: 'Saved work', body: 'Saved body', myDay: true }).doc;
      }
      if (kind === 'tasks') {
        await load('normal');
        const form = phone ? '.tasks-mobile-add' : '.tasks-add';
        await js(`{ const input=document.querySelector('${form} input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Unsaved task'); input.dispatchEvent(new Event('input',{bubbles:true})); }`);
        await js(`document.querySelector('${form}').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
        await delay(150);
        await check('refused quick add retains its input and saved rows', `document.querySelector('${form} input').value==='Unsaved task' && window.__storeState.doc.tasks[0]?.title==='Saved work' && document.body.innerText.includes('Store busy; retry the change')`);
        await shot('add-refused');
      }
      report.windows.push({ surface, rendererPid: win.webContents.getOSProcessId(), visible: win.isVisible(), focused: win.isFocused() });
      assert.equal(win.isVisible(), false);
      assert.equal(win.isFocused(), false);
      win.destroy();
    }
    report.ok = report.checks.every((check) => check.passed);
    finish(report.ok ? 0 : 1);
  } catch (error) { report.error = error.stack; finish(1); }
}

(process.versions.electron ? drive() : buildAndDrive()).catch((error) => { console.error(error); process.exitCode = 1; });
