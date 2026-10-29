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
//   a starting Claude (2026-10-10): the FIRST message into a pane reaches the
//   CLI 20 seconds late, as Claude's startup buffer delivered Pat's 6,299
//   character message into a new cdt-app session. It must land once; the
//   pre-fix code gave up at 7.5 s, said nothing was sent, and left the text to
//   show up in the prompt afterwards.
//   control, a 1,600-character single line (drawn by the CLI as "[Pasted text
//   #1]"), and a pasted multi-line body: each must land in the CLI's own
//   transcript exactly once through the new check.
//   a prompt that never takes the text: no Enter may reach the pane, the send
//   must fail with the honest error, and nothing may reach the transcript.
//   a short phone message with an image (2026-10-14): harbor-server has no
//   clipboard, so it types the upload's path on an "Image:" line, and the CLI
//   (2.1.299) draws that path as an [Image #N] chip. "FYI" plus a screenshot
//   was refused after three minutes because the check still wanted the path.
//   It must land once, with the image attached. Last, because the pre-fix code
//   leaves it sitting in the prompt. 2.1.311 stopped attaching a path that
//   shares its line with "Image:", so it now goes quoted on a line of its own
//   (2026-10-28), and the image must arrive ATTACHED, not as a path to Read.
//   then a /model switch in the now-cached conversation (2026-10-28, 2.1.312):
//   Claude asks "Switch model?" and Harbor must answer it; 2.1.312 reworded
//   the dialog and the pre-fix match left it open. The target is
//   claude-opus-5-5, the model every config home already pins, so the switch
//   the CLI saves changes nothing on disk.
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/drive-prompt-gate-win.js
//   HARBOR_DRIVE_SEND_MODULE=<path> ... runs the same drive against another copy
//   of session-send.js (the pre-fix HEAD, for the two-sided proof).
// Needs a signed-in claude; costs five tiny haiku turns. The probe session's
// transcript is deleted afterwards so it never reaches the rail.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
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
// Outside the session's folder, like the phone server's upload directory.
const uploads = fs.mkdtempSync(path.join(tmp, 'harbor-prompt-gate-upload-'));
const socketPath = path.join(store, 'daemon.sock');

// A 16x16 grey PNG, so the phone scenario has a real image file to attach.
function writeTinyPng(file) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const size = 16;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0)),
  ]));
  return file;
}
const PHONE_IMAGE = writeTinyPng(path.join(uploads, 'phone-shot.png'));
const sendLogFile = path.join(store, 'send-log.jsonl');

const words = 'the quick brown fox jumps over the lazy dog ';
const SCENARIOS = [
  // First on purpose: only a pane that has never taken a message gets the long wait.
  { name: 'a starting Claude that shows the typing 20 s late', text: (m) => `Reply with just OK.\n\nThis first message reached Claude late. ${m}`, delayTextMs: 20_000 },
  { name: 'control: a short message', text: (m) => `Reply with just OK. ${m}` },
  { name: 'a 1,600-character single line', text: (m) => `Reply with just OK. ${words.repeat(36)}${m}` },
  { name: 'a pasted multi-line body', text: (m) => `Reply with just OK.\n\nThis body is pasted, like a message with paragraphs. ${m}` },
  { name: 'a prompt that never takes the text', text: (m) => `Reply with just OK. ${m}`, dropText: true },
  // Shorter than the 24 characters the check compares, as "FYI" was.
  { name: 'a short phone message with an image (its path typed, no clipboard)', text: (m) => `FYI ${m}`, phoneImage: true },
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
  for (const dir of [store, cwd, uploads, transcriptDir].filter(Boolean)) {
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

  let sawSwitchDialog = false;
  const readScreen = async (lines, source) => {
    const screen = await client.request('screen', { id: paneId, scrollback: lines });
    if (/Switch model\?/.test(String(screen.visible || '') + String(screen.text || ''))) sawSwitchDialog = true;
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
  let delayTextMs = 0;
  const written = [];
  const deps = {
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
        if (text !== '\r' && delayTextMs) {
          written.push(`<${text.length} chars, ${delayTextMs / 1000}s late>`);
          setTimeout(() => client.request('input', { id: paneId, text }).catch(() => {}), delayTextMs);
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
  };
  const desktop = createSessionSend(deps);
  // The phone server: its own process, and no clipboard to paste an image from.
  const phone = createSessionSend({ ...deps, setXClipboardImage: undefined });

  const failures = [];
  for (const scenario of SCENARIOS) {
    const send = scenario.phoneImage ? phone : desktop;
    const marker = `gate-proof-${randomUUID().slice(0, 8)}`;
    const errors = [];
    const onStatus = (status) => { if (status.phase === 'error') errors.push(status.detail); };
    send.emitter.on('status', onStatus);
    written.length = 0;
    dropText = Boolean(scenario.dropText);
    delayTextMs = scenario.delayTextMs || 0;
    let thrown = null;
    try {
      await send.send({
        sessionId: claudeSession,
        text: scenario.text(marker),
        images: scenario.phoneImage ? [PHONE_IMAGE] : [],
        pane: { paneId, workspaceId: 'ws' },
      });
    } catch (error) { thrown = error; }
    dropText = false;
    delayTextMs = 0;
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
      // The pre-fix code refuses and the late text still shows up afterwards;
      // say so, since that text sitting in the prompt was Pat's whole report.
      if (scenario.delayTextMs && errors.length) {
        await sleep(scenario.delayTextMs);
        console.log(`  prompt afterwards: ${(await readScreen(8, 'visible')).split('\n').filter((l) => /^\s*❯/.test(l)).pop() || '(no prompt line)'}`);
      }
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
    if (scenario.phoneImage && landed) {
      const record = fs.readFileSync(transcript, 'utf8').split('\n')
        .filter((line) => line.includes(marker))
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .find((entry) => entry?.type === 'user' && !entry.isMeta);
      // A message with no attachment is stored as a plain string, not blocks.
      const raw = record?.message?.content;
      const content = Array.isArray(raw) ? raw : [{ type: 'text', text: String(raw || '') }];
      const text = content.filter((block) => block.type === 'text').map((block) => block.text).join(' ');
      const attached = content.some((block) => block.type === 'image');
      console.log(`  Claude received: ${JSON.stringify(text.slice(0, 80))}, image attached: ${attached}`);
      if (!attached) failures.push(`${scenario.name}: the image was not attached${text.includes(PHONE_IMAGE) ? ' (it reached Claude only as a path to Read)' : ''}`);
    }
  }

  {
    const name = 'a /model switch in the cached conversation';
    written.length = 0;
    sawSwitchDialog = false;
    let thrown = null;
    try {
      await desktop.send({ sessionId: claudeSession, text: '/model claude-opus-5-5', pane: { paneId, workspaceId: 'ws' } });
    } catch (error) { thrown = error; }
    await sleep(3000);
    const after = await readScreen(60, 'visible');
    const stillOpen = /Switch model\?/.test(after);
    const set = /Set model to|model to Opus/i.test(after);
    console.log(`\n${name}: ${thrown ? `REFUSED: ${thrown.message}` : 'reported sent'}`);
    console.log(`  keystrokes: ${written.join(' ')}`);
    console.log(`  dialog seen: ${sawSwitchDialog}, still open: ${stillOpen}, model set: ${set}`);
    if (!sawSwitchDialog) failures.push(`${name}: no "Switch model?" dialog appeared, so nothing was proven`);
    else if (thrown || stillOpen || !set) failures.push(`${name}: Harbor did not answer the dialog`);
  }

  if (failures.length) {
    console.log(`\nPROOF FAILED:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPROOF OK: every message the prompt showed landed once (one shown 20 s late included), a prompt that never showed it got no Enter and an honest refusal, the phone image arrived attached, and the /model cache warning was answered');
  }
}

main()
  .catch((error) => { console.error(`PROOF ERROR: ${error.stack || error.message}`); process.exitCode = 1; })
  .finally(teardown);
