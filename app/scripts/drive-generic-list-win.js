'use strict';

// Generic list drive (2026-10-24): the REAL Claude CLI's /mcp list, answered
// from the window's own list card (main/generic-list.js + AskCard ListCard),
// never from the raw terminal.
//
// Same rig as drive-mcp-tty-win.js: hidden Harbor on the capture host, an
// ISOLATED sessiond this script starts, and the real CLI reading the config
// home HARBOR_DRIVE_CLAUDE_HOME (default ~/.claude), so the list is a real
// one. No message is ever sent and nothing is signed in or out: a row click
// opens that server's own menu, and Esc backs out of it.
// PASS needs all of:
//   1. with the pointer moved deep into the list from the terminal side, the
//      window's card lists EVERY row of the CLI's list and marks the same
//      highlighted row the session's own screen shows;
//   2. one click on a row further down opens THAT server's menu in the real
//      dialog (read from the session's screen in the daemon);
//   3. the card's Esc backs the real dialog out to the list again.
// At the pre-fix code (HARBOR_DRIVE_APP=<pre-fix checkout>) step 1 fails: the
// window shows the raw tail of the screen and nothing to click.
// Usage (from app/): node scripts/drive-generic-list-win.js   (HARBOR_DRIVE_OUT for shots)
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
// The drive's own reading of the session screen, always the fixed parser.
const { parseGenericList } = require(`${HERE}/src/main/generic-list.js`);

const OUT = process.env.HARBOR_DRIVE_OUT || path.join(os.tmpdir(), 'harbor-drive-generic-list');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE
  || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const CLAUDE_HOME = process.env.HARBOR_DRIVE_CLAUDE_HOME || path.join(os.homedir(), '.claude');
const CWD = process.env.HARBOR_DRIVE_CWD || path.resolve(HERE, '..');
// Another list dialog can be shown the same way (HARBOR_DRIVE_COMMAND=plugin):
// steps 2 and 3 run only for /mcp, whose row click opens a read-only menu.
const COMMAND = process.env.HARBOR_DRIVE_COMMAND || 'mcp';
const DEEP = Number(process.env.HARBOR_DRIVE_DEEP || (COMMAND === 'mcp' ? 14 : 3));
const ELECTRON = path.join(HERE, 'node_modules', 'electron', 'dist', 'electron.exe');
const DAEMON = path.join(APP, 'src', 'daemon', 'daemon.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startDaemon(dir, socket) {
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARBOR_SESSIOND_DIR: dir, HARBOR_SESSIOND_SOCKET: socket,
    HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-generic-list-${process.pid}` };
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
  const root = prepareRoot(path.join(APP, 'verify', 'harbor-generic-list'));
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
    paneId = (await client.request('spawn', {
      argv: [CLAUDE, '--session-id', id, '--model', 'haiku', '--effort', 'low'],
      cwd: CWD, env: childEnv, cols: 120, rows: 60, agent: 'claude', agent_session: id,
    })).id;
    const screen = async () => (await client.request('screen', { id: paneId })).visible;
    const until = async (probe, ms, what) => {
      const t = Date.now() + ms;
      while (Date.now() < t) { const v = await probe(); if (v) return v; await sleep(300); }
      throw new Error(`${what}\n--- screen ---\n${await screen()}`);
    };
    const cliList = async () => parseGenericList(await screen());

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

    // The CLI's own /mcp, typed into the session the way a terminal would, then
    // the pointer moved deep into the list from the terminal side.
    await client.request('input', { id: paneId, text: `/${COMMAND} ` });
    await sleep(300);
    await client.request('input', { id: paneId, text: '\r' });
    await until(async () => (COMMAND !== 'mcp' || /Manage MCP servers/.test(await screen())) && (await cliList()), 30000, `/${COMMAND} never opened as a list`);
    const first = await cliList();
    for (let i = 0; i < Math.min(DEEP, first.rows.length - 1); i += 1) { await client.request('input', { id: paneId, text: '\x1b[B' }); await sleep(120); }
    await sleep(800);
    const deep = await cliList();
    facts.cli = { rows: deep.rows.length, selected: deep.rows[deep.selectedIndex]?.label, selectedIndex: deep.selectedIndex };

    // 1. The window's card: every row, the same highlight.
    await page.waitForSelector(`${tile} .ask-list`, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    facts.card = await page.evaluate((sel) => {
      const card = document.querySelector(`${sel} .ask-list`);
      if (!card) return { shown: false, fallbackText: document.querySelector(`${sel} .ask-fallback`)?.innerText?.slice(0, 400) || null };
      const sel1 = card.querySelector('.ask-list-row.sel');
      const rect = sel1?.getBoundingClientRect();
      const box = card.querySelector('.ask-list-rows')?.getBoundingClientRect();
      return {
        shown: true,
        rows: card.querySelectorAll('.ask-list-row').length,
        selected: sel1?.querySelector('.ask-list-label')?.firstChild?.textContent || null,
        selectedInView: Boolean(rect && box && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1),
        headers: [...card.querySelectorAll('.ask-list-h')].length,
        keys: [...card.querySelectorAll('.ask-keybtn')].map((b) => b.textContent),
      };
    }, tile);
    await page.screenshot({ path: path.join(OUT, `1-${COMMAND}-list-card-cursor-deep.png`) });
    if (!facts.card.shown) problems.push(`the window shows no list card for the /${COMMAND} dialog`);
    else {
      if (facts.card.rows !== deep.rows.length) problems.push(`the card lists ${facts.card.rows} rows, the CLI ${deep.rows.length}`);
      if (facts.card.selected !== facts.cli.selected) problems.push(`the card highlights "${facts.card.selected}", the CLI "${facts.cli.selected}"`);
      if (!facts.card.selectedInView) problems.push('the highlighted row is scrolled out of the card');
    }

    // 2. One click on a row further down opens that server's own menu.
    // A list that takes typing (/plugin's search): the card's field types
    // into the real dialog and the list re-filters.
    const field = await page.$(`${tile} .ask-list .ask-input`);
    if (facts.card.shown && field && process.env.HARBOR_DRIVE_SEARCH) {
      const query = process.env.HARBOR_DRIVE_SEARCH;
      await field.fill(query);
      await page.locator(`${tile} .ask-list button.ask-send`).click();
      await until(async () => (await screen()).includes(query), 10000, 'the typed search never reached the dialog').catch((e) => problems.push(e.message.split('\n')[0]));
      await sleep(1500);
      const filtered = await cliList();
      await page.waitForTimeout(1500);
      facts.search = {
        query,
        cliRows: filtered?.rows.map((r) => r.label) || null,
        cardRows: await page.$$eval(`${tile} .ask-list-row .ask-list-label`, (els) => els.map((e) => e.firstChild?.textContent)),
      };
      await page.screenshot({ path: path.join(OUT, `2-${COMMAND}-after-search.png`) });
      // The CLI's search also matches descriptions, so the test is that the
      // list changed and its top match names the query.
      const unchanged = JSON.stringify(filtered?.rows.map((r) => r.label)) === JSON.stringify(first.rows.map((r) => r.label));
      if (!filtered || unchanged || !filtered.rows[0].label.toLowerCase().includes(query.toLowerCase())) problems.push(`the CLI list did not filter to "${query}"`);
      if (JSON.stringify(facts.search.cardRows) !== JSON.stringify(facts.search.cliRows)) problems.push('the card does not show the filtered rows the CLI shows');
      // A click while the search field holds the highlight: the walk steps
      // into the list and opens that row (a plugin's details; nothing installs).
      if (filtered?.rows?.length > 1) {
        const target = filtered.rows[1].label;
        await page.locator(`${tile} .ask-list-row`, { has: page.locator('.ask-list-label', { hasText: target }) }).first().click();
        await until(async () => !/Discover plugins/.test(await screen()), 15000, `clicking "${target}" from the search did not open it`).catch((e) => problems.push(e.message.split('\n')[0]));
        const opened = await screen();
        facts.search.clicked = { target, opened: opened.includes(target.split(' · ')[0]), tail: opened.split('\n').filter((l) => l.trim()).slice(-8).join('\n') };
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(OUT, `3-${COMMAND}-after-click-from-search.png`) });
        if (!facts.search.clicked.opened) problems.push(`the click from the search did not open "${target}"`);
      }
    }

    if (facts.card.shown && COMMAND === 'mcp') {
      const targetIndex = Math.min(deep.rows.length - 1, deep.selectedIndex + 3);
      const target = deep.rows[targetIndex].label;
      facts.click = { target };
      await page.locator(`${tile} .ask-list-row`, { has: page.locator('.ask-list-label', { hasText: target }) }).first().click();
      await until(async () => !/Manage MCP servers/.test(await screen()), 15000, `clicking "${target}" did not open its menu`).catch((e) => problems.push(e.message.split('\n')[0]));
      const opened = await screen();
      facts.click.screen = opened.split('\n').filter((line) => line.trim()).slice(-14).join('\n');
      facts.click.opened = opened.includes(target.replace(/^claude\.ai /, '')) && !/Manage MCP servers/.test(opened);
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(OUT, '2-after-row-click.png') });
      if (!facts.click.opened) problems.push(`the click on "${target}" did not open that server's menu`);

      // 3. Esc from the window backs the dialog out to the list.
      // The server's own menu is a NUMBERED dialog, so the question card owns
      // it; its Decline is Esc.
      const esc = page.locator(`${tile} .ask button.ask-dismiss, ${tile} .ask button.ask-keybtn:has-text("Esc")`).first();
      await esc.waitFor({ timeout: 15000 });
      await esc.click();
      await until(async () => /Manage MCP servers/.test(await screen()), 15000, 'Esc from the card did not return to the list').catch((e) => problems.push(e.message.split('\n')[0]));
      await page.waitForTimeout(1800);
      facts.esc = { backToList: /Manage MCP servers/.test(await screen()), cardBack: Boolean(await page.$(`${tile} .ask-list`)) };
      await page.screenshot({ path: path.join(OUT, '3-after-esc.png') });
      if (!facts.esc.cardBack) problems.push('the list card did not come back after Esc');
    }
  } catch (error) {
    problems.push(error.stack || error.message);
  } finally {
    try { if (client && paneId) { for (let i = 0; i < 3; i += 1) { await client.request('input', { id: paneId, text: '\x1b' }); await sleep(300); } } } catch { /* gone */ }
    await closeApp(app).catch((e) => problems.push(`teardown: ${e.message}`));
    try { if (client && paneId) await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ }
    await sleep(1000);
    try { client?.close(); } catch { /* closed */ }
    if (daemon && daemon.exitCode === null) { daemon.kill(); await sleep(1000); }
    try { reportIsolation(root); } catch (e) { problems.push(e.message); }
  }
  fs.writeFileSync(path.join(OUT, 'facts.json'), JSON.stringify({ facts, problems }, null, 2));
  console.log(JSON.stringify(facts, null, 2));
  console.log(problems.length ? `PROOF FAILED:\n- ${problems.join('\n- ')}` : COMMAND === 'mcp'
    ? 'PROOF OK: the window lists every row of the real /mcp list with its highlight, a click opens that row, and Esc backs out'
    : `PROOF OK: the window lists every row of the real /${COMMAND} list with its highlight`);
  process.exit(problems.length ? 1 : 0);
})();
