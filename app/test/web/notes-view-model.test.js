'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDoc, selectNotes } = require('../../src/shared/notes-model.cjs');

const doc = normalizeDoc({
  version: 1,
  notes: [
    { id: 'old', title: 'Release plan', body: 'Ship the phone view', tags: ['work'], pinned: false, createdAt: 10, updatedAt: 20 },
    { id: 'pin', title: 'Groceries', body: 'Coffee and oranges', tags: ['home'], pinned: true, createdAt: 5, updatedAt: 6 },
    { id: 'new', title: 'Ideas', body: 'A harbor at night', tags: [], pinned: false, createdAt: 30, updatedAt: 40 },
  ],
}, { now: 50 });

test('notes view selection uses normalized shared-model shape and pinned-first ordering', () => {
  assert.deepEqual(selectNotes(doc).map((note) => note.id), ['pin', 'new', 'old']);
  // The normalized shape carries the note's group since desktop Notes grew
  // groups: a doc with no groups is seeded with one, and every note lands in it.
  // The phone view draws a flat list and never reads groupId, and its edits are
  // patches (note.update only touches groupId when the patch names it), so a
  // phone edit cannot reset a group the desktop assigned. This spec asserted the
  // pre-groups shape and failed only on the MERGE of the two streams, where
  // neither branch alone could see it (hosted CI, 2026-09-19).
  assert.deepEqual(doc.notes[0], {
    id: 'old', groupId: 'group-default', title: 'Release plan', body: 'Ship the phone view', tags: ['work'],
    pinned: false, createdAt: 10, updatedAt: 20,
  });
});

test('notes view search matches title and body case-insensitively', () => {
  assert.deepEqual(selectNotes(doc, { query: 'RELEASE' }).map((note) => note.id), ['old']);
  assert.deepEqual(selectNotes(doc, { query: 'oranges' }).map((note) => note.id), ['pin']);
  assert.deepEqual(selectNotes(doc, { query: 'missing' }), []);
});
