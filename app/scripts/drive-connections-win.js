'use strict';

// Connections panel drive (2026-10-24): Harbor's own /mcp, driven through the
// REAL renderer, preload, IPC, provider, bin/harbor-mcp-login (real pty) and
// session-send, with the Claude CLI and the session stood in:
//   * test/support/fake-claude-mcp.cjs answers `claude mcp list|get|login|
//     logout` from a state file (pinned through HARBOR_CLAUDE_BIN; the panel
//     refuses to run a real CLI from an isolated profile anyway);
//   * test/support/mcp-session-standin.js is the live session in an ISOLATED
//     daemon this script starts (relocated store, its own pipe); it draws the
//     prompt box and answers `/mcp reconnect|enable|disable` the way the real
//     CLI does, by writing the command and its result to the transcript.
// Hidden Harbor on the capture host (hidden, unfocusable, offscreen windows;
// isolated HOME/config/userData under app/verify/harbor-*). Links open through
// the recorded fake launcher, never a browser.
// The real CLI end to end is scripts/drive-mcp-signin-win.js.
//
// Steps and checks: /mcp + Enter in the command bar opens the panel (and types
// nothing into the session); all 20 servers listed in the CLI's groups; Sign
// in on a claude.ai connector opens its address and waits; claude.ai confirms
// and the running session reconnects; a failed OAuth sign-in shows the CLI's
// reason; Reconnect on a row runs in the session. Screenshots of every state.
// Usage (from app/): node scripts/drive-connections-win.js  (HARBOR_DRIVE_OUT for shots)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const APP = path.resolve(__dirname, '..');
const { captureEnv, hiddenMain, closeApp, assertHidden, reportIsolation } = require('./lib/capture-runtime.cjs');
const { prepareRoot, buildConfig } = require('./lib/demo-corpus.cjs');
const { _electron: electron } = require('../node_modules/@playwright/test');
const { SessionClient } = require('../src/daemon/client.js');
const { claudeProjectDir } = require('../src/main/session-send.js');

const OUT = process.env.HARBOR_DRIVE_OUT || path.join(os.tmpdir(), 'harbor-drive-connections');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const DAEMON = path.join(APP, 'src', 'daemon', 'daemon.js');
const FAKE_CLI = path.join(APP, 'test', 'support', 'fake-claude-mcp.cjs');
const STANDIN = path.join(APP, 'test', 'support', 'mcp-session-standin.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The shape of the list Pat saw (4 user servers, 15 claude.ai connectors with
// three needing a sign-in, one plugin server), every name generic.
const SERVERS = [
  ['sandbox-api', 'https://sandbox.example.com/mcp', 'http', 'connected'],
  ['browser', 'node C:\\tools\\browser\\cli.js --cdp-endpoint=http://127.0.0.1:9222', 'stdio', 'connected'],
  ['graph', 'node C:\\tools\\graph\\server.mjs', 'stdio', 'connected'],
  ['team-wiki', 'https://wiki.example.com/mcp', 'http', 'needs-auth'],
  ...['Design Suite', 'Docs Search', 'File Box', 'Whiteboard', 'Web Crawl', 'Video Studio', 'Diagrams', 'Office Mail', 'Boards'].map((n) => [`claude.ai ${n}`, `https://${n.toLowerCase().replace(/ /g, '-')}.example.com/mcp`, 'http', 'connected']),
  ['claude.ai Automations', 'https://automations.example.com/mcp-server/http', 'http', 'needs-auth'],
  ['claude.ai Meeting Notes', 'https://notes.example.com/mcp', 'http', 'connected'],
  ['claude.ai Team Chat', 'https://chat.example.com/mcp', 'http', 'connected'],
  ['claude.ai Sheets', 'https://sheets.example.com', 'http', 'connected'],
  ['claude.ai Surveys', 'https://surveys.example.com/mcp', 'http', 'needs-auth'],
  ['claude.ai Meetings', 'https://meetings.example.com/mcp/streamable', 'http', 'needs-auth'],
  ['plugin:deploy-skills:deploy', 'https://deploy.example.com/mcp', 'http', 'connected'],
].map(([name, target, transport, status]) => ({ name, target, transport, status }));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const root = prepareRoot(path.join(APP, 'verify', 'harbor-connections'));
  const isolated = captureEnv(root);
  const userData = path.join(root, 'userData');
  const cacheDir = path.join(root, 'cache');
  const projectsDir = path.join(root, '.claude', 'projects');
  const cwd = path.join(root, 'work', 'demo-project');
  for (const dir of [userData, cacheDir, projectsDir, cwd]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(buildConfig(root, { projectsDir, home: root, cacheDir, userData }), null, 2));
  // The plan's own config, by server NAME (the panel groups from it).
  fs.writeFileSync(path.join(root, '.claude', '.claude.json'), JSON.stringify({ mcpServers: Object.fromEntries(SERVERS.filter((s) => !s.name.includes(':') && !s.name.startsWith('claude.ai ')).map((s) => [s.name, { type: s.transport }])) }));
  const stateFile = path.join(root, 'fake-claude-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ servers: SERVERS, login: { 'claude.ai Meetings': 'claudeai', 'team-wiki': 'fail' } }, null, 2));
  const id = randomUUID();
  const transcript = path.join(claudeProjectDir(cwd, root), `${id}.jsonl`);
  // One finished turn, so the session is in the plan's history like any other.
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const at = (n) => new Date(Date.now() - (5 - n) * 60000).toISOString();
  fs.writeFileSync(transcript, `${[
    { type: 'user', uuid: `${id.slice(0, 30)}000001`, sessionId: id, cwd, timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: 'Which connectors do I have?' }] } },
    { type: 'assistant', uuid: `${id.slice(0, 30)}000002`, sessionId: id, cwd, timestamp: at(1), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Type /mcp to see them.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n')}\n`);
  // The plan's prompt history names the session, which is how Harbor tells
  // which plan a session belongs to.
  fs.writeFileSync(path.join(root, '.claude', 'history.jsonl'), `${JSON.stringify({ display: 'Which connectors do I have?', pastedContents: {}, timestamp: Date.now() - 300000, project: cwd, sessionId: id })}\n`);
  const facts = {};
  const problems = [];
  const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) problems.push(what); };
  let app; let daemon; let client; let paneId;
  try {
    fs.mkdirSync(isolated.HARBOR_SESSIOND_DIR, { recursive: true });
    daemon = spawn(ELECTRON, [DAEMON], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARBOR_SESSIOND_DIR: isolated.HARBOR_SESSIOND_DIR, HARBOR_SESSIOND_SOCKET: isolated.HARBOR_SESSIOND_SOCKET, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-connections-${process.pid}` } });
    let daemonErr = '';
    daemon.stderr.on('data', (c) => { daemonErr += c; });
    daemon.on('exit', (code, signal) => { facts.daemonExit = { code, signal, stderr: daemonErr.slice(-4000) }; });
    for (let i = 0; i < 150; i += 1) { try { const p = new SessionClient({ socketPath: isolated.HARBOR_SESSIOND_SOCKET }); const r = await p.request('health'); p.close(); if (r.ok) break; } catch { /* not yet */ } await sleep(100); }
    client = new SessionClient({ socketPath: isolated.HARBOR_SESSIOND_SOCKET, requestTimeoutMs: 30000 });
    // Harbor tells a Claude pane by its process command line (a "claude"
    // program name), so the stand-in runs from a copy named claude, under the
    // system Node running this drive: electron.exe as Node gets no console in
    // a ConPTY and exits at once without a word (measured).
    const standin = path.join(root, 'bin', 'claude');
    fs.mkdirSync(path.dirname(standin), { recursive: true });
    fs.copyFileSync(STANDIN, standin);
    paneId = (await client.request('spawn', {
      argv: [process.execPath, standin, transcript, id],
      cwd, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, cols: 120, rows: 40, agent: 'claude', agent_session: id,
    })).id;
    const paneScreen = async () => (await client.request('screen', { id: paneId })).visible;

    app = await electron.launch({ executablePath: require('../node_modules/electron'), args: [hiddenMain, `--user-data-dir=${userData}`], cwd: APP, timeout: 120000,
      env: { ...isolated, HARBOR_SHOT_ROOT: root, HARBOR_CLAUDE_BIN: FAKE_CLI, HARBOR_FAKE_CLAUDE_STATE: stateFile } });
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
    await page.waitForTimeout(2500);
    const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

    // /mcp + Enter in the real command bar.
    await page.click('.ubar-input[contenteditable], .ubar-input [contenteditable]');
    await page.keyboard.type('/mcp');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.conn-panel', { timeout: 10000 });
    await page.waitForSelector('.conn-row', { timeout: 30000 });
    await page.waitForTimeout(500);
    await shot('conn-1-list.png');
    facts.groups = await page.$$eval('.conn-group-h', (els) => els.map((e) => e.getAttribute('title')));
    facts.rows = await page.$$eval('.conn-row', (els) => els.length);
    facts.draftAfter = await page.$eval('.ubar-input[contenteditable], .ubar-input [contenteditable]', (el) => el.textContent);
    check(facts.rows === 20, `all 20 servers are listed (${facts.rows})`);
    check(facts.groups.some((g) => g.startsWith('User MCPs (')) && facts.groups.includes('claude.ai') && facts.groups.includes('Built-in MCPs (always available)'), `grouped like the CLI: ${facts.groups.join(' | ')}`);
    check(!/\/mcp/.test(await paneScreen()), '/mcp was NOT typed into the session');
    check(!facts.draftAfter.includes('/mcp'), 'the command bar draft is cleared');
    await page.$eval('.conn-scroll', (el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(300);
    await shot('conn-2-list-bottom.png');

    // Sign in on a claude.ai connector.
    const row = (name) => `.conn-row[data-server="${name}"]`;
    const launchesBefore = (await page.evaluate(() => window.harbor.e2e.getLaunchCalls())).length;
    await page.locator(`${row('claude.ai Meetings')} button.primary`).click();
    await page.waitForSelector(`${row('claude.ai Meetings')} .conn-job`, { timeout: 15000 });
    await page.waitForFunction((sel) => /claude\.ai to confirm|in the browser/.test(document.querySelector(sel)?.textContent || ''), `${row('claude.ai Meetings')} .conn-job`, { timeout: 15000 });
    await page.locator(row('claude.ai Meetings')).scrollIntoViewIfNeeded();
    await shot('conn-3-signin-waiting.png');
    const opened = (await page.evaluate(() => window.harbor.e2e.getLaunchCalls())).slice(launchesBefore).filter((c) => c.command === 'open-external').map((c) => c.argv[0]);
    facts.opened = opened;
    check(opened.length === 1 && opened[0].startsWith('https://claude.ai/'), `the claude.ai address opened in the browser exactly once (${opened.join(', ')})`);

    // claude.ai confirms: the CLI now reads it connected.
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state.servers.find((s) => s.name === 'claude.ai Meetings').status = 'connected';
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    await page.waitForFunction((sel) => /reconnected with the new tools/.test(document.querySelector(sel)?.textContent || ''), `${row('claude.ai Meetings')} .conn-job`, { timeout: 60000 });
    await page.waitForFunction((sel) => /Connected/.test(document.querySelector(sel)?.textContent || ''), `${row('claude.ai Meetings')} .conn-status`, { timeout: 30000 });
    await page.locator(row('claude.ai Meetings')).scrollIntoViewIfNeeded();
    await shot('conn-4-signed-in.png');
    const tx = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8') : '';
    check(/<command-args>reconnect claude\.ai Meetings<\/command-args>/.test(tx), 'the running session got /mcp reconnect for that connector');

    // A failed OAuth sign-in.
    await page.locator(row('team-wiki')).scrollIntoViewIfNeeded();
    await page.locator(`${row('team-wiki')} button.primary`).click();
    await page.waitForFunction((sel) => /Sign-in failed/.test(document.querySelector(sel)?.textContent || ''), `${row('team-wiki')} .conn-job`, { timeout: 30000 });
    facts.failedText = await page.$eval(`${row('team-wiki')} .conn-job`, (el) => el.textContent);
    await shot('conn-5-signin-failed.png');
    check(/access_denied/.test(facts.failedText), `the failure shows the CLI's reason: ${facts.failedText}`);

    // Reconnect on a row.
    await page.locator(`${row('graph')} button`, { hasText: 'Reconnect' }).click();
    await page.waitForFunction((sel) => /Successfully reconnected to graph/.test(document.querySelector(sel)?.textContent || ''), `${row('graph')}`, { timeout: 30000 });
    await page.locator(row('graph')).scrollIntoViewIfNeeded();
    await shot('conn-6-reconnect.png');
    check(true, 'Reconnect on a row ran in the session and reported its result');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check(!(await page.$('.conn-panel')), 'Esc closes the panel');
  } catch (error) {
    problems.push(error.stack || error.message);
    try { facts.panesAtError = await client.request('list'); facts.screenAtError = (await client.request('screen', { id: paneId })).visible; } catch (e) { facts.panesAtError = String(e.message); }
    try { await app?.windows()[0]?.screenshot({ path: path.join(OUT, 'conn-error.png') }); } catch { /* none */ }
  } finally {
    await closeApp(app).catch((e) => problems.push(`teardown: ${e.message}`));
    try { if (client && paneId) await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ }
    await sleep(800);
    try { client?.close(); } catch { /* closed */ }
    if (daemon && daemon.exitCode === null) { daemon.kill(); await sleep(800); }
    try { reportIsolation(root); } catch (e) { problems.push(e.message); }
  }
  fs.writeFileSync(path.join(OUT, 'facts.json'), JSON.stringify({ facts, problems }, null, 2));
  console.log(JSON.stringify(facts, null, 2));
  console.log(problems.length ? `FAILED:\n- ${problems.join('\n- ')}` : 'PASS');
  process.exit(problems.length ? 1 : 0);
})();
