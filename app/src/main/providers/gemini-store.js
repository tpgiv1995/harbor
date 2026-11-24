'use strict';

// Google's Antigravity CLI (`agy`, Gemini models) keeps every conversation
// under one store per Windows profile:
//
//   <profile>\.gemini\antigravity-cli\
//     brain\<uuid>\.system_generated\logs\transcript_full.jsonl   the record (one JSON step per line, nothing cut)
//     conversation_summaries.db                                   sqlite: title, workspace_uris, parent, status
//     annotations\<uuid>.pbtxt                                    written by the INTERACTIVE TUI only
//     history.jsonl                                               interactive TUI only, one line per prompt
//     cache\last_conversations.json                               { "<cwd>": "<latest conversation id>" }
//
// This module is the Node-only reader for everything around the transcript
// that the rail needs and the transcript itself does not hold: the folder a
// conversation started in, and whether a person typed it (a print-mode `agy -p`
// run lands in the SAME store with the SAME records). Nothing here spawns a
// process, and nothing here writes. Measured 2026-11-23 against agy 1.5.14:
//
//  - The transcript holds no cwd. `conversation_summaries.workspace_uris` holds
//    the folder it STARTED in (a resume from another folder keeps the first).
//  - A print-mode run writes NO annotations file and NO history.jsonl line, and
//    its summaries title is empty; every interactive conversation gets an
//    annotations file about a second after its first prompt.
//  - A sub-agent's summaries row has agent_name 'self', nesting_depth 1 and a
//    parent_conversation_id.
//
// node:sqlite is used only when the runtime has it (Electron 37's main process
// and Node 22.13+ do; proven read-only against a WAL database another process
// held open). Without it the folder falls back to history.jsonl and
// last_conversations.json, and the answers get thinner, never wrong.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSCRIPT_PARTS = ['.system_generated', 'logs', 'transcript_full.jsonl'];

// <profile root> -> that profile's Antigravity store.
function geminiStoreRoot(profileRoot) {
  return path.join(profileRoot, '.gemini', 'antigravity-cli');
}

function geminiTranscriptPath(storeRoot, id) {
  return path.join(storeRoot, 'brain', id, ...TRANSCRIPT_PARTS);
}

// The stores Harbor lists: the machine's real profile (an interactive session
// runs with USERPROFILE unchanged), then each Gemini profile that names another
// root. A profile's configHome is the USERPROFILE its sessions run under, so its
// store is <configHome>\.gemini\antigravity-cli. Never a headless worker's
// home: nothing names it here, and a home that does not exist lists nothing.
function geminiStoresFor({ homedir, profiles = [], roots = null } = {}) {
  if (roots) return roots.map((item) => (typeof item === 'string' ? { root: item, profileId: null, configHome: null } : item));
  const out = [];
  const seen = new Set();
  const add = (root, profileId, configHome) => {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ root, profileId, configHome });
  };
  if (homedir) add(geminiStoreRoot(homedir), null, null);
  for (const profile of profiles || []) {
    if (profile?.provider !== 'gemini' || !profile.configHome) continue;
    add(geminiStoreRoot(profile.configHome), profile.id ?? null, profile.configHome);
  }
  return out;
}

// What a person typed, out of the step's `<USER_REQUEST>` wrapper. agy appends
// ADDITIONAL_METADATA (local time) and, on the first prompt after a model
// change, USER_SETTINGS_CHANGE; neither is the person's words.
function unwrapUserRequest(content) {
  const text = String(content ?? '');
  const framed = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  if (framed) return framed[1].trim();
  // No frame: strip the known metadata sections and keep what is left.
  return text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .trim();
}

// file:///C:/work/x -> C:\work\x (and posix paths unchanged). A malformed URI is no folder.
function workspaceFromUri(uri) {
  try {
    const value = String(uri || '');
    if (!/^file:/i.test(value)) return null;
    return fileURLToPath(value);
  } catch { return null; }
}

// ---- node:sqlite, only when present, without its experimental-feature warning ----
let sqliteModule; // undefined: not tried; null: unavailable
function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  const emit = process.emitWarning;
  try {
    // The warning is printed once per process the first time the module loads;
    // Harbor is not experimenting, so drop exactly that one.
    process.emitWarning = (warning, ...rest) => {
      if (/SQLite is an experimental feature/i.test(String(warning?.message || warning))) return;
      return emit.call(process, warning, ...rest);
    };
    sqliteModule = require('node:sqlite');
  } catch { sqliteModule = null; } finally { process.emitWarning = emit; }
  return sqliteModule;
}

// Rows of conversation_summaries as Map(id -> facts), or null when the database
// is absent, locked or unreadable (the caller keeps what it last had). Read-only.
function readSummaries(dbFile, sqlite = loadSqlite()) {
  if (!sqlite) return null;
  let db;
  try {
    db = new sqlite.DatabaseSync(dbFile, { readOnly: true, timeout: 1500 });
    const rows = db.prepare('SELECT conversation_id, title, workspace_uris, source, agent_name, parent_conversation_id, nesting_depth FROM conversation_summaries').all();
    const out = new Map();
    for (const row of rows) {
      if (!UUID_RE.test(String(row.conversation_id || ''))) continue;
      let cwd = null;
      try {
        const uris = JSON.parse(row.workspace_uris || '[]');
        for (const uri of Array.isArray(uris) ? uris : []) { cwd = workspaceFromUri(uri); if (cwd) break; }
      } catch { /* no folder recorded */ }
      out.set(String(row.conversation_id).toLowerCase(), {
        title: String(row.title || '').trim(),
        cwd,
        parent: String(row.parent_conversation_id || '').trim() || null,
        depth: Number(row.nesting_depth) || 0,
        agent: String(row.agent_name || '').trim() || null,
        source: String(row.source || '').trim() || null,
      });
    }
    return out;
  } catch { return null; } finally { try { db?.close(); } catch { /* already closed */ } }
}

// history.jsonl: one line per prompt or slash command of the interactive TUI.
// The first prompt of a session is written before its conversation exists, so
// that line has no id; later lines do. Id -> the folder of its FIRST line.
function parseHistory(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const id = String(record?.conversationId || '').toLowerCase();
    if (!UUID_RE.test(id) || out.has(id)) continue;
    out.set(id, typeof record.workspace === 'string' && record.workspace ? record.workspace : null);
  }
  return out;
}

// cache/last_conversations.json is { cwd: latest id }: it names the folder of
// each folder's newest conversation only. A weaker source than the summaries
// row, used to fill folders it did not name.
function parseLastConversations(text) {
  const out = new Map();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      for (const [cwd, id] of Object.entries(parsed)) {
        const key = String(id || '').toLowerCase();
        if (UUID_RE.test(key) && cwd) out.set(key, cwd);
      }
    }
  } catch { /* unreadable */ }
  return out;
}

function sig(stat) { return stat ? `${stat.size}:${stat.mtimeMs}` : ''; }

// Everything about one store that is not in its transcripts, re-read only when
// the file it came from changed (size + mtime), and the database at most every
// minIntervalMs while agy keeps writing it.
function createStoreMeta({ root, minIntervalMs = 2000, now = Date.now, sqlite } = {}) {
  const dbFile = path.join(root, 'conversation_summaries.db');
  const walFile = `${dbFile}-wal`;
  const historyFile = path.join(root, 'history.jsonl');
  const lastFile = path.join(root, 'cache', 'last_conversations.json');
  const annotationsDir = path.join(root, 'annotations');
  const state = {
    summaries: null, summariesSig: null, summariesAt: -Infinity,
    history: new Map(), historySig: null,
    last: new Map(), lastSig: null,
    annotated: new Set(), annotationsSig: null,
  };
  const statOf = (file) => fsp.stat(file).catch(() => null);

  async function refresh() {
    // The summaries database: a read is a few milliseconds, but agy rewrites the
    // WAL on every step, so a busy session would re-read on every rail pass.
    const [dbStat, walStat] = await Promise.all([statOf(dbFile), statOf(walFile)]);
    const dbSig = `${sig(dbStat)}|${sig(walStat)}`;
    if (dbStat && (dbSig !== state.summariesSig) && now() - state.summariesAt >= minIntervalMs) {
      const read = readSummaries(dbFile, sqlite);
      state.summariesAt = now();
      if (read) { state.summaries = read; state.summariesSig = dbSig; }
    } else if (!dbStat) { state.summaries = null; state.summariesSig = null; }

    const historyStat = await statOf(historyFile);
    if (sig(historyStat) !== state.historySig) {
      state.history = historyStat ? parseHistory(await fsp.readFile(historyFile, 'utf8').catch(() => '')) : new Map();
      state.historySig = sig(historyStat);
    }
    const lastStat = await statOf(lastFile);
    if (sig(lastStat) !== state.lastSig) {
      state.last = lastStat ? parseLastConversations(await fsp.readFile(lastFile, 'utf8').catch(() => '')) : new Map();
      state.lastSig = sig(lastStat);
    }
    // A folder's mtime moves when a file is added: one readdir per change.
    const annStat = await statOf(annotationsDir);
    if (sig(annStat) !== state.annotationsSig) {
      const names = annStat ? await fsp.readdir(annotationsDir).catch(() => []) : [];
      state.annotated = new Set(names.map((name) => /^([0-9a-f-]{36})\.pbtxt$/i.exec(name)?.[1]?.toLowerCase()).filter(Boolean));
      state.annotationsSig = sig(annStat);
    }
    return state;
  }

  // The facts for one conversation id (any case), from every source there is.
  function factsFor(id) {
    const key = String(id).toLowerCase();
    const row = state.summaries?.get(key) || null;
    const cwd = row?.cwd || state.history.get(key) || state.last.get(key) || null;
    // A person typed it when ANY interactive-only trace names it. A title the
    // summaries row carries is one too: a print-mode run's title stays empty.
    const interactive = state.annotated.has(key) || state.history.has(key) || Boolean(row?.title);
    return {
      cwd,
      interactive,
      parentId: row?.parent || null,
      subAgent: Boolean(row && (row.parent || row.depth > 0)),
      title: row?.title || null,
      known: Boolean(row),
    };
  }

  return { refresh, factsFor, state, paths: { dbFile, historyFile, lastFile, annotationsDir } };
}

module.exports = {
  UUID_RE, geminiStoreRoot, geminiTranscriptPath, geminiStoresFor, unwrapUserRequest, workspaceFromUri,
  loadSqlite, readSummaries, parseHistory, parseLastConversations, createStoreMeta,
};
