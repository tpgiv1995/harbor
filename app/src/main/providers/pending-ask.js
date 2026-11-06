'use strict';

// The live AskUserQuestion for a session, read STRAIGHT OFF THE TRANSCRIPT FILE.
//
// Why not the streaming tail. The transcript provider already parses every
// session it has open and remembers the live question as `parser.pendingAsk`,
// and that is what the question card read until 2026-07-27. It failed on Pat
// the same day it shipped, and the failure is structural rather than a bug in
// the parse: a value produced as a side effect of a streaming tail is only as
// current as the last read that landed. His window proved it in the same
// screenshot as the broken card, rendering the conversation as of 20:38:24
// while the question it was asking about had been written at 20:38:55.
//
// So the card no longer depends on a cache being current. It reads the file,
// which cannot lag, in about a millisecond:
//
//   * bounded to the TAIL, because a day-long session runs to tens of MB
//   * keyed on the file's own size+mtime, so a 700ms poll over an idle session
//     costs one stat
//   * newest tool_use whose tool_result has not arrived; an answered question
//     is not a live one
//
// The pty stays the authority on the live INTERACTION (is the dialog still up,
// which row the "❯" is on, what the footer offers). This is only the authority
// on WHAT WAS ASKED. See ask-question.js for how the two are merged.

const fs = require('node:fs');
const { normalizeAsk } = require('../ask-question.js');

// A question sits a long way above the tool results that follow it, and those
// results can be large. 1MB of tail covers the realistic gap while keeping a
// cold read to a few milliseconds.
const TAIL_BYTES = 1024 * 1024;

// The tail plus where its last complete line ends, so the next poll can read
// only what was appended after it.
function readTailInfo(filePath, bytes) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(handle);
    const start = Math.max(0, size - bytes);
    const length = size - start;
    if (length <= 0) return { text: '', completeTo: size };
    const buffer = Buffer.alloc(length);
    const got = fs.readSync(handle, buffer, 0, length, start);
    const view = got < length ? buffer.subarray(0, got) : buffer;
    const lastNewline = view.lastIndexOf(0x0a);
    // A tail read lands mid-record; drop the partial first line rather than
    // letting a half-cut tool_use parse into a question that was never asked.
    const text = view.toString('utf8');
    const completeTo = lastNewline >= 0 ? start + lastNewline + 1 : start;
    return {
      text: start > 0 ? text.slice(text.indexOf('\n') + 1) : text,
      completeTo,
      marks: continuityMarks(handle, completeTo),
    };
  } finally {
    fs.closeSync(handle);
  }
}

// What must still be in the file for "it only grew" to be true: its first
// bytes and the bytes just before where the last read stopped. A transcript
// replaced by a different, larger file fails one of them (Astra review
// 2026-11-06: a larger replacement with an open question above the old offset
// was read from the old offset and the question was never seen).
const MARK_BYTES = 256;
function continuityMarks(handle, completeTo) {
  // The file's identity first: a replacement (write-to-temp and rename, or a
  // delete and recreate) is a new file whatever bytes it shares with the old
  // one (Astra review round 2). Bigint so a Windows file index is exact.
  const { dev, ino } = fs.fstatSync(handle, { bigint: true });
  const identity = `${dev}:${ino}`;
  const headLength = Math.min(MARK_BYTES, completeTo);
  const head = Buffer.alloc(headLength);
  if (headLength) fs.readSync(handle, head, 0, headLength, 0);
  const beforeLength = Math.min(MARK_BYTES, completeTo);
  const before = Buffer.alloc(beforeLength);
  if (beforeLength) fs.readSync(handle, before, 0, beforeLength, completeTo - beforeLength);
  return { identity, head: head.toString('latin1'), before: before.toString('latin1') };
}

const ASK_NEEDLE = Buffer.from('"AskUserQuestion"');

// The complete lines appended since `from`: whether any of them names an
// AskUserQuestion, and where the last complete one ends. Never decodes the
// bytes. Returns null when more than `cap` bytes arrived (a full tail read is
// then no more work than this).
function readAppendedInfo(filePath, from, cap, marks = null) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(handle);
    const length = size - from;
    if (length < 0 || length > cap) return null;
    if (marks) {
      const now = continuityMarks(handle, from);
      if (now.identity !== marks.identity || now.head !== marks.head || now.before !== marks.before) return null; // not the same file grown
    }
    if (length === 0) return { mentionsAsk: false, completeTo: from, marks };
    const buffer = Buffer.alloc(length);
    const got = fs.readSync(handle, buffer, 0, length, from);
    const lastNewline = buffer.subarray(0, got).lastIndexOf(0x0a);
    if (lastNewline < 0) return { mentionsAsk: false, completeTo: from, marks };
    const complete = buffer.subarray(0, lastNewline + 1);
    const completeTo = from + lastNewline + 1;
    return { mentionsAsk: complete.indexOf(ASK_NEEDLE) >= 0, completeTo, marks: continuityMarks(handle, completeTo) };
  } finally {
    fs.closeSync(handle);
  }
}

function createPendingAskReader(options = {}) {
  const tailBytes = options.tailBytes ?? TAIL_BYTES;
  // An injected readTail returns text only, so its reads cannot be continued
  // from an offset: every change is a full tail read, as before.
  const readTail = options.readTail
    ? (p, bytes) => ({ text: options.readTail(p, bytes), completeTo: null, marks: null })
    : readTailInfo;
  const readAppended = options.readAppended ?? readAppendedInfo;
  // Bigint so the identity (dev:ino) is exact; a file swapped in with the same
  // size and mtime is still another file (Astra review round 3).
  const stat = options.stat ?? ((p) => {
    const info = fs.statSync(p, { bigint: true });
    return { size: Number(info.size), mtimeMs: String(info.mtimeNs), identity: `${info.dev}:${info.ino}` };
  });
  const cache = new Map(); // path -> { size, mtimeMs, ask, completeTo, marks }

  const parse = (text) => {
    // One pass, newest-last: remember every AskUserQuestion and every answered
    // tool id, then take the newest ask that was never answered.
    const asks = [];
    const answered = new Set();
    for (const line of text.split('\n')) {
      if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
      // Cheap pre-filter: parsing every line of a megabyte of tool output to
      // find two records is the difference between 1ms and 60ms per poll.
      const isAsk = line.includes('"AskUserQuestion"');
      const isResult = line.includes('"tool_result"');
      if (!isAsk && !isResult) continue;
      let obj = null;
      try { obj = JSON.parse(line); } catch { continue; }
      // Only conversation records count. Claude Code 2.1.300 also stores
      // copies of each API request (`api-request-blob`) whose messages carry the
      // same tool_use and tool_result parts; a copy is neither a question nor
      // an answer (2026-10-15).
      if (obj?.type && obj.type !== 'assistant' && obj.type !== 'user') continue;
      const content = obj?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'tool_use' && part.name === 'AskUserQuestion') {
          const questions = normalizeAsk(part.input);
          if (questions) asks.push({ toolId: part.id || null, questions });
        } else if (part.type === 'tool_result' && part.tool_use_id) {
          answered.add(part.tool_use_id);
        }
      }
    }
    for (let i = asks.length - 1; i >= 0; i -= 1) {
      if (!asks[i].toolId || !answered.has(asks[i].toolId)) return asks[i];
    }
    return null;
  };

  // Returns { toolId, questions } or null. Never throws: this runs inside a
  // poll, and a poll that throws is a card that disappears.
  //
  // A busy session appends to its transcript every second or so, and every
  // open window polls this about once a second, so "the file changed" is the
  // normal case, not the rare one. Re-reading and splitting a megabyte of tail
  // on each change cost every window a megabyte read and three megabytes of
  // garbage per poll on the main thread (2026-11-06). When no question is open,
  // the answer can only change if an appended line names an AskUserQuestion:
  // an older question in the tail was already answered, and its answer comes
  // after it. So the appended bytes are scanned for that name without being
  // decoded, and only a hit (or an open question, or a rewrite) re-reads.
  const read = (filePath) => {
    if (!filePath) return null;
    try {
      const info = stat(filePath);
      const hit = cache.get(filePath);
      if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs && hit.identity === info.identity) return hit.ask;
      if (hit && !hit.ask && hit.completeTo != null && hit.marks && info.size > hit.size && info.size >= hit.completeTo) {
        const appended = readAppended(filePath, hit.completeTo, tailBytes, hit.marks);
        if (appended && !appended.mentionsAsk) {
          cache.set(filePath, { size: info.size, mtimeMs: info.mtimeMs, identity: info.identity, ask: null, completeTo: appended.completeTo, marks: appended.marks });
          return null;
        }
      }
      const tail = readTail(filePath, tailBytes);
      const ask = parse(tail.text);
      cache.set(filePath, { size: info.size, mtimeMs: info.mtimeMs, identity: info.identity, ask, completeTo: tail.completeTo, marks: tail.marks });
      return ask;
    } catch {
      return null;
    }
  };

  return { read, forget: (filePath) => cache.delete(filePath) };
}

module.exports = { createPendingAskReader, TAIL_BYTES, readTailInfo, readAppendedInfo };
