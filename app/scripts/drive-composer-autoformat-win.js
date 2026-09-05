'use strict';

// Windows prod-drive for the composer's auto-format, five-level lists, and the
// quote toggle (Pat, 2026-09-03). Same posture as drive-composer-nested-win.js:
// an ISOLATED Harbor instance with tmp userData and state, the real transcript
// corpus read-only, no daemon start, and a window parked off the visible
// desktop without activating it. Everything is REAL keystrokes over CDP: the
// Space that converts "- ", the Tab that indents, the Enter that leaves a
// quote. The one execCommand used is selectAll+delete between scenes, which
// is not under test.
//
// Usage: node scripts/drive-composer-autoformat-win.js   (from app/)
// Writes screenshots and a verdict to %TEMP%\harbor-drive-composer-autoformat\

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.join(os.tmpdir(), 'harbor-drive-composer-autoformat');
const CTRL = 2;
const SHIFT = 8;

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

const enter = (cdp) => key(cdp, 'Enter', { code: 'Enter', text: '\r', vk: 13 });
const tab = (cdp, shift = false) => key(cdp, 'Tab', { code: 'Tab', vk: 9, modifiers: shift ? SHIFT : 0 });
const backspace = (cdp) => key(cdp, 'Backspace', { code: 'Backspace', vk: 8 });
const ctrlShift9 = (cdp) => key(cdp, '(', { code: 'Digit9', vk: 57, modifiers: CTRL | SHIFT });

// A full reset between scenes. selectAll+delete alone leaves Chromium's list
// scaffolding (an empty bullet is content the user made, by the editor's own
// rule), which would put the next scene's typing inside a list.
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

// Every scene types into the composer, so a stolen focus is a defect, not a
// harness hiccup.
async function assertComposerFocused(cdp, when) {
  const focused = await cdp.eval(`(() => {
    const editor = document.querySelector('.ubar-input[contenteditable="true"]');
    return document.activeElement === editor ? 'editor' : (document.activeElement?.className || document.activeElement?.tagName || 'nothing');
  })()`);
  if (focused !== 'editor') throw new Error(`composer lost focus ${when}: focus is on ${focused}`);
}

const readEditor = (cdp) => cdp.eval(`(() => {
  const editor = document.querySelector('.ubar-input[contenteditable="true"]');
  const anchor = window.getSelection()?.anchorNode;
  let depth = 0;
  for (let node = anchor; node && node !== editor; node = node.parentNode) {
    if (node.nodeName === 'UL' || node.nodeName === 'OL') depth += 1;
  }
  const drafts = JSON.parse(localStorage.getItem('harbor-drafts') || '{}');
  const entry = Object.values(drafts).find((value) => value && typeof value.text === 'string');
  const quoteButton = document.querySelector('.compose-format-btn.fmt-quote');
  return {
    html: editor.innerHTML,
    draft: entry ? entry.text : '',
    depth,
    quoteOn: quoteButton ? quoteButton.getAttribute('aria-pressed') === 'true' : null,
    inQuote: Boolean(anchor && (anchor.nodeType === 1 ? anchor : anchor.parentNode).closest('blockquote')),
  };
})()`);

async function settle(cdp) { await sleep(450); return readEditor(cdp); }

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-composer-autoformat-'));
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
  // Port 0: Chromium picks a free port and writes it to DevToolsActivePort in
  // the user data dir. A fixed port is a trap when two drives run at once (the
  // first run of this script attached to ANOTHER drive's window that already
  // held the port, and that drive's keystrokes landed mid-scene).
  const childLog = fs.openSync(path.join(OUT, 'electron.log'), 'w');
  const child = spawn(ELECTRON, [APP_DIR, '--remote-debugging-port=0', '--no-focus-steal'], {
    env, stdio: ['ignore', childLog, childLog], detached: false,
  });
  // A vanished instance must be a loud verdict, not a silent exit 0: with the
  // websocket gone, a pending CDP promise never settles and node would simply
  // run out of work. The interval keeps the loop alive until the report is
  // written; the exit listener names what happened.
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
    // Every CDP call races the connection closing, so a dead window fails the
    // step it died in rather than hanging it.
    const rawSend = cdp.send.bind(cdp);
    cdp.send = (method, params) => Promise.race([rawSend(method, params), gone]);
    // Page exceptions are part of the verdict: a renderer that threw while
    // opening a session is the most likely reason a composer never appears.
    cdp.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        const detail = msg.params?.exceptionDetails;
        scenes.push(`page exception: ${detail?.exception?.description || detail?.text || 'unknown'}`.slice(0, 600));
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // SWP_NOACTIVATE | SWP_NOZORDER keeps the proof away from the desktop. The
    // window is created with --no-focus-steal either way, so a failed park
    // (Add-Type can lose a race with another drive compiling the same helper)
    // is retried once and then tolerated rather than failing the proof.
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
    // The format bar has to be open for the quote button's lit state.
    await cdp.eval(`(() => {
      const toggle = document.querySelector('.compose-format-toggle');
      if (toggle && toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
      return true;
    })()`);
    await waitFor(cdp, "document.querySelector('.compose-format-btn.fmt-quote') ? true : false", 'the format bar');
    await clearEditor(cdp);

    // Scene 1: "- " becomes a bullet, five levels deep, capped at five.
    await typeText(cdp, '- ');
    let state = await settle(cdp);
    check('dash-space makes a bullet', /<ul>/.test(state.html) && !/-/.test(state.html.replace(/<[^>]+>/g, '')), state.html);
    await typeText(cdp, 'one');
    for (const label of ['two', 'three', 'four', 'five']) {
      await enter(cdp);
      await tab(cdp);
      await typeText(cdp, label);
    }
    state = await settle(cdp);
    check('five nested levels reached', state.depth === 5, `depth ${state.depth}`);
    await enter(cdp);
    await tab(cdp);
    await assertComposerFocused(cdp, 'after a Tab at the depth cap');
    await typeText(cdp, 'six');
    state = await settle(cdp);
    check('a sixth level is refused', state.depth === 5, `depth ${state.depth}`);
    const expectedList = '- one\n  - two\n    - three\n      - four\n        - five\n        - six';
    check('nested bullets serialize with every level', state.draft === expectedList, JSON.stringify(state.draft));
    await cdp.shot('01-bullets-five-levels');

    // Scene 2: "1. " and "I. " make numbered lists that keep their style.
    await clearEditor(cdp);
    await typeText(cdp, '1. first');
    await enter(cdp);
    await typeText(cdp, 'second');
    state = await settle(cdp);
    check('number-dot-space makes a numbered list', state.draft === '1. first\n2. second', JSON.stringify(state.draft));
    await clearEditor(cdp);
    await typeText(cdp, 'I. alpha');
    await enter(cdp);
    await typeText(cdp, 'beta');
    state = await settle(cdp);
    check('roman marker makes a roman list', state.draft === 'I. alpha\nII. beta' && /type="I"/.test(state.html), JSON.stringify(state.draft));
    await cdp.shot('02-roman-list');
    await clearEditor(cdp);
    await typeText(cdp, 'a. x');
    await enter(cdp);
    await typeText(cdp, 'y');
    state = await settle(cdp);
    check('letter marker makes a letter list', state.draft === 'a. x\nb. y', JSON.stringify(state.draft));

    // Scene 3: "> " opens a quote; Enter adds lines; Enter on an empty last
    // line leaves it; the toolbar button is lit only inside.
    await clearEditor(cdp);
    await typeText(cdp, '> quoted');
    state = await settle(cdp);
    check('greater-than-space makes a quote', /<blockquote>/.test(state.html) && state.draft === '> quoted', JSON.stringify(state.draft));
    check('quote button is lit inside the quote', state.quoteOn === true, `aria-pressed ${state.quoteOn}`);
    await enter(cdp);
    await typeText(cdp, 'more');
    state = await settle(cdp);
    check('Enter inside a quote adds a quoted line', state.draft === '> quoted\n> more' && state.inQuote, JSON.stringify(state.draft));
    await cdp.shot('03-quote-two-lines');
    await enter(cdp);
    await enter(cdp);
    await typeText(cdp, 'after');
    state = await settle(cdp);
    check('Enter on the empty last line leaves the quote', state.draft === '> quoted\n> more\nafter' && !state.inQuote, JSON.stringify(state.draft));
    check('quote button is dark outside the quote', state.quoteOn === false, `aria-pressed ${state.quoteOn}`);
    await cdp.shot('04-quote-exited');

    // Scene 4: the button and Ctrl+Shift+9 toggle a quote on and OFF.
    await clearEditor(cdp);
    await typeText(cdp, 'plain text');
    await cdp.eval("document.querySelector('.compose-format-btn.fmt-quote').click(); true");
    state = await settle(cdp);
    check('quote button turns a line into a quote', state.draft === '> plain text' && state.quoteOn === true, JSON.stringify(state.draft));
    await cdp.shot('05-quote-button-on');
    await cdp.eval("document.querySelector('.compose-format-btn.fmt-quote').click(); true");
    state = await settle(cdp);
    check('quote button turns the quote back off', state.draft === 'plain text' && state.quoteOn === false && !/<blockquote>/.test(state.html), `${JSON.stringify(state.draft)} ${state.html}`);
    await typeText(cdp, ' typed');
    state = await settle(cdp);
    check('caret survived the toggle at the end of the line', state.draft === 'plain text typed', JSON.stringify(state.draft));
    await ctrlShift9(cdp);
    state = await settle(cdp);
    check('Ctrl+Shift+9 quotes', state.draft === '> plain text typed' && state.quoteOn === true, JSON.stringify(state.draft));
    await ctrlShift9(cdp);
    state = await settle(cdp);
    check('Ctrl+Shift+9 unquotes', state.draft === 'plain text typed' && state.quoteOn === false, JSON.stringify(state.draft));
    await assertComposerFocused(cdp, 'after the quote toggles');
    await cdp.shot('06-quote-toggled-off');

    // Scene 5: Backspace right after the conversion gives the marker back.
    await clearEditor(cdp);
    await typeText(cdp, '- ');
    await backspace(cdp);
    state = await settle(cdp);
    // The marker comes back with its Space (the serializer keeps trailing
    // whitespace inside a line), so the user keeps typing where they were.
    check('Backspace after auto-format restores the dash', !/<ul>/.test(state.html) && state.draft === '- ', `${JSON.stringify(state.draft)} ${state.html}`);
    await typeText(cdp, 'not a list');
    state = await settle(cdp);
    check('and the dash stays text afterwards', state.draft === '- not a list' && !/<ul>/.test(state.html), JSON.stringify(state.draft));
    await cdp.shot('07-backspace-revert');
    await clearEditor(cdp);
    await typeText(cdp, '> ');
    await backspace(cdp);
    await typeText(cdp, 'sign');
    state = await settle(cdp);
    check('Backspace after a quote auto-format restores the sign', state.draft === '> sign' && !/<blockquote>/.test(state.html), `${JSON.stringify(state.draft)} ${state.html}`);
    await clearEditor(cdp);
    await typeText(cdp, '1. ');
    await typeText(cdp, 'kept');
    await backspace(cdp);
    state = await settle(cdp);
    check('Backspace after typing into the list is an ordinary Backspace', /<ol>/.test(state.html) && state.draft === '1. kep', `${JSON.stringify(state.draft)} ${state.html}`);

    // Scene 6: a marker inside a list item is text, not a nested conversion.
    await clearEditor(cdp);
    await typeText(cdp, '- item 1. not');
    state = await settle(cdp);
    check('a marker mid-line stays text', state.draft === '- item 1. not', JSON.stringify(state.draft));
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
