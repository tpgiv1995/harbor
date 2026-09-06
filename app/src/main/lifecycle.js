'use strict';

// Daemon lifecycle and single-instance helpers. No Electron import here so
// this module is unit-testable under plain Node.
//
// Part of Harbor (see README.md).

const path = require('node:path');
const os = require('node:os');
const { platform } = require('./platform/index.js');
const { scriptInvocation } = require('./script-exec.js');

const HARBOR_SESSIOND_BIN = path.resolve(__dirname, '../../../bin/harbor-sessiond');

// The sessiond equivalent. `harbor-sessiond start` owns the decision about
// systemd versus a detached spawn, including the rule that a relocated store is
// not the real installation and so does not get the shared unit name.
// `recover: true` runs `harbor-sessiond recover` instead: the wedge lane, an
// identity-verified put-down of a mute owner followed by an ordinary start.
// Only the watchdog's wedge path asks for it; boot-time starts stay plain.
function startSessionDaemon(sessiondBin = HARBOR_SESSIOND_BIN, { recover = false } = {}) {
  const { command, args, env } = scriptInvocation(sessiondBin, [recover ? 'recover' : 'start']);
  return platform.startDaemon(command, args, Object.keys(env).length ? { env: { ...process.env, ...env } } : {});
}

// Parse launch-intent flags from an argv array.
// CAUTION: Chromium REORDERS argv before delivering the second-instance event
// (flags are hoisted ahead of positionals and extra Chromium flags appear), so
// space-separated profile values arrive torn apart. Only the equals form
// survives intact. The reliable channel is
// requestSingleInstanceLock(additionalData); this parser is the fallback and
// therefore only trusts equals-form values.
// Returns { action, noFocusSteal } where action is 'focus' | 'new-session'.
// noFocusSteal carries the out-of-band-restart intent through to the FIRST
// instance: a relaunch that races a not-yet-dead process lands in the
// second-instance handler, which used to focus unconditionally. That is one of
// the two paths that put Harbor over Pat's game on 2026-07-27 despite the flag
// being set on both processes.
function parseSecondInstanceArgs(argv) {
  const args = (argv || []).slice(1);

  const flagValue = (name) => {
    const eq = args.find((a) => typeof a === 'string' && a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    // Space-separated pairs survive only in our OWN process.argv (pre-mangling);
    // accept them when the next token is not itself a flag.
    const idx = args.indexOf(name);
    if (idx >= 0 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return args[idx + 1];
    return null;
  };

  const noFocusSteal = args.includes('--no-focus-steal');
  if (!args.includes('--new-session')) return { action: 'focus', noFocusSteal };
  const homeFlag = flagValue('--home');
  const home = homeFlag;
  const cwd = flagValue('--cwd') || os.homedir();
  return { action: 'new-session', home, cwd, noFocusSteal };
}

// Build the additionalData payload for requestSingleInstanceLock from OUR OWN
// process.argv (never mangled in-process). The first instance receives this
// verbatim in the second-instance event and should prefer it over argv.
function buildSecondInstancePayload(argv) {
  return parseSecondInstanceArgs(argv);
}

module.exports = {
  HARBOR_SESSIOND_BIN,
  startSessionDaemon,
  parseSecondInstanceArgs,
  buildSecondInstancePayload,
};
