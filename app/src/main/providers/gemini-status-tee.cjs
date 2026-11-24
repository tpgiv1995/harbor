'use strict';

// The Gemini twin of Claude's statusline tee (2026-11-23).
//
// agy runs the session's `statusLine` command through `cmd /c` with a JSON state object on stdin, about every 300 ms
// while something changes and at each state change (AGY-FACTS section 2). Harbor's per-launch settings file names a
// `.cmd` wrapper that runs THIS script. It keeps the one record per conversation that Harbor cannot read from the
// transcript: which conversation a pane is, what its agent is doing right now (`working`, `tool_use`, a pending
// permission menu that writes nothing to the transcript), model, effort and context use.
//
//   <contextDir>/gemini-<conversation_id>.json   written atomically (temp file then rename)
//
// Rules this script keeps, each pinned by test/providers/gemini-status-tee.test.js:
//   - Before the first prompt there is no conversation id: it writes NOTHING.
//   - The payload's `email` (and every other field it does not name here) is never copied: the account is not
//     Harbor's to record. Only the fields below are kept.
//   - The payload's `transcript_path` is WRONG for the CLI (it names `antigravity\brain`, the real folder is
//     `antigravity-cli\brain`), so the record carries a transcriptPath Harbor builds itself from the USERPROFILE agy
//     was started with (this process inherits agy's environment).
//   - `ownerPid` is NOT recorded: agy is this process's GRANDPARENT (through cmd.exe) and Node cannot read that
//     without a process query that costs seconds on Windows, which would run three times a second per pane. The
//     linker matches a pane by its folder and start time instead (provider-session-link.js).
//   - It prints one short plain line, which agy shows as its status row, and never fails loudly: a thrown error would
//     draw agy's "Statusline Error" banner and 30 failures disable the status line for the session.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_STATES = new Set(['authenticating', 'idle', 'working', 'tool_use']);

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value) => (typeof value === 'string' && value ? value : null);

function stateDirOf(home) {
  return path.join(home, '.gemini', 'antigravity-cli');
}

// The record for one payload, or null when the payload has no conversation yet. Pure: tests drive it directly.
function buildTeeRecord(payload, { now = Date.now(), home = os.homedir() } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const id = str(payload.conversation_id);
  if (!id || !CONVERSATION_ID_RE.test(id)) return null;
  const stateDir = stateDirOf(home);
  const model = payload.model && typeof payload.model === 'object' ? payload.model : null;
  const windowInfo = payload.context_window && typeof payload.context_window === 'object' ? payload.context_window : null;
  const state = AGENT_STATES.has(payload.agent_state) ? payload.agent_state : str(payload.agent_state);
  return {
    provider: 'gemini',
    conversation_id: id,
    agent_state: state,
    tool_confirmation_pending: payload.tool_confirmation_pending === true,
    cwd: str(payload.cwd) || str(payload.workspace?.current_dir),
    model: model ? { id: str(model.id), display_name: str(model.display_name), effort: str(model.effort) } : null,
    context_window: windowInfo ? {
      used_percentage: num(windowInfo.used_percentage),
      context_window_size: num(windowInfo.context_window_size),
      total_input_tokens: num(windowInfo.total_input_tokens),
      total_output_tokens: num(windowInfo.total_output_tokens),
    } : null,
    version: str(payload.version),
    home,
    stateDir,
    transcriptPath: path.join(stateDir, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'),
    writtenAt: new Date(now).toISOString(),
    writtenAtMs: now,
  };
}

function teePathFor(contextDir, conversationId) {
  return path.join(contextDir, `gemini-${conversationId}.json`);
}

// Atomic: a reader never sees half a record. The temp name carries the pid so two panes never share one.
function writeTeeRecord(contextDir, record, { fsImpl = fs, pid = process.pid } = {}) {
  fsImpl.mkdirSync(contextDir, { recursive: true });
  const target = teePathFor(contextDir, record.conversation_id);
  const temp = `${target}.tmp-${pid}`;
  fsImpl.writeFileSync(temp, JSON.stringify(record));
  try {
    fsImpl.renameSync(temp, target);
  } catch (error) {
    try { fsImpl.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  return target;
}

// What agy shows as its status row: short, plain, no secret. A custom status line REPLACES agy's own footer (measured on
// 1.5.14: with the tee installed the bottom row shows only what this prints), and the footer is how Harbor's send path
// and any person reads the pane's state, so this prints the same two hints agy does (`? for shortcuts` while idle,
// `esc to cancel` while working or holding a menu) and then the model and effort, the way agy's own footer ends.
// Works from the raw payload so it answers before the first prompt, when there is no record yet.
function statusLine(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const busy = payload.agent_state === 'working' || payload.agent_state === 'tool_use' || payload.tool_confirmation_pending === true;
  const model = str(payload.model?.display_name);
  return `${busy ? 'esc to cancel' : '? for shortcuts'}${model ? ` · ${model}` : ''}`;
}

function contextDirFromEnv(env = process.env) {
  return env.HARBOR_CONTEXT_DIR ? path.resolve(env.HARBOR_CONTEXT_DIR) : path.join(os.homedir(), '.cache', 'harbor', 'context');
}

function main() {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { text += chunk; });
  process.stdin.on('end', () => {
    let line = '';
    try {
      const payload = JSON.parse(text);
      const record = buildTeeRecord(payload, { home: process.env.USERPROFILE || os.homedir() });
      if (record) writeTeeRecord(contextDirFromEnv(), record);
      line = statusLine(payload);
    } catch { /* never draw an error banner in the user's pane */ }
    process.stdout.write(`${line}\n`);
  });
  process.stdin.on('error', () => process.stdout.write('\n'));
}

if (require.main === module) main();

module.exports = { buildTeeRecord, writeTeeRecord, teePathFor, statusLine, contextDirFromEnv, stateDirOf, CONVERSATION_ID_RE };
