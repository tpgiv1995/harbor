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
  assert.deepEqual(doc.notes[0], {
    id: 'old', title: 'Release plan', body: 'Ship the phone view', tags: ['work'],
    pinned: false, createdAt: 10, updatedAt: 20,
  });
});

test('notes view search matches title and body case-insensitively', () => {
  assert.deepEqual(selectNotes(doc, { query: 'RELEASE' }).map((note) => note.id), ['old']);
  assert.deepEqual(selectNotes(doc, { query: 'oranges' }).map((note) => note.id), ['pin']);
  assert.deepEqual(selectNotes(doc, { query: 'missing' }), []);
});
