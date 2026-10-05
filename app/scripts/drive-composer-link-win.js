'use strict';

// Windows prod-drive for the composer's LINK editor (Pat, 2026-09-05: "i
// clicked the hyperlink button on accident and it popped up the little link box
// and now hitting the 'x' doesnt get rid of it"). Same posture as
// drive-composer-autoformat-win.js: an ISOLATED Harbor instance with tmp
// userData and state, the real transcript corpus read-only, no daemon start,
// and a window parked off the visible desktop without activating it.
//
// Proves, all against the REAL editor: the link field has a × that dismisses it
// and leaves the text untouched (the reported bug, which cannot even be
// attempted at pre-fix HEAD because no such control exists); Escape and a
// second click on the link button also close it; a bare address gets its https
// scheme and links the selection; opening the field on an existing link
// prefills its address and re-links it; clearing the field while editing a link
// removes it; and clear-formatting unlinks.
//
// Usage: node scripts/drive-composer-link-win.js   (from app/)
// Writes screenshots and a verdict to %TEMP%\harbor-drive-composer-link\

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(os.tmpdir(), 'harbor-drive-composer-link');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`page threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    }
    return result.result.value;
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.eval(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

async function key(cdp, keyName, { text = '', modifiers = 0, code = '', vk = 0 } = {}) {
  const base = { key: keyName, code, modifiers };
  if (vk) base.windowsVirtualKeyCode = vk;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text, unmodifiedText: text, ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(45);
}

async function typeText(cdp, value) {
  for (const character of value) await key(cdp, character, { text: character });
}

const escape = (cdp) => key(cdp, 'Escape', { code: 'Escape', vk: 27 });

// Toolbar buttons are exercised by their real onClick, matching the sibling
// autoformat driver. The point of this proof is the outcome of the click, not
// the pointer plumbing.
const clickSel = (cdp, selector) => cdp.eval(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.click();
  return true;
})()`);

async function clearEditor(cdp) {
  await cdp.eval(`(() => {
    const editor = document.querySelector('.ubar-input[contenteditable="true"]');
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    editor.replaceChildren();
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    editor.focus();
    return true;
  })()`);
  await sleep(150);
}

const selectAll = (cdp) => cdp.eval(`(() => {
  const editor = document.querySelector('.ubar-input[contenteditable="true"]');
  editor.focus();
  document.execCommand('selectAll', false, null);
  return true;
})()`);

// Put a collapsed caret inside the first anchor, so opening the link field
// finds an enclosing <a> to edit.
const caretInLink = (cdp) => cdp.eval(`(() => {
  const editor = document.querySelector('.ubar-input[contenteditable="true"]');
  const a = editor.querySelector('a');
  if (!a || !a.firstChild) return false;
  const range = document.createRange();
  range.setStart(a.firstChild, 1);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  editor.focus();
  return true;
})()`);

const readEditor = (cdp) => cdp.eval(`(() => {
  const editor = document.querySelector('.ubar-input[contenteditable="true"]');
  const drafts = JSON.parse(localStorage.getItem('harbor-drafts') || '{}');
  const entry = Object.values(drafts).find((value) => value && typeof value.text === 'string');
  const field = document.querySelector('.compose-link-field');
  const input = document.querySelector('.compose-link-field input');
  const addBtn = document.querySelector('.compose-link-add');
  const linkBtn = document.querySelector('.compose-format-btn.fmt-link');
  return {
    html: editor.innerHTML,
    draft: entry ? entry.text : '',
    fieldOpen: Boolean(field),
    hasClose: Boolean(document.querySelector('.compose-link-close')),
    inputValue: input ? input.value : null,
    addLabel: addBtn ? addBtn.textContent : null,
    linkBtnPressed: linkBtn ? linkBtn.getAttribute('aria-pressed') : null,
    focusInEditor: document.activeElement === editor,
    focusClass: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : 'nothing',
  };
})()`);

const setInput = (cdp, value) => cdp.eval(`(() => {
  const input = document.querySelector('.compose-link-field input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

async function settle(cdp) { await sleep(400); return readEditor(cdp); }

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-composer-link-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });

  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  realConfig.paths = {
    ...realConfig.paths,
    cacheDir: path.join(tmp, 'cache'),
    tasksFile: path.join(tmp, 'tasks.json'),
    projectIconsDir: path.join(tmp, 'project-icons'),
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(realConfig, null, 2));

  const env = {
    ...process.env,
    HARBOR_E2E: '1',
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
  };
  const childLog = fs.openSync(path.join(OUT, 'electron.log'), 'w');
  const child = spawn(ELECTRON, [APP_DIR, '--remote-debugging-port=0', '--no-focus-steal'], {
    env, stdio: ['ignore', childLog, childLog], detached: false,
  });
  const heartbeat = setInterval(() => {}, 1000);
  let childExit = null;
  child.on('exit', (code, signal) => { childExit = `electron exited code=${code} signal=${signal}`; });
  const readPort = () => {
    try {
      const port = Number(fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
      return Number.isInteger(port) && port > 0 ? port : 0;
    } catch { return 0; }
  };

  const scenes = [];
  let failure = '';
  let cdpRef = null;
  const check = (name, condition, detail) => {
    scenes.push(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    if (!condition && !failure) failure = `${name}: ${detail || 'condition false'}`;
  };

  try {
    let target = null;
    let port = 0;
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(500);
      port = port || readPort();
      if (!port) continue;
      try {
        const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('CDP target never appeared');
    scenes.push(`info attached to this drive's own instance on port ${port}`);
    const connect = (url) => new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', () => reject(new Error('ws failed')));
    });
    const cdp = new Cdp(await connect(target.webSocketDebuggerUrl));
    cdpRef = cdp;
    const gone = new Promise((_, reject) => {
      cdp.ws.addEventListener('close', () => reject(new Error(`CDP connection closed (${childExit || 'window or target gone, electron still running'})`)));
    });
    const rawSend = cdp.send.bind(cdp);
    cdp.send = (method, params) => Promise.race([rawSend(method, params), gone]);
    cdp.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        const detail = msg.params?.exceptionDetails;
        scenes.push(`page exception: ${detail?.exception?.description || detail?.text || 'unknown'}`.slice(0, 600));
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const park = `powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { execSync(park, { stdio: 'ignore' }); break; } catch { await sleep(600); }
    }

    await waitFor(cdp, "document.querySelector('.sidebar-filter-chip') ? true : false", 'the session filter');
    await cdp.eval(`(() => {
      const all = [...document.querySelectorAll('.sidebar-filter-chip')].find((item) => item.textContent.trim() === 'All');
      if (all) all.click();
      return Boolean(all);
    })()`);
    await waitFor(cdp, "document.querySelector('.pg') ? true : false", 'a project row');
    await cdp.eval("document.querySelector('.pg').click(); true");
    await waitFor(cdp, "document.querySelector('.sr:not(:disabled)') ? true : false", 'a real session row');
    await cdp.eval("document.querySelector('.sr:not(:disabled)').click(); true");
    await waitFor(cdp, "document.querySelector('.ubar-input[contenteditable=\"true\"]') ? true : false", 'the real composer');
    await cdp.eval(`(() => {
      const toggle = document.querySelector('.compose-format-toggle');
      if (toggle && toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
      return true;
    })()`);
    await waitFor(cdp, "document.querySelector('.compose-format-btn.fmt-link') ? true : false", 'the format bar');
    await clearEditor(cdp);

    // Scene 1: a bare address links the selection and gains its https scheme.
    await typeText(cdp, 'see docs');
    await selectAll(cdp);
    await clickSel(cdp, '.compose-format-btn.fmt-link');
    let state = await settle(cdp);
    check('link button opens the field', state.fieldOpen && state.linkBtnPressed === 'true', JSON.stringify(state));
    check('the field carries a × dismiss control', state.hasClose, `hasClose ${state.hasClose}`);
    await setInput(cdp, 'example.com');
    await sleep(150);
    await cdp.shot('00-field-open');
    await clickSel(cdp, '.compose-link-add');
    state = await settle(cdp);
    check('a bare domain links the selection and is normalized to https',
      state.draft === '[see docs](https://example.com)' && !state.fieldOpen, JSON.stringify(state.draft));
    await cdp.shot('01-link-added-normalized');

    // Scene 2: the × dismisses the field and leaves the text untouched. This is
    // the reported bug; at pre-fix HEAD .compose-link-close does not exist, so
    // the click is a no-op and the field stays open, failing this scene.
    await caretInLink(cdp);
    await clickSel(cdp, '.compose-format-btn.fmt-link');
    state = await settle(cdp);
    check('field reopens on the existing link', state.fieldOpen, JSON.stringify(state));
    const closed = await clickSel(cdp, '.compose-link-close');
    state = await settle(cdp);
    check('the × control exists and was clicked', closed, `clicked ${closed}`);
    check('the × dismisses the field', !state.fieldOpen, `fieldOpen ${state.fieldOpen}`);
    check('the × leaves the link untouched', state.draft === '[see docs](https://example.com)', JSON.stringify(state.draft));
    check('focus returns to the editor after ×', state.focusInEditor, `focus ${state.focusClass}`);
    await cdp.shot('02-x-dismisses');

    // Scene 3: Escape closes the field too.
    await caretInLink(cdp);
    await clickSel(cdp, '.compose-format-btn.fmt-link');
    state = await settle(cdp);
    check('field open before Escape', state.fieldOpen, JSON.stringify(state));
    await escape(cdp);
    state = await settle(cdp);
    check('Escape closes the field', !state.fieldOpen, `fieldOpen ${state.fieldOpen}`);

    // Scene 4: opening on an existing link prefills its address and re-links.
    await caretInLink(cdp);
    await clickSel(cdp, '.compose-format-btn.fmt-link');
    state = await settle(cdp);
    check('the field prefills the existing address', state.inputValue === 'https://example.com', `value ${state.inputValue}`);
    await setInput(cdp, 'example.org/new');
    await clickSel(cdp, '.compose-link-add');
    state = await settle(cdp);
    check('editing a link updates its address', state.draft === '[see docs](https://example.org/new)', JSON.stringify(state.draft));
    await cdp.shot('03-link-edited');

    // Scene 5: clearing the field while editing a link removes it (Remove).
    await caretInLink(cdp);
    await clickSel(cdp, '.compose-format-btn.fmt-link');
    await settle(cdp);
    await setInput(cdp, '');
    state = await readEditor(cdp);
    check('the Add button becomes Remove on an emptied edit', state.addLabel === 'Remove', `label ${state.addLabel}`);
    await clickSel(cdp, '.compose-link-add');
    state = await settle(cdp);
    check('an emptied field removes the link', state.draft === 'see docs' && !/<a /.test(state.html), JSON.stringify(state.draft));
    await cdp.shot('04-link-removed');

    // Scene 6: a second click on the link button closes the field.
    await clickSel(cdp, '.compose-format-btn.fmt-link');
    await settle(cdp);
    await clickSel(cdp, '.compose-format-btn.fmt-link');
    state = await settle(cdp);
    check('a second click on the link button closes the field', !state.fieldOpen, `fieldOpen ${state.fieldOpen}`);

    // Scene 7: clear-formatting unlinks a link.
    await clearEditor(cdp);
    await typeText(cdp, 'linked text');
    await selectAll(cdp);
    await clickSel(cdp, '.compose-format-btn.fmt-link');
    await settle(cdp);
    await setInput(cdp, 'example.com');
    await clickSel(cdp, '.compose-link-add');
    state = await settle(cdp);
    check('a link exists before clearing', /<a /.test(state.html), state.html);
    await selectAll(cdp);
    await clickSel(cdp, '.compose-format-btn.fmt-clear');
    state = await settle(cdp);
    check('clear-formatting removes the link', state.draft === 'linked text' && !/<a /.test(state.html), `${JSON.stringify(state.draft)} ${state.html}`);
    await cdp.shot('05-clear-unlinks');
  } catch (error) {
    failure = failure || error.message;
    scenes.push(`THREW ${error.stack || error.message}`);
    try { if (cdpRef) scenes.push(`failure screenshot: ${await cdpRef.shot('99-failure')}`); } catch { /* window gone */ }
  } finally {
    await sleep(300);
    try { child.kill(); } catch { /* already gone */ }
    clearInterval(heartbeat);
    try { fs.closeSync(childLog); } catch { /* closed */ }
  }

  if (childExit) scenes.push(`info ${childExit}`);
  const verdict = failure ? 'FAIL' : 'PASS';
  const report = [verdict, '', ...scenes, '', `failure: ${failure || '(none)'}`, `screenshots: ${OUT}`, ''].join('\n');
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(failure ? 1 : 0);
}

main().catch((error) => { console.error('DRIVE FAILED:', error.message); process.exit(2); });
