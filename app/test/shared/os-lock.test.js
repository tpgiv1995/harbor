'use strict';

// The OS-owned mutex (src/shared/os-lock.cjs): held across processes, freed by
// the OS when its holder dies, never taken from a live holder, re-entrant only
// within one call chain.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { withLock } = require('../../src/shared/os-lock.cjs');

const LOCK = path.resolve(__dirname, '../../src/shared/os-lock.cjs');
const uniqueName = () => `test-os-lock-${crypto.randomUUID()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A second process that takes the lock, prints "held", and keeps it until its
// stdin closes or it is killed.
function holder(name) {
  const child = spawn(process.execPath, ['-e', `
    const { withLock } = require(${JSON.stringify(LOCK)});
    withLock(${JSON.stringify(name)}, () => new Promise((resolve) => {
      process.stdout.write('held\\n');
      process.stdin.on('end', resolve);
      process.stdin.resume();
    })).then(() => process.exit(0));
  `], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const ready = new Promise((resolve) => child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(); }));
  return { child, ready };
}

test('a lock held by another process makes this one wait, and runs out with LOCK_TIMEOUT without running fn', async () => {
  const name = uniqueName();
  const other = holder(name);
  await other.ready;
  let ran = false;
  await assert.rejects(withLock(name, () => { ran = true; }, { waitMs: 400 }), (error) => error.code === 'LOCK_TIMEOUT');
  assert.equal(ran, false);
  other.child.stdin.end();
  await new Promise((resolve) => other.child.on('exit', resolve));
  assert.equal(await withLock(name, () => 'mine', { waitMs: 3000 }), 'mine');
});

test('the OS frees a lock whose holder is killed, with no staleness rule', async () => {
  const name = uniqueName();
  const other = holder(name);
  await other.ready;
  other.child.kill('SIGKILL');
  await new Promise((resolve) => other.child.on('exit', resolve));
  const started = Date.now();
  assert.equal(await withLock(name, () => 'taken', { waitMs: 5000 }), 'taken');
  assert.ok(Date.now() - started < 3000, 'taken at once, not after a timeout');
});

test('concurrent callers in one process never overlap', async () => {
  const name = uniqueName();
  let inside = 0;
  let maxInside = 0;
  const order = [];
  const run = (id) => withLock(name, async () => {
    inside += 1; maxInside = Math.max(maxInside, inside);
    order.push(`start-${id}`);
    await sleep(60);
    order.push(`end-${id}`);
    inside -= 1;
  }, { waitMs: 5000, pollMs: 10 });
  await Promise.all([run(1), run(2), run(3)]);
  assert.equal(maxInside, 1);
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i].slice(6), order[i + 1].slice(4));
});

test('a nested call in the same chain does not wait on itself', async () => {
  const name = uniqueName();
  const result = await withLock(name, () => withLock(name, () => 'nested', { waitMs: 200 }), { waitMs: 2000 });
  assert.equal(result, 'nested');
});

test('the lock is released when fn throws', async () => {
  const name = uniqueName();
  await assert.rejects(withLock(name, () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withLock(name, () => 'free', { waitMs: 1000 }), 'free');
});

test('a waiter is told once that it is waiting', async () => {
  const name = uniqueName();
  const other = holder(name);
  await other.ready;
  let notices = 0;
  const waiting = withLock(name, () => 'after', { waitMs: 5000, noticeMs: 100, pollMs: 20, onWait: () => { notices += 1; } });
  await sleep(400);
  other.child.stdin.end();
  assert.equal(await waiting, 'after');
  assert.equal(notices, 1);
});

test('work started inside the lock that outlives it queues again instead of skipping the lock', async () => {
  const name = uniqueName();
  let later;
  await withLock(name, () => { later = () => withLock(name, () => 'queued', { waitMs: 2000 }); });
  const other = holder(name);
  await other.ready;
  await assert.rejects(later(), (error) => error.code === 'LOCK_TIMEOUT', 'it waited for the other holder instead of running inside a released lock');
  other.child.stdin.end();
});
