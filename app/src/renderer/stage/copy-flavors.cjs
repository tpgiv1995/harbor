'use strict';

// COPYING OUT OF HARBOR GIVES CLEAN FORMATTING (2026-11-21, Pat: "less of a
// pain in the ass to copy and paste data in and out of harbor"). Chromium's
// own copy of a conversation window put Harbor's dark theme on the clipboard
// as inline styles (measured from the real OS clipboard: text
// rgb(246, 247, 255) on background rgb(11, 12, 15), 12.5px Schibsted
// Grotesk), so a reply pasted into Outlook or Word came out as white text on
// black, and the plain-text flavor dropped every list marker.
//
// selectionFlavors reads the selection the way a paste reads a clipboard
// (paste-html.cjs, copy mode: lists, numbering, marks, links, tables, a blank
// line between paragraphs) and returns the two flavors the Notes view's Copy
// formatted button writes (shared/markdown-html.cjs): semantic HTML with no
// colour or font, and plain text with "- " bullets, indented children and
// tab-separated table rows. A selection inside code returns its text only, so
// code pastes as code. Null means "let the browser copy": nothing selected, or
// a selection that reaches outside the container.

const { foreignHtmlToSpec } = require('./paste-html.cjs');
const { specToHtml, specToPlainText } = require('../../shared/markdown-html.cjs');

// A selection across several list items or table cells clones the items
// without their list or table; these ancestors are put back around it.
const WRAPPERS = new Set(['UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);
const OUTERMOST = new Set(['UL', 'OL', 'TABLE']);

const elementOf = (node) => (node && node.nodeType === 1 ? node : node?.parentNode || null);

function insideCode(node, container) {
  for (let current = elementOf(node); current && current !== container; current = current.parentNode) {
    if (current.nodeName === 'PRE' || current.nodeName === 'CODE') return true;
  }
  return false;
}

function selectionFlavors(selection, container, doc) {
  if (!selection || !container || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const selected = String(selection.toString() || '');
  if (!selected.trim()) return null;
  if (insideCode(range.commonAncestorContainer, container)) return { html: null, text: selected };
  let fragment = range.cloneContents();
  for (let node = elementOf(range.commonAncestorContainer); node && node !== container && WRAPPERS.has(node.nodeName); node = node.parentNode) {
    const shell = node.cloneNode(false);
    shell.appendChild(fragment);
    fragment = shell;
    if (OUTERMOST.has(node.nodeName)) break;
  }
  const holder = doc.createElement('div');
  holder.appendChild(fragment);
  const spec = foreignHtmlToSpec(holder, { copy: true });
  if (!spec) return null;
  return { html: specToHtml(spec), text: specToPlainText(spec) };
}

// The copy/cut event handler body: writes the flavors and takes the event.
function writeSelection(event, container, doc = globalThis.document) {
  const flavors = selectionFlavors(globalThis.getSelection?.(), container, doc);
  if (!flavors || !event?.clipboardData) return false;
  if (flavors.html) event.clipboardData.setData('text/html', flavors.html);
  event.clipboardData.setData('text/plain', flavors.text);
  event.preventDefault();
  return true;
}

module.exports = { selectionFlavors, writeSelection };
