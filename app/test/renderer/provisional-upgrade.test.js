'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planProvisionalUpgrades } = require('../../src/renderer/stage/provisional-upgrade.cjs');

// Live-caught 2026-07-28, and it read as twenty minutes of lost work: Pat
// composed a 2,137-character message into a fresh session window, pressed
// Enter, and the window kept saying "Fresh session. Type below to start it."
// The send had landed and a real session was already working on it; the id
// upgrade was emitted only by the launch flow, which watches for a transcript
// for 45 seconds and then stops, and he had been typing for twenty minutes.

const tile = (sessionId, slot) => ({ sessionId, slot });

test('a provisional window adopts the session the daemon paired with its pane', () => {
  const plan = planProvisionalUpgrades({
    tiles: [tile('pane:w4:p1', 0)],
    selectedId: 'pane:w4:p1',
    focusedId: null,
    sessions: [{ id: '8e5466c1-960d-4e97-b8e3-999edee069dd', paneId: 'w4:p1' }],
  });
  assert.deepEqual(plan.tiles, [tile('8e5466c1-960d-4e97-b8e3-999edee069dd', 0)]);
  assert.equal(plan.selectedId, '8e5466c1-960d-4e97-b8e3-999edee069dd');
  assert.deepEqual(plan.renames, [['pane:w4:p1', '8e5466c1-960d-4e97-b8e3-999edee069dd']]);
});

test('nothing to adopt is null, so the stage is never touched for no reason', () => {
  assert.equal(planProvisionalUpgrades({ tiles: [tile('pane:w4:p1', 0)], sessions: [] }), null);
  assert.equal(planProvisionalUpgrades({
    tiles: [tile('real-id', 0)],
    sessions: [{ id: 'real-id', paneId: 'w4:p1' }],
  }), null, 'a window that already has its id is left alone');
  assert.equal(planProvisionalUpgrades({
    tiles: [tile('pane:w9:p9', 0)],
    sessions: [{ id: 'real-id', paneId: 'w4:p1' }],
  }), null, 'a pairing for some other pane is not this window');
});

test('a pane with no real session yet is not an upgrade', () => {
  // Agent detection lags, so a live pane can be known before its session id is.
  // Adopting `live:w4:p1` would swap one unusable key for another.
  assert.equal(planProvisionalUpgrades({
    tiles: [tile('pane:w4:p1', 0)],
    sessions: [{ id: 'live:w4:p1', paneId: 'w4:p1' }, { id: 'pane:w4:p1', paneId: 'w4:p1' }],
  }), null);
});

test('upgrading onto an id that already has a window collapses the duplicate', () => {
  // He reopened the session from the rail while its launch was still
  // provisional. Two windows on one session means two transcripts of one file,
  // two composers and two drafts; the upgraded one wins, because that is the
  // window he has been typing into.
  const plan = planProvisionalUpgrades({
    tiles: [tile('sess-1', 0), tile('pane:w4:p1', 1), tile('other', 2)],
    selectedId: 'pane:w4:p1',
    focusedId: 'sess-1',
    sessions: [{ id: 'sess-1', paneId: 'w4:p1' }],
  });
  assert.deepEqual(plan.tiles, [tile('sess-1', 1), tile('other', 2)]);
  assert.equal(plan.selectedId, 'sess-1');
  assert.equal(plan.focusedId, 'sess-1', 'focus follows the surviving window');
});

test('several provisional windows upgrade in one pass', () => {
  const plan = planProvisionalUpgrades({
    tiles: [tile('pane:w1:p1', 0), tile('pane:w2:p1', 1)],
    sessions: [{ id: 'a', paneId: 'w1:p1' }, { id: 'b', paneId: 'w2:p1' }],
  });
  assert.deepEqual(plan.tiles.map((t) => t.sessionId), ['a', 'b']);
  assert.equal(plan.renames.length, 2);
});

test('the first pairing for a pane wins, so a stale duplicate row cannot retarget a window', () => {
  const plan = planProvisionalUpgrades({
    tiles: [tile('pane:w4:p1', 0)],
    sessions: [{ id: 'first', paneId: 'w4:p1' }, { id: 'second', paneId: 'w4:p1' }],
  });
  assert.equal(plan.tiles[0].sessionId, 'first');
});

// SUBSTRATE-3: claude launches open on a minted real id, so this renderer-side
// heal never runs for them. Codex still opens on pane:<paneId> and depends on it.
test('a minted claude window with a real id from the start is not upgraded here', () => {
  assert.equal(planProvisionalUpgrades({
    tiles: [tile('8e5466c1-960d-4e97-b8e3-999edee069dd', 0)],
    sessions: [{ id: '8e5466c1-960d-4e97-b8e3-999edee069dd', paneId: 'w4:p1' }],
  }), null);
});

test('codex provisional windows still upgrade through the sidebar pairing', () => {
  const plan = planProvisionalUpgrades({
    tiles: [tile('pane:w4:p1', 0)],
    sessions: [{ id: 'codex-rollout-id', paneId: 'w4:p1', provider: 'codex' }],
  });
  assert.equal(plan.tiles[0].sessionId, 'codex-rollout-id');
});

// A codex window opened from the rail BEFORE the linker names its session is
// keyed live:<paneId>. When the link lands, the live: row becomes the real-id
// row, so a live: tile that cannot upgrade stops resolving a session at all
// and Stage drops it: the window Pat was watching would simply vanish
// (2026-08-08, found while fixing the 8KB rollout read that had kept the
// linker from ever landing a link).
test('a live:-keyed window upgrades to the session its pane was named with', () => {
  const plan = planProvisionalUpgrades({
    tiles: [tile('live:w4:p1', 0)],
    selectedId: 'live:w4:p1',
    focusedId: null,
    sessions: [{ id: '019fe010-da88-7c13-b551-9834713b8352', paneId: 'w4:p1', provider: 'codex' }],
  });
  assert.deepEqual(plan.tiles, [tile('019fe010-da88-7c13-b551-9834713b8352', 0)]);
  assert.equal(plan.selectedId, '019fe010-da88-7c13-b551-9834713b8352');
  assert.deepEqual(plan.renames, [['live:w4:p1', '019fe010-da88-7c13-b551-9834713b8352']]);
});

test('a live: window whose pane is still unnamed stays put', () => {
  assert.equal(planProvisionalUpgrades({
    tiles: [tile('live:w4:p1', 0)],
    sessions: [{ id: 'live:w4:p1', paneId: 'w4:p1' }],
  }), null);
});

test('a live: window collapses onto an existing real-id window like pane: does', () => {
  const plan = planProvisionalUpgrades({
    tiles: [tile('sess-1', 0), tile('live:w4:p1', 1)],
    selectedId: 'live:w4:p1',
    sessions: [{ id: 'sess-1', paneId: 'w4:p1' }],
  });
  assert.deepEqual(plan.tiles, [tile('sess-1', 1)]);
  assert.equal(plan.selectedId, 'sess-1');
});
