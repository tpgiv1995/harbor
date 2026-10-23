'use strict';

// Compressed (.jsonl.zst) and archived codex rollouts on the rail, and what it
// costs to list them. Codex compresses a rollout once it is about a week old
// and moves an archived chat to <home>/archived_sessions/. Every record below
// is SYNTHETIC, in the real record shapes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { realTmpDir } = require('../support/real-tmpdir.js');
const {
  createProviderHistory, acceptCodexHomeEvent, createChangeScheduler, extractRowFacts,
} = require('../../src/main/providers/provider-history.js');
const { pruneRolloutCopies } = require('../../src/main/providers/codex-rollout-files.js');

const noZstd = typeof zlib.zstdCompressSync !== 'function' && 'runtime has no zstd';
const ACTIVE_ID = '019f8250-89cc-73d3-9c1a-30007bced9ff';
const ARCHIVED_ID = '019f4d0b-373e-7102-969b-2b45933cbdfb';
const COLD_ID = '019f4d31-2dfb-7840-90c1-a3e2964bd4e8';
const STAMP_S = 1_700_000_000;

const meta = (id, cwd, extra = {}) => JSON.stringify({ timestamp: '2026-07-10T12:20:08.000Z', type: 'session_meta', payload: { id, session_id: id, timestamp: '2026-07-10T12:20:08.000Z', cwd, originator: 'codex_cli_rs', base_instructions: { text: 'x'.repeat(20000) }, ...extra } });
const user = (text) => JSON.stringify({ timestamp: '2026-07-10T12:20:09.000Z', type: 'event_msg', payload: { type: 'user_message', message: text } });
const filler = (bytes) => JSON.stringify({ timestamp: '2026-07-10T12:20:09.500Z', type: 'event_msg', payload: { type: 'token_count', note: 'x'.repeat(bytes) } });
const rollout = (id, cwd, prompt) => [meta(id, cwd), user(prompt)].join('\n');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t) {
  const dir = tmp(t, 'provider-codex-archive-');
  const home = path.join(dir, '.codex');
  const day = path.join(home, 'sessions', '2026', '07', '10');
  const archived = path.join(home, 'archived_sessions');
  fs.mkdirSync(day, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  const history = (extra = {}) => createProviderHistory({
    codexRoots: [{ root: path.join(home, 'sessions'), profileId: null, configHome: home }],
    cursorRoot: path.join(dir, 'none'),
    metadataFile: path.join(dir, 'cache', 'provider-session-metadata.json'),
    ...extra,
  });
  return { dir, home, day, archived, history, copies: path.join(dir, 'cache', 'codex-rollouts') };
}

test('compressed and archived codex rollouts list, flagged, one row per id', { skip: noZstd }, async (t) => {
  const { day, archived, history, copies } = fixture(t);
  // A cold (compressed) active session, an archived compressed one, and an
  // archived plain copy of an id that is ALSO active: the active file wins.
  fs.writeFileSync(path.join(day, `rollout-2026-07-10T12-20-08-${COLD_ID}.jsonl.zst`),
    zlib.zstdCompressSync(Buffer.from(rollout(COLD_ID, '/home/user/dev/widget', 'Cold session prompt.'))));
  fs.writeFileSync(path.join(archived, `rollout-2026-07-10T12-20-08-${ARCHIVED_ID}.jsonl.zst`),
    zlib.zstdCompressSync(Buffer.from(rollout(ARCHIVED_ID, '/home/user/dev/widget', 'Archived spike prompt.'))));
  fs.writeFileSync(path.join(day, `rollout-2026-07-21T01-35-28-${ACTIVE_ID}.jsonl`), rollout(ACTIVE_ID, '/home/user/dev/widget', 'Active prompt.'));
  fs.writeFileSync(path.join(archived, `rollout-2026-07-21T01-35-28-${ACTIVE_ID}.jsonl`), rollout(ACTIVE_ID, '/home/user/dev/widget', 'Stale archived copy.'));

  const provider = history();
  const rows = await provider.listSessions({});
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(rows.length, 3, 'one row per codex id');
  assert.equal(byId.get(ACTIVE_ID).archived, undefined, 'the active copy wins over an archived one');
  assert.equal(byId.get(ACTIVE_ID).title, 'Active prompt.');
  assert.equal(byId.get(COLD_ID).compressed, true);
  assert.equal(byId.get(COLD_ID).archived, undefined);
  assert.equal(byId.get(COLD_ID).title, 'Cold session prompt.', 'title read through the zstd stream');
  assert.equal(byId.get(COLD_ID).cwd, '/home/user/dev/widget', 'cwd from the compressed session_meta');
  assert.equal(byId.get(ARCHIVED_ID).archived, true);
  assert.equal(byId.get(ARCHIVED_ID).title, 'Archived spike prompt.');

  // Identity lookups (the Orch join asks for every candidate) never
  // decompress and never hand out a .zst as if it were JSONL.
  const plainMeta = provider.metaFor(ARCHIVED_ID);
  assert.equal(plainMeta.path, null);
  assert.match(plainMeta.rolloutPath, /\.jsonl\.zst$/);
  assert.equal(plainMeta.archived, true);
  assert.equal(plainMeta.cwd, '/home/user/dev/widget');
  assert.equal(fs.existsSync(copies), false, 'metaFor wrote no copy');

  // A reader of the conversation gets a plain, decompressed copy, made once.
  const readable = await provider.readableMetaFor(ARCHIVED_ID);
  assert.equal(path.dirname(readable.path), copies);
  assert.equal(fs.readFileSync(readable.path, 'utf8'), rollout(ARCHIVED_ID, '/home/user/dev/widget', 'Archived spike prompt.'));
  const ino = fs.statSync(readable.path).ino;
  assert.equal(fs.statSync((await provider.readableMetaFor(ARCHIVED_ID)).path).ino, ino, 'the copy is reused');
  // A plain row is the same object either way.
  assert.equal((await provider.readableMetaFor(ACTIVE_ID)).path, provider.metaFor(ACTIVE_ID).path);
  assert.equal(await provider.readableMetaFor('not-a-known-id'), null);
});

test('a compressed head is capped after its first line; the first line is always read whole', { skip: noZstd }, async (t) => {
  const dir = tmp(t, 'provider-codex-cap-');
  const cap = 64 * 1024;
  // A session_meta far larger than the cap still yields its cwd.
  const bigMeta = meta(ACTIVE_ID, '/home/user/dev/widget', { base_instructions: { text: 'p'.repeat(4 * cap) } });
  const near = path.join(dir, `rollout-2026-07-21T01-35-28-${ACTIVE_ID}.jsonl.zst`);
  fs.writeFileSync(near, zlib.zstdCompressSync(Buffer.from([bigMeta, filler(cap / 2), user('Inside the cap.')].join('\n'))));
  const far = path.join(dir, `rollout-2026-07-21T01-35-28-${COLD_ID}.jsonl.zst`);
  fs.writeFileSync(far, zlib.zstdCompressSync(Buffer.from([bigMeta, filler(2 * cap), user('Past the cap.')].join('\n'))));

  const inside = await extractRowFacts(near, 'codex', { compressedHeadBytes: cap });
  assert.equal(inside.cwd, '/home/user/dev/widget', 'the oversized first line is read whole');
  assert.equal(inside.firstUser, 'Inside the cap.');
  const past = await extractRowFacts(far, 'codex', { compressedHeadBytes: cap });
  assert.equal(past.cwd, '/home/user/dev/widget');
  assert.equal(past.firstUser, null, 'nothing past the cap is decompressed into the scan');
  const uncapped = await extractRowFacts(far, 'codex', { compressedHeadBytes: 16 * cap });
  assert.equal(uncapped.firstUser, 'Past the cap.', 'the same file titles when the cap allows it');
});

test('a compressed row comes back from the saved facts on the next launch without decompressing', { skip: noZstd }, async (t) => {
  const { dir, day, archived, history } = fixture(t);
  const cold = path.join(archived, `rollout-2026-07-10T12-20-08-${COLD_ID}.jsonl.zst`);
  const bytes = zlib.zstdCompressSync(Buffer.from(rollout(COLD_ID, '/home/user/dev/widget', 'Saved compressed title.')));
  fs.writeFileSync(cold, bytes);
  fs.utimesSync(cold, STAMP_S, STAMP_S);
  fs.writeFileSync(path.join(day, `rollout-2026-07-21T01-35-28-${ACTIVE_ID}.jsonl`), rollout(ACTIVE_ID, '/w', 'Plain.'));
  const factsCacheFile = path.join(dir, 'cache', 'provider-row-facts.json');
  const launch = (cache = factsCacheFile) => history({ factsCacheFile: cache }).listSessions({})
    .then((rows) => rows.find((row) => row.id === COLD_ID));

  const first = await launch();
  assert.equal(first.title, 'Saved compressed title.');
  assert.equal(first.archived, true);
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(factsCacheFile, 'utf8')).files).includes(cold), 'its facts are saved by path');

  // Same size, same mtime, bytes that are not zstd at all.
  fs.writeFileSync(cold, Buffer.alloc(bytes.length, 0x41));
  fs.utimesSync(cold, STAMP_S, STAMP_S);
  assert.notEqual((await launch(null)).title, 'Saved compressed title.', 'control: a cold read cannot title it now');
  const warm = await launch();
  assert.equal(warm.title, 'Saved compressed title.', 'the next launch trusted the saved facts and decompressed nothing');
  assert.equal(warm.archived, true, 'archived and compressed come back with the path');
  assert.equal(warm.compressed, true);
});

test('the codex-home watcher filter accepts only the session index and the session dirs', () => {
  for (const name of ['session_index.jsonl', 'sessions', 'archived_sessions', null, undefined]) assert.equal(acceptCodexHomeEvent(name), true, String(name));
  for (const name of ['logs_2.sqlite', 'logs_2.sqlite-wal', 'state_5.sqlite', 'models_cache.json', '.codex-global-state.json', 'config.toml']) {
    assert.equal(acceptCodexHomeEvent(name), false, name);
  }
});

test('codex log and cache writes in the home do not refresh the rail; a session index write does', async (t) => {
  const { home, history } = fixture(t);
  fs.writeFileSync(path.join(home, 'logs_2.sqlite'), 'x');
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), '');
  const provider = history({ debounceMs: 50 });
  let changed = 0;
  provider.emitter.on('changed', () => { changed += 1; });
  provider.start();
  t.after(() => provider.close());
  await new Promise((resolve) => setTimeout(resolve, 300));
  changed = 0;
  for (let i = 0; i < 3; i++) {
    await fsp.appendFile(path.join(home, 'logs_2.sqlite'), 'more');
    await fsp.writeFile(path.join(home, 'models_cache.json'), `{"n":${i}}`);
    await fsp.writeFile(path.join(home, 'state_5.sqlite'), String(i));
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(changed, 0, 'log, database and cache writes are ignored');
  await fsp.appendFile(path.join(home, 'session_index.jsonl'), '{"id":"x","thread_name":"Renamed"}\n');
  const deadline = Date.now() + 5000;
  while (!changed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(changed, 1, 'a session index write refreshes');
});

test('the change debounce fires after quiet, and at the max wait while events never stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let fired = 0;
  const changes = createChangeScheduler(() => { fired += 1; }, { debounceMs: 5000, maxWaitMs: 30000 });
  changes.schedule();
  t.mock.timers.tick(4999);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1, 'quiet for the debounce fires');

  // An event every second, forever: a pure trailing debounce never fires.
  fired = 0;
  for (let second = 0; second < 29; second++) { changes.schedule(); t.mock.timers.tick(1000); }
  assert.equal(fired, 0, 'still inside the max wait');
  changes.schedule();
  t.mock.timers.tick(1000);
  assert.equal(fired, 1, 'fires at the max wait even though events keep coming');
  changes.schedule();
  changes.cancel();
  t.mock.timers.tick(60000);
  assert.equal(fired, 1, 'cancel drops a pending fire');
});

test('decompressed copies are pruned by age, then least recently used to the byte cap; kept copies stay', async (t) => {
  const dir = tmp(t, 'provider-codex-copies-');
  const now = STAMP_S * 1000;
  const copy = (id, bytes, usedS) => {
    const file = path.join(dir, `rollout-2026-07-10T12-20-08-${id}.jsonl`);
    fs.writeFileSync(file, 'x'.repeat(bytes));
    fs.utimesSync(file, usedS, usedS);
    return file;
  };
  // ctime is the real write time, so "use" here is pinned by a far-future now.
  const day = 24 * 60 * 60;
  const a = copy('019f0000-0000-7000-8000-00000000000a', 400, STAMP_S - day);
  const b = copy('019f0000-0000-7000-8000-00000000000b', 400, STAMP_S - 2 * day);
  const kept = copy('019f0000-0000-7000-8000-00000000000c', 400, STAMP_S - 3 * day);
  const stray = path.join(dir, 'notes.txt');
  fs.writeFileSync(stray, 'not a copy');
  const tmpFile = path.join(dir, 'rollout-x.jsonl.123.tmp');
  fs.writeFileSync(tmpFile, 'torn');

  const later = Date.now() + 8 * day * 1000;
  const aged = await pruneRolloutCopies(dir, { keep: new Set([kept]), now: () => later });
  assert.deepEqual(aged.removed.sort(), [a, b, tmpFile].sort(), 'unused for a week, and a leftover .tmp');
  assert.ok(fs.existsSync(kept), 'a copy in use is never removed');
  assert.ok(fs.existsSync(stray), 'nothing but copies is touched');

  const c = copy('019f0000-0000-7000-8000-00000000000d', 400, STAMP_S);
  const d = copy('019f0000-0000-7000-8000-00000000000e', 400, STAMP_S);
  const capped = await pruneRolloutCopies(dir, { keep: new Set([kept]), maxBytes: 900, now: () => now });
  assert.equal(capped.removed.length, 1, 'the oldest unkept copy goes until the directory fits');
  assert.ok([c, d].includes(capped.removed[0]));
  assert.ok(capped.bytes <= 900);
});
