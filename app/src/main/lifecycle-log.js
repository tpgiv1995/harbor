'use strict';

// A DURABLE RECORD OF HOW THE APP STARTED AND HOW IT ENDED (2026-09-04).
//
// Six Harbor boots in eighteen minutes that evening, at least two of which
// exited before drawing a window, and nothing on the machine could say why:
// the app is launched from a shortcut, so its stdout goes nowhere, and it
// wrote no log of its own. The daemon has carried sessiond.log since the
// 2026-08-14 double crash for exactly this reason. This is the app's twin:
// one JSON line per lifecycle event (boot, startup failure, quit, renderer
// death, uncaught exception, relaunch, a history worker that could not write
// its cache), tiny, rotated at a cap, and never able to throw into the app.
//
// Injectable clock/pid/fs so the rotation and the failure modes have a test.

const fs = require('node:fs');
const path = require('node:path');

function createLifecycleLog({
  file,
  enabled = true,
  maxBytes = 1024 * 1024,
  now = () => new Date(),
  pid = process.pid,
  fsImpl = fs,
} = {}) {
  let ready = false;
  const ensureDir = () => {
    if (ready) return;
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    ready = true;
  };
  const rotateIfLarge = () => {
    try {
      if (fsImpl.statSync(file).size > maxBytes) fsImpl.renameSync(file, `${file}.1`);
    } catch { /* no file yet, or a rotation that lost a race: either is fine */ }
  };
  return {
    file,
    note(kind, details = {}) {
      if (!enabled || !file) return;
      try {
        ensureDir();
        rotateIfLarge();
        const line = JSON.stringify({ at: now().toISOString(), pid, kind, ...details });
        fsImpl.appendFileSync(file, `${line}\n`);
      } catch { /* logging must never break the app */ }
    },
  };
}

module.exports = { createLifecycleLog };
