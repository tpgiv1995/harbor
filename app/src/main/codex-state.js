'use strict';

// A Codex session's TURN STATE, folded straight off its rollout (2026-10-15).
//
// This is the same reading the shared transcript-parser contract gives
// (`header.lastSignal` idle only on a final_answer AgentMessage, task_complete
// or turn_aborted; `turnEnd` complete | aborted | error; `turnError` from a
// task_complete that carried an error), done here as a small fold so the
// notification source and the permission readback can poll a rollout tail
// cheaply without a full conversation parse. Shapes, measured on Codex CLI
// 0.160.0 rollouts:
//
//   event_msg task_started                          a turn began
//   event_msg item_completed {item:{type:'AgentMessage', phase}}
//                                                   commentary keeps the turn in
//                                                   flight; final_answer (or no
//                                                   phase, older builds) ends it
//   event_msg task_complete {error?:{message}}      the turn ended (or failed)
//   event_msg turn_aborted                          interrupted
//   turn_context {approval_policy, approvals_reviewer, sandbox_policy:{type}}
//   response_item function_call name=request_user_input arguments=JSON
//        {questions:[{id, header, question, options:[{label, description}]}]}
//   response_item function_call_output call_id      the answer arrived
//
// The question is written as a function_call BEFORE it is answered, which is
// what makes a pending Codex question readable from disk (Claude, by contrast,
// persists nothing while its dialog is up). Approvals are NOT written anywhere
// until they are resolved; those come from the screen (codex-screen.js).

const fs = require('node:fs');

const initialState = () => ({
  turn: 'idle',
  turnEnd: null,
  turnError: null,
  pendingQuestion: null,
  approvalPolicy: null,
  sandboxPolicy: null,
  reviewer: null,
  lastAgentMessage: null,
  lastRecordMs: 0,
});

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function foldCodexRecord(state, record) {
  if (!record || typeof record !== 'object') return state;
  const payload = record.payload || {};
  const ms = Date.parse(record.timestamp || '');
  if (Number.isFinite(ms)) state.lastRecordMs = Math.max(state.lastRecordMs, ms);
  if (record.type === 'turn_context') {
    if (typeof payload.approval_policy === 'string') state.approvalPolicy = payload.approval_policy;
    const sandbox = payload.sandbox_policy;
    const mode = typeof sandbox === 'string' ? sandbox : sandbox?.type || sandbox?.mode || null;
    if (mode) state.sandboxPolicy = mode;
    if (typeof payload.approvals_reviewer === 'string') state.reviewer = payload.approvals_reviewer;
    return state;
  }
  if (record.type === 'event_msg') {
    if (payload.type === 'task_started') {
      state.turn = 'working';
      state.turnEnd = null;
      state.turnError = null;
      // A question is asked and answered inside one turn. One still open when
      // the next turn starts was never answered (the process died or was
      // resumed under it), so it is not what the session is waiting on now.
      state.pendingQuestion = null;
    } else if (payload.type === 'task_complete') {
      state.turn = 'idle';
      state.pendingQuestion = null;
      const message = payload.error?.message || (typeof payload.error === 'string' ? payload.error : null);
      state.turnEnd = message ? 'error' : 'complete';
      state.turnError = message ? { message: String(message), ts: record.timestamp || null } : null;
      if (typeof payload.last_agent_message === 'string') state.lastAgentMessage = payload.last_agent_message;
    } else if (payload.type === 'turn_aborted') {
      state.turn = 'idle';
      state.turnEnd = 'aborted';
      state.turnError = null;
      state.pendingQuestion = null;
    } else if (payload.type === 'item_completed' && payload.item?.type === 'AgentMessage') {
      const phase = payload.item.phase;
      if (!phase || phase === 'final_answer') {
        state.turn = 'idle';
        if (!state.turnEnd) state.turnEnd = 'complete';
      }
    } else if (payload.type === 'item_completed' && payload.item?.type === 'UserMessage') {
      // A steer lands mid-turn as a UserMessage; it never ends a turn.
    }
    return state;
  }
  if (record.type === 'response_item') {
    if (payload.type === 'function_call' && payload.name === 'request_user_input') {
      const args = parseArguments(payload.arguments);
      const questions = Array.isArray(args?.questions) ? args.questions : null;
      if (questions?.length) state.pendingQuestion = { callId: payload.call_id || null, questions };
    } else if ((payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
      && state.pendingQuestion && payload.call_id === state.pendingQuestion.callId) {
      state.pendingQuestion = null;
    }
  }
  return state;
}

function foldCodexRecords(records, state = initialState()) {
  for (const record of records || []) foldCodexRecord(state, record);
  return state;
}

function parseLines(text) {
  const records = [];
  for (const line of String(text || '').split('\n')) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
    try { records.push(JSON.parse(line)); } catch { /* a foreign or torn line */ }
  }
  return records;
}

// A record that opens or closes a turn: the fold's working/idle anchor.
const TURN_ANCHORS = new Set(['task_started', 'task_complete', 'turn_aborted']);
const isTurnAnchor = (record) => record?.type === 'event_msg' && TURN_ANCHORS.has(record.payload?.type);

const parseLine = (text) => {
  if (!text || text.charCodeAt(0) !== 123 /* { */) return null;
  try { return JSON.parse(text); } catch { return null; }
};

// The head of a line is where a rollout names its record type; content that
// merely quotes one (a tool output that printed a rollout) sits further in and
// is rejected by the parse-and-check below anyway.
const HEAD_CHARS = 400;
const ANCHOR_HINT_RE = /"(?:task_started|task_complete|turn_aborted)"/;
const OUTPUT_HINT_RE = /"type":"(?:function_call_output|custom_tool_call_output)"/;
const CALL_ID_RE = /"call_id":"([^"]+)"/;

// The first read only sees the last `maxBytes`, and one long turn (big tool
// outputs) can be larger than that: its task_started then lies BEFORE the
// window, the fold starts from idle, and a turn in flight reads as finished
// (an approval in such a turn never showed, and the
// permission readback said "not on record" because the turn's turn_context was
// out of the window too). So walk back from `end` (a line boundary) to the last
// turn boundary and the last turn_context, keeping only the records the fold
// needs from that stretch: those two, plus request_user_input calls and their
// outputs (an output is kept as just its call_id). Bounded by `scanBytes`.
// `need` says which of the two the window already has. Returns { records (in
// file order), anchor, context } (whether each was found).
function scanBackForTurn(handle, end, { scanBytes, chunkBytes = 1024 * 1024, need = { anchor: true, context: true } } = {}) {
  const kept = [];
  // Every tool output in the stretch answers SOME call, and a long turn has
  // thousands of them; only the ones answering a kept question matter, so
  // they are collected as ids and matched once the walk is done.
  const answeredCalls = new Set();
  const floor = Math.max(0, end - scanBytes);
  let anchor = !need.anchor;
  let context = !need.context;
  let position = end;
  let carry = Buffer.alloc(0);
  const consider = (line) => {
    if (!line) return;
    const head = line.slice(0, HEAD_CHARS);
    if (ANCHOR_HINT_RE.test(head)) {
      const record = parseLine(line);
      if (isTurnAnchor(record)) {
        // Only the LAST boundary matters; an older one would be overridden.
        if (!anchor) kept.push(record);
        anchor = true;
        return;
      }
    }
    if (anchor) {
      // Past the boundary only the turn_context is still wanted.
      if (!context && head.includes('"turn_context"')) {
        const record = parseLine(line);
        if (record?.type === 'turn_context') { kept.push(record); context = true; }
      }
      return;
    }
    if (head.includes('"turn_context"')) {
      if (context) return;
      const record = parseLine(line);
      if (record?.type === 'turn_context') { kept.push(record); context = true; }
    } else if (head.includes('"request_user_input"')) {
      const record = parseLine(line);
      if (record?.type === 'response_item' && record.payload?.name === 'request_user_input') kept.push(record);
    } else if (OUTPUT_HINT_RE.test(head)) {
      const callId = CALL_ID_RE.exec(head)?.[1];
      if (callId) answeredCalls.add(callId);
    }
  };
  while (position > floor && !(anchor && context)) {
    const length = Math.min(chunkBytes, position - floor);
    position -= length;
    const chunk = Buffer.alloc(length);
    fs.readSync(handle, chunk, 0, length, position);
    const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    // Unless this chunk starts the file, its first line is torn: carry it.
    let cut = 0;
    if (position > 0) {
      const newline = data.indexOf(0x0a);
      if (newline < 0) { carry = data; continue; }
      cut = newline + 1;
    }
    carry = data.subarray(0, cut);
    const lines = data.subarray(cut).toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && !(anchor && context); i -= 1) consider(lines[i]);
  }
  // `kept` runs newest first. A question's output comes after it in the file,
  // so walking forward each kept question is followed by its answer, if any.
  const records = [];
  for (const record of kept.reverse()) {
    records.push(record);
    const callId = record.type === 'response_item' && record.payload?.name === 'request_user_input' ? record.payload.call_id : null;
    if (callId && answeredCalls.has(callId)) {
      records.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId } });
    }
  }
  return { records, anchor: anchor && need.anchor, context: context && need.context };
}

// Read [from, size) of a rollout, keeping only whole lines. A first read starts
// `maxBytes` from the end and drops the torn leading line; when that window
// holds no turn boundary it is anchored by scanBackForTurn (up to `scanBytes`
// further back). Returns { records, offset, size, anchored } where offset is
// where the next read should start and `anchored` is false only for a first
// read whose turn state could not be established (no boundary in reach).
const DEFAULT_SCAN_BYTES = 64 * 1024 * 1024;
function readRolloutSlice(filePath, { from = null, maxBytes = 2 * 1024 * 1024, scanBytes = DEFAULT_SCAN_BYTES } = {}) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(handle);
    // A file shorter than `from` was truncated or replaced: read it like a
    // first read (the fold restarts there anyway), so a window that opens
    // mid-file drops its torn leading line instead of parsing garbage.
    const first = from == null || from > size;
    const start = first ? Math.max(0, size - maxBytes) : from;
    const length = size - start;
    if (length <= 0) return { records: [], offset: start, size, anchored: true };
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, start);
    // Everything is cut on BYTES, never on the decoded string: a window that
    // opens inside a multibyte character decodes it as U+FFFD (three bytes
    // re-encoded for each one or two it stood for), so an offset measured on
    // the string drifted past the next line's start and that record was lost.
    // The bytes after the last newline (a line still being written) are left
    // on disk for the next read, which starts there.
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return { records: [], offset: start, size, anchored: true };
    const consumed = lastNewline + 1;
    // A first read from mid-file drops its torn leading line; `skip` is where
    // the whole lines begin.
    let skip = 0;
    if (first && start > 0) skip = buffer.indexOf(0x0a) + 1;
    let records = parseLines(buffer.subarray(skip, consumed).toString('utf8'));
    let anchored = true;
    const need = first && start > 0
      ? { anchor: !records.some(isTurnAnchor), context: !records.some((record) => record?.type === 'turn_context') }
      : null;
    if (need && (need.anchor || need.context) && scanBytes > 0) {
      const back = scanBackForTurn(handle, start + skip, { scanBytes, need });
      // concat, not unshift(...): a spread of a long array overflows the stack.
      records = back.records.concat(records);
      if (need.anchor) anchored = back.anchor;
    } else if (need?.anchor) {
      anchored = false;
    }
    return { records, offset: start + consumed, size, anchored };
  } finally {
    fs.closeSync(handle);
  }
}

// The permission posture a Codex session is ACTUALLY running under, in the
// readback keys session-send already returns for Claude (permission-modes.cjs),
// plus `read-only` for the sandbox Claude has no equivalent of. A pane Harbor
// launched with --dangerously-bypass-approvals-and-sandbox used to read
// "default" here, because the Claude footer scrape found no mode text.
function codexPermissionMode(state) {
  if (!state || (!state.approvalPolicy && !state.sandboxPolicy)) return null;
  const detail = { approvalPolicy: state.approvalPolicy, sandbox: state.sandboxPolicy, reviewer: state.reviewer };
  if (state.approvalPolicy === 'never' && state.sandboxPolicy === 'danger-full-access') return { mode: 'bypass', detail };
  if (state.reviewer && state.reviewer !== 'user') return { mode: 'auto', detail };
  if (state.sandboxPolicy === 'read-only') return { mode: 'read-only', detail };
  return { mode: 'default', detail };
}

function readCodexState(filePath, options = {}) {
  return foldCodexRecords(readRolloutSlice(filePath, options).records);
}

module.exports = {
  initialState,
  foldCodexRecord,
  foldCodexRecords,
  readRolloutSlice,
  scanBackForTurn,
  isTurnAnchor,
  readCodexState,
  codexPermissionMode,
};
