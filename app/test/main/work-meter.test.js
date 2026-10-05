'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkMeter } = require('../../src/main/work-meter.js');

const screen = (line) => ['⏺ Earlier reply text.', '', line, '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏸ manual mode on · esc to interrupt'].join('\n');

test('reads the shapes the real CLI draws', () => {
  assert.deepEqual(parseWorkMeter(screen('✻ Seasoning… (1s · thinking)')), { verb: 'Seasoning', elapsed: '1s', tokens: null, thinking: true });
  assert.deepEqual(parseWorkMeter(screen('✢ Seasoning… (3s · ↓ 25 tokens · thinking)')), { verb: 'Seasoning', elapsed: '3s', tokens: '↓ 25', thinking: true });
  assert.deepEqual(parseWorkMeter(screen('✽ Seasoning… (26s · ↓ 2.4k tokens)')), { verb: 'Seasoning', elapsed: '26s', tokens: '↓ 2.4k', thinking: false });
  assert.equal(parseWorkMeter(screen('· Dilly-dallying… (1m 3s · ↑ 12k tokens · esc to interrupt)')).elapsed, '1m 3s');
});

test('a spinner with no meter yet, an idle pane and look-alike prose are not meters', () => {
  assert.equal(parseWorkMeter(screen('✶ Forging…')), null);
  assert.equal(parseWorkMeter(screen('✻ Cogitated for 5s · done 1:13 PM')), null);
  assert.equal(parseWorkMeter(screen('⏺ Bash(sleep… (this takes a while))')), null);
  assert.equal(parseWorkMeter(''), null);
});
