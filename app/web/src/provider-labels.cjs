'use strict';

// How the phone names a session provider. One table for every phone surface (the New session
// sheet's tabs and summary, the shell's "New <provider> session" button, the header's context
// fact), because each used to hold its own { codex, cursor } literal and a fourth provider fell
// through every one of them: the sheet drew the raw id, and the header labelled a Gemini
// session "Claude" (2026-11-23, HARBOR-MAP G7).
const PROVIDER_LABEL = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
};

// `fallback` is what an unknown id reads as: the raw id where the surface shows a registry key
// (a tab for a provider the server offers must still be tappable and named), 'Claude' where the
// surface describes a session whose provider is simply unset (every pre-provider row is Claude).
function providerLabel(provider, fallback = provider || 'Claude') {
  return PROVIDER_LABEL[provider] || fallback;
}

module.exports = { PROVIDER_LABEL, providerLabel };
