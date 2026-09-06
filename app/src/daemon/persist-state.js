'use strict';

// A KEEPER MUST NEVER DIE OF ONE FAILED RENAME (2026-08-21). The keeper
// persists its state as tmp-write + rename, and on Windows the rename target
// can be transiently held by an outside reader (Defender, the indexer, a
// state-file read landing at the wrong instant), which surfaces as EPERM.
// That throw walked up to uncaughtException and the keeper recorded
// "keeper crashed: EPERM ... rename" and killed its LIVE session: caught
// twice on 2026-08-20/21 the first night session exits were logged at all,
// including the session holding Pat's two adversarial reviewers, and it is
// the best current explanation of the long "sessions dying then saying
// ready" family. A persist is a bookkeeping write: retry it briefly, and
// when it still fails, skip it and say so. The next activity stamp retries;
// startup/periodic reconciliation covers the worst case of a stale file.
// Only codes a lock produces are retried; anything else (disk full, path
// gone) fails fast and honestly.

const fs = require('node:fs');

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

function writeStateResilient(statePath, payload, {
  attempts = 5,
  backoffMs = 25,
  writeImpl = fs.writeFileSync,
  renameImpl = fs.renameSync,
  unlinkImpl = fs.unlinkSync,
  sleepImpl = null,
  log = () => {},
} = {}) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  const sleep = sleepImpl || ((ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ }
  });
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      writeImpl(temporary, payload, { mode: 0o600 });
      renameImpl(temporary, statePath);
      return true;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT.has(error.code)) break;
      if (attempt < attempts) sleep(backoffMs * attempt);
    }
  }
  try { unlinkImpl(temporary); } catch { /* tmp may not exist */ }
  log(`state persist failed (${lastError?.code}): ${lastError?.message}; keeping the session alive, the next persist retries`);
  return false;
}

module.exports = { writeStateResilient, TRANSIENT };
