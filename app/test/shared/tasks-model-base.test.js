'use strict';
// task.update with op.base: the task editor keeps unsaved edits in browser
// storage like the notes editor does, so the same stale-draft overwrite applied
// to a task's title and notes (2026-11-27, docs/BACKLOG.md "Notes sync").
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../src/shared/tasks-model.cjs');

let ids = 0;
const ctx = (now) => ({ now, idFactory: (prefix) => `${prefix}_${++ids}` });
const taskOf = (doc, id) => doc.tasks.find((task) => task.id === id);

function seed(notes) {
  const added = model.applyOp(model.emptyDoc(1), { type: 'task.add', title: 'Call carrier', notes, tags: ['cb'] }, ctx(100));
  const doc = model.applyOp(added.doc, { type: 'task.update', taskId: added.taskId, patch: { notes: `${notes}\nadded elsewhere` } }, ctx(150)).doc;
  return { doc, id: added.taskId };
}

test('a stored task draft on a different line merges with the newer notes', () => {
  const { doc, id } = seed('line one\nline two\nline three');
  const result = model.applyOp(doc, { type: 'task.update', taskId: id, patch: { notes: 'LINE ONE\nline two\nline three' }, base: { notes: 'line one\nline two\nline three' } }, ctx(200));
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(taskOf(result.doc, id).notes, 'LINE ONE\nline two\nline three\nadded elsewhere');
});

test('a conflicting task draft is kept as its own task, the task keeps its newer notes', () => {
  const { doc, id } = seed('one\ntwo');
  const result = model.applyOp(doc, { type: 'task.update', taskId: id, patch: { notes: 'one\ntwo\nmine at the end' }, base: { notes: 'one\ntwo' } }, ctx(200));
  assert.equal(result.ok, true);
  assert.equal(taskOf(result.doc, id).notes, 'one\ntwo\nadded elsewhere');
  const copy = taskOf(result.doc, result.conflictCopyId);
  assert.equal(copy.title, 'Call carrier (conflicting copy)');
  assert.equal(copy.notes, 'one\ntwo\nmine at the end');
  assert.equal(copy.listId, taskOf(result.doc, id).listId);
});

test('a based edit that changes nothing does not touch updatedAt', () => {
  const { doc, id } = seed('a');
  const result = model.applyOp(doc, { type: 'task.update', taskId: id, patch: { notes: 'a' }, base: { notes: 'a' } }, ctx(200));
  assert.equal(taskOf(result.doc, id).notes, 'a\nadded elsewhere');
  assert.equal(taskOf(result.doc, id).updatedAt, 150);
});

test('single decisions in a based edit (star, due date) still apply as given', () => {
  const { doc, id } = seed('a');
  const result = model.applyOp(doc, { type: 'task.update', taskId: id, patch: { starred: true, notes: 'a' }, base: { notes: 'a' } }, ctx(200));
  assert.equal(taskOf(result.doc, id).starred, true);
  assert.equal(taskOf(result.doc, id).notes, 'a\nadded elsewhere');
});

test('a strict task writer is refused when the task moved, and an empty title is still refused', () => {
  const { doc, id } = seed('a');
  const refused = model.applyOp(doc, { type: 'task.update', taskId: id, patch: { notes: 'b' }, base: { notes: 'a' }, strict: true }, ctx(200));
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict, true);
  const empty = model.applyOp(doc, { type: 'task.update', taskId: id, patch: { title: '  ' }, base: { title: 'Call carrier' } }, ctx(200));
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /needs a name/);
});

test('a task update with no base behaves exactly as before', () => {
  const { doc, id } = seed('a');
  const result = model.applyOp(doc, { type: 'task.update', taskId: id, patch: { notes: 'replaced' } }, ctx(200));
  assert.equal(taskOf(result.doc, id).notes, 'replaced');
  assert.equal(taskOf(result.doc, id).updatedAt, 200);
});
