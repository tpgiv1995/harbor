'use strict';

// Harbor's hand-off images are deleted after 14 days (2026-11-05). Synthetic
// files in a temp folder only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { pruneOldEntries, createThrottledPruner, DEFAULT_MAX_AGE_MS } = require('../../src/main/prune-old-files.js');
const { createImageWriter } = require('../../src/main/clipboard-images.js');

const DAY = 24 * 60 * 60 * 1000;

function folder() {
  return fs.mkdtempSync(path.join(realTmpDir(), 'harbor-prune-'));
}

function file(dir, name, ageDays, bytes = 10) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, Buffer.alloc(bytes));
  const when = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(full, when, when);
  return full;
}

test('the default age is 14 days', () => {
  assert.equal(DEFAULT_MAX_AGE_MS, 14 * DAY);
});

test('files older than the age go; recent ones and non-matching ones stay', async () => {
  const dir = folder();
  const old = file(dir, 'paste-1.png', 20, 100);
  const recent = file(dir, 'paste-2.png', 3);
  const other = file(dir, 'notes.txt', 30);
  const result = await pruneOldEntries({ dir, match: (name) => /^paste-\d+\.png$/.test(name) });
  assert.deepEqual(result, { removed: 1, bytes: 100 });
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(other), true, 'only matching names are ever removed');
});

test('an old folder (a phone upload run) goes whole; a recent one stays', async () => {
  const dir = folder();
  const oldRun = path.join(dir, 'run-old');
  fs.mkdirSync(oldRun);
  file(oldRun, 'a.png', 20);
  const when = new Date(Date.now() - 20 * DAY);
  fs.utimesSync(oldRun, when, when);
  const newRun = path.join(dir, 'run-new');
  fs.mkdirSync(newRun);
  const result = await pruneOldEntries({ dir });
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(oldRun), false);
  assert.equal(fs.existsSync(newRun), true);
});

test('a missing folder is not an error', async () => {
  assert.deepEqual(await pruneOldEntries({ dir: path.join(folder(), 'nope') }), { removed: 0, bytes: 0 });
});

test('the throttled pruner runs at most once per window', async () => {
  const dir = folder();
  let now = Date.now();
  const prune = createThrottledPruner({ dir }, { everyMs: 1000, clock: () => now });
  file(dir, 'a.png', 20);
  assert.equal((await prune()).removed, 1);
  file(dir, 'b.png', 20);
  assert.equal(await prune(), null, 'inside the window: skipped');
  assert.equal(fs.existsSync(path.join(dir, 'b.png')), true);
  now += 1001;
  assert.equal((await prune()).removed, 1, 'after the window: runs again');
});

test('saving a paste clears pastes older than 14 days from the same folder', async () => {
  const dir = folder();
  const old = file(dir, 'paste-1700000000000.png', 15);
  const keep = file(dir, 'paste-1790000000000.png', 1);
  let ran = null;
  const prune = createThrottledPruner({ dir, match: (name) => /^paste-\d+\.(png|jpg)$/.test(name) });
  const write = createImageWriter({ cacheDir: dir, prune: () => { ran = prune(); return ran; } });
  const saved = await write(Buffer.from('synthetic'), 'png');
  await ran;
  assert.equal(fs.existsSync(saved), true, 'the new paste is there');
  assert.equal(fs.existsSync(keep), true, 'a recent paste stays');
  assert.equal(fs.existsSync(old), false, 'the 15-day-old paste is gone');
});
