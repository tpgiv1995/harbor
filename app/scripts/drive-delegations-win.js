'use strict';

// Shipped renderer and preload, real transcript files and production indexes.
// The only fake is the owning pane. No daemon or real user store is opened.
// This host creates one hidden, non-focusable offscreen BrowserWindow and never
// imports the application's lifecycle composition or calls show/focus/restack.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const APP = path.resolve(__dirname, '..');
const OUT = process.env.HARBOR_DELEGATIONS_SHOTS || path.join(os.tmpdir(), 'harbor-drive-delegations');
const PORT = 9347;
const PARENT = '10000000-0000-4000-8000-000000000001';
const CHILD = '20000000-0000-4000-8000-000000000001';
const SECOND = '20000000-0000-4000-8000-000000000002';
const THIRD = '20000000-0000-4000-8000-000000000003';
const SUB = '30000000-0000-4000-8000-000000000001';
const DEAD = '50000000-0000-4000-8000-000000000001';
const RECENT_DEAD = '50000000-0000-4000-8000-000000000002';
const ORPHAN = '50000000-0000-4000-8000-000000000003';
const ORPHAN_CHILD = '20000000-0000-4000-8000-000000000004';
const OLD_PARENT = '50000000-0000-4000-8000-000000000004';
const OLD_CHILD = '20000000-0000-4000-8000-000000000005';
const SILENT_CHILD = '20000000-0000-4000-8000-000000000006';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function host() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const tmp = process.env.HARBOR_DRIVE_ROOT;
  fs.mkdirSync(path.join(tmp, 'userData'), { recursive: true });
  app.setPath('userData', path.join(tmp, 'userData'));
  app.commandLine.appendSwitch('remote-debugging-port', String(PORT));
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  const { createProviderHistory } = require('../src/main/providers/provider-history.js');
  const { createDelegationIndex, buildDelegationGroups, ageDelegationGroups } = require('../src/main/providers/delegations.js');
  const { mergeSidebarModel } = require('../src/shared/sidebar-model.cjs');
  const { createTranscriptProvider } = require('../src/main/providers/transcript.js');
  const { METHOD_CHANNELS } = require('../src/main/rpc/channels.js');
  const { emptyDoc } = require('../src/shared/tasks-model.cjs');
  const now = Date.now(); const cwd = 'C:\\dev\\delegation-demo';
  const projects = path.join(tmp, 'projects'); fs.mkdirSync(projects, { recursive: true });
  const stamp = (ago) => new Date(now - ago).toISOString();
  const lines = [{ type: 'user', cwd, sessionId: PARENT, timestamp: stamp(900000), message: { role: 'user', content: 'Review the release with delegated agents.' } }];
  function dispatch(id, thread, description, ago, terminal) {
    lines.push({ type: 'assistant', cwd, timestamp: stamp(ago), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `codex exec resume ${thread} --model gpt-6-astra "Check the release before publishing"`, description, run_in_background: true } }] } });
    lines.push({ type: 'user', timestamp: stamp(ago - 100), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${id}.` }] } });
    if (terminal) lines.push({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(ago - 1000), content: `<task-notification><task-id>${id}</task-id><status>${terminal}</status></task-notification>` });
  }
  dispatch('round1', CHILD, 'Review release correctness', 500000, 'completed');
  dispatch('quiet', SECOND, 'Check deployment assumptions', 720000);
  dispatch('failed', THIRD, 'Verify the data migration', 180000, 'failed');
  dispatch('round2', CHILD, 'Review round 2 changes', 10000);
  lines.push({ type: 'assistant', timestamp: stamp(3000), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The release checks are underway. I am waiting for the delegated reviews before the final answer.' }] } });
  const parentPath = path.join(projects, `${PARENT}.jsonl`); fs.writeFileSync(parentPath, lines.map(JSON.stringify).join('\n') + '\n');
  const parents = [{ id: PARENT, title: 'Review the release', project: 'Delegation demo', cwd, path: parentPath, lastActive: stamp(0) }];
  for (let i = 2; i <= 9; i++) {
    const id = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const file = path.join(projects, `${id}.jsonl`); fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: stamp(600000), message: { content: `Grid companion ${i}` } }) + '\n');
    parents.push({ id, title: `Grid companion ${i}`, project: 'Delegation demo', cwd, path: file, lastActive: stamp(600000) });
  }
  for (const [id, title, ago] of [[DEAD, 'Closed parent from yesterday', 1800000], [RECENT_DEAD, 'Recently closed parent', 240000], [ORPHAN, 'Closed parent with independent agent', 1800000], [OLD_PARENT, 'Closed parent with old completed child', 1800000]]) {
    const records = [];
    const launch = (tool, task, output, input) => {
      const launchedAgo = id === OLD_PARENT ? 60 * 3600000 + 1000 : ago;
      records.push({ type: 'assistant', timestamp: stamp(launchedAgo), message: { content: [{ type: 'tool_use', id: task, name: tool, input }] } });
      records.push({ type: 'user', timestamp: stamp(launchedAgo - 100), message: { content: [{ type: 'tool_result', tool_use_id: task, content: output }] } });
    };
    if (id === ORPHAN) launch('Bash', 'independent', 'Command running in background with ID: independent.', { description: 'Independent child review', command: `codex exec resume ${ORPHAN_CHILD} "Continue review"` });
    else if (id === OLD_PARENT) launch('Bash', 'old-review', 'Command running in background with ID: old-review.', { description: 'Old completed review', command: `codex exec resume ${OLD_CHILD} "Review sample"` });
    else {
      launch('Monitor', 'watch', 'Monitor started (task watch, expires in 5m unless the source ends first;', { description: 'Watch sample build' });
      launch('Bash', 'command', 'Command running in background with ID: command.', { description: 'Wait for sample build', command: 'node wait.js' });
      if (id === RECENT_DEAD) launch('Bash', 'silent-review', 'Command running in background with ID: silent-review.', { description: 'Review without recent signal', command: `codex exec resume ${SILENT_CHILD} "Review sample"` });
    }
    records.push({ type: 'assistant', timestamp: stamp(ago - 200), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Background work started.' }] } });
    const file = path.join(projects, `${id}.jsonl`); fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n'); fs.utimesSync(file, new Date(now - ago), new Date(now - ago));
    parents.push({ id, title, project: 'Delegation demo', cwd, path: file, lastActive: stamp(ago) });
  }
  const codexRoot = path.join(tmp, 'codex', 'sessions'); const day = path.join(codexRoot, '2026', '09', '26'); fs.mkdirSync(day, { recursive: true });
  for (const [id, parent, kind, ago, done] of [[CHILD, null, 'exec', 1000, false], [SECOND, null, 'exec', 720000, false], [THIRD, null, 'exec', 179000, true], [ORPHAN_CHILD, null, 'exec', 1000, false], [OLD_CHILD, null, 'exec', 60 * 3600000, true], [SILENT_CHILD, null, 'exec', 3600000, false], [SUB, CHILD, 'subagent', 4000, false], ['40000000-0000-4000-8000-000000000001', CHILD, 'guardian', 1000, true], ['40000000-0000-4000-8000-000000000002', SUB, 'guardian', 1000, true]]) {
    const source = kind === 'exec' ? 'exec' : { subagent: kind === 'guardian' ? { other: 'guardian' } : { thread_spawn: { parent_thread_id: parent, agent_nickname: 'Ohm', agent_path: '/root/semantic' } } };
    const rows = [
      { type: 'session_meta', payload: { id, session_id: CHILD, parent_thread_id: parent, source, cwd, timestamp: stamp(800000), originator: 'codex_exec' } },
      { type: 'turn_context', timestamp: stamp(ago), payload: { model: 'gpt-6-astra' } },
      { type: 'event_msg', timestamp: stamp(ago), payload: { type: 'task_started' } },
      { type: 'event_msg', timestamp: stamp(ago), payload: { type: 'user_message', message: 'Review release correctness' } },
    ];
    if (done) rows.push({ type: 'event_msg', timestamp: stamp(ago), payload: { type: 'task_complete' } });
    const rollout = path.join(day, `rollout-${id}.jsonl`);
    fs.writeFileSync(rollout, rows.map(JSON.stringify).join('\n') + '\n');
    fs.utimesSync(rollout, new Date(now - ago), new Date(now - ago));
  }
  const history = createProviderHistory({ codexRoot, cursorRoot: path.join(tmp, 'cursor'), metadataFile: path.join(tmp, 'metadata.json'), projectLabelForCwd: () => 'Delegation demo' });
  const providers = await history.listSessions();
  const index = createDelegationIndex({ homes: [path.join(tmp, 'claude')], contextCacheDir: path.join(tmp, 'context') }); const scan = await index.scan([...parents, ...providers], [PARENT]);
  const groups = buildDelegationGroups(scan.parents, scan.providers, now);
  assert.equal(groups.groups.find(g => g.parentId === OLD_PARENT).agents[0].state, 'done');
  assert.equal(groups.groups.find(g => g.parentId === OLD_PARENT).active, false);
  for (const row of parents) {
    row.background = scan.parents.find((p) => p.id === row.id)?.background;
    row.ownerEvidence = scan.parents.find((p) => p.id === row.id)?.ownerEvidence;
    if (row.background) for (const task of row.background.tasks) task.delegated = true;
    if (row.id === PARENT) row.delegationSummary = { total: 3, running: 2 };
  }
  for (const row of providers) row.delegatedBy = row.lineage?.parentThreadId || groups.delegatedBy[row.id];
  const model = mergeSidebarModel({ historySessions: [...parents, ...providers], livePanes: [{ pane_id: 'fixture-pane', workspace_id: 'fixture-workspace', agent: 'claude', agent_session: { kind: 'id', value: PARENT }, agent_status: 'idle' }], workspaces: [{ workspace_id: 'fixture-workspace', label: 'Delegation demo', cwd }] });
  const rows = new Map([...parents, ...providers].map((r) => [r.id, r]));
  const transcripts = createTranscriptProvider({ getSessionMeta: async (id) => rows.get(id), contextCacheDir: path.join(tmp, 'context'), readProcessCmdline: () => '' });
  let win;
  transcripts.emitter.on('update', (payload) => win?.webContents.send('transcript:update', payload));
  transcripts.emitter.on('error', (error) => console.error(error.message));
  const answers = {
    'sidebar:get-state': () => ({ model }), 'terminal:get-state': () => ({ panes: [], workspaces: [], tabs: [], connected: false }),
    'new-session:options': () => ({ profiles: [], providers: {}, defaults: {} }), 'setup:state': () => ({ completed: true, orchestrationEnabled: true }),
    'tasks:read': () => emptyDoc(), 'ask:list': () => [], 'project-icons:list': () => [], 'links:get': () => ({}), 'usage:get-all': () => ({}),
    'orchestration:list-runs': () => [], 'orchestration:list-delegations': () => ageDelegationGroups(groups.groups, Date.now(), [PARENT]),
    'transcript:open': (payload) => transcripts.open(payload.sessionId, payload), 'transcript:close': (payload) => transcripts.close(payload.sessionId),
    'session:send-queue': () => ({ queued: [] }), 'session:workflow-runs': () => [], 'session:menu-state': () => null,
    'capabilities:get': () => ({ ok: true, capabilities: { commands: [], models: { cached: [] } } }),
  };
  for (const { method } of METHOD_CHANNELS) ipcMain.handle(method, (_event, payload) => (answers[method] || (() => null))(payload));
  // The real phone bundle consumes the same fixture answers over its ordinary
  // WebSocket protocol. This loopback fixture never composes the live server.
  const http = require('node:http');
  const { WebSocketServer } = require('ws');
  const webRoot = path.join(APP, 'dist-web');
  const server = http.createServer((req, res) => {
    if (req.url === '/whoami') { res.setHeader('Content-Type', 'application/json'); res.end('{"authenticated":true,"tokenRequired":false}'); return; }
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.resolve(webRoot, `.${rel === '/' ? '/index.html' : rel}`);
    if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => socket.on('message', async (data) => {
    const request = JSON.parse(data); let result; let error;
    try { result = await (answers[request.method] || (() => null))(request.payload); } catch (reason) { error = reason.message; }
    socket.send(JSON.stringify({ type: 'response', id: request.id, result, error }));
  }));
  transcripts.emitter.on('update', (payload) => { for (const socket of wss.clients) if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'push', channel: 'transcript:update', args: [payload] })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.log(`MOBILE_URL=http://127.0.0.1:${server.address().port}`);
  await app.whenReady();
  win = new BrowserWindow({ show: false, focusable: false, x: -10000, y: -10000, width: 2560, height: 1600, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, preload: path.join(APP, 'src/preload/index.js') } });
  for (const method of ['show', 'showInactive', 'focus', 'maximize', 'moveTop', 'setAlwaysOnTop']) win[method] = () => { throw new Error(`drive refuses ${method}`); };
  await win.loadFile(path.join(APP, 'dist/index.html'));
  app.on('before-quit', () => { transcripts.closeAll(); history.close(); index.close(); wss.close(); server.close(); });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.onmessage = ({ data }) => { const msg = JSON.parse(data); const pending = this.pending.get(msg.id); if (!pending) return; this.pending.delete(msg.id); msg.error ? pending.reject(Error(msg.error.message)) : pending.resolve(msg.result); }; }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.seq; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async shot(name) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64')); }
}
async function waitFor(cdp, expression) { const end = Date.now() + 20000; while (Date.now() < end) { if (await cdp.eval(expression)) return; await sleep(100); } throw Error(`Timed out: ${expression}`); }
async function drive() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-delegations-drive-'));
  const env = { ...process.env, HARBOR_DRIVE_ROOT: tmp, HARBOR_E2E: '1', HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'), HARBOR_SESSIOND_SOCKET: `\\\\.\\pipe\\harbor-delegations-${process.pid}`, HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_BEACON_HOMES: path.join(tmp, 'claude'), HARBOR_NO_TITLER: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_MODEL_DISCOVERY: '1' };
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
    await cdp.eval(`localStorage.setItem('harbor-slate-stage', ${JSON.stringify(JSON.stringify({ tiles: [{ sessionId: PARENT, slot: 0 }], selectedId: PARENT }))}); localStorage.setItem('harbor-view','agents'); location.reload()`);
    await waitFor(cdp, 'Boolean(document.querySelector(".win2 .runstate-background"))');
    assert.match(await cdp.eval('document.querySelector(".win2 .runstate-background").textContent'), /waiting on 2 agents/);
    assert.equal(await cdp.eval('getComputedStyle(document.querySelector(".win2 .runstate-background .runstate-dot")).backgroundColor'), 'rgb(117, 185, 232)');
    const cue = await cdp.eval('(() => {const r=document.querySelector(".win2 .runstate-background").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...cue});
    await cdp.eval('document.querySelector(".win2 .runstate-background").focus()');
    await waitFor(cdp, 'Boolean(document.querySelector("[role=tooltip]"))');
    assert.match(await cdp.eval('document.querySelector("[role=tooltip]").textContent'), /<1m/);
    await sleep(150); // Let the hidden window submit the tooltip's paint.
    await cdp.shot('01-background-tooltip-2560');
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:2500,y:1500});
    const parentButton = `.sr[data-session-id="${PARENT}"]`;
    if (!await cdp.eval(`Boolean(document.querySelector(${JSON.stringify(parentButton)}))`)) await cdp.eval('document.querySelector(".pg-head, .pg-h, .project-row")?.click()');
    assert.equal(await cdp.eval(`Boolean(document.querySelector('.sr[data-session-id="${CHILD}"]'))`), false);
    await cdp.shot('02-rail-parent-2560');
    // Input through CDP exercises the actual React search handler.
    const search = await cdp.eval('(() => { const e=document.querySelector(".rail-search input, .sidebar-search input, input[placeholder*=Search]"); e.focus(); return Boolean(e); })()'); assert.equal(search, true);
    await cdp.send('Input.insertText', { text: 'Review release correctness' });
    await waitFor(cdp, `Boolean(document.querySelector('.sr[data-session-id="${CHILD}"]'))`);
    await cdp.shot('03-search-finds-children-2560');
    await cdp.eval(`window.__harborOpenSession(${JSON.stringify(PARENT)})`);
    await cdp.eval('document.querySelector(".delegation-pill").click()');
    await waitFor(cdp, `document.querySelectorAll('.delegation-group[data-parent-id="${PARENT}"] .delegation-agent').length === 3`);
    assert.equal(await cdp.eval(`Boolean(document.querySelector('.delegation-group[data-parent-id="${DEAD}"]'))`), false);
    assert.equal(await cdp.eval(`Boolean(document.querySelector('.delegation-group[data-parent-id="${OLD_PARENT}"]'))`), false);
    assert.match(await cdp.eval(`document.querySelector('.delegation-group[data-parent-id="${ORPHAN}"]').textContent`), /running/);
    await cdp.eval(`document.querySelector('.delegation-group[data-parent-id="${RECENT_DEAD}"] .delegation-tasks').open = true`);
    await cdp.eval(`document.querySelector('.delegation-group[data-parent-id="${RECENT_DEAD}"] .delegation-rounds').open = true`);
    assert.match(await cdp.eval(`document.querySelector('.delegation-group[data-parent-id="${RECENT_DEAD}"] .delegation-agent').textContent`), /end time unknown.*ended/);
    assert.match(await cdp.eval(`document.querySelector('.delegation-group[data-parent-id="${RECENT_DEAD}"]').textContent`), /ended with session/);
    const text = await cdp.eval('document.querySelector(".delegations").textContent');
    assert.match(text, /running/); assert.match(text, /failed/); assert.match(text, /quiet.*possibly hung/); assert.match(text, /Ohm/); assert.match(text, /2 approval reviews/);
    assert.equal(await cdp.eval('document.querySelector(".delegation-reviewers").tagName'), 'DIV');
    assert.equal(await cdp.eval('Boolean(document.querySelector(".focused-group"))'), true);
    await cdp.eval(`document.querySelector('.delegation-agent[data-agent-id="${CHILD}"] .delegation-rounds').open = true`);
    await cdp.shot('04-orch-focused-group-2560');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1032, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.shot('04b-orch-narrow');
    assert.equal(await cdp.eval('document.querySelector(".delegation-group").scrollWidth <= document.querySelector(".delegation-group").clientWidth'), true);
    await cdp.eval(`document.querySelector('.delegation-group[data-parent-id="${RECENT_DEAD}"]').scrollIntoView({block:'end'})`);
    await cdp.shot('04c-owner-lifecycle-narrow');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 2560, height: 1600, deviceScaleFactor: 1, mobile: false });
    await cdp.eval(`document.querySelector('.delegation-agent[data-agent-id="${CHILD}"] .delegation-agent-copy button').click()`);
    await waitFor(cdp, `Boolean(document.querySelector('.win2[data-session-id="${CHILD}"] .ro-flag'))`);
    await cdp.shot('05-child-read-only-2560');
    const tiles = Array.from({ length: 9 }, (_, i) => ({ sessionId: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, slot: i }));
    await cdp.eval(`localStorage.setItem('harbor-slate-stage', ${JSON.stringify(JSON.stringify({ tiles, selectedId: PARENT }))}); localStorage.setItem('harbor-view','agents'); location.reload()`);
    await waitFor(cdp, 'document.querySelectorAll(".win2").length === 9');
    await cdp.eval('document.querySelector(".win2 .runstate-background").focus()');
    await cdp.shot('06-background-grid-3x3');
    const geometry = await cdp.eval(`[...document.querySelectorAll('.win2')].map((tile) => { const t=tile.getBoundingClientRect();const c=tile.querySelector('.tile-close').getBoundingClientRect();const title=tile.querySelector('.ti').getBoundingClientRect();return { width:t.width, closeInside:c.right<=t.right, titleWidth:title.width }; })`);
    assert.equal(geometry.every((r) => r.closeInside && r.titleWidth > 100), true);
    const mobileUrl = log.match(/MOBILE_URL=(http:\/\/127\.0\.0\.1:\d+)/)[1];
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: mobileUrl });
    await waitFor(cdp, 'Boolean(document.querySelector(".mobile-background-state"))');
    assert.match(await cdp.eval('document.querySelector(".mobile-background-state").textContent'), /waiting on 2 agents/);
    await cdp.shot('07-phone-background');
    await cdp.eval(`localStorage.setItem('harbor-web-active', ${JSON.stringify(CHILD)}); location.reload()`);
    await waitFor(cdp, 'Boolean(document.querySelector(".hdr-model-chip:disabled"))');
    await cdp.shot('08-phone-child-read-only');
    fs.writeFileSync(path.join(OUT, 'verdict.json'), JSON.stringify({ status: 'PASS', geometry, states: text }, null, 2));
    console.log(JSON.stringify({ status: 'PASS', screenshots: OUT, grid: geometry[0] }));
  } finally { ws?.close(); child.kill(); fs.writeFileSync(path.join(OUT, 'host.log'), log); }
}
(process.argv.includes('--host') ? host() : drive()).catch((error) => { console.error(error); process.exitCode = 1; if (process.argv.includes('--host')) require('electron').app.exit(1); });
