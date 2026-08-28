#!/usr/bin/env node
// Installs the session daemon's own dependencies, then repairs the one thing npm
// cannot be trusted to preserve: the EXECUTE BIT on node-pty's `spawn-helper`.
//
// The daemon runs under the system Node rather than under Electron, so its deps
// live in `src/daemon/package.json` and are installed here by the `postinstall`
// hook. node-pty ships PREBUILT binaries (`prebuilds/<platform>-<arch>/`) and is
// never compiled locally, so there is no node-gyp step that would set the mode.
//
// npm extracts the tarball without the execute bit, which leaves:
//
//     -rw-r--r--  prebuilds/darwin-arm64/spawn-helper
//
// `lib/unixTerminal.js` passes that path to `pty.fork` as `helperPath`, and the
// exec fails. The failure is badly misleading: the daemon starts, binds its
// socket and reports `healthy: true`, and then EVERY session spawn dies with
//
//     Error: posix_spawnp failed.
//         at new UnixTerminal (.../node-pty/lib/unixTerminal.js:92:24)
//
// which names neither the helper nor the permission. Nothing in the test suite
// catches it, because no spec exercises the packaged prebuild.
//
// Live-caught on macOS 26 / arm64 (M1 Pro) 2026-08-16, on a clean clone: the
// binary was the correct `Mach-O 64-bit executable arm64` and carried no
// `com.apple.quarantine`; the mode was the whole bug, and `chmod +x` fixed it.
// It reproduces on every fresh `npm install`, so fixing it by hand does not
// hold and it belongs here rather than in a README note.
//
// Windows is skipped: `.node` DLLs are loaded, not exec'd, and there is no
// spawn-helper on that platform.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// Anchored to THIS FILE, not the process cwd. As an npm lifecycle script the
// cwd happens to be app/, but a standalone rerun (`node app/scripts/...` from
// the repo root, say, to re-repair the exec bit) used to make `npm --prefix`
// CREATE a junk <cwd>/src/daemon with a stray lockfile — which then flipped
// the ci/install branch on the next run — before dying on an assert that
// blamed node-pty instead of the cwd.
const appRoot = path.resolve(__dirname, '..');
const daemonDir = path.join(appRoot, 'src/daemon');

function installDaemonDeps() {
  const lock = path.join(daemonDir, 'package-lock.json');
  const cmd = fs.existsSync(lock) ? 'ci' : 'install';
  cp.execSync(`npm --prefix ${daemonDir} ${cmd} --no-audit --no-fund`, { stdio: 'inherit' });
  require('assert')(
    fs.existsSync(path.join(daemonDir, 'node_modules/node-pty')),
    'node-pty missing after install; the daemon cannot spawn a pty without it',
  );
}

// Every node-pty copy that could be resolved at runtime, not just the daemon's,
// so a hoisted or app-level install is repaired too.
function nodePtyRoots() {
  return [
    path.join(daemonDir, 'node_modules/node-pty'),
    path.join(appRoot, 'node_modules/node-pty'),
  ].filter((p) => fs.existsSync(p));
}

function repairExecBits() {
  if (process.platform === 'win32') return;

  let repaired = 0;
  let checked = 0;

  for (const root of nodePtyRoots()) {
    const prebuilds = path.join(root, 'prebuilds');
    if (!fs.existsSync(prebuilds)) continue;

    for (const entry of fs.readdirSync(prebuilds)) {
      // Only POSIX prebuild dirs carry a spawn-helper.
      if (entry.startsWith('win32-')) continue;
      const helper = path.join(prebuilds, entry, 'spawn-helper');
      if (!fs.existsSync(helper)) continue;

      checked += 1;
      const mode = fs.statSync(helper).mode;
      // Already executable by the owner: leave it alone.
      if (mode & 0o100) continue;

      // Mirror the read bits into the exec bits (0o755 from 0o644) rather than
      // forcing a fixed mode, so a restrictive umask is respected.
      const next = mode | ((mode & 0o444) >> 2);
      fs.chmodSync(helper, next);
      repaired += 1;
      console.log(`pack:daemon-deps: set +x on ${helper}`);
    }
  }

  if (checked === 0) {
    // Not fatal: a platform whose prebuild is absent simply has nothing to fix,
    // and failing the whole install over it would be worse than saying so.
    console.warn('pack:daemon-deps: no spawn-helper found in any node-pty prebuild');
    return;
  }
  if (repaired === 0) {
    console.log('pack:daemon-deps: spawn-helper already executable');
  }
}

installDaemonDeps();
repairExecBits();
