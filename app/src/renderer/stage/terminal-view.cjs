'use strict';

// Whether a session window renders the raw terminal, and why. ONE rule, used
// by BOTH the tile (to draw the xterm) and the stage's visible-pane
// registration (to attach the observer that feeds it).
//
// They used to disagree, and the disagreement was invisible until sessiond:
// the tile rendered its terminal for `tty` OR the codex/cursor fallback, while
// the registration counted only `tty`. A fallback terminal therefore had no
// observer, no backfill and no frames, ever. Under herdr the SELECTED tile was
// masked (herdr's control child streams the pane on its own), but sessiond's
// control channel carries no output, so Pat watched a codex session write a
// 4.5MB conversation into a window showing an empty black box (2026-08-08).
// A surface that renders a terminal and a surface that feeds one must be the
// same decision, or the next divergence is another silent blank screen.

function terminalView({ session, data, pane, tty } = {}) {
  const hasPane = Boolean(pane);
  const nonClaude = ['codex', 'cursor'].includes(session?.provider);
  const noTranscript = !data || Boolean(data.missing);
  // The one designed fallback: a live pane Harbor cannot name (a `live:` row
  // no evidence resolved). With no id there is no transcript to render, and
  // the terminal is the only truthful view of what that agent is doing.
  const fallback = Boolean(hasPane && nonClaude && noTranscript
    && String(session?.id || '').startsWith('live:'));
  return {
    fallback,
    showTerminal: Boolean(hasPane && (tty || fallback)),
  };
}

module.exports = { terminalView };
