'use strict';

// The team chart's transcript tailer, off the main thread (2026-11-02).
//
// Main tells it which transcripts belong to LIVE members (`track`), never the
// whole projects tree. Each file is read from a saved byte offset: the first
// read takes only the last FIRST_READ_CAP bytes (transcripts pass 100 MB and a
// single Claude subagent log was 62 MB on the day this was written), later reads
// take only appended bytes, a shrink or a new file id restarts from the tail,
// and a partial last line is held back by offset and read again once complete.
// No whole-file read, ever (test/main/no-whole-transcript-read.test.js).
//
// Changes arrive by fs.watch on each tracked file and on the session's
// `subagents` folder. Windows watching can miss events on junctions and fast
// appends, so main also sends `rescan` on every pane event, which re-stats the
// tracked files only. There is no timer here.

const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createFold, applyLine, foldSnapshot } = require('./team-fold.js');

const FIRST_READ_CAP = 2 * 1024 * 1024;
const HELPER_FIRST_READ_CAP = 512 * 1024;
const CHUNK = 256 * 1024;
const MAX_CARRY = 32 * 1024 * 1024;
const HELPER_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEBOUNCE_MS = 150;

function createTailer({ firstReadCap = FIRST_READ_CAP } = {}) {
  const entries = new Map();
  async function read(file, provider) {
    const stat = await fsp.stat(file);
    let entry = entries.get(file);
    if (entry && (stat.ino !== entry.ino || stat.size < entry.offset)) entry = null;
    if (!entry) {
      entry = { offset: 0, ino: stat.ino, size: 0, mtimeMs: 0, fold: createFold(), fresh: true, birthMs: stat.birthtimeMs || stat.ctimeMs || null };
      entries.set(file, entry);
    }
    if (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) return { entry, changed: false };
    let start = entry.offset;
    let skipFirst = false;
    if (start === 0 && stat.size > firstReadCap) { start = stat.size - firstReadCap; skipFirst = true; }
    const handle = await fsp.open(file, 'r');
    let position = start;
    let carry = [];
    let carryBytes = 0;
    try {
      while (position < stat.size) {
        const buffer = Buffer.alloc(Math.min(CHUNK, stat.size - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        const data = buffer.subarray(0, bytesRead);
        let from = 0;
        let newline;
        while ((newline = data.indexOf(10, from)) >= 0) {
          const piece = data.subarray(from, newline);
          from = newline + 1;
          if (skipFirst) { skipFirst = false; carry = []; carryBytes = 0; continue; }
          const line = carry.length ? Buffer.concat([...carry, piece], carryBytes + piece.length).toString('utf8') : piece.toString('utf8');
          carry = []; carryBytes = 0;
          applyLine(entry.fold, line, provider);
        }
        if (from < data.length) {
          if (carryBytes + (data.length - from) > MAX_CARRY) { carry = []; carryBytes = 0; skipFirst = true; }
          else { carry.push(data.subarray(from)); carryBytes += data.length - from; }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally { await handle.close(); }
    Object.assign(entry, { offset: position - carryBytes, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
    return { entry, changed: true };
  }
  return { read, entries, forget: (file) => entries.delete(file) };
}

function subagentsDirFor(transcript) {
  const id = path.basename(transcript, '.jsonl');
  return path.join(path.dirname(transcript), id, 'subagents');
}

function createTeamWatcher({ post, watchImpl = fs.watch, now = () => Date.now() } = {}) {
  const tailer = createTailer();
  const helperTailer = createTailer({ firstReadCap: HELPER_FIRST_READ_CAP });
  const tracked = new Map(); // id -> { id, path, provider, watcher, helperWatcher, helperDir, helpers }
  const pending = new Set();
  let timer = null;
  let running = Promise.resolve();
  const changed = new Map();
  const events = [];

  const schedule = (id) => {
    pending.add(id);
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, DEBOUNCE_MS);
  };

  async function readHelpers(item) {
    const dir = item.helperDir || subagentsDirFor(item.path);
    let names;
    try { names = await fsp.readdir(dir); } catch { return false; }
    if (!item.helperDir) {
      item.helperDir = dir;
      try {
        item.helperWatcher = watchImpl(dir, () => schedule(item.id));
        item.helperWatcher.on?.('error', () => { try { item.helperWatcher.close(); } catch { /* gone */ } item.helperWatcher = null; });
      } catch { item.helperWatcher = null; }
    }
    const helpers = [];
    for (const name of names) {
      if (!/^agent-.+\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      const agentId = name.slice(6, -6);
      let stat;
      try { stat = await fsp.stat(file); } catch { continue; }
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(path.join(dir, `agent-${agentId}.meta.json`), 'utf8')); } catch { /* meta optional */ }
      if (meta.finished === true && now() - stat.mtimeMs > HELPER_WINDOW_MS) continue;
      if (meta.finished !== true && now() - stat.mtimeMs > HELPER_WINDOW_MS) continue;
      let fold = null;
      try { fold = (await helperTailer.read(file, 'claude')).entry.fold; } catch { /* unreadable */ }
      const snapshot = fold ? foldSnapshot(fold) : null;
      helpers.push({
        id: agentId,
        description: meta.description || null,
        agentType: meta.agentType || null,
        model: snapshot?.model || meta.model || null,
        finished: meta.finished === true,
        startedMs: stat.birthtimeMs || null,
        lastEventMs: snapshot?.lastEventMs || stat.mtimeMs,
        openTool: snapshot?.openTools?.[0] || null,
        working: Boolean(snapshot?.working),
      });
    }
    helpers.sort((a, b) => (b.lastEventMs || 0) - (a.lastEventMs || 0));
    const key = JSON.stringify(helpers);
    if (key === item.helpersKey) return false;
    item.helpersKey = key;
    item.helpers = helpers;
    return true;
  }

  async function refresh(item) {
    let result;
    try { result = await tailer.read(item.path, item.provider); } catch { return; }
    const { entry } = result;
    const before = item.counts || { turns: entry.fold.turnsEnded, steps: entry.fold.stepsEnded };
    const helpersChanged = item.provider === 'claude' ? await readHelpers(item) : false;
    if (!result.changed && !helpersChanged) return;
    const snapshot = foldSnapshot(entry.fold);
    if (!entry.fresh) {
      if (snapshot.turnsEnded > before.turns) events.push({ id: item.id, kind: 'turn-ended' });
      else if (snapshot.stepsEnded > before.steps) events.push({ id: item.id, kind: 'step-ended' });
    }
    entry.fresh = false;
    item.counts = { turns: snapshot.turnsEnded, steps: snapshot.stepsEnded };
    changed.set(item.id, { ...snapshot, helpers: item.helpers || [] });
  }

  function flush() {
    const ids = [...pending];
    pending.clear();
    running = running.then(async () => {
      for (const id of ids) { const item = tracked.get(id); if (item) await refresh(item); }
      if (!changed.size && !events.length) return;
      post({ type: 'facts', changed: Object.fromEntries(changed), events: events.splice(0) });
      changed.clear();
    }).catch(() => {});
  }

  function track(files) {
    const wanted = new Map((files || []).filter((file) => file?.id && file.path).map((file) => [file.id, file]));
    const removed = [];
    for (const [id, item] of tracked) {
      const next = wanted.get(id);
      if (next && next.path === item.path) continue;
      try { item.watcher?.close(); } catch { /* gone */ }
      try { item.helperWatcher?.close(); } catch { /* gone */ }
      tailer.forget(item.path);
      tracked.delete(id);
      if (!next) removed.push(id);
    }
    for (const [id, file] of wanted) {
      if (tracked.has(id)) continue;
      const item = { id, path: file.path, provider: file.provider === 'codex' ? 'codex' : 'claude', watcher: null, helperWatcher: null, helperDir: null, helpers: [] };
      try {
        item.watcher = watchImpl(file.path, () => schedule(id));
        item.watcher.on?.('error', () => { try { item.watcher.close(); } catch { /* gone */ } item.watcher = null; });
      } catch { item.watcher = null; }
      tracked.set(id, item);
      schedule(id);
    }
    if (removed.length) post({ type: 'facts', changed: {}, removed, events: [] });
  }

  function rescan() { for (const id of tracked.keys()) schedule(id); }

  function close() {
    clearTimeout(timer);
    for (const item of tracked.values()) {
      try { item.watcher?.close(); } catch { /* gone */ }
      try { item.helperWatcher?.close(); } catch { /* gone */ }
    }
    tracked.clear();
  }

  return { track, rescan, close, flushNow: () => { clearTimeout(timer); timer = null; flush(); return running; }, tracked };
}

if (parentPort) {
  const watcher = createTeamWatcher({ post: (message) => parentPort.postMessage(message) });
  parentPort.on('message', (message) => {
    if (message?.type === 'track') watcher.track(message.files);
    else if (message?.type === 'rescan') watcher.rescan();
    else if (message?.type === 'close') watcher.close();
  });
}

module.exports = { FIRST_READ_CAP, createTailer, createTeamWatcher, subagentsDirFor };
