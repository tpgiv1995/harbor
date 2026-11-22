'use strict';

// FORMATTED TEXT PASTES AS FORMATTED TEXT (2026-11-21, Pat: "can you make it so
// its less of a pain in the ass to copy and paste data in and out of harbor?
// like if i paste in just the first 4 bullets (2 lvl 1 bullets each with a
// child bullet) ... look how it shows up"). The composer used to paste PLAIN
// TEXT only, so a Teams list arrived as bare paragraphs: no bullets, no
// nesting, no bold, and blank lines where the structure had been.
//
// foreignHtmlToSpec reads the HTML flavor every rich source puts on the
// clipboard (Teams, Outlook and Word, Google Docs, web pages, Harbor's own
// conversation windows) and returns the composer's own node SPEC, the shapes
// markdownToSpec builds and buildNodes turns into DOM: lines as `div`, lists
// as `ul`/`ol` > `li` with nested lists inside the item, `pre`, `blockquote`,
// `h1`-`h6`, and the inline marks strong/em/u/s/code plus links. Nothing
// foreign survives: no attribute but a safe href, a list type and a start, no
// style, no class, no element the composer does not draw itself.
//
// It returns null when keeping the HTML would add nothing (no list, heading,
// quote, code block, mark or link), and when the copy holds a TABLE: a
// spreadsheet's tab-separated plain text is what an agent reads best, so
// those keep the plain-text path. Invisible characters are dropped on the way
// in (shared/invisible-chars.cjs), and a no-break space becomes a space.
//
// Reads only nodeType / nodeName / childNodes / textContent / getAttribute, so
// tests feed literal objects, the same contract as compose-doc's serializeDoc.

const { stripInvisible } = require('../../shared/invisible-chars.cjs');

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
// The composer's own indent cap (compose-keys MAX_LIST_DEPTH).
const MAX_DEPTH = 5;

const DROP = new Set([
  'SCRIPT', 'STYLE', 'HEAD', 'META', 'TITLE', 'LINK', 'TEMPLATE', 'NOSCRIPT', 'SVG',
  'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'BUTTON', 'INPUT',
  'SELECT', 'TEXTAREA', 'OPTION', 'COLGROUP', 'MATH',
]);
const BLOCK = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE',
  'FIGCAPTION', 'ADDRESS', 'DL', 'DT', 'DD', 'CENTER', 'FORM', 'FIELDSET', 'DETAILS',
  'SUMMARY', 'HR', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'BODY', 'HTML',
]);
const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const TAG_MARK = {
  B: 'bold', STRONG: 'bold', I: 'italic', EM: 'italic', CITE: 'italic', U: 'underline', INS: 'underline',
  S: 'strike', STRIKE: 'strike', DEL: 'strike', CODE: 'code', KBD: 'code', SAMP: 'code', TT: 'code',
};
// Innermost first, the order compose-doc's serializer nests them in.
const MARK_ORDER = ['code', 'italic', 'bold', 'strike', 'underline'];
const MARK_TAG = { code: 'code', italic: 'em', bold: 'strong', strike: 's', underline: 'u' };
const LIST_TYPES = new Set(['1', 'a', 'A', 'i', 'I']);
const CSS_LIST_TYPE = {
  'lower-alpha': 'a', 'lower-latin': 'a', 'upper-alpha': 'A', 'upper-latin': 'A',
  'lower-roman': 'i', 'upper-roman': 'I',
};

const nameOf = (node) => String(node?.nodeName || '').toUpperCase();
const kids = (node) => Array.from(node?.childNodes || []);
const isElement = (node) => node?.nodeType === ELEMENT_NODE;
const attr = (node, name) => (typeof node?.getAttribute === 'function' ? node.getAttribute(name) : node?.[name] ?? null);
const styleOf = (node) => String(attr(node, 'style') || '').toLowerCase();

function cssValue(style, property) {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(style);
  return match ? match[1].trim() : '';
}

function safeHref(value) {
  const href = String(value || '').trim();
  return /^(https?:|mailto:)/i.test(href) ? href : '';
}

// The marks an element adds or removes. Google Docs wraps a whole copy in
// <b style="font-weight:normal">, so a style can cancel its own tag.
function marksFor(node, marks) {
  const tag = nameOf(node);
  const style = styleOf(node);
  const next = new Set(marks);
  const tagMark = TAG_MARK[tag];
  if (tagMark) next.add(tagMark);
  // Harbor's own conversation headings are <p class="md-h">.
  if (/(^|\s)md-h(\s|$)/.test(String(attr(node, 'class') || ''))) next.add('bold');
  const weight = cssValue(style, 'font-weight');
  if (/^(bold|bolder|[6-9]00)$/.test(weight)) next.add('bold');
  else if (/^(normal|lighter|[1-5]00)$/.test(weight)) next.delete('bold');
  const fontStyle = cssValue(style, 'font-style');
  if (/^(italic|oblique)/.test(fontStyle)) next.add('italic');
  else if (fontStyle === 'normal') next.delete('italic');
  const decoration = `${cssValue(style, 'text-decoration')} ${cssValue(style, 'text-decoration-line')}`;
  if (/underline/.test(decoration)) next.add('underline');
  if (/line-through/.test(decoration)) next.add('strike');
  return next;
}

// Word's list bullet ("\u00B7", "o", "1.") sits in a span the source itself hides.
const isWordListMarker = (node) => /mso-list\s*:\s*ignore/.test(styleOf(node));
// Icons and decorations a page hides from screen readers are not content.
// data-copy="skip" is Harbor's own mark for window chrome (a reply's time).
const isHiddenElement = (node) => attr(node, 'aria-hidden') === 'true' || attr(node, 'data-copy') === 'skip';
const hasBlockInside = (node) => kids(node).some((child) => isElement(child) && (BLOCK.has(nameOf(child)) || hasBlockInside(child)));
const containsTable = (node) => kids(node).some((child) => isElement(child) && (nameOf(child) === 'TABLE' || containsTable(child)));

function cleanText(text) {
  return stripInvisible(text).replace(/\u00A0/g, ' ');
}

// ── inline runs ────────────────────────────────────────────────────────────

// A line is built as runs { text, marks, link } and { br }, and becomes spec at
// the end, so whitespace collapses across element boundaries the way a browser
// renders it.
function collectInline(node, ctx, runs) {
  if (node.nodeType === TEXT_NODE) {
    const raw = String(node.textContent || '');
    if (raw) runs.push({ text: ctx.pre ? raw : raw.replace(/[ \t\r\n\f]+/g, ' '), marks: ctx.marks, link: ctx.link });
    return;
  }
  if (!isElement(node)) return;
  const tag = nameOf(node);
  if (DROP.has(tag) || isWordListMarker(node) || isHiddenElement(node)) return;
  if (tag === 'BR') { runs.push({ br: true }); return; }
  if (tag === 'IMG') {
    // Teams and Outlook draw emoji as images whose alt text is the emoji.
    const alt = String(attr(node, 'alt') || '').trim();
    if (alt && Array.from(alt).length <= 4) runs.push({ text: alt, marks: ctx.marks, link: ctx.link });
    return;
  }
  const next = { ...ctx, marks: marksFor(node, ctx.marks) };
  if (tag === 'A') next.link = safeHref(attr(node, 'href')) || ctx.link;
  for (const child of kids(node)) collectInline(child, next, runs);
}

function sameMarks(a, b) {
  if (a.size !== b.size) return false;
  for (const mark of a) if (!b.has(mark)) return false;
  return true;
}

// Runs to spec items: collapse spaces across runs, trim the line, merge
// neighbours with the same marks and link, wrap in the serializer's order.
function runsToSpec(runs, { pre = false } = {}) {
  const merged = [];
  let lastSpace = true;
  for (const run of runs) {
    if (run.br) { merged.push({ br: true }); lastSpace = true; continue; }
    let text = cleanText(run.text);
    if (!pre) {
      if (lastSpace) text = text.replace(/^ +/, '');
      if (!text) continue;
      lastSpace = text.endsWith(' ');
    }
    const previous = merged[merged.length - 1];
    if (previous && !previous.br && previous.link === run.link && sameMarks(previous.marks, run.marks)) previous.text += text;
    else merged.push({ text, marks: run.marks, link: run.link });
  }
  // Trim the line's end, and a space before each break.
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const run = merged[i];
    const atEnd = i === merged.length - 1 || merged[i + 1].br;
    if (!run.br && atEnd && !pre) run.text = run.text.replace(/ +$/, '');
  }
  while (merged.length && merged[merged.length - 1].br) merged.pop();
  while (merged.length && merged[0].br) merged.shift();
  return merged.filter((run) => run.br || run.text).map((run) => {
    if (run.br) return { tag: 'br', children: [] };
    let item = run.text;
    for (const mark of MARK_ORDER) if (run.marks.has(mark)) item = { tag: MARK_TAG[mark], children: [item] };
    if (run.link) item = { tag: 'a', href: run.link, children: [item] };
    return item;
  });
}

// Split a line's spec at its top-level breaks: each piece is a line of its own.
function splitLines(items) {
  const lines = [[]];
  for (const item of items) {
    if (item && item.tag === 'br') lines.push([]);
    else lines[lines.length - 1].push(item);
  }
  return lines;
}

// ── blocks ─────────────────────────────────────────────────────────────────

function listTypeOf(node) {
  const type = String(attr(node, 'type') || '');
  if (LIST_TYPES.has(type)) return type === '1' ? null : type;
  return CSS_LIST_TYPE[cssValue(styleOf(node), 'list-style-type')] || null;
}

function listSpec(node, ctx, depth) {
  const ordered = nameOf(node) === 'OL';
  const list = { tag: ordered ? 'ol' : 'ul', children: [] };
  if (ordered) {
    const type = listTypeOf(node);
    if (type) list.type = type;
    const start = parseInt(attr(node, 'start'), 10);
    if (Number.isFinite(start) && start !== 1) list.start = start;
  }
  for (const child of kids(node)) {
    const tag = nameOf(child);
    if (tag === 'LI') {
      const item = itemSpec(child, ctx, depth);
      if (item) list.children.push(...item);
    } else if (tag === 'UL' || tag === 'OL') {
      // Chromium's indent parks a nested list directly in its parent list.
      const nested = listSpec(child, ctx, depth + 1);
      attachNested(list, nested, depth);
    } else if (child.nodeType === TEXT_NODE ? String(child.textContent || '').trim() : isElement(child) && !DROP.has(tag)) {
      const runs = [];
      collectInline(child, ctx, runs);
      const children = runsToSpec(runs);
      if (children.length) list.children.push({ tag: 'li', children });
    }
  }
  return list;
}

// A nested list goes inside the item before it; past the composer's depth
// cap its items join this level instead of disappearing.
function attachNested(list, nested, depth) {
  if (!nested.children.length) return;
  if (depth >= MAX_DEPTH) { list.children.push(...flattenItems(nested)); return; }
  const parent = list.children[list.children.length - 1];
  if (parent) parent.children.push(nested);
  else list.children.push({ tag: 'li', children: [nested] });
}

function flattenItems(list) {
  const out = [];
  for (const item of list.children) {
    const inline = item.children.filter((c) => !(c && (c.tag === 'ul' || c.tag === 'ol')));
    if (inline.length) out.push({ tag: 'li', children: inline });
    for (const c of item.children) if (c && (c.tag === 'ul' || c.tag === 'ol')) out.push(...flattenItems(c));
  }
  return out;
}

// One <li>: its text (paragraphs inside it joined by a break), then any lists
// nested in it. Returns an array: an item, or nothing for an empty one.
function itemSpec(node, ctx, depth) {
  const inline = [];
  const nestedLists = [];
  const runs = [];
  const flushParagraph = () => {
    const children = runsToSpec(runs.splice(0));
    if (!children.length) return;
    if (inline.length) inline.push({ tag: 'br', children: [] });
    inline.push(...children);
  };
  const walk = (parent, walkCtx) => {
    for (const child of kids(parent)) {
      const tag = nameOf(child);
      if (tag === 'UL' || tag === 'OL') { flushParagraph(); nestedLists.push(listSpec(child, walkCtx, depth + 1)); continue; }
      if (isElement(child) && (BLOCK.has(tag) || hasBlockInside(child)) && !DROP.has(tag)) {
        flushParagraph();
        walk(child, { ...walkCtx, marks: marksFor(child, walkCtx.marks) });
        flushParagraph();
        continue;
      }
      collectInline(child, walkCtx, runs);
    }
  };
  walk(node, ctx);
  flushParagraph();
  const item = { tag: 'li', children: inline };
  const holder = { children: [item] };
  for (const nested of nestedLists) attachNested(holder, nested, depth);
  return holder.children.filter((child) => child.children.length);
}

// Word and Outlook do not write lists: each item is a paragraph styled
// "mso-list:l0 level2 lfo1" with its bullet in a hidden span. A run of them
// becomes one nested list, ordered when its markers are numbers or letters.
const wordListLevel = (node) => {
  const match = /mso-list\s*:\s*l\d+\s+level(\d+)/.exec(styleOf(node));
  return match ? Number(match[1]) : 0;
};

function wordMarkerText(node) {
  for (const child of kids(node)) {
    if (!isElement(child)) continue;
    if (isWordListMarker(child)) return String(child.textContent || '');
    const inner = wordMarkerText(child);
    if (inner) return inner;
  }
  return '';
}

function wordListSpec(paragraphs, ctx) {
  const roots = [];
  const stack = []; // stack[d] = the list at depth d (1-based level - 1)
  for (const paragraph of paragraphs) {
    const level = Math.min(wordListLevel(paragraph), MAX_DEPTH);
    const ordered = /^\s*\(?([0-9]+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)]/.test(cleanText(wordMarkerText(paragraph)));
    const runs = [];
    for (const child of kids(paragraph)) collectInline(child, ctx, runs);
    const children = runsToSpec(runs);
    if (!children.length) continue;
    stack.length = Math.min(stack.length, level);
    while (stack.length < level) {
      const list = { tag: ordered ? 'ol' : 'ul', children: [] };
      const depth = stack.length;
      if (depth === 0) roots.push(list);
      else {
        const parentList = stack[depth - 1];
        let parent = parentList.children[parentList.children.length - 1];
        if (!parent) { parent = { tag: 'li', children: [] }; parentList.children.push(parent); }
        parent.children.push(list);
      }
      stack.push(list);
    }
    stack[level - 1].children.push({ tag: 'li', children });
  }
  return roots;
}

function blockSpec(node, ctx, out) {
  const tag = nameOf(node);
  if (DROP.has(tag) || isHiddenElement(node)) return;
  if (tag === 'TABLE' && ctx.copy) { const table = tableSpec(node, ctx); if (table) out.push(table, BLANK()); return; }
  if (tag === 'UL' || tag === 'OL') { const list = listSpec(node, ctx, 1); if (list.children.length) out.push(list); if (ctx.copy) out.push(BLANK()); return; }
  if (tag === 'LI') { const items = itemSpec(node, ctx, 1); if (items.length) out.push({ tag: 'ul', children: items }); return; }
  if (tag === 'PRE') {
    const text = cleanText(String(node.textContent || '')).replace(/\n$/, '');
    if (text.trim()) out.push({ tag: 'pre', children: [text] });
    if (ctx.copy) out.push(BLANK());
    return;
  }
  if (tag === 'BLOCKQUOTE') {
    const inner = [];
    childBlocks(node, ctx, inner);
    const lines = [];
    for (const block of inner) {
      if (block.tag === 'div') lines.push(block);
      else lines.push({ tag: 'div', children: [plainOf(block)] });
    }
    if (lines.some((line) => line.children.length)) out.push({ tag: 'blockquote', children: lines });
    if (ctx.copy) out.push(BLANK());
    return;
  }
  if (HEADINGS.has(tag)) {
    const runs = [];
    for (const child of kids(node)) collectInline(child, { ...ctx, marks: marksFor(node, ctx.marks) }, runs);
    const children = runsToSpec(runs).filter((c) => !(c && c.tag === 'br'));
    if (children.length) out.push({ tag: tag.toLowerCase(), children });
    if (ctx.copy) out.push(BLANK());
    return;
  }
  if (tag === 'HR') return;
  const before = out.length;
  childBlocks(node, { ...ctx, marks: marksFor(node, ctx.marks) }, out);
  // An empty paragraph is a blank line the author typed (Word writes them as
  // <p>&nbsp;</p>); an empty div is only layout.
  if (out.length === before && tag === 'P') out.push({ tag: 'div', children: [] });
  // A copy keeps paragraphs apart with a real empty line (the Notes export
  // rule: Word shows paragraph margins as spacing nobody can click into).
  else if (ctx.copy && (tag === 'P' || HEADINGS.has(tag) || tag === 'PRE' || tag === 'BLOCKQUOTE' || tag === 'UL' || tag === 'OL')) out.push(BLANK());
}

const BLANK = () => ({ tag: 'div', children: [] });

// A copied table, row by row; a header cell is marked so the exports can bold
// it. Only in copy mode: a pasted table takes the plain-text path.
function tableSpec(node, ctx) {
  const rows = [];
  const walk = (parent) => {
    for (const child of kids(parent)) {
      const tag = nameOf(child);
      if (tag === 'TR') {
        const cells = [];
        for (const cell of kids(child)) {
          const cellTag = nameOf(cell);
          if (cellTag !== 'TD' && cellTag !== 'TH') continue;
          const runs = [];
          for (const inner of kids(cell)) collectInline(inner, ctx, runs);
          cells.push({ header: cellTag === 'TH', children: runsToSpec(runs).filter((c) => !(c && c.tag === 'br')) });
        }
        if (cells.length) rows.push({ cells });
      } else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') walk(child);
    }
  };
  walk(node);
  return rows.length ? { tag: 'table', rows } : null;
}

function plainOf(spec) {
  if (typeof spec === 'string') return spec;
  return (spec.children || []).map(plainOf).join(spec.tag === 'li' ? '' : ' ');
}

function childBlocks(parent, ctx, out) {
  let runs = [];
  const flush = () => {
    if (!runs.length) return;
    for (const line of splitLines(runsToSpec(runs))) if (line.length) out.push({ tag: 'div', children: line });
    runs = [];
  };
  const children = kids(parent);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    const tag = nameOf(child);
    if (isElement(child) && wordListLevel(child)) {
      flush();
      const group = [child];
      while (i + 1 < children.length) {
        const next = children[i + 1];
        if (isElement(next) && wordListLevel(next)) { group.push(next); i += 1; continue; }
        if (!isElement(next) && !String(next.textContent || '').trim()) { i += 1; continue; }
        break;
      }
      out.push(...wordListSpec(group, ctx));
      continue;
    }
    if (isElement(child) && (DROP.has(tag) || isHiddenElement(child))) continue;
    if (isElement(child) && (BLOCK.has(tag) || hasBlockInside(child))) {
      flush();
      if (BLOCK.has(tag)) blockSpec(child, ctx, out);
      else childBlocks(child, { ...ctx, marks: marksFor(child, ctx.marks), link: tag === 'A' ? safeHref(attr(child, 'href')) || ctx.link : ctx.link }, out);
      continue;
    }
    if (tag === 'BR' && !runs.some((run) => !run.br)) {
      // A break with nothing before it on this line is a blank line.
      out.push({ tag: 'div', children: [] });
      continue;
    }
    collectInline(child, ctx, runs);
  }
  flush();
}

// Blank lines: none at either end, never two in a row.
function tidyBlanks(spec) {
  const out = [];
  for (const block of spec) {
    const blank = block.tag === 'div' && !block.children.length;
    if (blank && (!out.length || (out[out.length - 1].tag === 'div' && !out[out.length - 1].children.length))) continue;
    out.push(block);
  }
  while (out.length && out[out.length - 1].tag === 'div' && !out[out.length - 1].children.length) out.pop();
  return out;
}

function hasStructure(spec) {
  return spec.some(function walk(item) {
    if (!item || typeof item === 'string') return false;
    if (item.tag !== 'div' && item.tag !== 'br') return true;
    return (item.children || []).some(walk);
  });
}

// { copy: true } is the copy-out mode (copy-flavors.cjs): tables are kept, a
// blank line follows each paragraph, and plain prose is returned too.
function foreignHtmlToSpec(root, { copy = false } = {}) {
  if (!root || (!copy && containsTable(root))) return null;
  const out = [];
  childBlocks(root, { marks: new Set(), link: null, pre: false, copy }, out);
  const spec = tidyBlanks(out);
  if (!spec.length) return null;
  return copy || hasStructure(spec) ? spec : null;
}

// The plain-text paste path: invisible characters out, no-break spaces made
// spaces, Windows line endings made newlines.
function cleanPastedText(text) {
  return cleanText(String(text ?? ''));
}

module.exports = { foreignHtmlToSpec, cleanPastedText, MAX_DEPTH };
