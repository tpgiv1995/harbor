#!/usr/bin/env node
'use strict';

// LIVE PROOF of the Connections sign-in (2026-10-24), against the REAL Claude
// CLI, with a throwaway MCP server that needs an OAuth sign-in
// (scripts/lib/oauth-mcp-standin.cjs, loopback only), so no connector anyone
// uses is signed out or in.
//
// What runs for real: `claude mcp add|list|get|logout|remove` for one config
// home and a scratch folder, `bin/harbor-mcp-login` driving `claude mcp login
// --no-browser` in a pty, a live Claude session in an ISOLATED daemon (its own
// store and pipe, reaped with this process), and the production send path
// (createSessionSend over the real terminal bridge) carrying
// `/mcp reconnect <server>` into that session. The only stand-in is the
// browser: this script follows the authorization address the way a browser
// would (the stand-in approves at once and redirects to the CLI's callback).
//
// PROOF OK needs: the list reads the server as needing a sign-in; the live
// session's own /mcp panel shows it needing a sign-in; the sign-in job goes
// waiting -> verifying -> reconnecting -> done with the session answering
// "Successfully reconnected"; the session's /mcp panel then shows the server
// connected with its 2 tools; and sign-out returns both to "needs
// authentication". Cleans up the server entry, its tokens and the session.
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/drive-mcp-signin-win.js
// Env: HARBOR_DRIVE_CLAUDE_HOME, the config home to sign in with (required:
// a signed-in home you can add a throwaway local server to). No model turn runs.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');
const { createTerminalBridge } = require('../src/main/terminal-bridge.js');
const { createControlClient } = require('../src/main/session-daemon/factory.js');
const { createSessionSend, createLinkRegistry, claudeProjectDir } = require('../src/main/session-send.js');
const { createMcpConnections, defaultRunClaude } = require('../src/main/providers/mcp-connections.js');
const { preacceptFolderTrust } = require('../../bin/harbor-bin.cjs');
const { startOAuthMcpStandin } = require('./lib/oauth-mcp-standin.cjs');

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const HOME_DIR = process.env.HARBOR_DRIVE_CLAUDE_HOME;
if (!HOME_DIR) { console.error('set HARBOR_DRIVE_CLAUDE_HOME to a signed-in Claude config home'); process.exit(2); }
const SERVER = `harbor-signin-proof-${process.pid}`;
const OUT = process.env.HARBOR_DRIVE_OUT || null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-signin-proof-store-'));
const cwd = fs.mkdtempSync(path.join(tmp, 'harbor-signin-proof-cwd-'));
const socketPath = path.join(store, 'daemon.sock');
const daemonEnv = { ...process.env, HARBOR_SESSION_BACKEND: 'sessiond', HARBOR_SESSIOND_DIR: store, HARBOR_SESSIOND_SOCKET: socketPath };

const facts = { server: SERVER, home: HOME_DIR };
const problems = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) problems.push(what); };

(async () => {
  const standin = await startOAuthMcpStandin();
  const cli = (args) => defaultRunClaude({ claudeBin: CLAUDE, args, home: HOME_DIR, cwd, timeoutMs: 120_000 });
  let daemon; let client; let paneId; let bridge; const sessionId = randomUUID();
  const transcript = path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
  try {
    const added = await cli(['mcp', 'add', '--transport', 'http', '-s', 'local', SERVER, standin.url]);
    check(added.code === 0, `the throwaway server is added at local scope (${(added.stdout || added.stderr).trim().split('\n')[0]})`);
    preacceptFolderTrust(HOME_DIR, cwd);

    daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, stdio: 'ignore', env: { ...daemonEnv, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid), HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-signin-proof-${process.pid}` } });
    for (let i = 0; i < 150; i += 1) { try { const p = new SessionClient({ socketPath }); const r = await p.request('health'); p.close(); if (r.ok) break; } catch { /* not yet */ } await sleep(100); }
    client = new SessionClient({ socketPath, requestTimeoutMs: 30000 });
    const env = { CLAUDE_CONFIG_DIR: HOME_DIR, TERM: 'xterm-256color' };
    for (const k of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'PROGRAMFILES', 'ProgramData']) if (process.env[k]) env[k] = process.env[k];
    paneId = (await client.request('spawn', { argv: [CLAUDE, '--session-id', sessionId, '--model', 'haiku', '--effort', 'low'], cwd, env, cols: 120, rows: 60, agent: 'claude', agent_session: sessionId })).id;
    const pane = { paneId, workspaceId: paneId };
    const screen = async () => (await client.request('screen', { id: paneId })).visible;
    const until = async (probe, ms, what) => {
      const t = Date.now() + ms;
      while (Date.now() < t) { const v = await probe(); if (v) return v; await sleep(300); }
      throw new Error(`${what}\n--- screen ---\n${await screen()}`);
    };
    await until(async () => { const s = await screen(); return /❯/u.test(s) && !/Loading/u.test(s) && !/trust/i.test(s); }, 90_000, 'the live session never reached its prompt');
    await sleep(4000);

    // The live session's own /mcp panel, read for evidence only.
    const panelRow = async () => {
      await client.request('input', { id: paneId, text: '/mcp' });
      await sleep(300);
      await client.request('input', { id: paneId, text: '\r' });
      await until(async () => /Manage MCP servers/.test(await screen()), 30_000, 'the session never opened /mcp');
      await sleep(1500);
      const lines = (await screen()).split('\n');
      const dialog = lines.slice(lines.findIndex((l) => /Manage MCP servers/.test(l)));
      const row = dialog.find((l) => l.includes(SERVER))?.trim() || '(not listed)';
      await client.request('input', { id: paneId, text: '\x1b' });
      await until(async () => !/Manage MCP servers/.test(await screen()), 15_000, 'the session never closed /mcp');
      await sleep(800);
      return row;
    };

    bridge = createTerminalBridge({ sessionSocketPath: socketPath, sessionStorePolicy: { allowed: true }, env: daemonEnv });
    bridge.emitter.on('error', () => {});
    await bridge.start();
    const sendClient = createControlClient({ env: daemonEnv, sessionStorePolicy: { allowed: true } });
    const sessionSend = createSessionSend({
      snapshot: async () => { const res = await sendClient.snapshot(); return res?.snapshot || res || {}; },
      readPane: async (id, lines = 16, source = 'recent') => (await sendClient.readPane(id, { source, lines, strip_ansi: true }))?.read?.text || '',
      readSuggestion: async () => null,
      terminalBridge: bridge,
      launchActions: { resumeSession: async () => { throw new Error('the proof never resumes'); } },
      getSessionMeta: async () => ({ cwd }),
      resolveTranscriptPath: async () => transcript,
      links: createLinkRegistry(),
      projectLabelForCwd: () => 'signin-proof',
      setXClipboardImage: async () => {},
      captureDir: path.join(store, 'captures'),
      sendLogFile: path.join(store, 'send-log.jsonl'),
    });

    // The browser: follow the address to the CLI's own callback.
    const visited = [];
    const browser = async (url) => {
      visited.push(url.replace(/\?.*/, '?…'));
      const first = await fetch(url, { redirect: 'manual' });
      const callback = first.headers.get('location');
      if (callback) { const back = await fetch(callback); visited.push(`${new URL(callback).origin}/… ${back.status}`); }
    };
    const updates = [];
    const conn = createMcpConnections({
      resolveContext: async () => ({ home: HOME_DIR, cwd }),
      claudeBin: async () => CLAUDE,
      openExternal: (url) => { browser(url).catch((e) => visited.push(`browser error ${e.message}`)); },
      sendCommand: ({ sessionId: id, pane: p, text }) => sessionSend.send({ sessionId: id, pane: p, text, provider: 'claude' }),
      transcriptPathFor: async () => transcript,
      onUpdate: (job) => { updates.push(job); console.log(`  job ${job.phase}: ${job.message || ''}`); },
    });
    const findRow = (listed) => listed.groups.flatMap((g) => g.servers).find((s) => s.name === SERVER);
    const waitJob = async () => until(async () => { const last = updates.at(-1); return last && ['done', 'failed', 'cancelled'].includes(last.phase) ? last : null; }, 180_000, 'the sign-in job never finished');

    const before = findRow(await conn.list({ sessionId, pane }));
    facts.listBefore = before && { status: before.status, group: null, actions: before.actions };
    check(before?.status === 'needs-auth' && before.actions.includes('sign-in'), `the list reads the server as needing a sign-in (${before?.statusText})`);
    facts.sessionBefore = await panelRow();
    check(/needs auth/i.test(facts.sessionBefore), `the live session's own /mcp shows it needing a sign-in: "${facts.sessionBefore}"`);

    // CONTROL: does a running session pick up a sign-in on its own? Sign in
    // with no pane (so no reconnect), give it 20 s, and look.
    await conn.signIn({ sessionId, pane: null, name: SERVER });
    const control = await waitJob();
    check(control.phase === 'done', `control sign-in (no reconnect) finished: ${control.message}`);
    await sleep(20_000);
    facts.sessionWithoutReconnect = await panelRow();
    check(/needs auth/i.test(facts.sessionWithoutReconnect), `without a reconnect the running session still needs a sign-in 20 s later: "${facts.sessionWithoutReconnect}"`);
    const reconnected = await conn.act({ sessionId, pane, name: SERVER, action: 'reconnect' });
    facts.controlReconnect = await panelRow();
    check(reconnected.outcome === 'reconnected' && /2 tools/.test(facts.controlReconnect), `one /mcp reconnect brings the tools in: "${facts.controlReconnect}"`);
    const reset = await conn.signOut({ sessionId, pane, name: SERVER });
    check(reset.live?.outcome === 'needs-auth', 'signed out again for the real run');
    updates.length = 0;
    visited.length = 0;

    await conn.signIn({ sessionId, pane, name: SERVER });
    const job = await waitJob();
    facts.signIn = { phases: [...new Set(updates.map((u) => u.phase))], message: job.message, live: job.live, visited };
    check(job.phase === 'done', `the sign-in job finished (${job.phase}: ${job.message})`);
    check(['waiting', 'verifying', 'reconnecting', 'done'].every((p) => facts.signIn.phases.includes(p)), `phases ${facts.signIn.phases.join(' -> ')}`);
    check(job.live?.outcome === 'reconnected', `the running session answered: "${job.live?.message}"`);
    check(standin.tokensIssued() > 0, 'the stand-in issued a token to the CLI');
    const after = findRow(await conn.list({ sessionId, pane }));
    check(after?.status === 'connected', `the list now reads it connected (${after?.statusText})`);
    facts.sessionAfter = await panelRow();
    check(/2 tools/.test(facts.sessionAfter), `the live session's own /mcp shows its real tools: "${facts.sessionAfter}"`);

    updates.length = 0;
    const out = await conn.signOut({ sessionId, pane, name: SERVER });
    facts.signOut = { message: out.message, live: out.live };
    check(out.ok && out.live?.outcome === 'needs-auth', `sign-out ran the CLI logout and the session reconnected to "${out.live?.message}"`);
    const finalRow = findRow(await conn.list({ sessionId, pane }));
    check(finalRow?.status === 'needs-auth', `the list reads it needing a sign-in again (${finalRow?.statusText})`);
    facts.sessionFinal = await panelRow();
  } catch (error) {
    problems.push(error.stack || error.message);
  } finally {
    try { await cli(['mcp', 'logout', SERVER]); } catch { /* best effort */ }
    const removed = await cli(['mcp', 'remove', '-s', 'local', SERVER]).catch(() => null);
    facts.cleanup = (removed?.stdout || removed?.stderr || '').trim().split('\n')[0];
    try { bridge?.close(); } catch { /* closing */ }
    try { if (client && paneId) await client.request('terminate', { id: paneId, signal: 'SIGKILL' }); } catch { /* gone */ }
    await sleep(1500);
    try { client?.close(); } catch { /* closed */ }
    if (daemon && daemon.exitCode === null) daemon.kill();
    await standin.close();
    await sleep(800);
    for (const p of [transcript, store, cwd]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  console.log(JSON.stringify(facts, null, 2));
  if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'signin-proof.json'), JSON.stringify({ facts, problems }, null, 2)); }
  console.log(problems.length ? `PROOF FAILED:\n- ${problems.join('\n- ')}` : 'PROOF OK: signed in through the real CLI, the running session reconnected and shows the new tools, and sign-out reverses it');
  process.exit(problems.length ? 1 : 0);
})();
