'use strict';

// CLAUDE'S LIVE WORKING LINE (2026-10-05). While a turn runs, Claude Code draws
// a spinner line above its composer, measured on CLI 2.1.289:
//   "✻ Seasoning… (1s · thinking)"
//   "✢ Seasoning… (3s · ↓ 25 tokens · thinking)"
//   "✽ Seasoning… (26s · ↓ 2.4k tokens)"
// The glyph and the verb change every frame; the parenthesis is the meter. It
// never reaches the transcript, so the window header reads it off the pane.
// Only a line whose parenthesis LEADS with an elapsed time counts, which keeps
// prose or a tool row that happens to contain "…(" from posing as the meter.
const WORK_LINE_RE = /^\s*\S\s+(\S[^…\n]{0,40}?)…\s*\(([^)\n]*)\)/;
const ELAPSED_RE = /^\d+[hms](?:\s+\d+[ms])*$/;
const TOKENS_RE = /^([↓↑])\s*([\d.,]+\s*[kKmM]?)\s+tokens?$/;
const SCAN_LINES = 16;

function parseWorkMeter(screen) {
  const lines = String(screen || '').split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - SCAN_LINES; i -= 1) {
    const match = WORK_LINE_RE.exec(lines[i]);
    if (!match) continue;
    const parts = match[2].split('·').map((part) => part.trim()).filter(Boolean);
    if (!parts.length || !ELAPSED_RE.test(parts[0])) continue;
    const tokens = parts.map((part) => TOKENS_RE.exec(part)).find(Boolean);
    return {
      verb: match[1].trim(),
      elapsed: parts[0],
      tokens: tokens ? `${tokens[1]} ${tokens[2].replace(/\s+/g, '')}` : null,
      thinking: parts.includes('thinking'),
    };
  }
  return null;
}

module.exports = { parseWorkMeter };
