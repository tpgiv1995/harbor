'use strict';

// A dialog drawn in the terminal has no hook-lane request and no transcript
// flag. Publish the card's own verdict so tile, rail and badge use the same
// evidence as its answer card.
//
// EVERY such dialog counts, not only the model-switch one this store first
// carried (2026-10-14, Pat: "i had my mahjong session sitting on a request to
// me for a while and didnt see it because its been showing like a blue 5").
// A permission prompt the hook lane hands back to the CLI (a guard ask, a
// simple Bash command, ExitPlanMode) draws only in the terminal, and on the
// session daemon nothing else reports it: the daemon sends no agent status and
// the transcript reader sets no blocked flag. The card saw the prompt; the
// badge, which only heard about model-switch dialogs, stayed blue for 24
// minutes.

// The poll results the card shows, which are exactly the ones that mean the
// session is waiting on you: a model switch, a menu with options (permission,
// question, resume), or the unrecognized-prompt panel.
// Gemini's first-run setup card (2026-11-24) is one too: the session waits on Pat's answer.
function liveDialog(next) {
  return next && (next.kind === 'model-switch' || next.kind === 'gemini-setup' || next.options?.length || next.fallback) ? next : null;
}

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

module.exports = { createDialogStore, liveDialog };
