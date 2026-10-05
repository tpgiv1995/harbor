'use strict';
// The index worker under sustained transcript churn (an agent fleet writing
// every second or two) must not rescan back-to-back forever: live-caught
// 2026-08-30, the worker thread saturated a core at ~90MB/s of re-reads inside
// Harbor's main process and every keystroke in the app lagged. Two rules:
// a refresh FLOOR serves the in-memory result when the last full pass was
// moments ago, and the parsed cache lives in worker MEMORY so a pass never
// re-reads its own cache file from disk.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryIndex } = require('../../src/main/providers/history-index.js');

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-index-floor-'));
  const projectsDir = path.join(tmp, 'projects');
  const cacheDir = path.join(tmp, 'cache');
  const projectDir = path.join(projectsDir, 'C--dev-thing');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const transcript = path.join(projectDir, '11111111-2222-3333-4444-555555555555.jsonl');
  const record = (text) => `${JSON.stringify({
    type: 'user', timestamp: new Date().toISOString(), cwd: 'C:\\dev\\thing',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
  fs.writeFileSync(transcript, record('first prompt'));
  return { tmp, projectsDir, cacheDir, transcript, record };
}

test('a refresh inside the floor serves the previous pass instead of rescanning', () => {
  const { projectsDir, cacheDir, transcript, record } = makeFixture();
  let now = 1_000_000;
  const index = createHistoryIndex({
    projectsDir, cacheDir, refreshFloorMs: 10_000, now: () => now,
  });
  const first = index.refreshIndex();
  const sizeBefore = Object.values(first)[0].sz;
  assert.ok(sizeBefore > 0);

  fs.appendFileSync(transcript, record('second prompt that changes the size'));
  now += 3_000; // inside the floor
  const second = index.refreshIndex();
  assert.strictEqual(Object.values(second)[0].sz, sizeBefore, 'inside the floor the stale pass is served');

  now += 10_000; // past the floor
  const third = index.refreshIndex();
  assert.ok(Object.values(third)[0].sz > sizeBefore, 'past the floor the change is picked up');
});

test('rebuild bypasses the floor', () => {
  const { projectsDir, cacheDir, transcript, record } = makeFixture();
  let now = 1_000_000;
  const index = createHistoryIndex({
    projectsDir, cacheDir, refreshFloorMs: 10_000, now: () => now,
  });
  const first = index.refreshIndex();
  const sizeBefore = Object.values(first)[0].sz;
  fs.appendFileSync(transcript, record('changed'));
  now += 1_000;
  const rebuilt = index.refreshIndex(true);
  assert.ok(Object.values(rebuilt)[0].sz > sizeBefore, 'rebuild must always rescan');
});

test('the parsed cache is held in memory: the disk cache file is read at most once', () => {
  const { projectsDir, cacheDir } = makeFixture();
  let now = 1_000_000;
  let diskCacheReads = 0;
  const index = createHistoryIndex({
    projectsDir, cacheDir, refreshFloorMs: 0, now: () => now,
    onDiskCacheRead: () => { diskCacheReads += 1; },
  });
  index.refreshIndex();
  now += 60_000;
  index.refreshIndex();
  now += 60_000;
  const third = index.refreshIndex();
  assert.strictEqual(Object.keys(third).length, 1);
  assert.strictEqual(diskCacheReads, 1, 'later passes must serve the cache from memory, not disk');
});
