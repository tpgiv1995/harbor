'use strict';

const fs = require('node:fs');
const path = require('node:path');

// TURN ON CRASH MINIDUMPS SO THE NEXT RENDERER DEATH LEAVES DECODABLE EVIDENCE
// (2026-09-05).
//
// Electron ships Crashpad but collects nothing unless crashReporter.start() is
// called. Without it a `render-process-gone` is only an exit code in the
// lifecycle log, and the code Harbor's renderer has died with, 0xFFFF7003
// (-36861), is not decodable from the number alone: it is NOT a plain access
// violation (0xC0000005) and NOT Chromium's own out-of-memory crash
// (0xE0000008). Two crashes 13 hours apart carried the identical code under
// completely different memory conditions, which points at a specific
// reproducible fault, not memory pressure (the commit-ceiling theory did not
// survive the timestamps: the machine's 85%-commit events were hours from
// either crash). The minidump names the faulting module and the true exception,
// which is the difference between a cause and a guess.
//
// Two deliberate choices:
//   - uploadToServer:false. A minidump can carry process memory; this is a
//     diagnostic for one machine and never leaves it.
//   - the dump directory is the same non-virtualized ~/.cache/harbor tree the
//     perf and lifecycle logs already use, NOT Electron's default under the
//     Roaming userData. That Roaming path is mirrored by the MSIX container, so
//     a dump written there can be invisible to an out-of-container reader (the
//     same trap that hid every earlier "where are the dumps" answer).
//
// This module NEVER throws. Capturing evidence must not be the reason the app
// fails to boot; same contract as gpu-telemetry.js and the lifecycle log.

// Crashpad writes the .dmp synchronously as the process dies, so by the time a
// main-process listener runs the file is on disk. Match a crash to its dump by
// taking the newest .dmp in the directory (Crashpad's layout puts finished
// reports directly under the dump dir on Windows).
function newestDump(dir) {
  try {
    let best = null;
    const walk = (d, depth) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          // Crashpad keeps completed reports one level down on some platforms;
          // one level of recursion covers both without walking the world.
          if (depth < 1) walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.dmp')) continue;
        const mtime = fs.statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: full, mtime };
      }
    };
    walk(dir, 0);
    return best ? best.path : null;
  } catch {
    return null;
  }
}

function createCrashCapture({
  crashReporter,
  app,
  dumpDir,
  log = () => {},
  findNewestDump = newestDump,
} = {}) {
  if (!crashReporter || typeof crashReporter.start !== 'function') {
    throw new TypeError('createCrashCapture requires an Electron crashReporter');
  }
  if (!app || typeof app.on !== 'function') {
    throw new TypeError('createCrashCapture requires the Electron app');
  }

  let armed = false;

  function emit(line) {
    try { log(line); } catch { /* logging must never break the app */ }
  }

  // A renderer (or other child) went away: record the reason, the exit code, and
  // the dump that Crashpad just wrote, on one line next to the existing
  // render-process-gone entry. A null dump means Crashpad wrote nothing (a clean
  // or forced exit), which is itself worth knowing.
  function noteCrash(source, details) {
    emit({
      at: new Date().toISOString(),
      kind: 'crash-dump',
      source,
      reason: details && details.reason,
      exitCode: details && details.exitCode,
      dump: findNewestDump(dumpDir),
    });
  }

  function arm() {
    if (armed) return { armed: true, dumpDir };
    try {
      // setPath('crashDumps') MUST precede start(): Crashpad reads the directory
      // once, at start.
      if (dumpDir && typeof app.setPath === 'function') app.setPath('crashDumps', dumpDir);
      crashReporter.start({
        uploadToServer: false, // local only; a dump can hold memory contents
        compress: true,
        ignoreSystemCrashHandler: false,
      });
      // App-level listeners on purpose: index.js's existing webContents
      // `render-process-gone` handler (recovery + transcript cleanup) is being
      // edited by another feature in the same working tree, so this adds a
      // SEPARATE listener that only reads and logs, colliding with nothing.
      app.on('render-process-gone', (_event, _webContents, details) => noteCrash('renderer', details));
      armed = true;
      emit({
        at: new Date().toISOString(),
        kind: 'crash-capture',
        message: `armed; minidumps (local only, never uploaded) -> ${dumpDir}`,
      });
    } catch (error) {
      emit({
        at: new Date().toISOString(),
        kind: 'crash-capture',
        message: `failed to arm: ${(error && error.message) || error}`,
      });
    }
    return { armed, dumpDir };
  }

  return {
    arm,
    noteCrash,
    get armed() { return armed; },
  };
}

module.exports = { createCrashCapture, newestDump };
