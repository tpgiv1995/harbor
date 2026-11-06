'use strict';

// The two scans Harbor's window waits on resume from disk instead of starting
// cold on every launch (2026-10-09: 12.5s + 13s of a 75s launch). Each proof
// is two-sided: a file's bytes are changed while its size and mtime are kept,
// so a scan that TRUSTED the cache still reports the old content (it did not
// read the file) while a cold scan reports the new content (the file really
// changed). A moved stamp or a foreign format must fall back to reading.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { createProviderHistory } = require('../../src/main/providers/provider-history.js');
const { createScanner } = require('../../src/main/providers/delegations-worker.js');
const { createDelegationIndex } = require('../../src/main/providers/delegations.js');
const bg = require('../../src/main/providers/background-tasks.js');

const CODEX_ID = '019f8250-89cc-73d3-9c1a-30007bced9ff';
const STAMP_S = 1_700_000_000; // a round mtime, so restoring it is exact

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRollout(file, prompt) {
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: '2026-07-21T01:35:28.639Z', type: 'session_meta', payload: { session_id: CODEX_ID, cwd: '/home/user/dev/widget', originator: 'codex_exec' } }),
    JSON.stringify({ timestamp: '2026-07-21T01:35:30.000Z', type: 'event_msg', payload: { type: 'user_message', message: prompt } }),
  ].join('\n'));
  fs.utimesSync(file, STAMP_S, STAMP_S);
}

test('codex/cursor rows come from the saved head facts when the file is unchanged, and from the file when it moved', async (t) => {
  const dir = tmp(t, 'harbor-facts-cache-');
  const codexRoot = path.join(dir, 'codex-sessions');
  const day = path.join(codexRoot, '2026', '07', '21');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-07-21T01-35-28-${CODEX_ID}.jsonl`);
  const factsCacheFile = path.join(dir, 'provider-row-facts.json');
  const launch = (cache = factsCacheFile) => createProviderHistory({ codexRoot, cursorRoot: path.join(dir, 'none'), metadataFile: path.join(dir, 'meta.json'), factsCacheFile: cache })
    .listSessions().then((rows) => rows.find((row) => row.id === CODEX_ID));

  writeRollout(rollout, 'Fix the flaky widget test.');
  assert.equal((await launch()).title, 'Fix the flaky widget test.', 'first launch reads the file');
  assert.ok(fs.existsSync(factsCacheFile), 'and saves what it read');

  // Same length, same mtime, different words.
  writeRollout(rollout, 'Fix the flaky gadget test.');
  assert.equal((await launch(null)).title, 'Fix the flaky gadget test.', 'control: the file really changed');
  assert.equal((await launch()).title, 'Fix the flaky widget test.', 'a fresh launch trusted the saved facts and never read the file');

  fs.utimesSync(rollout, STAMP_S + 60, STAMP_S + 60);
  assert.equal((await launch()).title, 'Fix the flaky gadget test.', 'a moved mtime is a reread');

  const saved = JSON.parse(fs.readFileSync(factsCacheFile, 'utf8'));
  saved.format = 'produced-by-other-code';
  saved.files[rollout].facts.firstUser = 'stale';
  fs.writeFileSync(factsCacheFile, JSON.stringify(saved));
  assert.equal((await launch()).title, 'Fix the flaky gadget test.', 'a cache written by different code is ignored');
});

// 2026-11-06: a live codex session grows its log on every turn, and every
// rail refresh rewrote the whole facts file (4 MB on Pat's machine) in the app
// and again in the phone server. One instance writes at most once per
// interval; what changed meanwhile is written on close.
test('the facts file is written at most once per interval, and the newest facts land on close', async (t) => {
  const dir = tmp(t, 'harbor-facts-interval-');
  const codexRoot = path.join(dir, 'codex-sessions');
  const day = path.join(codexRoot, '2026', '07', '21');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-07-21T01-35-28-${CODEX_ID}.jsonl`);
  const factsCacheFile = path.join(dir, 'provider-row-facts.json');
  const history = createProviderHistory({ codexRoot, cursorRoot: path.join(dir, 'none'), metadataFile: path.join(dir, 'meta.json'), factsCacheFile, factsSaveIntervalMs: 60_000 });
  const savedPrompt = () => JSON.parse(fs.readFileSync(factsCacheFile, 'utf8')).files[rollout].facts.firstUser;

  writeRollout(rollout, 'First prompt of the session.');
  await history.listSessions();
  assert.equal(savedPrompt(), 'First prompt of the session.', 'the first refresh writes the file');

  writeRollout(rollout, 'A different opening prompt now.');
  fs.utimesSync(rollout, STAMP_S + 60, STAMP_S + 60);
  const rows = await history.listSessions();
  assert.equal(rows.find((row) => row.id === CODEX_ID).title, 'A different opening prompt now.', 'the rail sees the change at once');
  assert.equal(savedPrompt(), 'First prompt of the session.', 'but the file is not rewritten inside the interval');

  history.close();
  assert.equal(savedPrompt(), 'A different opening prompt now.', 'close writes the newest facts');
});

const stamp = (n) => new Date(100000 + n * 1000).toISOString();
const launchLines = () => [
  { type: 'assistant', timestamp: stamp(0), message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { description: 'Long build', command: 'npm run build' } }] } },
  { type: 'user', timestamp: stamp(1), message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Command running in background with ID: old.' }] } },
].map((row) => JSON.stringify(row)).join('\n') + '\n';
const doneLine = () => {
  const text = '<task-notification><task-id>old</task-id><status>completed</status><summary>done</summary></task-notification>';
  return `${JSON.stringify({ type: 'queue-operation', timestamp: stamp(5), operation: 'enqueue', content: text, attachment: { type: 'queued_command', prompt: text }, message: { content: text } })}\n`;
};
// The prefix overwritten in place with blanks of the same length: the launch
// is gone from the bytes, so only a scan that RESUMED past it still knows it.
const blankPrefix = (file, length) => {
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.alloc(length - 1, 0x20), 0, length - 1, 0);
  fs.closeSync(fd);
};

test('the previous release facts and fold caches remain usable before background migration', async (t) => {
  const dir = tmp(t, 'harbor-compatible-cache-'); const codexRoot = path.join(dir, 'codex');
  const day = path.join(codexRoot, '2026', '07', '21'); fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-07-21T01-35-28-${CODEX_ID}.jsonl`);
  writeRollout(file, 'New prompt on disk');
  const stat = fs.statSync(file); const factsCacheFile = path.join(dir, 'facts.json');
  fs.writeFileSync(factsCacheFile, JSON.stringify({ format: 'e823c78fa0869b94', files: { [file]: { size: stat.size, mtimeMs: stat.mtimeMs,
    facts: { cwd: 'C:\\synthetic\\project', firstUser: 'Cached prompt', lineage: { kind: 'unknown', originator: 'codex_exec' } } } } }));
  const provider = createProviderHistory({ codexRoot, cursorRoot: path.join(dir, 'none'), metadataFile: path.join(dir, 'meta.json'), factsCacheFile }); t.after(() => provider.close());
  assert.equal((await provider.listSessions())[0].firstPrompt, 'Cached prompt', 'first refresh trusts compatible facts');
  assert.equal((await provider.migrateEntries(8)).changed, 1);
  assert.equal((await provider.listSessions())[0].firstPrompt, 'Cached prompt', 'lineage-only migration does not reparse prompt bodies');

  const transcript = path.join(dir, 'background.jsonl'); const cacheFile = path.join(dir, 'fold.json');
  const prefix = launchLines(); fs.writeFileSync(transcript, prefix);
  const first = createScanner(); await first(transcript); await first.save(cacheFile);
  const cached = JSON.parse(fs.readFileSync(cacheFile)); cached.format = 'da8a47743f347015'; fs.writeFileSync(cacheFile, JSON.stringify(cached));
  blankPrefix(transcript, Buffer.byteLength(prefix)); fs.appendFileSync(transcript, doneLine());
  const second = createScanner(); second.load(cacheFile);
  assert.equal((await second(transcript)).state.tasks.old?.status, 'completed', 'IPC changes do not invalidate unchanged background folds');
});

test('the background fold resumes from its saved offset in a new scanner, and a foreign format starts over', async (t) => {
  const dir = tmp(t, 'harbor-fold-cache-');
  const file = path.join(dir, 'parent.jsonl');
  const cacheFile = path.join(dir, 'background-fold.json');
  const prefix = launchLines();
  fs.writeFileSync(file, prefix);

  const first = createScanner();
  assert.equal(bg.backgroundSnapshot((await first(file)).state).outstanding[0].id, 'old');
  await first.save(cacheFile);

  blankPrefix(file, Buffer.byteLength(prefix));
  fs.appendFileSync(file, doneLine());

  const cold = createScanner();
  assert.equal(Object.keys((await cold(file)).state.tasks).length, 0, 'control: the launch is gone from the bytes');

  const resumed = createScanner();
  resumed.load(cacheFile);
  const tasks = (await resumed(file)).state.tasks;
  assert.equal(tasks.old?.status, 'completed', 'resumed past the blanked prefix and folded only the appended notice');

  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  saved.format = 'produced-by-other-code';
  fs.writeFileSync(cacheFile, JSON.stringify(saved));
  const foreign = createScanner();
  foreign.load(cacheFile);
  assert.equal(Object.keys((await foreign(file)).state.tasks).length, 0, 'a foreign format is never trusted');
});

test('through the real worker: a second index with the same cache file resumes where the first stopped', async (t) => {
  const dir = tmp(t, 'harbor-fold-worker-');
  const file = path.join(dir, 'parent.jsonl');
  const cacheFile = path.join(dir, 'background-fold.json');
  const prefix = launchLines();
  fs.writeFileSync(file, prefix);
  const row = { id: 'parent', path: file, lastActive: new Date().toISOString() };

  const first = createDelegationIndex({}, { cacheFile });
  assert.equal((await first.scan([row])).parents[0].background.outstanding[0].id, 'old');
  // The worker replies first and saves after; wait for the file.
  for (let i = 0; i < 100 && !fs.existsSync(cacheFile); i += 1) await new Promise((r) => setTimeout(r, 20));
  first.close();
  assert.ok(fs.existsSync(cacheFile), 'the worker saved its fold');

  blankPrefix(file, Buffer.byteLength(prefix));
  fs.appendFileSync(file, doneLine());

  const second = createDelegationIndex({}, { cacheFile });
  let tasks;
  try {
    tasks = (await second.scan([row])).parents[0].background.tasks;
    // Let its own post-reply save land before the directory is removed.
    const savedAt = fs.statSync(cacheFile).mtimeMs;
    for (let i = 0; i < 100 && fs.statSync(cacheFile).mtimeMs === savedAt; i += 1) await new Promise((r) => setTimeout(r, 20));
  } finally {
    second.close();
  }
  assert.equal(tasks.find((task) => task.id === 'old')?.status, 'completed', 'the new worker resumed from the saved offset');
});

// Astra review round 2, N7: an older trailing write paused at its rename could
// land after the close-time flush and leave older facts on disk.
test('an older facts write that lands late never leaves older facts on disk', async (t) => {
  const fsp = require('node:fs/promises');
  const dir = tmp(t, 'harbor-facts-race-');
  const codexRoot = path.join(dir, 'codex-sessions');
  const day = path.join(codexRoot, '2026', '07', '21');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-07-21T01-35-28-${CODEX_ID}.jsonl`);
  const factsCacheFile = path.join(dir, 'provider-row-facts.json');
  const history = createProviderHistory({ codexRoot, cursorRoot: path.join(dir, 'none'), metadataFile: path.join(dir, 'meta.json'), factsCacheFile, factsSaveIntervalMs: 0 });
  const savedPrompt = () => JSON.parse(fs.readFileSync(factsCacheFile, 'utf8')).files[rollout].facts.firstUser;
  writeRollout(rollout, 'Version A of the prompt.');
  await history.listSessions();
  const realRename = fsp.rename;
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let paused = 0;
  fsp.rename = async (...args) => { if (String(args[1]) === factsCacheFile && paused++ === 0) await gate; return realRename(...args); };
  t.after(() => { fsp.rename = realRename; });
  writeRollout(rollout, 'Version B of the prompt.'); fs.utimesSync(rollout, STAMP_S + 60, STAMP_S + 60);
  const writingB = history.listSessions(); // pauses at B's rename
  await new Promise((resolve) => setTimeout(resolve, 50));
  writeRollout(rollout, 'Version C of the prompt.'); fs.utimesSync(rollout, STAMP_S + 120, STAMP_S + 120);
  await history.listSessions();
  history.close();
  assert.equal(savedPrompt(), 'Version C of the prompt.', 'close leaves the newest facts');
  release(); await writingB;
  assert.equal(savedPrompt(), 'Version C of the prompt.', 'and the older write that landed late does not replace them');
});
