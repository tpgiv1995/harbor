'use strict';

// Where a codex rollout lives and how it is read, in ONE place. Codex keeps a
// session as <home>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl, compresses it
// to .jsonl.zst once it is about a week old, and moves an archived chat to
// <home>/archived_sessions/. The rail (provider-history.js) and the Files view
// (artifacts.js) walk, rank and decompress through this module, so both see
// the same files the same way. It requires nothing from either caller.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');

// Electron 37's Node (22.21) has zstd; a runtime without it skips .zst files
// rather than failing the scan.
const zstdAvailable = () => typeof zlib.createZstdDecompress === 'function';
const isCompressed = (file) => String(file).endsWith('.zst');

const CODEX_ID_RE = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl(\.zst)?$/i;

// sessions/YYYY/MM/DD/ (depth 3) and archived_sessions/ (flat today, walked to
// the same depth in case codex dates it too). `visit(file, id)` is awaited for
// every rollout this runtime can read.
async function walkRollouts(dir, depth, visit) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) await walkRollouts(full, depth - 1, visit);
      continue;
    }
    const id = entry.name.match(CODEX_ID_RE)?.[1];
    if (!id) continue;
    if (isCompressed(entry.name) && !zstdAvailable()) continue;
    await visit(full, id);
  }
}

// One file per codex id. A resumed archived chat can leave the old copy
// behind, and a compressed rollout can sit beside a fresh plain one: the
// active (non-archived) plain file is the one codex itself appends to.
const rolloutRank = ({ archived = false, compressed = false } = {}) => (archived ? 2 : 0) + (compressed ? 1 : 0);

// A readable stream of the rollout's JSONL, decompressed when it is .zst.
// Destroying the returned stream releases the file as well.
function createRolloutReadStream(file, { end } = {}) {
  if (!isCompressed(file)) return fs.createReadStream(file, end == null ? {} : { end });
  if (!zstdAvailable()) throw new Error('this runtime cannot decompress zstd');
  const raw = fs.createReadStream(file);
  const stream = raw.pipe(zlib.createZstdDecompress());
  raw.on('error', (error) => stream.destroy(error));
  stream.on('close', () => raw.destroy());
  return stream;
}

// Decompress a .jsonl.zst rollout into `temporary`; the caller renames it into
// place, so a reader never sees a half-written copy.
async function decompressRollout(file, temporary) {
  await pipeline(fs.createReadStream(file), zlib.createZstdDecompress(), fs.createWriteStream(temporary, { mode: 0o600 }));
}

const COPY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const COPY_RE = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i;

// Prune a directory of decompressed copies. A copy is a whole rollout
// (megabytes to hundreds of them), so nothing may let them pile up: a copy
// unused for `maxAgeMs` goes, then the least recently used until the directory
// fits in `maxBytes`, plus a crashed decompression's leftover .tmp. `keep`
// holds paths in use. Use is the later of atime and ctime (ctime is when the
// copy was made; its mtime is the SOURCE's, carried over on purpose).
async function pruneRolloutCopies(dir, {
  keep = new Set(), maxAgeMs = COPY_MAX_AGE_MS, maxBytes = COPY_MAX_BYTES, now = Date.now,
} = {}) {
  const removed = [];
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return { removed, bytes: 0 }; }
  const at = now();
  const drop = async (file) => {
    try { await fsp.unlink(file); removed.push(file); return true; } catch { return false; /* raced or gone */ }
  };
  const survivors = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let stat;
    try { stat = await fsp.lstat(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if (name.endsWith('.tmp')) {
      if (at - stat.mtimeMs > TEMP_MAX_AGE_MS) await drop(file);
      continue;
    }
    if (!COPY_RE.test(name)) continue;
    const usedMs = Math.max(stat.atimeMs, stat.ctimeMs);
    if (keep.has(file)) { survivors.push({ file, size: stat.size, usedMs, kept: true }); continue; }
    if (at - usedMs > maxAgeMs) { await drop(file); continue; }
    survivors.push({ file, size: stat.size, usedMs, kept: false });
  }
  let bytes = survivors.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of survivors.filter((e) => !e.kept).sort((a, b) => a.usedMs - b.usedMs)) {
    if (bytes <= maxBytes) break;
    if (await drop(entry.file)) bytes -= entry.size;
  }
  return { removed, bytes };
}

module.exports = {
  CODEX_ID_RE,
  zstdAvailable,
  isCompressed,
  walkRollouts,
  rolloutRank,
  createRolloutReadStream,
  decompressRollout,
  pruneRolloutCopies,
  COPY_MAX_AGE_MS,
  COPY_MAX_BYTES,
};
