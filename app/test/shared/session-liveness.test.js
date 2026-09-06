'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { externalLiveFromHeader } = require('../../src/shared/session-liveness.cjs');

const NOW = 1_000_000_000_000;

test('no header means not external-live', () => {
  assert.equal(externalLiveFromHeader(null, NOW), false);
  assert.equal(externalLiveFromHeader(undefined, NOW), false);
});

test('a dead beacon outranks a stale working flag (the OOM-kill shape)', () => {
  // Killed mid-turn: the transcript tail froze in a working state, but the
  // beacon pid is verifiably gone. This session is dead, not external-live.
  assert.equal(externalLiveFromHeader({ working: true, processAlive: false, lastWriteMs: NOW - 30_000 }, NOW), false);
});

test('working with an alive beacon is external-live', () => {
  assert.equal(externalLiveFromHeader({ working: true, processAlive: true, lastWriteMs: NOW - 30_000 }, NOW), true);
});

test('working with no beacon at all is external-live', () => {
  assert.equal(externalLiveFromHeader({ working: true, processAlive: null, lastWriteMs: NOW - 30_000 }, NOW), true);
});

test('idle with an alive beacon is external-live (watch the outside writer)', () => {
  assert.equal(externalLiveFromHeader({ working: false, processAlive: true, lastWriteMs: NOW - 9_000_000 }, NOW), true);
});

test('idle with a dead beacon is dead, whatever the transcript recency', () => {
  assert.equal(externalLiveFromHeader({ working: false, processAlive: false, lastWriteMs: NOW - 1_000 }, NOW), false);
});

test('no beacon falls back to short transcript recency', () => {
  assert.equal(externalLiveFromHeader({ working: false, processAlive: null, lastWriteMs: NOW - 60_000 }, NOW), true);
  assert.equal(externalLiveFromHeader({ working: false, processAlive: null, lastWriteMs: NOW - 4 * 60 * 1000 }, NOW), false);
  assert.equal(externalLiveFromHeader({ working: false, processAlive: null, lastWriteMs: null }, NOW), false);
});
