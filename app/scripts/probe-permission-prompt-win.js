#!/usr/bin/env node
'use strict';

// LIVE CAPTURE of a Claude Code permission prompt, parsed by Harbor's own
// dialog path (2026-09-30, CLI 2.1.286 changed the Bash prompt layout: the
// command now sits between dashed lines, and stacked prompts carry "N of M").
// Same isolation as drive-ask-sheet-win.js: a relocated daemon store and
// socket that dies with this process, a throwaway cwd, and the probe
// session's transcript deleted afterwards. Costs one small haiku turn.
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/probe-permission-prompt-win.js [captureFile]
// HARBOR_PROBE_CLAUDE pins the claude.exe under test. HARBOR_PROBE_KIND=mcp
// captures an MCP tool prompt instead of a Bash one (2.1.287 frames the MCP
// tool call between the same dashed lines): the probe writes a tiny stdio MCP
// server into its throwaway store and loads ONLY that server, which also
// proves a server answering Claude's newest protocol version still connects.
// Exit 0 with "PROOF OK" only when Harbor's menu state reads the live prompt
// as a recognized permission dialog with its options, no dashed rule leaked
// into the question, and Esc declines it.

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
const CAPTURE = process.argv[2] || null;
const KIND = process.env.HARBOR_PROBE_KIND === 'mcp' ? 'mcp' : 'bash';
// Newline-delimited JSON-RPC over stdio; echoes the client's protocol version.
const MCP_SERVER_SRC = `'use strict';
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo_probe', description: 'Echo the given text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String((m.params && m.params.arguments && m.params.arguments.text) || '') }] } });
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
});
`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-perm-proof-'));
const cwd = fs.mkdtempSync(path.join(tmp, 'harbor-perm-cwd-'));
const socketPath = path.join(store, 'daemon.sock');

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
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_PARENT_PID: String(process.pid),
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-perm-proof-${process.pid}`,
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
  const mcpArgs = [];
  if (KIND === 'mcp') {
    const serverFile = path.join(store, 'probe-mcp-server.cjs');
    fs.writeFileSync(serverFile, MCP_SERVER_SRC);
    const configFile = path.join(store, 'probe-mcp.json');
    fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { probe: { type: 'stdio', command: process.execPath, args: [serverFile], env: { ELECTRON_RUN_AS_NODE: '1' } } } }));
    mcpArgs.push('--strict-mcp-config', '--mcp-config', configFile);
  }
  const spawned = await client.request('spawn', {
    // No settings sources: the user allowlist would pre-approve the command and
    // hide the prompt this probe exists to capture.
    argv: [CLAUDE, '--session-id', claudeSession, '--model', 'haiku', '--effort', 'low', '--permission-mode', 'default', '--setting-sources', '', ...mcpArgs],
    cwd, env: childEnv, cols: 120, rows: 60,
  });
  const paneId = spawned.id;
  cleanup.paneId = paneId;
  cleanup.transcriptDir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[:\\/]/g, '-'));
  console.log(`spawned pane ${paneId}, claude ${CLAUDE}`);

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
  // A fresh cwd may open the folder-trust screen first; accept it (option 1).
  await until(async () => {
    const s = await readScreen(200, 'visible');
    if (/trust (this|the files in this) folder|Do you trust/i.test(s)) { await client.request('input', { id: paneId, text: '\r' }); await sleep(1500); return null; }
    return /❯/u.test(s) && !/Loading/u.test(s) ? s : null;
  }, 60_000, 'composer never came up');

  const prompt = KIND === 'mcp'
    ? 'Call the MCP tool mcp__probe__echo_probe exactly once with text "harbor probe", and do nothing else. If it is deferred, load it with tool search first.'
    : 'Use the Bash tool to run exactly this command and nothing else: mkdir harbor-perm-probe-dir';
  await client.request('input', { id: paneId, text: `\x1b[200~${prompt}\x1b[201~` });
  await sleep(300);
  await client.request('input', { id: paneId, text: '\r' });
  await until(async () => {
    const s = await readScreen(200, 'visible');
    return /Esc to cancel|Do you want to proceed/i.test(s) ? s : null;
  }, 150_000, 'permission prompt never appeared').catch(async (e) => {
    console.log(`---- last screen ----\n${await readScreen(40, 'visible')}`);
    throw e;
  });
  await sleep(800);
  const captured = await readScreen(60, 'visible');
  if (CAPTURE) fs.writeFileSync(CAPTURE, captured);
  console.log('---- captured prompt ----\n' + captured.split('\n').slice(-24).join('\n') + '\n-------------------------');

  const send = createSessionSend({
    snapshot: async () => ({ panes: [{ pane_id: paneId, workspace_id: 'ws' }], workspaces: [{ workspace_id: 'ws', label: 'proof' }] }),
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
  const pane = { paneId, workspaceId: 'ws' };
  const menu = await send.getMenu({ pane });
  const summary = menu && {
    kind: menu.kind || menu.type, fallback: Boolean(menu.fallback),
    question: menu.question, footer: menu.footer,
    options: (menu.options || []).map((o) => `${o.index}. ${o.label}`),
  };
  console.log(`menu state: ${JSON.stringify(summary)}`);
  const recognized = Boolean(menu && !menu.fallback && (menu.options || []).length >= 2
    && (menu.options || []).some((o) => /^Yes\b/.test(o.label)) && (menu.options || []).some((o) => /^No\b/.test(o.label)));
  const questionText = JSON.stringify((menu && menu.question) || '');
  const noRuleLeak = !/[╌╍┄┅┈┉]{3,}/u.test(questionText);
  // The call's own arguments must survive (the prompt titles the tool "Echo Probe").
  const keepsTool = KIND === 'mcp' ? /harbor probe/.test(questionText) : /harbor-perm-probe-dir/.test(questionText);

  await client.request('input', { id: paneId, text: '\x1b' });
  const cleared = await until(async () => { const s = await readScreen(200, 'visible'); return /Esc to cancel/i.test(s) ? null : s; }, 15_000, 'Esc did not clear the prompt').then(() => true, () => false);
  console.log(`kind ${KIND}; recognized as a labeled permission card: ${recognized}; no dashed rule in the question: ${noRuleLeak}; question names the call: ${keepsTool}; Esc cleared it: ${cleared}`);
  const ok = recognized && noRuleLeak && keepsTool && cleared;
  console.log(ok ? 'PROOF OK' : 'PROOF FAILED');
  return ok;
}

main()
  .then(async (ok) => { await teardown(); process.exit(ok ? 0 : 1); })
  .catch(async (error) => { console.error('ERR', error.stack || error); await teardown(); process.exit(1); });
