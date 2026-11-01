'use strict';

// The phone message box's text model (web/src/composer/plain-text.cjs). The DOM
// shapes below are the ones WebKit 18.4 and Chromium 136 actually leave in a
// contenteditable="plaintext-only" box with white-space: pre-wrap, measured
// 2026-11-01; the drive scripts prove the same rules against the real engines.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readPlain, displayText, offsetAt } = require('../../web/src/composer/plain-text.cjs');

function text(data) { return { nodeType: 3, data }; }
function el(nodeName, ...childNodes) {
  const node = { nodeType: 1, nodeName, childNodes };
  node.contains = (other) => childNodes.some((child) => child === other || (child.contains && child.contains(other)));
  return node;
}
const box = (...kids) => el('DIV', ...kids);

test('one trailing newline is the caret line the browser adds, never text', () => {
  assert.equal(readPlain(box(text('abc\n\n'))), 'abc\n', 'abc + Enter');
  assert.equal(readPlain(box(text('abc\ndef'))), 'abc\ndef', 'then typing def');
  assert.equal(readPlain(box(text('abc\ndef\n\n\n'))), 'abc\ndef\n\n', 'two more Enters');
  assert.equal(readPlain(box(text('\n'))), '', 'select all + delete');
  assert.equal(readPlain(box()), '', 'empty');
  assert.equal(readPlain(box(text('abc'))), 'abc');
});

test('inserted lines that arrive as blocks or breaks read as lines', () => {
  assert.equal(readPlain(box(text('one'), el('DIV', text('two')))), 'one\ntwo');
  assert.equal(readPlain(box(el('DIV', text('a')), el('DIV', text('b')))), 'a\nb');
  assert.equal(readPlain(box(el('DIV', text('a')), el('DIV', el('BR')))), 'a\n');
  assert.equal(readPlain(box(el('DIV', el('BR')))), '');
  assert.equal(readPlain(box(text('a'), el('BR'), text('b'))), 'a\nb');
  assert.equal(readPlain(box(text('a'), el('BR'))), 'a', 'a trailing break draws no line');
  assert.equal(readPlain(box(text('a'), el('BR'), el('BR'))), 'a\n');
  assert.equal(readPlain(box(el('DIV', text('a')), text('b'))), 'a\nb', 'text after a block starts a line');
  assert.equal(readPlain(box(text('x'), el('SPAN', text('y')), text('z'))), 'xyz', 'inline wrappers add nothing');
  assert.equal(readPlain(box(text('a b'))), 'a b', 'a non-breaking space is a space');
});

test('writing then reading gives back exactly what was written', () => {
  for (const value of ['', 'a', 'a\n', 'a\n\n', '\n', '\n\nx', 'line one\nline two', 'trailing space ', '  lead']) {
    assert.equal(readPlain(box(text(displayText(value)))), value, JSON.stringify(value));
  }
  assert.equal(displayText(''), '');
  assert.equal(displayText('a\n'), 'a\n\n');
});

test('a caret position maps to the character offset a textarea would report', () => {
  const t = text('abc\ndef');
  const root = box(t);
  assert.equal(offsetAt(root, t, 0), 0);
  assert.equal(offsetAt(root, t, 5), 5);
  assert.equal(offsetAt(root, root, 0), 0, 'before the first node');
  assert.equal(offsetAt(root, root, 1), 7, 'after the last node');

  const placeholder = text('abc\n\n');
  const withLine = box(placeholder);
  assert.equal(offsetAt(withLine, placeholder, 4), 4, 'on the new empty line');
  assert.equal(offsetAt(withLine, placeholder, 5), 4, 'past the caret line clamps to the end');

  const two = text('two');
  const block = el('DIV', two);
  const mixed = box(text('one'), block);
  assert.equal(offsetAt(mixed, two, 0), 4, 'start of a block line is after its newline');
  assert.equal(offsetAt(mixed, two, 2), 6);
  assert.equal(offsetAt(mixed, block, 0), 4);
  assert.equal(offsetAt(mixed, block, 1), 7);

  const b = text('b');
  const broken = box(text('a'), el('BR'), b);
  assert.equal(offsetAt(broken, broken, 2), 2, 'after the break');
  assert.equal(offsetAt(broken, b, 1), 3);

  assert.equal(offsetAt(root, text('elsewhere'), 0), null, 'a selection outside the box is not an offset');
});
