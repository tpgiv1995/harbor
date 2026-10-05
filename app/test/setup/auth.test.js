'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../../src/main/setup/auth.js');

// The commands below are not invented. They were read off the installed
// binaries on 2026-07-29:
//   claude auth --help   -> "login   Sign in to your Anthropic account"
//   codex --help         -> "login   Manage login"
//   cursor-agent --help  -> "login   Authenticate with Cursor"
test('each provider gets the vendor’s OWN login command', () => {
  assert.deepEqual(auth.loginPlan('claude').argv, ['claude', 'auth', 'login']);
  assert.deepEqual(auth.loginPlan('codex').argv, ['codex', 'login']);
  assert.deepEqual(auth.loginPlan('cursor').argv, ['cursor-agent', 'login']);
});

for (const platform of ['linux', 'darwin', 'win32']) {
test(`${platform}: a config home is routed by the SAME variable the launcher uses`, () => {
  // bin/harbor-bin.cjs sets CLAUDE_CONFIG_DIR to pick a home, so if the wizard
  // used anything else the login and the launch would disagree about what a
  // plan is.
  const plan = auth.loginPlan('claude', { configHome: '/home/tester/.claude-team' }, { platform });
  assert.deepEqual(plan.env, { CLAUDE_CONFIG_DIR: '/home/tester/.claude-team' });
  assert.equal(plan.display, platform === 'win32'
    ? "$env:CLAUDE_CONFIG_DIR = '/home/tester/.claude-team'; claude auth login"
    : 'CLAUDE_CONFIG_DIR=/home/tester/.claude-team claude auth login');
});

test(`${platform}: a path with spaces or quotes is quoted, never concatenated raw`, () => {
  const plan = auth.loginPlan('claude', { configHome: "/home/a b/it's" }, { platform });
  if (platform === 'win32') assert.equal(plan.display, "$env:CLAUDE_CONFIG_DIR = '/home/a b/it''s'; claude auth login");
  else assert.match(plan.display, /CLAUDE_CONFIG_DIR='\/home\/a b\/it'/);
  // The argv itself stays unquoted: it is passed as argv, not through a shell.
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, "/home/a b/it's");
});
}

test('NOTHING in a login plan can carry a credential', () => {
  // Structural, not a spot check: this is the single most important property
  // of the whole wizard, so it is walked rather than eyeballed.
  const forbidden = /(api[-_]?key|secret|token|password|credential|bearer)/i;
  for (const provider of ['claude', 'codex', 'cursor']) {
    const plan = auth.loginPlan(provider, { configHome: '/h/.claude' });
    for (const key of Object.keys(plan.env)) {
      assert.ok(!forbidden.test(key), `${provider} login env carries ${key}`);
    }
    assert.ok(!forbidden.test(JSON.stringify(plan)), `${provider} plan mentions a credential`);
  }
});

test('an unknown provider throws instead of composing a nonsense command', () => {
  assert.throws(() => auth.loginPlan('gemini'), /unknown provider/);
});

test('an ISOLATED profile refuses to launch a real login, and says why', async () => {
  // A login opens a real browser against a real account, which is exactly the
  // class of effect an isolated Harbor must not have; the wizard is the first
  // screen a drive walks through, so this is where it would escape.
  let spawned = 0;
  const result = await auth.launchLogin('claude', { configHome: '/h/.claude' }, {
    platform: 'linux',
    launchPolicy: { allowed: false, reason: 'refusing to launch a real session: isolated profile' },
    spawn: () => { spawned += 1; return { pid: 1, unref() {} }; },
    hasCommand: () => true,
  });
  assert.equal(spawned, 0, 'nothing was spawned');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAUNCH_BLOCKED');
  // Refusing is not dead-ending: the exact command is still handed over.
  assert.equal(result.manualCommand, 'CLAUDE_CONFIG_DIR=/h/.claude claude auth login');
});

test('the same call DOES launch when the policy allows it (two-sided)', async () => {
  // A refusal alone would pass just as well if the code never reached the
  // spawn, so the permitted branch is asserted too.
  const calls = [];
  const result = await auth.launchLogin('claude', { configHome: '/h/.claude' }, {
    platform: 'linux',
    launchPolicy: { allowed: true },
    spawn: (command, args) => { calls.push({ command, args }); return { pid: 4242, unref() {} }; },
    hasCommand: (name) => name === 'gnome-terminal',
  });
  assert.equal(result.launched, true);
  assert.equal(result.pid, 4242);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gnome-terminal');
  assert.deepEqual(calls[0].args, ['--', 'claude', 'auth', 'login']);
});

test('no terminal on the machine degrades to instructions, never to an error', async () => {
  const result = await auth.launchLogin('codex', {}, {
    platform: 'linux',
    launchPolicy: { allowed: true },
    hasCommand: () => false,
    spawn: () => { throw new Error('should not be reached'); },
  });
  assert.equal(result.code, 'NO_TERMINAL');
  assert.equal(result.manualCommand, 'codex login');
  assert.match(result.reason, /Run the command below yourself/);
});

test('each platform opens a terminal the way that platform actually can', () => {
  const plan = auth.loginPlan('claude', { configHome: '/h/.claude' });

  const linux = auth.terminalPlan(plan, { platform: 'linux', hasCommand: (n) => n === 'xterm' });
  assert.equal(linux.command, 'xterm');
  assert.deepEqual(linux.args, ['-e', 'claude', 'auth', 'login']);

  const windows = auth.terminalPlan(plan, { platform: 'win32', hasCommand: () => false });
  assert.equal(windows.command, 'cmd.exe');
  assert.ok(windows.args.includes('start'), 'start is a cmd builtin and needs cmd to run it');
  assert.ok(windows.args.join(' ').includes('claude auth login'));

  const darwin = auth.terminalPlan(plan, { platform: 'darwin', hasCommand: () => false });
  assert.equal(darwin.command, 'osascript');
  assert.ok(darwin.args.join(' ').includes('CLAUDE_CONFIG_DIR'), 'macOS still routes the home');
});

test('a spawn that fails is reported honestly with the command to run by hand', async () => {
  const result = await auth.launchLogin('cursor', {}, {
    platform: 'linux',
    launchPolicy: { allowed: true },
    hasCommand: () => true,
    spawn: () => { throw new Error('ENOENT'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SPAWN_FAILED');
  assert.equal(result.manualCommand, 'cursor-agent login');
});

// 2026-09-19: `bin` and `configHome` reach loginPlan straight from
// the renderer, and on win32 `bin` lands inside a real cmd.exe command line
// (terminalPlan below). Every refusal here is paired with the matching
// legitimate case, per this repo's two-sided standard.
test('validateBin refuses a cmd.exe metacharacter in ANY shape, bare or pathlike', () => {
  for (const bad of ['claude & calc.exe', 'claude|calc', 'claude>out.txt', 'claude<in.txt', 'claude^x', 'claude%x%', 'claude!x!', 'claude"x', 'claude\r\ncalc']) {
    const verdict = auth.validateBin(bad);
    assert.equal(verdict.ok, false, `expected "${bad}" to be refused`);
    assert.match(verdict.reason, /shell would interpret/);
  }
});

test('validateBin refuses a relative path and an absolute path to nothing', () => {
  assert.equal(auth.validateBin('relative/claude').ok, false);
  assert.match(auth.validateBin('relative/claude').reason, /not a plain command name or an absolute path/);
  const missing = auth.validateBin('/opt/does-not-exist/claude', { existsSync: () => false });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /does not exist/);
});

test('validateBin allows a bare command name and an absolute path that exists', () => {
  assert.equal(auth.validateBin('claude').ok, true);
  assert.equal(auth.validateBin('cursor-agent').ok, true);
  assert.equal(auth.validateBin('').ok, true, 'empty falls back to the provider default, not a rejection');
  assert.equal(auth.validateBin(undefined).ok, true);
  const found = auth.validateBin('/opt/claude/claude', { existsSync: () => true });
  assert.equal(found.ok, true, found.reason);
});

test('loginPlan itself refuses an unsafe bin before building anything', () => {
  assert.throws(() => auth.loginPlan('claude', { bin: 'claude & calc.exe' }), /shell would interpret/);
  assert.throws(() => auth.loginPlan('claude', { bin: 'relative/claude' }), /not a plain command name or an absolute path/);
  // Two-sided: the same call with a SAFE bin still works.
  assert.equal(auth.loginPlan('claude', { bin: 'claude' }).command, 'claude');
});

test('terminalPlan refuses to build a win32 command line for an argv element that slipped past validation', () => {
  // Simulates a `plan` assembled by hand (bypassing loginPlan), proving the
  // defensive re-check inside terminalPlan is not merely decorative.
  const plan = { argv: ['claude', 'auth', 'login & calc.exe'], env: {} };
  assert.throws(
    () => auth.terminalPlan(plan, { platform: 'win32' }),
    /refusing to build a cmd\.exe command line/,
  );
});

test('isLocalAbsoluteConfigHome refuses a relative path, a UNC share, and a device path; allows a local absolute path', () => {
  assert.equal(auth.isLocalAbsoluteConfigHome('relative/.claude').ok, false);
  assert.match(auth.isLocalAbsoluteConfigHome('relative/.claude').reason, /not an absolute path/);
  for (const unc of ['\\\\server\\share\\.claude', '//server/share/.claude', '\\\\.\\PhysicalDrive0', '\\\\?\\C:\\Users\\me\\.claude']) {
    const verdict = auth.isLocalAbsoluteConfigHome(unc);
    assert.equal(verdict.ok, false, `expected "${unc}" to be refused`);
    assert.match(verdict.reason, /network or device path/);
  }
  assert.equal(auth.isLocalAbsoluteConfigHome('C:\\Users\\me\\.claude').ok, true);
  assert.equal(auth.isLocalAbsoluteConfigHome('').ok, true, 'nothing chosen is not a rejection');
});

test('isSafeConfigHome allows a home under the given homedir or in the allowlist, refuses a stranger', () => {
  const ctx = { homedir: 'C:\\Users\\me', allowedHomes: ['C:\\Users\\someone-else\\.claude-shared'] };
  assert.equal(auth.isSafeConfigHome('C:\\Users\\me\\.claude', ctx).ok, true);
  assert.equal(auth.isSafeConfigHome('C:\\Users\\me\\deep\\nested\\.claude', ctx).ok, true, 'nested under the home is still under it');
  assert.equal(auth.isSafeConfigHome('C:\\Users\\someone-else\\.claude-shared', ctx).ok, true, 'a saved profile home outside the homedir is still known');
  const stranger = auth.isSafeConfigHome('C:\\Windows\\System32\\whatever', ctx);
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /not one of Harbor's known config homes/);
  // A near-miss must not pass by prefix accident: 'C:\Users\meREALLY' starts
  // with the string 'C:\Users\me' but is not a subdirectory of it.
  const nearMiss = auth.isSafeConfigHome('C:\\Users\\meREALLY\\not-my-folder', ctx);
  assert.equal(nearMiss.ok, false);
});

test('a launched login never CLAIMS the sign-in worked', () => {
  // Harbor cannot see a login finish: it happens in another process, in a
  // browser. Claiming success would be the proxy-verification this repo bans.
  return auth.launchLogin('claude', {}, {
    platform: 'linux',
    launchPolicy: { allowed: true },
    hasCommand: () => true,
    spawn: () => ({ pid: 1, unref() {} }),
  }).then((result) => {
    assert.match(result.note, /press Re-check/);
    assert.ok(!/signed in|success/i.test(result.note));
  });
});

// Windows paths are case-insensitive and this comparison was not: a home typed
// with a lowercase drive and folder names was judged "outside your home
// directory" against the same folder spelled the way the OS reports it, and the
// sign-in was refused (2026-09-19). One folder, two spellings.
test('on Windows a config home under the home directory matches whatever its letter case', () => {
  const opts = { homedir: 'C:\\Users\\Someone', platform: 'win32' };
  assert.equal(auth.isSafeConfigHome('c:\\users\\someone\\.claude-work', opts).ok, true);
  assert.equal(auth.isSafeConfigHome('C:\\USERS\\SOMEONE\\.claude-work', opts).ok, true);
  assert.equal(auth.isSafeConfigHome('C:\\Users\\SomeoneElse\\.claude', opts).ok, false, 'a sibling that merely shares a prefix is still outside');
  const known = { homedir: 'C:\\Users\\Someone', platform: 'win32', allowedHomes: ['D:\\AI\\Claude-Work'] };
  assert.equal(auth.isSafeConfigHome('d:\\ai\\claude-work', known).ok, true, 'a known home matches case-insensitively too');
});

test('on POSIX the same comparison stays case-sensitive', () => {
  const verdict = auth.isSafeConfigHome('/home/Someone/.claude', { homedir: '/home/someone', platform: 'linux' });
  assert.equal(verdict.ok, false);
});
