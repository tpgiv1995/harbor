'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isHidden, stripInvisible, dropAllInvisible } = require('../../src/shared/invisible-chars.cjs');

test('isHidden is Claude 2.1.321\'s predicate: controls, zero-widths, bidi, selectors, tags; never tab, newline, space or NBSP', () => {
  for (const cp of [0x00, 0x1b, 0x7f, 0x9f, 0xad, 0x200b, 0x200c, 0x200d, 0x200e, 0x202e, 0x2060, 0x2066, 0xfe0f, 0xfeff, 0xe0067]) {
    assert.equal(isHidden(cp), true, cp.toString(16));
  }
  for (const cp of [0x09, 0x0a, 0x20, 0x41, 0xa0, 0xe9, 0x2014, 0x1f600]) {
    assert.equal(isHidden(cp), false, cp.toString(16));
  }
});

test('stripInvisible removes what Claude always removes and turns every line separator into a newline', () => {
  assert.equal(stripInvisible('a\u200Bb\u00ADc\u2060d\uFEFFe\u202Af\u202Cg'), 'abcdefg');
  assert.equal(stripInvisible('one\r\ntwo\rthree\u2028four\u2029five\vsix\fseven\u0085eight'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight');
  assert.equal(stripInvisible('tab\tand nbsp\u00A0stay'), 'tab\tand nbsp\u00A0stay');
  assert.equal(stripInvisible('esc \x1b[31m gone'), 'esc [31m gone');
});

test('stripInvisible keeps what Claude keeps in context: emoji joiners and selectors, flags, Thai word breaks, marks in RTL text', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  assert.equal(stripInvisible(family), family);
  assert.equal(stripInvisible('\u2764\uFE0F'), '\u2764\uFE0F');
  const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
  assert.equal(stripInvisible(england), england);
  assert.equal(stripInvisible('\u0E2A\u0E27\u200B\u0E14\u0E35'), '\u0E2A\u0E27\u200B\u0E14\u0E35');
  assert.equal(stripInvisible('\u05E9\u05DC\u05D5\u05DD \u200Eabc'), '\u05E9\u05DC\u05D5\u05DD \u200Eabc');
  assert.equal(stripInvisible('plain \u200Eabc'), 'plain abc');
});

test('dropAllInvisible drops every hidden character, joiners included, for comparing two texts', () => {
  assert.equal(dropAllInvisible('ab\u200Dcd\uFE0F\u200B'), 'abcd');
  assert.equal(dropAllInvisible('a\r\nb'), 'a\nb');
  assert.equal(dropAllInvisible('pure ascii stays the same object'), 'pure ascii stays the same object');
  assert.equal(dropAllInvisible(null), '');
});
