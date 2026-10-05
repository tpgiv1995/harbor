'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { realTmpDir } = require('../support/real-tmpdir.js');
const path = require('node:path');
const { createDistWatcher } = require('../../src/main/dist-watcher.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond, { timeout = 8000, interval = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${message}`);
}

function makeDist() {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-dist-watch-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'index.js'), 'a');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>');
  return dir;
}

test('rides through a rebuild that wipes and recreates the assets subtree', async () => {
  const dir = makeDist();
  let announcements = 0;
  const watcher = createDistWatcher(dir, () => { announcements += 1; }, {
    settleMs: 120, rearmDelayMs: 100, maxRearms: 10,
  });
  try {
    // Simulate the vite rebuild: wipe assets, pause in the deleted window,
    // recreate with a RENAMED hashed asset the way vite really does (the
    // fingerprint is content-aware now, so a rebuild must look like one).
    // The unpatched watcher died here with an uncaught ENOENT.
    fs.rmSync(path.join(dir, 'assets'), { recursive: true, force: true });
    await sleep(150);
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'index-B2.js'), 'bb');
    fs.writeFileSync(path.join(dir, 'index.html'), '<html src=index-B2>');

    await waitFor(() => announcements >= 1, { message: 'settled announcement after wipe' });

    // The watcher must still be live for the NEXT build: land another build
    // and expect another settled announcement.
    await waitFor(() => watcher.armed, { message: 're-arm after wipe' });
    const before = announcements;
    fs.writeFileSync(path.join(dir, 'assets', 'index-C3.js'), 'cccc');
    fs.writeFileSync(path.join(dir, 'index.html'), '<html src=index-C3>');
    await waitFor(() => announcements > before, { message: 'announcement after re-arm' });
  } finally {
    watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a signal without a real change never announces, and a real build still does', async () => {
  // THE WINDOWS FALSE-BANNER REPRO (2026-08-20): Pat's restart ribbon
  // reappeared after every update restart while a spy watcher proved dist/
  // had ZERO file changes; the announce came from watcher churn. A settled
  // signal must be checked against the CONTENT fingerprint, so churn
  // (mtime-only touches, AV/indexer noise, byte-identical rewrites) draws
  // nothing and an actual build always draws the banner.
  const dir = makeDist();
  let announcements = 0;
  const watcher = createDistWatcher(dir, () => { announcements += 1; }, {
    settleMs: 120, rearmDelayMs: 100, maxRearms: 10,
  });
  try {
    // Churn shape 1: an mtime-only touch fires a real fs.watch event.
    const target = path.join(dir, 'assets', 'index.js');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(target, past, past);
    // Churn shape 2: a byte-identical rewrite (same names, same sizes).
    fs.writeFileSync(target, fs.readFileSync(target));
    await sleep(600); // several settle windows
    assert.equal(announcements, 0,
      'churn that changes no content must never draw the update banner');

    // The other side: a real build (renamed hashed asset + new index.html)
    // must still announce, or the suppression has silenced the feature.
    fs.writeFileSync(path.join(dir, 'assets', 'index-D4.js'), 'dddd');
    fs.writeFileSync(path.join(dir, 'index.html'), '<html src=index-D4>');
    await waitFor(() => announcements === 1, { message: 'real build announcement' });
  } finally {
    watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting the whole watched dir never crashes the process', async () => {
  const dir = makeDist();
  const watcher = createDistWatcher(dir, () => {}, {
    settleMs: 50, rearmDelayMs: 40, maxRearms: 3,
  });
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    // On Linux, deleting the watched root does not even emit an error: the
    // watch idles on the dead inode. The requirement is simply that nothing
    // throws on the async path; an uncaught exception would fail this test.
    await sleep(600);
    assert.ok(true, 'no uncaught exception after root deletion');
  } finally {
    watcher.close();
  }
});

test('missing dir at creation retries and arms once the dir appears', async () => {
  const dir = path.join(realTmpDir(), `harbor-dist-late-${process.pid}`);
  const watcher = createDistWatcher(dir, () => {}, {
    settleMs: 50, rearmDelayMs: 60, maxRearms: 20,
  });
  try {
    await sleep(150);
    fs.mkdirSync(dir);
    await waitFor(() => watcher.armed, { message: 'armed after late dir creation' });
  } finally {
    watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
