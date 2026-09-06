'use strict';

// The cache chip's whole brain, pure so the tile can re-derive it on a
// timer: warmth expires with NO transcript event, so the state must be a
// function of (facts, now), never something stored. The facts come from the
// transcript's own assistant usage records (main/providers/transcript.js
// captures cacheTouchedMs and cacheTtlMs from the cache_creation TTL
// breakdown the API writes); with no facts there is no chip, never a
// guessed one — the context gauge's never-invent-a-denominator posture.
//
// Why this exists (2026-08-21): a session idle past its cache TTL pays a
// full context re-read before its next reply's first word, and Pat had no
// way to see which of the two prices his next Enter would pay. Warm is not
// instant — a 470k-token cache HIT still measured 36s to first record — so
// the wording promises relative speed only.

function cacheFreshness({ touchedMs, ttlMs, now = Date.now() } = {}) {
  if (!Number.isFinite(touchedMs) || touchedMs <= 0) return null;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return null;
  const expiresAtMs = touchedMs + ttlMs;
  const remainingMs = expiresAtMs - now;
  if (remainingMs > 0) return { state: 'warm', remainingMs, expiresAtMs };
  return { state: 'expired', remainingMs: 0, expiresAtMs };
}

function describeCacheFreshness(freshness) {
  if (!freshness) return null;
  if (freshness.state === 'warm') {
    // Never "0m" while still warm: the floor is one minute. Label history,
    // both corrections Pat's (2026-08-21): the bare "cache 17m" failed its
    // first real read (left, or 17 minutes old?), and the disambiguated
    // "cache 17m left" was too much text once he knew what it meant. The
    // label is the bare countdown; the tooltip owns the explanation.
    const mins = Math.max(1, Math.floor(freshness.remainingMs / 60_000));
    return {
      state: 'warm',
      label: `${mins}m`,
      title: `Prompt cache warm for about ${mins} more minute${mins === 1 ? '' : 's'}`
        + ' (from this session’s own usage records).'
        + ' A message sent while warm skips the full context re-read.',
    };
  }
  return {
    state: 'expired',
    label: 'cold',
    title: 'Prompt cache expired: the next reply re-reads the full context'
      + ' before its first word, which is slow on a large session.',
  };
}

module.exports = { cacheFreshness, describeCacheFreshness };
