'use strict';

// Gemini (Google's Antigravity CLI) conversations on the rail. The store layout
// and every side file here are the ones measured on a real agy 1.5.14 (2026-11-23):
//   <profile>/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl
//   conversation_summaries.db, annotations/<uuid>.pbtxt, history.jsonl, cache/last_conversations.json
// Words, folders and ids are invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');

const { createProviderHistory } = require('../../src/main/providers/provider-history.js');
const { subSessionKind, isSubSession, railSessionVisible, interactiveAgentArgv } = require('../../src/shared/sub-sessions.cjs');
const { loadSqlite } = require('../../src/main/providers/gemini-store.js');

const sqlite = loadSqlite();
const IDS = {
  typed: '7c1d2e3f-0a1b-4c2d-8e3f-000000000001',
  print: '7c1d2e3f-0a1b-4c2d-8e3f-000000000002',
  child: '7c1d2e3f-0a1b-4c2d-8e3f-000000000003',
  other: '7c1d2e3f-0a1b-4c2d-8e3f-000000000004',
  fresh: '7c1d2e3f-0a1b-4c2d-8e3f-000000000005',
};
const WORK = process.platform === 'win32' ? 'C:\\work\\demo-site' : '/work/demo-site';
const WORK_URI = process.platform === 'win32' ? 'file:///C:/work/demo-site' : 'file:///work/demo-site';
const OLD = new Date('2026-11-20T10:00:00Z');

const userStep = (text) => JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T10:00:00Z', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-20T04:00:00-06:00.\n</ADDITIONAL_METADATA>` });
const answerStep = JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-20T10:00:02Z', model: 'gemini-4-hydrogen-low', input_tokens: 10, cache_read_tokens: 0, output_tokens: 1, content: 'done' });

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-gemini-rail-'));
  // Open handles close first: Windows will not delete a database or a watched folder in use.
  const closers = [];
  t.after(async () => { for (const close of closers) { try { close(); } catch { /* already closed */ } } await fs.rm(dir, { recursive: true, force: true }); });
  const home = path.join(dir, 'profile');
  const store = path.join(home, '.gemini', 'antigravity-cli');
  const transcript = (id, root = store) => path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
  const write = async (id, text, { root = store, at = OLD } = {}) => {
    const file = transcript(id, root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${userStep(text)}\n${answerStep}\n`);
    await fs.utimes(file, at, at);
    return file;
  };
  return { dir, home, store, transcript, write, track: (item) => { closers.push(() => item.close()); return item; } };
}

function summariesDb(file, rows) {
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "", step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL DEFAULT "", workspace_uris text NOT NULL DEFAULT "[]", status text NOT NULL DEFAULT "", source text NOT NULL DEFAULT "", project_id text NOT NULL DEFAULT "", agent_name text NOT NULL DEFAULT "", parent_conversation_id text NOT NULL DEFAULT "", nesting_depth integer NOT NULL DEFAULT 0)');
  const insert = db.prepare('INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, agent_name, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.title ?? '', JSON.stringify(row.uris ?? []), row.agent ?? '', row.parent ?? '', row.depth ?? 0);
  return db; // left open: a real agy holds its database while it runs
}

const make = (f, extra = {}) => createProviderHistory({
  homedir: f.home,
  metadataFile: path.join(f.dir, 'meta.json'),
  debounceMs: 60_000,
  projectLabelForCwd: (cwd) => (cwd ? path.basename(cwd) : null),
  ...extra,
});

test('a Gemini conversation lists in the same row shape as the other providers', async (t) => {
  const f = await fixture(t);
  const file = await f.write(IDS.typed, 'Add a pricing page to the site.');
  await fs.mkdir(path.join(f.store, 'annotations'), { recursive: true });
  await fs.writeFile(path.join(f.store, 'annotations', `${IDS.typed}.pbtxt`), 'title:"Add pricing page"\n');
  const history = make(f);
  f.track(history);
  const rows = await history.listSessions();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, IDS.typed);
  assert.equal(row.provider, 'gemini');
  assert.equal(row.path, file);
  // The typed words, out of <USER_REQUEST>, not agy's metadata blocks.
  assert.equal(row.title, 'Add a pricing page to the site.');
  assert.equal(row.firstPrompt, 'Add a pricing page to the site.');
  assert.match(row.lastActive, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(row.profileId, null);
  assert.equal(row.configHome, null, 'the real profile needs no USERPROFILE override');
  assert.equal(row.headless, false, 'an annotations file names it as typed');
  assert.deepEqual(history.metaFor(IDS.typed), { provider: 'gemini', cwd: null, path: file });
});

test('no Gemini store at all lists nothing, raises nothing and does not force full walks', async (t) => {
  const f = await fixture(t);
  const history = make(f, { codexRoot: path.join(f.dir, 'no-codex'), cursorRoot: path.join(f.dir, 'no-cursor') });
  const watched = [];
  const again = createProviderHistory({
    homedir: f.home, metadataFile: path.join(f.dir, 'meta.json'), debounceMs: 60_000,
    codexRoot: path.join(f.dir, 'no-codex'), cursorRoot: path.join(f.dir, 'no-cursor'),
    watchFactory: (dir) => { watched.push(dir); throw new Error('absent'); },
  });
  f.track(history); f.track(again);
  assert.deepEqual(await history.listSessions(), []);
  again.start();
  assert.deepEqual(watched.filter((dir) => dir.includes('.gemini')), [], 'a store that is not there is not watched, and is not an "unwatched root"');
  assert.deepEqual(await again.listSessions(), []);
});

test('the folder comes from the summaries database (the folder it STARTED in); the transcript has none', { skip: !sqlite }, async (t) => {
  const f = await fixture(t);
  await f.write(IDS.typed, 'Add a pricing page to the site.');
  const db = summariesDb(path.join(f.store, 'conversation_summaries.db'), [{ id: IDS.typed, title: 'Pricing page', uris: [WORK_URI] }]);
  f.track(db);
  const history = make(f);
  f.track(history);
  const [row] = await history.listSessions();
  assert.equal(row.cwd, WORK);
  assert.equal(row.project, 'demo-site');
  assert.equal(history.metaFor(IDS.typed).cwd, WORK);
  assert.equal(row.headless, false, 'a summaries title is only ever written for a typed conversation');
});

test('without node:sqlite the folder falls back to history.jsonl, then last_conversations.json', async (t) => {
  const f = await fixture(t);
  await f.write(IDS.typed, 'Add a pricing page to the site.');
  await f.write(IDS.other, 'Fix the footer links.');
  await f.write(IDS.fresh, 'Tidy the readme.');
  await fs.mkdir(path.join(f.store, 'cache'), { recursive: true });
  // The first prompt of a session is written before its conversation exists, so
  // that line names no id; a later line (a slash command) does.
  await fs.writeFile(path.join(f.store, 'history.jsonl'), [
    JSON.stringify({ display: 'Add a pricing page to the site.', timestamp: 1, workspace: WORK }),
    JSON.stringify({ display: '/exit', timestamp: 2, workspace: WORK, conversationId: IDS.typed, type: 'slash_command' }),
  ].join('\n'));
  await fs.writeFile(path.join(f.store, 'cache', 'last_conversations.json'), JSON.stringify({ [path.join(f.dir, 'elsewhere')]: IDS.other }));
  const history = make(f, { sqlite: null });
  f.track(history);
  const byId = Object.fromEntries((await history.listSessions()).map((row) => [row.id, row]));
  assert.equal(byId[IDS.typed].cwd, WORK, 'history.jsonl');
  assert.equal(byId[IDS.other].cwd, path.join(f.dir, 'elsewhere'), 'last_conversations.json');
  assert.equal(byId[IDS.fresh].cwd, null, 'nothing names it: honestly unknown');
});

test('a print-mode run is told apart from a typed conversation by what only the TUI writes', async (t) => {
  const f = await fixture(t);
  await f.write(IDS.typed, 'Typed in the terminal.');
  await f.write(IDS.print, 'Reply with the word OK.');
  await fs.mkdir(path.join(f.store, 'annotations'), { recursive: true });
  await fs.writeFile(path.join(f.store, 'annotations', `${IDS.typed}.pbtxt`), 'title:"Typed"\n');
  const history = make(f);
  f.track(history);
  const byId = Object.fromEntries((await history.listSessions()).map((row) => [row.id, row]));
  assert.equal(byId[IDS.typed].headless, false);
  assert.equal(byId[IDS.print].headless, true);
  // The shared classifier, which the rail filter and Orch both use.
  assert.equal(subSessionKind(byId[IDS.print]), 'headless Gemini');
  assert.equal(isSubSession(byId[IDS.print]), true);
  assert.equal(railSessionVisible(byId[IDS.print]), false, 'a headless run is not a rail session...');
  assert.equal(railSessionVisible({ ...byId[IDS.print], isLive: true }), true, '...unless a live pane holds it');
  assert.equal(isSubSession(byId[IDS.typed]), false);
});

test('a history.jsonl line that names the id, or Harbor\'s own sidecar, also marks it typed', async (t) => {
  const f = await fixture(t);
  await f.write(IDS.typed, 'One.');
  await f.write(IDS.other, 'Two.');
  await fs.writeFile(path.join(f.store, 'history.jsonl'), `${JSON.stringify({ display: '/exit', timestamp: 2, workspace: WORK, conversationId: IDS.typed })}\n`);
  const history = make(f);
  f.track(history);
  await history.rememberKeeperIdentity({ id: IDS.other, provider: 'gemini', cwd: WORK });
  const byId = Object.fromEntries((await history.listSessions()).map((row) => [row.id, row]));
  assert.equal(byId[IDS.typed].headless, false);
  assert.equal(byId[IDS.other].headless, false, 'Harbor launched it');
  assert.equal(byId[IDS.other].cwd, WORK, 'and remembered where');
});

test('a conversation written to a moment ago is never taken for a print run (agy writes the TUI files a second late)', async (t) => {
  const f = await fixture(t);
  const justNow = new Date();
  await f.write(IDS.fresh, 'Just typed.', { at: justNow });
  const history = make(f);
  f.track(history);
  assert.equal((await history.listSessions())[0].headless, false);
  // The same row, long after, with still nothing from the TUI: a print run.
  const later = make(f, { now: () => Date.now() + 5 * 60_000 });
  f.track(later);
  assert.equal((await later.listSessions())[0].headless, true);
});

test('a sub-agent conversation names its parent and is a sub-agent, not a rail session', { skip: !sqlite }, async (t) => {
  const f = await fixture(t);
  await f.write(IDS.typed, 'Review the whole repo.');
  await f.write(IDS.child, 'Review the auth folder.');
  const db = summariesDb(path.join(f.store, 'conversation_summaries.db'), [
    { id: IDS.typed, title: 'Review repo', uris: [WORK_URI] },
    { id: IDS.child, title: '', uris: [WORK_URI], agent: 'self', parent: IDS.typed, depth: 1 },
  ]);
  f.track(db);
  const history = make(f);
  f.track(history);
  const byId = Object.fromEntries((await history.listSessions()).map((row) => [row.id, row]));
  assert.equal(byId[IDS.child].delegatedBy, IDS.typed);
  assert.equal(subSessionKind(byId[IDS.child]), 'sub-agent');
  assert.equal(byId[IDS.typed].delegatedBy, null);
  assert.equal(isSubSession(byId[IDS.typed]), false);
});

test('the summaries database is read while another connection holds it open in WAL mode', { skip: !sqlite }, async (t) => {
  const f = await fixture(t);
  await f.write(IDS.typed, 'Held open.');
  await fs.mkdir(f.store, { recursive: true });
  const db = summariesDb(path.join(f.store, 'conversation_summaries.db'), [{ id: IDS.typed, title: 'Held', uris: [WORK_URI] }]);
  db.exec('PRAGMA wal_autocheckpoint=0');
  db.prepare('INSERT INTO conversation_summaries (conversation_id, title, workspace_uris) VALUES (?, ?, ?)').run(IDS.other, 'Later', JSON.stringify([WORK_URI]));
  f.track(db);
  const history = make(f);
  f.track(history);
  const [row] = await history.listSessions();
  assert.equal(row.cwd, WORK, 'committed rows in the WAL are visible to the read-only reader');
});

test('a configured Gemini profile is another store, listed with its profile and home; the real profile is not listed twice', async (t) => {
  const f = await fixture(t);
  const second = path.join(f.dir, 'second-profile');
  await f.write(IDS.typed, 'In the real profile.');
  await f.write(IDS.other, 'In the second profile.', { root: path.join(second, '.gemini', 'antigravity-cli') });
  const history = make(f, { profiles: [
    { id: 'gem2', provider: 'gemini', configHome: second },
    { id: 'gem-dup', provider: 'gemini', configHome: f.home },
    { id: 'cx', provider: 'codex', configHome: path.join(f.dir, 'codex-home') },
  ] });
  f.track(history);
  const rows = await history.listSessions();
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(rows.length, 2);
  assert.equal(byId[IDS.typed].profileId, null);
  assert.equal(byId[IDS.other].profileId, 'gem2');
  assert.equal(byId[IDS.other].configHome, second);
  assert.equal(history.metaFor(IDS.other).configHome, second);
});

test('a caller that names its own codex or cursor roots does not also read the real profile\'s Gemini store', async (t) => {
  const f = await fixture(t);
  await f.write(IDS.typed, 'In the real profile.');
  const isolated = createProviderHistory({ codexRoot: path.join(f.dir, 'c'), cursorRoot: path.join(f.dir, 'u'), metadataFile: path.join(f.dir, 'm.json'), debounceMs: 60_000 });
  f.track(isolated);
  assert.deepEqual(await isolated.listSessions(), []);
  const named = createProviderHistory({ codexRoot: path.join(f.dir, 'c'), cursorRoot: path.join(f.dir, 'u'), homedir: f.home, metadataFile: path.join(f.dir, 'm.json'), debounceMs: 60_000 });
  f.track(named);
  assert.equal((await named.listSessions()).length, 1);
});

test('the facts cache keeps a Gemini row\'s title across a restart without re-reading the transcript', async (t) => {
  const f = await fixture(t);
  const file = await f.write(IDS.typed, 'Remember this title.');
  const factsCacheFile = path.join(f.dir, 'facts.json');
  const first = make(f, { factsCacheFile, factsSaveIntervalMs: 0 });
  assert.equal((await first.listSessions())[0].title, 'Remember this title.');
  first.close();
  const stored = JSON.parse(await fs.readFile(factsCacheFile, 'utf8'));
  assert.equal(stored.files[file].facts.firstUser, 'Remember this title.');
  // Prove the second instance reads the facts, not the file: change the bytes but keep size and mtime.
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace('Remember this title.', 'Rememeer this title.'));
  await fs.utimes(file, OLD, OLD);
  const second = make(f, { factsCacheFile, factsSaveIntervalMs: 0 });
  f.track(second);
  assert.equal((await second.listSessions())[0].title, 'Remember this title.');
});

test('keeper identity can be remembered for a gemini session, and only for the three non-Claude providers', async (t) => {
  const f = await fixture(t);
  const history = make(f);
  f.track(history);
  const saved = await history.rememberKeeperIdentity({ id: IDS.typed, provider: 'gemini', cwd: WORK, configHome: null });
  assert.equal(saved.provider, 'gemini');
  assert.equal(saved.cwd, WORK);
  await assert.rejects(history.rememberKeeperIdentity({ id: IDS.typed, provider: 'claude', cwd: WORK }), /codex\/cursor\/gemini/);
});

// ---- the watcher: one added watcher, incremental, same order as a full walk ----

function fakeWatchers() {
  const listeners = new Map();
  const factory = (dir, _options, listener) => { listeners.set(dir, listener); return { on() {}, close() {} }; };
  return { factory, listeners, report: (dir, relative) => listeners.get(dir)('change', relative) };
}

test('one watcher covers a Gemini store; only a reported transcript is re-checked afterwards', async (t) => {
  const f = await fixture(t);
  await f.write(IDS.typed, 'First.');
  const w = fakeWatchers();
  const history = make(f, { watchFactory: w.factory, codexRoot: path.join(f.dir, 'no-codex'), cursorRoot: path.join(f.dir, 'no-cursor') });
  history.start();
  f.track(history);
  assert.ok(w.listeners.has(f.store), 'the store is watched');
  assert.equal([...w.listeners.keys()].filter((dir) => dir.includes('.gemini')).length, 1, 'ONE watcher for the whole store');
  const first = await history.listSessions();
  assert.equal(first.length, 1);

  // A conversation that appears and is reported: listed. Churn beside it: ignored.
  const file = await f.write(IDS.other, 'Second.');
  const rel = (p) => path.relative(f.store, p);
  w.report(f.store, rel(file));
  w.report(f.store, path.join('brain', IDS.other, '.system_generated', 'logs', 'chunks', 'transcript_full', '00000000.jsonl'));
  w.report(f.store, 'conversation_summaries.db-wal');
  const incremental = await history.listSessions();
  assert.deepEqual(incremental.map((row) => row.id).sort(), [IDS.typed, IDS.other].sort());
  const full = await make(f).listSessions();
  assert.deepEqual(incremental.map((row) => row.id), full.map((row) => row.id), 'incremental order equals a full walk\'s');

  // An unreported conversation stays unseen until a nameless event forces a walk.
  await f.write(IDS.fresh, 'Third.');
  assert.ok(!(await history.listSessions()).some((row) => row.id === IDS.fresh));
  w.report(f.store, null);
  assert.ok((await history.listSessions()).some((row) => row.id === IDS.fresh));
});

test('a new conversation folder is picked up from its folder event, before its transcript exists', async (t) => {
  const f = await fixture(t);
  await f.write(IDS.typed, 'First.');
  const w = fakeWatchers();
  const history = make(f, { watchFactory: w.factory, codexRoot: path.join(f.dir, 'no-codex'), cursorRoot: path.join(f.dir, 'no-cursor') });
  history.start();
  f.track(history);
  await history.listSessions();
  w.report(f.store, path.join('brain', IDS.other)); // folder appears, transcript not yet written
  assert.equal((await history.listSessions()).length, 1, 'nothing to list yet, and no error');
  await f.write(IDS.other, 'Now it is there.');
  w.report(f.store, path.join('brain', IDS.other, '.system_generated', 'logs', 'transcript_full.jsonl'));
  assert.equal((await history.listSessions()).length, 2);
});

test('a store that appears after Harbor started is noticed on the next listing', async (t) => {
  const f = await fixture(t);
  const w = fakeWatchers();
  const history = make(f, { watchFactory: w.factory, codexRoot: path.join(f.dir, 'no-codex'), cursorRoot: path.join(f.dir, 'no-cursor') });
  history.start();
  f.track(history);
  assert.deepEqual(await history.listSessions(), []);
  assert.ok(!w.listeners.has(f.store));
  await f.write(IDS.typed, 'agy was installed after Harbor started.');
  const rows = await history.listSessions();
  assert.equal(rows.length, 1);
  assert.ok(w.listeners.has(f.store), 'now watched');
});

test('the shared classifier reads an agy command line: -p, --print, acp are not a terminal session', () => {
  const agy = ['C:\\tools\\agy\\agy.exe'];
  assert.equal(interactiveAgentArgv('gemini', agy), true);
  assert.equal(interactiveAgentArgv('gemini', [...agy, '--conversation', IDS.typed]), true);
  assert.equal(interactiveAgentArgv('gemini', [...agy, '-p', 'say OK']), false);
  assert.equal(interactiveAgentArgv('gemini', [...agy, '--print', 'say OK']), false);
  assert.equal(interactiveAgentArgv('gemini', [...agy, 'acp']), false);
  assert.equal(interactiveAgentArgv('gemini', ['node.exe', 'other.js']), null, 'not agy: no evidence');
  assert.equal(interactiveAgentArgv('cursor', agy), null, 'cursor still has no discriminator');
});
