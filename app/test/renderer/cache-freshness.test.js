'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cacheFreshness, describeCacheFreshness } = require('../../src/renderer/stage/cache-freshness.cjs');

// The cache chip exists because a session idle past its cache TTL pays the
// full context re-read on its next message, while big-context turn starts
// are slow even warm (measured 2026-08-21: 36s to first record on a 470k
// cache HIT). Everything here derives from the transcript's own usage
// records; with no facts there is no chip, never a guessed one — the same
// posture as the context gauge's never-invent-a-denominator rule.

test('a session touched inside its TTL is warm, with honest time remaining', () => {
  const now = 1_000_000_000;
  const fresh = cacheFreshness({ touchedMs: now - 10 * 60_000, ttlMs: 60 * 60_000, now });
  assert.equal(fresh.state, 'warm');
  assert.equal(fresh.remainingMs, 50 * 60_000);
  assert.equal(fresh.expiresAtMs, now + 50 * 60_000);
});

test('a session idle past its TTL is expired, and remaining never goes negative', () => {
  const now = 1_000_000_000;
  const stale = cacheFreshness({ touchedMs: now - 61 * 60_000, ttlMs: 60 * 60_000, now });
  assert.equal(stale.state, 'expired');
  assert.equal(stale.remainingMs, 0);
});

test('missing or nonsense facts mean no chip, never a guessed one', () => {
  const now = 1_000_000_000;
  assert.equal(cacheFreshness({ touchedMs: null, ttlMs: 60 * 60_000, now }), null);
  assert.equal(cacheFreshness({ touchedMs: now, ttlMs: null, now }), null);
  assert.equal(cacheFreshness({ touchedMs: 0, ttlMs: 0, now }), null);
  assert.equal(cacheFreshness({ touchedMs: -5, ttlMs: -5, now }), null);
  assert.equal(describeCacheFreshness(null), null);
});

test('the chip text is a bare minutes-left countdown while warm and cold when expired', () => {
  // Label history, both corrections Pat's: "cache 17m" failed its first real
  // read (left, or 17 minutes old?), and the disambiguated "cache 17m left"
  // was too much text for a chip he now understands. The label is the bare
  // countdown; the tooltip owns the explanation.
  const now = 1_000_000_000;
  const warm = describeCacheFreshness(cacheFreshness({ touchedMs: now - 13 * 60_000, ttlMs: 60 * 60_000, now }));
  assert.equal(warm.state, 'warm');
  assert.equal(warm.label, '47m');
  assert.match(warm.title, /warm/i);
  // Inside the final minute the label never claims zero minutes of warmth.
  const closing = describeCacheFreshness(cacheFreshness({ touchedMs: now - 59.5 * 60_000, ttlMs: 60 * 60_000, now }));
  assert.equal(closing.label, '1m');
  const cold = describeCacheFreshness(cacheFreshness({ touchedMs: now - 2 * 60 * 60_000, ttlMs: 60 * 60_000, now }));
  assert.equal(cold.state, 'expired');
  assert.equal(cold.label, 'cold');
  assert.match(cold.title, /re-reads the full context/i);
});
