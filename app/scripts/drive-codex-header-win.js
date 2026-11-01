'use strict';

// Shipped renderer and phone bundle, real transcript parser and sidebar model,
// synthetic fixtures. Proves that a Codex window's header reads like a Claude
// one (2026-10-31, Pat: a Codex window was "missing a ton of information and
// elements (context, cache, etc...)"): the plan badge inside the model chip,
// the effort badge, the context ring and the bottom "CTX n%", and, while the
// task runs, the live elapsed time and output tokens. The cache countdown is a
// Claude fact (the Anthropic prompt cache's TTL); Codex records none, so its
// header must show no cache chip at all.
// One hidden, non-focusable offscreen BrowserWindow; no daemon, no real store.
//   node scripts/drive-codex-header-win.js [distDir] [distWebDir]
//   HARBOR_CODEX_HEADER_SHOTS=<dir>   where screenshots and verdict.json go
//   HARBOR_CODEX_HEADER_EXPECT=0      record the facts without asserting (the
//                                     "before" run against an older build)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const APP = path.resolve(__dirname, '..');
const OUT = process.env.HARBOR_CODEX_HEADER_SHOTS || path.join(os.tmpdir(), 'harbor-drive-codex-header');
const EXPECT = process.env.HARBOR_CODEX_HEADER_EXPECT !== '0';
const PORT = 9352;
const CLAUDE_WORK = '71000000-0000-4000-8000-000000000001';
const CLAUDE_IDLE = '71000000-0000-4000-8000-000000000002';
const CODEX_WORK = '72000000-0000-4000-8000-000000000001';
const CODEX_IDLE = '72000000-0000-4000-8000-000000000002';
const CODEX_PROFILE = 'codex-plan';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Claude: a long-running turn (3h 41m) that has spent 4.4k output tokens, a
// warm one-hour prompt cache, effort xhigh. `idle` ends the turn instead.
function claudeFixture(cwd, now, id, { working }) {
  const at = (ago) => new Date(now - ago).toISOString();
  const usage = (output) => ({ input_tokens: 5, cache_read_input_tokens: 118000, cache_creation_input_tokens: 800, output_tokens: output, cache_creation: { ephemeral_1h_input_tokens: 800, ephemeral_5m_input_tokens: 0 } });
  const lines = [{ type: 'user', cwd, sessionId: id, timestamp: at(working ? 13_260_000 : 600_000), message: { role: 'user', content: working ? 'Keep going through the nightly checks' : 'Summarize the open items' } }];
  const assistant = (n, ago, output, content, stop) => lines.push({ type: 'assistant', cwd, timestamp: at(ago), effort: 'xhigh', message: { id: `msg_${id.slice(-1)}_${n}`, role: 'assistant', model: 'claude-fable-5-1', stop_reason: stop || null, content, usage: usage(output) } });
  if (working) {
    assistant(1, 13_000_000, 1500, [{ type: 'text', text: 'Starting with the first batch.' }, { type: 'tool_use', id: 'toolu_a1', name: 'Bash', input: { command: 'npm test', description: 'Run the test suite' } }]);
    lines.push({ type: 'user', cwd, timestamp: at(12_990_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'ok' }] } });
    assistant(2, 6_000_000, 1700, [{ type: 'tool_use', id: 'toolu_a2', name: 'Read', input: { file_path: 'C:\\work\\notes.md' } }]);
    lines.push({ type: 'user', cwd, timestamp: at(5_990_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a2', content: 'ok' }] } });
    assistant(3, 90_000, 1200, [{ type: 'text', text: 'Running the long build next.' }, { type: 'tool_use', id: 'toolu_a3', name: 'Bash', input: { command: 'npm run build', description: 'Build the app' } }]);
  } else {
    assistant(1, 90_000, 900, [{ type: 'text', text: 'Three items are open: the release notes, the retry test and the cache report.' }], 'end_turn');
  }
  return lines;
}

// Codex: the shapes 0.166 writes (turn_context, thread_settings_applied,
// item_completed items, token_count with last/total usage and the window).
function codexFixture(cwd, now, id, { working, effort, contextTokens, outputThisTask }) {
  const at = (ago) => new Date(now - ago).toISOString();
  const windowTokens = 258400;
  const promptAgo = working ? 161_000 : 900_000;
  const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
  let totalOut = 120_000;
  const tokenCount = (ago, contextNow, output) => {
    totalOut += output;
    return { type: 'event_msg', timestamp: at(ago), payload: { type: 'token_count', info: { total_token_usage: { ...usage(4_700_000, 4_400_000, totalOut), total_tokens: 4_700_000 + totalOut }, last_token_usage: usage(contextNow - output, contextNow - output - 800, output), model_context_window: windowTokens }, rate_limits: { primary: { used_percent: 12 } } } };
  };
  const rows = [
    { type: 'session_meta', timestamp: at(promptAgo + 5000), payload: { id, cwd, timestamp: at(promptAgo + 5000), originator: 'codex-tui', cli_version: '0.166.0', source: 'cli' } },
    tokenCount(promptAgo + 4000, 20_000, 0),
    { type: 'event_msg', timestamp: at(promptAgo + 1000), payload: { type: 'task_started', turn_id: 't1', started_at: Math.floor((now - promptAgo) / 1000), model_context_window: windowTokens } },
    { type: 'turn_context', timestamp: at(promptAgo + 900), payload: { turn_id: 't1', model: 'gpt-6-astra', effort, collaboration_mode: { mode: 'default', settings: { model: 'gpt-6-astra', reasoning_effort: effort } } } },
    { type: 'event_msg', timestamp: at(promptAgo + 800), payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', reasoning_effort: effort } } },
    { type: 'event_msg', timestamp: at(promptAgo), payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: working ? 'Port the retry logic and rerun the build' : 'List what is left to verify' }] } } },
  ];
  const steps = 5;
  for (let n = 1; n <= steps; n += 1) {
    const share = n / steps;
    rows.push(tokenCount(promptAgo - share * (promptAgo - 6000), Math.round(20_000 + share * (contextTokens - 20_000)), Math.round(outputThisTask / steps)));
  }
  if (working) {
    rows.push({ type: 'response_item', timestamp: at(4000), payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"npm run build",workdir:"C:\\\\work"}))' } });
  } else {
    rows.push({ type: 'event_msg', timestamp: at(promptAgo - 100_000), payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1', phase: 'final_answer', content: [{ type: 'Text', text: 'Two things are left: the retry test and the release notes.' }] } } });
    rows.push({ type: 'event_msg', timestamp: at(promptAgo - 101_000), payload: { type: 'task_complete', turn_id: 't1', duration_ms: 101_000 } });
  }
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
  const cwd = 'C:\\work\\demo';
  const projects = path.join(tmp, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const contextDir = path.join(tmp, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  const claudeRows = [];
  for (const [id, working, title] of [[CLAUDE_WORK, true, 'Nightly checks'], [CLAUDE_IDLE, false, 'Open items summary']]) {
    const file = path.join(projects, `${id}.jsonl`);
    fs.writeFileSync(file, claudeFixture(cwd, now, id, { working }).map((l) => JSON.stringify(l)).join('\n') + '\n');
    // The statusline tee is where the Claude gauge's percent and window come from.
    fs.writeFileSync(path.join(contextDir, `${id}.json`), JSON.stringify({ used_percentage: 13, context_window_size: 1_000_000 }));
    claudeRows.push({ id, title, project: 'Demo', cwd, path: file, home: 'personal', lastActive: new Date(now).toISOString() });
  }
  const codexHome = path.join(tmp, 'codex-plan');
  const day = path.join(codexHome, 'sessions', '2026', '10', '31');
  fs.mkdirSync(day, { recursive: true });
  const codexSpecs = [
    [CODEX_WORK, { working: true, effort: 'max', contextTokens: 100_000, outputThisTask: 4400 }],
    [CODEX_IDLE, { working: false, effort: 'high', contextTokens: 167_700, outputThisTask: 9000 }],
  ];
  for (const [id, spec] of codexSpecs) {
    fs.writeFileSync(path.join(day, `rollout-${id}.jsonl`), codexFixture(cwd, now, id, spec).map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const history = createProviderHistory({
    profiles: [{ id: CODEX_PROFILE, provider: 'codex', configHome: codexHome }],
    cursorRoot: path.join(tmp, 'cursor'), metadataFile: path.join(tmp, 'metadata.json'), projectLabelForCwd: () => 'Demo',
  });
  const providers = await history.listSessions();
  const sessions = [...claudeRows, ...providers];
  const panes = [[CLAUDE_WORK, 'claude', 'working'], [CLAUDE_IDLE, 'claude', 'idle'], [CODEX_WORK, 'codex', 'working'], [CODEX_IDLE, 'codex', 'idle']]
    .map(([id, agent, status]) => ({ pane_id: `pane-${id.slice(-8)}-${agent}`, workspace_id: 'fixture-workspace', agent, agent_session: { kind: 'id', value: id }, agent_status: status }));
  const model = mergeSidebarModel({ historySessions: sessions, livePanes: panes, workspaces: [{ workspace_id: 'fixture-workspace', label: 'Demo', cwd }] });
  const rows = new Map(sessions.map((r) => [r.id, r]));
  const transcripts = createTranscriptProvider({ getSessionMeta: async (id) => rows.get(id), contextCacheDir: contextDir, readProcessCmdline: () => '' });
  let win;
  transcripts.emitter.on('update', (payload) => win?.webContents.send('transcript:update', payload));
  const profiles = [
    { id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', isDefault: true },
    { id: CODEX_PROFILE, label: 'Codex plan', letter: 'O', color: '#B48EAD', provider: 'codex', isDefault: false },
  ];
  const answers = {
    'sidebar:get-state': () => ({ model }), 'terminal:get-state': () => ({ panes: [], workspaces: [], tabs: [], connected: false }),
    'new-session:options': () => ({ profiles, providers: {}, defaults: {} }), 'setup:state': () => ({ completed: true, orchestrationEnabled: true }),
    'accounts:read-emails': () => ({}), 'usage:get-plans': () => ({}), 'usage:get-lean': () => null,
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
  win = new BrowserWindow({ show: false, focusable: false, x: -10000, y: -10000, width: 1920, height: 1080, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, preload: path.join(APP, 'src/preload/index.js') } });
  for (const method of ['show', 'showInactive', 'focus', 'maximize', 'moveTop', 'setAlwaysOnTop']) win[method] = () => { throw new Error(`drive refuses ${method}`); };
  await win.loadFile(path.join(dist, 'index.html'));
  app.on('before-quit', () => { transcripts.closeAll(); history.close(); wss.close(); server.close(); });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.errors = []; ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text); const pending = this.pending.get(msg.id); if (!pending) return; this.pending.delete(msg.id); msg.error ? pending.reject(Error(msg.error.message)) : pending.resolve(msg.result); }; }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.seq; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async shot(name, clip) { await sleep(200); const r = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 2 } } : {}) }); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64')); }
  async shotOf(name, selector, pad = 6) {
    const rect = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    if (!rect) throw Error(`no element for ${selector}`);
    await this.shot(name, { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2 });
  }
}
async function waitFor(cdp, expression) { const end = Date.now() + 20000; while (Date.now() < end) { if (await cdp.eval(expression)) return; await sleep(100); } await cdp.shot('zz-timeout').catch(() => {}); throw Error(`Timed out: ${expression}\n${(cdp.errors || []).slice(0, 5).join('\n')}`); }

// What the header and the bar actually say, read from the page.
const windowFacts = (id) => `(() => {
  const w = document.querySelector('.win2[data-session-id="${id}"]');
  if (!w) return null;
  const text = (sel) => { const e = w.querySelector(sel); return e ? e.textContent.trim().replace(/\\s+/g, ' ') : null; };
  const meta = w.querySelector('.wh-meta');
  const kids = [...meta.children].map((c) => ({ cls: String(c.className).split(' ')[0], x: Math.round(c.getBoundingClientRect().x), y: Math.round(c.getBoundingClientRect().y), w: Math.round(c.getBoundingClientRect().width) }));
  return {
    run: text('.runstate'), meter: text('.work-meter'),
    model: text('.model-chip'), effort: text('.model .eff'), plan: text('.model .model-acct'), standalonePill: Boolean(w.querySelector('.apill')),
    gauge: text('.gauge'), gaugeTitle: w.querySelector('.gauge')?.title || null, cache: text('.cache-chip'),
    metaOverflow: meta.scrollWidth > meta.clientWidth + 1, wrapped: kids.some((k) => k.y - Math.min(...kids.map((q) => q.y)) > 14), kids,
  };
})()`;
const barFacts = '(() => { const e = document.querySelector(".ubar-status .ustat-ctx"); return e ? { text: e.textContent.trim().replace(/\\s+/g, " "), title: e.title } : null; })()';
const railBadge = (id) => `(() => { const e = document.querySelector('.sr[data-session-id="${id}"] .sr-b'); return e ? e.textContent.trim() : null; })()`;

async function drive() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-codex-header-'));
  const env = { ...process.env, HARBOR_DRIVE_ROOT: tmp, HARBOR_E2E: '1', HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'), HARBOR_SESSIOND_SOCKET: `\\\\.\\pipe\\harbor-codex-header-${process.pid}`, HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_BEACON_HOMES: path.join(tmp, 'claude'), HARBOR_NO_TITLER: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_MODEL_DISCOVERY: '1' };
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
    const cdp = new Cdp(ws); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await waitFor(cdp, 'Boolean(window.__harborOpenSession)');
    const ids = [CLAUDE_WORK, CLAUDE_IDLE, CODEX_WORK, CODEX_IDLE];
    const stage = { tiles: ids.map((sessionId, slot) => ({ sessionId, slot })), selectedId: CODEX_WORK };
    await cdp.eval(`localStorage.setItem('harbor-slate-stage', ${JSON.stringify(JSON.stringify(stage))}); localStorage.setItem('harbor-view','agents'); location.reload()`);
    await waitFor(cdp, `Boolean(window.__harborOpenSession) && Boolean(document.querySelector('.sr[data-session-id="${CODEX_WORK}"]'))`);
    await sleep(500);
    for (const id of ids) {
      if (!await cdp.eval(`Boolean(document.querySelector('.win2[data-session-id="${id}"]'))`)) await cdp.eval(`window.__harborOpenSession(${JSON.stringify(id)})`);
    }
    await waitFor(cdp, `${JSON.stringify(ids)}.every((id) => document.querySelector('.win2[data-session-id="' + id + '"] .conv-user'))`);
    await sleep(2500); // let the local clock tick and the meters settle
    const facts = {};
    for (const [key, id] of [['claudeWorking', CLAUDE_WORK], ['claudeIdle', CLAUDE_IDLE], ['codexWorking', CODEX_WORK], ['codexIdle', CODEX_IDLE]]) facts[key] = await cdp.eval(windowFacts(id));
    facts.railBadge = { codexWorking: await cdp.eval(railBadge(CODEX_WORK)), codexIdle: await cdp.eval(railBadge(CODEX_IDLE)), claudeIdle: await cdp.eval(railBadge(CLAUDE_IDLE)) };
    // Which tile is selected depends on restore order; select the one under test.
    await cdp.eval(`document.querySelector('.win2[data-session-id="${CODEX_WORK}"] .pj').click()`);
    await sleep(500);
    facts.barCodexWorking = await cdp.eval(barFacts);
    await cdp.shot('01-stage-1920');
    for (const [key, id] of [['claude-working', CLAUDE_WORK], ['claude-idle', CLAUDE_IDLE], ['codex-working', CODEX_WORK], ['codex-idle', CODEX_IDLE]]) await cdp.shotOf(`02-header-${key}`, `.win2[data-session-id="${id}"] .wh`);
    await cdp.shotOf('03-bar-codex-working', '.ubar');
    await cdp.eval(`document.querySelector('.win2[data-session-id="${CODEX_IDLE}"] .pj').click()`);
    await sleep(500);
    facts.barCodexIdle = await cdp.eval(barFacts);
    await cdp.shotOf('04-bar-codex-idle', '.ubar');
    await cdp.eval(`document.querySelector('.win2[data-session-id="${CLAUDE_IDLE}"] .pj').click()`);
    await sleep(500);
    facts.barClaudeIdle = await cdp.eval(barFacts);
    await cdp.shotOf('05-bar-claude-idle', '.ubar');
    await cdp.shotOf('06-rail', '.sr[data-session-id="' + CODEX_IDLE + '"]', 40);

    // A narrower window shape: the same headers at the width of four windows on a 1032px stage.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1032, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    facts.narrow = { codexWorking: await cdp.eval(windowFacts(CODEX_WORK)), claudeWorking: await cdp.eval(windowFacts(CLAUDE_WORK)) };
    await cdp.shot('07-stage-1032');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

    // The phone: the same header facts from the same parser.
    const mobileUrl = log.match(/MOBILE_URL=(http:\/\/127\.0\.0\.1:\d+)/)[1];
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: mobileUrl });
    await waitFor(cdp, 'Boolean(document.body && document.body.textContent.length > 0)');
    await cdp.eval(`localStorage.setItem('harbor-web-active', ${JSON.stringify(CODEX_WORK)}); location.reload()`);
    await waitFor(cdp, `document.body.textContent.includes('Port the retry logic')`).catch(() => {});
    await sleep(2500);
    facts.phone = await cdp.eval(`(() => ({ chip: document.querySelector('.hdr-model-chip')?.textContent.trim() || null, ctx: document.querySelector('.hdr-ctx')?.textContent.trim() || null, ctxTitle: document.querySelector('.hdr-ctx')?.title || null, cache: document.querySelector('.hdr-cache')?.textContent.trim() || null, status: document.querySelector('.hdr-status')?.textContent.trim() || null }))()`);
    await cdp.shot('08-phone-codex-working-390');
    fs.writeFileSync(path.join(OUT, 'verdict.json'), JSON.stringify({ expect: EXPECT, facts }, null, 2));

    if (EXPECT) {
      const cw = facts.codexWorking; const ci = facts.codexIdle; const kw = facts.claudeWorking;
      assert.ok(cw && ci && kw, 'every window rendered');
      // Siblings: the same elements, in the same places.
      assert.equal(cw.plan, 'O', `codex plan badge rides in the model chip: ${JSON.stringify(cw)}`);
      assert.equal(ci.plan, 'O');
      assert.equal(kw.plan, 'P');
      assert.equal(cw.standalonePill, false, 'no second, trailing plan pill');
      assert.equal(cw.effort, 'max', 'effort follows the rollout');
      assert.equal(ci.effort, 'high');
      assert.equal(cw.gauge, '39', `100k of 258.4k tokens is 39 percent: ${cw.gauge}`);
      assert.equal(ci.gauge, '65', `167.7k of 258.4k is 65 percent: ${ci.gauge}`);
      assert.match(cw.gaugeTitle, /39% of context used/);
      assert.equal(ci.cache, null, 'codex records no cache TTL, so there is no cache chip');
      assert.ok(kw.cache, 'the claude cache chip is untouched');
      assert.match(cw.run, /Running|npm run build/i, `codex activity line: ${cw.run}`);
      assert.match(cw.meter || '', /^[23]m \d\ds · ↓ 4\.4k$/, `codex live meter (elapsed from the prompt, output tokens from the rollout): ${cw.meter}`);
      assert.match(kw.meter || '', /^3h \d\dm · ↓ 4\.4k$/, `claude live meter is unchanged: ${kw.meter}`);
      assert.equal(ci.meter, null, 'an idle window has no live meter');
      assert.equal(ci.run, 'ready');
      assert.equal(facts.railBadge.codexIdle, 'O', 'the rail names the codex plan, not the default claude plan');
      assert.equal(facts.railBadge.claudeIdle, 'P');
      assert.match(facts.barCodexWorking.text, /^ctx\s*39%$/);
      assert.match(facts.barCodexIdle.text, /^ctx\s*65%$/);
      assert.match(facts.barClaudeIdle.text, /^ctx\s*13%$/);
      for (const [name, f] of Object.entries({ cw, ci, kw })) assert.equal(f.metaOverflow, false, `${name} header meta does not overflow`);
      assert.match(facts.phone.ctx || '', /39/, `phone context: ${JSON.stringify(facts.phone)}`);
      assert.equal(facts.phone.cache, null, 'no cache chip on the phone for codex either');
    }
    console.log(JSON.stringify({ status: EXPECT ? 'PASS' : 'RECORDED', screenshots: OUT }));
  } finally { ws?.close(); child.kill(); fs.writeFileSync(path.join(OUT, 'host.log'), log); }
}
(process.argv.includes('--host') ? host() : drive()).catch((error) => { console.error(error); process.exitCode = 1; if (process.argv.includes('--host')) require('electron').app.exit(1); });
