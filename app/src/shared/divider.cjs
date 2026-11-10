'use strict';

// Synthetic regression fixtures model resize damage measured on 2026-10-03.
// A clipped UTF-8 box edge can contain a replacement character. Only long,
// overwhelmingly intact edges may tolerate it; prose can never be an edge.
function isDividerLine(value, minimum = 8) {
  const line = String(value ?? '').trim();
  if (!line || /[^\u2500\u2501\u2014_\-\ufffd\ufffc]/u.test(line)) return false;
  const damaged = (line.match(/[\ufffd\ufffc]/gu) || []).length;
  const intact = line.length - damaged;
  if (!damaged) return intact >= minimum;
  return intact >= Math.max(minimum, 16) && damaged <= 3 && intact / line.length >= 0.9;
}

// A NAMED SESSION'S PROMPT CARRIES ITS NAME IN THE TOP EDGE (2026-11-02, CLI
// 2.1.316). Approving a plan named the session ("agent-name" in the transcript)
// and from then on the CLI drew "───…─── vm-template-build ─" over the
// prompt. isDividerLine refuses the words, so the composer was never found and
// every send into that pane stopped as `nobox` for an hour. Only the COMPOSER's
// edge takes the name; menus and dialogs keep the strict test above.
const NAMED_EDGE_RE = /^[─━]{8,} \S(?:.*\S)? [─━]+$/u;
function isComposerEdge(value, minimum = 8) {
  return isDividerLine(value, minimum) || NAMED_EDGE_RE.test(String(value ?? '').trim());
}

module.exports = { isDividerLine, isComposerEdge };
