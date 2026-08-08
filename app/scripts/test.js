#!/usr/bin/env node
'use strict';

// Test runner for the harbor app. Discovers *.test.js under app/test/ and runs
// them with Node's built-in test runner. An optional filter argument selects a
// subset by path substring, so `npm test -- herdr` runs only test/herdr/*.
// A repeatable --exclude flag removes files by path substring instead, so CI
// can run everything except a suite it cannot host (see .github/workflows/ci.yml,
// which excludes test/herdr/ because it needs a real Herdr binary pinned to
// protocol 16/17, which CI does not install).
//
//   npm test                          run every test file
//   npm test -- herdr                 run test files whose path contains "herdr"
//   npm test -- --exclude herdr       run every test file EXCEPT those under herdr
//   npm test -- --exclude herdr --exclude e2e   multiple excludes stack
//
// --exclude and the positional filter combine (filter first, then excludes),
// so `npm test -- bin --exclude ai-launch` is also valid.

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
const testRoot = path.join(__dirname, '..', 'test');

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
  .filter((f) => f.includes(filter))
  .filter((f) => !excludes.some((needle) => f.includes(needle)))
  .sort();
if (selected.length === 0) {
  console.error(`no test files match filter ${JSON.stringify(filter)}${excludes.length ? ` after excluding ${JSON.stringify(excludes)}` : ''}`);
  process.exit(1);
}

console.log(`running ${selected.length} test file(s):`);
for (const f of selected) console.log('  ' + path.relative(path.join(__dirname, '..'), f));

// The herdr bridge suite boots a real named daemon and streams real ptys; run
// it SERIALLY after everything else. Under full-suite process concurrency its
// cold-start timing flaked ~1 in 3 (long-standing noise, ended here).
const herdrFiles = selected.filter((f) => f.includes(`${path.sep}herdr${path.sep}`));
const parallelFiles = selected.filter((f) => !herdrFiles.includes(f));

let status = 0;
if (parallelFiles.length) {
  const res = spawnSync(process.execPath, ['--test', ...parallelFiles], { stdio: 'inherit' });
  status = res.status == null ? 1 : res.status;
}
if (herdrFiles.length) {
  const res = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...herdrFiles],
    { stdio: 'inherit' },
  );
  if (status === 0) status = res.status == null ? 1 : res.status;
}
process.exit(status);
