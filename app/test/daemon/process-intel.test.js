'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessIntel } = require('../../src/daemon/process-intel.js');
const { winCpuSnapshot } = require('../../src/daemon/dormancy.js');
const { snapshotProcessTable } = require('../../src/daemon/orphan-sweep.js');

function nativeFixture(rows, calls = []) {
  return {
    snapshot: () => new Map(rows.map((row) => [row.pid, row])),
    commandLine: (pid) => { calls.push(pid); return { ok: true, cmdline: rows.find((row) => row.pid === pid)?.command || '' }; },
  };
}

function rows(created = 100n) {
  return [
    { pid: process.pid, ppid: process.ppid, name: 'node.exe', created, cpuUsec: 10, workingSet: 20, privateBytes: 30, command: 'node daemon.js' },
    { pid: 70001, ppid: process.pid, name: 'claude.exe', created: created + 1n, cpuUsec: 40, workingSet: 50, privateBytes: 60, command: 'claude --session-id abc' },
  ];
}

test('resident intel answers info/tree/find from memory without spawning and caches cmdline by pid+creation', () => {
  const calls = [];
  const intel = createProcessIntel({ platform: 'win32', native: nativeFixture(rows(), calls), refreshMs: 0 });
  assert.equal(intel.start(), true);
  assert.equal(intel.info(70001).cmdline, 'claude --session-id abc');
  assert.deepEqual(intel.tree(process.pid).processes.map((row) => row.pid), [process.pid, 70001]);
  assert.equal(intel.find('abc').processes[0].pid, 70001);
  assert.equal(calls.filter((pid) => pid === 70001).length, 1, 'hot queries share the lazy cmdline cache');
  intel.stop();
});

test('stale snapshots refuse and recycled pids do not retain old identity or cmdline', () => {
  let now = 1000;
  let current = rows(100n);
  const calls = [];
  const native = { snapshot: () => new Map(current.map((row) => [row.pid, row])), commandLine: nativeFixture(current, calls).commandLine };
  const intel = createProcessIntel({ platform: 'win32', native, clock: () => now, staleMs: 50, refreshMs: 0 });
  intel.start();
  assert.equal(intel.alive(70001, 101n), true);
  assert.equal(intel.info(70001).cmdline, 'claude --session-id abc');
  now = 1051;
  assert.equal(intel.info(70001), null);
  current = rows(200n);
  native.commandLine = nativeFixture(current, calls).commandLine;
  intel.refresh();
  assert.equal(intel.alive(70001, 101n), false);
  assert.equal(intel.info(70001).cmdline, 'claude --session-id abc');
  assert.equal(calls.filter((pid) => pid === 70001).length, 2, 'recycled identity causes a new cmdline read');
});

test('broken intel is disabled once while existing CIM readers still spawn PowerShell', async () => {
  const logs = [];
  const intel = createProcessIntel({ platform: 'win32', native: { snapshot() { throw new Error('layout broke'); } }, log: (line) => logs.push(line), refreshMs: 0 });
  assert.equal(intel.start(), false);
  assert.equal(intel.cpuTable(), null);
  intel.refresh();
  assert.equal(logs.length, 1);
  let dormancySpawns = 0;
  let orphanSpawns = 0;
  await winCpuSnapshot({ execFileImpl(_cmd, _args, _opts, cb) { dormancySpawns += 1; cb(new Error('baseline')); } });
  await snapshotProcessTable({ execFileImpl(_cmd, _args, _opts, cb) { orphanSpawns += 1; cb(new Error('baseline')); } });
  assert.equal(dormancySpawns, 1);
  assert.equal(orphanSpawns, 1);
});
