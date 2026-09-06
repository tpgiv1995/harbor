'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  MAX_LIST_DEPTH,
  composeKeyVerdict,
  listNormalizationVerdict,
  autoFormatVerdict,
  autoFormatRevertVerdict,
} = require('../../src/renderer/stage/compose-keys.cjs');

const verdict = (overrides) => composeKeyVerdict({
  key: 'x',
  inList: false,
  inEmptyListItem: false,
  listDepth: 0,
  shiftKey: false,
  inPre: false,
  ...overrides,
});

test('Enter submits only outside a list', () => {
  assert.equal(verdict({ key: 'Enter' }), 'submit');
  assert.equal(verdict({ key: 'Enter', inPre: true }), 'submit');
  assert.notEqual(verdict({ key: 'Enter', inList: true }), 'submit');
  assert.notEqual(verdict({ key: 'Enter', shiftKey: true }), 'submit');
});

test('Enter in a non-empty list item starts a native list item and never submits', () => {
  assert.equal(verdict({ key: 'Enter', inList: true }), 'new-list-item');
  assert.notEqual(verdict({ key: 'Enter', inList: true, inEmptyListItem: true }), 'new-list-item');
  assert.notEqual(verdict({ key: 'Enter' }), 'new-list-item');
  assert.notEqual(verdict({ key: 'Enter', inList: true, shiftKey: true }), 'new-list-item');
});

test('Enter in an empty list item exits the list and never submits', () => {
  assert.equal(verdict({ key: 'Enter', inList: true, inEmptyListItem: true }), 'exit-list');
  assert.notEqual(verdict({ key: 'Enter', inList: true }), 'exit-list');
  assert.notEqual(verdict({ key: 'Enter', inEmptyListItem: true }), 'exit-list');
  assert.notEqual(verdict({ key: 'Enter', inList: true, inEmptyListItem: true, shiftKey: true }), 'exit-list');
});

test('Shift+Enter stays a soft break in prose, lists, and preformatted text', () => {
  assert.equal(verdict({ key: 'Enter', shiftKey: true }), 'soft-break');
  assert.equal(verdict({ key: 'Enter', shiftKey: true, inList: true }), 'soft-break');
  assert.equal(verdict({ key: 'Enter', shiftKey: true, inPre: true }), 'soft-break');
  assert.notEqual(verdict({ key: 'Enter' }), 'soft-break');
  assert.notEqual(verdict({ key: 'Tab', shiftKey: true }), 'soft-break');
});

test('Tab indents a list item below the deliberate depth cap', () => {
  // Five levels since 2026-09-03 (Pat: "add ability to go to like 5").
  assert.equal(MAX_LIST_DEPTH, 5);
  for (const listDepth of [1, 2, 3, 4]) {
    assert.equal(verdict({ key: 'Tab', inList: true, listDepth }), 'indent', `depth ${listDepth}`);
  }
  assert.notEqual(verdict({ key: 'Tab', inList: true, listDepth: 5 }), 'indent');
  assert.notEqual(verdict({ key: 'Tab' }), 'indent');
  assert.notEqual(verdict({ key: 'Tab', inList: true, shiftKey: true }), 'indent');
});

test('Tab at the depth cap is swallowed, never handed to the browser', () => {
  // A default Tab leaves the composer for the next control (the mic button),
  // and whatever is typed next lands there.
  assert.equal(verdict({ key: 'Tab', inList: true, listDepth: MAX_LIST_DEPTH }), 'indent-blocked');
  assert.equal(verdict({ key: 'Tab', inList: true, listDepth: MAX_LIST_DEPTH + 1 }), 'indent-blocked');
  assert.notEqual(verdict({ key: 'Tab', inList: true, listDepth: MAX_LIST_DEPTH, shiftKey: true }), 'indent-blocked');
  assert.notEqual(verdict({ key: 'Tab', listDepth: MAX_LIST_DEPTH }), 'indent-blocked');
});

test('Shift+Tab outdents at every list depth and nowhere else', () => {
  assert.equal(verdict({ key: 'Tab', inList: true, shiftKey: true, listDepth: 1 }), 'outdent');
  assert.equal(verdict({ key: 'Tab', inList: true, shiftKey: true, listDepth: 3 }), 'outdent');
  assert.equal(verdict({ key: 'Tab', inList: true, shiftKey: true, listDepth: 5 }), 'outdent');
  assert.notEqual(verdict({ key: 'Tab', shiftKey: true }), 'outdent');
  assert.notEqual(verdict({ key: 'Tab', inList: true }), 'outdent');
  assert.notEqual(verdict({ key: 'Enter', inList: true, shiftKey: true }), 'outdent');
});

test('Tab outside a list and unrelated keys keep their browser default', () => {
  assert.equal(verdict({ key: 'Tab' }), 'default');
  assert.equal(verdict({ key: 'Tab', shiftKey: true }), 'default');
  assert.equal(verdict({ key: 'Escape', inList: true }), 'default');
  assert.notEqual(verdict({ key: 'Enter' }), 'default');
  assert.notEqual(verdict({ key: 'Tab', inList: true, listDepth: MAX_LIST_DEPTH - 1 }), 'default');
});

test('list normalization repairs only a failed indent with a preceding item', () => {
  assert.equal(listNormalizationVerdict({
    direction: 'indent', beforeDepth: 1, afterDepth: 1, canIndent: true,
  }), 'repair-indent');
  assert.equal(listNormalizationVerdict({
    direction: 'indent', beforeDepth: 1, afterDepth: 0, canIndent: true,
  }), 'repair-indent');
  assert.equal(listNormalizationVerdict({
    direction: 'indent', beforeDepth: 1, afterDepth: 2, canIndent: true,
  }), 'keep');
  assert.equal(listNormalizationVerdict({
    direction: 'indent', beforeDepth: 1, afterDepth: 1, canIndent: false,
  }), 'keep');
});

test('list normalization repairs only a failed nested outdent with an outer list', () => {
  assert.equal(listNormalizationVerdict({
    direction: 'outdent', beforeDepth: 2, afterDepth: 2, canOutdent: true,
  }), 'repair-outdent');
  assert.equal(listNormalizationVerdict({
    direction: 'outdent', beforeDepth: 2, afterDepth: 0, canOutdent: true,
  }), 'repair-outdent');
  assert.equal(listNormalizationVerdict({
    direction: 'outdent', beforeDepth: 2, afterDepth: 1, canOutdent: true,
  }), 'keep');
  assert.equal(listNormalizationVerdict({
    direction: 'outdent', beforeDepth: 1, afterDepth: 0, canOutdent: true,
  }), 'keep');
  assert.equal(listNormalizationVerdict({
    direction: 'outdent', beforeDepth: 2, afterDepth: 2, canOutdent: false,
  }), 'keep');
});

// ── quotes (2026-09-03) ─────────────────────────────────────────────────────

test('Enter inside a quote adds a line and never submits', () => {
  assert.equal(verdict({ key: 'Enter', inQuote: true }), 'new-quote-line');
  assert.equal(verdict({ key: 'Enter', inQuote: true, inEmptyQuoteLine: false }), 'new-quote-line');
  assert.notEqual(verdict({ key: 'Enter', inQuote: true }), 'submit');
  assert.equal(verdict({ key: 'Enter', inQuote: true, shiftKey: true }), 'soft-break');
});

test('Enter on the empty last line of a quote leaves the quote', () => {
  assert.equal(verdict({ key: 'Enter', inQuote: true, inEmptyQuoteLine: true }), 'exit-quote');
  assert.notEqual(verdict({ key: 'Enter', inEmptyQuoteLine: true }), 'exit-quote');
  assert.equal(verdict({ key: 'Enter', inEmptyQuoteLine: true }), 'submit');
});

test('a list inside a quote keeps the list rules for Enter', () => {
  assert.equal(verdict({ key: 'Enter', inQuote: true, inList: true }), 'new-list-item');
  assert.equal(verdict({ key: 'Enter', inQuote: true, inList: true, inEmptyListItem: true }), 'exit-list');
  assert.equal(verdict({ key: 'Tab', inQuote: true, inList: true, listDepth: 1 }), 'indent');
});

// ── auto-format on Space (2026-09-03) ───────────────────────────────────────

const auto = (overrides) => autoFormatVerdict({ key: ' ', collapsed: true, ...overrides });

test('a bullet marker followed by Space starts a bulleted list', () => {
  for (const marker of ['-', '*', '•']) {
    assert.deepEqual(auto({ textBeforeCaret: marker }), { kind: 'bullets', marker, type: null, start: 1 });
  }
});

test('a number followed by Space starts a numbered list at that number', () => {
  assert.deepEqual(auto({ textBeforeCaret: '1.' }), { kind: 'numbers', marker: '1.', type: null, start: 1 });
  assert.deepEqual(auto({ textBeforeCaret: '1)' }), { kind: 'numbers', marker: '1)', type: null, start: 1 });
  assert.deepEqual(auto({ textBeforeCaret: '7.' }), { kind: 'numbers', marker: '7.', type: null, start: 7 });
});

test('roman and letter markers start typed lists', () => {
  assert.equal(auto({ textBeforeCaret: 'I.' }).type, 'I');
  assert.equal(auto({ textBeforeCaret: 'i.' }).type, 'i');
  assert.equal(auto({ textBeforeCaret: 'A.' }).type, 'A');
  assert.equal(auto({ textBeforeCaret: 'a.' }).type, 'a');
  // Only a list's FIRST marker is a trigger: "b." or "II." is prose.
  assert.equal(auto({ textBeforeCaret: 'b.' }), null);
  assert.equal(auto({ textBeforeCaret: 'II.' }), null);
});

test('a greater-than sign followed by Space starts a quote', () => {
  assert.deepEqual(auto({ textBeforeCaret: '>' }), { kind: 'quote', marker: '>', type: null, start: 1 });
  assert.equal(auto({ textBeforeCaret: '>', inQuote: true }), null);
  // A list may start inside a quote, and a quote marker inside a list is text.
  assert.equal(auto({ textBeforeCaret: '-', inQuote: true }).kind, 'bullets');
  assert.equal(auto({ textBeforeCaret: '>', inList: true }), null);
});

test('auto-format needs the marker to be the whole line, a collapsed caret, and prose', () => {
  assert.equal(auto({ textBeforeCaret: 'x -' }), null);
  assert.equal(auto({ textBeforeCaret: '- ' }), null);
  assert.equal(auto({ textBeforeCaret: '' }), null);
  assert.equal(auto({ textBeforeCaret: '-', collapsed: false }), null);
  assert.equal(auto({ textBeforeCaret: '-', inList: true }), null);
  assert.equal(auto({ textBeforeCaret: '1.', inList: true }), null);
  assert.equal(auto({ textBeforeCaret: '-', inPre: true }), null);
  assert.equal(auto({ textBeforeCaret: '-', inCode: true }), null);
  assert.equal(auto({ textBeforeCaret: '-', key: 'Enter' }), null);
  assert.equal(auto({ textBeforeCaret: '-', key: 'x' }), null);
});

test('Backspace straight after an auto-format reverts it, and only then', () => {
  const revert = (overrides) => autoFormatRevertVerdict({
    key: 'Backspace', pending: true, caretInside: true, stillEmpty: true, ...overrides,
  });
  assert.equal(revert({}), 'revert');
  assert.equal(revert({ pending: false }), 'keep');
  assert.equal(revert({ caretInside: false }), 'keep');
  assert.equal(revert({ stillEmpty: false }), 'keep');
  assert.equal(revert({ key: 'Delete' }), 'keep');
  assert.equal(revert({ ctrlKey: true }), 'keep');
  assert.equal(revert({ altKey: true }), 'keep');
});
