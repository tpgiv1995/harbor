'use strict';

// GFM-style table parsing for the markdown-lite renderer. Pure so the gate can
// prove the recognition rules without a DOM: md.jsx consumes the parse and only
// owns the JSX. Live-caught 2026-08-22: an assistant status message carrying a
// markdown table rendered as one wall of prose with literal pipes glued in,
// because the renderer had no table notion at all ("is that block supposed to
// be like a list?").
//
// Deliberately narrow, like the rest of markdown-lite:
// - A table is a HEADER row, a SEPARATOR row, then zero or more body rows.
//   Without the separator on line two, pipe-bearing lines are prose (a numbered
//   list discussing shell pipes must never become a two-column table).
// - Cells split on '|' with no escaped-pipe support; inline marks inside cells
//   are the renderer's job, not this parser's.
// - Ragged body rows are padded to the header width, and overlong rows keep
//   their tail glued into the last cell rather than silently dropping content.

// At least two pipes so a lone '|' inside prose never opens a table.
function looksLikeRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.includes('|')) return false;
  return (trimmed.match(/\|/g) || []).length >= 2 || trimmed.startsWith('|');
}

function isSeparatorLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.includes('-') || !trimmed.includes('|')) return false;
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = body.split('|');
  if (!cells.length) return false;
  return cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function splitRow(line) {
  const trimmed = String(line || '').trim();
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((cell) => cell.trim());
}

function alignOf(cell) {
  const c = String(cell || '').trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/**
 * Parse a run of consecutive lines into { header, align, rows } or null when
 * the run is not a table (no valid separator on the second line).
 */
function parseTableLines(lines) {
  const list = Array.isArray(lines) ? lines : [];
  if (list.length < 2) return null;
  if (!looksLikeRow(list[0]) || !isSeparatorLine(list[1])) return null;
  const header = splitRow(list[0]);
  if (!header.length) return null;
  const align = splitRow(list[1]).map(alignOf);
  while (align.length < header.length) align.push(null);
  const rows = [];
  for (const line of list.slice(2)) {
    if (!looksLikeRow(line)) continue;
    const cells = splitRow(line);
    while (cells.length < header.length) cells.push('');
    if (cells.length > header.length) {
      const tail = cells.splice(header.length - 1).join(' | ');
      cells.push(tail);
    }
    rows.push(cells);
  }
  return { header, align: align.slice(0, header.length), rows };
}

module.exports = { looksLikeRow, isSeparatorLine, parseTableLines };
