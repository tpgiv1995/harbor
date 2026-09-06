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

function defaultReadTail(filePath, bytes) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const { size } = fs.fstatSync(handle);
    const start = Math.max(0, size - bytes);
    const length = size - start;
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, start);
    // A tail read lands mid-record; drop the partial first line rather than
    // letting a half-cut tool_use parse into a question that was never asked.
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(handle);
  }
}

function createPendingAskReader(options = {}) {
  const tailBytes = options.tailBytes ?? TAIL_BYTES;
  const readTail = options.readTail ?? defaultReadTail;
  const stat = options.stat ?? ((p) => fs.statSync(p));
  const cache = new Map(); // path -> { size, mtimeMs, ask }

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
  const read = (filePath) => {
    if (!filePath) return null;
    try {
      const info = stat(filePath);
      const hit = cache.get(filePath);
      if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.ask;
      const ask = parse(readTail(filePath, tailBytes));
      cache.set(filePath, { size: info.size, mtimeMs: info.mtimeMs, ask });
      return ask;
    } catch {
      return null;
    }
  };

  return { read, forget: (filePath) => cache.delete(filePath) };
}

module.exports = { createPendingAskReader, TAIL_BYTES };
