'use strict';

// The phone message box is a plain-text editable element, not a <textarea>
// (2026-11-01). iOS Safari kept raising its "AutoFill Contact" bar and offering
// Pat's home and work addresses on every tap into the box: autoComplete="off"
// removed it in an idle session only, and a label plus a name did not remove it
// in a busy one. Safari's AutoFill classifies input, textarea and select
// elements and nothing else, which is why every chat app on the phone (Claude,
// ChatGPT, Slack) types into an editable element instead. This module is the
// text model of that element: the draft is plain text, and these helpers read
// it from the box, write it back, and move the caret by character offset, the
// way a textarea's value and selectionStart/selectionEnd did.
//
// What the browser leaves in a contenteditable="plaintext-only" box with
// white-space: pre-wrap (measured in WebKit 18.4 and Chromium 136, 2026-11-01):
//   - Enter inserts "\n" text, and at the end of the box it adds a SECOND "\n"
//     so the new empty line can hold the caret. "abc" + Enter is "abc\n\n" in
//     the DOM; typing "def" then leaves "abc\ndef". So one trailing "\n" is
//     never text, it is the line the caret sits on.
//   - Select-all + delete leaves "\n" (that same placeholder).
//   - Inserted multi-line text (a paste, Playwright's fill) can arrive as
//     "one<div>two</div>": a block element is a line of its own.
// readPlain() maps all of that to the text a person typed; writePlain() writes
// the inverse, so read(write(t)) === t for every t.

const TEXT = 3;
const ELEMENT = 1;
const BLOCKS = new Set(['DIV', 'P', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

// Serialize `root` up to an optional boundary (container, offset), using the
// browser's own rules for where lines break. Returns the text before the
// boundary, or all of it when there is none.
function serialize(root, stop) {
  let out = '';
  let pendingBreak = false; // a block just closed: the next content starts a line
  let done = false;
  const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  const emit = (text) => {
    if (!text) return;
    if (pendingBreak) { newline(); pendingBreak = false; }
    out += text;
  };
  const walk = (node) => {
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length && !done; i += 1) {
      if (stop && node === stop.container && i === stop.offset) { done = true; return; }
      const child = kids[i];
      if (child.nodeType === TEXT) {
        const data = String(child.data || '').replace(/ /g, ' ');
        if (stop && child === stop.container) { emit(data.slice(0, stop.offset)); done = true; return; }
        emit(data);
      } else if (child.nodeType === ELEMENT) {
        const name = String(child.nodeName || '').toUpperCase();
        if (name === 'BR') {
          if (pendingBreak) { newline(); pendingBreak = false; }
          out += '\n';
        } else if (BLOCKS.has(name)) {
          pendingBreak = false;
          newline();
          walk(child);
          pendingBreak = true;
        } else {
          walk(child);
        }
      }
    }
    if (stop && node === stop.container && !done) done = true;
  };
  walk(root);
  return out;
}

// The text in the box.
function readPlain(root) {
  const raw = serialize(root, null);
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}

// What the box must hold to show `text`: the text plus, when it ends on an
// empty line, the extra "\n" that gives that line a caret.
function displayText(text) {
  const value = String(text || '');
  return value.endsWith('\n') ? `${value}\n` : value;
}

// The character offset of a DOM boundary point inside the box, clamped to the
// text (a caret on the placeholder line is at the end).
function offsetAt(root, container, offset) {
  if (!container || (container !== root && !root.contains?.(container))) return null;
  const before = serialize(root, { container, offset });
  return Math.min(before.length, readPlain(root).length);
}

function writePlain(el, text) {
  el.textContent = displayText(text);
}

// The selection as {start, end} offsets, or null when it is not in the box.
function getSelectionOffsets(el) {
  const sel = el?.ownerDocument?.getSelection?.();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const start = offsetAt(el, range.startContainer, range.startOffset);
  const end = offsetAt(el, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return { start, end };
}

// Put the caret (or a selection) at character offsets. The box is rewritten
// to its normal form first, one text node, so an offset is a node offset; that
// is safe here because nothing is mid-composition while code moves the caret.
function setSelectionOffsets(el, start, end = start) {
  const doc = el?.ownerDocument;
  const sel = doc?.getSelection?.();
  if (!sel) return;
  const text = readPlain(el);
  const display = displayText(text);
  if (el.childNodes.length !== 1 || el.firstChild.nodeType !== TEXT || el.firstChild.data !== display) {
    writePlain(el, text);
  }
  const clamp = (n) => Math.max(0, Math.min(Number.isFinite(n) ? n : text.length, text.length));
  const range = doc.createRange();
  const node = el.firstChild;
  if (node) {
    range.setStart(node, clamp(start));
    range.setEnd(node, clamp(end));
  } else {
    range.setStart(el, 0);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

module.exports = { readPlain, displayText, offsetAt, writePlain, getSelectionOffsets, setSelectionOffsets };
