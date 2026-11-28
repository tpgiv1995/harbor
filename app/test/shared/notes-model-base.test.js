'use strict';
// note.update with op.base (2026-11-27, Pat: "I keep having mobile harbor
// overwrite harbor notes"; docs/BACKLOG.md "Notes sync"). The two incidents of
// 2026-11-25 on an agent's board note, replayed against the reducer:
// a draft the phone stored on Nov 23 wrote itself over the live note, and a
// phone that saved the whole body it had loaded dropped an edit made meanwhile.
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../src/shared/notes-model.cjs');

let ids = 0;
const ctx = (now) => ({ now, idFactory: (prefix) => `${prefix}_${++ids}` });

function seed(body, title = 'Board') {
  const added = model.applyOp(model.emptyDoc(1), { type: 'note.add', title, body, tags: ['cb'] }, ctx(100));
  return { doc: added.doc, id: added.noteId };
}
const noteOf = (doc, id) => doc.notes.find((note) => note.id === id);

const NOV23 = '# Questions\nQ1: old question\nYour answer: old';
const LIVE = '# Questions\nQ7: new question from the agent\nYour answer:\n\n## Status\nRelease went out';

test('a stale draft stored on the phone never overwrites the newer note', () => {
  // the draft was typed against the Nov 23 text; the note has moved on since
  const { doc, id } = seed(LIVE);
  const draft = '# Questions\nQ1: old question\nYour answer: old, edited on the phone';
  const result = model.applyOp(doc, { type: 'note.update', noteId: id, patch: { body: draft }, base: { body: NOV23 } }, ctx(200));
  assert.equal(result.ok, true);
  assert.equal(noteOf(result.doc, id).body, LIVE, 'the live note keeps its newer text');
  const copy = noteOf(result.doc, result.conflictCopyId);
  assert.ok(copy, 'the draft is kept as its own note');
  assert.equal(copy.body, draft);
  assert.equal(copy.title, 'Board (conflicting copy)');
  assert.deepEqual(result.conflictFields, ['body']);
  assert.match(model.conflictNotice(result), /saved as its own note: “Board \(conflicting copy\)”/);
});

test('a draft from before bases existed (base unknown) never overwrites either', () => {
  const { doc, id } = seed(LIVE);
  const result = model.applyOp(doc, { type: 'note.update', noteId: id, patch: { body: NOV23 }, base: { body: null } }, ctx(200));
  assert.equal(noteOf(result.doc, id).body, LIVE);
  assert.equal(noteOf(result.doc, result.conflictCopyId).body, NOV23);
});

test('closing the phone editor without typing leaves an edit made meanwhile alone', () => {
  const loaded = '# Questions\nQ7: new question from the agent\nYour answer:';
  const { doc: start, id } = seed(loaded);
  const elsewhere = model.applyOp(start, { type: 'note.update', noteId: id, patch: { body: `${loaded}\n\nQ8: added at 17:52` } }, ctx(150)).doc;
  const result = model.applyOp(elsewhere, { type: 'note.update', noteId: id, patch: { body: loaded }, base: { body: loaded } }, ctx(200));
  assert.equal(result.ok, true);
  assert.equal(noteOf(result.doc, id).body, `${loaded}\n\nQ8: added at 17:52`);
  assert.equal(noteOf(result.doc, id).updatedAt, 150, 'nothing changed, so the note is not bumped');
  assert.equal(result.conflictCopyId, undefined);
});

test('answers typed on the phone merge with an edit made elsewhere while it was open (the 17:54Z loss)', () => {
  const loaded = '# Questions\nQ7: which carrier?\nYour answer:\n\n## Status\nrunning';
  const { doc: start, id } = seed(loaded);
  const agent = '# Questions\nQ7: which carrier?\nYour answer:\n\n## Status\nrunning\nround 8 started 17:52';
  const elsewhere = model.applyOp(start, { type: 'note.update', noteId: id, patch: { body: agent } }, ctx(150)).doc;
  const typed = '# Questions\nQ7: which carrier?\nYour answer: Carrier A\n\n## Status\nrunning';
  const result = model.applyOp(elsewhere, { type: 'note.update', noteId: id, patch: { body: typed }, base: { body: loaded } }, ctx(200));
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(noteOf(result.doc, id).body, '# Questions\nQ7: which carrier?\nYour answer: Carrier A\n\n## Status\nrunning\nround 8 started 17:52');
});

test('ordinary typing on a current note still saves exactly what was typed', () => {
  const { doc, id } = seed('hello');
  const result = model.applyOp(doc, { type: 'note.update', noteId: id, patch: { title: 'Board v2', body: 'hello world', tags: ['cb', 'live'] }, base: { title: 'Board', body: 'hello', tags: ['cb'] } }, ctx(200));
  const note = noteOf(result.doc, id);
  assert.equal(note.title, 'Board v2');
  assert.equal(note.body, 'hello world');
  assert.deepEqual(note.tags, ['cb', 'live']);
  assert.equal(note.updatedAt, 200);
  assert.equal(result.merged, false);
});

test('a strict writer (an agent tool) is refused instead of merged when the note moved', () => {
  const { doc: start, id } = seed('a\nb\nc\nd');
  const moved = model.applyOp(start, { type: 'note.update', noteId: id, patch: { body: 'a\nb\nc\nD' } }, ctx(150)).doc;
  const refused = model.applyOp(moved, { type: 'note.update', noteId: id, patch: { body: 'A\nb\nc\nd' }, base: { body: 'a\nb\nc\nd' }, strict: true }, ctx(200));
  assert.equal(refused.ok, false);
  assert.equal(refused.conflict, true);
  assert.deepEqual(refused.conflictFields, ['body']);
  const fine = model.applyOp(moved, { type: 'note.update', noteId: id, patch: { body: 'A\nb\nc\nD' }, base: { body: 'a\nb\nc\nD' }, strict: true }, ctx(200));
  assert.equal(fine.ok, true);
  assert.equal(noteOf(fine.doc, id).body, 'A\nb\nc\nD');
});

test('an update with no base behaves exactly as before (the CLI, older clients)', () => {
  const { doc, id } = seed('old');
  const result = model.applyOp(doc, { type: 'note.update', noteId: id, patch: { body: 'replaced' } }, ctx(200));
  assert.equal(noteOf(result.doc, id).body, 'replaced');
  assert.equal(noteOf(result.doc, id).updatedAt, 200);
  assert.equal(result.merged, undefined);
});

test('a group move or pin in a based edit still applies when the text conflicts', () => {
  const added = model.applyOp(model.emptyDoc(1), { type: 'group.add', name: 'Archive' }, ctx(50));
  const { doc: start, id } = (() => {
    const note = model.applyOp(added.doc, { type: 'note.add', title: 'Board', body: 'x', tags: [] }, ctx(100));
    return { doc: note.doc, id: note.noteId };
  })();
  const moved = model.applyOp(start, { type: 'note.update', noteId: id, patch: { body: 'theirs' } }, ctx(150)).doc;
  const result = model.applyOp(moved, { type: 'note.update', noteId: id, patch: { body: 'mine', groupId: added.groupId }, base: { body: 'x' } }, ctx(200));
  assert.equal(noteOf(result.doc, id).groupId, added.groupId);
  assert.equal(noteOf(result.doc, id).body, 'theirs');
  assert.equal(noteOf(result.doc, result.conflictCopyId).groupId, added.groupId);
});
