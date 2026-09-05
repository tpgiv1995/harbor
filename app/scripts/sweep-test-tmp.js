'use strict';

// THE SUITE'S OWN LITTER, SWEPT BY THE THING THAT CREATED IT (2026-08-09).
//
// Measured on Pat's box: /tmp held 18,842 entries and 7.3GB, of which 17,382
// were this suite's `mkdtemp` directories: 7,822 `harbor-session-send-test-*`,
// 2,750 `harbor-e2e-*`, 810 `harbor-tasks-cli-*`, 803 `harbor-tasks-test-*`,
// 750 `harbor-icons-test-*` and about thirty other prefixes behind them. On
// this machine /tmp is a TMPFS, so every one of those bytes was RAM, on a box
// whose whole problem is memory pressure.
//
// WHY NOT FIX THE THIRTY CALL SITES. Most of them are already correct: they
// register a `t.after` that removes the directory, and that teardown simply
// does not run when the runner is killed (Ctrl+C, an OOM, a timeout). This is
// the same lesson as `src/daemon/harness-watch.js`, which exists because three
// interrupted `npm test` runs left 28 orphaned daemons despite every suite
// having correct teardown: the floor belongs in one place that does not depend
// on teardown having run, not in each suite. Per-suite cleanup stays; this is
// the net under it.
//
// AT THE START OF A RUN, NEVER AT THE END, for exactly the same reason: a run
// that is killed never reaches its own end. The next run cleans up after the
// last one.
//
// The age threshold is what makes it safe to run while other suites are live:
// a directory that has not been touched in hours cannot belong to a test that
// is running now. Nothing outside the prefix list is ever considered, and a
// symlink is unlinked rather than followed, so this can never walk out of the
// temp directory it was pointed at.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every prefix here is test-only by construction. Production Harbor keeps its
// state in ~/.local/state/harbor and its caches in ~/.cache/harbor; nothing the
// app relies on at runtime lives in a temp directory with these names.
const TEST_TMP_PREFIXES = ['harbor-', 'herdr-'];

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function sweepTestTmp({
  dir = os.tmpdir(),
  olderThanMs = TWO_HOURS_MS,
  now = Date.now(),
  prefixes = TEST_TMP_PREFIXES,
} = {}) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed: 0 };
  }
  for (const entry of entries) {
    if (!prefixes.some((p) => entry.name.startsWith(p))) continue;
    const full = path.join(dir, entry.name);
    try {
      // lstat, so a symlink is judged as the LINK and removed as the link. A
      // stat here would follow it and could report the age of, and then delete,
      // something that merely happens to be pointed at from /tmp.
      const stat = fs.lstatSync(full);
      if (now - stat.mtimeMs < olderThanMs) continue;
      if (stat.isSymbolicLink()) { fs.unlinkSync(full); removed += 1; continue; }
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A directory that vanished under us, or one owned by another user, is
      // not this sweeper's problem and must never fail a test run.
    }
  }
  return { removed };
}

module.exports = { sweepTestTmp, TEST_TMP_PREFIXES, TWO_HOURS_MS };
