'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_CONTEXT_DIR,
  resolveContextDir,
  resolveSignalPolicy,
  resolveLaunchPolicy,
  resolveDialogPolicy,
  resolveSessionStorePolicy,
  createSignalGuard,
  createDialogGuard,
  createInjectableExecFile,
  resolveE2eFakeLaunch,
} = require('../../src/main/isolation.js');
const { createLaunchActions } = require('../../src/main/actions/launch.js');

const REAL_PROFILE = '/home/someone/.config/harbor';
const ISOLATED_PROFILE = '/tmp/harbor-cfg-repro-abc123';

test('an E2E run with the fake-launch variable unset records instead of launching', async () => {
  const env = { HARBOR_E2E: '1' };
  let underlyingCalled = false;
  const recorded = [];
  const execFile = createInjectableExecFile({ allowed: true }, {
    env,
    fakeLaunch: resolveE2eFakeLaunch(env),
    onFakeLaunch: (call) => recorded.push(call),
    execFile: () => { underlyingCalled = true; },
  });
  await new Promise((resolve, reject) => {
    execFile('/bin/ai', ['--session-id', 'test-id'], { cwd: '/tmp/project' }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  assert.equal(underlyingCalled, false);
  assert.deepEqual(recorded, [{
    command: '/bin/ai',
    argv: ['--session-id', 'test-id'],
    options: { cwd: '/tmp/project' },
  }]);
});

test('only explicit zero opts an E2E run out of fake launching', () => {
  assert.equal(resolveE2eFakeLaunch({ HARBOR_E2E: '1' }), true);
  assert.equal(resolveE2eFakeLaunch({ HARBOR_E2E: '1', HARBOR_E2E_FAKE_LAUNCH: '1' }), true);
  assert.equal(resolveE2eFakeLaunch({ HARBOR_E2E: '1', HARBOR_E2E_FAKE_LAUNCH: '0' }), false);
  assert.equal(resolveE2eFakeLaunch({ HARBOR_E2E_FAKE_LAUNCH: '1' }), true);
  assert.equal(resolveE2eFakeLaunch({}), false);
});

test('the context store defaults to the real cache and honors an explicit override', () => {
  assert.equal(resolveContextDir({}), path.join(os.homedir(), '.cache', 'harbor', 'context'));
  assert.equal(resolveContextDir({}), DEFAULT_CONTEXT_DIR);
  assert.equal(
    resolveContextDir({ HARBOR_CONTEXT_DIR: '/tmp/throwaway/context' }),
    path.resolve('/tmp/throwaway/context'),
  );
  // Relative overrides resolve, so the policy's path comparison cannot be
  // fooled into thinking a throwaway dir is the real one (or the reverse).
  assert.equal(
    resolveContextDir({ HARBOR_CONTEXT_DIR: 'ctx' }),
    path.resolve('ctx'),
  );
});

test('the real profile reading the real context store may signal, exactly as before', () => {
  const policy = resolveSignalPolicy({
    userDataPath: REAL_PROFILE,
    defaultUserDataPath: REAL_PROFILE,
    contextDir: DEFAULT_CONTEXT_DIR,
    env: {},
  });
  assert.equal(policy.allowed, true);
  assert.equal(policy.reason, null);
});

test('an isolated profile reading the REAL context store is refused, with both escapes named', () => {
  const policy = resolveSignalPolicy({
    userDataPath: ISOLATED_PROFILE,
    defaultUserDataPath: REAL_PROFILE,
    contextDir: DEFAULT_CONTEXT_DIR,
    env: {},
  });
  assert.equal(policy.allowed, false);
  assert.match(policy.reason, /isolated profile/);
  assert.ok(policy.reason.includes(ISOLATED_PROFILE), 'names the profile it is running on');
  assert.ok(policy.reason.includes(DEFAULT_CONTEXT_DIR), 'names the store it would have read');
  assert.match(policy.reason, /HARBOR_CONTEXT_DIR/);
  assert.match(policy.reason, /HARBOR_ALLOW_REAL_SIGNALS=1/);
});

test('an isolated profile with its OWN context store may signal: those pids are its own', () => {
  const policy = resolveSignalPolicy({
    userDataPath: ISOLATED_PROFILE,
    defaultUserDataPath: REAL_PROFILE,
    contextDir: '/tmp/harbor-drive/context',
    env: {},
  });
  assert.equal(policy.allowed, true);
});

test('the opt-in env clears the refusal for a drive that means it', () => {
  const policy = resolveSignalPolicy({
    userDataPath: ISOLATED_PROFILE,
    defaultUserDataPath: REAL_PROFILE,
    contextDir: DEFAULT_CONTEXT_DIR,
    env: { HARBOR_ALLOW_REAL_SIGNALS: '1' },
  });
  assert.equal(policy.allowed, true);
  assert.equal(policy.optIn, true);
});

test('an unknowable profile fails CLOSED: a guard that cannot tell must not signal', () => {
  const policy = resolveSignalPolicy({
    userDataPath: undefined,
    defaultUserDataPath: REAL_PROFILE,
    contextDir: DEFAULT_CONTEXT_DIR,
    env: {},
  });
  assert.equal(policy.allowed, false);
});

test('the guard blocks real signals and lets the signal-0 liveness probe through', () => {
  const calls = [];
  const guarded = createSignalGuard({
    policy: resolveSignalPolicy({
      userDataPath: ISOLATED_PROFILE,
      defaultUserDataPath: REAL_PROFILE,
      contextDir: DEFAULT_CONTEXT_DIR,
      env: {},
    }),
    processKill: (pid, signal) => { calls.push([pid, signal]); },
  });

  guarded(4321, 0);
  assert.deepEqual(calls, [[4321, 0]], 'signal 0 delivers nothing and every liveness probe needs it');

  for (const signal of ['SIGTERM', 'SIGKILL', undefined]) {
    assert.throws(() => guarded(4321, signal), /refusing to signal a real process/);
  }
  assert.deepEqual(calls, [[4321, 0]], 'no real signal ever reached process.kill');
});

// The sibling: a launch needs nothing from the real machine but the binary, so
// an isolated profile is refused on the profile alone, whatever the tee store
// is set to.
test('the real profile launches for real; an isolated one refuses whatever its context store is', () => {
  assert.equal(resolveLaunchPolicy({
    userDataPath: REAL_PROFILE, defaultUserDataPath: REAL_PROFILE, env: {},
  }).allowed, true);

  for (const contextDir of [DEFAULT_CONTEXT_DIR, '/tmp/harbor-drive/context']) {
    const policy = resolveLaunchPolicy({
      userDataPath: ISOLATED_PROFILE, defaultUserDataPath: REAL_PROFILE, contextDir, env: {},
    });
    assert.equal(policy.allowed, false, `isolated profile must not launch (contextDir ${contextDir})`);
    assert.match(policy.reason, /refusing to launch a real session/);
    assert.match(policy.reason, /HARBOR_E2E_FAKE_LAUNCH=1/);
    assert.match(policy.reason, /HARBOR_ALLOW_REAL_LAUNCH=1/);
  }

  assert.equal(resolveLaunchPolicy({
    userDataPath: ISOLATED_PROFILE,
    defaultUserDataPath: REAL_PROFILE,
    env: { HARBOR_ALLOW_REAL_LAUNCH: '1' },
  }).allowed, true);
});

test('an isolated profile refuses the same new-session drive when sessiond is selected', async () => {
  const policy = resolveLaunchPolicy({
    userDataPath: ISOLATED_PROFILE,
    defaultUserDataPath: REAL_PROFILE,
    env: { HARBOR_SESSION_BACKEND: 'sessiond' },
  });
  let underlyingCalled = false;
  const execFile = createInjectableExecFile(policy, {
    env: { HARBOR_SESSION_BACKEND: 'sessiond' },
    execFile: () => { underlyingCalled = true; },
  });
  const launch = createLaunchActions({ execFile });
  await assert.rejects(
    () => launch.newSession({ account: 'team', cwd: '/tmp/isolated-sessiond-project' }),
    /refusing to launch a real session/,
  );
  assert.equal(underlyingCalled, false, 'the blocked drive must not reach bin/ai or either backend');
});

test('the guard is a pass-through when the policy allows it', () => {
  const calls = [];
  const guarded = createSignalGuard({
    policy: { allowed: true, reason: null },
    processKill: (pid, signal) => { calls.push([pid, signal]); return 'called'; },
  });
  assert.equal(guarded(99, 'SIGTERM'), 'called');
  assert.deepEqual(calls, [[99, 'SIGTERM']]);
});

// ── native file dialogs ──────────────────────────────────────────────────────
//
// Live-caught 2026-07-26: the E2E gate popped a GNOME file chooser on Pat's
// real desktop every few minutes for ninety minutes. Electron routes
// showOpenDialog through org.freedesktop.portal.FileChooser on the SESSION BUS,
// which `xvfb-run` does not isolate, so the picker escaped the harness and
// blocked the main process waiting for an answer nobody could give.

test('the real profile still opens file dialogs', () => {
  const policy = resolveDialogPolicy({
    userDataPath: REAL_PROFILE, defaultUserDataPath: REAL_PROFILE, env: {},
  });
  assert.equal(policy.allowed, true);
  assert.equal(policy.optIn, false);
});

test('an isolated profile refuses a native file dialog and says why', () => {
  const policy = resolveDialogPolicy({
    userDataPath: ISOLATED_PROFILE, defaultUserDataPath: REAL_PROFILE, env: {},
  });
  assert.equal(policy.allowed, false);
  assert.match(policy.reason, /refusing to open a native file dialog/);
  // The reason has to name the mechanism, or the next person "fixes" it by
  // scrubbing DISPLAY again and watches it escape anyway.
  assert.match(policy.reason, /SESSION BUS/);
  assert.match(policy.reason, /HARBOR_ALLOW_REAL_DIALOGS=1/);
});

test('the dialog opt-in is honored, so a deliberate drive can still pick a folder', () => {
  const policy = resolveDialogPolicy({
    userDataPath: ISOLATED_PROFILE,
    defaultUserDataPath: REAL_PROFILE,
    env: { HARBOR_ALLOW_REAL_DIALOGS: '1' },
  });
  assert.equal(policy.allowed, true);
  assert.equal(policy.optIn, true);
});

test('the dialog guard names the caller so a test identifies itself', () => {
  const blocked = createDialogGuard({
    policy: resolveDialogPolicy({
      userDataPath: ISOLATED_PROFILE, defaultUserDataPath: REAL_PROFILE, env: {},
    }),
  });
  assert.throws(() => blocked('pick-folder'), (error) => {
    assert.equal(error.code, 'DIALOG_BLOCKED');
    assert.match(error.message, /blocked: pick-folder/);
    return true;
  });

  const allowed = createDialogGuard({
    policy: resolveDialogPolicy({
      userDataPath: REAL_PROFILE, defaultUserDataPath: REAL_PROFILE, env: {},
    }),
  });
  assert.doesNotThrow(() => allowed('pick-folder'));
});

test('an isolated profile refuses the default session store and the explicit escape allows the same drive', () => {
  const base = {
    userDataPath: ISOLATED_PROFILE,
    defaultUserDataPath: REAL_PROFILE,
    sessionDir: path.join(os.homedir(), '.local/state/harbor/sessiond'),
  };
  const blocked = resolveSessionStorePolicy({ ...base, env: {} });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /refusing to operate on the default session store/);
  assert.match(blocked.reason, /HARBOR_ALLOW_REAL_SESSION_STORE=1/);

  const allowed = resolveSessionStorePolicy({
    ...base,
    env: { HARBOR_ALLOW_REAL_SESSION_STORE: '1' },
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.optIn, true);
});

test('the real profile and an isolated session store remain allowed', () => {
  assert.equal(resolveSessionStorePolicy({
    userDataPath: REAL_PROFILE,
    defaultUserDataPath: REAL_PROFILE,
    env: {},
  }).allowed, true);
  assert.equal(resolveSessionStorePolicy({
    userDataPath: ISOLATED_PROFILE,
    defaultUserDataPath: REAL_PROFILE,
    sessionDir: '/tmp/harbor-sessiond-drive',
    env: { HARBOR_SESSIOND_DIR: '/tmp/harbor-sessiond-drive' },
  }).allowed, true);
});
