'use strict';

// /mcp + >_ drive (2026-10-24, Pat: "you cant do it in the harbor interface but
// then if you toggle it back to the terminal then that doesnt work either").
//
// A brand-new Claude session (no transcript yet) with the CLI's own /mcp list
// open, then its window flips to the raw >_ terminal. Hidden Harbor on the
// repo's capture host (hidden, unfocusable, offscreen windows; isolated HOME,
// config and userData under app/verify/harbor-*), connected to an ISOLATED
// sessiond this script starts itself (relocated store, its own pipe, reaped
// with this process). The session is the REAL Claude CLI in that daemon,
// reading the config home HARBOR_DRIVE_CLAUDE_HOME (default ~/.claude), so the
// list is the real one. No message is ever sent: no transcript, no turn.
//
// Pat's own steps, from Harbor's input log: >_, then the window's focus button
// a second later, then keys, then clicks on rows inside the terminal. PASS
// needs all of:
//   1. the view shows the dialog and forwards mouse events to the CLI;
//   2. after the focus button, three Down presses move the dialog's pointer
//      three rows (read from the session's own screen in the daemon);
//   3. one click on a row opens that server's menu, as it does in a terminal.
// At the pre-fix code (HARBOR_DRIVE_APP=<pre-fix checkout>) steps 1 to 3 fail.
// Usage (from app/): node scripts/drive-mcp-tty-win.js
// Screenshots and facts go to HARBOR_DRIVE_OUT.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const APP = process.env.HARBOR_DRIVE_APP || path.resolve(__dirname, '..');
const HERE = path.resolve(__dirname, '..');
const { captureEnv, hiddenMain, closeApp, assertHidden, reportIsolation } = require(`${APP}/scripts/lib/capture-runtime.cjs`);
const { prepareRoot, buildConfig } = require(`${APP}/scripts/lib/demo-corpus.cjs`);
const { _electron: electron } = require(`${HERE}/node_modules/@playwright/test`);
const { SessionClient } = require(`${APP}/src/daemon/client.js`);

const OUT = process.env.HARBOR_DRIVE_OUT || path.join(os.tmpdir(), 'harbor-drive-mcp-tty');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE
  || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const CLAUDE_HOME = process.env.HARBOR_DRIVE_CLAUDE_HOME || path.join(os.homedir(), '.claude');
// A folder the config home already trusts and outside the account home (the
// capture guard refuses the app any read under it).
const CWD = process.env.HARBOR_DRIVE_CWD || 'C:\\dev\\harbor';
const ELECTRON = path.join(HERE, 'node_modules', 'electron', 'dist', 'electron.exe');
const DAEMON = path.join(APP, 'src', 'daemon', 'daemon.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pointerLine = (text) => String(text).split('\n').findIndex((line) => /^\s*❯/u.test(line));
const pointerRow = (text) => (String(text).split('\n').find((line) => /^\s*❯/u.test(line)) || '(none)').trim();
const active = (page) => page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`);

async function startDaemon(dir, socket) {
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARBOR_SESSIOND_DIR: dir, HARBOR_SESSIOND_SOCKET: socket,
    HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-mcp-tty-${process.pid}` };
  const daemon = spawn(ELECTRON, [DAEMON], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  daemon.stderr.on('data', (c) => { stderr += c; });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { const probe = new SessionClient({ socketPath: socket }); const r = await probe.request('health'); probe.close(); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`isolated daemon never answered: ${stderr}`);
    await sleep(100);
  }
  return daemon;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const root = prepareRoot(path.join(APP, 'verify', 'harbor-mcp-tty'));
  const isolated = captureEnv(root);
  const userData = path.join(root, 'userData');
  const cacheDir = path.join(root, 'cache');
  const projectsDir = path.join(root, 'projects');
  for (const dir of [userData, cacheDir, projectsDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(buildConfig(root, { projectsDir, home: root, cacheDir, userData }), null, 2));
  const facts = { app: APP };
  const problems = [];
  let app; let daemon; let client; let paneId;
  try {
    daemon = await startDaemon(isolated.HARBOR_SESSIOND_DIR, isolated.HARBOR_SESSIOND_SOCKET);
    client = new SessionClient({ socketPath: isolated.HARBOR_SESSIOND_SOCKET, requestTimeoutMs: 30000 });
    const id = randomUUID();
    const childEnv = { CLAUDE_CONFIG_DIR: CLAUDE_HOME, TERM: 'xterm-256color' };
    for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMFILES', 'ProgramData']) {
      if (process.env[key]) childEnv[key] = process.env[key];
    }
    // Harbor's launch geometry (session-daemon/client.js _spawn) and a minted id.
    paneId = (await client.request('spawn', {
      argv: [CLAUDE, '--session-id', id, '--model', 'haiku', '--effort', 'low'],
      cwd: CWD, env: childEnv, cols: 120, rows: 60, agent: 'claude', agent_session: id,
    })).id;
    facts.session = id; facts.pane = paneId;
    const screen = async () => (await client.request('screen', { id: paneId })).visible;
    const until = async (probe, ms, what) => {
      const t = Date.now() + ms;
      while (Date.now() < t) { const v = await probe(); if (v) return v; await sleep(300); }
      throw new Error(`${what}\n--- screen ---\n${await screen()}`);
    };

    app = await electron.launch({ executablePath: require(`${HERE}/node_modules/electron`), args: [hiddenMain, `--user-data-dir=${userData}`], cwd: APP, timeout: 120000, env: { ...isolated, HARBOR_SHOT_ROOT: root } });
    const page = await app.firstWindow({ timeout: 60000 });
    page.setDefaultTimeout(30000);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000));
    await assertHidden(app);
    await page.waitForSelector('.rail', { timeout: 60000 });
    await page.evaluate((sessionId) => {
      localStorage.setItem('harbor-slate-stage', JSON.stringify({ tiles: [{ sessionId, slot: 0 }], selectedId: sessionId }));
      localStorage.setItem('harbor-view', 'agents');
      location.reload();
    }, id);
    const tile = `.win2[data-session-id="${id}"]`;
    await page.waitForSelector(tile, { timeout: 60000 });
    await until(async () => { const s = await screen(); return /❯/u.test(s) && !/Loading/u.test(s); }, 90000, 'composer never came up');
    await page.waitForTimeout(2500);

    // The CLI's own /mcp list, typed into the session the way a terminal would.
    await client.request('input', { id: paneId, text: '/mcp ' });
    await sleep(300);
    await client.request('input', { id: paneId, text: '\r' });
    await until(async () => /Manage MCP servers/.test(await screen()), 30000, '/mcp never opened');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, '1-cli-mcp-behind-the-window.png') });

    // >_ , a real click.
    const click = async (selector) => {
      const box = await page.locator(selector).first().boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    await click(`${tile} button.ico.tty`);
    await page.waitForTimeout(3500);
    const xtermText = async () => (await page.evaluate((sel) => document.querySelector(`${sel} .xterm-rows`)?.innerText || '', tile));
    facts.open = {
      showsDialog: /Manage MCP servers/.test(await xtermText()),
      mouseEventsOn: await page.evaluate((sel) => Boolean(document.querySelector(`${sel} .xterm`)?.classList.contains('enable-mouse-events')), tile),
      activeElement: await active(page),
    };
    await page.screenshot({ path: path.join(OUT, '2-tty-open.png') });
    if (!facts.open.showsDialog) problems.push('the >_ view did not show the /mcp dialog');
    if (!facts.open.mouseEventsOn) problems.push('the >_ view does not forward mouse events to the CLI (clicks only select text)');

    // The focus button a second later, then three Down presses.
    await click(`${tile} button.tile-focus`);
    await page.waitForTimeout(2500);
    const before = await screen();
    facts.afterFocusButton = { activeElement: await active(page), pointerBefore: pointerRow(before) };
    for (let i = 0; i < 3; i += 1) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(400); }
    await page.waitForTimeout(1200);
    const after = await screen();
    facts.afterFocusButton.pointerAfter = pointerRow(after);
    facts.afterFocusButton.moved = pointerLine(after) - pointerLine(before);
    await page.screenshot({ path: path.join(OUT, '3-tty-after-focus-button-and-keys.png') });
    if (facts.afterFocusButton.moved !== 3) problems.push(`after the focus button, three Down presses moved the pointer ${facts.afterFocusButton.moved} rows (keys went to ${facts.afterFocusButton.activeElement})`);

    // One click on a row, as Pat did.
    const rowBox = await page.evaluate((sel) => {
      const row = [...document.querySelectorAll(`${sel} .xterm-rows > div`)].find((r) => /Zoom for Claude/.test(r.innerText));
      if (!row) return null;
      const b = row.getBoundingClientRect();
      const col = row.innerText.indexOf('claude.ai Zoom');
      const cell = b.width / Math.max(1, row.innerText.length || 1);
      return { x: b.left + (col + 4) * cell, y: b.top + b.height / 2 };
    }, tile);
    if (rowBox) { await page.mouse.click(rowBox.x, rowBox.y); await page.waitForTimeout(1800); }
    const clicked = await screen();
    facts.rowClick = { found: Boolean(rowBox), opened: /Authenticate/.test(clicked) && /Zoom/.test(clicked), pointer: pointerRow(clicked) };
    await page.screenshot({ path: path.join(OUT, '4-tty-after-row-click.png') });
    if (!facts.rowClick.opened) problems.push(`one click on the Zoom row did not open its menu (pointer: ${facts.rowClick.pointer})`);
  } catch (error) {
    problems.push(error.stack || error.message);
  } finally {
    try { if (client && paneId) { await client.request('input', { id: paneId, text: '\x1b' }); await sleep(300); await client.request('input', { id: paneId, text: '\x1b' }); } } catch { /* gone */ }
    await closeApp(app).catch((e) => problems.push(`teardown: ${e.message}`));
    try { if (client && paneId) await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ }
    await sleep(1000);
    try { client?.close(); } catch { /* closed */ }
    if (daemon && daemon.exitCode === null) { daemon.kill(); await sleep(1000); }
    try { reportIsolation(root); } catch (e) { problems.push(e.message); }
  }
  fs.writeFileSync(path.join(OUT, 'facts.json'), JSON.stringify({ facts, problems }, null, 2));
  console.log(JSON.stringify(facts, null, 2));
  console.log(problems.length ? `PROOF FAILED:\n- ${problems.join('\n- ')}` : 'PROOF OK: the >_ view shows /mcp, keeps the keys after the focus button, and a click on a row opens it');
  process.exit(problems.length ? 1 : 0);
})();
