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
