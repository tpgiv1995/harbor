'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { codexSessionRoots } = require('../../src/daemon/codex-roots.js');

// The dormancy veto looked only under ~/.codex/sessions, so a session on a
// second Codex account (rollouts under its own CODEX_HOME) was never found and
// failed closed to "awake" forever (2026-10-15).
test('a codex session\'s own CODEX_HOME is searched first, the defaults after', () => {
  const defaults = [path.join('/u', '.codex', 'sessions')];
  assert.deepEqual(codexSessionRoots({ sessionEnv: { CODEX_HOME: '/u/.codex-pro' }, defaults }), [
    path.join('/u/.codex-pro', 'sessions'),
    path.join('/u', '.codex', 'sessions'),
  ]);
  // The default home is not listed twice.
  assert.deepEqual(codexSessionRoots({ sessionEnv: { CODEX_HOME: path.join('/u', '.codex') }, defaults }), defaults);
  // A session launched with no CODEX_HOME keeps the old behaviour exactly.
  assert.deepEqual(codexSessionRoots({ sessionEnv: {}, defaults }), defaults);
  assert.deepEqual(codexSessionRoots({ sessionEnv: null, defaults }), defaults);
});
