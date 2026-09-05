'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../src/shared/notes-model.cjs');

function ids() {
  let value = 0;
  return () => `n${++value}`;
}

test('notes normalize is total and repairs ids, fields, caps, tags, and timestamps', () => {
  const longTitle = `${'t'.repeat(400)}\nmore`;
  const longBody = 'b'.repeat(100100);
  const repaired = model.normalizeDoc({ notes: [
    { id: 'one', title: longTitle, body: longBody, tags: [' Work ', 'work', '', 7], pinned: 1 },
    { id: 'one', title: 'duplicate' },
    { title: null, body: 42, tags: 'wrong', pinned: true, createdAt: 'bad' },
    null,
    'junk',
  ] }, { now: 500, idFactory: ids() });
  assert.equal(repaired.version, 1);
  assert.equal(repaired.notes.length, 2);
  assert.equal(repaired.notes[0].title.length, model.MAX_TITLE);
  assert.equal(repaired.notes[0].body.length, model.MAX_BODY);
  assert.deepEqual(repaired.notes[0].tags, ['Work', '7']);
  assert.equal(repaired.notes[0].pinned, false);
  assert.equal(repaired.notes[1].id, 'n1');
  assert.equal(repaired.notes[1].title, '');
  assert.equal(repaired.notes[1].body, '42');
  assert.equal(repaired.notes[1].createdAt, 500);
  assert.equal(model.mintsIds({ notes: [{ title: 'hand added' }] }), true);
  assert.equal(model.mintsIds(repaired), false);
  for (const junk of [null, undefined, 7, 'bad', [], { notes: 4 }]) {
    assert.deepEqual(model.normalizeDoc(junk).notes, []);
  }
});

test('notes reducer adds, updates, pins, removes, caps content, and never mutates input', () => {
  const original = model.emptyDoc();
  const before = JSON.stringify(original);
  const added = model.applyOp(original, {
    type: 'note.add', title: '', body: 'draft', tags: ['Teams', 'teams'],
  }, { now: 100, idFactory: ids() });
  assert.equal(added.ok, true);
  assert.equal(JSON.stringify(original), before);
  assert.equal(added.noteId, 'n1');
  assert.deepEqual(added.doc.notes[0], {
    id: 'n1', title: '', body: 'draft', tags: ['Teams'], pinned: false,
    createdAt: 100, updatedAt: 100,
  });

  const updated = model.applyOp(added.doc, {
    type: 'note.update', noteId: 'n1', patch: {
      title: 'New title', body: 'x'.repeat(model.MAX_BODY), tags: ['Email'], pinned: true,
    },
  }, { now: 200 });
  assert.equal(updated.doc.notes[0].body.length, model.MAX_BODY);
  assert.equal(updated.doc.notes[0].pinned, true);
  assert.equal(updated.doc.notes[0].updatedAt, 200);

  const unpinned = model.applyOp(updated.doc, { type: 'note.pin', noteId: 'n1', pinned: false }, { now: 300 });
  assert.equal(unpinned.doc.notes[0].pinned, false);
  assert.equal(unpinned.doc.notes[0].updatedAt, 300);

  const removed = model.applyOp(unpinned.doc, { type: 'note.remove', noteId: 'n1' }, { now: 400 });
  assert.equal(removed.removed, 1);
  assert.deepEqual(removed.doc.notes, []);
  assert.deepEqual(model.applyOp(original, { type: 'note.unknown' }), {
    ok: false, reason: 'unknown operation: note.unknown',
  });
  assert.match(model.applyOp(original, null).reason, /unknown operation/);
  assert.match(model.applyOp(original, { type: 'note.pin', noteId: 'gone' }).reason, /no longer exists/);
});

test('notes selector searches title and body and orders pinned then recently updated', () => {
  const doc = { version: 1, notes: [
    { id: 'old', title: 'Email reply', body: 'Budget', pinned: false, createdAt: 1, updatedAt: 10 },
    { id: 'pin-old', title: 'Teams', body: 'Budget status', pinned: true, createdAt: 2, updatedAt: 20 },
    { id: 'pin-new', title: 'Other', body: 'budget followup', pinned: true, createdAt: 3, updatedAt: 30 },
    { id: 'new', title: 'Budget memo', body: '', pinned: false, createdAt: 4, updatedAt: 40 },
  ] };
  assert.deepEqual(model.selectNotes(doc).map((note) => note.id), ['pin-new', 'pin-old', 'new', 'old']);
  assert.deepEqual(model.selectNotes(doc, { query: 'BUDGET' }).map((note) => note.id), ['pin-new', 'pin-old', 'new', 'old']);
  assert.deepEqual(model.selectNotes(doc, { query: 'teams' }).map((note) => note.id), ['pin-old']);
});

test('append composes inside the reducer and refuses what it cannot honor', () => {
  const base = model.applyOp(model.emptyDoc(), { type: 'note.add', title: 'draft', body: 'first line' }, { now: 100, idFactory: ids() }).doc;
  const noteId = base.notes[0].id;
  const appended = model.applyOp(base, { type: 'note.append', noteId, text: 'second line' }, { now: 200 });
  assert.equal(appended.ok, true);
  assert.equal(appended.doc.notes[0].body, 'first line\nsecond line');
  assert.equal(base.notes[0].body, 'first line', 'input doc untouched');
  const ontoEmpty = model.applyOp(model.applyOp(model.emptyDoc(), { type: 'note.add' }, { now: 100, idFactory: ids() }).doc, { type: 'note.append', noteId: 'n1', text: 'only line' }, { now: 200 });
  assert.equal(ontoEmpty.doc.notes[0].body, 'only line', 'no leading newline onto an empty body');
  assert.equal(model.applyOp(base, { type: 'note.append', noteId, text: '' }, { now: 200 }).ok, false);
  assert.equal(model.applyOp(base, { type: 'note.append', noteId: 'missing', text: 'x' }, { now: 200 }).ok, false);
});

test('an oversized body refuses out loud instead of silently truncating', () => {
  const big = 'x'.repeat(model.MAX_BODY + 1);
  const added = model.applyOp(model.emptyDoc(), { type: 'note.add', body: big }, { now: 100, idFactory: ids() });
  assert.equal(added.ok, false);
  assert.match(added.reason, /over/);
  const base = model.applyOp(model.emptyDoc(), { type: 'note.add', body: 'small' }, { now: 100, idFactory: ids() }).doc;
  const patched = model.applyOp(base, { type: 'note.update', noteId: base.notes[0].id, patch: { body: big } }, { now: 200 });
  assert.equal(patched.ok, false);
  const nearCap = model.applyOp(model.emptyDoc(), { type: 'note.add', body: 'y'.repeat(model.MAX_BODY - 2) }, { now: 100, idFactory: ids() }).doc;
  const overflow = model.applyOp(nearCap, { type: 'note.append', noteId: nearCap.notes[0].id, text: 'zzzz' }, { now: 200 });
  assert.equal(overflow.ok, false, 'append refuses rather than passing the cap');
});
