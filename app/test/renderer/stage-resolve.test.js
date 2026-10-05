'use strict';
// The persisted stage survives a model that is momentarily missing a session.
//
// Live-caught 2026-09-04: Harbor came back with "Nothing on the stage" while
// every one of the 14 sessions was alive in the daemon, and Pat re-opened them
// one by one from the rail. The renderer used to CULL any restored tile whose
// session id was absent from the current sidebar model, and PERSIST the cull,
// on every model update once the first model had arrived. Any transient shrink
// of the model (a history refresh that failed at boot, a get-state rejection
// that still flipped the loaded flag, an index pass that dropped a project)
// therefore wiped the stage for good: when the sessions returned to the rail
// minutes later, the windows did not, because the store no longer named them.
//
// The rule now: a tile whose session is not in the model is HIDDEN, never
// deleted. It reappears the moment its session does. Only an explicit close,
// or eviction to make room, removes a tile from the store; eviction takes an
// absent tile before a visible one.
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveStage, pickEviction } = require('../../src/renderer/stage/stage-resolve.cjs');

const tiles = [
  { sessionId: 'a', slot: 0, lastSel: 10 },
  { sessionId: 'b', slot: 1, lastSel: 30 },
  { sessionId: 'c', slot: 2, lastSel: 20 },
];
const has = (...ids) => (id) => ids.includes(id);

test('an absent session hides its tile and keeps the store untouched', () => {
  const out = resolveStage({ tiles, selectedId: 'a', focusedId: null, isResolvable: has('a', 'c') });
  assert.deepEqual(out.tiles.map((t) => t.sessionId), ['a', 'c']);
  assert.equal(out.tiles[0], tiles[0], 'visible tiles are the same objects, not copies');
  assert.equal(out.selectedId, 'a');
  assert.equal(out.hidden, 1);
});

test('the store is not the caller\'s to mutate: the input array is unchanged', () => {
  const copy = tiles.map((t) => ({ ...t }));
  resolveStage({ tiles: copy, selectedId: 'a', focusedId: 'b', isResolvable: has('a') });
  assert.deepEqual(copy, tiles);
});

test('a hidden selection falls back to the most recently selected visible tile, without changing the stored selection', () => {
  const out = resolveStage({ tiles, selectedId: 'b', focusedId: null, isResolvable: has('a', 'c') });
  assert.equal(out.selectedId, 'c', 'c was selected more recently than a');
  assert.equal(out.storedSelectedId, 'b', 'the stored selection is reported as-is so it can return');
});

test('the stored selection comes back the moment its session does', () => {
  const gone = resolveStage({ tiles, selectedId: 'b', focusedId: null, isResolvable: has('a', 'c') });
  assert.equal(gone.selectedId, 'c');
  const back = resolveStage({ tiles, selectedId: 'b', focusedId: null, isResolvable: has('a', 'b', 'c') });
  assert.equal(back.selectedId, 'b');
  assert.equal(back.hidden, 0);
});

test('an empty model hides everything and selects nothing, and drops nothing', () => {
  const out = resolveStage({ tiles, selectedId: 'a', focusedId: 'a', isResolvable: () => false });
  assert.deepEqual(out.tiles, []);
  assert.equal(out.selectedId, null);
  assert.equal(out.focusedId, null);
  assert.equal(out.hidden, 3);
});

test('focus is cleared while the focused session is hidden and returns with it', () => {
  const gone = resolveStage({ tiles, selectedId: 'b', focusedId: 'b', isResolvable: has('a') });
  assert.equal(gone.focusedId, null);
  const back = resolveStage({ tiles, selectedId: 'b', focusedId: 'b', isResolvable: has('a', 'b') });
  assert.equal(back.focusedId, 'b');
});

test('the resolvable predicate is the only judge: provisional and launch-known ids are the caller\'s call', () => {
  const provisional = [{ sessionId: 'pane:p1', slot: 0, lastSel: 1 }, { sessionId: 'live:p2', slot: 1, lastSel: 2 }];
  const out = resolveStage({ tiles: provisional, selectedId: 'pane:p1', focusedId: null, isResolvable: (id) => id.startsWith('pane:') });
  assert.deepEqual(out.tiles.map((t) => t.sessionId), ['pane:p1']);
});

test('eviction takes an absent tile before any visible one, oldest selection first', () => {
  const crowded = [
    { sessionId: 'a', slot: 0, lastSel: 50 },
    { sessionId: 'ghost-old', slot: 1, lastSel: 5 },
    { sessionId: 'ghost-new', slot: 2, lastSel: 40 },
    { sessionId: 'b', slot: 3, lastSel: 10 },
  ];
  const evict = pickEviction({ tiles: crowded, selectedId: 'a', isResolvable: has('a', 'b') });
  assert.equal(evict.sessionId, 'ghost-old');
});

test('with no absent tiles, eviction is the least-recently-selected visible tile that is not selected', () => {
  const evict = pickEviction({ tiles, selectedId: 'a', isResolvable: has('a', 'b', 'c') });
  assert.equal(evict.sessionId, 'c', 'a is selected; of b (30) and c (20), c is older');
});

test('the selected tile is never evicted while anything else exists', () => {
  const two = [{ sessionId: 'a', slot: 0, lastSel: 1 }, { sessionId: 'b', slot: 1, lastSel: 2 }];
  assert.equal(pickEviction({ tiles: two, selectedId: 'a', isResolvable: () => true }).sessionId, 'b');
  const one = [{ sessionId: 'a', slot: 0, lastSel: 1 }];
  assert.equal(pickEviction({ tiles: one, selectedId: 'a', isResolvable: () => true }).sessionId, 'a');
});
