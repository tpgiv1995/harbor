#!/usr/bin/env node
'use strict';

// PROBE (2026-10-24): what Claude Code's inline /mcp actions do in a live
// session (/mcp reconnect|enable|disable <server>, read out of the 2.1.303
// binary): what the screen shows, and whether the result reaches the
// transcript, which is where Harbor can read it without scraping a dialog.
// Real CLI, isolated daemon, the cwd and home given (HARBOR_PROBE_HOME is
// required; the cwd defaults to this checkout). The probe session's transcript
// is deleted afterwards.
// HARBOR_PROBE_ACTIONS is a |-separated list (default "reconnect chrome").
// Usage (from app/): ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/probe-mcp-inline-win.js

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');
const { claudeProjectDir } = require('../src/main/session-send.js');

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const HOME_DIR = process.env.HARBOR_PROBE_HOME;
if (!HOME_DIR) { console.error('set HARBOR_PROBE_HOME to a signed-in Claude config home'); process.exit(2); }
const CWD = process.env.HARBOR_PROBE_CWD || path.resolve(__dirname, '..', '..');
const ACTIONS = (process.env.HARBOR_PROBE_ACTIONS || 'reconnect chrome').split('|');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-mcp-inline-probe-'));
const socketPath = path.join(store, 'daemon.sock');

(async () => {
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, stdio: 'ignore', env: { ...process.env, HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-mcp-inline-${process.pid}` } });
  for (let i = 0; i < 100; i += 1) { try { const p = new SessionClient({ socketPath }); const r = await p.request('health'); p.close(); if (r.ok) break; } catch { /* not yet */ } await sleep(100); }
  const client = new SessionClient({ socketPath, requestTimeoutMs: 30000 });
  const env = { CLAUDE_CONFIG_DIR: HOME_DIR, TERM: 'xterm-256color' };
  for (const k of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMFILES', 'ProgramData']) if (process.env[k]) env[k] = process.env[k];
  const sessionId = randomUUID();
  const transcript = path.join(claudeProjectDir(CWD), `${sessionId}.jsonl`);
  const { id: paneId } = await client.request('spawn', { argv: [CLAUDE, '--session-id', sessionId, '--model', 'haiku', '--effort', 'low'], cwd: CWD, env, cols: 120, rows: 60, agent: 'claude' });
  const screen = async () => (await client.request('screen', { id: paneId })).visible;
  try {
    for (let i = 0; i < 300 && !/❯/u.test(await screen()); i += 1) await sleep(300);
    await sleep(4000);
    for (const action of ACTIONS) {
      const t0 = Date.now();
      await client.request('input', { id: paneId, text: `/mcp ${action}` });
      await sleep(400);
      await client.request('input', { id: paneId, text: '\r' });
      await sleep(Number(process.env.HARBOR_PROBE_WAIT_MS || 8000));
      const s = await screen();
      const lines = s.split('\n').filter((l) => l.trim());
      console.log(`=== /mcp ${action} (${Date.now() - t0} ms) screen tail:\n${lines.slice(-12).join('\n')}`);
    }
    console.log(`=== transcript ${fs.existsSync(transcript) ? 'exists' : 'absent'}`);
    if (fs.existsSync(transcript)) {
      for (const line of fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line);
          const c = r.message?.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text || '').join('') : '';
          console.log(`  ${r.type}${r.subtype ? `/${r.subtype}` : ''}: ${JSON.stringify(text || r.content || '').slice(0, 300)}`);
        } catch { /* partial */ }
      }
    }
  } finally {
    try { await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ }
    await sleep(1500); client.close(); daemon.kill(); await sleep(800);
    try { fs.rmSync(transcript, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
