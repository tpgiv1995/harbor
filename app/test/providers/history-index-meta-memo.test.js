'use strict';
// `meta` answers from memory when nothing it depends on has changed.
//
// Live-caught 2026-09-09 ("harbor is CRAWLING today ... messages getting
// dropped"): every `meta` call rebuilt the whole home map (three homes'
// history.jsonl parsed, session-env and file-history re-listed; 12,871
// entries in one of them) and re-read the generated-titles file, ~32ms a
// call. The Orch summaries broadcast asked for meta once per candidate
// session per broadcast, 2,400 requests in 30 seconds on the live worker,
// which is a single thread that also answers the rail refresh and the two
// meta lookups on EVERY send. The worker never caught up: one thread of the
// main process burned 3,114 CPU-seconds in 84 minutes, and a send waited 120
// seconds between resolve and sending for its meta. Two rules now hold:
// the home map is rebuilt only when one of its inputs changed on disk
// (history.jsonl size/mtime, the session-env / file-history directory mtime),
// and the titles file is re-read only when its size/mtime changed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryIndex } = require('../../src/main/providers/history-index.js');

const SESSION_A = '11111111-2222-3333-4444-555555555555';

function record(text, cwd = 'C:\\dev\\thing') {
  return `${JSON.stringify({
    type: 'user', timestamp: new Date().toISOString(), cwd,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-index-meta-'));
  const projectsDir = path.join(tmp, 'projects');
  const cacheDir = path.join(tmp, 'cache');
  const projectDir = path.join(projectsDir, 'C--dev-thing');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${SESSION_A}.jsonl`), record('first prompt'));
  const homes = {};
  for (const id of ['p1', 'p2']) {
    const home = path.join(tmp, `.claude-${id}`);
    fs.mkdirSync(path.join(home, 'session-env'), { recursive: true });
    fs.mkdirSync(path.join(home, 'file-history'), { recursive: true });
    fs.writeFileSync(path.join(home, 'history.jsonl'), '');
    homes[id] = home;
  }
  const profiles = Object.entries(homes).map(([id, configHome]) => ({ id, configHome }));
  const titlesFile = path.join(cacheDir, 'session-titles.json');
  fs.writeFileSync(titlesFile, JSON.stringify({ titles: { [SESSION_A]: 'Generated title one' } }));
  return { tmp, projectsDir, cacheDir, homes, profiles, titlesFile };
}

// Counts REAL filesystem calls, whichever handle the index reads through, so
// a memo that merely moved the reads to another fs object cannot pass.
function countFsCalls(run) {
  const original = { readdirSync: fs.readdirSync, readFileSync: fs.readFileSync };
  const counts = { readdir: [], readFile: [] };
  fs.readdirSync = (target, ...rest) => { counts.readdir.push(String(target)); return original.readdirSync(target, ...rest); };
  fs.readFileSync = (target, ...rest) => { counts.readFile.push(String(target)); return original.readFileSync(target, ...rest); };
  try {
    run();
  } finally {
    fs.readdirSync = original.readdirSync;
    fs.readFileSync = original.readFileSync;
  }
  return counts;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

test('repeated meta calls neither re-list the homes nor re-read the titles file', () => {
  const { projectsDir, cacheDir, homes, profiles, titlesFile } = makeFixture();
  fs.mkdirSync(path.join(homes.p1, 'session-env', SESSION_A));
  const index = createHistoryIndex({ projectsDir, cacheDir, profiles, refreshFloorMs: 0 });
  index.refreshIndex();
  const first = JSON.parse(index.run(['meta', SESSION_A]));
  assert.strictEqual(first.home, 'p1');
  assert.strictEqual(first.title, 'Generated title one');

  const counts = countFsCalls(() => {
    for (let i = 0; i < 200; i += 1) index.run(['meta', SESSION_A]);
  });
  const underHomes = counts.readdir.filter((target) => Object.values(homes).some((home) => target.startsWith(home)));
  assert.deepStrictEqual(underHomes, [], `200 meta calls listed a home directory ${underHomes.length} times`);
  const titleReads = counts.readFile.filter((target) => target === titlesFile);
  assert.deepStrictEqual(titleReads, [], `200 meta calls read the titles file ${titleReads.length} times`);
});

test('a session that lands in another home\'s history.jsonl is re-attributed on the next meta', async () => {
  const { projectsDir, cacheDir, homes, profiles } = makeFixture();
  fs.mkdirSync(path.join(homes.p1, 'session-env', SESSION_A));
  const index = createHistoryIndex({ projectsDir, cacheDir, profiles, refreshFloorMs: 0 });
  index.refreshIndex();
  assert.strictEqual(JSON.parse(index.run(['meta', SESSION_A])).home, 'p1');

  await settle();
  fs.appendFileSync(path.join(homes.p2, 'history.jsonl'), `${JSON.stringify({ sessionId: SESSION_A })}\n`);
  assert.strictEqual(JSON.parse(index.run(['meta', SESSION_A])).home, 'p2', 'history.jsonl outscores a session-env entry once it changes on disk');
});

test('a new session-env entry attributes an unattributed session on the next meta', async () => {
  const { projectsDir, cacheDir, homes, profiles } = makeFixture();
  const index = createHistoryIndex({ projectsDir, cacheDir, profiles, refreshFloorMs: 0 });
  index.refreshIndex();
  assert.strictEqual(JSON.parse(index.run(['meta', SESSION_A])).home, null);

  await settle();
  fs.mkdirSync(path.join(homes.p2, 'session-env', SESSION_A));
  assert.strictEqual(JSON.parse(index.run(['meta', SESSION_A])).home, 'p2');
});

test('an unchanged titles file is applied once per index pass, not on every meta', () => {
  // The apply loop walks every entry (1,590 on the live machine, ~6ms) and
  // used to run on every meta call even though the entries already carried
  // the titles from the last pass.
  const { projectsDir, cacheDir, profiles } = makeFixture();
  const index = createHistoryIndex({ projectsDir, cacheDir, profiles, refreshFloorMs: 0 });
  const files = index.refreshIndex();
  const [entry] = Object.values(files);
  assert.strictEqual(entry.title, 'Generated title one');
  assert.strictEqual(JSON.parse(index.run(['meta', SESSION_A])).title, 'Generated title one');

  entry.title = 'poked in memory';
  assert.strictEqual(JSON.parse(index.run(['meta', SESSION_A])).title, 'poked in memory');
});

test('a rewritten titles file is reflected on the next meta', async () => {
  const { projectsDir, cacheDir, profiles, titlesFile } = makeFixture();
  const index = createHistoryIndex({ projectsDir, cacheDir, profiles, refreshFloorMs: 0 });
  index.refreshIndex();
  assert.strictEqual(JSON.parse(index.run(['meta', SESSION_A])).title, 'Generated title one');

  await settle();
  fs.writeFileSync(titlesFile, JSON.stringify({ titles: { [SESSION_A]: 'Generated title two, longer' } }));
  assert.strictEqual(JSON.parse(index.run(['meta', SESSION_A])).title, 'Generated title two, longer');
});
