import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
} from 'react';
import composeDoc from './compose-doc.cjs';
import composeKeys from './compose-keys.cjs';
import slashTokens from './slash-tokens.cjs';

const { serializeDoc, markdownToSpec, buildNodes } = composeDoc;
const {
  composeKeyVerdict, listNormalizationVerdict, autoFormatVerdict, autoFormatRevertVerdict,
} = composeKeys;
const { parseSlashTokens, classifySlashTokens } = slashTokens;

// The WYSIWYG composer. Real bold and real bullets on screen; markdown on the
// wire, because the destination is an agent's terminal and markdown is the only
// formatting that survives that trip.
//
// The contenteditable is UNCONTROLLED on purpose. Re-rendering it from React
// state on every keystroke would rebuild the DOM under the caret and destroy
// the selection, so the DOM is authoritative while typing and serializes OUT to
// the draft. The editor is rebuilt only when the draft changes from somewhere
// else (a session switch, voice transcription, a slash insert, a dropped file),
// which is detected by comparing against the last value this editor emitted.
//
// Two mechanisms the old textarea needed are deliberately gone rather than
// ported: the JS auto-grow (a contenteditable sizes itself) and the mirror
// layer that had to metric-match the textarea exactly. Slash colouring now uses
// the CSS Custom Highlight API, which paints ranges WITHOUT touching the DOM,
// so there is no caret to save and restore.

const HIGHLIGHT_OK = 'harbor-slash-ok';
const HIGHLIGHT_BAD = 'harbor-slash-bad';

// execCommand is deprecated but implemented, and Electron pins exactly one
// Chromium, so there is no cross-engine exposure. It is worth using because it
// brings list continuation, backspacing out of a bullet, and caret placement
// for free; hand-rolling those is where contenteditable editors go wrong.
const exec = (command, value = null) => {
  try { return document.execCommand(command, false, value); } catch { return false; }
};

function closestTag(node, tags, root) {
  let current = node;
  while (current && current !== root) {
    if (current.nodeType === 1 && tags.includes(current.nodeName)) return current;
    current = current.parentNode;
  }
  return null;
}

function listDepthFrom(node, root) {
  let depth = 0;
  let current = node;
  while (current && current !== root) {
    if (current.nodeType === 1 && (current.nodeName === 'UL' || current.nodeName === 'OL')) depth += 1;
    current = current.parentNode;
  }
  return depth;
}

function listItemOwnText(item) {
  if (!item) return '';
  return Array.from(item.childNodes || [])
    .filter((child) => child.nodeName !== 'UL' && child.nodeName !== 'OL')
    .map((child) => child.textContent || '')
    .join('');
}

function nextContentSibling(node) {
  let sibling = node?.nextSibling || null;
  while (sibling && sibling.nodeType === 3 && !String(sibling.textContent || '').trim()) {
    sibling = sibling.nextSibling;
  }
  return sibling;
}

function selectionContext(root) {
  const anchor = window.getSelection()?.anchorNode;
  const item = closestTag(anchor, ['LI'], root);
  const list = closestTag(anchor, ['UL', 'OL'], root);
  const quote = closestTag(anchor, ['BLOCKQUOTE'], root);
  // A quote's lines are divs (normalizeQuoteLines); bare inline content
  // straight inside the blockquote counts as its one line.
  const quoteLine = quote ? (closestTag(anchor, ['DIV', 'P'], quote) || quote) : null;
  const lastQuoteLine = Boolean(quoteLine) && (quoteLine === quote || !nextContentSibling(quoteLine));
  return {
    item,
    list,
    inList: Boolean(item && list),
    inEmptyListItem: Boolean(item && !listItemOwnText(item).trim()),
    listDepth: listDepthFrom(list, root),
    inPre: Boolean(closestTag(anchor, ['PRE'], root)),
    inCode: Boolean(closestTag(anchor, ['CODE'], root)),
    quote,
    quoteLine,
    inQuote: Boolean(quote),
    inEmptyQuoteLine: Boolean(quote && lastQuoteLine && !String(quoteLine.textContent || '').trim()),
  };
}

function directListItemSibling(item, direction) {
  let sibling = item?.[direction] || null;
  while (sibling && sibling.nodeName !== 'LI') sibling = sibling[direction];
  return sibling;
}

function listEditSnapshot(root) {
  const context = selectionContext(root);
  const parentItem = context.list ? closestTag(context.list.parentNode, ['LI'], root) : null;
  return {
    ...context,
    previousItem: directListItemSibling(context.item, 'previousSibling'),
    parentItem,
    outerList: parentItem ? closestTag(parentItem.parentNode, ['UL', 'OL'], root) : null,
    existingArtifacts: new Set(context.item?.querySelectorAll?.('blockquote,span[style]') || []),
  };
}

function unwrapNode(node) {
  const parent = node?.parentNode;
  if (!parent) return;
  while (node.firstChild) parent.insertBefore(node.firstChild, node);
  parent.removeChild(node);
}

function removeNewIndentArtifacts(snapshot) {
  const item = snapshot.item;
  if (!item) return;
  for (const node of item.querySelectorAll?.('blockquote,span[style]') || []) {
    if (snapshot.existingArtifacts.has(node)) continue;
    if (node.nodeName === 'BLOCKQUOTE' || /(?:margin|padding)-left|text-indent/i.test(node.getAttribute('style') || '')) {
      unwrapNode(node);
    }
  }
  for (const property of ['margin-left', 'padding-left', 'text-indent']) item.style?.removeProperty(property);
}

function removeEmptyIndentWrapper(node, root) {
  let current = node;
  while (current && current !== root && current.nodeName !== 'UL' && current.nodeName !== 'OL') {
    const parent = current.parentNode;
    if (!String(current.textContent || '').trim() && !current.querySelector?.('li')) current.remove();
    current = parent;
  }
}

// Chromium normally builds the correct nested list. Some contenteditable DOM
// shapes instead receive a blockquote or a left-indented span. Only that failed
// shape is repaired here; successful native list DOM is left untouched.
function normalizeListEdit(root, snapshot, direction) {
  const item = snapshot.item;
  if (!item || !root.contains(item)) return;
  const actualDepth = listDepthFrom(item, root);
  const normalization = listNormalizationVerdict({
    direction,
    beforeDepth: snapshot.listDepth,
    afterDepth: actualDepth,
    canIndent: Boolean(snapshot.previousItem),
    canOutdent: Boolean(snapshot.parentItem && snapshot.outerList),
  });

  if (normalization === 'repair-indent') {
    let nested = Array.from(snapshot.previousItem.children || [])
      .find((child) => child.nodeName === snapshot.list.nodeName);
    if (!nested) {
      nested = document.createElement(snapshot.list.nodeName.toLowerCase());
      snapshot.previousItem.appendChild(nested);
    }
    const oldParent = item.parentNode;
    nested.appendChild(item);
    removeEmptyIndentWrapper(oldParent, root);
    removeNewIndentArtifacts(snapshot);
    return;
  }

  if (normalization === 'repair-outdent') {
    const oldList = item.parentNode;
    snapshot.outerList.insertBefore(item, snapshot.parentItem.nextSibling);
    if (!oldList.querySelector?.('li')) oldList.remove();
    removeNewIndentArtifacts(snapshot);
  }
}

function caretToEnd(root) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

// Inline code has no execCommand, so it is the one mark done by hand.
function toggleInlineCode(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  const existing = closestTag(range.commonAncestorContainer, ['CODE'], root);
  if (existing) {
    const parent = existing.parentNode;
    while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
    parent.removeChild(existing);
    return;
  }
  if (range.collapsed) return;
  const code = document.createElement('code');
  try {
    range.surroundContents(code);
  } catch {
    // surroundContents refuses a range that only partly covers a node; taking
    // the contents out first always works.
    code.appendChild(range.extractContents());
    range.insertNode(code);
  }
}

// ── lines, quotes, and auto-format ──────────────────────────────────────────

const LINE_TAGS = ['DIV', 'P', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
const LIST_TAGS = ['UL', 'OL'];
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

function isLineBoundary(node) {
  return node?.nodeType === 1
    && (node.nodeName === 'BR' || LINE_TAGS.includes(node.nodeName) || LIST_TAGS.includes(node.nodeName));
}

// Chromium leaves the first line of a contenteditable as bare inline nodes
// under the root and wraps every later line in a div, so "the line the caret
// is on" is either a block or a run of top-level inline siblings between line
// boundaries. Both shapes resolve here.
function topLevelNode(root, node) {
  let top = node;
  while (top && top.parentNode && top.parentNode !== root) top = top.parentNode;
  return top && top.parentNode === root ? top : null;
}

function inlineRunAround(top) {
  let start = top;
  while (start.previousSibling && !isLineBoundary(start.previousSibling)) start = start.previousSibling;
  let end = top;
  while (end.nextSibling && !isLineBoundary(end.nextSibling)) end = end.nextSibling;
  const nodes = [];
  for (let current = start; current; current = current.nextSibling) {
    nodes.push(current);
    if (current === end) break;
  }
  return nodes;
}

// The top-level nodes making up the line that holds `node`: one block child of
// the root, or the bare inline run. An empty editor gets a line to work in.
function lineNodesAround(root, node, offset = 0) {
  let target = node;
  if (target === root) {
    target = root.childNodes[Math.min(offset, root.childNodes.length - 1)] || null;
    if (!target) {
      const line = document.createElement('div');
      line.appendChild(document.createElement('br'));
      root.appendChild(line);
      return [line];
    }
  }
  const top = topLevelNode(root, target);
  if (!top) return [];
  if (top.nodeType === 1 && (LINE_TAGS.includes(top.nodeName) || LIST_TAGS.includes(top.nodeName))) return [top];
  return inlineRunAround(top);
}

// Text on the caret's line before the caret, for the auto-format triggers. The
// marker is typed text, so the caret sits in a text node; a caret parked on an
// element is not a trigger position.
function lineTextBeforeCaret(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const { startContainer: node, startOffset: offset } = selection.getRangeAt(0);
  if (node.nodeType !== 3 || !root.contains(node)) return null;
  const block = closestTag(node, LINE_TAGS, root);
  const scope = block || root;
  const from = block ? null : inlineRunAround(topLevelNode(root, node))[0];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let text = '';
  let started = !from;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (!started) {
      if (current === from || from.contains(current)) started = true;
      else continue;
    }
    if (current === node) break;
    if (isLineBoundary(current)) { text = ''; continue; }
    if (current.nodeType === 3) text += current.textContent || '';
  }
  text += String(node.textContent || '').slice(0, offset);
  return { text, node, offset };
}

function placeCaretAtStart(node) {
  const selection = window.getSelection();
  if (!selection || !node) return;
  const range = document.createRange();
  range.setStart(node, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

// Any text on the caret's line AFTER the caret, up to the next line boundary.
// The auto-format triggers require the marker to be the whole line, so a caret
// parked in front of existing text ("1.| existing") must not convert.
function hasLineTextAfter(root, node) {
  const block = closestTag(node, LINE_TAGS, root);
  const scope = block || root;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current && current !== node) current = walker.nextNode();
  for (current = walker.nextNode(); current; current = walker.nextNode()) {
    if (isLineBoundary(current)) return false;
    if (current.nodeType === 3 && String(current.textContent || '').trim()) return true;
  }
  return false;
}

// The Space converts only when the marker is EXACTLY the caret's line: one text
// node holding the marker right before the caret, and nothing after the caret
// on that line. A marker split across styled nodes (`<b>1</b>.`) or a caret
// left mid-line would otherwise swallow the Space without formatting anything.
function autoFormatApplies(root, verdict, line) {
  const { node, offset } = line;
  if (!node || node.nodeType !== 3) return false;
  const { marker } = verdict;
  if (String(node.textContent).slice(Math.max(0, offset - marker.length), offset) !== marker) return false;
  // ANY character after the caret in this node, whitespace included, means the
  // caret is not at the line end and the Space is ordinary input, not a trigger
  // (2026-09-03: a caret before existing spaces must not auto-format).
  if (String(node.textContent).slice(offset) !== '') return false;
  return !hasLineTextAfter(root, node);
}

// Every line inside a quote is a div, so Enter splits a LINE and stays in the
// quote. Given bare inline content in a blockquote, Chromium's Enter splits
// the BLOCKQUOTE into two, which is the "two quotes with a gap" Pat kept
// hitting, and formatBlock('<div>') inside one only nests a div, which is why
// the old button could never turn a quote off (2026-09-03).
function normalizeQuoteLines(quote) {
  let line = null;
  for (const child of Array.from(quote.childNodes)) {
    if (child.nodeType === 1 && (LINE_TAGS.includes(child.nodeName) || LIST_TAGS.includes(child.nodeName))) {
      line = null;
      continue;
    }
    if (child.nodeName === 'BR') {
      if (!line) {
        line = document.createElement('div');
        quote.insertBefore(line, child);
        line.appendChild(document.createElement('br'));
      }
      quote.removeChild(child);
      line = null;
      continue;
    }
    if (!line) {
      line = document.createElement('div');
      quote.insertBefore(line, child);
    }
    line.appendChild(child);
  }
  for (const child of Array.from(quote.children)) {
    if (child.nodeName === 'DIV' && !child.childNodes.length) child.appendChild(document.createElement('br'));
  }
}

// Wrap the selected line(s) in one quote. Returns the quote's first line.
function wrapInQuote(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const first = lineNodesAround(root, range.startContainer, range.startOffset);
  if (!first.length) return null;
  const last = range.collapsed ? first : lineNodesAround(root, range.endContainer, range.endOffset);
  const startNode = first[0];
  let endNode = (last.length ? last : first).at(-1);
  if (endNode !== startNode && !(startNode.compareDocumentPosition(endNode) & Node.DOCUMENT_POSITION_FOLLOWING)) {
    endNode = first.at(-1);
  }
  const nodes = [];
  for (let current = startNode; current; current = current.nextSibling) {
    nodes.push(current);
    if (current === endNode) break;
  }
  const quote = document.createElement('blockquote');
  root.insertBefore(quote, startNode);
  for (const node of nodes) quote.appendChild(node);
  normalizeQuoteLines(quote);
  return quote.firstElementChild || quote;
}

function unwrapQuote(quote) {
  normalizeQuoteLines(quote);
  const parent = quote.parentNode;
  if (!parent) return null;
  const first = quote.firstChild;
  while (quote.firstChild) parent.insertBefore(quote.firstChild, quote);
  parent.removeChild(quote);
  return first;
}

// The quote button and Ctrl+Shift+9: off when the caret is in a quote, on
// around the current line(s) otherwise. A line with no text has no offsets for
// withCaretPreserved to restore, so the caret is placed by hand.
function toggleQuote(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const anchor = selection.anchorNode;
  const existing = closestTag(selection.getRangeAt(0).commonAncestorContainer, ['BLOCKQUOTE'], root);
  let line;
  if (existing) {
    const caretLine = closestTag(anchor, ['DIV', 'P'], existing);
    line = unwrapQuote(existing);
    if (caretLine?.parentNode) line = caretLine;
  } else {
    line = wrapInQuote(root);
  }
  if (line && !String(line.textContent || '').trim()) placeCaretAtStart(line);
}

// Enter on the empty last line of a quote leaves the quote: the empty line
// goes, a plain line follows the quote, and an emptied quote goes with it.
function exitQuote(context) {
  const { quote, quoteLine } = context;
  const parent = quote?.parentNode;
  if (!parent) return;
  const after = document.createElement('div');
  after.appendChild(document.createElement('br'));
  if (quoteLine && quoteLine !== quote) quoteLine.remove();
  if (!String(quote.textContent || '').trim() && !quote.querySelector('li,pre')) {
    parent.insertBefore(after, quote);
    quote.remove();
  } else {
    parent.insertBefore(after, quote.nextSibling);
  }
  placeCaretAtStart(after);
}

// The Space that follows a trigger: the marker is deleted (it is the last
// characters before the caret, in one text node) and the structure takes its
// place. Returns what a following Backspace needs in order to undo it.
function applyAutoFormat(root, verdict, line) {
  const { node, offset } = line;
  const { marker } = verdict;
  if (String(node.textContent || '').slice(offset - marker.length, offset) !== marker) return null;
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(node, offset - marker.length);
  range.setEnd(node, offset);
  selection.removeAllRanges();
  selection.addRange(range);
  exec('delete');
  if (verdict.kind === 'quote') {
    const first = wrapInQuote(root);
    if (!first) return null;
    placeCaretAtStart(first);
    return { kind: 'quote', marker, node: first, quote: first.parentNode };
  }
  // The list Chromium builds is the one that was not there before: after the
  // marker is deleted the caret can sit on the root itself, where walking up
  // from the anchor finds nothing.
  const before = new Set(root.querySelectorAll('ul,ol'));
  exec(verdict.kind === 'bullets' ? 'insertUnorderedList' : 'insertOrderedList');
  const anchor = window.getSelection()?.anchorNode;
  const list = closestTag(anchor, LIST_TAGS, root)
    || Array.from(root.querySelectorAll('ul,ol')).find((candidate) => !before.has(candidate))
    || null;
  const item = closestTag(anchor, ['LI'], root)
    || (list && Array.from(list.children).find((child) => child.nodeName === 'LI' && child.contains(anchor)))
    || list?.querySelector('li')
    || null;
  if (list && verdict.kind === 'numbers') {
    if (verdict.type) list.setAttribute('type', verdict.type);
    if (verdict.start !== 1) list.setAttribute('start', String(verdict.start));
  }
  // Chromium can leave the caret on the root beside the new list (typing still
  // lands in the item, but a Backspace verdict asks where the caret IS), so it
  // is put inside the item explicitly.
  if (item && !item.contains(window.getSelection()?.anchorNode ?? null)) placeCaretAtStart(item);
  return item ? { kind: verdict.kind, marker, node: item } : null;
}

// The structure goes and a plain line holding the typed marker takes its
// place, by hand: toggling the list off through execCommand leaves the caret
// nowhere when the list was the editor's only content, and the marker then
// went nowhere too (drive-caught 2026-09-03).
function revertAutoFormat(root, pending) {
  const text = `${pending.marker} `;
  const line = document.createElement('div');
  line.textContent = text;
  if (pending.kind === 'quote') {
    const quote = pending.quote;
    if (quote?.parentNode) {
      quote.parentNode.insertBefore(line, quote);
      quote.remove();
    } else {
      root.appendChild(line);
    }
  } else {
    const item = pending.node;
    const list = closestTag(item, LIST_TAGS, root);
    if (!list) {
      root.appendChild(line);
    } else if (list.querySelectorAll('li').length <= 1) {
      list.parentNode.insertBefore(line, list);
      list.remove();
    } else {
      // "- " typed right under an existing list joins it as a new item, so
      // only that item comes out again.
      const after = item.nextSibling ? item : null;
      item.remove();
      if (after) list.parentNode.insertBefore(line, list);
      else list.parentNode.insertBefore(line, list.nextSibling);
    }
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(line.firstChild, text.length);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

// Build the editor's visible text plus a node/offset map, so a slash token
// found in that text can be turned back into a DOM Range. Block boundaries
// contribute a newline that belongs to no node: without it a token opening a
// new line would not match the tokenizer's "start or whitespace" rule.
function visibleTextMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spans = [];
  let text = '';
  let previousBlock = null;
  let node = walker.nextNode();
  while (node) {
    const block = closestTag(node, ['DIV', 'P', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'], root) || root;
    if (previousBlock && block !== previousBlock) text += '\n';
    previousBlock = block;
    const value = node.textContent || '';
    spans.push({ node, start: text.length, end: text.length + value.length });
    text += value;
    node = walker.nextNode();
  }
  return { text, spans };
}

function pointAt(spans, offset) {
  for (const span of spans) {
    if (offset >= span.start && offset <= span.end) {
      return { node: span.node, offset: offset - span.start };
    }
  }
  return null;
}

function rangeFor(spans, start, end) {
  const from = pointAt(spans, start);
  const to = pointAt(spans, end);
  if (!from || !to) return null;
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range;
}

// Chromium's block commands collapse the selection to the start of the block
// they just built: typing "first item" then clicking the bullet button leaves
// the caret at offset 0, so the next keystroke lands in front of the text
// (live-caught 2026-07-26, driven). None of the formatting commands change the
// TEXT, only its structure, so remembering the caret as a character offset and
// putting it back is exact.
function selectionOffsets(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const { spans } = visibleTextMap(root);
  const offsetOf = (node, offset) => {
    const span = spans.find((entry) => entry.node === node);
    return span ? span.start + offset : null;
  };
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return { start, end };
}

function restoreSelection(root, saved) {
  if (!saved) return;
  const { spans } = visibleTextMap(root);
  const range = rangeFor(spans, saved.start, saved.end);
  if (!range) return;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Run a BLOCK command with the caret where the user left it. A command that
// already landed the caret correctly restores to the same place, so this is a
// no-op rather than a second correction.
//
// Only block commands get this. An inline mark pressed with a COLLAPSED caret
// sets Chromium's pending typing style ("bold from here on"), and that pending
// style is discarded the moment anything touches the selection: restoring here
// would silently strip the formatting off text the user then types, which is
// exactly how Ctrl+B, type, Ctrl+B lost its bold (live-caught 2026-07-26).
function withCaretPreserved(root, run) {
  const saved = selectionOffsets(root);
  run();
  restoreSelection(root, saved);
}

// Blocks that count as content even when they hold no text: a bullet the user
// just added to an empty composer is something they made, not leftovers.
const STRUCTURAL = 'ul,ol,pre,blockquote,h1,h2,h3,h4,h5,h6';

// Emptying the composer leaves Chromium's pending typing style behind
// ("underlined from here on"), so the NEXT message comes out silently
// formatted even though the box looked blank (live-caught 2026-07-26: clearing
// an underlined draft and retyping produced <u>~~text~~</u> again). Nothing
// clears that style reliably, not removeFormat and not toggling the mark off,
// but replacing the contents gives a fresh caret with no style to inherit.
function resetIfBare(root) {
  if (!root || !root.childNodes.length) return;
  if (String(root.textContent || '').trim()) return;
  if (root.querySelector(STRUCTURAL)) return;
  const focused = document.activeElement === root;
  root.replaceChildren();
  // Emptying the node strands the selection outside the editor, and Chromium
  // then falls back to the LAST typing style it knew, which is the very thing
  // being cleared here. Putting a caret back inside recomputes the style from
  // the now-empty editor.
  if (focused) caretToEnd(root);
}

function paintSlashHighlights(root, knownNames) {
  // Absent in an older engine; the valid/unknown badge still reports the same
  // fact, so the loss is colour only.
  if (!window.CSS?.highlights || typeof window.Highlight !== 'function') return;
  const { text, spans } = visibleTextMap(root);
  const ok = [];
  const bad = [];
  // The ok/bad/plain rule lives in slash-tokens.cjs and nowhere else, so the
  // colour here can never drift from the valid/unknown badge beside it.
  for (const { start, token, kind } of classifySlashTokens(parseSlashTokens(text), knownNames)) {
    if (kind === 'plain') continue;
    const range = rangeFor(spans, start, start + token.length);
    if (!range) continue;
    (kind === 'ok' ? ok : bad).push(range);
  }
  window.CSS.highlights.set(HIGHLIGHT_OK, new window.Highlight(...ok));
  window.CSS.highlights.set(HIGHLIGHT_BAD, new window.Highlight(...bad));
}

function clearSlashHighlights() {
  if (!window.CSS?.highlights) return;
  window.CSS.highlights.delete(HIGHLIGHT_OK);
  window.CSS.highlights.delete(HIGHLIGHT_BAD);
}

// ── toolbar ─────────────────────────────────────────────────────────────────

const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const IconBullets = () => (
  <Icon>
    <circle cx="5" cy="7" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="5" cy="17" r="1.4" fill="currentColor" stroke="none" />
    <path d="M10 7h9M10 12h9M10 17h9" />
  </Icon>
);

const IconNumbers = () => (
  <Icon>
    <path d="M10 7h9M10 12h9M10 17h9" />
    <text x="2" y="9" fontSize="7" fill="currentColor" stroke="none">1</text>
    <text x="2" y="14.5" fontSize="7" fill="currentColor" stroke="none">2</text>
    <text x="2" y="20" fontSize="7" fill="currentColor" stroke="none">3</text>
  </Icon>
);

const IconQuote = () => (
  <Icon>
    <path d="M5 6v12" strokeWidth="2.4" />
    <path d="M10 8h9M10 12h9M10 16h6" />
  </Icon>
);

const IconCode = () => (
  <Icon><path d="M9 7l-5 5 5 5M15 7l5 5-5 5" /></Icon>
);

const IconCodeBlock = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M9 10l-2 2 2 2M15 10l2 2-2 2" />
  </Icon>
);

const IconLink = () => (
  <Icon><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></Icon>
);

const IconClear = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

// Everything here survives the trip to Claude as markdown. Font colour,
// highlight, and font size are deliberately absent even though Teams has them:
// Teams renders rich text, Harbor types into a terminal, so those would be
// controls that silently do nothing on the wire.
const TOOLBAR = [
  [
    { key: 'bold', title: 'Bold  (Ctrl+B)', label: 'B', state: 'bold', run: () => exec('bold') },
    { key: 'italic', title: 'Italic  (Ctrl+I)', label: 'I', state: 'italic', run: () => exec('italic') },
    { key: 'underline', title: 'Underline  (Ctrl+U)', label: 'U', state: 'underline', run: () => exec('underline') },
    { key: 'strike', title: 'Strikethrough  (Ctrl+Shift+X)', label: 'S', state: 'strikeThrough', run: () => exec('strikeThrough') },
  ],
  [
    { key: 'heading', block: true, title: 'Heading', label: 'H', run: (root) => exec('formatBlock', closestTag(window.getSelection()?.anchorNode, ['H2'], root) ? '<div>' : '<h2>') },
    { key: 'bullets', block: true, title: 'Bulleted list  (Ctrl+Shift+8)', icon: <IconBullets />, state: 'insertUnorderedList', run: () => exec('insertUnorderedList') },
    { key: 'numbers', block: true, title: 'Numbered list  (Ctrl+Shift+7)', icon: <IconNumbers />, state: 'insertOrderedList', run: () => exec('insertOrderedList') },
    { key: 'quote', block: true, title: 'Quote  (Ctrl+Shift+9)', icon: <IconQuote />, run: (root) => toggleQuote(root) },
  ],
  [
    { key: 'code', title: 'Inline code  (Ctrl+E)', icon: <IconCode />, run: (root) => toggleInlineCode(root) },
    { key: 'codeblock', block: true, title: 'Code block', icon: <IconCodeBlock />, run: (root) => exec('formatBlock', closestTag(window.getSelection()?.anchorNode, ['PRE'], root) ? '<div>' : '<pre>') },
    { key: 'link', title: 'Link', icon: <IconLink />, link: true },
  ],
  [
    { key: 'clear', block: true, title: 'Clear formatting', icon: <IconClear />, run: () => { exec('removeFormat'); exec('formatBlock', '<div>'); } },
  ],
];

// ── component ───────────────────────────────────────────────────────────────

export const ComposeEditor = forwardRef(function ComposeEditor({
  value,
  onChange,
  onSubmit,
  onPasteImage,
  onKeyDown,
  disabled,
  placeholder,
  ariaInvalid,
  formatOpen,
  knownCommandNames,
  submitOnEnter = true,
  className = '',
}, ref) {
  const editorRef = useRef(null);
  // What this editor last serialized out. Anything arriving in `value` that is
  // not this came from somewhere else and means "rebuild".
  const lastEmittedRef = useRef('');
  const [marks, setMarks] = useState({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const savedRangeRef = useRef(null);
  // The structure the last Space auto-format built, until the next key.
  const autoFormatRef = useRef(null);

  useImperativeHandle(ref, () => ({
    focus() { editorRef.current?.focus(); },
    get element() { return editorRef.current; },
  }), []);

  const emit = useCallback(() => {
    const root = editorRef.current;
    if (!root) return;
    resetIfBare(root);
    const markdown = serializeDoc(root);
    lastEmittedRef.current = markdown;
    onChange?.(markdown);
  }, [onChange]);

  // Rebuild ONLY on an outside write. Comparing against the last emitted value
  // is what keeps this from fighting the caret on every keystroke.
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    const incoming = String(value ?? '');
    if (incoming === lastEmittedRef.current) return;
    root.replaceChildren();
    if (incoming) root.appendChild(buildNodes(markdownToSpec(incoming), document));
    lastEmittedRef.current = incoming;
    if (document.activeElement === root) caretToEnd(root);
  }, [value]);

  // Slash colouring rides the value, so it repaints for typed AND inserted
  // text without a second trigger.
  useLayoutEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    paintSlashHighlights(root, knownCommandNames);
  }, [value, knownCommandNames]);

  useEffect(() => () => clearSlashHighlights(), []);

  // Semantic tags, never styled spans. The serializer recognises <b>/<i>/<u>;
  // a <span style="font-weight:bold"> would render as bold on screen and then
  // silently arrive at the agent as plain text. Chromium already defaults this
  // way, but the default is per-document state that anything could flip.
  useEffect(() => {
    exec('styleWithCSS', false);
    exec('defaultParagraphSeparator', 'div');
  }, []);

  // What the toolbar should be showing as active right now.
  const readMarks = useCallback(() => {
    const root = editorRef.current;
    if (!root || !root.contains(document.getSelection()?.anchorNode ?? null)) return;
    const next = {};
    for (const group of TOOLBAR) {
      for (const item of group) {
        if (!item.state) continue;
        try { next[item.key] = document.queryCommandState(item.state); } catch { next[item.key] = false; }
      }
    }
    next.code = Boolean(closestTag(document.getSelection()?.anchorNode, ['CODE'], root));
    next.quote = Boolean(closestTag(document.getSelection()?.anchorNode, ['BLOCKQUOTE'], root));
    setMarks(next);
  }, []);

  // Toolbar lit-state follows the caret. selectionchange alone is NOT enough:
  // pressing B with a collapsed caret sets a typing style without moving the
  // selection, so the event never fires and the button stayed dark while bold
  // was in fact on (live-caught 2026-07-26). Every command re-reads directly.
  useEffect(() => {
    if (!formatOpen) return undefined;
    document.addEventListener('selectionchange', readMarks);
    readMarks();
    return () => document.removeEventListener('selectionchange', readMarks);
  }, [formatOpen, readMarks]);

  const runItem = (item) => {
    const root = editorRef.current;
    if (!root) return;
    root.focus();
    if (item.link) {
      const selection = window.getSelection();
      savedRangeRef.current = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      setLinkUrl('');
      setLinkOpen((open) => !open);
      return;
    }
    if (item.block) withCaretPreserved(root, () => item.run(root));
    else item.run(root);
    emit();
    readMarks();
  };

  const applyLink = () => {
    const root = editorRef.current;
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!root || !url) return;
    root.focus();
    const selection = window.getSelection();
    if (savedRangeRef.current && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRangeRef.current);
    }
    // With nothing selected there is no anchor text, so the URL becomes its own
    // label rather than producing an invisible empty link.
    if (selection?.isCollapsed) exec('insertText', url);
    const restored = window.getSelection();
    if (restored?.isCollapsed) {
      const range = restored.getRangeAt(0).cloneRange();
      range.setStart(range.startContainer, Math.max(0, range.startOffset - url.length));
      restored.removeAllRanges();
      restored.addRange(range);
    }
    exec('createLink', url);
    emit();
  };

  const handleKeyDown = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const root = editorRef.current;
    const context = selectionContext(root);

    // Backspace straight after an auto-format puts the typed marker back.
    const pending = autoFormatRef.current;
    if (autoFormatRevertVerdict({
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      pending: Boolean(pending),
      caretInside: Boolean(pending?.node && root.contains(pending.node)
        && pending.node.contains(window.getSelection()?.anchorNode ?? null)),
      stillEmpty: Boolean(pending?.node && !String(pending.node.textContent || '').trim()),
    }) === 'revert') {
      event.preventDefault();
      autoFormatRef.current = null;
      revertAutoFormat(root, pending);
      emit();
      readMarks();
      return;
    }
    if (!MODIFIER_KEYS.has(event.key)) autoFormatRef.current = null;

    // "- ", "1. ", "I. ", "a. ", "> " at the start of a line become the
    // structure they name (Pat, 2026-09-03). The verdict is pure and tested;
    // this only supplies the line text and applies the result.
    // isComposing guards an IME: a Space that commits a composition must stay
    // the IME's, never trigger auto-format (2026-09-03).
    if (event.key === ' ' && !event.ctrlKey && !event.altKey && !event.metaKey
      && !event.isComposing && !event.nativeEvent?.isComposing) {
      const line = lineTextBeforeCaret(root);
      const auto = line && autoFormatVerdict({
        key: ' ',
        textBeforeCaret: line.text,
        collapsed: true,
        inList: context.inList,
        inQuote: context.inQuote,
        inPre: context.inPre,
        inCode: context.inCode,
      });
      // Only prevent the Space once the conversion is certain to land: a marker
      // split across nodes or a mid-line caret leaves the Space to type itself.
      if (auto && autoFormatApplies(root, auto, line)) {
        event.preventDefault();
        autoFormatRef.current = applyAutoFormat(root, auto, line);
        emit();
        readMarks();
        return;
      }
    }

    const verdict = composeKeyVerdict({
      ...context,
      key: event.key,
      shiftKey: event.shiftKey,
    });

    if (verdict === 'submit' && submitOnEnter) {
      // Pat order, 2026-08-22: Enter submits outside lists, but inside a list
      // native Chromium Enter continues or exits the list instead of sending.
      event.preventDefault();
      onSubmit?.();
      return;
    }
    if (verdict === 'new-list-item' || verdict === 'exit-list') {
      // insertParagraph is intentionally native here. Its input event emits the
      // resulting DOM after Chromium has inserted an LI or exited an empty LI.
      return;
    }
    if (verdict === 'new-quote-line') {
      // Native insertParagraph splits the line div and stays inside the quote,
      // provided the quote's content IS line divs.
      if (context.quoteLine === context.quote) {
        withCaretPreserved(root, () => normalizeQuoteLines(context.quote));
      }
      return;
    }
    if (verdict === 'exit-quote') {
      event.preventDefault();
      exitQuote(context);
      emit();
      readMarks();
      return;
    }
    if (verdict === 'soft-break') {
      event.preventDefault();
      exec(context.inPre ? 'insertLineBreak' : 'insertParagraph');
      emit();
      return;
    }
    if (verdict === 'indent-blocked') {
      // The cap: nothing happens, and focus stays in the composer.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (verdict === 'indent' || verdict === 'outdent') {
      event.preventDefault();
      event.stopPropagation();
      const snapshot = listEditSnapshot(root);
      withCaretPreserved(root, () => {
        exec(verdict);
        normalizeListEdit(root, snapshot, verdict);
      });
      emit();
      readMarks();
      return;
    }

    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    const shift = event.shiftKey;
    const command = (() => {
      if (!shift && key === 'b') return { run: () => exec('bold') };
      if (!shift && key === 'i') return { run: () => exec('italic') };
      if (!shift && key === 'u') return { run: () => exec('underline') };
      if (!shift && key === 'e') return { run: () => toggleInlineCode(root) };
      if (shift && key === 'x') return { run: () => exec('strikeThrough') };
      // With Shift held these arrive as their shifted characters on a US
      // layout, so both spellings are accepted.
      if (shift && (key === '8' || key === '*')) return { run: () => exec('insertUnorderedList'), block: true };
      if (shift && (key === '7' || key === '&')) return { run: () => exec('insertOrderedList'), block: true };
      if (shift && (key === '9' || key === '(')) return { run: () => toggleQuote(root), block: true };
      return null;
    })();
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    if (command.block) withCaretPreserved(root, command.run);
    else command.run();
    emit();
    readMarks();
  };

  const handlePaste = (event) => {
    // The image branch calls preventDefault synchronously before it awaits.
    onPasteImage?.(event);
    if (event.defaultPrevented) return;
    // Everything else pastes as PLAIN TEXT. A contenteditable would otherwise
    // accept whatever HTML the source page put on the clipboard, dragging
    // foreign styling and structure into a message bound for a terminal.
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') || '';
    if (text) exec('insertText', text);
    emit();
  };

  return (
    <div className="compose-editor-stack">
      {formatOpen ? (
        <div className="compose-format-bar" role="toolbar" aria-label="Text formatting">
          {TOOLBAR.map((group, index) => (
            <React.Fragment key={group[0].key}>
              {index ? <span className="compose-format-sep" aria-hidden="true" /> : null}
              {group.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`compose-format-btn fmt-${item.key}${marks[item.key] ? ' on' : ''}`}
                  title={item.title}
                  aria-label={item.title}
                  aria-pressed={item.state || item.key === 'code' || item.key === 'quote' ? Boolean(marks[item.key]) : undefined}
                  disabled={disabled}
                  // Keeping focus in the editor is the whole game: execCommand
                  // acts on the live selection, and a blur would lose it.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runItem(item)}
                >
                  {item.icon || <span className="compose-format-glyph">{item.label}</span>}
                </button>
              ))}
            </React.Fragment>
          ))}
          {linkOpen ? (
            <span className="compose-link-field">
              <input
                type="text"
                value={linkUrl}
                autoFocus
                placeholder="https://…"
                aria-label="Link address"
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); applyLink(); }
                  if (event.key === 'Escape') { event.preventDefault(); setLinkOpen(false); editorRef.current?.focus(); }
                }}
              />
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={applyLink}>Add</button>
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        ref={editorRef}
        className={`ubar-input${className ? ` ${className}` : ''}${value ? '' : ' is-empty'}`}
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck
        role="textbox"
        aria-multiline="true"
        aria-label="Message the selected session"
        aria-disabled={disabled ? true : undefined}
        aria-invalid={ariaInvalid ? true : undefined}
        data-placeholder={placeholder}
        onInput={emit}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
    </div>
  );
});
