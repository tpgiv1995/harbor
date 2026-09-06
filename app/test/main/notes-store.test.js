'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { createNoteStore, resolveNotesFile } = require('../../src/main/providers/notes.js');

const QUIET = { error() {}, warn() {}, log() {} };

function tempFile() {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-notes-test-'));
  return { dir, file: path.join(dir, 'notes.json') };
}

test('notes file resolution honors env, configured path, then Electron userData', () => {
  const app = { getPath: () => '/real/userData' };
  assert.equal(resolveNotesFile({ env: { HARBOR_NOTES_FILE: '/tmp/n.json' }, configuredFile: '/configured/n.json', app }), path.resolve('/tmp/n.json'));
  assert.equal(resolveNotesFile({ env: {}, configuredFile: '/configured/n.json', app }), path.resolve('/configured/n.json'));
  assert.equal(resolveNotesFile({ env: {}, app }), path.join('/real/userData', 'notes.json'));
});

test('notes writes atomically with trailing newline, backup, and no temporary file', async () => {
  const { dir, file } = tempFile();
  const store = createNoteStore({ file, logger: QUIET });
  await store.mutate({ type: 'note.add', title: 'One', body: 'first' });
  await store.mutate({ type: 'note.add', title: 'Two', body: 'second' });
  assert.equal(fs.readFileSync(file, 'utf8').endsWith('\n'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).notes.map((note) => note.title), ['One', 'Two']);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).notes.map((note) => note.title), ['One']);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), []);
  store.close();
});

test('notes corrupt input is quarantined, reported, restored from backup, and never overwritten', async () => {
  const { dir, file } = tempFile();
  const store = createNoteStore({ file, logger: QUIET });
  await store.mutate({ type: 'note.add', title: 'Survivor' });
  await store.mutate({ type: 'note.add', title: 'Later' });
  store.close();
  fs.writeFileSync(file, '{broken notes');

  const reopened = createNoteStore({ file, logger: QUIET });
  const result = await reopened.read();
  assert.equal(result.recovery.kind, 'restored-backup');
  assert.deepEqual(result.doc.notes.map((note) => note.title), ['Survivor']);
  assert.equal(fs.existsSync(file), false);
  assert.match(fs.readFileSync(result.recovery.detail, 'utf8'), /broken notes/);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-')).length, 1);
  reopened.close();
});

test('notes outside edits reach subscribers while self writes are suppressed', async () => {
  const { file } = tempFile();
  const store = createNoteStore({ file, logger: QUIET });
  await store.mutate({ type: 'note.add', title: 'Inside' });
  const seen = [];
  const unsubscribe = store.subscribe((doc) => seen.push(doc.notes.map((note) => note.title)));
  await store.mutate({ type: 'note.add', title: 'Still inside' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(seen, []);

  const outside = JSON.parse(fs.readFileSync(file, 'utf8'));
  outside.notes.push({ id: 'outside', title: 'Outside', body: '', tags: [], pinned: false, createdAt: 1, updatedAt: 1 });
  await fsp.writeFile(file, `${JSON.stringify(outside, null, 2)}\n`);
  const deadline = Date.now() + 4000;
  while (!seen.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(seen.at(-1).includes('Outside'));
  unsubscribe();
  store.close();
});

test('notes persist an id repaired during read so the next mutation can address it', async () => {
  const { file } = tempFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1, notes: [{ title: 'Hand added', body: 'draft' }] }));
  const store = createNoteStore({ file, logger: QUIET });
  const first = await store.read();
  const id = first.doc.notes[0].id;
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).notes[0].id, id);
  const updated = await store.mutate({ type: 'note.update', noteId: id, patch: { body: 'saved' } });
  assert.equal(updated.ok, true, updated.reason);
  assert.equal(updated.doc.notes[0].body, 'saved');
  store.close();
});

// A file the store cannot READ is not a file it may write: with a transient
// EPERM/EBUSY (or this spec's EISDIR stand-in) the load falls back to an
// almost-empty doc, and saving a mutation on top of that would rename it over
// every note on disk (caught in review, 2026-08-25).
test('a mutate refuses to save over a file the store could not read', async () => {
  const { file } = tempFile();
  fs.mkdirSync(file); // notes.json IS a directory: reads fail, nothing parses
  const store = createNoteStore({ file, logger: QUIET });
  const result = await store.mutate({ type: 'note.add', title: 'must not land' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be read/);
  assert.equal(fs.statSync(file).isDirectory(), true, 'the unreadable target is untouched');
  store.close();
});
