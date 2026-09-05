'use strict';

// Hex-field editing rules for the list colour picker. Pure so the gate can
// prove the field is never rewritten mid-keystroke when the parent normalizes
// or when cleanColor expands a 3-digit shorthand.

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A prop-driven value must not clobber what the user is typing. */
function hexFieldMaySyncFromValue(focused) {
  return !focused;
}

function normalizeHexDraft(draft) {
  const trimmed = String(draft ?? '').trim();
  if (!HEX_RE.test(trimmed)) return null;
  const body = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  return `#${body.toLowerCase()}`;
}

/**
 * Blur/Enter settlement: commit a normalized colour, revert empty drafts, or
 * leave an invalid draft visible with the error shown.
 */
function settleHexDraft(draft, fallback) {
  const trimmed = String(draft ?? '').trim();
  if (!trimmed) {
    return { hex: fallback, invalid: false, commit: null };
  }
  const commit = normalizeHexDraft(trimmed);
  if (!commit) {
    return { hex: draft, invalid: true, commit: null };
  }
  return { hex: commit, invalid: false, commit };
}

module.exports = {
  hexFieldMaySyncFromValue,
  normalizeHexDraft,
  settleHexDraft,
};
