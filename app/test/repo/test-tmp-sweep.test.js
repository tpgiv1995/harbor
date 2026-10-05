'use strict';

// The suite's own litter is swept, and NOTHING ELSE IS (2026-08-09).
//
// Both halves matter equally here, and the second one more: a sweeper that is
// slightly too eager deletes a running suite's fixtures, or somebody's
// unrelated /tmp work, and it would do it silently on every `npm test`. Every
// spec below therefore asserts a survivor alongside each casualty.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sweepTestTmp } = require('../../scripts/sweep-test-tmp.js');
const { canSymlink } = require('../support/can-symlink.js');

const HOUR = 60 * 60 * 1000;

function aged(dir, name, ageMs, { file = false } = {}) {
  const full = path.join(dir, name);
  if (file) fs.writeFileSync(full, 'x');
  else { fs.mkdirSync(full, { recursive: true }); fs.writeFileSync(path.join(full, 'inner'), 'x'); }
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(full, when, when);
  return full;
}

test('stale harbor test dirs are removed; fresh ones and foreign ones are not', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweepspec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const staleE2e = aged(dir, 'harbor-e2e-12345', 6 * HOUR);
  const staleSend = aged(dir, 'harbor-session-send-test-AbCdEf', 6 * HOUR);
  const staleHerdr = aged(dir, 'herdr-fake-xyz', 6 * HOUR);
  const staleFile = aged(dir, 'harbor-e2e-pasted-image.png', 6 * HOUR, { file: true });

  // MUST SURVIVE.
  const freshRunning = aged(dir, 'harbor-tasks-test-RUNNING', 30 * 1000);
  const foreignOld = aged(dir, 'someone-elses-work', 99 * HOUR);
  const claudeScratch = aged(dir, 'claude-1000', 99 * HOUR);
  const nearMiss = aged(dir, 'harborsomething', 99 * HOUR); // no separator: not our prefix shape

  const { removed } = sweepTestTmp({ dir, olderThanMs: 2 * HOUR });

  assert.equal(fs.existsSync(staleE2e), false, 'an abandoned e2e profile must go');
  assert.equal(fs.existsSync(staleSend), false, 'the 7,822-strong prefix must go');
  assert.equal(fs.existsSync(staleHerdr), false, 'herdr stubs are the same litter');
  assert.equal(fs.existsSync(staleFile), false, 'a stale FILE counts too, not just directories');
  assert.equal(removed, 4);

  assert.ok(fs.existsSync(freshRunning), 'a directory a LIVE suite is using must never be swept');
  assert.ok(fs.existsSync(foreignOld), 'nothing outside the prefix list is ever touched');
  assert.ok(fs.existsSync(claudeScratch), "another tool's temp store is not ours to delete");
  assert.ok(fs.existsSync(nearMiss), 'the prefix match is literal, not fuzzy');
});

test('a symlink is unlinked, never followed out of the temp directory', {
  skip: !canSymlink() && 'cannot create symlinks in this session: no SeCreateSymbolicLinkPrivilege',
}, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweepspec-link-'));
  const precious = fs.mkdtempSync(path.join(os.tmpdir(), 'sweepspec-precious-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(precious, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(precious, 'do-not-delete'), 'x');

  const link = path.join(dir, 'harbor-e2e-link');
  fs.symlinkSync(precious, link);
  const when = new Date(Date.now() - 6 * HOUR);
  fs.lutimesSync(link, when, when);

  sweepTestTmp({ dir, olderThanMs: 2 * HOUR });

  assert.equal(fs.existsSync(link), false, 'the link itself is removed');
  assert.ok(fs.existsSync(path.join(precious, 'do-not-delete')),
    'the link TARGET must be untouched: a sweeper that follows links can walk anywhere');
});

test('an unreadable directory never fails the run', () => {
  const result = sweepTestTmp({ dir: '/definitely/not/a/real/path', olderThanMs: 1 });
  assert.deepEqual(result, { removed: 0 });
});
