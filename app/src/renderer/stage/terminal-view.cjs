'use strict';

// Whether a session window renders the raw terminal, and why. ONE rule, used
// by BOTH the tile (to draw the xterm) and the stage's visible-pane
// registration (to attach the observer that feeds it).
//
// They used to disagree, and the disagreement was invisible until sessiond:
// the tile rendered its terminal for `tty` OR the codex/cursor fallback, while
// the registration counted only `tty`. A fallback terminal therefore had no
// observer, no backfill and no frames, ever. Under the old backend the SELECTED
// tile was masked by its control child, but sessiond's
// control channel carries no output, so Pat watched a codex session write a
// 4.5MB conversation into a window showing an empty black box (2026-08-08).
// A surface that renders a terminal and a surface that feeds one must be the
// same decision, or the next divergence is another silent blank screen.

// Providers whose window is a transcript the daemon's pane does not feed (codex, cursor, gemini).
const NON_CLAUDE_PROVIDERS = ['codex', 'cursor', 'gemini'];

function terminalView({ session, data, pane, tty } = {}) {
  const hasPane = Boolean(pane);
  const nonClaude = NON_CLAUDE_PROVIDERS.includes(session?.provider);
  const noTranscript = !data || Boolean(data.missing);
  // The one designed fallback: a live pane Harbor cannot name (a `live:` row
  // no evidence resolved). With no id there is no transcript to render, and
  // the terminal is the only truthful view of what that agent is doing.
  //
  // Gemini's provisional pane (2026-11-24) is the designed window, like codex and cursor. Until then
  // (2026-11-23, DESIGN D12) it fell back to its terminal so Google's first-run pages could be answered
  // there; Pat opened a new Gemini window onto a raw terminal and called it no Harbor screen at all.
  // Those pages are now the Gemini setup card in the window (GeminiSetupCard.jsx, main/gemini-first-run.js).
  const id = String(session?.id || '');
  const unnamed = id.startsWith('live:');
  const fallback = Boolean(hasPane && nonClaude && noTranscript && unnamed);
  return {
    fallback,
    showTerminal: Boolean(hasPane && (tty || fallback)),
  };
}

// WHERE THE KEYBOARD GOES WHEN A WINDOW IS CLICKED (2026-10-24, Pat on /mcp:
// "if you toggle it back to the terminal then that doesnt work either"). He
// opened >_ and clicked the window's focus button a second later; the button
// kept keyboard focus, so every key he pressed went to it and the dialog in
// the terminal never moved (driven: three Down presses after that click left
// the /mcp pointer where it was; a click inside the terminal fixed it, and
// nothing on screen said so). A window showing its terminal is a terminal: a
// click on its header buttons keeps the keys in the terminal (`headerKeepsKeys`,
// so the mousedown must not move focus), and a click elsewhere on the window
// arms the terminal, not the command bar. Anything interactive (a button, an
// input, the terminal itself) and a finished text selection are left alone,
// as before.
function windowClickArms({ showTerminal = false, interactive = false, selecting = false } = {}) {
  if (interactive || selecting) return null;
  return showTerminal ? 'terminal' : 'composer';
}

function headerKeepsKeys({ showTerminal = false, onButton = false } = {}) {
  return Boolean(showTerminal && onButton);
}

// The line above a fallback terminal (Gemini's first-run pages are the setup card, never answered here).
function terminalFallbackNote(label) {
  const name = String(label || '').toLowerCase();
  return `this ${name} pane has not named its session yet; showing its terminal`;
}

module.exports = { terminalView, terminalFallbackNote, NON_CLAUDE_PROVIDERS, windowClickArms, headerKeepsKeys };
