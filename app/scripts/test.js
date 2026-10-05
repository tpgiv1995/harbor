#!/usr/bin/env node
'use strict';

// Test runner for the harbor app. Discovers *.test.js under app/test/ and runs
// them with Node's built-in test runner. An optional filter argument selects a
// subset by path substring.
// A repeatable --exclude flag removes files by path segment instead, so CI
// can run everything except a suite it cannot host (see .github/workflows/ci.yml,
// which documents every excluded host-dependent suite).
//
//   npm test                          run every test file
//   npm test -- main                  run test files whose path contains "main"
//   npm test -- --exclude daemon      run every test file except daemon tests
//   npm test -- --exclude daemon --exclude e2e   multiple excludes stack
//
// --exclude and the positional filter combine (filter first, then excludes),
// so `npm test -- main --exclude e2e` is also valid.

const { spawnSync } = require('child_process');
const { readdirSync } = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const excludes = [];
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--exclude') {
    i += 1;
    if (i >= args.length) {
      console.error('--exclude requires a value');
      process.exit(1);
    }
    excludes.push(args[i]);
  } else if (arg.startsWith('--exclude=')) {
    excludes.push(arg.slice('--exclude='.length));
  } else {
    positional.push(arg);
  }
}
const filter = positional[0] || '';
const normalizedFilter = filter.split(/[\\/]+/).filter(Boolean).join(path.sep);
const testRoot = path.join(__dirname, '..', 'test');

function matchesExclude(file, needle) {
  const relative = path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/');
  const normalized = String(needle).split(/[\\/]+/).filter(Boolean).join('/');
  if (!normalized) return false;
  if (normalized.includes('/')) return relative === normalized || relative.startsWith(`${normalized}/`);
  return relative.split('/').includes(normalized);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(testRoot);
} catch (e) {
  console.error('no test/ directory found:', e.message);
  process.exit(1);
}

const selected = files
  .filter((f) => path.relative(path.join(__dirname, '..'), f).includes(normalizedFilter))
  .filter((f) => !excludes.some((needle) => matchesExclude(f, needle)))
  .sort();
if (selected.length === 0) {
  console.error(`no test files match filter ${JSON.stringify(filter)}${excludes.length ? ` after excluding ${JSON.stringify(excludes)}` : ''}`);
  process.exit(1);
}

// Sweep the PREVIOUS run's abandoned temp directories before starting this
// one. See scripts/sweep-test-tmp.js for why this is at the start and not the
// end, and why it is here rather than in thirty suites' teardown.
try {
  const { sweepTestTmp } = require('./sweep-test-tmp.js');
  const { removed } = sweepTestTmp();
  if (removed) console.log(`swept ${removed} abandoned temp director(ies) from earlier runs`);
} catch (e) {
  console.log(`temp sweep skipped: ${e.message}`);
}

// A REAL CONPTY IS A MACHINE-GLOBAL RESOURCE, NOT A PARALLELIZABLE FIXTURE
// (2026-08-14). session-daemon-live's two real-pty specs pass alone (3s) and
// pass on the 2-core hosted runner, and failed EVERY local run that put
// another real-pty suite beside them: ConPTY spawn and teardown under
// contention outran a 30s deadline that a lone run clears in three. The live
// Harbor on this machine holds its own ptys too, so the gate machine always
// has less headroom than CI, not more. The fix is scheduling, not a longer
// deadline: files that hold a real pty run AFTER the parallel pass, one file
// at a time, so a pty wait only ever measures its own pty.
// THE TEMP DIR'S SPELLING IS DECIDED HERE, ONCE, FOR EVERY TEST CHILD
// (2026-09-18). test/support/real-tmpdir.js fixed the 8.3 short-name trap per
// suite, and the suites that never adopted it kept dying on the hosted runner:
// seven server and web files called mkdtemp on a raw os.tmpdir(), the server
// under test watched that directory by its RUNNER~1 spelling, and libuv
// aborted each whole file (Assertion failed: !_wcsnicmp, src\win\fs-event.c).
// The public CI run was red for three weeks on it. os.tmpdir() reads TEMP/TMP
// (TMPDIR on POSIX), so handing every child the OS's own long spelling makes
// the trap unreachable for the 70-odd files that use os.tmpdir() directly and
// for every file written after them. It must be realpathSync.native: the JS
// realpath hands an 8.3 name straight back. A file run directly with
// `node --test` bypasses this runner, which is what real-tmpdir.js is still for.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  try {
    const real = require('fs').realpathSync.native(require('os').tmpdir());
    if (process.platform === 'win32') { env.TEMP = real; env.TMP = real; }
    else env.TMPDIR = real;
  } catch (e) {
    console.log(`temp dir realpath skipped: ${e.message}`);
  }
  return env;
}

const SERIAL_PTY = ['test/daemon', 'test/main/session-daemon-live.test.js'];
const isSerialPty = (f) => SERIAL_PTY.some((needle) => matchesExclude(f, needle));
const serialFiles = selected.filter(isSerialPty);
const parallelFiles = selected.filter((f) => !isSerialPty(f));

console.log(`running ${selected.length} test file(s):`);
for (const f of selected) {
  const rel = path.relative(path.join(__dirname, '..'), f);
  console.log('  ' + rel + (isSerialPty(f) ? '   (serial pty pass)' : ''));
}

let status = 0;
if (parallelFiles.length > 0) {
  const result = spawnSync(process.execPath, ['--test', ...parallelFiles], { stdio: 'inherit', env: childEnv() });
  status = result.status == null ? 1 : result.status;
}
if (serialFiles.length > 0) {
  // The serial pass otherwise launches INTO the parallel pass's teardown
  // storm: on win32, hundreds of test children's console hosts are still
  // dying as the first pty spec starts, and ConPTY operations starve against
  // a deadline that a settled machine clears in seconds. Wait for the
  // console-host population to hold still (a measurable completion, not a
  // blind sleep), capped and reported so the cap is never silent.
  if (process.platform === 'win32' && parallelFiles.length > 0) {
    const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const conhostCount = () => {
      const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq conhost.exe', '/NH'], { encoding: 'utf8' });
      if (result.status !== 0 || !result.stdout) return -1;
      return result.stdout.split('\n').filter((line) => /conhost\.exe/i.test(line)).length;
    };
    const deadline = Date.now() + 30000;
    let last = conhostCount();
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      sleepSync(500);
      const now = conhostCount();
      if (now !== last) { last = now; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= 2000) break;
    }
    if (Date.now() >= deadline) console.log('serial pty pass: console hosts never settled within 30s; proceeding anyway');
  }
  console.log(`serial pty pass: ${serialFiles.length} file(s), one at a time`);
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...serialFiles],
    {
      stdio: 'inherit',
      // A lone pty file still shares the machine with whatever the parallel
      // pass left draining, so its deadline is sized for that reality unless
      // the caller already chose one.
      env: childEnv({ HARBOR_TEST_SLOW_PTY_MS: process.env.HARBOR_TEST_SLOW_PTY_MS || '90000' }),
    },
  );
  const serialStatus = result.status == null ? 1 : result.status;
  if (serialStatus !== 0) status = status === 0 ? serialStatus : status;
}
process.exit(status);
