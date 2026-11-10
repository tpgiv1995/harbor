'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { readCodexRolloutMeta, findCodexRollout } = require('./provider-session-link.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function homeFor(file) {
  const day = path.dirname(file), month = path.dirname(day), year = path.dirname(month), sessions = path.dirname(year);
  return /^\d{2}$/.test(path.basename(day)) && /^\d{2}$/.test(path.basename(month))
    && /^\d{4}$/.test(path.basename(year)) && path.basename(sessions) === 'sessions' ? path.dirname(sessions) : null;
}

async function prefixTail(file, end, budget) {
  const handle = await fs.open(file, 'r');
  try {
    if (end > (await handle.stat()).size) throw Error('fork boundary exceeds stored parent');
    const start = Math.max(0, end - budget), buffer = Buffer.alloc(end - start);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, start + count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    let data = buffer.subarray(0, count);
    if (start) {
      const before = Buffer.alloc(1); await handle.read(before, 0, 1, start - 1);
      if (before[0] !== 10) {
        const newline = data.indexOf(10);
        data = newline < 0 ? Buffer.alloc(0) : data.subarray(newline + 1);
      }
    }
    const records = [];
    for (const line of data.toString('utf8').split('\n')) { try { records.push(JSON.parse(line)); } catch {} }
    return { records, bytes: count };
  } finally { await handle.close(); }
}

// A paginated fork stores history_base instead of copying its parent's rows.
// Read only its immutable byte boundary, from the SAME config home. One total
// byte budget and an eight-parent cap bound a cold open; no parent watcher or
// periodic read is installed. Parent headers and liveness are not inherited.
async function readCodexInheritedHistory(file, { maxBytes = 1024 * 1024, maxDepth = 8,
  missingParents = new Set(), findParent = findCodexRollout } = {}) {
  const home = homeFor(file), chunks = [], seen = new Set([path.resolve(file)]);
  if (!home) return { records: [], bytes: 0, unavailable: false };
  let current = file, bytes = 0, unavailable = false;
  for (let depth = 0; depth < maxDepth && bytes < maxBytes; depth++) {
    const meta = await readCodexRolloutMeta(current, { history: true });
    if (!meta?.historyBase || !meta.forkedFromId || meta.lineage.parentThreadId
      || /^(?:subagent|guardian)/.test(meta.lineage.kind || '')) break;
    const { thread_id: parentId, end_byte_offset: end } = meta.historyBase;
    if (!UUID.test(parentId || '') || !Number.isSafeInteger(end) || end < 0) { unavailable = true; break; }
    if (missingParents.has(parentId)) { unavailable = true; break; }
    const parent = await findParent(parentId, { codexHome: home });
    if (!parent) { missingParents.add(parentId); unavailable = true; break; }
    if (seen.has(path.resolve(parent))) { unavailable = true; break; }
    seen.add(path.resolve(parent));
    try {
      const part = await prefixTail(parent, end, maxBytes - bytes);
      bytes += part.bytes; chunks.unshift(part.records); current = parent;
    } catch { unavailable = true; break; }
  }
  return { records: chunks.flat(), bytes, unavailable };
}

module.exports = { readCodexInheritedHistory };
