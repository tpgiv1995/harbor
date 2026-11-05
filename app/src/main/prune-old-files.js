'use strict';

const fs = require('node:fs');
const path = require('node:path');

// HARBOR'S OWN HAND-OFF IMAGES ARE DELETED AFTER 14 DAYS (2026-11-05, Pat
// approved "delete pasted images after 14 days"). A pasted image
// (~/.cache/harbor/pastes) or a phone upload (<userData>/server-upload/<run>)
// is only a hand-off: the CLI copies the image into the transcript when the
// message is sent, so the file is never read again. Nothing ever removed them:
// the paste folder had reached 1.6 GB (1,769 files) and phone uploads 74 MB.
//
// No timer (Pat's no-polling rule): the owner calls the throttled pruner when
// it writes a new file, so the work happens at most once per window and only
// while Harbor is actually being used. Only entries older than maxAgeMs go;
// anything in use or already gone is skipped and tried next time.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 14 * DAY_MS;
const DEFAULT_EVERY_MS = 6 * 60 * 60 * 1000;

async function pruneOldEntries({ dir, maxAgeMs = DEFAULT_MAX_AGE_MS, match = () => true, now = Date.now(), fsImpl = fs } = {}) {
  let names;
  try { names = await fsImpl.promises.readdir(dir); } catch { return { removed: 0, bytes: 0 }; }
  let removed = 0;
  let bytes = 0;
  for (const name of names) {
    if (!match(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fsImpl.promises.lstat(full);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      if (stat.isFile()) {
        await fsImpl.promises.unlink(full);
        bytes += stat.size;
      } else if (stat.isDirectory()) {
        await fsImpl.promises.rm(full, { recursive: true, force: true });
      } else {
        continue; // never follow or remove a link
      }
      removed += 1;
    } catch { /* in use or already gone: next time */ }
  }
  return { removed, bytes };
}

function createThrottledPruner(options, { everyMs = DEFAULT_EVERY_MS, clock = Date.now } = {}) {
  let last = -Infinity;
  let running = null;
  return function prune() {
    if (running) return running;
    if (clock() - last < everyMs) return Promise.resolve(null);
    last = clock();
    running = pruneOldEntries({ ...options, now: clock() })
      .catch(() => null)
      .finally(() => { running = null; });
    return running;
  };
}

module.exports = { pruneOldEntries, createThrottledPruner, DEFAULT_MAX_AGE_MS, DEFAULT_EVERY_MS };
