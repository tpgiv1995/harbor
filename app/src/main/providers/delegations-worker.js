'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createBackgroundState, applyBackgroundLine, backgroundSnapshot, interestingLine } = require('./background-tasks.js');
const { readSessionOwner } = require('./session-owner.js');
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

// THE FOLD RESUMES WHERE IT STOPPED, ACROSS RESTARTS (2026-10-09). Each file's
// fold (byte offset, background state, codex signal) lived only in this
// worker's memory, so every launch re-read every transcript active in the last
// 48 hours from byte 0: 116 files, 1.4GB, 13s measured, and the window waits on
// it. With a cache file the entries are loaded once and saved after any pass
// that moved them, so a launch reads only what was appended since. The format
// is a hash of the code that produced the entries (this file and the fold), so
// a changed fold rule rebuilds from byte 0 by itself.
const FOLD_FORMAT = (() => {
  const hash = require('node:crypto').createHash('sha1');
  for (const file of [__filename, require.resolve('./background-tasks.js')]) {
    try { hash.update(fs.readFileSync(file)); } catch { hash.update(file); }
  }
  return hash.digest('hex').slice(0, 16);
})();

function createScanner() {
  const files = new Map();
  const touched = new Set();
  let dirty = false;
  async function scan(file, provider = 'claude') {
    touched.add(file);
    const stat = await fsp.stat(file);
    let entry = files.get(file);
    if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) return entry;
    dirty = true;
    if (!entry || stat.size <= entry.size || stat.ino !== entry.ino) entry = { offset: 0, state: createBackgroundState(), signal: {} };
    // The final partial line is held by
    // offset, then read again on append, including split UTF-8 and huge lines.
    let bytes = entry.offset;
    const handle = await fsp.open(file, 'r');
    let carry = []; let carryBytes = 0;
    try {
      while (bytes < stat.size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - bytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
        if (!bytesRead) break;
        bytes += bytesRead;
        const data = buffer.subarray(0, bytesRead);
        let start = 0; let end;
        while ((end = data.indexOf(10, start)) >= 0) {
          const piece = data.subarray(start, end);
          const line = carry.length ? Buffer.concat([...carry, piece], carryBytes + piece.length).toString('utf8') : piece.toString('utf8');
          carry = []; carryBytes = 0; start = end + 1;
          if (provider === 'claude' ? !interestingLine(line) : !line.includes('event_msg') && !line.includes('turn_context')) continue;
          let row; try { row = JSON.parse(line); } catch { continue; }
          if (provider === 'claude') applyBackgroundLine(entry.state, row);
          else {
            const ms = Date.parse(row.timestamp) || 0;
            entry.signal.lastSignalMs = Math.max(entry.signal.lastSignalMs || 0, ms);
            if (row.type === 'turn_context' && row.payload?.model) entry.signal.model = row.payload.model;
            if (row.type === 'event_msg' && row.payload?.type === 'task_started') { entry.signal.working = true; entry.signal.startedMs = ms; }
            if (row.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(row.payload?.type)) {
              Object.assign(entry.signal, { working: false, endedMs: ms, outcome: row.payload.type === 'turn_aborted' ? 'stopped' : 'done' });
            }
          }
        }
        if (start < data.length) { carry.push(data.subarray(start)); carryBytes += data.length - start; }
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally { await handle.close(); }
    Object.assign(entry, { offset: bytes - carryBytes, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
    files.set(file, entry);
    return entry;
  }
  // Seeded once from disk; a missing, unreadable or other-format file seeds
  // nothing and the first pass reads from byte 0, exactly as before.
  scan.load = (cacheFile) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (parsed?.format !== FOLD_FORMAT || !parsed.files || typeof parsed.files !== 'object') return;
      for (const [file, entry] of Object.entries(parsed.files)) {
        if (entry && Number.isFinite(entry.offset) && entry.state && entry.signal) files.set(file, entry);
      }
    } catch { /* first launch */ }
  };
  // Saves the entries this pass touched (a file that left the 48h window is
  // dropped with it). A failed write costs the next launch a reread, nothing more.
  scan.save = async (cacheFile) => {
    for (const file of [...files.keys()]) if (!touched.has(file)) { files.delete(file); dirty = true; }
    touched.clear();
    if (!dirty) return;
    dirty = false;
    // Serialized BEFORE the first await: the next pass can start the moment
    // this one yields, and it mutates entries in place as it folds, so a later
    // snapshot could pair one pass's state with another's offset.
    const body = JSON.stringify({ format: FOLD_FORMAT, files: Object.fromEntries(files) });
    const temporary = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(temporary, body);
      for (let attempt = 0; ; attempt += 1) {
        try { await fsp.rename(temporary, cacheFile); break; } catch (error) {
          if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    } catch {
      dirty = true;
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  };
  scan.endPass = () => touched.clear();
  return scan;
}
const scan = createScanner();
let loadedCacheFile = null;
async function scanRows(rows, liveIds = [], now = Date.now(), ownerOptions) {
  const live = new Set(liveIds); const parents = []; const providers = [];
  for (const row of rows) {
    if (!row.path) continue;
    if (row.provider === 'codex') {
      providers.push({ ...row, signal: {} });
    } else if (!row.provider || row.provider === 'claude') {
      if (!live.has(row.id) && Date.parse(row.lastActive) < now - RECENT_WINDOW_MS) continue;
      try {
        const entry = await scan(row.path);
        const ownerEvidence = { ...await readSessionOwner(row.id, ownerOptions), lastWriteMs: entry.mtimeMs };
        parents.push({ ...row, isLive: live.has(row.id), ownerEvidence, background: backgroundSnapshot(entry.state, now) });
      } catch { /* unreadable file is retried */ }
    }
  }
  // The window limits discovery, never evidence for an established link.
  // Resolve against metadata first, then include every linked descendant,
  // even when rows arrive in child-before-parent order or the root is absent.
  const { linkDispatches, buildDelegationGroups } = require('./delegations.js');
  const links = linkDispatches(parents, providers);
  const linked = new Set([...parents.map(p => p.id), ...Object.keys(links.delegatedBy)]);
  const children = new Map();
  for (const row of providers) {
    const parentId = row.lineage?.parentThreadId || row.delegatedBy;
    if (!parentId) continue;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(row.id);
  }
  const pending = [...linked];
  for (let i = 0; i < pending.length; i++) for (const id of children.get(pending[i]) || []) {
    if (!linked.has(id)) { linked.add(id); pending.push(id); }
  }
  for (const row of providers) {
    if (!linked.has(row.id) && !live.has(row.id) && !(row.lastWriteMs >= now - RECENT_WINDOW_MS)) continue;
    try {
      const entry = await scan(row.path, 'codex');
      row.signal = entry.signal; row.lastWriteMs = entry.mtimeMs;
    } catch { /* unreadable linked evidence remains unknown */ }
  }
  const built = buildDelegationGroups(parents, providers, now, links);
  return { parents, providers, built };
}
if (parentPort) parentPort.on('message', async ({ rows, liveIds, ownerOptions, cacheFile }) => {
  try {
    if (cacheFile && loadedCacheFile !== cacheFile) { scan.load(cacheFile); loadedCacheFile = cacheFile; }
    const result = await scanRows(rows, liveIds, Date.now(), ownerOptions);
    parentPort.postMessage(result);
    if (cacheFile) await scan.save(cacheFile);
    else scan.endPass();
  } catch (error) { parentPort.postMessage({ error: error.message }); }
});
module.exports = { createScanner, scanRows };
