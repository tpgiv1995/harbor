'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPendingPatches } = require('../../src/renderer/pending-patches.cjs');

test('one entity failing in flight does not skip another entity or misattribute its error', async () => {
  let releaseA;
  const writes = [];
  const edits = createPendingPatches((id, patch) => {
    writes.push({ id, patch });
    return id === 'A' ? new Promise(resolve => { releaseA = resolve; }) : { ok: true };
  });
  edits.queue('A', { title: 'Keep A' });
  edits.queue('B', { title: 'Save B' });
  const first = edits.flush('A');
  await Promise.resolve();
  const second = edits.flush('B');
  releaseA({ ok: false, retryable: true, reason: 'A is busy' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, true, 'B must send its own patch despite A failing');
  assert.deepEqual(writes, [{ id: 'A', patch: { title: 'Keep A' } }, { id: 'B', patch: { title: 'Save B' } }]);
  assert.equal(edits.error('A').reason, 'A is busy');
  assert.equal(edits.error('B'), undefined);
  assert.deepEqual(edits.pending('A'), { title: 'Keep A' });
  assert.equal(edits.pending('B'), undefined);
});

test('a failed in-flight field and a newer different field both survive retry', async () => {
  let release, allow = false;
  const saved = [];
  const edits = createPendingPatches((_id, patch) => allow ? (saved.push(patch), { ok: true }) : new Promise(resolve => { release = resolve; }));
  edits.queue('one', { title: 'first' });
  const first = edits.flush('one'); await Promise.resolve();
  edits.queue('one', { body: 'new body' }); release({ ok: false, retryable: true, reason: 'busy' });
  assert.equal((await first).ok, false);
  assert.deepEqual(edits.pending('one'), { title: 'first', body: 'new body' });
  allow = true; assert.equal((await edits.flush('one')).ok, true);
  assert.deepEqual(saved, [{ title: 'first', body: 'new body' }]);
  assert.equal(edits.pending('one'), undefined);
});
test('a successful in-flight save drains newer typing before reporting success', async () => {
  let release; const writes = [];
  const edits = createPendingPatches((_id, patch) => { writes.push(patch); return writes.length === 1 ? new Promise(resolve => { release = resolve; }) : { ok: true }; });
  edits.queue('one', { title: 'first' }); const first = edits.flush('one'); await Promise.resolve();
  edits.queue('one', { title: 'latest', tags: ['new'] }); release({ ok: true });
  assert.equal((await first).ok, true);
  assert.deepEqual(writes, [{ title: 'first' }, { title: 'latest', tags: ['new'] }]);
});
test('reopening retains failed drafts by identity and clears only acknowledged fields', async () => {
  const values = new Map(); const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const edits = createPendingPatches(() => ({ ok: false, retryable: true }), { storage, key: 'test' });
  edits.queue('one', { title: 'retained' }); edits.queue('two', { body: 'separate' }); await edits.flush('one');
  const reopened = createPendingPatches(() => ({ ok: true }), { storage, key: 'test' });
  assert.deepEqual(reopened.pending('one'), { title: 'retained' }); await reopened.flush('one');
  assert.equal(reopened.pending('one'), undefined); assert.deepEqual(reopened.pending('two'), { body: 'separate' });
});
test('concurrent flush callers send one patch, and thrown failures keep its fields', async () => {
  let writes = 0;
  const edits = createPendingPatches(() => { writes++; throw Error('offline'); });
  edits.queue('one', { title: 'retained' });
  const results = await Promise.all([edits.flush('one'), edits.flush('one')]);
  assert.equal(writes, 1); assert.ok(results.every(result => !result.ok));
  assert.deepEqual(edits.pending('one'), { title: 'retained' });
});

// 2026-09-20: the save banner rendered on "has a pending edit", which is true from
// every keystroke until its debounced save lands 400 ms later, so it flashed a
// sentence and a Retry button on each key typed into a note. Attention is for an
// edit that FAILED or is genuinely stuck, never for ordinary typing.
test('ordinary typing never asks for attention; a failure does at once; a stuck edit does after the stall window', async () => {
  let clock = 1_000_000;
  let answer = { ok: true };
  const edits = createPendingPatches(() => answer, { now: () => clock });

  edits.queue('note', { body: 'h' });
  assert.equal(edits.needsAttention('note'), false, 'a keystroke waiting out its debounce is not a problem');
  clock += 300; edits.queue('note', { body: 'he' });
  clock += 3900;
  assert.equal(edits.needsAttention('note'), false, 'the stall window restarts at the LAST change, so steady typing never trips it');
  assert.equal((await edits.flush('note')).ok, true);
  assert.equal(edits.needsAttention('note'), false, 'a saved edit needs nothing');

  answer = { ok: false, reason: 'the file is locked' };
  edits.queue('note', { body: 'hel' });
  assert.equal((await edits.flush('note')).ok, false);
  assert.equal(edits.needsAttention('note'), true, 'a refused save is shown immediately, with its reason');
  assert.equal(edits.error('note').reason, 'the file is locked');

  const stuck = createPendingPatches(() => new Promise(() => {}), { now: () => clock });
  stuck.queue('task', { title: 'never acknowledged' });
  assert.equal(stuck.needsAttention('task'), false);
  clock += stuck.STALLED_MS;
  assert.equal(stuck.needsAttention('task'), true, 'an edit still unsaved long after the last change is stuck and must be visible');
  assert.equal(stuck.needsAttention('nothing-pending'), false);
});

test('an edit restored from storage at startup is stuck by definition once the window passes', () => {
  let clock = 5_000;
  const storage = { getItem: () => JSON.stringify({ old: { body: 'left over from a crash' } }), setItem() {} };
  const edits = createPendingPatches(() => ({ ok: true }), { storage, key: 'k', now: () => clock });
  assert.equal(edits.needsAttention('old'), false, 'the editor gets the window to flush it first');
  clock += edits.STALLED_MS;
  assert.equal(edits.needsAttention('old'), true);
});
