'use strict';

// Where a codex rollout lives and how it is read, in ONE place. Codex keeps a
// session as $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl, can
// compress it to .jsonl.zst once it is old (`local_thread_store_compression`),
// and moves an archived chat to $CODEX_HOME/archived_sessions/. The resume
// lookup (provider-session-link findCodexRollout) walks all three through this
// module. It requires nothing from its callers, so no import can go circular.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

// zlib's zstd exists from Node 22.15 (23.8 on the 23 line). Electron's Node has
// it; a system node on PATH may not.
const zstdAvailable = () => typeof zlib.createZstdDecompress === 'function';
const isCompressed = (file) => String(file).endsWith('.zst');

const CODEX_ID_RE = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl(\.zst)?$/i;

// sessions/YYYY/MM/DD/ (depth 3) and archived_sessions/ (flat today, walked to
// the same depth in case codex dates it too). Entries are visited newest name
// first, so dated directories come newest-day first. `visit(file, id)` may
// return true to stop the walk; the walk then returns true. A compressed file
// is skipped when this runtime cannot decompress it, unless the caller asks to
// see it anyway (to report it as unreadable rather than absent).
async function walkRollouts(dir, depth, visit, { includeUndecompressable = false } = {}) {
  const entries = (await fsp.readdir(dir, { withFileTypes: true }).catch(() => []))
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && await walkRollouts(full, depth - 1, visit, { includeUndecompressable })) return true;
      continue;
    }
    const id = entry.name.match(CODEX_ID_RE)?.[1];
    if (!id) continue;
    if (isCompressed(entry.name) && !zstdAvailable() && !includeUndecompressable) continue;
    if (await visit(full, id)) return true;
  }
  return false;
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

module.exports = {
  CODEX_ID_RE,
  zstdAvailable,
  isCompressed,
  walkRollouts,
  rolloutRank,
  createRolloutReadStream,
};
