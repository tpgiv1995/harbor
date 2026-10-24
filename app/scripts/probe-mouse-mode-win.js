#!/usr/bin/env node
'use strict';

// PROBE (2026-10-24): which stimulus makes Claude Code 2.1.303 re-send its
// mouse-reporting switches (ESC[?1000h ... ESC[?1006h) with /mcp open? A >_ view
// is a FRESH xterm: it only forwards clicks once those switches reach it in a
// frame. Real CLI, isolated daemon, the raw observer stream (no bridge, so no
// view-open key), one stimulus at a time.
// Usage (from app/): ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/probe-mouse-mode-win.js

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');
const { createStreamSupervisor } = require('../src/main/session-daemon/factory.js');

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CLAUDE = path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const HOME_DIR = process.env.HARBOR_PROBE_HOME || path.join(os.homedir(), '.claude');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-mouse-mode-probe-'));
const socketPath = path.join(store, 'daemon.sock');
const MODES = /\x1b\[\?(?:1000|1002|1003|1006|1004|1049|2004|25)[hl]/g;

(async () => {
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, stdio: 'ignore', env: { ...process.env, HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-mouse-probe-${process.pid}` } });
  for (let i = 0; i < 100; i += 1) { try { const p = new SessionClient({ socketPath }); const r = await p.request('health'); p.close(); if (r.ok) break; } catch { /* not yet */ } await sleep(100); }
  const client = new SessionClient({ socketPath, requestTimeoutMs: 30000 });
  const env = { CLAUDE_CONFIG_DIR: HOME_DIR, TERM: 'xterm-256color' };
  for (const k of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMFILES', 'ProgramData']) if (process.env[k]) env[k] = process.env[k];
  const { id: paneId } = await client.request('spawn', { argv: [CLAUDE, '--session-id', randomUUID(), '--model', 'haiku', '--effort', 'low'], cwd: os.homedir(), env, cols: 120, rows: 60, agent: 'claude' });
  const screen = async () => (await client.request('screen', { id: paneId })).visible;
  try {
    for (let i = 0; i < 300 && !/❯/u.test(await screen()); i += 1) await sleep(300);
    await sleep(2500);
    await client.request('input', { id: paneId, text: '/mcp ' });
    await sleep(200);
    await client.request('input', { id: paneId, text: '\r' });
    for (let i = 0; i < 100 && !/Manage MCP servers/.test(await screen()); i += 1) await sleep(300);
    await sleep(1500);
    const supervisor = createStreamSupervisor({ sessionSocketPath: socketPath, sessionStorePolicy: { allowed: true }, env: { ...process.env, HARBOR_SESSION_BACKEND: 'sessiond', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath } });
    let seen = [];
    supervisor.on('frame', ({ paneId: id, bytes }) => { if (id === paneId) seen.push(...(bytes.toString('utf8').match(MODES) || []).map((m) => m.slice(2))); });
    supervisor.on('error', () => {});
    const step = async (label, fn) => {
      seen = [];
      await fn();
      await sleep(2000);
      console.log(`${label.padEnd(40)} modes: ${seen.length ? seen.join(' ') : '(none)'}`);
    };
    await step('observer attached', async () => { const o = supervisor.attachObserver(paneId, { cols: 120, rows: 60 }); await o.ready; });
    await step('control at the same size (120x60)', async () => { supervisor.acquireControl(paneId, { cols: 120, rows: 60 }); });
    await step('resize to 150x40', async () => { supervisor.resize(paneId, { cols: 150, rows: 40 }); });
    await step('ctrl+End', async () => { await client.request('input', { id: paneId, text: '\x1b[1;5F' }); });
    await step('focus in (CSI I)', async () => { await client.request('input', { id: paneId, text: '\x1b[I' }); });
    await step('Down arrow', async () => { await client.request('input', { id: paneId, text: '\x1b[B' }); });
    await step('Esc (closes /mcp)', async () => { await client.request('input', { id: paneId, text: '\x1b' }); });
    await step('resize to 140x34 at the composer', async () => { supervisor.resize(paneId, { cols: 140, rows: 34 }); });
    supervisor.detach();
  } finally {
    try { await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ }
    await sleep(1000); client.close(); daemon.kill(); await sleep(800);
    try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
