'use strict';
// ONE WRITER, AND NOT ON EVERY PASS (2026-11-06). The index cache is about
// 17 MB on Pat's machine (12,000 transcripts) and was stringified and
// rewritten whole on every pass that saw one transcript grow: every 10 to 30
// seconds while any session worked, in the app and again in the phone server.
// A long-lived process now writes at most once per saveIntervalMs (the newest
// pass, when the interval is up or on close), a readOnly process never writes,
// and a one-shot CLI (no interval) still writes every changed pass.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryIndex } = require('../../src/main/providers/history-index.js');

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-index-save-'));
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
  const writes = { count: 0 };
  const countingFs = {
    ...fs,
    writeFileSync: (target, ...rest) => {
      if (path.basename(String(target)).startsWith('.index-')) writes.count += 1;
      return fs.writeFileSync(target, ...rest);
    },
  };
  const cachedSize = () => {
    const data = JSON.parse(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8'));
    return Object.values(data.files)[0].sz;
  };
  return { tmp, projectsDir, cacheDir, transcript, record, writes, countingFs, cachedSize };
}

test('a long-lived index writes its cache at most once per interval, and the newest pass on flush', () => {
  const { projectsDir, cacheDir, transcript, record, writes, countingFs, cachedSize } = makeFixture();
  let now = 1_000_000;
  const index = createHistoryIndex({
    projectsDir, cacheDir, fs: countingFs, refreshFloorMs: 0, saveIntervalMs: 120_000, now: () => now,
  });
  index.refreshIndex();
  assert.strictEqual(writes.count, 1, 'the first pass writes the cache');
  for (let i = 0; i < 5; i += 1) {
    fs.appendFileSync(transcript, record(`prompt ${i}`));
    now += 15_000;
    index.refreshIndex();
  }
  assert.strictEqual(writes.count, 1, 'five changed passes inside the interval write nothing');
  const newest = fs.statSync(transcript).size;
  assert.strictEqual(index.flush(), true, 'a pass was waiting');
  assert.strictEqual(writes.count, 2);
  assert.strictEqual(cachedSize(), newest, 'the flushed cache is the newest pass');
  assert.strictEqual(index.flush(), false, 'nothing left to write');
});

test('a waiting pass is written when the interval is up even if no pass runs then', async () => {
  const { projectsDir, cacheDir, transcript, record, writes, countingFs, cachedSize } = makeFixture();
  const index = createHistoryIndex({
    projectsDir, cacheDir, fs: countingFs, refreshFloorMs: 0, saveIntervalMs: 80,
  });
  index.refreshIndex();
  fs.appendFileSync(transcript, record('second'));
  index.refreshIndex();
  assert.strictEqual(writes.count, 1, 'inside the interval');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(writes.count, 2, 'the trailing write landed');
  assert.strictEqual(cachedSize(), fs.statSync(transcript).size);
});

test('a read-only index never writes the cache', () => {
  const { projectsDir, cacheDir, transcript, record, writes, countingFs } = makeFixture();
  let now = 1_000_000;
  const index = createHistoryIndex({
    projectsDir, cacheDir, fs: countingFs, refreshFloorMs: 0, readOnly: true, now: () => now,
  });
  const first = index.refreshIndex();
  assert.strictEqual(Object.keys(first).length, 1, 'it still answers');
  fs.appendFileSync(transcript, record('second'));
  now += 60_000;
  const second = index.refreshIndex();
  assert.ok(Object.values(second)[0].sz > Object.values(first)[0].sz, 'and sees changes in memory');
  index.migrateEntries();
  index.flush();
  assert.strictEqual(writes.count, 0);
  assert.strictEqual(fs.existsSync(path.join(cacheDir, 'index.json')), false);
});

test('without an interval every changed pass still writes (the one-shot CLI)', () => {
  const { projectsDir, cacheDir, transcript, record, writes, countingFs } = makeFixture();
  let now = 1_000_000;
  const index = createHistoryIndex({ projectsDir, cacheDir, fs: countingFs, refreshFloorMs: 0, now: () => now });
  index.refreshIndex();
  fs.appendFileSync(transcript, record('second'));
  now += 1_000;
  index.refreshIndex();
  assert.strictEqual(writes.count, 2);
});

// Astra review 2026-11-06, finding 7: the titler reads this file from disk, so
// a pass that lands late must announce itself, or a new session first seen in
// memory waits for an unrelated later refresh to be named.
test('a late write announces itself; an on-time one does not need to', async () => {
  const { projectsDir, cacheDir, transcript, record, countingFs } = makeFixture();
  let announced = 0;
  const index = createHistoryIndex({
    projectsDir, cacheDir, fs: countingFs, refreshFloorMs: 0, saveIntervalMs: 80, onPersisted: () => { announced += 1; },
  });
  index.refreshIndex();
  assert.strictEqual(announced, 0, 'the first pass writes in line: its own refresh already follows');
  fs.appendFileSync(transcript, record('second'));
  index.refreshIndex();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(announced, 1, 'the trailing write is announced');
});
