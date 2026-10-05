'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../src/shared/notes-model.cjs');

function ids() {
  let value = 0;
  return () => `n${++value}`;
}

// Prefix-aware, for the group tests: idFactory('g') -> g1, idFactory('n') -> n1.
function seq() {
  let value = 0;
  return (prefix = 'n') => `${prefix}${++value}`;
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
    id: 'n1', groupId: 'group-default', title: '', body: 'draft', tags: ['Teams'], pinned: false,
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

test('notes seed a default group and land every note in a real group', () => {
  const empty = model.emptyDoc(500);
  assert.deepEqual(empty.groups, [{
    id: model.DEFAULT_GROUP_ID, name: model.DEFAULT_GROUP_NAME, color: null, createdAt: 500, order: 0,
  }]);
  // A missing or unknown groupId falls back to the first group, so nothing is
  // ever orphaned.
  const repaired = model.normalizeDoc({
    groups: [{ id: 'g-work', name: 'Work', order: 0 }],
    notes: [
      { id: 'a', title: 'in group', groupId: 'g-work' },
      { id: 'b', title: 'unknown group', groupId: 'nope' },
      { id: 'c', title: 'no group' },
    ],
  }, { now: 1 });
  assert.equal(repaired.groups.length, 1);
  assert.equal(repaired.groups[0].color, null);
  assert.equal(repaired.notes.find((n) => n.id === 'a').groupId, 'g-work');
  assert.equal(repaired.notes.find((n) => n.id === 'b').groupId, 'g-work');
  assert.equal(repaired.notes.find((n) => n.id === 'c').groupId, 'g-work');
  assert.equal(model.mintsIds({ groups: [{ name: 'hand added group' }] }), true);
});

test('group ops add, rename, recolour, and refuse a bad colour or the last group', () => {
  const base = model.emptyDoc(0);
  const added = model.applyOp(base, { type: 'group.add', name: '  Teams replies  ', color: '4EC9B6' }, { now: 10, idFactory: seq() });
  assert.equal(added.ok, true);
  assert.equal(added.groupId, 'g1');
  const group = added.doc.groups.find((g) => g.id === 'g1');
  assert.equal(group.name, 'Teams replies');
  assert.equal(group.color, '#4ec9b6');
  assert.equal(added.doc.groups.length, 2);

  assert.equal(model.applyOp(base, { type: 'group.add', name: '   ' }).ok, false);

  const renamed = model.applyOp(added.doc, { type: 'group.rename', groupId: 'g1', name: 'Outlook' }, { now: 20 });
  assert.equal(renamed.doc.groups.find((g) => g.id === 'g1').name, 'Outlook');
  assert.match(model.applyOp(added.doc, { type: 'group.rename', groupId: 'gone', name: 'x' }).reason, /no longer exists/);

  assert.equal(model.applyOp(added.doc, { type: 'group.color', groupId: 'g1', color: 'not-a-color' }).ok, false);
  const cleared = model.applyOp(added.doc, { type: 'group.color', groupId: 'g1', color: null });
  assert.equal(cleared.doc.groups.find((g) => g.id === 'g1').color, null);

  // The last group cannot be deleted; rename it instead.
  assert.match(model.applyOp(base, { type: 'group.remove', groupId: model.DEFAULT_GROUP_ID }).reason, /only group/);
});

test('deleting a group reassigns its notes to the first remaining group, never deletes them', () => {
  let doc = model.emptyDoc(0);
  doc = model.applyOp(doc, { type: 'group.add', name: 'Personal' }, { now: 1, idFactory: seq() }).doc;
  const personal = doc.groups.find((g) => g.name === 'Personal').id;
  doc = model.applyOp(doc, { type: 'note.add', title: 'keep me', groupId: personal }, { now: 2, idFactory: seq() }).doc;
  const noteId = doc.notes[0].id;
  const removed = model.applyOp(doc, { type: 'group.remove', groupId: personal }, { now: 3 });
  assert.equal(removed.ok, true);
  assert.equal(removed.movedNotes, 1);
  assert.equal(removed.doc.groups.some((g) => g.id === personal), false);
  const survivor = removed.doc.notes.find((n) => n.id === noteId);
  assert.ok(survivor, 'the note survives its group');
  assert.equal(survivor.groupId, model.DEFAULT_GROUP_ID);
  // The reassigned note keeps its updatedAt (a group move is not a content edit).
  assert.equal(survivor.updatedAt, 2);
});

test('note.add honors a group, and note.update moves a note or refuses an unknown group', () => {
  let doc = model.emptyDoc(0);
  doc = model.applyOp(doc, { type: 'group.add', name: 'Work' }, { now: 1, idFactory: seq() }).doc;
  const work = doc.groups.find((g) => g.name === 'Work').id;
  const added = model.applyOp(doc, { type: 'note.add', title: 'task', groupId: work }, { now: 2, idFactory: seq() });
  assert.equal(added.doc.notes[0].groupId, work);
  // An unknown groupId on add is tolerant: it lands in the first group.
  const tolerant = model.applyOp(doc, { type: 'note.add', title: 'stray', groupId: 'nope' }, { now: 2, idFactory: seq() });
  assert.equal(tolerant.doc.notes[0].groupId, model.DEFAULT_GROUP_ID);
  // A move is explicit: an unknown target fails out loud.
  const noteId = added.doc.notes[0].id;
  assert.match(model.applyOp(added.doc, { type: 'note.update', noteId, patch: { groupId: 'nope' } }).reason, /no longer exists/);
  const moved = model.applyOp(added.doc, { type: 'note.update', noteId, patch: { groupId: model.DEFAULT_GROUP_ID } }, { now: 3 });
  assert.equal(moved.doc.notes[0].groupId, model.DEFAULT_GROUP_ID);
});

test('notes selectors filter by group and topic and index both', () => {
  const doc = model.normalizeDoc({
    groups: [
      { id: 'g-teams', name: 'Teams', order: 0 },
      { id: 'g-personal', name: 'Personal', order: 1 },
    ],
    notes: [
      { id: 'a', title: 'Standup', groupId: 'g-teams', tags: ['urgent'], updatedAt: 30 },
      { id: 'b', title: 'Budget', groupId: 'g-teams', tags: ['Urgent', 'finance'], updatedAt: 20 },
      { id: 'c', title: 'Groceries', groupId: 'g-personal', tags: ['errand'], updatedAt: 10 },
    ],
  });
  assert.deepEqual(model.selectNotes(doc, { groupId: 'g-teams' }).map((n) => n.id), ['a', 'b']);
  assert.deepEqual(model.selectNotes(doc, { tag: 'URGENT' }).map((n) => n.id), ['a', 'b']);
  assert.deepEqual(model.selectNotes(doc, { groupId: 'g-personal', tag: 'urgent' }).map((n) => n.id), []);
  assert.deepEqual(model.groupCounts(doc), { 'g-teams': 2, 'g-personal': 1 });
  assert.deepEqual(
    model.tagIndex(doc).map((t) => [t.tag, t.count]),
    [['urgent', 2], ['errand', 1], ['finance', 1]],
  );
});
