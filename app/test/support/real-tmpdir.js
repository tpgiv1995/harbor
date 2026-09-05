'use strict';

const fs = require('node:fs');
const os = require('node:os');

// os.tmpdir() answers with whatever spelling %TEMP% carries, and on a hosted
// Windows runner that is an 8.3 short name (RUNNER~1) because the username is
// nine characters. Anything downstream that realpaths, watches, or serves the
// same location then speaks the LONG spelling, and two names for one directory
// read as two directories: the 2026-08-14 CI flip failed five watcher suites
// and three server specs exactly this way, reproduced locally with a
// substituted LONGTE~1 TEMP. macOS has the same trap through /var -> /private/var.
// One realpath at the boundary gives every fixture the spelling the OS itself
// uses, so path identity is decided once, here, not per test.
//
// It must be realpathSync.NATIVE: the JS realpath only resolves symlinks and
// hands an 8.3 name straight back (measured), while the native form asks the
// OS for the final long path. The difference is not cosmetic: libuv's Windows
// fs.watch ABORTS THE PROCESS (Assertion failed: !_wcsnicmp(filename, dir,
// dirlen), src\win\fs-event.c) when the watched dir was opened by its short
// spelling, which is what took out five whole suites on the hosted runner.
let resolved;
function realTmpDir() {
  if (!resolved) resolved = fs.realpathSync.native(os.tmpdir());
  return resolved;
}

module.exports = { realTmpDir };
