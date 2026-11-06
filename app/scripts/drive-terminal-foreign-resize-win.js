#!/usr/bin/env node
'use strict';

// LIVE PROOF that an open >_ view keeps its size, and comes back clean, when
// another Harbor process resizes its pane. Real CLI, ISOLATED daemon (relocated
// store, its own cwd, never the user's daemon), the REAL terminal bridge twice
// over: one as the desktop app (heals), one as the phone server (does not).
//
// Live-caught 2026-11-06 (Pat: "look at the scrambled lettering"): his >_ view
// of a working session filled with stray letters and later lines written over
// earlier ones. The view was 154x35; the phone server's own bridge had grown
// the pane to 120x60 for dialogs, because only the desktop process knew the
// view was open. Two fixes, both proven here:
//   1. the daemon refuses a `purpose: 'dialog'` resize while any client
//      observes the pane (daemon.js), so the phone-side sizing waits;
//   2. the desktop bridge notices any other resize of a pane it shows raw and
//      puts the view's size back, then repaints the view from history
//      (terminal-bridge.js healForeignResize).
// PROOF OK when the dialog resize is refused with the size unchanged, a raw
// foreign resize is undone within seconds, and afterwards the modeled view
// (fed exactly as XtermPane is: reset, backfill, frames) matches the
// session's own screen line for line. At the pre-fix bridge
// (HARBOR_DRIVE_BRIDGE_MODULE=<old terminal-bridge.js>) step 2 never heals.
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/drive-terminal-foreign-resize-win.js
// Needs a signed-in claude; costs one tiny haiku turn. The probe session's
// transcript is deleted afterwards so it never reaches the rail.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');
const { ScreenModel } = require('../src/daemon/screen.js');
const { claudeProjectDir } = require('../src/main/session-send.js');

const BRIDGE_MODULE = process.env.HARBOR_DRIVE_BRIDGE_MODULE
  ? path.resolve(process.env.HARBOR_DRIVE_BRIDGE_MODULE)
  : path.join(__dirname, '../src/main/terminal-bridge.js');
const { createTerminalBridge } = require(BRIDGE_MODULE);

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE
  || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-foreign-resize-proof-'));
const cwd = fs.mkdtempSync(path.join(tmp, 'harbor-foreign-resize-cwd-'));
const socketPath = path.join(store, 'daemon.sock');
const VIEW = { cols: 154, rows: 35 }; // Pat's >_ view that night
const FOREIGN = { cols: 120, rows: 60 }; // the dialog geometry

const cleanup = { client: null, daemon: null, paneId: null, bridges: [], transcriptDir: null };
async function teardown() {
  const { client, daemon, paneId, bridges, transcriptDir } = cleanup;
  for (const bridge of bridges) { try { bridge.close(); } catch { /* closing */ } }
  if (client && paneId) { try { await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ } }
  await sleep(1500);
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

const lines = (text) => String(text || '').split('\n').map((line) => line.trimEnd());
function differingLines(a, b) {
  const left = lines(a);
  const right = lines(b);
  let count = 0;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) if ((left[i] || '') !== (right[i] || '')) count += 1;
  return count;
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
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-foreign-resize-proof-${process.pid}`,
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
  const client = new SessionClient({ socketPath, requestTimeoutMs: 30_000 });
  cleanup.client = client;
  const childEnv = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMFILES', 'ProgramData', 'CLAUDE_CONFIG_DIR']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const claudeSession = randomUUID();
  // No --settings pin: this runs the machine's own Claude settings, the ones
  // Pat's view scrambled under.
  const spawned = await client.request('spawn', {
    argv: [CLAUDE, '--session-id', claudeSession, '--model', 'haiku', '--effort', 'low', '--dangerously-skip-permissions'],
    cwd, env: childEnv, cols: VIEW.cols, rows: VIEW.rows,
  });
  const paneId = spawned.id;
  cleanup.paneId = paneId;
  cleanup.transcriptDir = path.dirname(path.join(claudeProjectDir(cwd), `${claudeSession}.jsonl`));
  console.log(`spawned pane ${paneId} at ${VIEW.cols}x${VIEW.rows}, bridge ${BRIDGE_MODULE}`);

  const screen = async () => (await client.request('screen', { id: paneId })).visible;
  const size = async () => {
    const listed = await client.request('list');
    const session = (listed.sessions || listed).find((item) => item.id === paneId);
    return `${session.cols}x${session.rows}`;
  };
  const until = async (probe, ms, what) => {
    const t = Date.now() + ms;
    while (Date.now() < t) { const v = await probe().catch(() => null); if (v) return v; await sleep(300); }
    throw new Error(`${what}\n--- screen ---\n${await screen().catch((error) => error.message)}`);
  };
  const settle = async (ms) => {
    let prev = null; let since = Date.now(); const t = Date.now() + ms;
    while (Date.now() < t) {
      const v = await screen();
      if (v !== prev) { prev = v; since = Date.now(); } else if (Date.now() - since > 2500 && !/esc to interrupt/i.test(v)) return v;
      await sleep(250);
    }
    return prev;
  };

  // A fresh temp cwd opens on the folder-trust dialog with "No, exit"
  // highlighted; answer it before anything types an Enter.
  await until(async () => { const s = await screen(); return /trust this folder|❯/u.test(s) && !/Loading/u.test(s) ? s : null; }, 60_000, 'nothing came up');
  if (/trust this folder/u.test(await screen())) {
    // Enter only once "Yes" is the highlighted row: an arrow sent before the
    // dialog is interactive is dropped, and Enter would then pick "No, exit".
    await until(async () => {
      if (/❯\s*(?:\d\.\s*)?Yes, I trust this folder/u.test(await screen())) return true;
      await client.request('input', { id: paneId, text: '\x1b[B' });
      await sleep(400);
      return /❯\s*(?:\d\.\s*)?Yes, I trust this folder/u.test(await screen());
    }, 20_000, 'the trust dialog never highlighted Yes');
    await client.request('input', { id: paneId, text: '\r' });
  }
  await until(async () => { const s = await screen(); return /❯/u.test(s) && !/trust this folder|Loading/u.test(s); }, 60_000, 'composer never came up');
  await sleep(1500);
  await client.request('input', { id: paneId, text: 'Print Line 1 to Line 50, one per line, nothing else.' });
  await sleep(800);
  await client.request('input', { id: paneId, text: '\r' });
  await settle(90_000);

  const env = { ...process.env, HARBOR_SESSION_BACKEND: 'sessiond', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath };
  const desktop = createTerminalBridge({ sessionSocketPath: socketPath, sessionStorePolicy: { allowed: true }, env });
  const phone = createTerminalBridge({ sessionSocketPath: socketPath, sessionStorePolicy: { allowed: true }, env, healForeignResize: false });
  for (const bridge of [desktop, phone]) { bridge.emitter.on('error', () => {}); cleanup.bridges.push(bridge); await bridge.start(); }

  // The desktop's >_ view, fed exactly as XtermPane is.
  let view = new ScreenModel(VIEW);
  desktop.emitter.on('reset', ({ paneId: id }) => { if (id === paneId) view = new ScreenModel(VIEW); });
  desktop.emitter.on('backfill', ({ paneId: id, text }) => { if (id === paneId && text) view.write(text); });
  desktop.emitter.on('frame', ({ paneId: id, data }) => { if (id === paneId && data) view.write(Buffer.from(data, 'base64').toString('utf8')); });
  let healed = 0;
  desktop.emitter.on('view-resized-back', ({ paneId: id }) => { if (id === paneId) healed += 1; });
  await desktop.setVisiblePanes([{ paneId, ...VIEW }]);
  await sleep(3000);
  console.log(`baseline: view vs session differ on ${differingLines((await view.read()).visible, await screen())} line(s)`);

  // 1. The phone server sizes the pane for dialogs while the desktop shows it raw.
  const dialog = await phone.ensureDialogSize(paneId);
  await sleep(1500);
  const afterDialog = await size();
  const dialogRefused = dialog.ok === false && afterDialog === `${VIEW.cols}x${VIEW.rows}`;
  console.log(`1. phone-side dialog sizing: ${JSON.stringify(dialog)}; pane is ${afterDialog}`);

  // 2. Any other resize (an older daemon, a tool): the view must take its size back.
  await client.request('resize', { id: paneId, ...FOREIGN });
  await client.request('input', { id: paneId, text: 'typing while the sizes disagree' });
  await sleep(700);
  const mismatched = differingLines((await view.read()).visible, await screen());
  console.log(`2. foreign resize to ${FOREIGN.cols}x${FOREIGN.rows}: view vs session differ on ${mismatched} line(s) before the heal`);
  let restored = false;
  try {
    await until(async () => (await size()) === `${VIEW.cols}x${VIEW.rows}`, 15_000, 'the pane never went back to the view size');
    restored = true;
  } catch (error) { console.log(error.message.split('\n')[0]); }

  // 3. After the heal, typing redraws and the view matches the session.
  await client.request('input', { id: paneId, text: ' and after' });
  await sleep(2500);
  const viewText = (await view.read()).visible;
  const sessionText = await screen();
  const diff = differingLines(viewText, sessionText);
  console.log(`3. after the heal (${healed} heal(s)): view vs session differ on ${diff} line(s)`);
  console.log(`--- the >_ view ---\n${viewText}\n--- the session's own screen ---\n${sessionText}`);

  if (dialogRefused && restored && diff === 0) {
    console.log('PROOF OK: the dialog sizing waited, the foreign resize was undone, and the view matches the session');
  } else {
    console.log(`PROOF FAILED: dialog ${dialogRefused ? 'refused' : 'APPLIED'}, size ${restored ? 'restored' : 'NOT RESTORED'}, view ${diff === 0 ? 'matches' : `differs on ${diff} line(s)`}`);
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error('DRIVE FAILED', error); process.exitCode = 1; }).finally(teardown);
