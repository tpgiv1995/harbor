'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const {
  parseSecondInstanceArgs,
} = require('../../src/main/lifecycle.js');

// --- parseSecondInstanceArgs -----------------------------------------------

test('parseSecondInstanceArgs: empty argv -> focus', () => {
  const result = parseSecondInstanceArgs(['/path/electron', '/path/app']);
  assert.deepEqual(result, { action: 'focus', noFocusSteal: false });
});

test('parseSecondInstanceArgs: --focus flag -> focus', () => {
  const result = parseSecondInstanceArgs(['/path/electron', '/path/app', '--focus']);
  assert.deepEqual(result, { action: 'focus', noFocusSteal: false });
});

test('parseSecondInstanceArgs: --new-session --home team --cwd /foo -> new-session team', () => {
  const argv = ['/usr/bin/electron', '/path/app', '--new-session', '--home', 'team', '--cwd', '/foo/bar'];
  const result = parseSecondInstanceArgs(argv);
  assert.equal(result.action, 'new-session');
  assert.equal(result.home, 'team');
  assert.equal(result.cwd, '/foo/bar');
});

test('parseSecondInstanceArgs: --new-session --home personal --cwd /baz -> new-session personal', () => {
  const argv = ['/usr/bin/electron', '/path/app', '--new-session', '--home', 'personal', '--cwd', '/baz'];
  const result = parseSecondInstanceArgs(argv);
  assert.equal(result.action, 'new-session');
  assert.equal(result.home, 'personal');
  assert.equal(result.cwd, '/baz');
});

test('parseSecondInstanceArgs: --new-session without --home defers the profile default to config', () => {
  const argv = ['/usr/bin/electron', '/path/app', '--new-session', '--cwd', '/some/dir'];
  const result = parseSecondInstanceArgs(argv);
  assert.equal(result.action, 'new-session');
  assert.equal(result.home, null);
  assert.equal(result.cwd, '/some/dir');
});

test('parseSecondInstanceArgs: --new-session without --cwd defaults to homedir', () => {
  const argv = ['/usr/bin/electron', '/path/app', '--new-session', '--home', 'team'];
  const result = parseSecondInstanceArgs(argv);
  assert.equal(result.action, 'new-session');
  assert.equal(result.cwd, os.homedir());
});
