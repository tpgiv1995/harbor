'use strict';

// One rule: does a blank line inside a prose segment END the open list run,
// or is it just the gap between two items of the same list?
//
// Models (and people) write "1." for every item with a blank line between
// items; standard markdown still renders one numbered list, 1..N. md.jsx used
// to flush the open run on every blank line, so each item became its own
// single-item <ol> and every item rendered as "1." (live-caught by Pat,
// 2026-08-30, screenshot of a five-item reply numbered 1,1,1,1,1). The run
// stays open exactly when the next non-blank line is another list item.
const LIST_ITEM_RE = /^(\s*)([-*•]|\d{1,9}[.)])\s+/;

function isListItemLine(line) {
  return LIST_ITEM_RE.test(String(line ?? ''));
}

// lines: the segment's lines; blankIndex: the index of the blank line being
// considered; returns true when an open list run should stay open across it.
function continuesListRun(lines, blankIndex) {
  let ahead = blankIndex + 1;
  while (ahead < lines.length && !String(lines[ahead] ?? '').trim()) ahead += 1;
  return ahead < lines.length && isListItemLine(lines[ahead]);
}

module.exports = { continuesListRun, isListItemLine };
