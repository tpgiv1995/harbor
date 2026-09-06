'use strict';

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
// THE bin/ CONTRACT IS THE AUTHORITY HERE, NOT THE CONFIG SHAPE.
// Live-caught 2026-07-28: Pat could not start a new session. buildNewArgv had
// been changed to emit `--home <configHome path>` on the assumption that bin/ai
// accepted it. It does not select an account that way. The old bash ai rejected
// the flag outright ("unknown option"), and the Node rewrite that replaced it
// parses `--home` and then IGNORES it for account selection, so every launch
// silently went to the personal account no matter which button was clicked.
// bin/claude-sessions likewise took `--home <name>` validated against
// auto|team|personal|plan3 and died on a path.
//
// So these assertions pin the argv to what the scripts actually parse. bin/ai
// now takes `--home <PROFILE|CONFIG_HOME>` for every account (2026-08-07); the
// legacy per-account flags, one literal flag per account, are gone, since an account is a
// config home and the path already says which one. If a later batch changes
// what bin/ actually parses, change the scripts and these assertions together,
// and prove it with HARBOR_AI_DRY_RUN=1 before believing it.

const {
  createLaunchActions,
  buildResumeArgv,
  buildProviderResumeArgv,
  buildNewArgv,
  CLAUDE_SESSIONS,
  AI_BIN,
} = require('../../src/main/actions/launch.js');
const { scriptInvocation } = require('../../src/main/script-exec.js');

function makeExecRecorder() {
  const calls = [];
  const execFile = (command, argv, optionsOrCb, maybeCb) => {
    const options = typeof optionsOrCb === 'object' ? optionsOrCb : null;
    const cb = maybeCb || (typeof optionsOrCb === 'function' ? optionsOrCb : null);
    const script = [AI_BIN, CLAUDE_SESSIONS].find((candidate) => {
      const invocation = scriptInvocation(candidate, []);
      return command === invocation.command
        && invocation.args.every((arg, index) => argv[index] === arg);
    });
    const prefixLength = script ? scriptInvocation(script, []).args.length : 0;
    calls.push({ command: script || command, argv: argv.slice(prefixLength), options });
    if (cb) cb(null, '', '');
  };
  return { execFile, calls };
}

// Profiles are INJECTED, and the fallback is asserted as "the DEFAULT profile"
// rather than as a literal name (2026-08-06). This test used to say
// "unattributed falls back to team", which was only ever true of one machine's
// hardcoded seed. Profiles are DISCOVERED now (config/homes.js), so the default
// is whichever profile that machine's own directories make default, and pinning
// the word "team" was pinning the author's account list into a spec.
const RESUME_PROFILES = [
  { id: 'personal', configHome: '/home/example/.claude', isDefault: true },
  { id: 'team', configHome: '/home/example/.claude-team' },
  { id: 'plan3', configHome: '/home/example/.claude-plan3' },
];
const DEFAULT_ID = RESUME_PROFILES.find((p) => p.isDefault).id;

test('resume argv matrix: each home routes to itself, unattributed falls back to the default', async () => {
  const { execFile, calls } = makeExecRecorder();
  const launch = createLaunchActions({ execFile, profiles: RESUME_PROFILES });
  const P = RESUME_PROFILES;

  for (const id of ['personal', 'team', 'plan3']) {
    assert.deepEqual(buildResumeArgv({ id: `${id}-id`, detectedHome: id, profiles: P }), [
      '--resume-id', `${id}-id`, '--home', id,
    ], `${id} must route to its own home`);
  }
  assert.deepEqual(buildResumeArgv({ id: 'unknown-id', detectedHome: null, profiles: P }), [
    '--resume-id', 'unknown-id', '--home', DEFAULT_ID,
  ]);

  await launch.resumeSession({ id: 'team-id', detectedHome: 'team' });
  await launch.resumeSession({ id: 'unknown-id', detectedHome: null });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, CLAUDE_SESSIONS);
  assert.deepEqual(calls[0].argv, ['--resume-id', 'team-id', '--home', 'team']);
  assert.deepEqual(calls[1].argv, ['--resume-id', 'unknown-id', '--home', DEFAULT_ID]);
});

test('resume argv adds --live-ok only when explicitly requested', () => {
  // Profiles are INJECTED (RESUME_PROFILES, which already carries a 'team'
  // id): unwired, this falls through to legacyConfig()'s real ~/.claude*
  // discovery, and 'team' only resolves to itself on a machine that happens
  // to have a ~/.claude-team directory. Everywhere else it silently falls
  // back to the default profile, which made this pass or fail by whose
  // machine ran it.
  assert.deepEqual(buildResumeArgv({ id: 'takeover-id', detectedHome: 'team', liveOk: true, profiles: RESUME_PROFILES }), [
    '--resume-id', 'takeover-id', '--home', 'team', '--live-ok',
  ]);
  assert.deepEqual(buildResumeArgv({ id: 'plain-id', detectedHome: 'team', profiles: RESUME_PROFILES }), [
    '--resume-id', 'plain-id', '--home', 'team',
  ]);
});

test('resume argv carries an unanswered message without truncation', () => {
  const text = `original question\n${'detail '.repeat(6000)}`;
  assert.deepEqual(buildResumeArgv({
    id: 'mid-turn-id',
    detectedHome: 'team',
    profiles: RESUME_PROFILES,
    resumePrompt: text,
  }), ['--resume-id', 'mid-turn-id', '--home', 'team', '--prompt', text]);
});

test('resume does not execute real claude-sessions in tests', async () => {
  let executed = false;
  const launch = createLaunchActions({
    // Arity-agnostic on purpose: execFile is overloaded, and on Windows the
    // launcher passes an options object (to set ELECTRON_RUN_AS_NODE, since a
    // shebang script cannot be executed there) that it does not pass on POSIX.
    // A fixed three-parameter stub bound `cb` to that options object and failed
    // with "cb is not a function" on Windows only, which is a test that
    // encodes one platform's calling convention rather than the behaviour.
    execFile: (...args) => {
      executed = true;
      const cb = args[args.length - 1];
      if (typeof cb === 'function') cb(null, '', '');
    },
  });
  await launch.resumeSession({ id: 'abc', detectedHome: 'team' });
  assert.equal(executed, true);
});

// Profiles are INJECTED for the pure builders, never read from the developer's
// own config (2026-08-06). These assertions used to fall through to
// `legacyConfig()`, which reads the real ~/.config/harbor/config.json, so they
// asserted one machine's account paths and passed only there: a fresh clone with
// a different home, or a contributor with two accounts instead of three, got
// failures that said nothing about the code. The shape under test is "a profile
// resolves to ITS configured home", and that needs a fixture, not an install.
const FIXTURE_HOME = '/home/example';
const FIXTURE_PROFILES = [
  { id: 'personal', label: 'Personal', configHome: `${FIXTURE_HOME}/.claude` },
  { id: 'team', label: 'Team', configHome: `${FIXTURE_HOME}/.claude-team`, isDefault: true },
  { id: 'plan3', label: 'Plan 3', configHome: `${FIXTURE_HOME}/.claude-plan3` },
];

test('buildNewArgv resolves every profile to its configured home', () => {
  const P = FIXTURE_PROFILES;
  assert.deepEqual(buildNewArgv({ account: 'team', profiles: P }), ['--home', `${FIXTURE_HOME}/.claude-team`]);
  assert.deepEqual(buildNewArgv({ account: 'plan3', profiles: P }), ['--home', `${FIXTURE_HOME}/.claude-plan3`]);
  assert.deepEqual(buildNewArgv({ account: 'personal', profiles: P }), ['--home', `${FIXTURE_HOME}/.claude`]);
  // null and an unknown id both fall back to the DEFAULT profile.
  assert.deepEqual(buildNewArgv({ account: null, profiles: P }), ['--home', `${FIXTURE_HOME}/.claude-team`]);
  assert.deepEqual(buildNewArgv({ account: 'unknown', profiles: P }), ['--home', `${FIXTURE_HOME}/.claude-team`]);
});

test('opaque profile ids never participate in path construction', () => {
  const profiles = [{
    id: '../ odd / id',
    configHome: '/safe/config home',
    isDefault: true,
  }];
  // An id bin/ has never heard of must produce NO account flag rather than a
  // bogus one: claude-sessions `die`s on an unknown --home and aborts the resume.
  assert.deepEqual(buildNewArgv({ account: '../ odd / id', profiles }), ['--home', '/safe/config home']);
  assert.deepEqual(buildResumeArgv({ id: 'session', detectedHome: '../ odd / id', profiles }), [
    '--resume-id', 'session',
  ]);
});

test('buildNewArgv appends provider, model, and effort without changing defaults', () => {
  const P = FIXTURE_PROFILES;
  assert.deepEqual(buildNewArgv({ account: 'personal', provider: 'claude', model: 'opus', effort: 'default', profiles: P }), ['--home', `${FIXTURE_HOME}/.claude`, '--model', 'opus']);
  assert.deepEqual(buildNewArgv({ account: 'personal', provider: 'claude', model: 'opus', effort: 'high', profiles: P }), [
    '--home', `${FIXTURE_HOME}/.claude`, '--model', 'opus', '--effort', 'high',
  ]);
  assert.deepEqual(buildNewArgv({ account: 'team', provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', profiles: P }), [
    '--provider', 'codex', '--model', 'gpt-5.6-sol', '--effort', 'xhigh',
  ]);
  assert.deepEqual(buildNewArgv({ account: 'personal', provider: 'cursor', model: 'default', profiles: P }), [
    '--provider', 'cursor',
  ]);
  // A bare Start must behave exactly like today's bare click: no --model.
  assert.deepEqual(buildNewArgv({ account: 'personal', provider: 'claude', model: 'default', effort: 'default', profiles: P }), ['--home', `${FIXTURE_HOME}/.claude`]);
});

test('provider launches and resumes select only a profile owned by that provider', () => {
  const profiles = [
    ...FIXTURE_PROFILES,
    { id: 'codex-work', provider: 'codex', configHome: `${FIXTURE_HOME}/.codex-work`, isDefault: true },
    { id: 'codex-lab', provider: 'codex', configHome: `${FIXTURE_HOME}/.codex-lab` },
  ];
  assert.deepEqual(buildNewArgv({ account: 'team', provider: 'codex', profiles }), [
    '--home', `${FIXTURE_HOME}/.codex-work`, '--provider', 'codex',
  ], 'a foreign Claude account falls back to the Codex default');
  assert.deepEqual(buildProviderResumeArgv({
    provider: 'codex', id: 'session-id', detectedHome: 'codex-lab', profiles,
  }), ['--provider', 'codex', '--resume-id', 'session-id', '--home', `${FIXTURE_HOME}/.codex-lab`]);
  assert.deepEqual(buildProviderResumeArgv({
    provider: 'cursor', id: 'session-id', detectedHome: `${FIXTURE_HOME}/cursor`, profiles,
  }), ['--provider', 'cursor', '--resume-id', 'session-id'], 'Cursor never invents a home flag');
});

test('newSession: calls AI_BIN with correct argv and cwd for team', async () => {
  // Profiles are INJECTED (FIXTURE_PROFILES): unwired this falls through to
  // legacyConfig()'s real ~/.claude* discovery, and `team` only resolves to
  // `${os.homedir()}/.claude-team` on a machine that actually has that
  // directory (the author's). cwd itself stays a plain string; it is never
  // validated against the real filesystem here, so it needs no fixture.
  const { execFile, calls } = makeExecRecorder();
  const launch = createLaunchActions({ execFile, profiles: FIXTURE_PROFILES });
  const result = await launch.newSession({ account: 'team', cwd: `${os.homedir()}/myproject` });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, AI_BIN);
  assert.deepEqual(calls[0].argv.slice(0, 2), ['--home', `${FIXTURE_HOME}/.claude-team`]);
  assert.equal(calls[0].argv[2], '--session-id');
  assert.match(calls[0].argv[3], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(calls[0].options?.cwd, `${os.homedir()}/myproject`);
  assert.equal(result.command, AI_BIN);
  assert.equal(result.cwd, `${os.homedir()}/myproject`);
  assert.equal(result.sessionId, calls[0].argv[3]);
});

test('newSession: passes the configured home for the first account', async () => {
  const { execFile, calls } = makeExecRecorder();
  const launch = createLaunchActions({ execFile });
  await launch.newSession({ account: 'personal', cwd: '/tmp/test' });
  assert.deepEqual(calls[0].argv.slice(0, 2), ['--home', path.join(os.homedir(), '.claude')]);
  assert.equal(calls[0].argv[2], '--session-id');
  assert.match(calls[0].argv[3], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('newSession: launches the rail defaults for every Claude account', async () => {
  // Profiles are INJECTED here (FIXTURE_PROFILES), not read from this
  // machine's real config homes: the point under test is that every account
  // launches on ITS OWN home, and pinning that to whichever `.claude*`
  // directories happen to exist locally would pass or fail by whose machine
  // ran it.
  const P = FIXTURE_PROFILES;
  for (const [account, accountArgv] of [
    ['personal', ['--home', `${FIXTURE_HOME}/.claude`]],
    ['team', ['--home', `${FIXTURE_HOME}/.claude-team`]],
    ['plan3', ['--home', `${FIXTURE_HOME}/.claude-plan3`]],
  ]) {
    const { execFile, calls } = makeExecRecorder();
    const launch = createLaunchActions({ execFile, profiles: P });
    await launch.newSession({
      account,
      cwd: '/tmp/project',
      provider: 'claude',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
    });
    assert.deepEqual(calls[0].argv.slice(0, -2), [
      ...accountArgv,
      '--model', 'claude-opus-4-8',
      '--effort', 'xhigh',
    ]);
    assert.equal(calls[0].argv.at(-2), '--session-id');
    assert.match(calls[0].argv.at(-1), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('newSession: rejects if cwd is missing', async () => {
  const { execFile } = makeExecRecorder();
  const launch = createLaunchActions({ execFile });
  await assert.rejects(() => launch.newSession({ account: 'team' }), /cwd/);
});

test('resumeProviderSession: bin/ai resume argv in the session cwd, claude and cwd-less rejected', async () => {
  const { execFile, calls } = makeExecRecorder();
  const launch = createLaunchActions({ execFile });
  // A REAL directory: resume refuses a deleted working folder by design
  // (live-caught 2026-07-24), so the happy path must use one that exists.
  const realCwd = require('node:os').tmpdir();
  const result = await launch.resumeProviderSession({
    provider: 'codex', cwd: realCwd, id: 'abc-123',
  });
  assert.equal(result.command, launch.AI_BIN);
  assert.deepEqual(calls[0].argv, ['--provider', 'codex', '--resume-id', 'abc-123']);
  assert.equal(calls[0].options.cwd, realCwd);
  await assert.rejects(
    () => launch.resumeProviderSession({ provider: 'codex', cwd: '/nonexistent/deleted-project', id: 'zz' }),
    /no longer exists/,
  );
  await assert.rejects(() => launch.resumeProviderSession({ provider: 'claude', cwd: '/x', id: 'i' }), /codex\/cursor only/);
  await assert.rejects(() => launch.resumeProviderSession({ provider: 'cursor', id: 'i' }), /working folder/);
});

// THE DEATH RATTLE IS NOT A HEARTBEAT (live-caught 2026-08-03).
//
// bin/claude-sessions refuses a resume whose transcript was written in the
// last 90 seconds. A claude WRITES ITS TRANSCRIPT ON THE WAY OUT, so a fleet
// killed together (herdr daemon recovery at 20:14:13.665Z that day, or an
// oomd kill of the daemon's cgroup) is un-resumable for 90 seconds precisely
// BECAUSE it just died: two of Pat's sessions refused four times over four
// minutes with his typed messages stranded in their composers.
//
// Harbor proves ownership from the process (tee pid, /proc, id scan) instead
// of guessing it from an mtime, and passes --live-ok on proof. Two-sided ON
// PURPOSE: proof alone would also pass if the flag were emitted
// unconditionally, which would delete the double-writer protection outright.
test('a PROVEN-dead owner resumes at once; anything less leaves the live guard standing', async () => {
  // Profiles are INJECTED (RESUME_PROFILES) for the same reason as the
  // '--live-ok' spec above: unwired, 'team' only resolves to itself when the
  // machine running the suite happens to have a ~/.claude-team directory.
  const argvFor = async (isSessionUnowned) => {
    const { execFile, calls } = makeExecRecorder();
    const launch = createLaunchActions({ execFile, isSessionUnowned, profiles: RESUME_PROFILES });
    await launch.resumeSession({ id: 'dead-fleet-id', detectedHome: 'team' });
    return calls[0].argv;
  };

  assert.deepEqual(await argvFor(async () => true), [
    '--resume-id', 'dead-fleet-id', '--home', 'team', '--live-ok',
  ]);
  // Not proven: no tee, an unreadable start time, another live process holding
  // the id. Every one of those means "do not claim to know".
  assert.deepEqual(await argvFor(async () => false), [
    '--resume-id', 'dead-fleet-id', '--home', 'team',
  ]);
  // A probe that throws is an ambiguity, never an authorization.
  assert.deepEqual(await argvFor(async () => { throw new Error('boom'); }), [
    '--resume-id', 'dead-fleet-id', '--home', 'team',
  ]);
  // Unwired (harnesses, tests, the server head before it composes a platform)
  // the argv stays byte-identical to the pre-fix behaviour.
  const { execFile, calls } = makeExecRecorder();
  await createLaunchActions({ execFile, profiles: RESUME_PROFILES }).resumeSession({ id: 'plain', detectedHome: 'team' });
  assert.deepEqual(calls[0].argv, ['--resume-id', 'plain', '--home', 'team']);
});

// adopt-on-send has already verified AND killed the owner by the time it
// resumes, so its explicit liveOk must not be re-litigated by the probe (the
// pid it just killed is gone, but the scan is best-effort and a stray match
// would strand the adopted session with no process left to go back to).
test('an explicit liveOk from adopt-on-send is never downgraded by the probe', async () => {
  const { execFile, calls } = makeExecRecorder();
  let probed = false;
  const launch = createLaunchActions({
    execFile,
    isSessionUnowned: async () => { probed = true; return false; },
  });
  await launch.resumeSession({ id: 'adopted-id', detectedHome: 'personal', liveOk: true });
  assert.deepEqual(calls[0].argv, ['--resume-id', 'adopted-id', '--home', 'personal', '--live-ok']);
  assert.equal(probed, false, 'a settled ownership question must not be asked again');
});

// The probe introduced an await BEFORE the single-flight map was populated in
// the first draft of this fix, which reopened the exact race the guard exists
// to close: two claude --resume processes on one transcript.
test('the ownership probe never reopens the single-flight window', async () => {
  // Profiles are INJECTED (RESUME_PROFILES); see the '--live-ok' spec above.
  const { execFile, calls } = makeExecRecorder();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const launch = createLaunchActions({
    execFile,
    isSessionUnowned: async () => { await gate; return true; },
    profiles: RESUME_PROFILES,
  });
  const first = launch.resumeSession({ id: 'raced-id', detectedHome: 'team' });
  const second = launch.resumeSession({ id: 'raced-id', detectedHome: 'team' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1, 'one resume process for one session id');
  assert.deepEqual(calls[0].argv, ['--resume-id', 'raced-id', '--home', 'team', '--live-ok']);
  // The deduped caller gets the same answer, not undefined.
  assert.deepEqual(a, b);
  assert.equal(a.command, CLAUDE_SESSIONS);
});
