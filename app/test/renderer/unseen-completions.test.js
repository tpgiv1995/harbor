'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SEEN_STORE_VERSION,
  MAX_SEEN_ENTRIES,
  loadSeenStore,
  seedSeenStore,
  markSeen,
  seenMsFor,
  attentionFor,
  countAttention,
  badgeCounts,
} = require('../../src/renderer/stage/unseen-completions.cjs');

const NOW = 1_760_000_000_000;
const MINUTE = 60_000;

// A session descriptor as the renderer assembles it: transcript activity time,
// whether a transcript row exists at all, and the live working/blocked signals.
function session(overrides = {}) {
  return {
    id: 's1',
    isHistorical: true,
    activeMs: NOW - MINUTE,
    working: false,
    blocked: false,
    isSelected: false,
    ...overrides,
  };
}

test('a fresh store seeds a watermark, so an existing rail full of sessions does not light up', () => {
  const store = seedSeenStore(loadSeenStore(null), NOW);
  assert.equal(store.seededAtMs, NOW);
  // Every one of Pat's 719 existing sessions last wrote BEFORE the watermark.
  for (const activeMs of [NOW - MINUTE, NOW - 1000 * MINUTE, 0]) {
    assert.equal(attentionFor(session({ activeMs }), store), null, `activeMs=${activeMs}`);
  }
});

test('seeding happens once: a later call never moves the watermark forward', () => {
  const seeded = seedSeenStore(loadSeenStore(null), NOW);
  const again = seedSeenStore(seeded, NOW + 500 * MINUTE);
  assert.equal(again.seededAtMs, NOW, 'a re-seed would silently mark everything read');
  // And a completion after the original watermark still shows.
  assert.equal(attentionFor(session({ activeMs: NOW + MINUTE }), again), 'finished');
});

test('a session that finishes after you last looked is marked', () => {
  const store = seedSeenStore(loadSeenStore(null), NOW);
  assert.equal(attentionFor(session({ activeMs: NOW + MINUTE }), store), 'finished');
});

test('selecting the window clears it, and later work marks it again', () => {
  let store = seedSeenStore(loadSeenStore(null), NOW);
  const finished = session({ activeMs: NOW + MINUTE });
  assert.equal(attentionFor(finished, store), 'finished');

  store = markSeen(store, 's1', NOW + 2 * MINUTE);
  assert.equal(attentionFor(finished, store), null, 'checking it must clear the marker');

  // It runs again and finishes again: the marker comes back. This is why the
  // store holds a TIMESTAMP and not a boolean.
  assert.equal(attentionFor(session({ activeMs: NOW + 3 * MINUTE }), store), 'finished');
});

test('a session you are looking at never marks itself', () => {
  const store = seedSeenStore(loadSeenStore(null), NOW);
  assert.equal(attentionFor(session({ activeMs: NOW + MINUTE, isSelected: true }), store), null);
});

test('a session still working is not finished, however stale its last write', () => {
  const store = seedSeenStore(loadSeenStore(null), NOW);
  assert.equal(attentionFor(session({ activeMs: NOW + MINUTE, working: true }), store), null);
});

test('blocked outranks finished: a session stuck on a question is never merely done', () => {
  const store = seedSeenStore(loadSeenStore(null), NOW);
  assert.equal(attentionFor(session({ activeMs: NOW + MINUTE, blocked: true }), store), 'blocked');
  // Even while working, something waiting on an answer needs you.
  assert.equal(attentionFor(session({ activeMs: NOW + MINUTE, blocked: true, working: true }), store), 'blocked');
  // But not while you are looking straight at it.
  assert.equal(
    attentionFor(session({ activeMs: NOW + MINUTE, blocked: true, isSelected: true }), store),
    null,
  );
});

test('a window with no transcript yet has finished nothing', () => {
  // A fresh `pane:`/`live:` window: no history row, so there is no turn to
  // have completed and no honest activity time to compare.
  const store = seedSeenStore(loadSeenStore(null), NOW);
  assert.equal(attentionFor(session({ isHistorical: false, activeMs: NOW + MINUTE }), store), null);
  for (const activeMs of [null, undefined, 0, NaN, -1]) {
    assert.equal(attentionFor(session({ activeMs }), store), null, `activeMs=${activeMs}`);
  }
});

test('a session first seen after seeding still marks itself when it finishes', () => {
  // No per-session entry exists, so it falls back to the watermark rather than
  // being treated as already read; a session started after the feature shipped
  // must still be able to tell you it is done.
  const store = seedSeenStore(loadSeenStore(null), NOW);
  assert.equal(seenMsFor(store, 'brand-new'), NOW);
  assert.equal(attentionFor(session({ id: 'brand-new', activeMs: NOW + MINUTE }), store), 'finished');
});

test('an unseeded store marks nothing, so a first paint cannot flash badges', () => {
  const empty = loadSeenStore(null);
  assert.equal(empty.seededAtMs, null);
  assert.equal(attentionFor(session({ activeMs: NOW + MINUTE }), empty), null);
});

test('the store survives a round trip and rejects junk', () => {
  let store = seedSeenStore(loadSeenStore(null), NOW);
  store = markSeen(store, 's1', NOW + MINUTE);
  const round = loadSeenStore(JSON.parse(JSON.stringify(store)));
  assert.equal(round.seededAtMs, NOW);
  assert.equal(seenMsFor(round, 's1'), NOW + MINUTE);

  for (const junk of [null, undefined, 'nope', 42, [], { version: 99 }, { seen: 'x' }]) {
    const recovered = loadSeenStore(junk);
    assert.equal(recovered.version, SEEN_STORE_VERSION);
    assert.deepEqual(recovered.seen, {});
  }
});

test('the store is bounded, keeping the most recently checked sessions', () => {
  let store = seedSeenStore(loadSeenStore(null), NOW);
  for (let i = 0; i < MAX_SEEN_ENTRIES + 50; i += 1) {
    store = markSeen(store, `s${i}`, NOW + i);
  }
  const ids = Object.keys(store.seen);
  assert.equal(ids.length, MAX_SEEN_ENTRIES, 'a store that grows forever is a leak');
  assert.ok(ids.includes(`s${MAX_SEEN_ENTRIES + 49}`), 'the newest check must survive');
  assert.ok(!ids.includes('s0'), 'the oldest check is the one to drop');
});

test('marking a session that is already newer never moves the clock backwards', () => {
  let store = seedSeenStore(loadSeenStore(null), NOW);
  store = markSeen(store, 's1', NOW + 5 * MINUTE);
  store = markSeen(store, 's1', NOW + MINUTE);
  assert.equal(seenMsFor(store, 's1'), NOW + 5 * MINUTE);
});

test('countAttention totals what is waiting, for a single glance at the rail', () => {
  const store = seedSeenStore(loadSeenStore(null), NOW);
  const sessions = [
    session({ id: 'a', activeMs: NOW + MINUTE }),
    session({ id: 'b', activeMs: NOW + MINUTE, blocked: true }),
    session({ id: 'c', activeMs: NOW + MINUTE, working: true }),
    session({ id: 'd', activeMs: NOW - MINUTE }),
  ];
  assert.deepEqual(countAttention(sessions, store), { finished: 1, blocked: 1, total: 2 });
});

test('an excluded session never marks, however overdue', () => {
  const store = { version: SEEN_STORE_VERSION, seededAtMs: 100, seen: {} };
  const overdue = { id: 'w1', isHistorical: true, activeMs: 500, working: false, blocked: false, isSelected: false };
  assert.equal(attentionFor({ ...overdue, excluded: true }, store), null);
  assert.equal(attentionFor({ ...overdue, excluded: true, blocked: true }, store), null);
  assert.equal(attentionFor(overdue, store), 'finished');
});

test('badgeCounts: blocked is live and ignores selection and the seen store', () => {
  const store = { version: SEEN_STORE_VERSION, seededAtMs: 100, seen: { q: 999 } };
  const counts = badgeCounts([
    { id: 'q', open: true, isHistorical: true, activeMs: 50, working: false, blocked: true, isSelected: true },
    { id: 'f', open: true, isHistorical: true, activeMs: 500, working: false, blocked: false, isSelected: false },
    { id: 'seen', open: true, isHistorical: true, activeMs: 50, working: false, blocked: false, isSelected: false },
    { id: 'orch', open: true, isHistorical: true, activeMs: 500, working: false, blocked: true, isSelected: false, excluded: true },
  ], store);
  assert.deepEqual(counts, { finished: 1, blocked: 1, total: 2 });
});

test('badgeCounts speaks only for OPEN windows: background history never badges', () => {
  // Pat, 2026-08-30: the taskbar sat at 9+ around the clock with two sessions
  // open. Every transcript in ~/.claude/projects that advanced after the
  // watermark counted forever, because terminal and agent sessions are never
  // selected in Harbor and so never marked seen. The badge answers "which of
  // MY open windows need me": a descriptor without open: true contributes
  // nothing, however overdue and even when blocked.
  const store = { version: SEEN_STORE_VERSION, seededAtMs: 100, seen: {} };
  const background = Array.from({ length: 40 }, (_, i) => (
    { id: `bg${i}`, isHistorical: true, activeMs: 500, working: false, blocked: false, isSelected: false }
  ));
  const blockedBackground = { id: 'bgq', isHistorical: true, activeMs: 500, working: false, blocked: true, isSelected: false };
  const openFinished = { id: 'of', open: true, isHistorical: true, activeMs: 500, working: false, blocked: false, isSelected: false };
  const openBlocked = { id: 'ob', open: true, isHistorical: true, activeMs: 50, working: false, blocked: true, isSelected: true };
  const counts = badgeCounts([...background, blockedBackground, openFinished, openBlocked], store);
  assert.deepEqual(counts, { finished: 1, blocked: 1, total: 2 });
});

test('a v1 store loads as empty, which is the 2026-08-22 owner-ordered wipe', () => {
  const stale = { version: 1, seededAtMs: 100, seen: { a: 200 } };
  const loaded = loadSeenStore(stale);
  assert.equal(loaded.seededAtMs, null);
  assert.deepEqual(loaded.seen, {});
  const seeded = seedSeenStore(loaded, 5000);
  assert.equal(seeded.seededAtMs, 5000);
});
