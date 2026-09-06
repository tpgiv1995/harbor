'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyFormat } = require('../../web/src/composer/format-markdown.cjs');

test('format-markdown wraps bold selection for the phone textarea toolbar', () => {
  const result = applyFormat('format proof', 0, 12, 'bold');
  assert.equal(result.text, '**format proof**');
});
