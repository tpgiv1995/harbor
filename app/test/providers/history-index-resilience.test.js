'use strict';
// The index worker must never turn a cache-file hiccup into a missing rail.
//
// Live-caught 2026-09-04 ("my sessions arent loading / showing up"): Harbor's
// history index is written by MORE than one process on this machine (the app,
// the Harbor Mobile server, and the CLI picker all run the same worker against
// the same ~/.cache/harbor/index.json), and on Windows a rename over a file
// another handle holds open fails with EPERM. 47 orphaned `.index-*` temp files
// in the cache dir proved it happens several times a day. Before this file the
// worker THREW out of refreshIndex after it had already parsed every
// transcript: the fully computed pass was discarded, the in-memory cache was
// never set, and the caller saw a rejection instead of rows. At boot that
// rejection propagated out of sidebarBridge.start() and Harbor exited with
// code 1 before drawing a window.
//
// Second shape, same file: discover() answered an unreadable projects root with
// an EMPTY corpus, which emit turned into zero rows and saveCache persisted as
// an empty index. One bad readdir emptied the rail AND the on-disk cache.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryIndex, CACHE_VERSION } = require('../../src/main/providers/history-index.js');

const SESSION_A = '11111111-2222-3333-4444-555555555555';
const SESSION_B = '66666666-7777-8888-9999-aaaaaaaaaaaa';

function record(text, cwd = 'C:\\dev\\thing') {
  return `${JSON.stringify({
    type: 'user', timestamp: new Date().toISOString(), cwd,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-index-resil-'));
  const projectsDir = path.join(tmp, 'projects');
  const cacheDir = path.join(tmp, 'cache');
  const projectA = path.join(projectsDir, 'C--dev-thing');
  const projectB = path.join(projectsDir, 'C--dev-other');
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const transcriptA = path.join(projectA, `${SESSION_A}.jsonl`);
  const transcriptB = path.join(projectB, `${SESSION_B}.jsonl`);
  fs.writeFileSync(transcriptA, record('first prompt in thing'));
  fs.writeFileSync(transcriptB, record('first prompt in other', 'C:\\dev\\other'));
  return { tmp, projectsDir, cacheDir, projectA, projectB, transcriptA, transcriptB };
}

function tempLeftovers(cacheDir) {
  return fs.readdirSync(cacheDir).filter((name) => name.startsWith('.index-'));
}

function idsOf(index) {
  return Object.values(index).map((entry) => entry.id).sort();
}

test('a cache write that cannot land keeps the pass, its result, and leaves no temp file behind', () => {
  const { projectsDir, cacheDir, transcriptA } = makeFixture();
  let now = 1_000_000;
  const logged = [];
  const index = createHistoryIndex({
    projectsDir, cacheDir, refreshFloorMs: 10_000, now: () => now, log: (line) => logged.push(line),
  });
  const first = index.refreshIndex();
  assert.deepStrictEqual(idsOf(first), [SESSION_A, SESSION_B].sort());
  const cacheFile = path.join(cacheDir, 'index.json');
  assert.ok(fs.existsSync(cacheFile), 'the first pass wrote the cache');

  // Make the rename impossible: the cache path is now a DIRECTORY, which no
  // rename can replace on any platform.
  fs.rmSync(cacheFile);
  fs.mkdirSync(cacheFile);
  fs.appendFileSync(transcriptA, record('a second prompt that changes the size'));
  now += 20_000;

  let second;
  assert.doesNotThrow(() => { second = index.refreshIndex(); }, 'a failed cache write must not discard the pass');
  assert.deepStrictEqual(idsOf(second), [SESSION_A, SESSION_B].sort(), 'every session is still reported');
  const entryA = Object.values(second).find((entry) => entry.id === SESSION_A);
  assert.ok(entryA.sz > Object.values(first).find((entry) => entry.id === SESSION_A).sz, 'the changed transcript was re-parsed');
  assert.deepStrictEqual(tempLeftovers(cacheDir), [], 'a temp file that could not be renamed is removed, not orphaned');
  assert.ok(logged.some((line) => /cache/i.test(line)), 'the failure is logged, not swallowed silently');

  // The pass was kept in memory: inside the floor the worker answers from it
  // rather than re-reading a cache file it could not write.
  now += 3_000;
  const third = index.refreshIndex();
  assert.strictEqual(third, second, 'inside the floor the kept pass is served');

  // emit rides the same path: rows, never a throw.
  now += 20_000;
  const out = index.run(['emit', '--all', '--with-cwd'], { HARBOR_INDEX_READ_ONLY: '0' });
  assert.strictEqual(out.split('\n').filter(Boolean).length, 2);
});

test('an unreadable projects root fails honestly and never empties the on-disk cache', () => {
  const { projectsDir, cacheDir } = makeFixture();
  let now = 1_000_000;
  const index = createHistoryIndex({ projectsDir, cacheDir, refreshFloorMs: 10_000, now: () => now });
  index.refreshIndex();
  const cacheFile = path.join(cacheDir, 'index.json');
  const before = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.strictEqual(Object.keys(before.files).length, 2);

  // The root goes away (a junction re-point, a transient EBUSY, a bad mount:
  // the shape does not matter, the corpus is simply not listable right now).
  fs.renameSync(projectsDir, `${projectsDir}-away`);
  now += 20_000;
  assert.throws(() => index.refreshIndex(), /cannot list|projects/i, 'an unlistable root is an error, not an empty corpus');
  assert.throws(() => index.run(['emit', '--all'], {}), /cannot list|projects/i, 'emit does not answer zero rows for it either');

  const after = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.strictEqual(after.v, CACHE_VERSION);
  assert.strictEqual(Object.keys(after.files).length, 2, 'the cache on disk still holds every session');

  // When the root is back, the pass resumes with nothing lost.
  fs.renameSync(`${projectsDir}-away`, projectsDir);
  now += 20_000;
  assert.deepStrictEqual(idsOf(index.refreshIndex()), [SESSION_A, SESSION_B].sort());
});

test('a project directory that cannot be listed keeps its cached sessions instead of dropping them', () => {
  const { projectsDir, cacheDir, projectB } = makeFixture();
  let now = 1_000_000;
  let failListing = null;
  const fsImpl = {
    ...fs,
    readdirSync: (target, ...rest) => {
      if (failListing && path.resolve(target) === path.resolve(failListing)) {
        const error = new Error(`EBUSY: resource busy or locked, scandir '${target}'`);
        error.code = 'EBUSY';
        throw error;
      }
      return fs.readdirSync(target, ...rest);
    },
  };
  const index = createHistoryIndex({ projectsDir, cacheDir, refreshFloorMs: 10_000, now: () => now, fs: fsImpl });
  const first = index.refreshIndex();
  assert.deepStrictEqual(idsOf(first), [SESSION_A, SESSION_B].sort());

  failListing = projectB;
  now += 20_000;
  const second = index.refreshIndex();
  assert.deepStrictEqual(idsOf(second), [SESSION_A, SESSION_B].sort(), 'the unlistable project keeps the sessions the cache already knew');

  const onDisk = JSON.parse(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8'));
  assert.strictEqual(Object.keys(onDisk.files).length, 2, 'the cache is not shrunk by a listing failure');
});
