'use strict';

// Windows prod-drive for formatted copy and paste (2026-11-21, Pat: "less of a
// pain in the ass to copy and paste data in and out of harbor"). An ISOLATED
// Harbor (tmp userData and state, the real transcript corpus read-only, no
// daemon start), born offscreen by HARBOR_E2E, never focused.
//
// The clipboard is never touched: every paste and copy is a ClipboardEvent
// carrying its own DataTransfer, dispatched into the real renderer, so the
// real composer handler and the real conversation copy handler run against
// the real DOM and Pat's clipboard stays his.
//
// Proves, in the live editor: a Teams-shaped list pastes as bullets with its
// nesting and bold; a paste into existing text lands at the caret; Harbor's
// own copy HTML pastes back as a numbered list; a spreadsheet table pastes as
// its tab-separated text; invisible characters never reach the draft; and a
// list copied out of a real conversation window carries clean HTML (no
// colours) and real bullets, and pastes back into the composer as a list.
//
// Usage: node scripts/drive-clipboard-format-win.js   (from app/)
// Writes screenshots and a verdict to %TEMP%\harbor-drive-clipboard\

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const { SessionClient } = require('../src/daemon/client.js');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9341;
const OUT = path.join(os.tmpdir(), 'harbor-drive-clipboard');
const ZWSP = String.fromCodePoint(0x200b);
const SESSION = 'c11b0a4d-0000-4000-8000-00000000c0b1';
const mungeCwd = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');
// The reply the conversation window draws, then copies: a nested list with
// bold, and a table.
const REPLY = [
  'Here is the plan.',
  '',
  '- **Backups** stay at 37 days',
  '  - one sentence in the paper changes',
  '- **Guards** go ahead',
  '- Laptop access waits',
  '',
  '| Item | Owner |',
  '| --- | --- |',
  '| Backups | Vox |',
  '| Guards | Pat |',
].join('\n');
const INVISIBLE_RE = new RegExp('[' + [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0xad].map((cp) => String.fromCodePoint(cp)).join('') + ']');

const TEAMS_HTML = '<div><ul>'
  + `<li><p><strong>Backup retention.</strong> Deleted data can be restored for 37 days.${ZWSP}</p>`
  + '<ul><li><p>what happened here? keep at 37</p></li></ul></li>'
  + `<li><p><strong>Harbor${ZWSP}'s --help.</strong> Should an agent fix it?</p>`
  + '<ul><li><p>yes, surgically</p></li></ul></li></ul></div>';
const TEAMS_TEXT = `Backup retention. Deleted data can be restored for 37 days.${ZWSP}\n\nwhat happened here? keep at 37\nHarbor${ZWSP}'s --help. Should an agent fix it?\n\nyes, surgically`;
const TEAMS_MD = [
  '- **Backup retention.** Deleted data can be restored for 37 days.',
  '  - what happened here? keep at 37',
  "- **Harbor's --help.** Should an agent fix it?",
  '  - yes, surgically',
].join('\n');
const HARBOR_HTML = '<!--StartFragment--><ol class="md-list" style="padding-left: 18px; list-style-type: decimal; color: rgb(246, 247, 255); background-color: rgb(11, 12, 15);"><li style="margin-bottom: 3px;">Reword the instructions, or leave them?<span>&nbsp;</span><strong>Recommend: reword them now.</strong></li><li>Second point</li></ol><!--EndFragment-->';
const HARBOR_MD = '1. Reword the instructions, or leave them? **Recommend: reword them now.**\n2. Second point';
const TABLE_HTML = '<table><tr><td><b>Name</b></td><td>Count</td></tr><tr><td>A</td><td>3</td></tr></table>';
const TABLE_TEXT = 'Name\tCount\nA\t3';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`page threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    return result.result.value;
  }

  async shotOf(selector, name) {
    const rect = await this.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`);
    const params = { format: 'png' };
    if (rect && rect.width && rect.height) params.clip = { ...rect, x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8), width: rect.width + 16, height: rect.height + 16, scale: 1 };
    const result = await this.send('Page.captureScreenshot', params);
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

const EDITOR = '.ubar-input[contenteditable="true"]';

async function clearComposer(cdp) {
  await cdp.eval(`(() => {
    const editor = document.querySelector('${EDITOR}');
    getSelection().removeAllRanges();
    editor.replaceChildren();
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    editor.focus();
    const r = document.createRange(); r.selectNodeContents(editor); r.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    return true;
  })()`);
  await sleep(250);
}

async function typeInto(cdp, text) {
  for (const character of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character, unmodifiedText: character });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(30);
  }
}

// A paste exactly as Chromium delivers one, minus the OS clipboard.
async function paste(cdp, flavors) {
  const result = await cdp.eval(`(() => {
    const editor = document.querySelector('${EDITOR}');
    editor.focus();
    const data = new DataTransfer();
    const flavors = ${JSON.stringify(flavors)};
    for (const [type, value] of Object.entries(flavors)) data.setData(type, value);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    editor.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  await sleep(600);
  return result;
}

async function draftText(cdp) {
  return cdp.eval(`(() => {
    const drafts = JSON.parse(localStorage.getItem('harbor-drafts') || '{}');
    const entries = Object.entries(drafts).filter(([, value]) => value && typeof value.text === 'string');
    entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    return entries.length ? entries[0][1].text : '';
  })()`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-clipboard-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  const projectsDir = path.join(tmp, 'projects');
  const fixtureDir = path.join(projectsDir, mungeCwd(APP_DIR));
  fs.mkdirSync(fixtureDir, { recursive: true });
  const base = { sessionId: SESSION, cwd: APP_DIR, version: '2.1.321', userType: 'external', isSidechain: false };
  const at = Date.now() - 60_000;
  fs.writeFileSync(path.join(fixtureDir, `${SESSION}.jsonl`), [
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: new Date(at).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'What is the plan?' }] } },
    { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: new Date(at + 20_000).toISOString(), message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: REPLY }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 50 } } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  realConfig.paths = { ...realConfig.paths, projectsDir, cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json'), notesFile: path.join(tmp, 'notes.json'), boardsDir: path.join(tmp, 'boards'), projectIconsDir: path.join(tmp, 'project-icons') };
  const claudeHome = path.join(tmp, 'claude-home');
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
  realConfig.profiles = [{ id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', configHome: claudeHome, email: null, isDefault: true }];
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(realConfig, null, 2));

  const store = path.join(tmp, 'sessiond');
  fs.mkdirSync(store, { recursive: true });
  const socketPath = path.join(store, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [path.join(APP_DIR, 'src', 'daemon', 'daemon.js')], {
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-clipboard-drive-${process.pid}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let daemonErr = '';
  daemon.stderr.on('data', (chunk) => { daemonErr += chunk; });
  for (const deadline = Date.now() + 15_000; ;) {
    try { const probe = new SessionClient({ socketPath }); const r = await probe.request('health'); probe.close(); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`isolated daemon never answered: ${daemonErr}`);
    await sleep(100);
  }

  const env = {
    ...process.env,
    HARBOR_E2E: '1',
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: store,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-clipboard-drive-${process.pid}`,
    HARBOR_NO_VOICE: '1',
    HARBOR_E2E_FAKE_LAUNCH: '1',
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], { env, stdio: ['ignore', fs.openSync(path.join(OUT, 'electron.log'), 'w'), fs.openSync(path.join(OUT, 'electron.err.log'), 'w')], windowsHide: true });

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail }); };
  let cdpForDetail = null;
  let failure = '';
  try {
    let target = null;
    for (let i = 0; i < 600 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('CDP target never appeared');
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', () => reject(new Error('ws failed')));
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // One synthetic session in the rail (the E2E model hook), opened in a window.
    const cwd = APP_DIR.replace(/\\/g, '/');
    await waitFor(cdp, 'typeof window.__setSidebarModelForTest === "function"', 'the test model hook');
    await cdp.eval(`(() => {
      const NOW = Date.now();
      const row = { id: ${JSON.stringify(SESSION)}, project: 'clipboard-proof', title: 'Clipboard proof', firstPrompt: 'What is the plan?',
        lastActive: new Date(NOW).toISOString(), lastActiveMs: NOW, home: 'personal', provider: 'claude', model: null, isLive: false,
        paneId: null, workspaceId: null, agentStatus: null, isWindowsEra: false, isChildTask: false, childTitle: null,
        cwd: ${JSON.stringify(cwd)}, isHistorical: true };
      const m = { projects: [{ label: 'clipboard-proof', sessions: [row], sessionCount: 1, lastActiveMs: NOW, hasLive: false, isWindowsEra: false,
        isOrchestration: false, isDateGroup: false, displayDayMs: null, newSessionCwd: ${JSON.stringify(cwd)} }], liveProjects: [], grouping: 'project' };
      window.__setSidebarModelForTest(m); window.__setRailModelForTest?.(structuredClone(m));
      return true;
    })()`);
    await cdp.eval("[...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'All')?.click(); true");
    await sleep(400);
    const rowSel = `.sr[data-session-id="${SESSION}"]`;
    await waitFor(cdp, `Boolean(document.querySelector('${rowSel}') || document.querySelector('.pg'))`, 'the proof project in the rail');
    if (!(await cdp.eval(`Boolean(document.querySelector('${rowSel}'))`))) {
      await cdp.eval("[...document.querySelectorAll('.pg')].find((g) => /clipboard-proof/i.test(g.innerText || ''))?.click(); true");
    }
    await waitFor(cdp, `Boolean(document.querySelector('${rowSel}'))`, 'the proof session row');
    await cdp.eval(`document.querySelector('${rowSel}').click(); true`);
    let found = true;
    try {
      await waitFor(cdp, "[...document.querySelectorAll('.conv ul.md-list')].some((l) => l.querySelectorAll(':scope > li').length >= 2)", 'the reply list in the window', 30000);
    } catch { found = false; }
    await waitFor(cdp, `document.querySelector('${EDITOR}') ? true : false`, 'the real composer');

    // 1. A Teams list into an empty composer.
    await clearComposer(cdp);
    const took = await paste(cdp, { 'text/html': TEAMS_HTML, 'text/plain': TEAMS_TEXT });
    const teams = await draftText(cdp);
    check('Teams list pastes with bullets, nesting and bold', took && teams === TEAMS_MD, JSON.stringify(teams));
    check('no invisible character reaches the draft', !INVISIBLE_RE.test(teams), JSON.stringify(teams));
    check('the editor draws real list elements', await cdp.eval(`document.querySelectorAll('${EDITOR} ul ul li').length === 2`), await cdp.eval(`document.querySelector('${EDITOR}').innerHTML`));
    await cdp.shotOf('.ubar', '1-teams-list-pasted');

    // 2. A paste into existing text lands at the caret, after the typed words.
    await clearComposer(cdp);
    await typeInto(cdp, 'Answers:');
    await cdp.eval(`(() => { const editor = document.querySelector('${EDITOR}'); const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('insertParagraph'); return true; })()`);
    await paste(cdp, { 'text/html': TEAMS_HTML, 'text/plain': TEAMS_TEXT });
    const mid = await draftText(cdp);
    check('a paste after typed text keeps the text and adds the list', mid === `Answers:\n${TEAMS_MD}`, JSON.stringify(mid));
    await cdp.shotOf('.ubar', '2-paste-after-text');

    // 3. Harbor's own copy pastes back as a numbered list, its colours gone.
    await clearComposer(cdp);
    await paste(cdp, { 'text/html': HARBOR_HTML, 'text/plain': 'Reword the instructions, or leave them? Recommend: reword them now.\nSecond point' });
    const harbor = await draftText(cdp);
    check("Harbor's own copy pastes back as a numbered list with bold", harbor === HARBOR_MD, JSON.stringify(harbor));
    check('no foreign style reaches the editor', await cdp.eval(`!document.querySelector('${EDITOR}').innerHTML.includes('rgb(')`), await cdp.eval(`document.querySelector('${EDITOR}').innerHTML`));
    await cdp.shotOf('.ubar', '3-harbor-copy-pasted');

    // 4. A spreadsheet table keeps its tab-separated text.
    await clearComposer(cdp);
    await paste(cdp, { 'text/html': TABLE_HTML, 'text/plain': TABLE_TEXT });
    const table = await draftText(cdp);
    check('a table pastes as its tab-separated text', table === TABLE_TEXT, JSON.stringify(table));

    // 5. Plain text loses its invisible characters and no-break spaces.
    await clearComposer(cdp);
    await paste(cdp, { 'text/plain': `plain${ZWSP} text\u00A0here` });
    const plain = await draftText(cdp);
    check('plain text is cleaned of invisible characters', plain === 'plain text here', JSON.stringify(plain));
    await clearComposer(cdp);

    // 6. Copy a real list out of a real conversation window.
    if (!found) {
      check('a conversation with a list was found to copy from', false, 'no session in the first groups showed a list');
    } else {
      const copied = await cdp.eval(`(() => {
        const list = [...document.querySelectorAll('.conv ul.md-list, .conv ol.md-list')].find((l) => l.querySelectorAll(':scope > li').length >= 2);
        list.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.selectNodeContents(list);
        const s = getSelection(); s.removeAllRanges(); s.addRange(range);
        const data = new DataTransfer();
        const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
        list.dispatchEvent(event);
        return { taken: event.defaultPrevented, html: data.getData('text/html'), text: data.getData('text/plain'), items: list.querySelectorAll(':scope > li').length, ordered: list.nodeName === 'OL' };
      })()`);
      await cdp.shotOf('.conv', '6-conversation-selection');
      const marker = copied.ordered ? /^1\. /m : /^- /m;
      check('a conversation copy is taken by Harbor', copied.taken, JSON.stringify(copied).slice(0, 300));
      check('the copied HTML is a list with no dark-theme colours', /<(ul|ol)[\s>]/.test(copied.html) && !/rgb\(|background-color|font-family/.test(copied.html), copied.html.slice(0, 400));
      check('the copied plain text has list markers', marker.test(copied.text), JSON.stringify(copied.text.slice(0, 200)));
      // ...and pastes back into the composer as a list.
      await cdp.eval('getSelection().removeAllRanges(); true');
      await clearComposer(cdp);
      await paste(cdp, { 'text/html': copied.html, 'text/plain': copied.text });
      const back = await draftText(cdp);
      const lines = back.split('\n').filter((line) => (copied.ordered ? /^\d+\. /.test(line) : /^- /.test(line)));
      check('the copied list pastes back into the composer as a list', lines.length === copied.items, JSON.stringify(back.slice(0, 300)));
      await cdp.shotOf('.ubar', '6-conversation-copy-pasted-back');
      // The whole reply: its paragraph, list and table in one copy.
      const whole = await cdp.eval(`(() => {
        const list = document.querySelector('.conv ul.md-list');
        let reply = list.parentElement;
        while (reply && !reply.querySelector('table')) reply = reply.parentElement;
        const range = document.createRange();
        range.selectNodeContents(reply);
        const s = getSelection(); s.removeAllRanges(); s.addRange(range);
        const data = new DataTransfer();
        const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
        reply.dispatchEvent(event);
        s.removeAllRanges();
        return { html: data.getData('text/html'), text: data.getData('text/plain') };
      })()`);
      check('a whole reply copies its table as a grid and as tab-separated rows', /<table[\s>]/.test(whole.html) && /Item\tOwner\nBackups\tVox\nGuards\tPat/.test(whole.text), JSON.stringify(whole.text));
      check('a whole reply keeps the paragraph, the nested list and the bold', /Here is the plan\./.test(whole.text) && /- Backups stay at 37 days\n  - one sentence/.test(whole.text) && /<strong>Backups<\/strong>/.test(whole.html), JSON.stringify(whole.text));
      fs.writeFileSync(path.join(OUT, 'whole-reply-copy.html'), whole.html);
      fs.writeFileSync(path.join(OUT, 'whole-reply-copy.txt'), whole.text);
      fs.writeFileSync(path.join(OUT, 'conversation-copy.html'), copied.html);
      fs.writeFileSync(path.join(OUT, 'conversation-copy.txt'), copied.text);
      await clearComposer(cdp);
    }
  } catch (error) {
    failure = error.message;
  } finally {
    await sleep(300);
    try { child.kill(); } catch { /* already gone */ }
    try { daemon.kill(); } catch { /* already gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const passed = !failure && results.length && results.every((r) => r.ok);
  const report = [
    passed ? 'PASS' : 'FAIL',
    '',
    ...results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.detail}`}`),
    '',
    `failure: ${failure || '(none)'}`,
    `screenshots: ${OUT}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(passed ? 0 : 1);
}

main().catch((error) => { console.error('DRIVE FAILED:', error.message); process.exit(2); });
