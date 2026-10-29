#!/usr/bin/env node
'use strict';

// LIVE PROOF that a Harbor send into a Codex pane is actually SUBMITTED, against
// the REAL installed Codex CLI in an ISOLATED daemon (relocated store, its own
// cwd) and a THROWAWAY CODEX_HOME holding only a copy of one seat's auth.
//
// Live-caught 2026-10-28 (Pat: "have to send like every message in terminal
// view"): three of five Codex sends (276, 360 and 649 characters) sat in Codex's
// prompt box unsubmitted until Pat opened the >_ terminal and pressed Enter,
// while Harbor reported "sent". Codex on Windows reads raw key events, so a
// paste arrives as a stream of keystrokes, and its paste-burst rule turns an
// Enter that lands within 120 ms of that stream into a newline. Harbor pressed
// Enter 160 ms after writing the paste and never looked again.
//
// Each scenario sends through createSessionSend's real deliver() and counts the
// submits Codex itself records (history.jsonl in the throwaway home, one line per
// submitted prompt). A send that Harbor reports as sent must be in history
// exactly once; one that is not submitted gets Enter from this drive (as Pat did)
// so the next scenario starts from an empty box.
//
// Then two image sends, one from the phone (no clipboard) and one from the
// desktop: each must reach Codex as an ATTACHED image (an image item in the
// session's rollout), not as a path for the model to read.
// Against pre-fix code the desktop scenario proves nothing: that code pressed
// Alt+V, Codex read the REAL system clipboard, and attached whatever image was
// on it (seen 2026-10-29). The fixed code never touches the clipboard for Codex.
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/drive-codex-send-win.js
//   HARBOR_DRIVE_SEND_MODULE=<path>   the same drive against another session-send.js
//   HARBOR_PROBE_CODEX_AUTH=<file>    auth.json to copy (default ~/.codex/auth.json)
//   HARBOR_PROBE_LOAD=<n>             n busy-loop workers while sending (default 4)
//   HARBOR_PROBE_CAPTURE=<dir>        save the screen after each send
// Costs one tiny gpt-6.1-sol turn (low effort) per scenario.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');
const harborBin = require('../../bin/harbor-bin.cjs');

const SEND_MODULE = process.env.HARBOR_DRIVE_SEND_MODULE
  ? path.resolve(process.env.HARBOR_DRIVE_SEND_MODULE)
  : path.join(__dirname, '../src/main/session-send.js');
const { createSessionSend, createLinkRegistry } = require(SEND_MODULE);

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CODEX = process.env.HARBOR_PROBE_CODEX || 'codex';
const AUTH = process.env.HARBOR_PROBE_CODEX_AUTH || path.join(os.homedir(), '.codex', 'auth.json');
const LOAD = Number(process.env.HARBOR_PROBE_LOAD ?? 4);
const CAPTURE = process.env.HARBOR_PROBE_CAPTURE || '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-codex-send-proof-'));
const cwd = fs.mkdtempSync(path.join(tmp, 'harbor-codex-send-cwd-'));
const codexHome = fs.mkdtempSync(path.join(tmp, 'harbor-codex-send-home-'));
const socketPath = path.join(store, 'daemon.sock');
const history = path.join(codexHome, 'history.jsonl');

// A 16x16 grey PNG, so the image scenarios have a real file to attach.
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
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0)),
  ]));
  return file;
}
const IMAGE = writeTinyPng(path.join(store, 'shot.png'));

// Every rollout record of this session that carries the marker and an image.
function attachedImage(marker) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) files.push(full);
    }
  };
  try { walk(path.join(codexHome, 'sessions')); } catch { return false; }
  return files.some((file) => fs.readFileSync(file, 'utf8').split('\n')
    .some((line) => line.includes(marker) && /"input_image"|"local_images":\["|"images":\["/.test(line)));
}

const words = 'the quick brown fox jumps over the lazy dog ';
const SCENARIOS = [
  { name: 'a short message (40 characters)', text: (m) => `Reply with just OK. ${m}` },
  { name: 'a 300-character line', text: (m) => `Reply with just OK. ${words.repeat(6)}${m}` },
  { name: 'a 700-character line', text: (m) => `Reply with just OK. ${words.repeat(15)}${m}` },
  { name: 'a pasted body with paragraphs', text: (m) => `Reply with just OK.\n\nThis body has paragraphs, like a real message. ${words.repeat(4)}\n\nAnd a last one. ${m}` },
  { name: 'a 2,000-character paste (Codex draws a placeholder)', text: (m) => `Reply with just OK. ${words.repeat(45)}${m}` },
  { name: 'a phone message with an image (no clipboard)', text: (m) => `Reply with just OK. ${m}`, image: true, phone: true },
  { name: 'a desktop message with an image', text: (m) => `Reply with just OK. ${m}`, image: true },
];

const cleanup = { client: null, daemon: null, paneId: null, workers: [] };
async function teardown() {
  for (const worker of cleanup.workers) { try { await worker.terminate(); } catch { /* gone */ } }
  const { client, daemon, paneId } = cleanup;
  if (client && paneId) { try { await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ } }
  if (client) client.close();
  if (daemon && daemon.exitCode === null) {
    daemon.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), sleep(5000)]);
  }
  await sleep(1000);
  for (const dir of [store, cwd, codexHome]) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* best effort */ }
  }
  console.log(`throwaway home removed: ${!fs.existsSync(codexHome)}`);
}

const submits = (marker) => {
  try { return fs.readFileSync(history, 'utf8').split('\n').filter((line) => line.includes(marker)).length; } catch { return 0; }
};

async function main() {
  console.log(`session-send under test: ${SEND_MODULE}`);
  fs.copyFileSync(AUTH, path.join(codexHome, 'auth.json'));
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_PARENT_PID: String(process.pid),
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-codex-send-proof-${process.pid}`,
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
  const childEnv = { CODEX_HOME: codexHome, TERM: 'xterm-256color' };
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMFILES', 'ProgramData']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  // The argv Harbor's bin/ai builds for a Codex pane, pins included.
  const version = harborBin.codexCliVersion(CODEX, childEnv);
  const controls = harborBin.codexPaneControls({ version, codexHome });
  const argv = harborBin.resolveWindowsLaunch(harborBin.withCodexPaneControls(
    [CODEX, '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=low'],
    controls,
  ), { env: childEnv });
  console.log(`codex ${version ? version.join('.') : 'unreadable'}; ${LOAD} load worker(s)`);
  const spawned = await client.request('spawn', { argv, cwd, env: childEnv, cols: 120, rows: 50 });
  const paneId = spawned.id;
  cleanup.paneId = paneId;

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
    const s = await readScreen(60, 'visible');
    return /^› /mu.test(s) && !/esc to interrupt/iu.test(s) ? s : null;
  }, 90_000, 'codex never came up idle');
  await idle();

  // Machine load, the condition every one of Pat's failed sends ran under.
  for (let i = 0; i < LOAD; i += 1) {
    cleanup.workers.push(new Worker('for (;;) { Math.sqrt(Math.random()); }', { eval: true }));
  }

  const written = [];
  const deps = {
    snapshot: async () => ({ panes: [{ pane_id: paneId, workspace_id: 'ws' }], workspaces: [{ workspace_id: 'ws', label: 'proof' }] }),
    readPane: async (_id, lines = 16, source) => readScreen(lines, source),
    readSuggestion: async () => null,
    terminalBridge: {
      getState: () => ({ controlledPaneId: paneId }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_id, text) => {
        written.push(text === '\r' ? '<Enter>' : `<${text.length} chars>`);
        client.request('input', { id: paneId, text }).catch(() => {});
        return { ok: true };
      },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: { resumeSession: async () => {} },
    getSessionMeta: async () => ({ cwd, provider: 'codex' }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'proof',
    sleep,
    captureDir: path.join(store, 'unrecognized-dialogs'),
    sendLogFile: path.join(store, 'send-log.jsonl'),
  };
  const clipped = [];
  const desktop = createSessionSend({ ...deps, setXClipboardImage: async (file) => { clipped.push(file); } });
  // The phone server: no clipboard to paste an image from.
  const phone = createSessionSend({ ...deps, setXClipboardImage: undefined });

  const failures = [];
  let index = 0;
  for (const scenario of SCENARIOS) {
    index += 1;
    const send = scenario.phone ? phone : desktop;
    const marker = `codex-proof-${randomUUID().slice(0, 8)}`;
    const errors = [];
    const onStatus = (status) => { if (status.phase === 'error') errors.push(status.detail); };
    send.emitter.on('status', onStatus);
    written.length = 0;
    let thrown = null;
    const t0 = Date.now();
    try {
      await send.send({ sessionId: `pane:${paneId}`, provider: 'codex', text: scenario.text(marker), images: scenario.image ? [IMAGE] : [], pane: { paneId, workspaceId: 'ws' } });
    } catch (error) { thrown = error; }
    const reported = Date.now() - t0;
    let took = 0;
    try { took = await until(async () => submits(marker), 15_000, 'not submitted'); } catch { took = 0; }
    const screenAfter = await readScreen(30, 'visible');
    if (CAPTURE) {
      fs.mkdirSync(CAPTURE, { recursive: true });
      fs.writeFileSync(path.join(CAPTURE, `${index}-after-send.txt`), `${scenario.name}\nsubmitted: ${took}\n\n${screenAfter}\n`);
    }
    let rescued = false;
    if (!took) {
      // What Pat did: open >_ and press Enter.
      await client.request('input', { id: paneId, text: '\r' });
      try { took = await until(async () => submits(marker), 10_000, 'still not submitted'); rescued = Boolean(took); } catch { /* reported */ }
    }
    try { await idle(); } catch (error) { failures.push(`${scenario.name}: ${error.message}`); }
    await sleep(800);
    const copies = submits(marker);
    send.emitter.off('status', onStatus);
    const outcome = thrown ? `REFUSED: ${thrown.message}` : (errors[0] ? `ERROR: ${errors[0]}` : `reported sent after ${(reported / 1000).toFixed(1)} s`);
    console.log(`\n${scenario.name}: ${outcome}`);
    console.log(`  keystrokes: ${written.join(' ')}`);
    console.log(`  submitted by Harbor: ${took && !rescued ? 'yes' : 'NO'}${rescued ? ' (it sat in the box until a manual Enter)' : ''}; copies in history: ${copies}`);
    if (thrown || errors.length) failures.push(`${scenario.name}: ${thrown ? thrown.message : errors[0]}`);
    else if (!took || rescued) failures.push(`${scenario.name}: Harbor said sent, but Codex did not submit it`);
    if (copies > 1) failures.push(`${scenario.name}: ${copies} copies submitted, expected 1`);
    if (scenario.image && took) {
      let attached = false;
      try { attached = await until(async () => attachedImage(marker), 10_000, 'no image record'); } catch { /* reported */ }
      console.log(`  image attached: ${attached}`);
      if (!attached) failures.push(`${scenario.name}: the image was not attached`);
    }
  }
  {
    // Both effort menus send /effort for every provider; Codex has none, and
    // its /model --reasoning=<level> is what changes it (footer: "GPT-6.1-Sol high").
    const name = 'an effort change from the menus (/effort high)';
    let thrown = null;
    try { await desktop.send({ sessionId: `pane:${paneId}`, provider: 'codex', text: '/effort high', pane: { paneId, workspaceId: 'ws' } }); } catch (error) { thrown = error; }
    const high = /GPT-[\w.-]+ high\b/i;
    let footer = '';
    try { footer = await until(async () => { const screen = await readScreen(8, 'visible'); return high.test(screen) ? screen : null; }, 10_000, 'effort unchanged'); } catch { footer = await readScreen(8, 'visible'); }
    const changed = high.test(footer);
    console.log(`\n${name}: ${thrown ? `REFUSED: ${thrown.message}` : 'reported sent'}`);
    console.log(`  effort now high: ${changed}${/Unrecognized command/i.test(footer) ? ' (Codex: Unrecognized command)' : ''}`);
    if (thrown || !changed) failures.push(`${name}: Codex's effort did not change`);
  }
  if (clipped.length) failures.push(`the clipboard was used for a Codex image (${clipped.length} time(s))`);

  if (failures.length) {
    console.log(`\nPROOF FAILED:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nPROOF OK: every Codex send Harbor reported as sent was submitted exactly once, short, long, multi-line and placeholder-sized, under machine load, the phone and desktop images arrived attached, and /effort from the effort menus changed the Codex effort');
  }
}

main()
  .catch((error) => { console.error(`PROOF ERROR: ${error.stack || error.message}`); process.exitCode = 1; })
  .finally(teardown);
