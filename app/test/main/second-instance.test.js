'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSecondInstanceArgs, buildSecondInstancePayload } = require('../../src/main/lifecycle.js');

// Real fixture captured 2026-07-17: Chromium hoists flags ahead of positionals
// and injects its own flags, tearing "--home personal" apart. The parser must
// never bind a flag to a neighboring flag token.
const MANGLED = [
  '/app/node_modules/electron/dist/electron',
  '--new-session', '--home', '--cwd',
  '--allow-file-access-from-files',
  '.', 'personal', '/home/you/dev/harbor-proof',
];

test('mangled argv never binds flag tokens as values', () => {
  const parsed = parseSecondInstanceArgs(MANGLED);
  assert.equal(parsed.action, 'new-session');
  assert.equal(parsed.home, null); // config chooses the default, never "--cwd"
  assert.notEqual(parsed.cwd, '--allow-file-access-from-files');
});

test('equals-form flags survive mangling', () => {
  const parsed = parseSecondInstanceArgs([
    'electron', '--allow-file-access-from-files', '--new-session',
    '--home=personal', '--cwd=/home/you/dev/harbor-proof', '.',
  ]);
  assert.deepEqual(parsed, {
    action: 'new-session',
    home: 'personal',
    cwd: '/home/you/dev/harbor-proof',
    noFocusSteal: false,
  });
});

test('own-process space-form argv parses correctly for the payload', () => {
  const payload = buildSecondInstancePayload([
    'electron', '/app', '--new-session', '--home', 'personal', '--cwd', '/tmp/x',
  ]);
  assert.deepEqual(payload, { action: 'new-session', home: 'personal', cwd: '/tmp/x', noFocusSteal: false });
});

test('bare invocation is a focus', () => {
  assert.deepEqual(parseSecondInstanceArgs(['electron', '/app']), { action: 'focus', noFocusSteal: false });
  assert.deepEqual(parseSecondInstanceArgs(['electron', '/app', '--focus']), { action: 'focus', noFocusSteal: false });
});

// The other path that put Harbor over Pat's game on 2026-07-27: a relaunch that
// races a not-yet-dead instance lands in the second-instance handler, which
// focused unconditionally. The intent has to survive the trip to the first
// instance, so it is parsed here alongside the action.
test('an out-of-band relaunch carries its no-focus-steal intent to the first instance', () => {
  assert.equal(parseSecondInstanceArgs(['electron', '.', '--no-focus-steal']).noFocusSteal, true);
  assert.equal(parseSecondInstanceArgs(['electron', '.', '--no-focus-steal']).action, 'focus');
  assert.equal(
    buildSecondInstancePayload(['electron', '.', '--new-session', '--home=personal', '--no-focus-steal']).noFocusSteal,
    true,
  );
});

test("a launch Pat made himself still says it wants the window", () => {
  assert.equal(parseSecondInstanceArgs(['electron', '.']).noFocusSteal, false);
  assert.equal(parseSecondInstanceArgs(['electron', '.', '--new-session']).noFocusSteal, false);
});
