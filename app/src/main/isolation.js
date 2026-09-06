'use strict';

const os = require('node:os');
const path = require('node:path');

// What state OUTSIDE this app is a given Harbor instance allowed to touch?
//
// Live-caught 2026-07-25: a Playwright drive launched Harbor with an isolated
// userData, an isolated daemon socket and its own Xvfb display, and stubbed
// window.harbor.session.send so "nothing is typed into a real pane". Apply in
// the session-config modal routes a PANELESS session through session.takeover
// (reconfigureSelected -> takeoverSelected), which was not stubbed, and
// takeover learns its kill target from the statusline context tee, whose
// directory was hardcoded to the real ~/.cache/harbor/context. Profile
// isolation does not isolate $HOME, so the test instance SIGTERMed the live
// claude that was running the test: session 31899b4f froze mid tool call and
// its pane dropped to a bash prompt. The session killed itself with its own
// repro.
//
// Two layers, because either alone still leaks:
//   1. resolveContextDir: the tee store is env-overridable, so a harness can
//      be made physically unable to learn a real owner pid.
//   2. resolveSignalPolicy: an instance on a NON-DEFAULT profile that is still
//      reading the REAL tee store refuses to signal at all, so a drive that
//      forgets layer 1 kills nothing.
//
// Signal 0 is never blocked: it delivers nothing, and every liveness probe
// (pidAlive, the owner-gone fall-through, closePaneTab's verify) is built on
// it. Blocking it would turn a guard into a behavior change.

const DEFAULT_CONTEXT_DIR = path.join(os.homedir(), '.cache', 'harbor', 'context');
const CONTEXT_DIR_ENV = 'HARBOR_CONTEXT_DIR';
const OPT_IN_ENV = 'HARBOR_ALLOW_REAL_SIGNALS';

function resolveContextDir(env = process.env) {
  const override = env?.[CONTEXT_DIR_ENV];
  return override ? path.resolve(override) : DEFAULT_CONTEXT_DIR;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a) === path.resolve(b);
}

// userDataPath/defaultUserDataPath come from Electron: app.getPath('userData')
// against path.join(app.getPath('appData'), app.getName()). The default is
// RECONSTRUCTED rather than captured at boot because --user-data-dir is applied
// by Chromium before any app code runs, so a captured value would already be
// the override; appData and getName() are unaffected by that switch (probed
// 2026-07-25 both ways).
function resolveSignalPolicy(options = {}) {
  const env = options.env || process.env;
  const {
    userDataPath,
    defaultUserDataPath,
    contextDir = resolveContextDir(env),
    defaultContextDir = DEFAULT_CONTEXT_DIR,
  } = options;
  if (env?.[OPT_IN_ENV] === '1') {
    return { allowed: true, reason: null, optIn: true };
  }
  // An isolated tee store can only ever name pids the harness itself created.
  if (!samePath(contextDir, defaultContextDir)) {
    return { allowed: true, reason: null, optIn: false };
  }
  // The real profile IS the real app: adopt-on-send and worker close must keep
  // working exactly as before.
  if (samePath(userDataPath, defaultUserDataPath)) {
    return { allowed: true, reason: null, optIn: false };
  }
  return {
    allowed: false,
    optIn: false,
    reason: 'refusing to signal a real process: this Harbor runs on an isolated profile '
      + `(${userDataPath || 'unknown'}) while reading the real context store (${contextDir}), so any owner `
      + `pid it finds belongs to a live session. Point ${CONTEXT_DIR_ENV} at a throwaway directory, or set `
      + `${OPT_IN_ENV}=1 to opt in.`,
  };
}

// The sibling of the signal guard: launches. resume/new-session shell out to
// bin/claude-sessions and bin/ai, which start REAL agents in Pat's workspaces,
// and unlike a signal that needs a tee pid, a launch needs nothing from the
// real machine except the binary. An isolated profile therefore never launches
// for real; HARBOR_E2E_FAKE_LAUNCH (which records launches and reports success)
// still wins for harnesses that assert on the argv.
const LAUNCH_OPT_IN_ENV = 'HARBOR_ALLOW_REAL_LAUNCH';

function resolveLaunchPolicy(options = {}) {
  const env = options.env || process.env;
  const { userDataPath, defaultUserDataPath } = options;
  if (env?.[LAUNCH_OPT_IN_ENV] === '1') return { allowed: true, reason: null, optIn: true };
  if (samePath(userDataPath, defaultUserDataPath)) return { allowed: true, reason: null, optIn: false };
  return {
    allowed: false,
    optIn: false,
    reason: 'refusing to launch a real session: this Harbor runs on an isolated profile '
      + `(${userDataPath || 'unknown'}), so a resume or new session here would start a real agent in a real `
      + `workspace. Set HARBOR_E2E_FAKE_LAUNCH=1 to record launches instead, or ${LAUNCH_OPT_IN_ENV}=1 to opt in.`,
  };
}

// The third sibling: native file dialogs. Live-caught 2026-07-26, and it cost
// Pat ninety minutes of a GNOME file chooser stealing focus on his real
// desktop every few minutes while the E2E gate ran.
//
// Electron does NOT draw dialog.showOpenDialog itself. It calls
// org.freedesktop.portal.FileChooser over the SESSION BUS, where
// xdg-desktop-portal-gnome activates Nautilus and draws the dialog on the real
// desktop. `env -u DISPLAY -u WAYLAND_DISPLAY xvfb-run` isolates X11 and
// nothing else: DBUS_SESSION_BUS_ADDRESS is untouched, so a portal-backed
// dialog walks straight out of the harness. Exactly the 2026-07-25 shape
// again, where the harness isolated socket, profile and display but never the
// things that live outside all three.
//
// Worse than noisy: showOpenDialog is MODAL and awaits an answer nobody on the
// test side can give, so it blocks the main process for as long as it sits
// there.
//
// A dialog needs nothing real except a person to answer it, so like a launch
// it is refused outright on a non-default profile rather than made safe.
const DIALOG_OPT_IN_ENV = 'HARBOR_ALLOW_REAL_DIALOGS';
const SESSION_STORE_OPT_IN_ENV = 'HARBOR_ALLOW_REAL_SESSION_STORE';

function resolveE2eFakeLaunch(env = process.env) {
  const e2eMode = env.HARBOR_E2E === '1';
  return env.HARBOR_E2E_FAKE_LAUNCH === '1'
    || (e2eMode && env.HARBOR_E2E_FAKE_LAUNCH !== '0');
}
const DEFAULT_SESSION_DIR = path.join(os.homedir(), '.local', 'state', 'harbor', 'sessiond');

function resolveDialogPolicy(options = {}) {
  const env = options.env || process.env;
  const { userDataPath, defaultUserDataPath } = options;
  if (env?.[DIALOG_OPT_IN_ENV] === '1') return { allowed: true, reason: null, optIn: true };
  if (samePath(userDataPath, defaultUserDataPath)) return { allowed: true, reason: null, optIn: false };
  return {
    allowed: false,
    optIn: false,
    reason: 'refusing to open a native file dialog: this Harbor runs on an isolated profile '
      + `(${userDataPath || 'unknown'}), and Electron routes file dialogs through the desktop portal on the `
      + 'SESSION BUS, which xvfb does not isolate, so the picker would open on the real desktop and block this '
      + `process until a human answered it. Stub the picker in the harness, or set ${DIALOG_OPT_IN_ENV}=1 to opt in.`,
  };
}

function resolveSessionStorePolicy(options = {}) {
  const env = options.env || process.env;
  const sessionDir = path.resolve(options.sessionDir || env.HARBOR_SESSIOND_DIR || DEFAULT_SESSION_DIR);
  const defaultSessionDir = path.resolve(options.defaultSessionDir || DEFAULT_SESSION_DIR);
  const { userDataPath, defaultUserDataPath } = options;
  if (env?.[SESSION_STORE_OPT_IN_ENV] === '1') return { allowed: true, reason: null, optIn: true };
  if (!samePath(sessionDir, defaultSessionDir)) return { allowed: true, reason: null, optIn: false };
  if (samePath(userDataPath, defaultUserDataPath)) return { allowed: true, reason: null, optIn: false };
  return {
    allowed: false,
    optIn: false,
    reason: 'refusing to operate on the default session store: this Harbor runs on an isolated profile '
      + `(${userDataPath || 'unknown'}) while the session daemon directory is ${sessionDir}. Point `
      + `HARBOR_SESSIOND_DIR at a throwaway directory, or set ${SESSION_STORE_OPT_IN_ENV}=1 to opt in.`,
  };
}

// Names the caller in the thrown error, so a test that reaches a picker
// identifies itself instead of silently opening a window on someone's screen.
function createDialogGuard({ policy }) {
  if (!policy) throw new TypeError('createDialogGuard requires a policy');
  return function assertDialogAllowed(what = 'file dialog') {
    if (policy.allowed) return;
    const error = new Error(`${policy.reason} (blocked: ${what})`);
    error.code = 'DIALOG_BLOCKED';
    // The stack is the point: it names the IPC handler, and the renderer's
    // rejection names the test that drove it.
    throw error;
  };
}

// Wraps process.kill so every signalling path in the main process is covered,
// including ones added later: the takeover owner kill and closePaneTab's
// orphan reap both take their killer by injection.
function createSignalGuard({ policy, processKill }) {
  if (!policy || typeof processKill !== 'function') {
    throw new TypeError('createSignalGuard requires a policy and a processKill');
  }
  return function guardedKill(pid, signal) {
    if (!policy.allowed && signal !== 0) {
      throw new Error(`${policy.reason} (blocked ${signal || 'SIGTERM'} to pid ${pid})`);
    }
    return processKill(pid, signal);
  };
}

// Wraps execFile so an isolated profile never shells out to bin/ for a real launch.
// HARBOR_E2E_FAKE_LAUNCH records argv and reports success; the opt-in env clears a
// deliberate refusal for drives that mean it.
function createInjectableExecFile(launchPolicy, options = {}) {
  const env = options.env || process.env;
  const fakeLaunch = options.fakeLaunch || env.HARBOR_E2E_FAKE_LAUNCH === '1';
  const onFakeLaunch = options.onFakeLaunch || null;
  const execFile = options.execFile || require('node:child_process').execFile;
  if (fakeLaunch) {
    return (command, argv, optionsOrCb, maybeCb) => {
      const launchOptions = typeof optionsOrCb === 'object' ? optionsOrCb : null;
      const cb = maybeCb || (typeof optionsOrCb === 'function' ? optionsOrCb : null);
      if (onFakeLaunch) onFakeLaunch({ command, argv, options: launchOptions });
      if (cb) cb(null, '', '');
    };
  }
  if (launchPolicy && !launchPolicy.allowed) {
    return (command, argv, optionsOrCb, maybeCb) => {
      const cb = maybeCb || (typeof optionsOrCb === 'function' ? optionsOrCb : null);
      const error = new Error(launchPolicy.reason);
      if (cb) cb(error, '', launchPolicy.reason);
      else throw error;
    };
  }
  return execFile;
}

module.exports = {
  DEFAULT_CONTEXT_DIR,
  CONTEXT_DIR_ENV,
  OPT_IN_ENV,
  LAUNCH_OPT_IN_ENV,
  DIALOG_OPT_IN_ENV,
  SESSION_STORE_OPT_IN_ENV,
  resolveE2eFakeLaunch,
  DEFAULT_SESSION_DIR,
  resolveContextDir,
  resolveSignalPolicy,
  resolveLaunchPolicy,
  resolveDialogPolicy,
  resolveSessionStorePolicy,
  createSignalGuard,
  createDialogGuard,
  createInjectableExecFile,
};
