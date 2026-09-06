'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLinuxPlatform } = require('../../src/main/platform/linux.js');

test('linux processInfo distinguishes live Claude, recycled pid, zombie, and dead pid', async () => {
  const values = new Map([
    [11, Buffer.from('/usr/bin/claude\0--resume\0')],
    [12, Buffer.from('/usr/bin/bash\0')],
    [13, Buffer.alloc(0)],
  ]);
  const platform = createLinuxPlatform({
    readFile: async (file) => {
      // btime 1000s; pid 11 started 5000 ticks (USER_HZ=100) after boot, so
      // startedAt = 1000*1000 + 5000*10 = 1050000 ms. comm carries a space
      // and parens on purpose: fields must be taken after the LAST ')'.
      if (file === '/proc/stat') return 'cpu 1 2 3\nbtime 1000\n';
      if (file === '/proc/11/stat') return `11 (cl (aude)) S${' 0'.repeat(18)} 5000 0`;
      const match = /\/proc\/(\d+)\/cmdline/.exec(file);
      const pid = match ? Number(match[1]) : null;
      if (!values.has(pid)) { const error = new Error('gone'); error.code = 'ENOENT'; throw error; }
      return values.get(pid);
    },
    processKill: (pid, signal) => {
      if (pid === 14 && signal === 0) { const error = new Error('gone'); error.code = 'ESRCH'; throw error; }
    },
  });
  assert.deepEqual(await platform.processInfo(11), { alive: true, cmdline: '/usr/bin/claude\0--resume\0', isAgent: true, startedAt: 1050000 });
  assert.deepEqual(await platform.processInfo(12), { alive: true, cmdline: '/usr/bin/bash\0', isAgent: false });
  assert.deepEqual(await platform.processInfo(13), { alive: false, cmdline: '', isAgent: false });
  assert.deepEqual(await platform.processInfo(14), { alive: false, cmdline: '', isAgent: false });
});

test('linux killProcess preserves exact signals and verifies death', async () => {
  const calls = [];
  let alive = true;
  const platform = createLinuxPlatform({
    processKill: (pid, signal) => {
      calls.push([pid, signal]);
      if (signal === 'SIGTERM') alive = false;
      if (signal === 0 && !alive) { const error = new Error('gone'); error.code = 'ESRCH'; throw error; }
    },
    sleep: async () => {},
  });
  assert.equal((await platform.killProcess(22, 'SIGTERM')).died, true);
  assert.deepEqual(calls, [[22, 'SIGTERM'], [22, 0]]);
});
