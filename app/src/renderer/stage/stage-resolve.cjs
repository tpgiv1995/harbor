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

// Called only for an explicit open, never during a model refresh. Hidden
// windows retain their identity but yield their cell to a visible new window.
function placeNewTile({ tiles = [], tile, preferredSlot, isResolvable = () => true, maxTiles = 16 }) {
  const visibleSlots = new Set(tiles.filter(t => isResolvable(String(t.sessionId))).map(t => t.slot));
  let slot = Number.isInteger(preferredSlot) && preferredSlot >= 0 && preferredSlot < maxTiles
    && !visibleSlots.has(preferredSlot) ? preferredSlot : 0;
  while (visibleSlots.has(slot)) slot += 1;
  const used = new Set([...tiles.map(t => t.slot), slot]);
  const placed = tiles.map(t => {
    if (t.slot !== slot) return t;
    let replacement = 0;
    while (used.has(replacement)) replacement += 1;
    used.add(replacement);
    return { ...t, slot: replacement };
  });
  return [...placed, { ...tile, slot }];
}

// Where a dragged window lands (2026-10-07, Pat: a window dragged to the end
// "left behind a 'gap'", "the others would 'slide' and adjust"; then "i would
// want it to slide in between the two, not swap"). Windows own grid cells and
// empty cells are real (each offers New session, and a click launches into
// that cell), so a drag never packs the whole grid:
// - onto another visible window: the dragged window takes that cell and the
//   windows between its old and new cells slide one place toward the cell it
//   left; empty and hidden cells in between stay where they are. Never a swap;
// - onto an empty cell: the window moves there, then the run of windows after
//   the cell it left slides back one cell to close it, up to the next empty
//   (or hidden) cell. A window dropped just past the others therefore joins
//   the end of their run, with no hole left in the middle;
// - unless that run is only the dragged window itself: the last window moved
//   into the empty cell after it stays there, which is how three open windows
//   put one in the bottom-right (live-caught by Pat before this rule existed).
// A hidden window's cell reads as empty, the way the stage draws it; one that
// a drop lands on moves to the first free cell and keeps its identity.
function placeDraggedTile({ tiles = [], sessionId, cell, isResolvable = () => true, maxTiles = 16 }) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= maxTiles) return tiles;
  const source = tiles.find(t => t.sessionId === sessionId);
  if (!source || source.slot === cell) return tiles;
  const visible = t => isResolvable(String(t.sessionId));
  const target = tiles.find(t => t.slot === cell && t !== source);
  if (target && visible(target)) {
    const lo = Math.min(source.slot, cell);
    const hi = Math.max(source.slot, cell);
    const inRange = tiles.filter(t => (t === source || visible(t)) && t.slot >= lo && t.slot <= hi).sort((a, b) => a.slot - b.slot);
    const cells = inRange.map(t => t.slot);
    const order = inRange.filter(t => t !== source);
    if (cell > source.slot) order.push(source); else order.unshift(source);
    const next = new Map(order.map((t, i) => [t, cells[i]]));
    return tiles.map(t => (next.has(t) ? { ...t, slot: next.get(t) } : t));
  }
  const vacated = source.slot;
  let placed = tiles.map(t => (t === source ? { ...t, slot: cell } : t));
  const bySlot = new Map(placed.filter(t => t.sessionId === sessionId || (t !== target && visible(t))).map(t => [t.slot, t]));
  const run = [];
  for (let c = vacated + 1; c < maxTiles && bySlot.has(c); c += 1) run.push(bySlot.get(c));
  if (run.length && !(run.length === 1 && run[0].sessionId === sessionId)) {
    const sliding = new Set(run);
    placed = placed.map(t => (sliding.has(t) ? { ...t, slot: t.slot - 1 } : t));
  }
  if (target) {
    const used = new Set(placed.filter(t => t.sessionId !== target.sessionId).map(t => t.slot));
    let free = 0;
    while (used.has(free)) free += 1;
    placed = placed.map(t => (t.sessionId === target.sessionId ? { ...t, slot: free } : t));
  }
  return placed;
}

module.exports = { resolveStage, pickEviction, placeNewTile, placeDraggedTile };
