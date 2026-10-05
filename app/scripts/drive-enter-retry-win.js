#!/usr/bin/env node
'use strict';

// LIVE PROOF that a swallowed Enter no longer strands a message, against the
// REAL Claude Code CLI in an ISOLATED daemon (relocated store, its own cwd,
// never the user's daemon).
//
// Live-caught 2026-09-23: two image sends into a busy session left their text
// in Claude's composer and reported "could not confirm the message reached the
// session". A busy CLI can read Harbor's text and Enter in one read, and then
// the Enter is taken as text. That coalescing is the console's decision and
// cannot be forced from here, so this drive reproduces its RESULT exactly: the
// bridge drops the first Enter, leaving the message in the real composer just
// as the live failure did. Everything else is production code: createSessionSend
// reads the real screen, decides from the real composer box, presses Enter
// again, and confirmDelivery confirms against the real transcript.
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/drive-enter-retry-win.js
//   HARBOR_DRIVE_SEND_MODULE=<path> ... to run the same drive against another
//   copy of session-send.js (the pre-fix HEAD, for the two-sided proof).
// Needs a signed-in claude; costs three tiny haiku turns. The probe session's
// transcript is deleted afterwards so it never reaches the rail.
//
// Exit 0 with "PROOF OK" only when every scenario's message is in the CLI's own
// transcript and the Enter was pressed again exactly when it had been dropped.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');

const SEND_MODULE = process.env.HARBOR_DRIVE_SEND_MODULE
  ? path.resolve(process.env.HARBOR_DRIVE_SEND_MODULE)
  : path.join(__dirname, '../src/main/session-send.js');
const { createSessionSend, createLinkRegistry } = require(SEND_MODULE);

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE
  || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-enter-retry-proof-'));
const cwd = fs.mkdtempSync(path.join(tmp, 'harbor-enter-retry-cwd-'));
const socketPath = path.join(store, 'daemon.sock');
const sendLogFile = path.join(store, 'send-log.jsonl');

const SCENARIOS = [
  { name: 'control: Enter taken', dropFirstEnter: false, text: (m) => `Reply with just OK. ${m}` },
  { name: 'one line, first Enter dropped', dropFirstEnter: true, text: (m) => `Reply with just OK. ${m}` },
  { name: 'pasted body, first Enter dropped', dropFirstEnter: true, text: (m) => `Reply with just OK.\n\nThis body is pasted, like a message with paragraphs. ${m}` },
];

// Teardown runs on EVERY exit (see drive-ask-sheet-win.js for why): the store
// names a job namespace and the daemon watches this pid.
const cleanup = { client: null, daemon: null, paneId: null, transcriptDir: null };
async function teardown() {
  const { client, daemon, paneId, transcriptDir } = cleanup;
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
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-enter-retry-proof-${process.pid}`,
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
  const spawned = await client.request('spawn', {
    argv: [CLAUDE, '--session-id', claudeSession, '--model', 'haiku', '--effort', 'low', '--permission-mode', 'bypassPermissions'],
    cwd,
    env: childEnv,
    cols: 120,
    rows: 60,
  });
  const paneId = spawned.id;
  cleanup.paneId = paneId;
  const transcript = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[:\\/]/g, '-'), `${claudeSession}.jsonl`);
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

  let dropNextEnter = false;
  const written = [];
  const send = createSessionSend({
    snapshot: async () => ({ panes: [{ pane_id: paneId, workspace_id: 'ws' }], workspaces: [{ workspace_id: 'ws', label: 'proof' }] }),
    readPane: async (_id, lines = 16, source) => readScreen(lines, source),
    terminalBridge: {
      getState: () => ({ controlledPaneId: paneId }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_id, text) => {
        if (text === '\r' && dropNextEnter) {
          dropNextEnter = false;
          written.push('<Enter dropped>');
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
    const marker = `enter-proof-${randomUUID().slice(0, 8)}`;
    const errors = [];
    const onStatus = (status) => { if (status.phase === 'error') errors.push(status.detail); };
    send.emitter.on('status', onStatus);
    written.length = 0;
    dropNextEnter = scenario.dropFirstEnter;
    const retriesBefore = countRetries();
    await send.send({ sessionId: claudeSession, text: scenario.text(marker), pane: { paneId, workspaceId: 'ws' } });
    const copies = () => {
      try {
        return fs.readFileSync(transcript, 'utf8').split('\n').filter((line) => {
          if (!line.includes(marker)) return false;
          try { const record = JSON.parse(line); return record.type === 'user' && !record.isMeta; } catch { return false; }
        }).length;
      } catch { return 0; }
    };
    let landed = false;
    try {
      landed = Boolean(await until(async () => (errors.length ? 'error' : copies() > 0), 25_000, 'neither landed nor errored'));
    } catch { landed = false; }
    landed = landed && !errors.length;
    send.emitter.off('status', onStatus);
    await idle();
    await sleep(1500);
    const landedCopies = copies();
    const retries = countRetries() - retriesBefore;
    const composer = (await readScreen(8, 'visible')).split('\n').find((l) => /❯/u.test(l)) || '';
    console.log(`\n${scenario.name}: ${landed ? `LANDED in the transcript (${landedCopies} cop${landedCopies === 1 ? 'y' : 'ies'})` : `NOT LANDED${errors.length ? ` (${errors[0]})` : ''}`}`);
    console.log(`  keystrokes: ${written.join(' ')}`);
    console.log(`  enter-retry log records: ${retries}; composer now: ${JSON.stringify(composer.trim())}`);
    if (!landed) failures.push(`${scenario.name}: message never reached the transcript`);
    if (landed && landedCopies !== 1) failures.push(`${scenario.name}: ${landedCopies} copies of one message landed`);
    if (scenario.dropFirstEnter && retries < 1) failures.push(`${scenario.name}: the dropped Enter was never pressed again`);
  }

  if (failures.length) {
    console.log(`\nPROOF FAILED:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPROOF OK: a dropped Enter is pressed again from the real composer, a taken one never is');
  }

  function countRetries() {
    try {
      return fs.readFileSync(sendLogFile, 'utf8').split('\n').filter((line) => line.includes('"enter-retry"')).length;
    } catch { return 0; }
  }
}

main()
  .catch((error) => { console.error(`PROOF ERROR: ${error.stack || error.message}`); process.exitCode = 1; })
  .finally(teardown);
