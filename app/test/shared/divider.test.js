'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isDividerLine } = require('../../src/shared/divider.cjs');
test('divider tolerance accepts limited replacement damage, never words or digits', () => {
  for (const glyph of ['\u2500', '\u2501', '\u2014', '_', '-']) {
    assert.equal(isDividerLine(glyph.repeat(40)), true);
    for (const junk of ['\ufffd', '\ufffc']) {
      assert.equal(isDividerLine(glyph.repeat(20) + junk + glyph.repeat(20)), true);
      assert.equal(isDividerLine(glyph.repeat(20) + junk.repeat(2) + glyph.repeat(20)), true);
      assert.equal(isDividerLine(glyph.repeat(20) + junk.repeat(3) + glyph.repeat(20)), true);
      assert.equal(isDividerLine(glyph.repeat(20) + junk.repeat(4) + glyph.repeat(20)), false);
      assert.equal(isDividerLine(glyph.repeat(5) + junk), false);
    }
    for (const word of ['yes', 'No', '1', '\u00e9', '\u4e2d']) assert.equal(isDividerLine(glyph.repeat(50) + word), false);
  }
  assert.equal(isDividerLine('---'), false);
  assert.equal(isDividerLine('---', 3), true);
  assert.equal(isDividerLine(''), false);
});
