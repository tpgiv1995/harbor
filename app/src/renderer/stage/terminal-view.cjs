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
  // Gemini (2026-11-23, DESIGN D12) also falls back for a PROVISIONAL pane: a profile that never ran
  // agy shows Google's colour-scheme and Terms screens before any conversation exists, the person
  // answers them (Harbor never does), and a send refuses until they have. That answer is typed in
  // this terminal, so a Gemini pane with no transcript yet must show it, not an empty window.
  const id = String(session?.id || '');
  const unnamed = id.startsWith('live:') || (session?.provider === 'gemini' && id.startsWith('pane:'));
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

// The line above a fallback terminal. Gemini's says where its first-run screens are answered.
function terminalFallbackNote(label) {
  const name = String(label || '').toLowerCase();
  const base = `this ${name} pane has not named its session yet; showing its terminal`;
  return name === 'gemini' ? `${base}. Answer Google's first-run screens here` : base;
}

module.exports = { terminalView, terminalFallbackNote, NON_CLAUDE_PROVIDERS, windowClickArms, headerKeepsKeys };
