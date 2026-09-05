'use strict';

// A KEEPER MUST NEVER DIE OF ONE FAILED RENAME (2026-08-21). The night
// session exits first became visible, two keepers died of "keeper crashed:
// EPERM ... rename state.tmp -> state" while their sessions were alive and
// one was mid-hold for two adversarial review subagents. The writer retries
// the lock-shaped codes briefly, fails CLOSED (returns false, never throws)
// so the caller's session survives, and fails FAST on codes retrying cannot
// help (disk full is not a lock).

const test = require('node:test');
const assert = require('node:assert/strict');

const { writeStateResilient } = require('../../src/daemon/persist-state.js');

function harness({ renamePlan }) {
  const calls = { writes: 0, renames: 0, unlinks: 0, sleeps: [], logs: [] };
  let renameAttempt = 0;
  return {
    calls,
    opts: {
      backoffMs: 1,
      writeImpl: () => { calls.writes += 1; },
      renameImpl: () => {
        renameAttempt += 1;
        calls.renames += 1;
        const outcome = renamePlan[Math.min(renameAttempt, renamePlan.length) - 1];
        if (outcome !== 'ok') { const e = new Error(`${outcome}: rename`); e.code = outcome; throw e; }
      },
      unlinkImpl: () => { calls.unlinks += 1; },
      sleepImpl: (ms) => calls.sleeps.push(ms),
      log: (m) => calls.logs.push(m),
    },
  };
}

test('a transient lock is retried and the write lands', () => {
  const h = harness({ renamePlan: ['EPERM', 'EBUSY', 'ok'] });
  assert.equal(writeStateResilient('C:/x/state.json', '{}', h.opts), true);
  assert.equal(h.calls.renames, 3, 'two transient failures, then success');
  assert.deepEqual(h.calls.sleeps, [1, 2], 'backoff grows between attempts');
  assert.equal(h.calls.logs.length, 0, 'a recovered persist is not an incident');
});

test('a lock that never releases fails CLOSED: false, no throw, tmp cleaned, and it says so', () => {
  const h = harness({ renamePlan: ['EPERM'] });
  let result;
  assert.doesNotThrow(() => { result = writeStateResilient('C:/x/state.json', '{}', h.opts); },
    'the whole point: this must never walk up to uncaughtException and kill the keeper');
  assert.equal(result, false);
  assert.equal(h.calls.renames, 5, 'all attempts spent on a lock-shaped code');
  assert.equal(h.calls.unlinks, 1, 'the tmp file is not left behind');
  assert.match(h.calls.logs[0] || '', /keeping the session alive/);
});

test('a code retrying cannot help fails fast', () => {
  const h = harness({ renamePlan: ['ENOSPC'] });
  assert.equal(writeStateResilient('C:/x/state.json', '{}', h.opts), false);
  assert.equal(h.calls.renames, 1, 'disk-full is not a lock; one attempt, no retry theater');
});

test('the happy path is one write, one rename, no ceremony', () => {
  const h = harness({ renamePlan: ['ok'] });
  assert.equal(writeStateResilient('C:/x/state.json', '{}', h.opts), true);
  assert.equal(h.calls.writes, 1);
  assert.equal(h.calls.renames, 1);
  assert.equal(h.calls.sleeps.length, 0);
});
