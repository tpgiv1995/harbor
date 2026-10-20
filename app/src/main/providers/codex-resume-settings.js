'use strict';

// WHAT A RESUMED CODEX SESSION RAN WITH, in ONE place, for both readers:
// bin/ai (whatever `node` is on PATH) and Harbor's main process (Electron's own
// Node). `codex resume <id>` with no -m / -c comes back on the home's DEFAULT
// model and effort, not the session's, and Harbor used to resume every codex
// session under the bypass flag whatever it had been started with. The rollout
// records all three on every turn (turn_context: model, effort,
// approval_policy, approvals_reviewer, sandbox_policy), so the LAST
// turn_context is the session's current truth.
//
// Main reads it as well as bin/ai because a compressed (.jsonl.zst) rollout
// needs zlib's zstd, which Node has only from 22.15 (23.8 on the 23 line).
// Electron's Node has it; the system node bin/ai runs on may not. Main hands
// bin/ai all three flags plus --recorded, and bin/ai's own read stays as the
// fallback and for a terminal `ai --resume-id`.

const fs = require('node:fs');
const { findCodexRollout } = require('./provider-session-link.js');
const { isCompressed, zstdAvailable, createRolloutReadStream } = require('./codex-rollout-files.js');
const { codexPermissionFromPolicy } = require('../../shared/codex-permission.cjs');

// A model or effort travels into argv, so only a plain slug is kept.
const CODEX_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TURN_CONTEXT_MARK = Buffer.from('"turn_context"');

const parseTurnContext = (line) => {
  try {
    const row = JSON.parse(Buffer.isBuffer(line) ? line.toString('utf8') : line);
    return row?.type === 'turn_context' && row.payload && typeof row.payload === 'object' ? row.payload : null;
  } catch {
    return null; // a torn or foreign line: keep looking
  }
};

// A plain rollout is read from its END in chunks, because a long rollout is
// megabytes and the record wanted is near the tail; the cap only bounds a file
// with no turn_context at all.
function lastCodexTurnContext(file, { chunkBytes = 256 * 1024, maxBytes = 32 * 1024 * 1024, strict = false } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) {
    if (strict) throw error;
    return null;
  }
  try {
    let end = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let scanned = 0;
    while (end > 0 && scanned < maxBytes) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      scanned += chunk.length;
      const buf = Buffer.concat([chunk, carry]);
      // Every line but the first is whole; the first is whole only at offset 0.
      const lines = [];
      let lineEnd = buf.length;
      for (let at = buf.lastIndexOf(0x0a, lineEnd - 1); at >= 0; at = buf.lastIndexOf(0x0a, at - 1)) {
        lines.push(buf.subarray(at + 1, lineEnd));
        lineEnd = at;
        if (at === 0) break;
      }
      carry = buf.subarray(0, lineEnd);
      if (start === 0) { lines.push(carry); carry = Buffer.alloc(0); }
      for (const line of lines) {
        if (line.indexOf(TURN_CONTEXT_MARK) < 0) continue;
        const payload = parseTurnContext(line);
        if (payload) return payload;
      }
      end = start;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// A compressed rollout cannot be read from its end, so it is streamed once
// through the decompressor and the LAST turn_context kept. Nothing is written
// to disk, and the scan stays in bytes: only a line carrying the mark is ever
// decoded (a long rollout is tens of MB of tool output). Codex never appends
// to a compressed rollout, so this is a cold file, read once per resume. A
// stream or decompression error THROWS: the caller refuses or falls back.
async function lastCompressedCodexTurnContext(file) {
  const stream = createRolloutReadStream(file);
  let carry = Buffer.alloc(0);
  let last = null;
  const take = (line) => {
    if (line.indexOf(TURN_CONTEXT_MARK) < 0) return;
    const payload = parseTurnContext(line);
    if (payload) last = payload;
  };
  try {
    for await (const chunk of stream) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let from = 0;
      for (let at = buf.indexOf(0x0a, from); at >= 0; at = buf.indexOf(0x0a, from)) {
        take(buf.subarray(from, at));
        from = at + 1;
      }
      // A turn_context row names itself in its first bytes
      // (`{"timestamp":…,"type":"turn_context",…`), so a partial line with no
      // mark in its first 4 KB is not one, and only a stub of it is carried
      // (a line can be MBs of tool output; the stub can never parse).
      const rest = buf.subarray(from);
      carry = rest.length < 4096 || rest.subarray(0, 4096).indexOf(TURN_CONTEXT_MARK) >= 0
        ? Buffer.from(rest)
        : Buffer.from(rest.subarray(0, 64));
    }
    if (carry.length) take(carry);
  } finally {
    stream.destroy();
  }
  return last;
}

// Model, effort and permission mode as recorded. Values travel into argv, so a
// model or effort that is not a plain slug is dropped rather than quoted.
function codexRecordedSettings(turnContext) {
  if (!turnContext) return { model: '', effort: '', permission: null };
  const model = CODEX_SLUG_RE.test(String(turnContext.model || '')) ? String(turnContext.model) : '';
  const effort = CODEX_SLUG_RE.test(String(turnContext.effort || '')) ? String(turnContext.effort) : '';
  const permission = codexPermissionFromPolicy({
    approvalPolicy: turnContext.approval_policy,
    approvalsReviewer: turnContext.approvals_reviewer,
    sandboxPolicy: turnContext.sandbox_policy,
  });
  return { model, effort, permission };
}

const ZSTD_NEEDS = 'zstd needs Node 22.15+ (or 23.8+)';

// The rollout is found wherever codex keeps it: sessions/ plain or .jsonl.zst,
// or archived_sessions/ (findCodexRollout). A rollout that cannot be found or
// read THROWS one line naming why, because resuming it on defaults could hand
// a session that ran Read-only or Ask full access. A rollout that is read but
// names no single mode answers a null permission (the caller resumes on the
// default, as before).
async function readCodexResumeSettings(resumeId, codexHome, { zstd = zstdAvailable } = {}) {
  const refuse = (why) => new Error(`cannot resume codex session ${resumeId}: ${why}; `
    + 'the model, effort and permission mode it ran with are unknown, so Harbor is refusing rather than resuming it on the defaults '
    + '(pass --model, --effort and --permission to choose them)');
  const detail = (error) => String(error?.message || error).replace(/\s+/g, ' ').trim();
  let file;
  try {
    file = await findCodexRollout(resumeId, { codexHome });
  } catch (error) {
    throw refuse(`its rollout could not be looked up under ${codexHome} (${detail(error)})`);
  }
  if (!file) throw refuse(`no rollout for it under ${codexHome} (sessions/ or archived_sessions/)`);
  if (isCompressed(file) && !zstd()) {
    throw refuse(`its rollout ${file} is zstd-compressed and this node (${process.version} at ${process.execPath}) `
      + `cannot decompress it (${ZSTD_NEEDS}; put a newer node first on PATH)`);
  }
  let turnContext;
  try {
    turnContext = isCompressed(file) ? await lastCompressedCodexTurnContext(file) : lastCodexTurnContext(file, { strict: true });
  } catch (error) {
    throw refuse(`its rollout ${file} could not be read (${detail(error)})`);
  }
  return codexRecordedSettings(turnContext);
}

module.exports = {
  CODEX_SLUG_RE,
  lastCodexTurnContext,
  lastCompressedCodexTurnContext,
  codexRecordedSettings,
  readCodexResumeSettings,
};
