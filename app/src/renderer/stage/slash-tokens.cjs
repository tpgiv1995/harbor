'use strict';

// Slash-command recognition over the WHOLE draft, not just position 0.
//
// Pat, 2026-07-25: "in longer messages the slash command doesnt get
// 'recognized' with the different text". His long messages carry the command
// after other text (the /quality-appended-at-the-end pattern), and the old
// parser anchored on the start of the draft, so recognition simply never ran.
//
// Two tiers, deliberately different, because a leading slash declares command
// INTENT while a slash later in prose is usually a file path:
// - The LEADING token (very start of the draft) keeps the original semantics:
//   recolored valid-or-invalid, the valid/unknown hint, and the suggestion
//   popup with prefix + substring matching.
// - A NON-LEADING token is recolored ONLY when it exactly matches a known
//   command (a path must never light up red as "unknown command"), and only
//   the token still being typed at the very end of the draft opens the popup,
//   prefix-matched, needing at least one character after the slash.

// Every whitespace-delimited token that begins with '/'.
function parseSlashTokens(text) {
  const value = String(text || '');
  const tokens = [];
  const re = /(^|\s)(\/[^\s]*)/g;
  let match;
  while ((match = re.exec(value)) !== null) {
    tokens.push({ start: match.index + match[1].length, token: match[2] });
  }
  return tokens;
}

// The token the user is typing right now: it must run to the exact end of the
// draft. Anything else (a space typed after it, text beyond it) is committed
// prose and must not pop suggestions.
function activeSlashToken(text, tokens) {
  const value = String(text || '');
  const last = tokens.length ? tokens[tokens.length - 1] : null;
  if (!last) return null;
  if (last.start + last.token.length !== value.length) return null;
  return last;
}

// Suggestion list for the active token. Leading keeps the historical
// prefix-or-substring match; non-leading is prefix-only and needs at least
// "/x" so typing a path ("/home/...") barely flashes the popup.
function slashMatchesFor(active, commands) {
  if (!active) return [];
  const list = Array.isArray(commands) ? commands : [];
  const needle = active.token.toLowerCase();
  if (active.start === 0) {
    return list.filter((command) => command.name.toLowerCase().startsWith(needle)
      || command.name.toLowerCase().includes(needle.slice(1)));
  }
  if (needle.length < 2) return [];
  return list.filter((command) => command.name.toLowerCase().startsWith(needle));
}

// Paint plan: every token tagged with the colour it should get, keeping its
// offsets so the caller can find it again.
//
// 'ok' = exact known command; 'bad' = unknown LEADING token (command intent
// that will not resolve); a non-leading unknown stays 'plain', because it is
// almost always a file path and a path must never light up red as a failed
// command.
//
// The composer turns these offsets into DOM Ranges for the CSS Custom
// Highlight API. This is the ONLY place the rule lives, so the colour in the
// composer and any other consumer can never drift apart.
function classifySlashTokens(tokens, knownNames) {
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames || []);
  return (tokens || []).map(({ start, token }) => {
    const isKnown = known.has(token);
    return { start, token, kind: isKnown ? 'ok' : (start === 0 ? 'bad' : 'plain') };
  });
}

// What the composer chrome (stack shadow, hint badge) should say. The leading
// token keeps its valid/invalid verdict; without one, any known token later in
// the draft reads as valid; otherwise no slash chrome at all.
function slashChrome(tokens, knownNames) {
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames || []);
  if (!tokens.length) return { active: false, valid: null };
  const leading = tokens[0].start === 0 ? tokens[0] : null;
  if (leading) return { active: true, valid: known.has(leading.token) };
  const anyKnown = tokens.some(({ token }) => known.has(token));
  return anyKnown ? { active: true, valid: true } : { active: false, valid: null };
}

module.exports = {
  parseSlashTokens,
  activeSlashToken,
  slashMatchesFor,
  classifySlashTokens,
  slashChrome,
};
