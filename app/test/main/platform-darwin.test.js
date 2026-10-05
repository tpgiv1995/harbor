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
