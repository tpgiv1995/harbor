'use strict';

// The pure half of the phone header's two session buttons (2026-10-31, Pat:
// "the button to start a new session from an existing chat" and "a one click
// option ... to copy the session ID to my clipboard so I can easily paste it in
// for another session to reference"). Both already exist in the desktop window
// header (stage/SessionTile.jsx); the rules here are the same ones.

// A provisional pane (`pane:`) or an unresolved live row (`live:`) carries only
// a synthetic id that no other session can act on, so there is nothing real to
// copy until a transcript id lands. Desktop hides its button for these; the
// phone keeps the button's place and disables it.
const PROVISIONAL_ID = /^(pane|live):/;

function canCopySessionId(id) {
  const value = String(id ?? '').trim();
  return value.length > 0 && !PROVISIONAL_ID.test(value);
}

// What the New session sheet opens on when it is started from a chat: the chat's
// own folder, provider and plan (desktop's sibling button, `siblingSessionRequest`
// in renderer/new-session-defaults.cjs, resolves the same three). Model and
// effort are not carried: they keep the sheet's normal defaults. A chat with no
// known folder has nothing to start in, so there is no preset and the button
// is disabled.
function newSessionHerePreset(session) {
  const folder = typeof session?.cwd === 'string' ? session.cwd.trim() : '';
  if (!folder) return null;
  return {
    folder,
    provider: session.provider || 'claude',
    account: session.home || session.account || null,
    // The server adds this session's own folder to the folders it will accept,
    // so a worktree the rail has not listed yet still launches. Only a real id
    // can be looked up.
    sessionId: canCopySessionId(session.id) ? String(session.id) : null,
  };
}

module.exports = { canCopySessionId, newSessionHerePreset };
