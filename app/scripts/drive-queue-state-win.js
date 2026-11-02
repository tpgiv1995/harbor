'use strict';

// Shipped renderer, real transcript parser and sidebar model, synthetic fixture.
// Proves that messages waiting in Claude's own queue SHOW in the Harbor window
// (2026-11-01, Pat: "a lot more messages that are sticking in the queue when i
// enter the terminal view. it'd be nice to have some visibility into this in
// the 'harbor view'"): a waiting bubble is drawn dashed with "Waiting in
// Claude's queue" under it, one Claude took after 70 s says "Waited 1m 10s",
// one taken at once says nothing, and the header counts what still waits,
// background results included. A message another session sent is labelled
// with that session's name, not drawn with its raw wrapper. A running sub-agent
// shows how many tools it has used and what it is doing under its Delegated row. One hidden, non-focusable offscreen
// BrowserWindow; no daemon, no real store.
//   node scripts/drive-queue-state-win.js [distDir]
//   HARBOR_QUEUE_SHOTS=<dir>     where screenshots and verdict.json go
//   HARBOR_QUEUE_EXPECT=0        record the facts without asserting (the
//                                "before" run against an older build)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const APP = path.resolve(__dirname, '..');
const OUT = process.env.HARBOR_QUEUE_SHOTS || path.join(os.tmpdir(), 'harbor-drive-queue-state');
const EXPECT = process.env.HARBOR_QUEUE_EXPECT !== '0';
const PORT = 9353;
const SESSION = '73000000-0000-4000-8000-000000000001';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A working Claude turn with the queue records 2.1.316 writes: enqueue, then
// `remove` with the same content when Claude takes it mid-turn.
function fixture(cwd, now) {
  const at = (ago) => new Date(now - ago).toISOString();
  const usage = (output) => ({ input_tokens: 5, cache_read_input_tokens: 90000, cache_creation_input_tokens: 600, output_tokens: output, cache_creation: { ephemeral_1h_input_tokens: 600, ephemeral_5m_input_tokens: 0 } });
  const lines = [];
  const assistant = (n, ago, content) => lines.push({ type: 'assistant', cwd, timestamp: at(ago), effort: 'xhigh', message: { id: `msg_q_${n}`, role: 'assistant', model: 'claude-opus-5-5', content, usage: usage(800), stop_reason: 'tool_use' } });
  const result = (id, ago) => lines.push({ type: 'user', cwd, timestamp: at(ago), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const queue = (operation, content, ago) => lines.push({ type: 'queue-operation', operation, ...(content ? { content } : {}), timestamp: at(ago), sessionId: SESSION });
  lines.push({ type: 'user', cwd, sessionId: SESSION, timestamp: at(900_000), message: { role: 'user', content: 'Run the release rehearsal and report what fails.' } });
  assistant(1, 880_000, [{ type: 'text', text: 'Starting the rehearsal.' }, { type: 'tool_use', id: 'toolu_q1', name: 'Bash', input: { command: 'npm run rehearsal', description: 'Run the release rehearsal' } }]);
  queue('enqueue', 'Also note how long each stage takes.', 400_000);
  result('toolu_q1', 330_000);
  queue('remove', 'Also note how long each stage takes.', 330_000);
  assistant(2, 320_000, [{ type: 'text', text: 'Rehearsal stage one passed; timing each stage from here.' }, { type: 'tool_use', id: 'toolu_q2', name: 'Bash', input: { command: 'npm run rehearsal -- --stage 2', description: 'Run stage two' } }]);
  queue('enqueue', 'Quick one: skip the screenshots step.', 300_000);
  result('toolu_q2', 298_000);
  queue('remove', 'Quick one: skip the screenshots step.', 298_000);
  assistant(3, 290_000, [{ type: 'tool_use', id: 'toolu_q3', name: 'Bash', input: { command: 'npm run rehearsal -- --stage 3', description: 'Run stage three, the long one' } }, { type: 'tool_use', id: 'toolu_q4', name: 'Agent', input: { description: 'Check free disk space on the build agents', subagent_type: 'general-purpose' } }]);
  queue('enqueue', '<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-demo" from-name="dispatcher">Stage three is the one that filled the disk last time; watch free space.</cross-session-message>', 120_000);
  queue('enqueue', 'When this finishes, push the branch.', 45_000);
  queue('enqueue', '[SYSTEM NOTIFICATION - NOT USER INPUT] Background task finished: disk report', 30_000);
  return lines;
}

async function host() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const tmp = process.env.HARBOR_DRIVE_ROOT;
  const dist = process.env.HARBOR_DRIVE_DIST || path.join(APP, 'dist');
  fs.mkdirSync(path.join(tmp, 'userData'), { recursive: true });
  app.setPath('userData', path.join(tmp, 'userData'));
  app.commandLine.appendSwitch('remote-debugging-port', String(PORT));
  app.commandLine.appendSwitch('disable-background-timer-throttling');
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
  const file = path.join(projects, `${SESSION}.jsonl`);
  fs.writeFileSync(file, fixture(cwd, now).map((l) => JSON.stringify(l)).join('\n') + '\n');
  // The running sub-agent behind the Delegated row, in its own transcript.
  const subs = path.join(projects, SESSION, 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  fs.writeFileSync(path.join(subs, 'agent-disk.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_q4', finished: false }));
  const subTool = (name, input) => JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: new Date(now).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `s-${Math.random()}`, name, input }] } });
  fs.writeFileSync(path.join(subs, 'agent-disk.jsonl'), [
    ...Array.from({ length: 6 }, (_, i) => subTool('Grep', { pattern: `agent-${i}` })),
    subTool('Bash', { command: 'Get-PSDrive C', description: 'Measure free space on C:' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(contextDir, `${SESSION}.json`), JSON.stringify({ used_percentage: 21, context_window_size: 1_000_000 }));
  const rows = [{ id: SESSION, title: 'Release rehearsal', project: 'Demo', cwd, path: file, home: 'personal', lastActive: new Date(now).toISOString() }];
  const panes = [{ pane_id: 'pane-queue-claude', workspace_id: 'fixture-workspace', agent: 'claude', agent_session: { kind: 'id', value: SESSION }, agent_status: 'working' }];
  const model = mergeSidebarModel({ historySessions: rows, livePanes: panes, workspaces: [{ workspace_id: 'fixture-workspace', label: 'Demo', cwd }] });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const transcripts = createTranscriptProvider({ getSessionMeta: async (id) => byId.get(id), contextCacheDir: contextDir, readProcessCmdline: () => '' });
  let win;
  transcripts.emitter.on('update', (payload) => win?.webContents.send('transcript:update', payload));
  const profiles = [{ id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', isDefault: true }];
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
  await app.whenReady();
  win = new BrowserWindow({ show: false, focusable: false, x: -10000, y: -10000, width: 1920, height: 1080, webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, preload: path.join(APP, 'src/preload/index.js') } });
  for (const method of ['show', 'showInactive', 'focus', 'maximize', 'moveTop', 'setAlwaysOnTop']) win[method] = () => { throw new Error(`drive refuses ${method}`); };
  await win.loadFile(path.join(dist, 'index.html'));
  app.on('before-quit', () => { transcripts.closeAll(); });
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

// What the window actually says, read from the page.
const facts = `(() => {
  const w = document.querySelector('.win2[data-session-id="${SESSION}"]');
  if (!w) return null;
  const meta = w.querySelector('.wh-meta');
  const chip = w.querySelector('.queue-chip');
  return {
    chip: chip ? chip.textContent.trim() : null,
    chipTitle: chip ? chip.title : null,
    waitingBubbles: [...w.querySelectorAll('.conv-user.queued-waiting .conv-user-text')].map((e) => e.textContent.trim()),
    peerLabels: [...w.querySelectorAll('.conv-user.peer .conv-peer-from')].map((e) => e.textContent.trim()),
    peerSide: (() => { const p = w.querySelector('.conv-user.peer'); const c = w.querySelector('.conv'); if (!p || !c) return null; const pr = p.getBoundingClientRect(); const cr = c.getBoundingClientRect(); return pr.left - cr.left < cr.right - pr.right ? 'left' : 'right'; })(),
    subLines: [...w.querySelectorAll('.conv-act-sub')].map((e) => e.textContent.trim()),
    rawWrapperShown: /cross-session-message/.test(w.textContent),
    states: [...w.querySelectorAll('.conv-queue-state')].map((e) => ({ text: e.textContent.trim(), waiting: e.classList.contains('waiting') })),
    bubbles: w.querySelectorAll('.conv-user').length,
    metaOverflow: meta.scrollWidth > meta.clientWidth + 1,
    // The command bar (2026-11-02): typed messages waiting means Stop is how
    // they go now, and the bar says so.
    barPhase: document.querySelector('.ubar-status .ustat-phase')?.textContent.trim() || null,
    stopTitle: document.querySelector('button.send.stop')?.title || null,
  };
})()`;

async function drive() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-queue-state-'));
  const env = { ...process.env, HARBOR_DRIVE_ROOT: tmp, HARBOR_E2E: '1', HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'), HARBOR_SESSIOND_SOCKET: `\\\\.\\pipe\\harbor-queue-state-${process.pid}`, HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_BEACON_HOMES: path.join(tmp, 'claude'), HARBOR_NO_TITLER: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_MODEL_DISCOVERY: '1' };
  if (process.argv[2]) env.HARBOR_DRIVE_DIST = path.resolve(process.argv[2]);
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
    const stage = { tiles: [{ sessionId: SESSION, slot: 0 }], selectedId: SESSION };
    await cdp.eval(`localStorage.setItem('harbor-slate-stage', ${JSON.stringify(JSON.stringify(stage))}); localStorage.setItem('harbor-view','agents'); location.reload()`);
    await waitFor(cdp, `Boolean(window.__harborOpenSession) && Boolean(document.querySelector('.sr[data-session-id="${SESSION}"]'))`);
    await sleep(500);
    if (!await cdp.eval(`Boolean(document.querySelector('.win2[data-session-id="${SESSION}"]'))`)) await cdp.eval(`window.__harborOpenSession(${JSON.stringify(SESSION)})`);
    await waitFor(cdp, `Boolean(document.querySelector('.win2[data-session-id="${SESSION}"] .conv-user'))`);
    await sleep(1500);
    const wide = await cdp.eval(facts);
    await cdp.shot('01-window-1920');
    await cdp.shotOf('02-header-1920', `.win2[data-session-id="${SESSION}"] .wh`);
    await cdp.shotOf('06-command-bar-1920', '.ubar-status', 4).catch(() => {});
    await cdp.shotOf('07-stop-button-1920', 'button.send.stop', 8).catch(() => {});
    await cdp.eval(`(() => { const b = document.querySelectorAll('.win2[data-session-id="${SESSION}"] .conv-user'); b[b.length - 1].scrollIntoView({ block: 'end' }); })()`);
    await sleep(300);
    await cdp.shotOf('03-conversation-1920', `.win2[data-session-id="${SESSION}"] .conv-scroll, .win2[data-session-id="${SESSION}"] .conv`, 0).catch(() => cdp.shot('03-conversation-1920'));
    // The window at one cell of a 4x4 grid on Pat's screen (about 400px wide):
    // the window itself is narrowed, so the page around it keeps its layout.
    await cdp.eval(`(() => { const w = document.querySelector('.win2[data-session-id="${SESSION}"]'); w.style.width = '400px'; w.style.maxWidth = '400px'; w.style.flex = 'none'; })()`);
    await sleep(600);
    const narrow = await cdp.eval(facts);
    await cdp.shotOf('04-window-400', `.win2[data-session-id="${SESSION}"]`, 0);
    await cdp.shotOf('05-header-400', `.win2[data-session-id="${SESSION}"] .wh`);
    const verdict = { expect: EXPECT, wide, narrow, errors: cdp.errors };
    fs.writeFileSync(path.join(OUT, 'verdict.json'), JSON.stringify(verdict, null, 2));
    if (EXPECT) {
      assert.ok(wide, 'the window rendered');
      assert.equal(wide.chip, '3 queued', `header count: ${JSON.stringify(wide)}`);
      assert.match(wide.chipTitle, /^3 messages wait for Claude's next step \(1 from you, 1 from other sessions, 1 background result\)/);
      assert.deepEqual(wide.waitingBubbles.length, 2, `two typed messages still wait: ${JSON.stringify(wide.waitingBubbles)}`);
      assert.deepEqual(wide.states.map((s) => s.text), [
        "Waited 1m 10s in Claude's queue",
        "Waiting in Claude's queue: it reads this at its next step",
        "Waiting in Claude's queue: it reads this at its next step",
      ], 'the 70 s wait is noted, the 2 s one is not, both waiting ones say so');
      assert.deepEqual(wide.waitingBubbles, ['Stage three is the one that filled the disk last time; watch free space.', 'When this finishes, push the branch.'], 'the peer message shows its text, not its wrapper');
      assert.deepEqual(wide.peerLabels, ['Message from dispatcher'], 'the peer message names the session that sent it');
      assert.equal(wide.peerSide, 'left', 'a peer message sits on the other side from Pat\'s own messages');
      assert.equal(wide.rawWrapperShown, false, 'no raw cross-session wrapper on screen');
      assert.deepEqual(wide.subLines, ['7 tools so far · Measuring free space on C:'], 'the running sub-agent says what it is doing, even in a collapsed group');
      assert.equal(wide.metaOverflow, false, 'the header does not overflow at 1920');
      assert.equal(narrow.metaOverflow, false, 'the header does not overflow at a grid cell width');
      assert.equal(wide.barPhase, "2 messages wait in Claude's queue. Stop sends them now", `the bar names Stop as the way to send them now: ${JSON.stringify(wide.barPhase)}`);
      assert.match(wide.stopTitle || '', /reads your 2 queued messages now \(Esc\)/, 'the Stop button says what it does to the queue');
      assert.deepEqual(cdp.errors, [], 'no page errors');
    }
    console.log(JSON.stringify({ status: EXPECT ? 'PASS' : 'RECORDED', screenshots: OUT }));
  } finally { ws?.close(); child.kill(); fs.writeFileSync(path.join(OUT, 'host.log'), log); }
}
(process.argv.includes('--host') ? host() : drive()).catch((error) => { console.error(error); process.exitCode = 1; if (process.argv.includes('--host')) require('electron').app.exit(1); });
