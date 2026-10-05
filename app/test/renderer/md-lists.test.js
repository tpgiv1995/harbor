'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { continuesListRun, isListItemLine } = require('../../src/renderer/stage/md-lists.cjs');

// The Pat screenshot shape (2026-08-30): every item written "1." with a blank
// line between items. One list, numbered 1..N, is the only honest rendering;
// the blank must not end the run.
test('a blank line between two lazy-numbered items keeps the run open', () => {
  const lines = ['1. **Every bot reply** is fresh', '', '1. **Access is broad.** For you'];
  assert.equal(continuesListRun(lines, 1), true);
});

test('several consecutive blank lines between items still keep the run open', () => {
  const lines = ['- alpha', '', '', '- beta'];
  assert.equal(continuesListRun(lines, 1), true);
  assert.equal(continuesListRun(lines, 2), true);
});

test('a blank line before prose ends the run', () => {
  const lines = ['1. alpha', '', 'And then a closing paragraph.'];
  assert.equal(continuesListRun(lines, 1), false);
});

test('a blank line before a heading ends the run', () => {
  const lines = ['1. alpha', '', '# What I verified'];
  assert.equal(continuesListRun(lines, 1), false);
});

test('a blank line at the end of the segment ends the run', () => {
  const lines = ['1. alpha', ''];
  assert.equal(continuesListRun(lines, 1), false);
});

test('item shapes: bullets, dots, parens, unicode bullet; not bare numbers', () => {
  assert.equal(isListItemLine('- x'), true);
  assert.equal(isListItemLine('* x'), true);
  assert.equal(isListItemLine('• x'), true);
  assert.equal(isListItemLine('12. x'), true);
  assert.equal(isListItemLine('3) x'), true);
  assert.equal(isListItemLine('  2. indented item'), true);
  assert.equal(isListItemLine('2024 was a year'), false);
  assert.equal(isListItemLine('plain prose'), false);
});
