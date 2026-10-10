#!/usr/bin/env node
'use strict';

// LIVE PROOF that Harbor presses Enter only once Claude's prompt shows the
// message, against the REAL Claude Code CLI in an ISOLATED daemon (relocated
// store, its own cwd, never the user's daemon).
//
// Live-caught 2026-10-09: for 45 minutes one session's prompt took none of
// Harbor's keystrokes while its Claude was alive and idle. Harbor typed, pressed
// Enter blind, and reported "sent"; the messages were never submitted (Claude's
// own prompt history never recorded them). The trigger inside the CLI is not
// reproducible on demand, so this drive reproduces its RESULT exactly: the
// bridge drops the typed text, leaving the real prompt empty, just as Pat's was.
// Everything else is production code reading the real screen.
//
// Scenarios:
//   control, a 1,600-character single line (drawn by the CLI as "[Pasted text
//   #1]"), and a pasted multi-line body: each must land in the CLI's own
//   transcript exactly once through the new check.
//   a prompt that never takes the text: no Enter may reach the pane, the send
//   must fail with the honest error, and nothing may reach the transcript.
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/drive-prompt-gate-win.js
//   HARBOR_DRIVE_SEND_MODULE=<path> ... runs the same drive against another copy
//   of session-send.js (the pre-fix HEAD, for the two-sided proof).
// Needs a signed-in claude; costs three tiny haiku turns. The probe session's
// transcript is deleted afterwards so it never reaches the rail.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');
const { claudeProjectDir } = require('../src/main/session-send.js');

const SEND_MODULE = process.env.HARBOR_DRIVE_SEND_MODULE
  ? path.resolve(process.env.HARBOR_DRIVE_SEND_MODULE)
  : path.join(__dirname, '../src/main/session-send.js');
const { createSessionSend, createLinkRegistry } = require(SEND_MODULE);

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE
  || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-prompt-gate-proof-'));
const cwd = fs.mkdtempSync(path.join(tmp, 'harbor-prompt-gate-cwd-'));
const socketPath = path.join(store, 'daemon.sock');
const sendLogFile = path.join(store, 'send-log.jsonl');

const words = 'the quick brown fox jumps over the lazy dog ';
const SCENARIOS = [
  { name: 'control: a short message', text: (m) => `Reply with just OK. ${m}` },
  { name: 'a 1,600-character single line', text: (m) => `Reply with just OK. ${words.repeat(36)}${m}` },
  { name: 'a pasted multi-line body', text: (m) => `Reply with just OK.\n\nThis body is pasted, like a message with paragraphs. ${m}` },
  { name: 'a prompt that never takes the text', text: (m) => `Reply with just OK. ${m}`, dropText: true },
];

const cleanup = { client: null, daemon: null, paneId: null, transcriptDir: null, sessionId: null };
async function teardown() {
  const { client, daemon, paneId, transcriptDir, sessionId } = cleanup;
  if (client && paneId) { try { await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ } }
  if (client) client.close();
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), sleep(5000)]);
  }
  await sleep(500);
  for (const dir of [store, cwd, transcriptDir].filter(Boolean)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort */ }
  }
  if (sessionId) {
    for (const name of [`${sessionId}.json`, `${sessionId}.learned.json`]) {
      try { fs.rmSync(path.join(os.homedir(), '.cache/harbor/context', name), { force: true }); } catch { /* best effort */ }
    }
  }
}

async function main() {
  console.log(`session-send under test: ${SEND_MODULE}`);
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_PARENT_PID: String(process.pid),
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-prompt-gate-proof-${process.pid}`,
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
  cleanup.sessionId = claudeSession;
  const spawned = await client.request('spawn', {
    argv: [CLAUDE, '--session-id', claudeSession, '--model', 'haiku', '--effort', 'low', '--permission-mode', 'bypassPermissions'],
    cwd,
    env: childEnv,
    cols: 120,
    rows: 60,
  });
  const paneId = spawned.id;
  cleanup.paneId = paneId;
  const transcript = path.join(claudeProjectDir(cwd), `${claudeSession}.jsonl`);
  cleanup.transcriptDir = path.dirname(transcript);
  console.log(`spawned pane ${paneId}, claude session ${claudeSession}`);

  const readScreen = async (lines, source) => {
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
  const idle = async () => until(async () => {
    const s = await readScreen(200, 'visible');
    return /❯/u.test(s) && !/Loading|esc to interrupt/iu.test(s) ? s : null;
  }, 60_000, 'composer never came up idle');
  await idle();

  let dropText = false;
  const written = [];
  const send = createSessionSend({
    snapshot: async () => ({ panes: [{ pane_id: paneId, workspace_id: 'ws' }], workspaces: [{ workspace_id: 'ws', label: 'proof' }] }),
    readPane: async (_id, lines = 16, source) => readScreen(lines, source),
    // Production reads Claude's dim suggested prompt from the keeper's cells.
    readSuggestion: async () => (await client.request('screen', { id: paneId, scrollback: 0 })).suggestion || null,
    terminalBridge: {
      getState: () => ({ controlledPaneId: paneId }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_id, text) => {
        if (text !== '\r' && dropText) {
          written.push('<text dropped>');
          return { ok: true };
        }
        written.push(text === '\r' ? '<Enter>' : `<${text.length} chars>`);
        client.request('input', { id: paneId, text }).catch(() => {});
        return { ok: true };
      },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: { resumeSession: async () => {} },
    getSessionMeta: async () => ({ cwd, path: transcript }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'proof',
    sleep,
    setXClipboardImage: async () => {},
    captureDir: path.join(store, 'unrecognized-dialogs'),
    sendLogFile,
  });

  const failures = [];
  for (const scenario of SCENARIOS) {
    const marker = `gate-proof-${randomUUID().slice(0, 8)}`;
    const errors = [];
    const onStatus = (status) => { if (status.phase === 'error') errors.push(status.detail); };
    send.emitter.on('status', onStatus);
    written.length = 0;
    dropText = Boolean(scenario.dropText);
    let thrown = null;
    try {
      await send.send({ sessionId: claudeSession, text: scenario.text(marker), pane: { paneId, workspaceId: 'ws' } });
    } catch (error) { thrown = error; }
    dropText = false;
    const copies = () => {
      try {
        return fs.readFileSync(transcript, 'utf8').split('\n').filter((line) => {
          if (!line.includes(marker)) return false;
          try { const record = JSON.parse(line); return record.type === 'user' && !record.isMeta; } catch { return false; }
        }).length;
      } catch { return 0; }
    };
    let landed = 0;
    if (scenario.dropText) {
      await sleep(6000);
      landed = copies();
    } else {
      try { await until(async () => (errors.length ? 'error' : copies() > 0), 30_000, 'neither landed nor errored'); } catch { /* reported below */ }
      await idle();
      await sleep(1500);
      landed = copies();
    }
    send.emitter.off('status', onStatus);
    const enters = written.filter((key) => key === '<Enter>').length;
    const outcome = thrown ? `REFUSED: ${thrown.message}` : (errors[0] ? `ERROR: ${errors[0]}` : 'reported sent');
    console.log(`\n${scenario.name}: ${outcome}`);
    console.log(`  keystrokes: ${written.join(' ')}`);
    console.log(`  copies in the transcript: ${landed}`);
    if (scenario.dropText) {
      if (enters > 0) failures.push(`${scenario.name}: Enter was pressed into a prompt that never showed the text`);
      if (!thrown || thrown.code !== 'PROMPT_NEVER_HELD') failures.push(`${scenario.name}: the send was not refused honestly`);
      if (landed) failures.push(`${scenario.name}: something reached the transcript`);
    } else {
      if (thrown || errors.length) failures.push(`${scenario.name}: ${thrown ? thrown.message : errors[0]}`);
      if (landed !== 1) failures.push(`${scenario.name}: ${landed} copies landed, expected exactly 1`);
    }
  }

  if (failures.length) {
    console.log(`\nPROOF FAILED:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPROOF OK: every message the prompt showed landed once, and a prompt that never showed it got no Enter and an honest refusal');
  }
}

main()
  .catch((error) => { console.error(`PROOF ERROR: ${error.stack || error.message}`); process.exitCode = 1; })
  .finally(teardown);
