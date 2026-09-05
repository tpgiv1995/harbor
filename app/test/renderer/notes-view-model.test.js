'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../src/renderer/notes/notes-view-model.cjs');

test('displayTitle prefers a title and derives an untitled note from its body', () => {
  assert.equal(model.displayTitle({ title: ' Named ', body: 'ignored' }), 'Named');
  assert.equal(model.displayTitle({ body: '\n\nFirst useful line\nSecond' }), 'First useful line');
  assert.equal(model.displayTitle({ body: '' }), 'Untitled note');
  assert.equal(model.displayTitle({ body: 'x'.repeat(80) }).length, 60);
});

test('listRows delegates search and pinned ordering to selectNotes', () => {
  const doc = { version: 1, notes: [
    { id: 'old', title: 'Alpha', body: '', pinned: false, tags: [], createdAt: 1, updatedAt: 1 },
    { id: 'pin', title: 'Alpha pinned', body: '', pinned: true, tags: [], createdAt: 2, updatedAt: 2 },
    { id: 'new', title: 'Beta', body: '', pinned: false, tags: [], createdAt: 3, updatedAt: 3 },
  ] };
  assert.deepEqual(model.listRows(doc).map((note) => note.id), ['pin', 'new', 'old']);
  assert.deepEqual(model.listRows(doc, { query: 'alpha' }).map((note) => note.id), ['pin', 'old']);
});

test('copyPayload produces rich HTML and a plain text fallback', () => {
  const payload = model.copyPayload({ body: '- first\n- **bold**' });
  // The exporter styles every block inline for the Word paste target
  // (markdown-html.cjs), so the list opens with its style attribute.
  assert.match(payload.html, /<ul\b/);
  assert.match(payload.html, /<strong>bold<\/strong>/);
  assert.equal(payload.text, '- first\n- bold');
});
