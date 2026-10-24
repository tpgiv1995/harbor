'use strict';

// Shipped renderer and phone bundle, real transcript parser, fixture sessions.
// Proves the action rows Pat asked for on 2026-10-24: a described command reads
// as Claude's own sentence (past tense when done, -ing on the working line), a
// PowerShell call counts as a command, a Windows path shows its file name, and a
// codex cell written as JavaScript names its command, patch and image.
// One hidden, non-focusable offscreen BrowserWindow; no daemon, no real store.
//   node scripts/drive-command-labels-win.js [distDir] [distWebDir]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const APP = path.resolve(__dirname, '..');
const OUT = process.env.HARBOR_COMMAND_LABEL_SHOTS || path.join(os.tmpdir(), 'harbor-drive-command-labels');
const PORT = 9351;
const CLAUDE = '61000000-0000-4000-8000-000000000001';
const CODEX = '62000000-0000-4000-8000-000000000001';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function claudeFixture(cwd, now) {
  const at = (ago) => new Date(now - ago).toISOString();
  const lines = [{ type: 'user', cwd, sessionId: CLAUDE, timestamp: at(300000), message: { role: 'user', content: 'Check whether the nightly test run is stuck' } }];
  let n = 0;
  const tool = (name, input, { done = true, text, thinking } = {}) => {
    const id = `toolu_fixture_${++n}`;
    const content = [];
    if (thinking) content.push({ type: 'thinking', thinking, signature: 'x' });
    if (text) content.push({ type: 'text', text });
    content.push({ type: 'tool_use', id, name, input });
    lines.push({ type: 'assistant', cwd, timestamp: at(280000 - n * 9000), message: { id: `msg_${n}`, role: 'assistant', model: 'claude-opus-5-5', content } });
    if (done) lines.push({ type: 'user', cwd, timestamp: at(279000 - n * 9000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  };
  tool('Bash', { command: 'ls -la /c/Users/demo/.claude*/projects/*/nightly-run* 2>/dev/null; date', description: 'Find the session transcript across config homes' },
    { text: "I'll find which session that is and check whether it's still making progress." });
  tool('Bash', { command: 'cd /c/Users/demo/.claude/projects/C--dev-demo && tail -n 40 nightly-run.jsonl | python -c "import sys"', description: 'Summarize the last 40 transcript entries' },
    { text: "It's a demo session, last written a minute ago. Reading its recent tail to see what it's doing." });
  tool('Bash', { command: 'date -u; ls -la /c/dev/demo/logs/pytest-planrun.txt; tail -c 800 /c/dev/demo/logs/pytest-planrun.txt', description: 'Check test log progress and latest transcript lines' },
    { text: 'The session is sitting in a 20-minute foreground test run. Checking whether this run is making progress or hung.' });
  tool('PowerShell', { command: "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Format-List", description: 'List running pytest processes with CPU and memory' });
  tool('Bash', { command: 'git -C /c/dev/demo log -1 --format=%h; sed -n 255,340p eval/keybuilder/run_plan_keys.py', description: 'Read the key pool code around the budget wait and the commit it came from, to see why the test deadlocks' });
  tool('PowerShell', { command: 'Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq 32704 }' },
    { thinking: 'The test run is hung on a single test; CPU usage is near zero and the log has not moved since 02:27.' });
  tool('Read', { file_path: 'C:\\dev\\demo\\eval\\keybuilder\\test_plan_run.py' });
  tool('TaskCreate', { subject: 'Free the stuck session', description: 'Stop the hung test', activeForm: 'Freeing the stuck session' });
  tool('ToolSearch', { query: 'select:SendMessage', max_results: 1 });
  tool('SendMessage', { to: 'demo-94', summary: 'Tell the session which test deadlocks', message: 'Your rerun is parked on the same line.' });
  tool('Bash', { command: 'ls /c/tools/py-spy 2>/dev/null; python -m pip --version 2>/dev/null; mkdir -p /c/tools/py-spy && python -m pip install --quiet --target /c/tools/py-spy py-spy', description: 'Install py-spy into C:\\tools for stack dumps' },
    { done: false, text: 'I will grab a stack dump of the hung test, then free the session.' });
  return lines;
}

function codexFixture(cwd, now) {
  const at = (ago) => new Date(now - ago).toISOString();
  const rows = [
    { type: 'session_meta', payload: { id: CODEX, cwd, timestamp: at(200000), originator: 'codex_exec', source: 'exec' } },
    { type: 'turn_context', timestamp: at(200000), payload: { model: 'gpt-6-astra' } },
    { type: 'event_msg', timestamp: at(199000), payload: { type: 'user_message', message: 'Tidy the capture script and check the screenshots' } },
  ];
  const cell = (id, input, ago) => {
    rows.push({ type: 'response_item', timestamp: at(ago), payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input } });
    rows.push({ type: 'response_item', timestamp: at(ago - 500), payload: { type: 'custom_tool_call_output', call_id: id, output: 'Process exited with code 0' } });
  };
  cell('c1', 'text(await tools.write_stdin({session_id:12071,chars:"",yield_time_ms:1000}));\ntext(await tools.exec_command({cmd:"Get-Content C:\\\\dev\\\\demo\\\\SKILL.md","max_output_tokens":1400}));\n', 190000);
  cell('c2', 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: C:/dev/demo/capture.mjs\\n@@\\n-const out=1;\\n+const out=2;\\n+const more=3;\\n*** End Patch"));', 180000);
  cell('c3', "for(const n of ['before','after'])image((await tools.view_image({path:'C:/dev/demo/screens/'+n+'.png'})).image_url);", 170000);
  cell('c4', 'text(await tools.write_stdin({session_id:84806,chars:"\\u0003"}));', 160000);
  rows.push({ type: 'event_msg', timestamp: at(150000), payload: { type: 'agent_message', message: 'The capture script is tidy and both screenshots look right.' } });
  rows.push({ type: 'event_msg', timestamp: at(149000), payload: { type: 'task_complete' } });
  return rows;
}

async function host() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const tmp = process.env.HARBOR_DRIVE_ROOT;
  const dist = process.env.HARBOR_DRIVE_DIST || path.join(APP, 'dist');
  const distWeb = process.env.HARBOR_DRIVE_DIST_WEB || path.join(APP, 'dist-web');
  fs.mkdirSync(path.join(tmp, 'userData'), { recursive: true });
  app.setPath('userData', path.join(tmp, 'userData'));
  app.commandLine.appendSwitch('remote-debugging-port', String(PORT));
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  const { createProviderHistory } = require('../src/main/providers/provider-history.js');
  const { mergeSidebarModel } = require('../src/shared/sidebar-model.cjs');
  const { createTranscriptProvider } = require('../src/main/providers/transcript.js');
  const { METHOD_CHANNELS } = require('../src/main/rpc/channels.js');
  const { emptyDoc } = require('../src/shared/tasks-model.cjs');
  const now = Date.now();
  const cwd = 'C:\\dev\\demo';
  const projects = path.join(tmp, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const claudePath = path.join(projects, `${CLAUDE}.jsonl`);
  fs.writeFileSync(claudePath, claudeFixture(cwd, now).map((l) => JSON.stringify(l)).join('\n') + '\n');
  const codexRoot = path.join(tmp, 'codex', 'sessions');
  const day = path.join(codexRoot, '2026', '10', '24');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-${CODEX}.jsonl`), codexFixture(cwd, now).map((l) => JSON.stringify(l)).join('\n') + '\n');
  const history = createProviderHistory({ codexRoot, cursorRoot: path.join(tmp, 'cursor'), metadataFile: path.join(tmp, 'metadata.json'), projectLabelForCwd: () => 'Demo' });
  const providers = await history.listSessions();
  const sessions = [{ id: CLAUDE, title: 'Check stuck session', project: 'Demo', cwd, path: claudePath, lastActive: new Date(now).toISOString() }, ...providers];
  const model = mergeSidebarModel({ historySessions: sessions, livePanes: [{ pane_id: 'fixture-pane', workspace_id: 'fixture-workspace', agent: 'claude', agent_session: { kind: 'id', value: CLAUDE }, agent_status: 'working' }], workspaces: [{ workspace_id: 'fixture-workspace', label: 'Demo', cwd }] });
  const rows = new Map(sessions.map((r) => [r.id, r]));
  const transcripts = createTranscriptProvider({ getSessionMeta: async (id) => rows.get(id), contextCacheDir: path.join(tmp, 'context'), readProcessCmdline: () => '' });
  let win;
  transcripts.emitter.on('update', (payload) => win?.webContents.send('transcript:update', payload));
  const answers = {
    'sidebar:get-state': () => ({ model }), 'terminal:get-state': () => ({ panes: [], workspaces: [], tabs: [], connected: false }),
    'new-session:options': () => ({ profiles: [], providers: {}, defaults: {} }), 'setup:state': () => ({ completed: true, orchestrationEnabled: true }),
    'tasks:read': () => emptyDoc(), 'ask:list': () => [], 'project-icons:list': () => [], 'links:get': () => ({}), 'usage:get-all': () => ({}),
    'orchestration:list-runs': () => [], 'orchestration:list-delegations': () => [],
    'transcript:open': (payload) => transcripts.open(payload.sessionId, payload), 'transcript:close': (payload) => transcripts.close(payload.sessionId),
    'session:send-queue': () => ({ queued: [] }), 'session:workflow-runs': () => [], 'session:menu-state': () => null,
    'capabilities:get': () => ({ ok: true, capabilities: { commands: [], models: { cached: [] } } }),
  };
  for (const { method } of METHOD_CHANNELS) ipcMain.handle(method, (_event, payload) => (answers[method] || (() => null))(payload));
  const http = require('node:http');
  const { WebSocketServer } = require('ws');
  const server = http.createServer((req, res) => {
    if (req.url === '/whoami') { res.setHeader('Content-Type', 'application/json'); res.end('{"authenticated":true,"tokenRequired":false}'); return; }
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.resolve(distWeb, `.${rel === '/' ? '/index.html' : rel}`);
    if (!file.startsWith(distWeb + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => socket.on('message', async (data) => {
    const request = JSON.parse(data);
    let result; let error;
    try { result = await (answers[request.method] || (() => null))(request.payload); } catch (reason) { error = reason.message; }
    socket.send(JSON.stringify({ type: 'response', id: request.id, result, error }));
  }));
  transcripts.emitter.on('update', (payload) => { for (const socket of wss.clients) if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'push', channel: 'transcript:update', args: [payload] })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.log(`MOBILE_URL=http://127.0.0.1:${server.address().port}`);
  await app.whenReady();
  win = new BrowserWindow({ show: false, focusable: false, x: -10000, y: -10000, width: 2560, height: 1600, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, preload: path.join(APP, 'src/preload/index.js') } });
  for (const method of ['show', 'showInactive', 'focus', 'maximize', 'moveTop', 'setAlwaysOnTop']) win[method] = () => { throw new Error(`drive refuses ${method}`); };
  await win.loadFile(path.join(dist, 'index.html'));
  app.on('before-quit', () => { transcripts.closeAll(); history.close(); wss.close(); server.close(); });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.onmessage = ({ data }) => { const msg = JSON.parse(data); const pending = this.pending.get(msg.id); if (!pending) return; this.pending.delete(msg.id); msg.error ? pending.reject(Error(msg.error.message)) : pending.resolve(msg.result); }; }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.seq; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async shot(name) { await sleep(150); const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64')); }
}
async function waitFor(cdp, expression) { const end = Date.now() + 20000; while (Date.now() < end) { if (await cdp.eval(expression)) return; await sleep(100); } await cdp.shot('zz-timeout').catch(() => {}); throw Error(`Timed out: ${expression}`); }
const openTile = (id) => `localStorage.setItem('harbor-slate-stage', ${JSON.stringify(JSON.stringify({ tiles: [{ sessionId: id, slot: 0 }], selectedId: id }))}); localStorage.setItem('harbor-view','agents'); location.reload()`;
const rowTexts = '[...document.querySelectorAll(".win2 .conv-act-row, .win2 .conv-act-group-summary")].map((e) => e.textContent.trim())';
// The saved stage is restored only once the rail knows the session; a reload
// that lands first leaves the stage empty, so open it directly if needed.
async function openSession(cdp, id) {
  await cdp.eval(openTile(id));
  await waitFor(cdp, `Boolean(window.__harborOpenSession) && Boolean(document.querySelector('.sr[data-session-id="${id}"]'))`);
  await sleep(300);
  if (!await cdp.eval(`Boolean(document.querySelector('.win2[data-session-id="${id}"]'))`)) await cdp.eval(`window.__harborOpenSession(${JSON.stringify(id)})`);
  await waitFor(cdp, `Boolean(document.querySelector('.win2[data-session-id="${id}"]'))`);
}

async function drive() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-command-labels-'));
  const env = { ...process.env, HARBOR_DRIVE_ROOT: tmp, HARBOR_E2E: '1', HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'), HARBOR_SESSIOND_SOCKET: `\\\\.\\pipe\\harbor-command-labels-${process.pid}`, HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_BEACON_HOMES: path.join(tmp, 'claude'), HARBOR_NO_TITLER: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_MODEL_DISCOVERY: '1' };
  if (process.argv[2]) env.HARBOR_DRIVE_DIST = path.resolve(process.argv[2]);
  if (process.argv[3]) env.HARBOR_DRIVE_DIST_WEB = path.resolve(process.argv[3]);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(APP, 'node_modules/electron/dist/electron.exe'), [__filename, '--host'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (b) => { log += b; }); child.stderr.on('data', (b) => { log += b; });
  let ws;
  try {
    let target;
    for (let n = 0; n < 100 && !target; n++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((r) => r.type === 'page'); } catch {} }
    if (!target) throw Error('Hidden host did not expose CDP');
    ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const cdp = new Cdp(ws); await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 2560, height: 1600, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, 'Boolean(window.__harborOpenSession)');

    await openSession(cdp, CLAUDE);
    await waitFor(cdp, 'document.querySelectorAll(".win2 .conv-act-said, .win2 .conv-act-group").length >= 3');
    const claudeRows = await cdp.eval(rowTexts);
    assert.ok(claudeRows.some((t) => t.startsWith('Found the session transcript across config homes')), claudeRows.join(' | '));
    assert.ok(claudeRows.some((t) => t.startsWith('Summarized the last 40 transcript entries')), claudeRows.join(' | '));
    assert.ok(claudeRows.includes('Ran 3 commands'), `PowerShell counts as a command: ${claudeRows.join(' | ')}`);
    assert.ok(claudeRows.some((t) => t.startsWith('Installing py-spy into C:\\tools for stack dumps')), `a running command reads in the -ing form: ${claudeRows.join(' | ')}`);
    assert.equal(claudeRows.some((t) => t.startsWith('Installed py-spy')), false, 'a running command never reads as finished');
    assert.equal(claudeRows.some((t) => /ran \d+ tool/.test(t) && /PowerShell/.test(t)), false);
    const working = await cdp.eval('document.querySelector(".win2").textContent');
    assert.match(working, /Installing py-spy into C:\\tools for stack dumps…/);
    assert.doesNotMatch(working, /……/);
    await cdp.shot('01-claude-collapsed-2560');
    await cdp.eval('document.querySelectorAll(".win2 .conv-act-group-toggle").forEach((b) => b.click())');
    await waitFor(cdp, 'document.querySelectorAll(".win2 .conv-act-group.expanded").length > 0');
    const expanded = await cdp.eval(rowTexts);
    assert.ok(expanded.some((t) => t.startsWith('Listed running pytest processes with CPU and memory')), expanded.join(' | '));
    assert.ok(expanded.some((t) => /^Read\s*test_plan_run\.py/.test(t)), `Windows path shows the file name: ${expanded.join(' | ')}`);
    assert.ok(expanded.some((t) => /^Messaged\s*demo-94/.test(t)), expanded.join(' | '));
    const overflow = await cdp.eval('[...document.querySelectorAll(".win2 .conv-act-row")].filter((r) => r.scrollWidth > r.clientWidth + 1).length');
    assert.equal(overflow, 0, 'no action row overflows its window');
    await cdp.shot('02-claude-expanded-2560');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1032, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.eval('document.querySelector(".win2 .conv-act-said")?.scrollIntoView({ block: "start" })');
    // A command that does not fit drops under its sentence; it never shrinks
    // to a sliver beside it, and no row spills out of its window.
    const narrow = await cdp.eval('[...document.querySelectorAll(".win2 .conv-act-main")].map((m) => { const s = m.querySelector(".conv-act-said").getBoundingClientRect(); const c = m.querySelector(".conv-act-chip")?.getBoundingClientRect(); return { chip: c ? c.width : null, below: c ? c.top >= s.bottom - 1 : null }; })');
    assert.ok(narrow.some((r) => r.below), `the long description puts its command on the next line: ${JSON.stringify(narrow)}`);
    assert.ok(narrow.every((r) => r.chip === null || r.chip >= 40), `no command is squeezed to a sliver: ${JSON.stringify(narrow)}`);
    assert.ok(narrow.some((r) => r.below === false), `a short sentence keeps its command on the same line: ${JSON.stringify(narrow)}`);
    assert.equal(await cdp.eval('[...document.querySelectorAll(".win2 .conv-act-row")].filter((r) => r.scrollWidth > r.clientWidth + 1).length'), 0);
    await cdp.shot('03-claude-narrow-1032');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 2560, height: 1600, deviceScaleFactor: 1, mobile: false });

    await openSession(cdp, CODEX);
    await waitFor(cdp, 'document.querySelectorAll(".win2 .conv-act-group, .win2 .conv-act").length >= 1');
    await cdp.eval('document.querySelectorAll(".win2 .conv-act-group-toggle").forEach((b) => b.click())');
    await waitFor(cdp, 'document.querySelectorAll(".win2 .conv-act-row").length >= 4');
    const codexRows = await cdp.eval(rowTexts);
    for (const want of [/^Ran\s*Get-Content C:\\dev\\demo\\SKILL\.md/, /^Edited\s*capture\.mjs\s*\+2 −1/, /^Viewed\s*\*\.png/, /^Typed\s*Ctrl\+C/]) {
      assert.ok(codexRows.some((t) => want.test(t)), `${want}: ${codexRows.join(' | ')}`);
    }
    assert.equal(codexRows.some((t) => /tools\./.test(t)), false, 'no row shows the raw codex script');
    await cdp.shot('04-codex-expanded-2560');

    const mobileUrl = log.match(/MOBILE_URL=(http:\/\/127\.0\.0\.1:\d+)/)[1];
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: mobileUrl });
    await waitFor(cdp, 'Boolean(document.body && document.body.textContent.length > 0)');
    await cdp.eval(`localStorage.setItem('harbor-web-active', ${JSON.stringify(CLAUDE)}); location.reload()`);
    await waitFor(cdp, 'document.querySelectorAll(".conv-act-said, .conv-act-group").length >= 2');
    await cdp.eval('document.querySelectorAll(".conv-act-group-toggle").forEach((b) => b.click())');
    await sleep(300);
    const phoneRows = await cdp.eval('[...document.querySelectorAll(".conv-act-row")].map((e) => e.textContent.trim())');
    assert.ok(phoneRows.some((t) => t.startsWith('Found the session transcript across config homes')), phoneRows.join(' | '));
    const phoneOverflow = await cdp.eval('[...document.querySelectorAll(".conv-act-row")].filter((r) => r.scrollWidth > r.clientWidth + 1).length');
    assert.equal(phoneOverflow, 0, 'no phone action row overflows');
    await cdp.eval('document.querySelector(".conv-act-said")?.scrollIntoView({ block: "center" })');
    await cdp.shot('05-phone-claude-390');
    fs.writeFileSync(path.join(OUT, 'verdict.json'), JSON.stringify({ status: 'PASS', claudeRows, expanded, codexRows, phoneRows, narrow }, null, 2));
    console.log(JSON.stringify({ status: 'PASS', screenshots: OUT }));
  } finally { ws?.close(); child.kill(); fs.writeFileSync(path.join(OUT, 'host.log'), log); }
}
(process.argv.includes('--host') ? host() : drive()).catch((error) => { console.error(error); process.exitCode = 1; if (process.argv.includes('--host')) require('electron').app.exit(1); });
