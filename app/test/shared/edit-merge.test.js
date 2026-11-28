'use strict';
// The three-way merge every based note and task edit goes through (2026-11-27,
// docs/BACKLOG.md "Notes sync"). The rule under test: an edit made elsewhere is
// never lost; when two edits cannot both be kept the merge says so instead of
// picking one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeText, mergeValue, mergeSet, MAX_CELLS } = require('../../src/shared/edit-merge.cjs');

const doc = (...rows) => rows.join('\n');

test('edits on different lines both survive', () => {
  const base = doc('# Questions', 'Q1: which carrier?', 'Your answer:', '', 'Q2: when?', 'Your answer:');
  const mine = doc('# Questions', 'Q1: which carrier?', 'Your answer: Carrier A', '', 'Q2: when?', 'Your answer:');
  const theirs = doc('# Questions', 'Q1: which carrier?', 'Your answer:', '', 'Q2: when?', 'Your answer:', '', 'Q3: new question');
  const result = mergeText(base, mine, theirs);
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(result.text, doc('# Questions', 'Q1: which carrier?', 'Your answer: Carrier A', '', 'Q2: when?', 'Your answer:', '', 'Q3: new question'));
});

test('one side unchanged: the other side wins outright, no merge needed', () => {
  assert.deepEqual(mergeText('a\nb', 'a\nb', 'a\nB'), { ok: true, text: 'a\nB', merged: false });
  assert.deepEqual(mergeText('a\nb', 'A\nb', 'a\nb'), { ok: true, text: 'A\nb', merged: false });
  assert.deepEqual(mergeText('a\nb', 'x', 'x'), { ok: true, text: 'x', merged: false });
});

test('two different edits of the same line are a conflict, never a pick', () => {
  assert.deepEqual(mergeText('a\nb\nc', 'a\nMINE\nc', 'a\nTHEIRS\nc'), { ok: false });
});

test('edits on touching lines are a conflict (no shared line between them, as in git)', () => {
  assert.deepEqual(mergeText('a\nb\nc\nd', 'a\nB\nc\nd', 'a\nb\nC\nd'), { ok: false });
  // both sides appending at the very end touch at the same point
  assert.deepEqual(mergeText('a\nb', 'a\nb\nmine', 'a\nb\ntheirs'), { ok: false });
});

test('the identical change made on both sides merges cleanly', () => {
  const result = mergeText('a\nb\nc\nd\ne', 'a\nB\nc\nd\nE', 'a\nB\nc\nd\ne');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'a\nB\nc\nd\nE');
});

test('typing that continues an already-merged save stays clean against the merged text', () => {
  // first save: mine1 merged with theirs; the store holds that merge
  const base0 = doc('one', 'two', 'three', 'four', 'five');
  const mine1 = doc('one hel', 'two', 'three', 'four', 'five');
  const theirs = doc('one', 'two', 'three', 'four', 'FIVE');
  const stored = mergeText(base0, mine1, theirs);
  assert.equal(stored.text, doc('one hel', 'two', 'three', 'four', 'FIVE'));
  // the next save's base is the value just sent (pending-patches.cjs), the typing goes on
  const mine2 = doc('one hello', 'two', 'three', 'four', 'five');
  const next = mergeText(mine1, mine2, stored.text);
  assert.equal(next.ok, true);
  assert.equal(next.text, doc('one hello', 'two', 'three', 'four', 'FIVE'));
});

test('an unknown base (a draft stored before bases existed) merges only when already equal', () => {
  assert.deepEqual(mergeText(null, 'same', 'same'), { ok: true, text: 'same', merged: false });
  assert.deepEqual(mergeText(null, 'old draft', 'newer note'), { ok: false });
  assert.deepEqual(mergeValue(undefined, 'a', 'b'), { ok: false });
  assert.deepEqual(mergeSet(null, ['a'], ['b']), { ok: false });
});

test('a text too large to diff is a conflict, so the caller keeps both versions', () => {
  const rows = Math.ceil(Math.sqrt(MAX_CELLS)) + 10;
  const base = Array.from({ length: rows }, (_, i) => `base ${i}`).join('\n');
  const mine = Array.from({ length: rows }, (_, i) => `mine ${i}`).join('\n');
  const theirs = Array.from({ length: rows }, (_, i) => `theirs ${i}`).join('\n');
  assert.deepEqual(mergeText(base, mine, theirs), { ok: false });
});

test('a title (single value) keeps whichever side changed it, and conflicts when both did', () => {
  assert.deepEqual(mergeValue('Plan', 'Plan v2', 'Plan'), { ok: true, value: 'Plan v2', merged: false });
  assert.deepEqual(mergeValue('Plan', 'Plan', 'Plan (agent)'), { ok: true, value: 'Plan (agent)', merged: false });
  assert.deepEqual(mergeValue('Plan', 'Mine', 'Theirs'), { ok: false });
});

test('tags merge as a set: my additions and removals land on top of theirs', () => {
  const key = (tag) => tag.toLowerCase();
  const result = mergeSet(['work', 'cb'], ['work', 'urgent'], ['Work', 'cb', 'board'], key);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, ['Work', 'board', 'urgent']);
});
