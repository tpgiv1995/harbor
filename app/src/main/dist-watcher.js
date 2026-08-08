'use strict';

const fs = require('node:fs');

// Watch the build output dir and announce settled rebuilds. Node's recursive
// fs.watch rescans subtrees on events; when a vite build has just wiped
// dist/assets, that rescan throws an async ENOENT on the FSWatcher error path,
// which is FATAL to the main process unless handled (live-caught 2026-07-18:
// a routine frontend rebuild took the whole app down). So: every watcher gets
// an error handler that closes it, counts the churn as a change, and re-arms
// once the rebuild settles. Re-arm retries are bounded; a dist dir that stays
// gone means builds stopped, not a reason to spin forever.
function createDistWatcher(distDir, onSettledChange, options = {}) {
  const settleMs = options.settleMs ?? 1500;
  const rearmDelayMs = options.rearmDelayMs ?? 2000;
  const maxRearms = options.maxRearms ?? 30;
  const watchFn = options.watchFn || ((dir, cb) => fs.watch(dir, { recursive: true }, cb));

  let timer = null;
  let watcher = null;
  let rearms = 0;
  let closed = false;

  const announce = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!closed) onSettledChange(); }, settleMs);
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
        announce(); // the wipe itself is the change signal
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

module.exports = { createDistWatcher };
