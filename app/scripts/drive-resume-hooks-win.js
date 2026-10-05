#!/usr/bin/env node
'use strict';

// LIVE PROOF that a message sent into a freshly RESUMED Claude session lands,
// against the REAL Claude Code CLI in an ISOLATED daemon (relocated store, its
// own cwd, never the user's daemon).
//
// Why this exists (2026-09-14, CLI 2.1.270): `--resume` now draws the composer
// BEFORE the SessionStart hooks finish (2.1.268 changelog: "the conversation
// appears immediately instead of waiting for SessionStart hooks"), and text
// typed while the "Running SessionStart hooks…" spinner is up is DROPPED. Harbor
// judged the pane ready off the settled composer, typed Pat's message three
// seconds after the resume, and the message never reached the transcript. The
// send log said "sent".
//
// What it exercises, all production code: the daemon's screen model, the
// readiness rule (`waitForResumedClaudeReady`, the exact call actions/takeover
// makes after a resume) and `send()` from session-send.js.
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/drive-resume-hooks-win.js
// Needs a signed-in claude on this machine; costs two small haiku turns. The
// probe session's transcript is deleted afterwards so it never reaches the rail.
//
// Exit 0 with "PROOF OK" only when the message delivered after readiness is
// recorded as a user record in the CLI's own transcript.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');
const { createSessionSend, createLinkRegistry } = require('../src/main/session-send.js');

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE
  || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-resume-hooks-proof-'));
const cwd = fs.mkdtempSync(path.join(tmp, 'harbor-resume-hooks-cwd-'));
const socketPath = path.join(store, 'daemon.sock');
const HOOKS_RE = /Running SessionStart hooks/i;

const cleanup = { client: null, daemon: null, paneIds: [], transcriptDir: null, sampler: null };
async function teardown() {
  const { client, daemon, paneIds, transcriptDir, sampler } = cleanup;
  if (sampler) clearInterval(sampler);
  for (const paneId of paneIds) {
    if (client) { try { await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ } }
  }
  if (client) client.close();
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), sleep(5000)]);
  }
  await sleep(500);
  for (const dir of [store, cwd, transcriptDir].filter(Boolean)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort */ }
  }
}

function transcriptRecords(transcript) {
  let text = '';
  try { text = fs.readFileSync(transcript, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}
function textOf(record) {
  const content = record?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === 'text').map((p) => p.text || '').join('');
  return '';
}

async function main() {
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_PARENT_PID: String(process.pid),
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-resume-hooks-proof-${process.pid}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanup.daemon = daemon;
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { const probe = new SessionClient({ socketPath }); const r = await probe.request('health'); probe.close(); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`daemon never answered: ${stderr}`);
    await sleep(50);
  }
  const client = new SessionClient({ socketPath });
  cleanup.client = client;
  const childEnv = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMFILES', 'ProgramData', 'CLAUDE_CONFIG_DIR']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const claudeSession = randomUUID();
  const transcript = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[:\\/]/g, '-'), `${claudeSession}.jsonl`);
  cleanup.transcriptDir = path.dirname(transcript);

  const readScreenOf = (paneId) => async (lines, source) => {
    const screen = await client.request('screen', { id: paneId, scrollback: lines });
    const text = String(source === 'visible' ? screen.visible : screen.text).split('\n');
    while (text.length && !text.at(-1).trim()) text.pop();
    return text.slice(-lines).join('\n');
  };
  const until = async (fn, ms, what) => {
    const t = Date.now() + ms;
    while (Date.now() < t) { const v = await fn(); if (v) return v; await sleep(400); }
    throw new Error(what);
  };

  // ---- Phase 1: a real session with one turn in it, then killed dead ----------
  const first = await client.request('spawn', {
    argv: [CLAUDE, '--session-id', claudeSession, '--model', 'haiku', '--effort', 'low', '--permission-mode', 'bypassPermissions'],
    cwd, env: childEnv, cols: 120, rows: 60,
  });
  cleanup.paneIds.push(first.id);
  console.log(`phase 1: spawned pane ${first.id}, claude session ${claudeSession}`);
  const readFirst = readScreenOf(first.id);
  await until(async () => { const s = await readFirst(200, 'visible'); return /[❯>]/u.test(s) && !/Loading/u.test(s) && !HOOKS_RE.test(s) ? s : null; }, 60_000, 'phase 1: composer never came up');
  await client.request('input', { id: first.id, text: '\x1b[200~Reply with exactly the word: ok\x1b[201~' });
  await sleep(300);
  await client.request('input', { id: first.id, text: '\r' });
  await until(async () => transcriptRecords(transcript).some((r) => r.type === 'assistant' && textOf(r).trim()) ? true : null, 90_000, 'phase 1: no assistant reply reached the transcript');
  console.log('phase 1: first turn recorded; killing the session');
  await client.request('terminate', { id: first.id, signal: 'SIGKILL' });
  await until(async () => {
    const list = await client.request('list');
    const row = (list.sessions || []).find((s) => s.id === first.id);
    return !row || row.exit ? true : null;
  }, 20_000, 'phase 1: the killed pane never recorded its exit');
  cleanup.paneIds = [];

  // ---- Phase 2: resume it exactly as bin/claude-sessions does, then send ------
  const spawnedAt = Date.now();
  const second = await client.request('spawn', {
    argv: [CLAUDE, '--dangerously-skip-permissions', '--resume', claudeSession],
    cwd, env: childEnv, cols: 120, rows: 60,
  });
  cleanup.paneIds.push(second.id);
  const paneId = second.id;
  const readScreen = readScreenOf(paneId);
  console.log(`phase 2: resumed as pane ${paneId}`);

  // Sample the screen so the report can say WHEN the hooks spinner was up.
  const samples = [];
  let firstHooksFrame = null;
  cleanup.sampler = setInterval(async () => {
    try {
      const s = await readScreen(60, 'visible');
      const hooks = HOOKS_RE.test(s);
      if (hooks && !firstHooksFrame) firstHooksFrame = s;
      samples.push({ t: Date.now() - spawnedAt, hooks, composer: /❯/.test(s), esc: /esc to interrupt/i.test(s) });
    } catch { /* pane gone */ }
  }, 200);

  const send = createSessionSend({
    snapshot: async () => ({ panes: [{ pane_id: paneId, workspace_id: 'ws', agent_session: { kind: 'id', value: claudeSession } }], workspaces: [{ workspace_id: 'ws', label: 'proof' }] }),
    readPane: async (_id, lines, source) => readScreen(lines, source),
    terminalBridge: {
      getState: () => ({ controlledPaneId: paneId }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_id, text) => { client.request('input', { id: paneId, text }).catch(() => {}); return { ok: true }; },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: { resumeSession: async () => {} },
    getSessionMeta: async () => ({ cwd }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'proof',
    sleep,
    setXClipboardImage: async () => {},
    captureDir: path.join(store, 'unrecognized-dialogs'),
    sendLogFile: path.join(store, 'send-log.jsonl'),
  });

  // The exact call actions/takeover.js makes after a resume.
  const ready = await send.waitForResumedClaudeReady(paneId, 'ws');
  const readyAt = Date.now() - spawnedAt;
  const atReady = await readScreen(60, 'visible');
  console.log(`phase 2: waitForResumedClaudeReady -> ${ready} after ${readyAt}ms; hooks spinner on screen at that moment: ${HOOKS_RE.test(atReady)}`);
  if (!ready) throw new Error('resumed session never became ready');

  const marker = `second-${randomUUID().slice(0, 8)}`;
  const result = await send.send({ sessionId: claudeSession, text: `Reply with exactly the word: ${marker}`, pane: { paneId, workspaceId: 'ws' } });
  const sentAt = Date.now() - spawnedAt;
  console.log(`phase 2: send() -> ${JSON.stringify(result)} at ${sentAt}ms`);

  let landed = false;
  try {
    await until(async () => transcriptRecords(transcript).some((r) => r.type === 'user' && !r.isMeta && textOf(r).includes(marker)) ? true : null, 30_000, 'not landed');
    landed = true;
  } catch { landed = false; }
  clearInterval(cleanup.sampler); cleanup.sampler = null;

  const hooksSamples = samples.filter((s) => s.hooks);
  const hooksWindow = hooksSamples.length ? `${hooksSamples[0].t}ms..${hooksSamples.at(-1).t}ms (${hooksSamples.length} samples)` : 'never seen';
  const composerDuringHooks = hooksSamples.some((s) => s.composer);
  console.log(`hooks spinner visible: ${hooksWindow}; composer drawn while hooks ran: ${composerDuringHooks}; "esc to interrupt" during hooks: ${hooksSamples.some((s) => s.esc)}`);
  if (firstHooksFrame) console.log(`first hooks frame (tail):\n${firstHooksFrame.split('\n').slice(-8).join('\n')}`);
  console.log(`message landed in the transcript: ${landed}`);
  console.log(landed ? 'PROOF OK' : 'PROOF FAILED: the message Harbor reported as sent never reached the transcript');
  return landed;
}

main()
  .then(async (ok) => { await teardown(); process.exit(ok ? 0 : 1); })
  .catch(async (error) => { console.error('ERR', error.stack || error); await teardown(); process.exit(1); });
