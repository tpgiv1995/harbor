#!/usr/bin/env node
'use strict';

// PROBE: can a PreToolUse hook answer AskUserQuestion in an INTERACTIVE
// Claude Code session, so the TUI dialog never appears?
//
// The CLI's shipped sdk-tools.d.ts (2.1.260) documents `answers` and
// `annotations` on AskUserQuestionInput as "collected by the permission
// component". If the interactive CLI honours a hook's updatedInput carrying
// them, Harbor can take questions as JSON (every option, description and
// preview intact) and hand answers back without scraping a screen or typing
// arrow keys into a pty. This script measures that against the real CLI in
// an isolated daemon (relocated store, its own cwd, never the user's daemon),
// exactly like scripts/drive-ask-sheet-win.js. Costs one haiku turn.
//
// Usage (from app/, Windows):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/probe-ask-hook-win.js
//
// Verdicts printed: HOOK ANSWERS (the tool_result carries the hook's answers
// and no dialog was ever drawn), DIALOG DREW (the hook ran but the dialog
// still appeared), or HOOK NOT RUN.

const { execPath: guiNodeExec } = require('../test/support/gui-node.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SessionClient } = require('../src/daemon/client.js');

const DAEMON = path.join(__dirname, '../src/daemon/daemon.js');
const HOOK = path.join(__dirname, 'ask-hook-probe', 'hook.mjs');
const CLAUDE = process.env.HARBOR_PROBE_CLAUDE
  || path.win32.normalize(path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tmp = fs.realpathSync.native(os.tmpdir());
const store = fs.mkdtempSync(path.join(tmp, 'harbor-ask-hook-probe-'));
const cwd = fs.mkdtempSync(path.join(tmp, 'harbor-ask-hook-cwd-'));
const outDir = path.join(store, 'hook-out');
const socketPath = path.join(store, 'daemon.sock');
const LANE = process.argv.includes('--permission-request') ? 'PermissionRequest' : 'PreToolUse';
// --harbor: the REAL lane end to end. bin/harbor-ask-hook is installed as the
// hook, an isolated HARBOR_ASK_DIR carries the files, and the real ask inbox
// (main/providers/ask-inbox.js) runs in this process, claims the question the
// moment it lands and answers it the way the card would. The CLI's own
// tool_result is the verdict, exactly as in the probe lane.
const HARBOR_LANE = process.argv.includes('--harbor');
const REAL_HOOK = path.join(__dirname, '../../bin/harbor-ask-hook');
const { createAskInbox } = require('../src/main/providers/ask-inbox.js');

const cleanup = { client: null, daemon: null, paneId: null, transcriptDir: null, inbox: null };
async function teardown() {
  const { client, daemon, paneId, transcriptDir } = cleanup;
  try { cleanup.inbox?.stop(); } catch { /* not started */ }
  try {
    const log = fs.readFileSync(path.join(store, 'asks', 'hook.log'), 'utf8').trim().split('\n');
    console.log('--- real hook log ---\n' + log.slice(-6).join('\n'));
  } catch { /* probe lane: no real hook log */ }
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
  const settingsFile = path.join(store, 'probe-settings.json');
  const nodeExe = process.env.HARBOR_PROBE_NODE || 'node';
  const askDir = path.join(store, 'asks');
  const hookCommand = HARBOR_LANE ? `"${nodeExe}" "${REAL_HOOK}"` : `"${nodeExe}" "${HOOK}" "${outDir}"`;
  const hooks = LANE === 'PreToolUse'
    ? { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hookCommand, timeout: 600 }] }] }
    : { PermissionRequest: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hookCommand, timeout: 600 }] }] };
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks }, null, 2));
  console.log(`lane=${LANE} hook=${hookCommand}`);

  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
      HARBOR_SESSIOND_PARENT_PID: String(process.pid),
      HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-ask-hook-probe-${process.pid}`,
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
  // The hook inherits the CLI's environment, so the isolated ask dir travels
  // this way and the real hook never touches ~/.harbor/asks from a probe.
  childEnv.HARBOR_ASK_DIR = askDir;
  const claudeSession = randomUUID();
  const spawned = await client.request('spawn', {
    argv: [CLAUDE, '--session-id', claudeSession, '--model', 'haiku', '--effort', 'low', '--permission-mode', 'bypassPermissions', '--settings', settingsFile],
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

  // The real inbox, answering as the card would: q1 -> its second option,
  // q2 (multi) -> options 1 and 3, a note on q1.
  let inboxSaw = false;
  if (HARBOR_LANE) {
    const inbox = createAskInbox({
      dir: askDir,
      ownsSession: (sessionId) => (sessionId === claudeSession ? { paneId, workspaceId: 'ws' } : null),
      pollMs: 300,
      log: (line) => console.log(`  ${line}`),
    });
    cleanup.inbox = inbox;
    const DECLINE = process.argv.includes('--decline');
    inbox.emitter.on('changed', (list) => {
      for (const entry of list) {
        if (entry.answered) continue;
        inboxSaw = true;
        if (DECLINE) {
          // The deny lane: the reply text must reach Claude as the reason.
          console.log(`  inbox declining ${entry.id}`);
          console.log('  decline result:', JSON.stringify(inbox.decline(entry.id, 'PROBE-DECLINE: skip the probe and reply with the word DECLINED')));
          continue;
        }
        const answers = {};
        const annotations = {};
        entry.questions.forEach((q, i) => {
          const labels = q.options.map((o) => o.label);
          answers[q.question] = q.multiSelect ? [labels[0], labels[2]].filter(Boolean).join(', ') : (labels[1] || labels[0]);
          if (i === 0) annotations[q.question] = { notes: 'probe note through the real inbox' };
        });
        console.log(`  inbox answering ${entry.id} for session ${entry.sessionId.slice(0, 8)} (${entry.questions.length} questions, preview on q1 option 2: ${Boolean(entry.questions[0]?.options[1]?.preview)})`);
        console.log('  answer result:', JSON.stringify(inbox.answer(entry.id, { answers, annotations })));
      }
    });
    inbox.start();
  }

  const readScreen = async (lines) => {
    const screen = await client.request('screen', { id: paneId, scrollback: lines });
    const text = String(screen.visible).split('\n');
    while (text.length && !text.at(-1).trim()) text.pop();
    return text.slice(-lines).join('\n');
  };
  const until = async (fn, ms, what) => {
    const t = Date.now() + ms;
    while (Date.now() < t) { const v = await fn(); if (v) return v; await sleep(400); }
    throw new Error(what);
  };
  await until(async () => { const s = await readScreen(200); return /[❯>]/u.test(s) && !/Loading/u.test(s) ? s : null; }, 40_000, 'composer never came up');

  const prompt = 'Call the AskUserQuestion tool exactly once, right now, with TWO questions. '
    + 'Question 1: header "Approach", question "Which approach should I take for the probe?", multiSelect false, options "Fast path", "Careful path", "Ask again later", each with a one-sentence description, and give the second option a preview of three short lines of ASCII. '
    + 'Question 2: header "Delivery", question "How should I hand the result off? (pick any)", multiSelect TRUE, options "File only", "File and note", "Note only", each with a one-sentence description. Do not answer the questions yourself. After the tool returns, reply with exactly the word DONE and nothing else.';
  await client.request('input', { id: paneId, text: `\x1b[200~${prompt}\x1b[201~` });
  await sleep(300);
  await client.request('input', { id: paneId, text: '\r' });

  // Race: the dialog on screen vs the tool_result in the transcript.
  const started = Date.now();
  let verdict = null;
  let dialogSeen = false;
  let hookRan = false;
  let result = null;
  while (Date.now() - started < 180_000 && !verdict) {
    await sleep(700);
    hookRan = hookRan || fs.existsSync(path.join(outDir, 'hook-input.json')) || inboxSaw || fs.existsSync(path.join(askDir, 'hook.log'));
    const screen = await readScreen(120).catch(() => '');
    if (/Enter to select/u.test(screen) && /to navigate/u.test(screen)) dialogSeen = true;
    try {
      const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        const content = o.message?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part.type === 'tool_result' && o.type === 'user') {
            const text = JSON.stringify(part.content || '');
            if (/answered|answers|Careful path|File only|PROBE-DECLINE|denied|deny/u.test(text)) result = text;
          }
        }
      }
    } catch { /* no transcript yet */ }
    if (result) verdict = dialogSeen ? 'DIALOG DREW (then something answered it)' : (hookRan ? 'HOOK ANSWERS' : 'ANSWERED WITHOUT HOOK?');
    else if (dialogSeen && hookRan && Date.now() - started > 15_000) verdict = 'DIALOG DREW';
    else if (dialogSeen && !hookRan && Date.now() - started > 15_000) verdict = 'HOOK NOT RUN';
  }
  console.log(`hookRan=${hookRan} dialogSeen=${dialogSeen} elapsed=${Date.now() - started}ms`);
  if (fs.existsSync(path.join(outDir, 'hook-input.json'))) {
    const input = JSON.parse(fs.readFileSync(path.join(outDir, 'hook-input.json'), 'utf8'));
    console.log('hook stdin keys:', Object.keys(input).join(', '));
    console.log('questions the hook received:', JSON.stringify(input.tool_input?.questions?.map((q) => ({ header: q.header, multi: q.multiSelect, options: q.options.map((o) => o.label + (o.preview ? ' [preview]' : '')) }))));
  }
  console.log('tool_result:', result ? result.slice(0, 700) : '(none)');
  const screen = await readScreen(30).catch(() => '');
  console.log('--- screen tail ---\n' + screen.split('\n').slice(-12).join('\n'));
  console.log(`\nVERDICT: ${verdict || 'TIMEOUT'}`);
}

main().then(async () => { await teardown(); process.exit(0); }).catch(async (error) => { console.error(error); await teardown(); process.exit(1); });
