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

test('a config home is routed by the SAME variable the launcher uses', () => {
  // bin/harbor-bin.cjs sets CLAUDE_CONFIG_DIR to pick a home, so if the wizard
  // used anything else the login and the launch would disagree about what a
  // plan is.
  const plan = auth.loginPlan('claude', { configHome: '/home/tester/.claude-team' });
  assert.deepEqual(plan.env, { CLAUDE_CONFIG_DIR: '/home/tester/.claude-team' });
  assert.equal(plan.display, 'CLAUDE_CONFIG_DIR=/home/tester/.claude-team claude auth login');
});

test('a path with spaces or quotes is quoted, never concatenated raw', () => {
  const plan = auth.loginPlan('claude', { configHome: "/home/a b/it's" });
  assert.match(plan.display, /CLAUDE_CONFIG_DIR='\/home\/a b\/it'/);
  // The argv itself stays unquoted: it is passed as argv, not through a shell.
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, "/home/a b/it's");
});

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
