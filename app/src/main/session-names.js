'use strict';

// CUSTOM SESSION NAMES (2026-11-15, Pat: "can you add a feature that lets me
// rename session/chat names in harbor? like a little pencil icon where i could
// type in a custom title").
//
// A name is Harbor's own record, kept beside config.json, and never written
// into the session: Claude Code's `/rename` would have to be TYPED into a live
// session, which wakes a sleeping one and bills its plan for a turn, and Codex
// and Cursor have no such command at all. A name here costs nothing, works for
// every provider and every state (live, asleep, ended), and outranks every
// automatic title (the Haiku titler, the CLI's own summary, the first prompt).
// An empty name removes the record, and the automatic title comes back.
//
// Both composition roots that build a rail (the app and the phone server)
// read the same file and watch it, so a rename made in one shows in the other.
// A bridge given no file has no names at all: a test or harness never reaches
// the real one by default.

const fs = require('node:fs');
const path = require('node:path');

const NAME_MAX = 120;
const FILE_VERSION = 1;

function cleanSessionName(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, NAME_MAX).trim();
}

// `{ v, names: { <sessionId>: { title, at } } }`. Anything unreadable is no
// names (never an exception into the rail), and an entry without a usable
// title is dropped rather than shown blank.
function parseSessionNames(text) {
  let data;
  try { data = JSON.parse(text); } catch { return {}; }
  const raw = data && typeof data === 'object' && data.names && typeof data.names === 'object' ? data.names : {};
  const names = {};
  for (const [id, entry] of Object.entries(raw)) {
    const title = cleanSessionName(typeof entry === 'string' ? entry : entry?.title);
    if (id && title) names[id] = { title, at: typeof entry?.at === 'string' ? entry.at : null };
  }
  return names;
}

function readSessionNames(file, fsImpl = fs) {
  if (!file) return {};
  try { return parseSessionNames(fsImpl.readFileSync(file, 'utf8')); } catch { return {}; }
}

// A replace over an existing file fails on Windows while another handle holds
// it (EPERM/EBUSY/EACCES), and the phone server may be reading it right then,
// so the rename is retried briefly before it is called a failure.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_MS = [25, 50, 100, 200];
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function writeSessionNames(file, names, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(temporary, `${JSON.stringify({ v: FILE_VERSION, names }, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try { fsImpl.renameSync(temporary, file); return; }
    catch (error) {
      if (!RETRY_CODES.has(error?.code) || attempt >= RETRY_MS.length) {
        try { fsImpl.rmSync(temporary, { force: true }); } catch { /* best effort */ }
        throw error;
      }
      sleepSync(RETRY_MS[attempt]);
    }
  }
}

// Read, change one entry, write: the file on disk is the truth, so a rename
// made in the other process since this one last read it is kept.
function setSessionName(file, sessionId, title, { fsImpl = fs, now = () => new Date() } = {}) {
  if (!file) throw new Error('session names are not available in this Harbor');
  const id = String(sessionId || '');
  if (!id || id.startsWith('pane:') || id.startsWith('live:')) {
    throw new Error('this session has no lasting id yet, so it cannot be renamed until its first message lands');
  }
  const names = readSessionNames(file, fsImpl);
  const clean = cleanSessionName(title);
  if (clean) names[id] = { title: clean, at: now().toISOString() };
  else delete names[id];
  writeSessionNames(file, names, fsImpl);
  return { names, title: clean || null };
}

// The rows the rail is built from, with each named session's title swapped in.
// Only a renamed row is copied, so the common case allocates one array.
// Orchestration child tasks keep their `BATCH TITLE:` title: the rail detects
// them by that prefix, and they are read-only machine rows.
function applySessionNames(rows, names) {
  if (!names || !Object.keys(names).length) return rows;
  return rows.map((row) => {
    const title = names[row?.id]?.title;
    if (!title || String(row.title || '').trimStart().startsWith('BATCH TITLE:')) return row;
    return { ...row, title, autoTitle: row.title ?? null };
  });
}

module.exports = {
  NAME_MAX,
  cleanSessionName,
  parseSessionNames,
  readSessionNames,
  writeSessionNames,
  setSessionName,
  applySessionNames,
};
