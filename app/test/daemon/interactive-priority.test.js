'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { raiseToInteractive } = require('../../src/daemon/interactive-priority.js');

const fakeOs = () => {
  const calls = [];
  return {
    calls,
    constants: { priority: { PRIORITY_ABOVE_NORMAL: -7 } },
    setPriority: (pid, value) => { calls.push([pid, value]); },
  };
};

test('on Windows the session chain raises itself, and a spawned CLI, to above normal', () => {
  const os = fakeOs();
  assert.equal(raiseToInteractive(0, { platform: 'win32', os }), true);
  assert.equal(raiseToInteractive(4242, { platform: 'win32', os }), true);
  assert.deepEqual(os.calls, [[0, -7], [4242, -7]]);
});

test('elsewhere it changes nothing, because raising priority needs privileges there', () => {
  const os = fakeOs();
  assert.equal(raiseToInteractive(0, { platform: 'linux', os }), false);
  assert.equal(raiseToInteractive(0, { platform: 'darwin', os }), false);
  assert.deepEqual(os.calls, []);
});

test('a pid that already exited is not an error', () => {
  const os = { ...fakeOs(), setPriority: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); } };
  assert.equal(raiseToInteractive(99999, { platform: 'win32', os }), false);
});

test('the real call on this machine leaves the process above normal (Windows only)', { skip: process.platform !== 'win32' }, () => {
  const os = require('node:os');
  const before = os.getPriority(0);
  try {
    assert.equal(raiseToInteractive(0), true);
    assert.equal(os.getPriority(0), os.constants.priority.PRIORITY_ABOVE_NORMAL);
  } finally {
    os.setPriority(0, before);
  }
});

// Measured 2026-11-18: ABOVE NORMAL is not inherited, so a Codex pane's real
// codex.exe (started by the npm node shim) ran at NORMAL. The keeper raises a
// direct child of its spawned process that is a known agent CLI, nothing else.
test('the real CLI behind a launcher shim is raised, and nothing else is', () => {
  const { raiseLaunchedCli } = require('../../src/daemon/interactive-priority.js');
  const set = [];
  const fakeOs = { constants: { priority: { PRIORITY_ABOVE_NORMAL: -7 } }, setPriority: (pid, value) => set.push([pid, value]) };
  const table = new Map([
    [100, { pid: 100, ppid: 1, name: 'node.exe', created: 10n }],
    [101, { pid: 101, ppid: 100, name: 'codex.exe', created: 11n }],
    [102, { pid: 102, ppid: 100, name: 'python.exe', created: 12n }],
    [103, { pid: 103, ppid: 101, name: 'claude.exe', created: 13n }],
    [104, { pid: 104, ppid: 100, name: 'CURSOR-AGENT.EXE', created: 14n }],
    [105, { pid: 105, ppid: 100, name: 'claude.exe', created: 5n }],
  ]);
  assert.deepEqual(raiseLaunchedCli(100, { table, platform: 'win32', os: fakeOs }), [101, 104]);
  assert.deepEqual(set, [[101, -7], [104, -7]], 'not the tool (102), not a grandchild (103), not a recycled-pid stranger (105)');
  assert.deepEqual(raiseLaunchedCli(100, { table, platform: 'linux', os: fakeOs }), []);
  assert.deepEqual(raiseLaunchedCli(999, { table, platform: 'win32', os: fakeOs }), [], 'a root missing from the snapshot raises nothing');
});
