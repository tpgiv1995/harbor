'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SCROLLBACK_CAP } = require('../../src/shared/terminal-layout.cjs');

test('scrollback cap is 10k lines for xterm configuration', () => {
  assert.equal(SCROLLBACK_CAP, 10000);
});
