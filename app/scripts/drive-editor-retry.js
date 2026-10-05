'use strict';

// Actual views and hooks with deterministic refused IPC results. No product
// main, provider process, network connection, or visible window is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const appDir = path.resolve(__dirname, '..');
const work = path.join(appDir, 'verify', 'editor-retry');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndDrive() {
  fs.mkdirSync(work, { recursive: true });
  const html = path.join(work, 'index.html');
  fs.writeFileSync(html, '<div id="root"></div><script type="module" src="/scripts/store-contention-fixture.jsx"></script>');
  fs.writeFileSync(path.join(work, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('reviewStore',{call:(channel,op)=>ipcRenderer.invoke('review:store',channel,op)});`);
  await (await import('vite')).build({ root: appDir, configFile: false, base: './',
    plugins: [{ name: 'observe-store-hooks', enforce: 'pre', transform(source, id) {
      const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11);
      const relative = path.relative(path.resolve(appDir, '..'), id).replace(/\\/g, '/');
      if (baseline && ['app/src/renderer/tasks/TaskEditor.jsx', 'app/src/renderer/tasks/TasksView.jsx', 'app/src/renderer/notes/NotesView.jsx', 'app/web/src/notes/NotesView.jsx', 'app/web/src/tasks/TasksView.jsx'].includes(relative)) {
        assert.match(baseline, /^[a-f0-9]{40}$/);
        const read = require('node:child_process').spawnSync('git', ['show', `${baseline}:${relative}`], { cwd: appDir, windowsHide: true, timeout: 10000, encoding: 'utf8' });
        console.log(`baseline source pid: ${read.pid} exited ${read.status}`);
        assert.equal(read.status, 0, read.stderr);
        return read.stdout;
      }
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
  let win;
  app.setPath('home', process.env.HOME);
  app.setPath('userData', process.env.HARBOR_USER_DATA_DIR);
  app.setPath('sessionData', path.join(process.env.HARBOR_USER_DATA_DIR, 'chromium'));
  app.on('window-all-closed', () => {});
  const finish = code => {
    clearTimeout(timer);
    report.processes = app.getAppMetrics().map(({ pid, type }) => ({ pid, type }));
    if (win && !win.isDestroyed()) win.destroy();
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(report, null, 2));
    app.exit(code);
  };
  const timer = setTimeout(() => { report.error = '90 second deadline'; finish(2); }, 90000);
  try {
    await app.whenReady();
    const models = { notes: require('../src/shared/notes-model.cjs'), tasks: require('../src/shared/tasks-model.cjs') };
    let docs, mode, held, writes;
    const refusal = { ok: false, retryable: true, reason: 'Store busy; retry the change' };
    const apply = (kind, op) => { const result = models[kind].applyOp(docs[kind], op); if (result.ok) docs[kind] = result.doc; return result; };
    ipcMain.handle('review:store', (_event, channel, op) => {
      const [kind, operation] = channel.split(':');
      if (operation === 'read') return { ok: true, doc: docs[kind] };
      writes.push({ kind, op });
      if (mode === 'hold') return new Promise(resolve => held.push(allow => resolve(allow ? apply(kind, op) : refusal)));
      return mode === 'allow' ? apply(kind, op) : refusal;
    });
    win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1280, height: 850,
      webPreferences: { preload: path.join(work, 'preload.cjs'), offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|devtools):/.test(details.url) }));
    const js = source => win.webContents.executeJavaScript(source);
    const until = async source => { const end = Date.now() + 3000; while (Date.now() < end) { if (await js(source)) return; await delay(30); } throw Error('timed out: ' + source); };
    const waitHeld = async () => { const end = Date.now() + 2500; while (!held.length && Date.now() < end) await delay(20); assert.ok(held.length, 'save entered the held IPC'); };
    const release = allow => { mode = allow ? 'allow' : 'refuse'; for (const answer of held.splice(0)) answer(allow); };
    const input = (selector, value) => js(`{ const el=document.querySelector(${JSON.stringify(selector)}); const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); }`);
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const blur = selector => js(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new FocusEvent('focusout',{bubbles:true}))`);
    const body = value => js(`{ const el=document.querySelector('.notes-compose-editor[contenteditable], .notes-compose-editor [contenteditable]'); el.textContent=${JSON.stringify(value)}; el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'})); }`);
    const load = async surface => {
      release(false); writes = []; held = []; mode = 'refuse';
      win.setSize(surface.startsWith('phone') ? 390 : 1280, 850);
      docs = Object.fromEntries(Object.entries(models).map(([kind, model]) => [kind, model.applyOp(model.emptyDoc(), { type: kind === 'notes' ? 'note.add' : 'task.add', title: 'Saved work', body: 'Saved body', myDay: true }).doc]));
      docs.notes = models.notes.applyOp(docs.notes, { type: 'note.add', title: 'Other note', body: 'Other body' }).doc;
      docs.notes = models.notes.applyOp(docs.notes, { type: 'group.add', name: 'Other group' }).doc;
      docs.tasks = models.tasks.applyOp(docs.tasks, { type: 'list.add', name: 'Other list' }).doc;
      await win.loadFile(path.join(work, 'build', 'verify/editor-retry/index.html'), { query: { surface } });
      await until('Boolean(window.__storeState?.doc)');
      await js('localStorage.clear()');
      // Remount after clearing persisted test drafts from the preceding scenario.
      await win.loadFile(path.join(work, 'build', 'verify/editor-retry/index.html'), { query: { surface } }); await until('Boolean(window.__storeState?.doc)');
      if (surface === 'desktop-tasks') { await click('.task-title'); await until("Boolean(document.querySelector('.task-editor-title'))"); }
      if (surface === 'phone-notes') { await click('.note-row'); await until("Boolean(document.querySelector('.ne-title'))"); }
      if (surface === 'desktop-notes') {
        await js("[...document.querySelectorAll('.notes-item-main')].find(el=>el.innerText.includes('Saved work')).click()");
        await until("document.querySelector('.notes-title-input')?.value==='Saved work'");
      }
    };
    held = []; writes = [];
    const shot = async name => { win.webContents.invalidate(); await delay(100); fs.writeFileSync(path.join(work, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
    const scenario = async (name, surface, action) => {
      try { await load(surface); await action(); report.checks.push({ name, surface, passed: true }); }
      catch (error) { report.checks.push({ name, surface, passed: false, error: error.message }); }
      report.windows.push({ name, rendererPid: win.webContents.getOSProcessId(), visible: win.isVisible(), focused: win.isFocused() });
      release(false); await delay(80);
      win.webContents.invalidate(); await delay(100);
      fs.writeFileSync(path.join(work, name + '.png'), (await win.webContents.capturePage()).toPNG());
    };
    for (const field of ['starred', 'myDay', 'dueDate', 'listId', 'tags']) {
      await scenario('task-field-' + field, 'desktop-tasks', async () => {
        await input('.task-editor-title', 'Pending title');
        if (field === 'starred') await click('.task-editor-head .task-star');
        if (field === 'myDay') await click('.task-editor-toggle');
        if (field === 'dueDate') await input('.task-editor-date', '2026-10-15');
        if (field === 'listId') await input('.task-editor-select', docs.tasks.lists[1].id);
        if (field === 'tags') { await input('.task-editor-tag-input', 'retained'); await blur('.task-editor-tag-input'); }
        await delay(100);
        const label = { starred: 'importance', myDay: 'My Day', dueDate: 'due date', listId: 'list', tags: 'tags' }[field];
        assert.ok((await js("document.querySelector('.edit-save-status')?.textContent || ''")).includes(label), 'failure names the intended field');
        await shot('refused-task-' + field);
        mode = 'allow'; await click('.task-editor-close');
        await until("!document.querySelector('.task-editor-title')");
        const saved = docs.tasks.tasks[0];
        assert.equal(saved.title, 'Pending title');
        if (field === 'starred') assert.equal(saved.starred, true);
        if (field === 'myDay') assert.equal(saved.myDayDate, null);
        if (field === 'dueDate') assert.equal(saved.dueDate, '2026-10-15');
        if (field === 'listId') assert.equal(saved.listId, docs.tasks.lists[1].id);
        if (field === 'tags') assert.deepEqual(saved.tags, ['retained']);
      });
    }
    await scenario('task-title-notes', 'desktop-tasks', async () => {
      mode = 'hold'; await input('.task-editor-title', 'Retained title'); await blur('.task-editor-title'); await waitHeld();
      await input('.task-editor-notes', 'Retained task notes'); release(false); await delay(80);
      mode = 'allow'; await click('.task-editor-close'); await until("!document.querySelector('.task-editor-title')");
      assert.equal(docs.tasks.tasks[0].title, 'Retained title'); assert.equal(docs.tasks.tasks[0].notes, 'Retained task notes');
    });
    await scenario('notes-overlapping-fields', 'desktop-notes', async () => {
      mode = 'hold'; await input('.notes-title-input', 'Retained title'); await blur('.notes-title-input'); await waitHeld();
      await body('Retained body'); release(false); await delay(80); mode = 'allow'; await blur('.notes-title-input'); await delay(150);
      const saved = docs.notes.notes.find(note => note.body === 'Retained body'); assert.ok(saved); assert.equal(saved.title, 'Retained title');
    });
    // 2026-09-20 ("typing in notes gives a flash of a message about 'unsaved changes'... on
    // like every key you type"): the save banner rendered while an edit was merely pending
    // its 400 ms debounce. With saves ALLOWED it must never appear while typing. Keys land
    // faster than the debounce on purpose, so the edit stays pending the whole time, and a
    // MutationObserver counts every appearance (a poll could miss a one-frame flash).
    await scenario('notes-typing-never-shows-the-save-banner', 'desktop-notes', async () => {
      mode = 'allow';
      await js("window.__bannerSeen = 0; new MutationObserver(() => { if (document.querySelector('.edit-save-status')) window.__bannerSeen += 1; }).observe(document.body, { childList: true, subtree: true }); true");
      for (const text of ['T', 'Ty', 'Typ', 'Typi', 'Typin', 'Typing']) { await body(text); await delay(120); }
      await delay(700);
      assert.equal(await js('window.__bannerSeen'), 0, 'the save banner appeared while typing with every save succeeding');
      assert.equal(docs.notes.notes.find(note => note.title === 'Saved work').body, 'Typing');
    });
    await scenario('notes-navigation-refusal', 'desktop-notes', async () => {
      await body('Draft before navigation');
      await js("[...document.querySelectorAll('.notes-item-main')].find(el=>el.innerText.includes('Other note')).click()"); await delay(120);
      assert.equal(await js("document.querySelector('.notes-title-input').value"), 'Saved work', 'refused save must keep the current editor');
      mode = 'allow'; await js("[...document.querySelectorAll('.notes-item-main')].find(el=>el.innerText.includes('Other note')).click()");
      await until("document.querySelector('.notes-title-input').value==='Other note'");
      assert.equal(docs.notes.notes.find(note => note.title === 'Saved work').body, 'Draft before navigation');
    });
    await scenario('notes-topics-refusal', 'desktop-notes', async () => {
      await input('.notes-topic-input', 'retained'); await blur('.notes-topic-input'); await delay(80);
      mode = 'allow'; await blur('.notes-title-input'); await delay(150);
      assert.deepEqual(docs.notes.notes.find(note => note.title === 'Saved work').tags, ['retained']);
    });
    await scenario('notes-group-refusal', 'desktop-notes', async () => {
      const target = docs.notes.groups[1].id;
      await input('.notes-editor-group-select', target); await delay(100);
      assert.match(await js("document.querySelector('.edit-save-status')?.textContent || ''"), /group/);
      mode = 'allow'; await blur('.notes-title-input'); await delay(150);
      assert.equal(docs.notes.notes.find(note => note.title === 'Saved work').groupId, target);
    });
    for (const kind of ['list', 'group']) {
      const surface = kind === 'list' ? 'desktop-tasks' : 'desktop-notes';
      const prefix = kind === 'list' ? 'tasks' : 'notes';
      await scenario(kind + '-create-refusal', surface, async () => {
        if (kind === 'list') await click('.task-editor-close');
        await click('.' + prefix + '-new' + kind + '-btn');
        const selector = '.' + prefix + '-new' + kind + '-input';
        await input(selector, 'Retained name');
        await js("document.querySelector('" + selector + "').form.requestSubmit()"); await delay(100);
        assert.equal(await js("document.querySelector('" + selector + "')?.value"), 'Retained name');
        mode = 'allow'; await js("document.querySelector('" + selector + "').form.requestSubmit()"); await delay(100);
        assert.equal(docs[kind === 'list' ? 'tasks' : 'notes'][kind + 's'].filter(item => item.name === 'Retained name').length, 1);
      });
      await scenario(kind + '-rename-refusal', surface, async () => {
        if (kind === 'list') await click('.task-editor-close');
        const button = kind === 'list' ? '.tasks-list-row .tasks-nav-btn' : '.notes-group-head';
        await js("document.querySelector('" + button + "').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
        const selector = '.' + prefix + '-rename-input';
        await input(selector, 'Retained rename');
        await js("document.querySelector('" + selector + "').form.requestSubmit()"); await delay(100);
        assert.equal(await js("document.querySelector('" + selector + "')?.value"), 'Retained rename');
        mode = 'allow'; await js("document.querySelector('" + selector + "').form.requestSubmit()"); await delay(100);
        assert.ok(docs[kind === 'list' ? 'tasks' : 'notes'][kind + 's'].some(item => item.name === 'Retained rename'));
      });
    }
    await scenario('phone-note-refused-save', 'phone-notes', async () => {
      await input('.ne-title', 'Retained title'); await input('.ne-body', 'Retained body'); await input('.ne-tags input', 'retained');
      await click('.ne-back'); await delay(100);
      assert.equal(await js("document.querySelector('.ne-body')?.value"), 'Retained body');
      mode = 'allow'; await click('.ne-back'); await until("!document.querySelector('.ne-title')");
      const saved = docs.notes.notes.find(note => note.title === 'Retained title'); assert.equal(saved.body, 'Retained body'); assert.deepEqual(saved.tags, ['retained']);
    });
    await scenario('phone-note-typing-during-save', 'phone-notes', async () => {
      mode = 'hold'; await input('.ne-title', 'First title'); await input('.ne-body', 'First body'); await click('.ne-back'); await waitHeld();
      await input('.ne-title', 'Latest title'); await input('.ne-body', 'Latest body'); await input('.ne-tags input', 'latest');
      release(true); await until("!document.querySelector('.ne-title')");
      const saved = docs.notes.notes.find(note => note.title === 'Latest title'); assert.ok(saved, 'typing after the request must be saved before close');
      assert.equal(saved.body, 'Latest body'); assert.deepEqual(saved.tags, ['latest']);
    });
    for (const surface of ['desktop-tasks', 'phone-tasks']) {
      await scenario(surface + '-quick-add', surface, async () => {
        if (surface === 'desktop-tasks') await click('.task-editor-close');
        const form = surface === 'desktop-tasks' ? '.tasks-add' : '.tasks-mobile-add';
        await input(form + ' input', 'Retained add');
        await js(`document.querySelector('${form}').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`); await delay(100);
        assert.equal(await js(`document.querySelector('${form} input').value`), 'Retained add');
        mode = 'allow'; await js(`document.querySelector('${form}').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`); await delay(100);
        assert.equal(docs.tasks.tasks.filter(task => task.title === 'Retained add').length, 1);
      });
    }
    await scenario('task-editor-subtask', 'desktop-tasks', async () => {
      await input('.task-editor-subadd-input', 'Retained child');
      await js("document.querySelector('.task-editor-subadd').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))"); await delay(100);
      assert.equal(await js("document.querySelector('.task-editor-subadd-input').value"), 'Retained child');
      mode = 'allow'; await js("document.querySelector('.task-editor-subadd').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))"); await delay(100);
      assert.equal(docs.tasks.tasks.filter(task => task.title === 'Retained child').length, 1);
    });
    for (const surface of ['desktop-tasks', 'phone-tasks']) {
      await scenario(surface + '-overlapping-adds', surface, async () => {
        if (surface === 'desktop-tasks') await click('.task-editor-close');
        const form = surface === 'desktop-tasks' ? '.tasks-add' : '.tasks-mobile-add';
        mode = 'hold'; await input(form + ' input', 'First submission');
        await js(`document.querySelector('${form}').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`); await waitHeld();
        await input(form + ' input', 'New draft'); release(false); await delay(100);
        assert.equal(await js("Boolean(document.querySelector('.retry-add'))"), true, 'the older failed submission remains recoverable');
        await shot('refused-' + surface + '-add');
        mode = 'allow'; await click('.retry-add'); await delay(100);
        assert.equal(docs.tasks.tasks.filter(task => task.title === 'First submission').length, 1);
        assert.equal(await js(`document.querySelector('${form} input').value`), 'New draft');
        await js(`document.querySelector('${form}').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`); await delay(100);
        assert.equal(docs.tasks.tasks.filter(task => task.title === 'New draft').length, 1);
      });
    }
    await scenario('task-editor-overlapping-subtasks', 'desktop-tasks', async () => {
      mode = 'hold'; await input('.task-editor-subadd-input', 'First child');
      await js("document.querySelector('.task-editor-subadd').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))"); await waitHeld();
      await input('.task-editor-subadd-input', 'Next child'); release(false); await delay(100);
      assert.equal(await js("Boolean(document.querySelector('.retry-add'))"), true);
      mode = 'allow'; await click('.retry-add'); await delay(100);
      assert.equal(docs.tasks.tasks.filter(task => task.title === 'First child').length, 1);
      assert.equal(await js("document.querySelector('.task-editor-subadd-input').value"), 'Next child');
    });
    await scenario('task-inline-subtask-refusal', 'desktop-tasks', async () => {
      await click('.task-editor-close');
      await click('button[title="Add a sub-task"]'); await input('.tasks-subadd-input', 'Inline child');
      await js("document.querySelector('.tasks-subadd').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))"); await delay(100);
      assert.equal(await js("document.querySelector('.tasks-subadd-input')?.value"), 'Inline child');
      mode = 'allow'; await js("document.querySelector('.tasks-subadd').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))"); await delay(100);
      assert.equal(docs.tasks.tasks.filter(task => task.title === 'Inline child').length, 1);
    });
    for (const surface of ['desktop-tasks', 'phone-tasks', 'editor-subtasks']) {
      const host = surface === 'editor-subtasks' ? 'desktop-tasks' : surface;
      const form = surface === 'editor-subtasks' ? '.task-editor-subadd' : surface === 'phone-tasks' ? '.tasks-mobile-add' : '.tasks-add';
      const submit = async () => {
        await input(form + ' input', 'Same intended title');
        await js(`document.querySelector('${form}').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
      };
      await scenario(surface + '-independent-identical-adds', host, async () => {
        if (surface === 'desktop-tasks') await click('.task-editor-close');
        mode = 'hold'; await submit(); await waitHeld(); await submit(); await delay(100);
        assert.equal(held.length, 2, 'two submissions with identical content are two intentions');
        release(true); await delay(100);
        assert.equal(docs.tasks.tasks.filter(task => task.title === 'Same intended title').length, 2);
      });
      await scenario(surface + '-retry-same-intent-once', host, async () => {
        if (surface === 'desktop-tasks') await click('.task-editor-close');
        await submit(); await delay(100);
        assert.equal(await js("document.querySelectorAll('.retry-add').length"), 1);
        mode = 'hold';
        await js("const button=document.querySelector('.retry-add'); button.click(); button.click()");
        await waitHeld(); await delay(100);
        assert.equal(held.length, 1, 'repeated retries of one intention share its in-flight request');
        release(true); await delay(100);
        assert.equal(docs.tasks.tasks.filter(task => task.title === 'Same intended title').length, 1);
        assert.equal(await js("document.querySelectorAll('.retry-add').length"), 0);
      });
    }
    for (const surface of ['desktop-tasks', 'desktop-notes', 'phone-notes']) {
      await scenario(surface + '-restored-draft', surface, async () => {
        const selector = surface === 'desktop-tasks' ? '.task-editor-title' : surface === 'desktop-notes' ? '.notes-title-input' : '.ne-title';
        await input(selector, 'Draft survives remount');
        if (surface === 'phone-notes') await click('.ne-back'); else await blur(selector);
        await delay(120);
        await win.loadFile(path.join(work, 'build', 'verify/editor-retry/index.html'), { query: { surface } });
        await until('Boolean(window.__storeState?.doc)');
        if (surface === 'desktop-tasks') await click('.task-title');
        if (surface === 'phone-notes') await click('.note-row');
        if (surface === 'desktop-notes') {
          await js("[...document.querySelectorAll('.notes-item-main')].find(el=>el.innerText.includes('Saved work')).click()");
          await until("document.querySelector('.notes-item.active .notes-item-title')?.textContent==='Saved work'");
        }
        await until(`Boolean(document.querySelector('${selector}'))`);
        assert.equal(await js(`document.querySelector('${selector}').value`), 'Draft survives remount');
        mode = 'allow';
        if (surface === 'desktop-tasks') await click('.task-editor-close');
        else if (surface === 'phone-notes') await click('.ne-back'); else await blur(selector);
        await delay(150);
        assert.ok(docs[surface === 'desktop-tasks' ? 'tasks' : 'notes'][surface === 'desktop-tasks' ? 'tasks' : 'notes'].some(item => item.title === 'Draft survives remount'));
      });
    }
    report.windows.push({ rendererPid: win.webContents.getOSProcessId(), visible: win.isVisible(), focused: win.isFocused() });
    assert.equal(win.isVisible(), false); assert.equal(win.isFocused(), false);
    report.ok = report.checks.every(check => check.passed);
    finish(report.ok ? 0 : 1);
  } catch (error) { report.error = error.stack; finish(1); }
}
(process.versions.electron ? drive() : buildAndDrive()).catch(error => { console.error(error); process.exitCode = 1; });
