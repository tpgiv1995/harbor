'use strict';

// LIVE Windows proof for where a conversation window stays scrolled
// (2026-11-16, Pat: "when im minimized out of a chat/session for some reason
// the windows sometimes just scroll to the top of the chat"), plus the two asks
// that came with it: the mouse wheel and PageUp/PageDown scroll the selected
// chat from anywhere on the stage, and every message shows the time it was sent
// in the machine's own time zone.
//
// An ISOLATED Harbor (tmp userData, config, transcript store and sessiond; port
// 9362), born hidden and shown inactive off-screen, opens three synthetic
// 30-turn chats in one grid. Window B is scrolled up into its history with a
// real wheel; A and C stay at their latest message. Then, one at a time:
//   focus   - A takes the full stage and gives it back (B and C were display:none)
//   minimize- the page collapses to 1x1 (what Chromium hands a minimized window)
//             while C gets a new reply, then comes back
//   view    - Tasks and back (the stage unmounts and remounts)
//   follow  - new replies land in A while it is at the bottom
//   noYank  - a wheel up in A while replies stream must hold, not snap back
//   barWheel- the wheel over the command bar scrolls the selected window, and
//             wheeling back to the bottom resumes following
//   header  - the wheel over a window's header scrolls that window
//   pageKeys- PageUp/PageDown with the cursor in the composer
//   send    - sending from the composer brings that window back to the bottom
//   times   - each prompt and reply shows its time, "Yesterday" for yesterday
// Pass: B keeps the same message at the same spot through focus, minimize and
// view; A and C stay at the bottom through all of them; every later step holds.
// Screenshots and verdict.json in %TEMP%\harbor-drive-conversation-scroll.
//
// Usage (from app/): node scripts/drive-conversation-scroll-win.js [renderer index.html]
// With no argument it loads app/dist (run `npm run build` first). A path loads
// that build instead, through VITE_DEV_SERVER_URL, so a build of an older
// commit can be checked against the same steps.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const { SessionClient } = require('../src/daemon/client.js');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9362;
const OUT = path.join(os.tmpdir(), 'harbor-drive-conversation-scroll');
const RENDERER = process.argv[2] ? path.resolve(process.argv[2]) : null;
const TURNS = 30;

const IDS = {
  a: '5c3011a0-0000-4000-8000-0000000000a1',
  b: '5c3011b0-0000-4000-8000-0000000000b2',
  c: '5c3011c0-0000-4000-8000-0000000000c3',
};
const mungeCwd = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');
const step = (label) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${label}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  async eval(expression, timeoutMs = 20_000) {
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`page did not answer within ${timeoutMs} ms: ${expression.slice(0, 60)}`)), timeoutMs); });
    const result = await Promise.race([this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), deadline]).finally(() => clearTimeout(timer));
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
    await sleep(200);
  }
}

async function key(cdp, keyName, { code = keyName, vk = 0, text = '' } = {}) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text, unmodifiedText: text });
  if (text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: keyName, code, text, unmodifiedText: text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(40);
}

async function wheel(cdp, x, y, deltaY) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
}

// ---- the fixture ---------------------------------------------------------

// Local wall-clock times, so the expected labels are the machine's own zone.
function localAt(daysAgo, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const SENTENCE = 'The parser reads each record once, keeps the newest reply in view, and leaves the reader where they were reading. ';
function replyText(tag, n) {
  return [`${tag} turn ${n} reply.`, SENTENCE.repeat(3), SENTENCE.repeat(2), `End of ${tag} turn ${n}.`].join('\n\n');
}

function chatRecords(id, tag, times) {
  const base = { sessionId: id, cwd: APP_DIR, version: '2.1.316', userType: 'external', isSidechain: false };
  const records = [];
  let parent = null;
  times.forEach((at, i) => {
    const n = i + 1;
    const u = `${tag}-u${n}`;
    const a = `${tag}-a${n}`;
    records.push({ ...base, type: 'user', uuid: u, parentUuid: parent, timestamp: at.toISOString(), message: { role: 'user', content: [{ type: 'text', text: `${tag} question ${n}: where does the window stay?` }] } });
    records.push({ ...base, type: 'assistant', uuid: a, parentUuid: u, timestamp: new Date(at.getTime() + 40_000).toISOString(), message: { id: `${tag}-m${n}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: replyText(tag, n) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 50 } } });
    parent = a;
  });
  return records;
}

function liveRecord(id, tag, n) {
  const base = { sessionId: id, cwd: APP_DIR, version: '2.1.316', userType: 'external', isSidechain: false };
  return { ...base, type: 'assistant', uuid: `${tag}-live${n}`, parentUuid: null, timestamp: new Date().toISOString(), message: { id: `${tag}-live-m${n}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `${tag} live reply ${n}.\n\n${SENTENCE.repeat(3)}` }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 50 } } };
}

// What the window should print for a time, worked out here independently of
// the renderer's own formatter: today is the bare time, yesterday says so.
function expectedLabel(date) {
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (day(date) === day(new Date())) return time;
  if (day(date) === day(yesterday)) return `Yesterday ${time}`;
  return null;
}

// ---- page helpers ---------------------------------------------------------

const PAGE_DRIVER = `
(() => {
  const NOW = Date.now();
  const row = (id, title) => ({
    id, project: 'scroll-proof', title, firstPrompt: title,
    lastActive: new Date(NOW).toISOString(), lastActiveMs: NOW,
    home: 'personal', provider: 'claude', model: null, isLive: false, paneId: null, workspaceId: null,
    agentStatus: null, isWindowsEra: false, isChildTask: false, childTitle: null,
    cwd: ${JSON.stringify(APP_DIR.replace(/\\/g, '/'))}, isHistorical: true,
  });
  const model = () => {
    const sessions = [row(${JSON.stringify(IDS.a)}, 'Scroll A'), row(${JSON.stringify(IDS.b)}, 'Scroll B'), row(${JSON.stringify(IDS.c)}, 'Scroll C')];
    return JSON.parse(JSON.stringify({
      projects: [{ label: 'scroll-proof', sessions, sessionCount: sessions.length, lastActiveMs: NOW,
        hasLive: false, isWindowsEra: false, isOrchestration: false, isDateGroup: false, displayDayMs: null,
        newSessionCwd: ${JSON.stringify(APP_DIR.replace(/\\/g, '/'))} }],
      liveProjects: [], grouping: 'project',
    }));
  };
  const push = (m) => { window.__setSidebarModelForTest(m); window.__setRailModelForTest?.(structuredClone(m)); };
  window.__scrollDrive = {
    install() { push(model()); return true; },
    conv(id) { return document.querySelector('.win2[data-session-id="' + id + '"] .conv'); },
    // Where a window is: its distance from the bottom, and the first message
    // showing at its top edge with that message's offset from the edge.
    state(id) {
      const n = this.conv(id);
      if (!n) return null;
      const top = n.getBoundingClientRect().top;
      let anchor = null;
      for (const el of n.querySelector('.conv-body').children) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > top + 1) {
          anchor = { text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 48), offset: Math.round(r.top - top) };
          break;
        }
      }
      return { scrollTop: Math.round(n.scrollTop), scrollHeight: n.scrollHeight, clientHeight: n.clientHeight,
        dist: Math.round(n.scrollHeight - n.scrollTop - n.clientHeight), anchor };
    },
    center(selector) {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
    has(id, text) { return (this.conv(id)?.innerText || '').includes(text); },
  };
  return 'installed';
})()
`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-scroll-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  const projectsDir = path.join(tmp, 'projects');
  const fixtureDir = path.join(projectsDir, mungeCwd(APP_DIR));
  fs.mkdirSync(fixtureDir, { recursive: true });

  // A: ten turns yesterday morning, twenty this session. B and C: today only.
  const today = (start, i, gapMin) => new Date(start.getTime() + i * gapMin * 60_000);
  const startToday = new Date(Date.now() - 3 * 3600_000);
  const timesA = Array.from({ length: TURNS }, (_, i) => (i < 10 ? localAt(1, 9, 5 + i * 5) : today(startToday, i - 10, 2)));
  const timesB = Array.from({ length: TURNS }, (_, i) => today(startToday, i, 3));
  const timesC = Array.from({ length: TURNS }, (_, i) => today(startToday, i, 4));
  const files = {};
  for (const [k, tag, times] of [['a', 'A', timesA], ['b', 'B', timesB], ['c', 'C', timesC]]) {
    files[k] = path.join(fixtureDir, `${IDS[k]}.jsonl`);
    fs.writeFileSync(files[k], `${chatRecords(IDS[k], tag, times).map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  const append = (k, record) => fs.appendFileSync(files[k], `${JSON.stringify(record)}\n`);

  realConfig.paths = {
    ...realConfig.paths,
    projectsDir,
    cacheDir: path.join(tmp, 'cache'),
    tasksFile: path.join(tmp, 'tasks.json'),
    notesFile: path.join(tmp, 'notes.json'),
    boardsDir: path.join(tmp, 'boards'),
    projectIconsDir: path.join(tmp, 'project-icons'),
  };
  const claudeHome = path.join(tmp, 'claude-home');
  fs.mkdirSync(path.join(claudeHome, 'projects'), { recursive: true });
  realConfig.profiles = [{ id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', configHome: claudeHome, email: null, isDefault: true }];
  // Three windows side by side in one row, as on Pat's stage.
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(realConfig, null, 2));

  const store = path.join(tmp, 'sessiond');
  fs.mkdirSync(store, { recursive: true });
  const socketPath = path.join(store, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [path.join(APP_DIR, 'src', 'daemon', 'daemon.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_PARENT_PID: String(process.pid),
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-scroll-drive-${process.pid}`,
    },
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
    HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-scroll-drive-${process.pid}`,
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
    HARBOR_NO_VOICE: '1',
    // A send is reported delivered without touching any pane.
    HARBOR_E2E_FAKE_SEND_MS: '150',
    HARBOR_E2E_FAKE_LAUNCH: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (RENDERER) env.VITE_DEV_SERVER_URL = pathToFileURL(RENDERER).href;
  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
    env,
    windowsHide: true,
    stdio: ['ignore', fs.openSync(path.join(OUT, 'electron.log'), 'w'), fs.openSync(path.join(OUT, 'electron.err.log'), 'w')],
  });

  const facts = { renderer: RENDERER || 'app/dist' };
  const checks = {};
  let failure = '';
  let cdpRef = null;
  try {
    let target = null;
    for (let i = 0; i < 1200 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('CDP target never appeared');
    step('window up');
    const ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', reject);
    });
    const cdp = new Cdp(ws);
    cdpRef = cdp;
    await cdp.send('Runtime.enable');
    await waitFor(cdp, 'typeof window.__setSidebarModelForTest === "function" && typeof window.__setRailModelForTest === "function"', 'the E2E model hooks', 60_000);
    await cdp.eval(PAGE_DRIVER);
    await cdp.eval('window.__scrollDrive.install()');
    await cdp.eval("[...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'All')?.click(); true");
    await sleep(400);
    const rowSel = (k) => `.sr[data-session-id="${IDS[k]}"]`;
    await waitFor(cdp, `Boolean(document.querySelector('${rowSel('a')}') || document.querySelector('.pg'))`, 'the test project in the rail');
    if (!(await cdp.eval(`Boolean(document.querySelector('${rowSel('a')}'))`))) {
      await cdp.eval("[...document.querySelectorAll('.pg')].find((g) => /scroll-proof/i.test(g.innerText || ''))?.click(); true");
    }
    for (const k of ['a', 'b', 'c']) {
      await waitFor(cdp, `Boolean(document.querySelector('${rowSel(k)}'))`, `row ${k}`);
      await cdp.eval(`document.querySelector('${rowSel(k)}').click(); true`);
      await sleep(300);
    }
    for (const [k, tag] of [['a', 'A'], ['b', 'B'], ['c', 'C']]) {
      await waitFor(cdp, `window.__scrollDrive.has(${JSON.stringify(IDS[k])}, 'End of ${tag} turn ${TURNS}.')`, `window ${tag} to load`, 45_000);
    }
    await sleep(1500);
    const st = (k) => cdp.eval(`window.__scrollDrive.state(${JSON.stringify(IDS[k])})`);
    const all = async () => ({ a: await st('a'), b: await st('b'), c: await st('c') });
    const atBottom = (s) => Boolean(s && s.dist <= 2);
    const sameSpot = (before, after) => Boolean(before?.anchor && after?.anchor && before.anchor.text === after.anchor.text && Math.abs(before.anchor.offset - after.anchor.offset) <= 4);
    facts.opened = await all();
    checks.openedAtBottom = atBottom(facts.opened.a) && atBottom(facts.opened.b) && atBottom(facts.opened.c);
    await cdp.shot('01-opened');

    // Scroll B up into its history with a real wheel.
    step('wheel B up into its history');
    const bCenter = await cdp.eval(`window.__scrollDrive.center('.win2[data-session-id="${IDS.b}"] .conv')`);
    await wheel(cdp, bCenter.x, bCenter.y, -900);
    await sleep(500);
    await wheel(cdp, bCenter.x, bCenter.y, -900);
    await sleep(1200);
    facts.bRead = await st('b');
    checks.bScrolledUp = Boolean(facts.bRead && facts.bRead.dist > 600 && facts.bRead.scrollTop > 200);

    const run = async (name, fn) => {
      step(name);
      try { await fn(); } catch (error) { facts[`${name}Error`] = error.message; checks[name] = false; }
    };

    await run('focus', async () => {
      await cdp.eval(`document.querySelector('.win2[data-session-id="${IDS.a}"] .tile-focus').click(); true`);
      await sleep(700);
      facts.focusDuring = await all();
      await cdp.eval(`document.querySelector('.win2[data-session-id="${IDS.a}"] .tile-focus').click(); true`);
      await sleep(1000);
      facts.focusAfter = await all();
      checks.focus = atBottom(facts.focusAfter.a) && atBottom(facts.focusAfter.c) && sameSpot(facts.bRead, facts.focusAfter.b);
      await cdp.shot('02-after-focus');
    });

    await run('minimize', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1, height: 1, deviceScaleFactor: 1, mobile: false });
      await sleep(600);
      facts.minimizeDuring = await all();
      append('c', liveRecord(IDS.c, 'C', 1));
      await sleep(7000);
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(1200);
      facts.minimizeAfter = await all();
      facts.minimizeCGotReply = await cdp.eval(`window.__scrollDrive.has(${JSON.stringify(IDS.c)}, 'C live reply 1.')`);
      checks.minimize = atBottom(facts.minimizeAfter.a) && atBottom(facts.minimizeAfter.c) && facts.minimizeCGotReply && sameSpot(facts.bRead, facts.minimizeAfter.b);
      await cdp.shot('03-after-minimize');
    });

    await run('view', async () => {
      await cdp.eval("document.querySelector('.view-switch [aria-label=\"Tasks\"]').click(); true");
      await sleep(900);
      await cdp.eval("document.querySelector('.view-switch [aria-label=\"Agents\"]').click(); true");
      await waitFor(cdp, `Boolean(window.__scrollDrive.conv(${JSON.stringify(IDS.b)}))`, 'the stage to come back');
      await sleep(1500);
      facts.viewAfter = await all();
      checks.view = atBottom(facts.viewAfter.a) && atBottom(facts.viewAfter.c) && sameSpot(facts.bRead, facts.viewAfter.b);
      await cdp.shot('04-after-view-switch');
    });

    // Rearranging windows reorders the tiles in the page, and a browser puts a
    // scroll box that is moved in the page back at its top. Right-drag C onto
    // A's cell, the way Pat rearranges the stage.
    await run('reorder', async () => {
      const before = await all();
      const from = await cdp.eval(`window.__scrollDrive.center('.win2[data-session-id="${IDS.c}"] .wh')`);
      const to = await cdp.eval(`window.__scrollDrive.center('.win2[data-session-id="${IDS.a}"] .wh')`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'right', buttons: 2, clickCount: 1 });
      for (let i = 1; i <= 12; i += 1) {
        const x = Math.round(from.x + ((to.x - from.x) * i) / 12);
        const y = Math.round(from.y + ((to.y - from.y) * i) / 12);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'right', buttons: 2 });
        await sleep(40);
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'right', buttons: 0, clickCount: 1 });
      await sleep(400);
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(1000);
      const after = await all();
      facts.reorder = { before, after, order: await cdp.eval("[...document.querySelectorAll('.grid4 .win2[data-session-id]')].sort((x, y) => Number(x.getAttribute('data-slot')) - Number(y.getAttribute('data-slot'))).map((w) => w.getAttribute('data-session-id').slice(0, 8) + '@' + w.getAttribute('data-slot'))") };
      facts.reorderAtTop = ['a', 'b', 'c'].filter((k) => after[k] && after[k].scrollTop === 0);
      checks.reorderMoved = facts.reorder.order[0]?.startsWith(IDS.c.slice(0, 8));
      checks.reorder = atBottom(after.a) && atBottom(after.c) && sameSpot(before.b, after.b);
      await cdp.shot('04b-after-reorder');
    });

    await run('follow', async () => {
      const seen = [];
      for (let n = 1; n <= 3; n += 1) {
        append('a', liveRecord(IDS.a, 'A', n));
        await waitFor(cdp, `window.__scrollDrive.has(${JSON.stringify(IDS.a)}, 'A live reply ${n}.')`, `A live reply ${n}`, 15_000);
        await sleep(400);
        seen.push(await st('a'));
      }
      facts.follow = seen;
      checks.follow = seen.every(atBottom);
    });

    await run('noYank', async () => {
      const aCenter = await cdp.eval(`window.__scrollDrive.center('.win2[data-session-id="${IDS.a}"] .conv')`);
      append('a', liveRecord(IDS.a, 'A', 10));
      await wheel(cdp, aCenter.x, aCenter.y, -400);
      for (let n = 11; n <= 13; n += 1) {
        await sleep(350);
        append('a', liveRecord(IDS.a, 'A', n));
      }
      await waitFor(cdp, `window.__scrollDrive.has(${JSON.stringify(IDS.a)}, 'A live reply 13.')`, 'A live reply 13', 15_000);
      await sleep(800);
      facts.noYank = await st('a');
      checks.noYank = Boolean(facts.noYank && facts.noYank.dist > 250);
    });

    await run('barWheel', async () => {
      // Select C with a click on its title line (which also arms the composer).
      await cdp.eval(`document.querySelector('.win2[data-session-id="${IDS.c}"] .wh').click(); true`);
      await sleep(500);
      const before = await st('c');
      const bar = await cdp.eval("window.__scrollDrive.center('.ubar-input')");
      await wheel(cdp, bar.x, bar.y, -400);
      await sleep(900);
      const up = await st('c');
      await wheel(cdp, bar.x, bar.y, 6000);
      await sleep(900);
      const down = await st('c');
      append('c', liveRecord(IDS.c, 'C', 2));
      await waitFor(cdp, `window.__scrollDrive.has(${JSON.stringify(IDS.c)}, 'C live reply 2.')`, 'C live reply 2', 15_000);
      await sleep(600);
      const followed = await st('c');
      facts.barWheel = { before, up, down, followed };
      checks.barWheel = atBottom(before) && up.dist >= 300 && atBottom(down) && atBottom(followed);
    });

    await run('header', async () => {
      const before = await st('b');
      const head = await cdp.eval(`window.__scrollDrive.center('.win2[data-session-id="${IDS.b}"] .wh')`);
      await wheel(cdp, head.x, head.y, -300);
      await sleep(900);
      const after = await st('b');
      facts.header = { before, after };
      checks.header = Boolean(before && after && before.scrollTop - after.scrollTop >= 200);
      // Put B back where the earlier steps left it is not needed: later steps
      // only use C and the send check on B.
    });

    await run('pageKeys', async () => {
      await cdp.eval(`document.querySelector('.win2[data-session-id="${IDS.c}"] .wh').click(); true`);
      await sleep(400);
      await cdp.eval("document.querySelector('.ubar-input')?.focus(); true");
      const before = await st('c');
      await key(cdp, 'PageUp', { vk: 33 });
      await sleep(900);
      const up = await st('c');
      await key(cdp, 'PageDown', { vk: 34 });
      await sleep(900);
      const down = await st('c');
      facts.pageKeys = { before, up, down, focus: await cdp.eval("document.activeElement?.className || ''") };
      checks.pageKeys = atBottom(before) && up.dist >= Math.round(before.clientHeight * 0.5) && atBottom(down);
    });

    await run('send', async () => {
      await cdp.eval(`document.querySelector('.win2[data-session-id="${IDS.b}"] .wh').click(); true`);
      await sleep(500);
      const before = await st('b');
      await cdp.eval("document.querySelector('.ubar-input')?.focus(); true");
      await cdp.send('Input.insertText', { text: 'checking where this window lands' });
      await sleep(200);
      await key(cdp, 'Enter', { vk: 13, text: '\r' });
      await sleep(1200);
      const after = await st('b');
      facts.send = { before, after };
      checks.send = Boolean(before && before.dist > 300) && atBottom(after);
    });

    await run('times', async () => {
      const labels = await cdp.eval(`(() => {
        const read = (id) => [...document.querySelectorAll('.win2[data-session-id="' + id + '"] .conv-time')].map((el) => ({ text: el.textContent.trim(), title: el.getAttribute('title') || '', side: el.closest('.conv-turn-meta') ? 'user' : 'assistant' }));
        return { a: read(${JSON.stringify(IDS.a)}), b: read(${JSON.stringify(IDS.b)}) };
      })()`);
      const want = {
        aFirstUser: expectedLabel(timesA[0]),
        aFirstReply: expectedLabel(new Date(timesA[0].getTime() + 40_000)),
        aEleventhUser: expectedLabel(timesA[10]),
        bFirstUser: expectedLabel(timesB[0]),
      };
      const aUser = labels.a.filter((l) => l.side === 'user');
      const aReply = labels.a.filter((l) => l.side === 'assistant');
      const bUser = labels.b.filter((l) => l.side === 'user');
      facts.times = { want, got: { aFirstUser: aUser[0], aFirstReply: aReply[0], aEleventhUser: aUser[10], bFirstUser: bUser[0] }, counts: { aUser: aUser.length, aReply: aReply.length, bUser: bUser.length } };
      checks.times = aUser[0]?.text === want.aFirstUser && aReply[0]?.text === want.aFirstReply
        && aUser[10]?.text === want.aEleventhUser && bUser[0]?.text === want.bFirstUser
        && /20\d\d/.test(aUser[0]?.title || '') && aUser.length >= TURNS && aReply.length >= TURNS;
      // The top of A with a real wheel (a script setting scrollTop is not Pat
      // scrolling, and the window rightly puts that back), so the screenshot
      // shows yesterday's labels.
      const aConv = await cdp.eval(`window.__scrollDrive.center('.win2[data-session-id="${IDS.a}"] .conv')`);
      await wheel(cdp, aConv.x, aConv.y, -20000);
      await sleep(1200);
      await cdp.shot('05-timestamps');
    });

    // The help guide names the wheel, PageUp/PageDown and the times.
    await run('help', async () => {
      await cdp.eval('document.activeElement?.blur?.(); true');
      await key(cdp, 'F1', { vk: 112 });
      await waitFor(cdp, "/PageDown/.test(document.body.innerText) && /hover the time/.test(document.body.innerText)", 'the help guide', 8000);
      await cdp.eval("[...document.querySelectorAll('.help-card')].find((c) => /Keyboard/.test(c.innerText))?.scrollIntoView({ block: 'center' }); true");
      await sleep(400);
      await cdp.shot('06-help');
      checks.help = true;
      await key(cdp, 'Escape', { vk: 27 });
    });

    try { await cdp.eval('window.harbor.e2e.quit()'); } catch { /* quitting */ }
  } catch (error) {
    failure = `drive error: ${error.message}`;
    if (cdpRef) {
      try { facts.failShot = await cdpRef.shot('failure'); } catch { /* window gone */ }
    }
  } finally {
    await sleep(800);
    try { child.kill(); } catch { /* gone */ }
    try { daemon.kill(); } catch { /* gone */ }
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (!failure && failed.length) failure = `failed: ${failed.join(', ')}`;
  fs.writeFileSync(path.join(OUT, 'verdict.json'), JSON.stringify({ checks, facts, failure }, null, 2));
  console.log(JSON.stringify(checks, null, 2));
  if (failure) {
    console.log(`PROOF FAILED: ${failure}`);
    console.log(`details: ${path.join(OUT, 'verdict.json')}`);
    process.exitCode = 1;
  } else {
    console.log('PROOF OK: every window kept its place through full stage, a collapsed page and a view switch; the wheel and PageUp/PageDown scroll the selected window; a send returns it to the bottom; every message shows its time');
  }
}

main();
