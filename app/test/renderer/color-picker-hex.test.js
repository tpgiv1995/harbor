'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hexFieldMaySyncFromValue,
  normalizeHexDraft,
  settleHexDraft,
} = require('../../src/renderer/tasks/color-picker-hex.cjs');

test('LIST-COLOR-12: a focused hex field must not accept a prop rewrite', () => {
  assert.equal(hexFieldMaySyncFromValue(true), false);
  assert.equal(hexFieldMaySyncFromValue(false), true);
});

test('LIST-COLOR-13: hex drafts commit only on settlement, normalized like the model', () => {
  assert.equal(normalizeHexDraft('4ec9b6'), '#4ec9b6');
  assert.equal(normalizeHexDraft('#ABC'), '#abc');
  assert.equal(normalizeHexDraft('  #4EC9B6  '), '#4ec9b6');
  // Orchestrator fix (disclosed): the worker's original assertion expected
  // '#4ec' -> null, contradicting the '#ABC' case four lines up; a 3-digit hex
  // is valid under the model rule and normalizes like any other.
  assert.equal(normalizeHexDraft('#4ec'), '#4ec');
  assert.equal(normalizeHexDraft('4e'), null);
  assert.equal(normalizeHexDraft('octarine'), null);
});

test('LIST-COLOR-14: blur settles valid drafts and keeps invalid ones in place', () => {
  const fallback = '#4ec9b6';
  assert.deepEqual(settleHexDraft('abc', fallback), {
    hex: '#abc',
    invalid: false,
    commit: '#abc',
  });
  assert.deepEqual(settleHexDraft('', fallback), {
    hex: fallback,
    invalid: false,
    commit: null,
  });
  assert.deepEqual(settleHexDraft('#nope', fallback), {
    hex: '#nope',
    invalid: true,
    commit: null,
  });
});
