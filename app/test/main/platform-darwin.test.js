'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDarwinPlatform } = require('../../src/main/platform/darwin.js');

test('darwin ps query distinguishes Claude, recycled pid, zombie, and dead pid', async () => {
  // ps output now carries etime between state and command: the takeover
  // owner ladder verifies a fresh claude by start time (see takeover.js).
  const outputs = new Map([
    [301, ' S 01:05 claude --resume abc\n'],
    [302, ' S 1-02:03:04 /bin/zsh\n'],
    [303, ' Z 00:10 claude --resume abc\n'],
  ]);
  const platform = createDarwinPlatform({
    run: async (_command, args) => ({ stdout: outputs.get(Number(args[1])) || '' }),
  });
  const before = Date.now();
  const claude = await platform.processInfo(301);
  const after = Date.now();
  assert.equal(claude.alive, true);
  assert.equal(claude.cmdline, 'claude --resume abc');
  assert.equal(claude.isAgent, true);
  // etime 01:05 = 65s ago, bounded by the wall clocks around the call.
  assert.ok(claude.startedAt >= before - 65000 && claude.startedAt <= after - 65000 + 1000,
    `startedAt ${claude.startedAt} must be ~65s before now`);
  const zsh = await platform.processInfo(302);
  assert.equal(zsh.isAgent, false);
  assert.ok(Number.isFinite(zsh.startedAt), 'day-form etime still parses');
  assert.deepEqual(await platform.processInfo(303), { alive: false, cmdline: '', isAgent: false });
  assert.deepEqual(await platform.processInfo(304), { alive: false, cmdline: '', isAgent: false });
});

test('darwin focus guard reports unavailable rather than pretending success', () => {
  const logs = [];
  const platform = createDarwinPlatform({ logger: { warn: (message) => logs.push(message) } });
  assert.equal(platform.focusGuard().available, false);
  assert.match(logs[0], /unavailable/);
});


test('darwin starts a daemon by spawning it directly, not through launchctl submit', () => {
  // REGRESSION GUARD, 2026-08-28. `launchctl submit` ran the daemon in
  // LAUNCHD's environment, which silently discarded the caller's env — the very
  // thing that carries ELECTRON_RUN_AS_NODE for a packaged .app. Its label was
  // also never cleared, so a job parked at exit 127 made every later submit
  // fail and wedged auto-start for the rest of the boot. linux.js and win32.js
  // never had either problem, because they spawn directly.
  const calls = [];
  const platform = createDarwinPlatform({
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { pid: 4242, unref() { this.unrefd = true; } };
    },
  });
  const pid = platform.startDaemon('/Harbor.app/Contents/MacOS/Harbor',
    ['/Harbor.app/Contents/Resources/bin/harbor-sessiond', 'start'],
    { env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' } });

  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].command, 'launchctl', 'launchctl submit cannot carry the caller env');
  assert.equal(calls[0].command, '/Harbor.app/Contents/MacOS/Harbor');
  assert.deepEqual(calls[0].args, ['/Harbor.app/Contents/Resources/bin/harbor-sessiond', 'start']);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1', 'the interpreter selector must reach the daemon');
  assert.equal(calls[0].options.detached, true, 'the daemon must outlive the app that started it');
  assert.equal(calls[0].options.stdio, 'ignore');
  // The pid is the SPAWNED CHILD's — `harbor-sessiond start`, a wrapper that
  // health-waits and exits — not the daemon's. What launchctl got wrong was
  // returning a pid for a process it did not even spawn; the contract now is
  // "the pid of the process startDaemon started", nothing more.
  assert.equal(pid, 4242, 'the pid must be the spawned starter, not a launchctl wrapper it never ran');
});
