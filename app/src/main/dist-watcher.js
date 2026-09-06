'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Watch the build output dir and announce settled rebuilds. Node's recursive
// fs.watch rescans subtrees on events; when a vite build has just wiped
// dist/assets, that rescan throws an async ENOENT on the FSWatcher error path,
// which is FATAL to the main process unless handled (live-caught 2026-07-18:
// a routine frontend rebuild took the whole app down). So: every watcher gets
// an error handler that closes it, counts the churn as a change, and re-arms
// once the rebuild settles. Re-arm retries are bounded; a dist dir that stays
// gone means builds stopped, not a reason to spin forever.
//
// A SIGNAL IS NOT A BUILD (2026-08-20). On Windows the watcher fired without
// any build: ever since the Legion migration, Pat's restart ribbon reappeared
// once after every update restart ("it takes two restarts to stick"), and a
// spy watcher on dist/ proved his restarts generated ZERO filesystem events;
// the announce came from the watcher's own churn paths (the boot-time arm and
// error path on a tree Defender and the indexer were still chewing), which
// Linux never exercised. So the announcement is CONTENT-AWARE now: a
// fingerprint of dist (file names + sizes, plus the index.html bytes, which
// vite's content-hashed asset names make a faithful build identity) is taken
// at creation, and any settled signal only announces when the fingerprint
// actually CHANGED. Spurious signals, byte-identical rebuilds, AV churn, and
// double events can no longer draw the banner, on any OS; a real build always
// can, because it renames its hashed assets and rewrites index.html.
function distFingerprint(distDir) {
  try {
    const parts = [];
    const walk = (dir, rel) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, relPath);
        else parts.push(`${relPath}:${fs.statSync(full).size}`);
      }
    };
    walk(distDir, '');
    let html = '';
    try { html = fs.readFileSync(path.join(distDir, 'index.html')).toString('base64'); } catch { /* fingerprint still covers the listing */ }
    return crypto.createHash('sha1').update(`${parts.join('\n')}|${html}`).digest('hex');
  } catch {
    // Unreadable (mid-wipe, not built yet) is UNKNOWN, and unknown is never
    // announced; the caller re-checks until the tree is readable again.
    return null;
  }
}

function createDistWatcher(distDir, onSettledChange, options = {}) {
  const settleMs = options.settleMs ?? 1500;
  const rearmDelayMs = options.rearmDelayMs ?? 2000;
  const maxRearms = options.maxRearms ?? 30;
  const maxNullRechecks = options.maxNullRechecks ?? 20;
  const watchFn = options.watchFn || ((dir, cb) => fs.watch(dir, { recursive: true }, cb));
  const fingerprintFn = options.fingerprintFn || distFingerprint;

  let timer = null;
  let watcher = null;
  let rearms = 0;
  let nullRechecks = 0;
  let closed = false;
  let baseline = fingerprintFn(distDir);

  const check = () => {
    timer = null;
    if (closed) return;
    const current = fingerprintFn(distDir);
    if (current === null) {
      // Mid-wipe: the build is still landing. Look again, boundedly, so a
      // dist that stays deleted stops the polling rather than owning a timer
      // forever; the next real event restarts the cycle.
      nullRechecks += 1;
      if (nullRechecks > maxNullRechecks) return;
      timer = setTimeout(check, settleMs);
      timer.unref?.();
      return;
    }
    nullRechecks = 0;
    if (current === baseline) return; // a signal without a change is churn, not a build
    baseline = current;
    onSettledChange();
  };

  const announce = () => {
    clearTimeout(timer);
    nullRechecks = 0;
    timer = setTimeout(check, settleMs);
    timer.unref?.();
  };

  const rearmLater = () => {
    if (closed) return;
    rearms += 1;
    if (rearms > maxRearms) {
      console.warn(`dist watch gave up after ${maxRearms} re-arms (dist stayed unwatchable)`);
      return;
    }
    const t = setTimeout(arm, rearmDelayMs);
    t.unref?.();
  };

  const arm = () => {
    if (closed) return;
    try {
      watcher = watchFn(distDir, announce);
      watcher.on?.('error', () => {
        try { watcher.close(); } catch { /* already closed */ }
        watcher = null;
        announce(); // the wipe MAY be a change; the fingerprint check decides
        rearmLater();
      });
      watcher.unref?.();
      rearms = 0;
    } catch {
      // dist may be mid-wipe (or not built yet); retry until it settles.
      rearmLater();
    }
  };

  arm();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* already closed */ }
      watcher = null;
    },
    get armed() { return watcher != null; },
  };
}

module.exports = { createDistWatcher, distFingerprint };
