'use strict';
// The notes and tasks stores hand a based edit's outcome back to the views
// (2026-11-27, docs/BACKLOG.md "Notes sync"): merged, kept as its own note or
// task (conflictCopyId), or refused for a strict writer, through the real
// file, lock and reducer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { createNoteStore } = require('../../src/main/providers/notes.js');
const { createTaskStore } = require('../../src/main/providers/tasks.js');

const QUIET = { error() {}, warn() {}, log() {} };

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), `harbor-${name}-base-`));
  return { file: path.join(dir, `${name}.json`), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the notes store reports a merge, a conflicting copy and a strict refusal', async (t) => {
  const { file, done } = scratch('notes');
  t.after(done);
  const store = createNoteStore({ file, logger: QUIET });
  t.after(() => store.close?.());
  const added = await store.mutate({ type: 'note.add', title: 'Board', body: 'a\nb\nc\nd' });
  const id = added.noteId;
  await store.mutate({ type: 'note.update', noteId: id, patch: { body: 'a\nb\nc\nD' } });

  const merged = await store.mutate({ type: 'note.update', noteId: id, patch: { body: 'A\nb\nc\nd' }, base: { body: 'a\nb\nc\nd' } });
  assert.equal(merged.ok, true);
  assert.equal(merged.merged, true);
  assert.equal(merged.doc.notes.find((n) => n.id === id).body, 'A\nb\nc\nD');

  const copied = await store.mutate({ type: 'note.update', noteId: id, patch: { body: 'A\nb\nc\nMINE' }, base: { body: 'A\nb\nc\nd' } });
  assert.equal(copied.ok, true);
  assert.ok(copied.conflictCopyId);
  assert.deepEqual(copied.conflictFields, ['body']);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.notes.find((n) => n.id === id).body, 'A\nb\nc\nD');
  assert.equal(onDisk.notes.find((n) => n.id === copied.conflictCopyId).body, 'A\nb\nc\nMINE');

  const refused = await store.mutate({ type: 'note.update', noteId: id, patch: { body: 'x' }, base: { body: 'a\nb\nc\nd' }, strict: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict, true);
  assert.deepEqual(refused.conflictFields, ['body']);
});

test('the tasks store reports a merge and a conflicting copy', async (t) => {
  const { file, done } = scratch('tasks');
  t.after(done);
  const store = createTaskStore({ file, logger: QUIET });
  t.after(() => store.close?.());
  const added = await store.mutate({ type: 'task.add', title: 'Call carrier', notes: 'one\ntwo\nthree' });
  const id = added.taskId;
  await store.mutate({ type: 'task.update', taskId: id, patch: { notes: 'one\ntwo\nTHREE' } });
  const merged = await store.mutate({ type: 'task.update', taskId: id, patch: { notes: 'ONE\ntwo\nthree' }, base: { notes: 'one\ntwo\nthree' } });
  assert.equal(merged.ok, true);
  assert.equal(merged.merged, true);
  assert.equal(merged.doc.tasks.find((x) => x.id === id).notes, 'ONE\ntwo\nTHREE');
  const copied = await store.mutate({ type: 'task.update', taskId: id, patch: { notes: 'ONE\ntwo\nmine' }, base: { notes: 'one\ntwo\nthree' } });
  assert.ok(copied.conflictCopyId);
  assert.equal(copied.doc.tasks.find((x) => x.id === id).notes, 'ONE\ntwo\nTHREE');
});
