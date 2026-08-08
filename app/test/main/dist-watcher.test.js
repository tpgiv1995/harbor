'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dist-watch-'));
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
    // recreate. The unpatched watcher died here with an uncaught ENOENT.
    fs.rmSync(path.join(dir, 'assets'), { recursive: true, force: true });
    await sleep(150);
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'index.js'), 'b');

    await waitFor(() => announcements >= 1, { message: 'settled announcement after wipe' });

    // The watcher must still be live for the NEXT build: touch a file and
    // expect another settled announcement.
    await waitFor(() => watcher.armed, { message: 're-arm after wipe' });
    const before = announcements;
    fs.writeFileSync(path.join(dir, 'assets', 'index.js'), 'c');
    await waitFor(() => announcements > before, { message: 'announcement after re-arm' });
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
  const dir = path.join(os.tmpdir(), `harbor-dist-late-${process.pid}`);
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
