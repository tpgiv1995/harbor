#!/usr/bin/env node
'use strict';

// LIVE PROOF of the answer sheet's delivery against the REAL Claude Code CLI,
// in an ISOLATED daemon (relocated store, its own cwd, never the user's daemon).
//
// What it exercises, all production code: the daemon's screen model
// (src/daemon/screen.js, Unicode 11 widths), the pty parser (menu-parse.js),
// the on-demand transcript read (providers/pending-ask.js), the merge
// (ask-question.js), and the `sheet` delivery in session-send.js, driven
// through createSessionSend with a thin bridge over the daemon client.
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/drive-ask-sheet-win.js
// Needs a signed-in claude on this machine; costs one small haiku turn. The
// probe session's transcript is deleted afterwards so it never reaches the rail.
//
// Exit 0 with "PROOF OK" only when the CLI's own tool_result records exactly
// the answers the sheet delivered.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');
const { createSessionSend, createLinkRegistry } = require('../src/main/session-send.js');
const { createPendingAskReader } = require('../src/main/providers/pending-ask.js');

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE
  || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-ask-sheet-proof-'));
const cwd = fs.mkdtempSync(path.join(tmp, 'harbor-ask-sheet-cwd-'));
const socketPath = path.join(store, 'daemon.sock');

const ANSWERS = [
  { question: 0, kind: 'select', index: 2 },
  { question: 1, kind: 'multi', indexes: [1, 3] },
];
const EXPECT = ['Show me the cleaned census first', 'File + note to you, Draft the note for someone'];

// Teardown runs on EVERY exit, including a thrown assertion: the first shape
// of this script exited on a failed wait and left its keeper and its claude
// alive for an hour (2026-09-03), because a relocated store without its own
// job namespace has no kernel containment and a dead harness is not a dead
// session. The store names a job namespace and the daemon watches this pid.
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
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-ask-sheet-proof-${process.pid}`,
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
  await until(async () => { const s = await readScreen(200, 'visible'); return /[❯>]/u.test(s) && !/Loading/u.test(s) ? s : null; }, 40_000, 'composer never came up');

  const prompt = 'Call the AskUserQuestion tool exactly once, right now, with TWO questions. '
    + 'Question 1: header "Finish approach", question "How do you want me to produce the complete BIH file for the full roster?", multiSelect false, options "Reassemble + one BIH map (Recommended)", "Show me the cleaned census first", "Clean re-run of the 5 PDFs", each with a description of at least 150 characters. '
    + 'Question 2: header "Delivery", question "How should I hand off the finished file? (pick any)", multiSelect TRUE, options "File + note to you", "Just the file", "Draft the note for someone", each with a description of at least 100 characters. Do not answer the questions yourself.';
  await client.request('input', { id: paneId, text: `\x1b[200~${prompt}\x1b[201~` });
  await sleep(300);
  await client.request('input', { id: paneId, text: '\r' });
  await until(async () => { const s = await readScreen(200, 'visible'); return /Enter to select/.test(s) ? s : null; }, 150_000, 'dialog never appeared');
  await sleep(800);

  // The transcript holds NOTHING from the assistant turn while the dialog is
  // up (measured 2026-09-03, v2.1.258: thinking, text, tool_use and
  // tool_result all land together after the answer), so the production
  // reader is expected to come back empty here. It is asserted, not assumed:
  // if a future CLI persists early, this line is the first place to know.
  const reader = createPendingAskReader();
  const early = reader.read(transcript);
  console.log(`transcript while the dialog is up: ${early ? 'carries the question (the CLI persists early now)' : 'no assistant record (as measured)'}`);

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

  // The batch is DISCOVERED off the dialog by getMenu (the same call the card
  // polls), which walks it once and puts it back where it was.
  const pane = { paneId, workspaceId: 'ws' };
  const discovering = Date.now();
  const menu = await send.getMenu({ pane });
  if (!menu?.asked || menu.asked.length !== 2) throw new Error(`discovery did not yield the batch: ${JSON.stringify(menu && { asked: menu.asked, tabs: menu.tabs })}`);
  console.log(`discovered ${menu.asked.map((q) => `${q.header} (${q.options.length} options${q.multiSelect ? ', multi' : ''})`).join(' / ')} in ${Date.now() - discovering}ms; dialog back on question ${menu.batch.currentIndex + 1}`);

  const started = Date.now();
  const result = await send.answerMenu({ pane, action: { type: 'sheet', answers: ANSWERS } });
  console.log(`deliverSheet -> ${JSON.stringify(result)} in ${Date.now() - started}ms`);
  if (!result.ok) throw new Error(`delivery refused: ${result.reason}`);

  const recorded = await until(async () => {
    let text = '';
    try { text = fs.readFileSync(transcript, 'utf8'); } catch { return null; }
    for (const line of text.split('\n')) {
      if (!line.includes('"tool_result"')) continue;
      let obj = null;
      try { obj = JSON.parse(line); } catch { continue; }
      for (const part of obj?.message?.content || []) {
        if (part.type === 'tool_result') {
          const content = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
          if (content.includes('answered')) return content;
        }
      }
    }
    return null;
  }, 20_000, 'no tool_result reached the transcript');
  console.log(`tool_result: ${recorded}`);
  const ok = EXPECT.every((answer) => recorded.includes(`="${answer}"`));
  console.log(ok ? 'PROOF OK' : 'PROOF FAILED: the recorded answers differ from what the sheet delivered');
  return ok;
}

main()
  .then(async (ok) => { await teardown(); process.exit(ok ? 0 : 1); })
  .catch(async (error) => { console.error('ERR', error.stack || error); await teardown(); process.exit(1); });
