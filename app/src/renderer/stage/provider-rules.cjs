'use strict';

// Per-provider window rules that the tile header and the command bar must read the SAME way.
// Before 2026-11-23 each held its own ['codex', 'cursor'] / ['claude', 'codex'] literal, and a
// fourth provider (Gemini) would have fallen through every one of them silently.

const { NON_CLAUDE_PROVIDERS } = require('./terminal-view.cjs');

// Providers whose plan badge rides inside the model chip, so a codex or gemini window's header
// reads like a claude one (codex 2026-10-31, gemini 2026-11-23). Any other provider that has a
// home keeps the trailing pill. A Gemini row with no home (the default profile never names one)
// shows no badge at all: ProfileBadge resolves nothing and renders null.
const PLAN_IN_CHIP = new Set(['claude', 'codex', 'gemini']);

function planInChip(provider) {
  return PLAN_IN_CHIP.has(provider || 'claude');
}

// A dead non-Claude session resumes on send (bin/ai --resume-id) EXCEPT when its working folder
// is unknown: a cursor transcript never records its cwd, and a Gemini conversation's records may
// not either, and an unmatched project cannot be resumed anywhere honest.
function nonClaudeDead({ dead, session } = {}) {
  return Boolean(dead && NON_CLAUDE_PROVIDERS.includes(session?.provider) && !session?.cwd);
}

module.exports = { PLAN_IN_CHIP, planInChip, nonClaudeDead };
