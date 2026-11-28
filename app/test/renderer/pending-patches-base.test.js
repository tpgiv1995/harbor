'use strict';
// Pending edits carry the value they started from (2026-11-27, docs/BACKLOG.md
// "Notes sync"): the draft store keeps a base per field, persists it beside the
// drafts, sends it with every save, and the notes store merges against it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPendingPatches } = require('../../src/renderer/pending-patches.cjs');
const notes = require('../../src/shared/notes-model.cjs');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    data,
  };
}

test('the base is recorded on a field\'s first change only and travels with the save', async () => {
  const sent = [];
  const edits = createPendingPatches((id, patch, base) => { sent.push({ id, patch, base }); return { ok: true }; });
  edits.queue('n1', { body: 'h' }, { body: '' });
  edits.queue('n1', { body: 'hi' }, { body: 'h' });
  edits.queue('n1', { groupId: 'g2' });
  await edits.flush('n1');
  assert.deepEqual(sent, [{ id: 'n1', patch: { body: 'hi', groupId: 'g2' }, base: { body: '' } }]);
  assert.equal(edits.base('n1'), undefined, 'a saved field forgets its base');
});

test('an edit with no base sends no base, exactly as before', async () => {
  const sent = [];
  const edits = createPendingPatches((id, patch, base) => { sent.push(base); return { ok: true }; });
  edits.queue('t1', { starred: true });
  await edits.flush('t1');
  assert.deepEqual(sent, [undefined]);
});

test('bases are stored beside the drafts and restored with them', () => {
  const storage = memoryStorage();
  const first = createPendingPatches(async () => ({ ok: false, reason: 'offline' }), { storage, key: 'k' });
  first.queue('n1', { body: 'typed' }, { body: 'shown' });
  assert.deepEqual(JSON.parse(storage.getItem('k-base')), { n1: { body: 'shown' } });
  const reopened = createPendingPatches(async () => ({ ok: true }), { storage, key: 'k' });
  assert.deepEqual(reopened.pending('n1'), { body: 'typed' });
  assert.deepEqual(reopened.base('n1'), { body: 'shown' });
});

test('a draft stored before bases existed restores with an unknown (null) base', async () => {
  const storage = memoryStorage({ k: JSON.stringify({ n1: { body: 'Nov 23 draft', title: 'Old' } }) });
  const sent = [];
  const edits = createPendingPatches((id, patch, base) => { sent.push(base); return { ok: true }; }, { storage, key: 'k' });
  assert.deepEqual(edits.base('n1'), { body: null, title: null });
  await edits.flush('n1');
  assert.deepEqual(sent, [{ body: null, title: null }]);
});

test('newer typing pending after a save continues from the value just sent', async () => {
  let release;
  const sent = [];
  const edits = createPendingPatches((id, patch, base) => {
    sent.push({ patch, base });
    return sent.length === 1 ? new Promise((resolve) => { release = resolve; }) : { ok: true };
  });
  edits.queue('n1', { body: 'a' }, { body: '' });
  const flushing = edits.flush('n1');
  await Promise.resolve(); await Promise.resolve();
  edits.queue('n1', { body: 'ab' }, { body: 'a' });
  release({ ok: true });
  await flushing;
  assert.deepEqual(sent, [
    { patch: { body: 'a' }, base: { body: '' } },
    { patch: { body: 'ab' }, base: { body: 'a' } },
  ]);
});

test('discard forgets the base with the draft', () => {
  const storage = memoryStorage();
  const edits = createPendingPatches(async () => ({ ok: true }), { storage, key: 'k' });
  edits.queue('n1', { body: 'x' }, { body: '' });
  edits.discard('n1');
  assert.equal(edits.base('n1'), undefined);
  assert.deepEqual(JSON.parse(storage.getItem('k-base')), {});
});

// The editors pass the value shown JUST BEFORE each change as its base. Drive a
// typing session with autosaves through the real notes reducer, with an edit made
// elsewhere halfway: no save may ever become a conflict, and both edits survive.
// The control run passes the value shown when the note OPENED instead, which is
// the mistake this rule exists to prevent: every save after the first conflicts.
function typingSession({ baseFrom }) {
  let ids = 0;
  const ctx = (now) => ({ now, idFactory: (prefix) => `${prefix}_${++ids}` });
  const start = notes.applyOp(notes.emptyDoc(1), { type: 'note.add', title: 'Board', body: 'intro\n\nstatus: idle' }, ctx(1));
  const id = start.noteId;
  let doc = start.doc;
  let clock = 10;
  const copies = [];
  const edits = createPendingPatches(async (noteId, patch, base) => {
    const result = notes.applyOp(doc, { type: 'note.update', noteId, patch, ...(base ? { base } : {}) }, ctx(clock += 1));
    if (result.ok) doc = result.doc;
    if (result.conflictCopyId) copies.push(result.conflictCopyId);
    return result;
  });
  const opened = doc.notes[0].body;
  let shown = opened;
  const type = async (text, { save } = {}) => {
    const next = shown.replace(/^[^\n]*/, (line) => line + text);
    edits.queue(id, { body: next }, { body: baseFrom === 'shown' ? shown : opened });
    shown = next;
    if (save) await edits.flush(id);
  };
  return { id, edits, type, copies, get doc() { return doc; }, set doc(value) { doc = value; } };
}

test('autosaves while typing never conflict, and an edit made elsewhere survives them', async () => {
  const run = typingSession({ baseFrom: 'shown' });
  await run.type(' h');
  await run.type('e', { save: true });
  run.doc = notes.applyOp(run.doc, { type: 'note.update', noteId: run.id, patch: { body: run.doc.notes[0].body.replace('idle', 'round 8 running') } }, { now: 50 }).doc;
  await run.type('ll', { save: true });
  await run.type('o', { save: true });
  assert.deepEqual(run.copies, []);
  assert.equal(run.doc.notes.find((n) => n.id === run.id).body, 'intro hello\n\nstatus: round 8 running');
});

test('control: a base remembered from when the note opened makes later saves conflict', async () => {
  const run = typingSession({ baseFrom: 'opened' });
  await run.type(' h', { save: true });
  await run.type('e', { save: true });
  assert.equal(run.copies.length, 1, 'the second save already conflicts with the first');
});

test('a restored draft is current while the entity still holds its base, stale once it moved', () => {
  const storage = memoryStorage();
  const first = createPendingPatches(async () => ({ ok: false, reason: 'offline' }), { storage, key: 'k' });
  first.queue('n1', { title: 'Plan v2 ', body: 'typed' }, { title: 'Plan', body: 'saved' });
  first.queue('n1', { groupId: 'g2' });
  const reopened = createPendingPatches(async () => ({ ok: true }), { storage, key: 'k' });
  assert.equal(reopened.stale('n1', { title: 'Plan', body: 'saved', groupId: 'g1' }), false, 'current: show it and save it later');
  assert.equal(reopened.stale('n1', { title: 'Plan', body: 'saved elsewhere since' }), true, 'stale: never show it as the note');
  assert.equal(reopened.stale('n1', { title: 'Plan ', body: 'saved' }), false, 'a title\'s edge spaces do not make it stale');
  assert.equal(reopened.stale('missing', { title: 'x' }), false);
});

test('a draft from before bases existed is current only when it already matches the entity', () => {
  const storage = memoryStorage({ k: JSON.stringify({ n1: { body: 'Nov 23 draft' } }) });
  const edits = createPendingPatches(async () => ({ ok: true }), { storage, key: 'k' });
  assert.equal(edits.stale('n1', { body: 'newer note' }), true);
  assert.equal(edits.stale('n1', { body: 'Nov 23 draft' }), false);
});
