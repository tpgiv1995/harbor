'use strict';

// A model dialog has no transcript tool call. Publish the visible parser
// verdict so tile, rail and badge use the same evidence as its answer card.
function createDialogStore() {
  let snapshot = new Set();
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(id, blocked) {
      if (!id || snapshot.has(id) === Boolean(blocked)) return;
      snapshot = new Set(snapshot);
      if (blocked) snapshot.add(id);
      else snapshot.delete(id);
      for (const listener of listeners) listener();
    },
  };
}

module.exports = { createDialogStore };
