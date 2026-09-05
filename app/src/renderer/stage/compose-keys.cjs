'use strict';

// Five levels since 2026-09-03 (Pat: "bullets maybe go to 2-3 levels, add
// ability to go to like 5"); three before that. The serializer and the parser
// nest to any depth, so the cap is this one number and the CSS indent.
const MAX_LIST_DEPTH = 5;

// The contenteditable supplies facts from its live DOM selection. This module
// owns only the keyboard decision, so the Node unit gate can prove every path
// without pretending to reproduce Chromium's editing engine.
function composeKeyVerdict({
  inList = false,
  inEmptyListItem = false,
  listDepth = 0,
  inQuote = false,
  inEmptyQuoteLine = false,
  shiftKey = false,
  key = '',
  inPre = false,
} = {}) {
  // inPre is deliberately part of the context even though both preformatted
  // and prose Shift+Enter are soft breaks. The JSX uses it to choose the
  // matching Chromium command after this decision has been made.
  void inPre;

  if (key === 'Enter') {
    if (shiftKey) return 'soft-break';
    // A list inside a quote is still a list: its Enter rules come first.
    if (inList) return inEmptyListItem ? 'exit-list' : 'new-list-item';
    // A quote behaves like a list (2026-09-03): Enter adds a line to the
    // quote, Enter on an empty last line leaves it. Before this, Enter inside a
    // quote submitted, so a quote could never hold a second line.
    if (inQuote) return inEmptyQuoteLine ? 'exit-quote' : 'new-quote-line';
    return 'submit';
  }

  if (key === 'Tab' && inList) {
    if (shiftKey) return 'outdent';
    // At the cap the Tab is swallowed, never handed to the browser: a default
    // Tab in a contenteditable moves focus to the next control (the mic button
    // sits right after the composer), so a user who keeps typing after one
    // Tab too many would be typing at a button (2026-09-03, with the cap
    // raised to five).
    return listDepth < MAX_LIST_DEPTH ? 'indent' : 'indent-blocked';
  }

  return 'default';
}

function listNormalizationVerdict({
  direction,
  beforeDepth = 0,
  afterDepth = 0,
  canIndent = false,
  canOutdent = false,
} = {}) {
  if (direction === 'indent' && canIndent && afterDepth !== beforeDepth + 1) return 'repair-indent';
  if (direction === 'outdent' && beforeDepth > 1 && canOutdent && afterDepth !== beforeDepth - 1) {
    return 'repair-outdent';
  }
  return 'keep';
}

// Auto-format on Space (Pat, 2026-09-03: "whenever i start typing a numbered
// or bulleted list like this (1. , I. , - , etc) i want it to auto-format").
// What the line must hold, in full, before the Space that converts it. Only a
// list's FIRST marker is a trigger: "1." (or any number, kept as the start),
// "I."/"i." for roman, "A."/"a." for letters, and ">" for a quote. The Word
// and Docs shape: the marker vanishes, the structure appears, and Backspace
// straight after puts the typed characters back (autoFormatRevertVerdict).
const AUTO_FORMAT_TRIGGERS = [
  { re: /^[-*•]$/, kind: 'bullets' },
  { re: /^(\d{1,9})[.)]$/, kind: 'numbers', start: (match) => Number(match[1]) },
  { re: /^I\.$/, kind: 'numbers', type: 'I' },
  { re: /^i\.$/, kind: 'numbers', type: 'i' },
  { re: /^A\.$/, kind: 'numbers', type: 'A' },
  { re: /^a\.$/, kind: 'numbers', type: 'a' },
  { re: /^>$/, kind: 'quote' },
];

function autoFormatVerdict({
  key = '',
  textBeforeCaret = '',
  collapsed = true,
  inList = false,
  inQuote = false,
  inPre = false,
  inCode = false,
} = {}) {
  if (key !== ' ' || !collapsed || inPre || inCode) return null;
  const text = String(textBeforeCaret);
  for (const trigger of AUTO_FORMAT_TRIGGERS) {
    const match = text.match(trigger.re);
    if (!match) continue;
    // A marker typed inside a list is text ("- " as a dash in a bullet, ">"
    // as a sign), and ">" inside a quote likewise; a list may start inside a
    // quote.
    if (inList || (trigger.kind === 'quote' && inQuote)) return null;
    return {
      kind: trigger.kind,
      marker: text,
      type: trigger.type || null,
      start: trigger.start ? trigger.start(match) : 1,
    };
  }
  return null;
}

// Backspace right after an auto-format, with nothing typed into the new
// structure, undoes the conversion and restores the typed marker. Any other
// key first, or any text in the structure, and Backspace is ordinary again.
function autoFormatRevertVerdict({
  key = '',
  pending = false,
  caretInside = false,
  stillEmpty = false,
  ctrlKey = false,
  altKey = false,
  metaKey = false,
} = {}) {
  if (key !== 'Backspace' || ctrlKey || altKey || metaKey) return 'keep';
  return pending && caretInside && stillEmpty ? 'revert' : 'keep';
}

module.exports = {
  MAX_LIST_DEPTH,
  AUTO_FORMAT_TRIGGERS,
  composeKeyVerdict,
  listNormalizationVerdict,
  autoFormatVerdict,
  autoFormatRevertVerdict,
};
