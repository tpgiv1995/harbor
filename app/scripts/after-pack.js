'use strict';

// The packaged app's pty guarantee, ASSERTED instead of assumed. Two silent
// ways to ship a build whose daemon cannot spawn a single session existed
// before this hook, and both logged success at pack time:
//
//   1. The exec bit on node-pty's `spawn-helper` is repaired at install time
//      (scripts/pack-daemon-deps.js), reaches the bundle only because
//      electron-builder happens to preserve modes on copy, and under a
//      restrictive build umask ships owner-only (0o700) — so the second user
//      of a drag-installed app hits the exact `posix_spawnp failed` trap the
//      repair exists to kill. An `npm ci --ignore-scripts` flow skips the
//      repair entirely and ships `-rw-` helpers.
//
//   2. extraResources copies the BUILD HOST's daemon node_modules verbatim, so
//      a cross-target build can ship a native module the target OS cannot
//      load at all — node-pty 1.1.0 carries no linux prebuild whatsoever
//      (Linux relies on a local node-gyp build), and a `dist:linux` run on a
//      Mac would package a daemon whose `require('node-pty')` throws on every
//      session spawn.
//
// This hook closes both: it locates the packed daemon's node-pty, asserts the
// TARGET platform has a loadable binary, and normalizes the helper to 0o755.
// Failing the build here is the point — a broken artifact must not ship
// quietly.

const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux'
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const nodePty = path.join(resources, 'app', 'src', 'daemon', 'node_modules', 'node-pty');

  if (!fs.existsSync(nodePty)) {
    throw new Error(`after-pack: packed app has no daemon node-pty at ${nodePty}; `
      + 'pack:daemon-deps did not run or extraResources changed shape');
  }

  const arches = platform === 'win32' ? ['win32-x64', 'win32-arm64']
    : platform === 'darwin' ? ['darwin-x64', 'darwin-arm64']
      : []; // linux ships a node-gyp build/Release, not a prebuild
  const prebuilds = arches.map((a) => path.join(nodePty, 'prebuilds', a));
  const built = path.join(nodePty, 'build', 'Release');
  const loadable = prebuilds.some((dir) => fs.existsSync(dir)) || fs.existsSync(built);
  if (!loadable) {
    throw new Error(`after-pack: daemon node-pty carries no ${platform}-loadable binary `
      + '(cross-target build from a host without one?) — every session spawn would die');
  }

  if (platform !== 'win32') {
    let helpers = 0;
    const prebuildRoot = path.join(nodePty, 'prebuilds');
    for (const entry of fs.existsSync(prebuildRoot) ? fs.readdirSync(prebuildRoot) : []) {
      const helper = path.join(prebuildRoot, entry, 'spawn-helper');
      if (!fs.existsSync(helper)) continue;
      helpers += 1;
      // 0o755 unconditionally: the artifact is for DISTRIBUTION, so the build
      // machine's umask must not decide whether a second user can exec it.
      fs.chmodSync(helper, 0o755);
    }
    if (helpers === 0 && !fs.existsSync(built)) {
      throw new Error('after-pack: no spawn-helper found in any packed prebuild — '
        + 'pty spawns would fail with posix_spawnp on the shipped app');
    }
    console.log(`after-pack: verified ${platform} pty binary; ${helpers} spawn-helper(s) set 0755`);
  } else {
    console.log('after-pack: verified win32 pty binary');
  }
};
