// Synthetic regression fixtures model resize damage measured on 2026-10-03.
// A clipped UTF-8 box edge can contain a replacement character. Only long,
// overwhelmingly intact edges may tolerate it; prose can never be an edge.
export function isDividerLine(value, minimum = 8) {
  const line = String(value ?? '').trim();
  if (!line || /[^\u2500\u2501\u2014_\-\ufffd\ufffc]/u.test(line)) return false;
  const damaged = (line.match(/[\ufffd\ufffc]/gu) || []).length;
  const intact = line.length - damaged;
  if (!damaged) return intact >= minimum;
  return intact >= Math.max(minimum, 16) && damaged <= 3 && intact / line.length >= 0.9;
}

// A PROMPT BORDER CAN CARRY THE SESSION'S NAME (2026-11-18, Pat: "harbor is
// absolutely fucked right now"). Claude Code 2.1.321 draws a named session's
// title inside the top edge of its prompt box, right-aligned:
// "─(143) Gate decision G-107 test declaration conditions ─". isDividerLine
// refuses any line with letters in it (prose can never be an edge), so
// composerBox found no box at all in the Navigator's pane and every send into
// it would have failed as "nobox". This accepts an edge that is box-drawing
// characters on both ends with one title between them, and is used ONLY where
// Harbor locates Claude's prompt box; dialog parsers keep isDividerLine.
// Fixture: test/fixtures/composer-enter/titled-border-2.1.321.txt.
const TITLED_EDGE_RE = /^([\u2500\u2501]+) (\S.*?) ([\u2500\u2501]+)$/u;
export function isPromptEdgeLine(value, minimum = 8) {
  if (isDividerLine(value, minimum)) return true;
  const match = TITLED_EDGE_RE.exec(String(value ?? '').trim());
  return Boolean(match) && match[1].length + match[3].length >= minimum;
}
