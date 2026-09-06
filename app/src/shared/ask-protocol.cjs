'use strict';

// THE HOOK LANE FOR QUESTIONS (2026-09-05).
//
// Claude Code's AskUserQuestion is answered by "the permission component": the
// CLI's own sdk-tools.d.ts documents `answers` and `annotations` on the tool's
// INPUT, and a PreToolUse hook that allows the call with `updatedInput`
// carrying them makes the tool return those answers without ever drawing its
// TUI dialog (measured against the real CLI 2.1.260 in an isolated pty,
// scripts/probe-ask-hook-win.js: no dialog, tool_result verbatim, 9 seconds).
//
// So Harbor no longer needs to read a question off a pty screen or type arrow
// keys into it. The hook (bin/harbor-ask-hook) hands Harbor the question as
// JSON, every option, description and preview intact, and waits; Harbor's
// inbox (main/providers/ask-inbox.js) shows a real form; the user's answer
// travels back through the same hook. The old screen-scraping card is the
// FLOOR for sessions that started without the hook.
//
// Transport is a directory of small JSON files, because the hook is a plain
// Node script with nothing to import and Harbor may not even be running:
//
//   <dir>/harbor.alive             Harbor's heartbeat (pid, at), refreshed every
//                                  HEARTBEAT_MS. Stale or absent = no Harbor,
//                                  and the hook steps aside so the CLI draws
//                                  its dialog exactly as it always did.
//   <dir>/<id>.request.json        the hook's question (tool_input + session)
//   <dir>/<id>.claim.json          Harbor's "this session is mine, hold on"
//   <dir>/<id>.answer.json         the user's answer, or a decline
//
// A session Harbor does not own (a terminal claude outside Harbor) is never
// claimed; the hook waits CLAIM_WAIT_MS and steps aside, so those sessions see
// the dialog with a sub-second delay and nothing else changes for them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HEARTBEAT_MS = 5000;
const HEARTBEAT_STALE_MS = 30_000;
const CLAIM_WAIT_MS = 3000;
const ANSWER_POLL_MS = 250;
const REQUEST_MAX_AGE_MS = 13 * 60 * 60 * 1000;
// The hook's own ceiling in settings: 12 hours. A question can wait all day.
const HOOK_TIMEOUT_S = 43_200;

function defaultAskDir(env = process.env) {
  return env.HARBOR_ASK_DIR || path.join(os.homedir(), '.harbor', 'asks');
}

function safeId(toolUseId) {
  const id = String(toolUseId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return id || `ask-${Date.now()}`;
}

const filesFor = (dir, id) => ({
  request: path.join(dir, `${id}.request.json`),
  claim: path.join(dir, `${id}.claim.json`),
  answer: path.join(dir, `${id}.answer.json`),
  // Harbor's explicit "not mine" (a session it is not showing): the hook
  // steps aside the moment it lands instead of waiting out CLAIM_WAIT_MS, so
  // a terminal claude or an orchestration worker loses about a poll, not
  // three seconds, while Harbor is running.
  pass: path.join(dir, `${id}.pass.json`),
});
const heartbeatPath = (dir) => path.join(dir, 'harbor.alive');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Atomic where the OS allows it, never BLOCKING: the inbox calls this on
// Electron's main thread, and a retry loop that spins on a rename refused by
// a scanner would stall every IPC and terminal frame in the app (review
// finding, 2026-09-05). These files are a few hundred bytes and every reader
// tolerates a torn read (readJson returns null and the next poll re-reads),
// so a refused rename falls back to a direct write instead of waiting.
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(value);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, json);
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    fs.writeFileSync(file, json);
  }
}

function heartbeatFresh(dir, nowMs = Date.now(), staleMs = HEARTBEAT_STALE_MS) {
  try {
    const stat = fs.statSync(heartbeatPath(dir));
    return nowMs - stat.mtimeMs < staleMs;
  } catch {
    return false;
  }
}

// Answer -> the exact PreToolUse decision the CLI expects.
// answer: { answers: {question: string}, annotations?: {question: {notes}} }
//      or { decline: string } (Claude gets the text as the reason).
function hookOutputFor(toolInput, answer) {
  if (answer && typeof answer.decline === 'string') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: answer.decline,
      },
    };
  }
  const answers = answer && answer.answers && typeof answer.answers === 'object' ? answer.answers : {};
  const annotations = answer && answer.annotations && typeof answer.annotations === 'object' ? answer.annotations : undefined;
  const updatedInput = { ...(toolInput || {}), answers };
  if (annotations && Object.keys(annotations).length) updatedInput.annotations = annotations;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'answered in Harbor',
      updatedInput,
    },
  };
}

module.exports = {
  HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
  CLAIM_WAIT_MS,
  ANSWER_POLL_MS,
  REQUEST_MAX_AGE_MS,
  HOOK_TIMEOUT_S,
  defaultAskDir,
  safeId,
  filesFor,
  heartbeatPath,
  readJson,
  writeJsonAtomic,
  heartbeatFresh,
  hookOutputFor,
};
