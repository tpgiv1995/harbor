'use strict';

// THE PERSISTED STAGE IS NEVER PRUNED FROM A MODEL SNAPSHOT (2026-09-04).
//
// Harbor came back with "Nothing on the stage" over fourteen live sessions and
// Pat re-opened every window from the rail by hand. The renderer used to drop
// any restored tile whose session id was missing from the CURRENT sidebar
// model, and write that drop back to localStorage, on every model update once
// the first model had arrived. A model is momentarily short for many ordinary
// reasons (a history refresh that failed at boot, a get-state call that
// rejected but still flipped the loaded flag, an index pass that skipped a
// project it could not list), and every one of them became a permanent wipe:
// when the sessions returned to the rail minutes later the windows did not,
// because the store no longer named them.
//
// So the store is read-only from the model's point of view. This module turns
// the persisted store plus a resolvability predicate into what the stage
// operates on right now: the visible tiles, an effective selection, an
// effective focus. A tile whose session is absent is HIDDEN and comes back the
// instant its session does; the stored selection stays stored, so it returns
// too. Only an explicit close, or eviction to make room for a sixteenth
// window, removes a tile, and eviction takes an absent tile before a visible
// one. The same principle as the daemon's boot-id filter: filtering is harmless
// even when a verdict is wrong; deleting is not.
//
// Pure on purpose (no React, no DOM), so it has a unit test.

function lastSel(tile) {
  return Number.isFinite(tile?.lastSel) ? tile.lastSel : 0;
}

function resolveStage({ tiles = [], selectedId = null, focusedId = null, isResolvable } = {}) {
  const resolvable = typeof isResolvable === 'function' ? isResolvable : () => true;
  const visible = [];
  let hidden = 0;
  for (const tile of tiles) {
    if (resolvable(String(tile.sessionId))) visible.push(tile);
    else hidden += 1;
  }
  const visibleIds = new Set(visible.map((tile) => String(tile.sessionId)));
  let effectiveSelectedId = null;
  if (selectedId != null && visibleIds.has(String(selectedId))) {
    effectiveSelectedId = selectedId;
  } else if (visible.length) {
    // The stored selection is hidden (or null): the command bar still needs a
    // target, so the most recently selected VISIBLE window stands in. The
    // store keeps the real selection for when its session comes back.
    effectiveSelectedId = [...visible].sort((a, b) => lastSel(b) - lastSel(a))[0].sessionId;
  }
  const effectiveFocusedId = focusedId != null && visibleIds.has(String(focusedId)) ? focusedId : null;
  return {
    tiles: visible,
    selectedId: effectiveSelectedId,
    focusedId: effectiveFocusedId,
    storedSelectedId: selectedId,
    hidden,
  };
}

// Which tile gives up its place when the stage is full: an absent (hidden)
// tile first, oldest selection first among those; otherwise the least recently
// selected visible tile that is not the selected one; the selected tile only
// when it is the last one standing.
function pickEviction({ tiles = [], selectedId = null, isResolvable } = {}) {
  const resolvable = typeof isResolvable === 'function' ? isResolvable : () => true;
  if (!tiles.length) return null;
  const bySelection = (a, b) => lastSel(a) - lastSel(b);
  const absent = tiles.filter((tile) => !resolvable(String(tile.sessionId))).sort(bySelection);
  if (absent.length) return absent[0];
  const others = tiles.filter((tile) => tile.sessionId !== selectedId).sort(bySelection);
  return others[0] || tiles[0];
}

module.exports = { resolveStage, pickEviction };
