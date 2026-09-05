'use strict';

// The task file. The reducer's correctness is proven in test/shared; this file
// is only about the three things that decide whether a task list is trustworthy:
// where it lives, that a write cannot half-happen, and that unreadable bytes are
// never thrown away.
//
// Every case runs against a throwaway file named by HARBOR_TASKS_FILE, never the
// real userData one. Spec 1 is the guard for that ordering: env is checked
// BEFORE the composed config on purpose (the 2026-07-28 lesson, where an
// isolated app started reading the real store because composition began
// outranking the env override).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { realTmpDir } = require('../support/real-tmpdir.js');
const path = require('node:path');

const { createTaskStore, resolveTasksFile } = require('../../src/main/providers/tasks.js');

const QUIET = { error() {}, warn() {}, log() {} };

function tempFile(name = 'tasks.json') {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-tasks-test-'));
  return { dir, file: path.join(dir, name) };
}

function storeOn(file, extra = {}) {
  return createTaskStore({ file, logger: QUIET, ...extra });
}

async function addTask(store, title, listId) {
  const result = await store.mutate({ type: 'task.add', listId, title });
  assert.equal(result.ok, true, result.reason);
  return result;
}

test('1) env names the file and outranks both the composed config and userData', () => {
  const fakeApp = { getPath: () => '/real/userData' };
  assert.equal(
    resolveTasksFile({
      env: { HARBOR_TASKS_FILE: '/tmp/throwaway/tasks.json' },
      configuredFile: '/configured/tasks.json',
      app: fakeApp,
    }),
    path.resolve('/tmp/throwaway/tasks.json'),
    'a relocated harness must not be able to reach the real store just because config composition ran',
  );
  assert.equal(
    resolveTasksFile({ env: {}, configuredFile: '/configured/tasks.json', app: fakeApp }),
    path.resolve('/configured/tasks.json'),
  );
  assert.equal(
    resolveTasksFile({ env: {}, app: fakeApp }),
    path.join('/real/userData', 'tasks.json'),
    'the default is userData-relative, so an isolated Electron profile is isolated here for free',
  );
});

test('2) a first read on a machine with no file returns a usable empty document and writes nothing', async () => {
  const { file } = tempFile();
  const store = storeOn(file);
  const { ok, doc } = await store.read();
  assert.equal(ok, true);
  assert.equal(doc.lists.length, 1);
  assert.deepEqual(doc.tasks, []);
  assert.equal(fs.existsSync(file), false, 'reading must not create the file');
  store.close();
});

test('3) a write lands atomically, keeps a backup, and leaves no temp behind', async () => {
  const { dir, file } = tempFile();
  const store = storeOn(file);
  const first = await addTask(store, 'First task');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.bak`), false, 'nothing to back up on the very first write');

  await addTask(store, 'Second task', first.doc.lists[0].id);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk.tasks.map((t) => t.title), ['First task', 'Second task']);

  const backup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.deepEqual(backup.tasks.map((t) => t.title), ['First task'], 'the backup is the copy just replaced');

  const stray = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(stray, [], 'no temp file survives a completed write');
  store.close();
});

test('4) a refused operation changes nothing on disk and answers with the reason', async () => {
  const { file } = tempFile();
  const store = storeOn(file);
  const seeded = await addTask(store, 'Real task');
  const before = fs.readFileSync(file, 'utf8');

  const refused = await store.mutate({ type: 'task.add', listId: seeded.doc.lists[0].id, title: '   ' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /needs a name/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refusal is not a write');

  const unknown = await store.mutate({ type: 'nonsense' });
  assert.equal(unknown.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  store.close();
});

test('5) unreadable JSON is restored from the backup, and the bad bytes are kept, never overwritten', async () => {
  const { dir, file } = tempFile();
  const store = storeOn(file);
  const first = await addTask(store, 'Survivor');
  await addTask(store, 'Also here', first.doc.lists[0].id);
  store.close();

  // Corrupt the live file. The backup still holds the one-task version.
  fs.writeFileSync(file, '{"tasks": [ this is not json');

  const reopened = storeOn(file);
  const { doc, recovery } = await reopened.read();
  assert.deepEqual(doc.tasks.map((t) => t.title), ['Survivor'], 'the last good copy comes back');
  assert.equal(recovery.kind, 'restored-backup');
  assert.equal(fs.existsSync(file), false, 'the unreadable file was moved aside, not deleted or rewritten');
  const quarantined = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(recovery.detail, path.join(dir, quarantined[0]));
  assert.match(fs.readFileSync(recovery.detail, 'utf8'), /this is not json/, 'the original bytes are intact');
  reopened.close();
});

test('6) unreadable JSON with no backup starts fresh, still without destroying the bad bytes', async () => {
  const { dir, file } = tempFile();
  fs.writeFileSync(file, 'not json at all');
  const store = storeOn(file);
  const { doc, recovery } = await store.read();
  assert.deepEqual(doc.tasks, []);
  assert.equal(doc.lists.length, 1);
  assert.equal(recovery.kind, 'corrupt');
  assert.match(fs.readFileSync(recovery.detail, 'utf8'), /not json at all/);
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.corrupt-')).length, 1);
  store.close();
});

test('7) concurrent mutations serialize, so no tick loses another', async () => {
  const { file } = tempFile();
  const store = storeOn(file);
  const seeded = await addTask(store, 'anchor');
  const listId = seeded.doc.lists[0].id;

  // Fire twelve adds in one tick. Without a write chain each would read the same
  // pre-change document and the last write would erase the other eleven.
  const titles = Array.from({ length: 12 }, (_, i) => `task ${i}`);
  const results = await Promise.all(titles.map((title) => store.mutate({ type: 'task.add', listId, title })));
  for (const result of results) assert.equal(result.ok, true, result.reason);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.tasks.length, 13);
  for (const title of titles) {
    assert.ok(onDisk.tasks.some((t) => t.title === title), `${title} survived`);
  }
  store.close();
});

test('8) a failed write is reported honestly and does not wedge every later mutation', {
  skip: process.platform === 'win32' && 'NTFS directory mode bits cannot make the write fail on Windows',
}, async () => {
  const { file } = tempFile();
  const store = storeOn(file);
  await addTask(store, 'before');

  // Make the directory unwritable so the temp write fails. Root ignores mode
  // bits, so skip rather than assert something untrue.
  const dir = path.dirname(file);
  const original = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o500);
  const blocked = await store.mutate({ type: 'task.add', title: 'during' });
  fs.chmodSync(dir, original);

  if (blocked.ok) {
    assert.ok(process.getuid?.() === 0, 'a non-root run must not be able to write to a read-only directory');
  } else {
    assert.match(blocked.reason, /could not save/);
    assert.ok(blocked.reason.includes(file), 'the refusal names the file it could not write');
  }

  // The chain survived: the next mutation still works.
  const after = await store.mutate({ type: 'task.add', title: 'after' });
  assert.equal(after.ok, true, after.reason);
  assert.ok(after.doc.tasks.some((t) => t.title === 'after'));
  store.close();
});

test('9) an edit made outside Harbor is pushed to subscribers; our own writes are not', async () => {
  const { file } = tempFile();
  const store = storeOn(file);
  const seeded = await addTask(store, 'from harbor');

  const seen = [];
  const unsubscribe = store.subscribe((doc) => seen.push(doc.tasks.map((t) => t.title)));

  // Our own write must not bounce back: the renderer already has this document.
  await addTask(store, 'also from harbor', seeded.doc.lists[0].id);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(seen, [], 'a write we made ourselves is not news');

  // Somebody else (a script, jq, another agent) rewrites the file.
  const outside = JSON.parse(fs.readFileSync(file, 'utf8'));
  outside.tasks.push({
    id: 'outside-1',
    listId: outside.lists[0].id,
    title: 'added by hand',
    createdAt: Date.now(),
  });
  await fsp.writeFile(file, `${JSON.stringify(outside, null, 2)}\n`, 'utf8');

  const deadline = Date.now() + 4000;
  while (seen.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(seen.length >= 1, true, 'an outside edit reaches the UI');
  assert.ok(seen.at(-1).includes('added by hand'));

  unsubscribe();
  store.close();
});

test('11) an id the reader had to invent is written back once, so it can be referenced', async () => {
  // Somebody adds a task by hand with no id. Without this, every read invents a
  // new id for it and clicking its checkbox answers "that task no longer
  // exists"; the row is visible and dead.
  const { file } = tempFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    lists: [{ id: 'L1', name: 'Mine' }],
    tasks: [{ listId: 'L1', title: 'added by hand, no id' }],
  }));

  const store = storeOn(file);
  const first = await store.read();
  const id = first.doc.tasks[0].id;
  assert.ok(id, 'the reader invented one');

  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(persisted.tasks[0].id, id, 'and wrote it down');

  const again = await store.read();
  assert.equal(again.doc.tasks[0].id, id, 'so the next read agrees');

  const ticked = await store.mutate({ type: 'task.setDone', taskId: id });
  assert.equal(ticked.ok, true, ticked.reason);
  assert.equal(ticked.doc.tasks[0].done, true);
  store.close();
});

test('12) a fresh install can rename its starter list before anything has been written', async () => {
  const { file } = tempFile();
  const store = storeOn(file);
  const { doc } = await store.read();
  const listId = doc.lists[0].id;
  assert.equal(fs.existsSync(file), false, 'still nothing on disk');

  const renamed = await store.mutate({ type: 'list.rename', listId, name: 'Personal' });
  assert.equal(renamed.ok, true, renamed.reason);
  assert.equal(renamed.doc.lists[0].name, 'Personal');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).lists[0].name, 'Personal');
  store.close();
});

test('10) the file on disk is plain readable JSON a human or a script can edit', async () => {
  const { file } = tempFile();
  const store = storeOn(file);
  const seeded = await addTask(store, 'Renew the equipment lease');
  await store.mutate({
    type: 'task.update',
    taskId: seeded.taskId,
    patch: { dueDate: '2026-08-15', starred: true, tags: ['work'], notes: 'ask Alex first' },
  });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\n {2}"lists": \[/, 'indented, not minified');
  assert.match(text, /"title": "Renew the equipment lease"/);
  assert.match(text, /"dueDate": "2026-08-15"/, 'a due date is a plain calendar day, not an epoch');
  assert.equal(text.endsWith('\n'), true, 'trailing newline, like every other file a human edits');
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.tasks[0].tags, ['work']);
  store.close();
});
