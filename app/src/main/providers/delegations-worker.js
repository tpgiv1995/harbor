'use strict';
const { parentPort } = require('node:worker_threads');
const fsp = require('node:fs/promises');
const { createBackgroundState, applyBackgroundLine, backgroundSnapshot, interestingLine } = require('./background-tasks.js');
const { readSessionOwner } = require('./session-owner.js');
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

function createScanner() {
  const files = new Map();
  return async function scan(file, provider = 'claude') {
    const stat = await fsp.stat(file);
    let entry = files.get(file);
    if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) return entry;
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
  };
}
const scan = createScanner();
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
if (parentPort) parentPort.on('message', async ({ rows, liveIds, ownerOptions }) => {
  try { parentPort.postMessage(await scanRows(rows, liveIds, Date.now(), ownerOptions)); } catch (error) { parentPort.postMessage({ error: error.message }); }
});
module.exports = { createScanner, scanRows };
