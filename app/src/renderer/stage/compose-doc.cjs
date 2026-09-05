'use strict';

// The composer is WYSIWYG; the wire is not. Everything composed here leaves
// Harbor as ONE string of characters typed into an agent's terminal, so
// markdown is the only formatting that survives the trip. This module owns
// both conversions and nothing else in the app does.
//
//   serializeDoc(root)  live editor DOM -> markdown. Runs on every edit.
//   markdownToSpec(md)  markdown -> node spec. Runs ONLY when something
//                       outside the editor writes the draft (voice, a slash
//                       insert, a dropped file, switching sessions).
//
// serializeDoc reads only nodeType / nodeName / childNodes / textContent (plus
// href on a link), so tests feed it literal objects and need no jsdom.
//
// markdownToSpec returns plain objects rather than an HTML string on purpose.
// The editor builds real nodes from the spec, so a draft holding
// `<img onerror=...>` can never become live markup, the same reason md.jsx
// renders React elements instead of injecting HTML.

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// Innermost to outermost. Bold+italic has to nest as **(*x*)** = ***x***, so
// the order here is load-bearing, not cosmetic.
const MARK_ORDER = ['code', 'italic', 'bold', 'strike', 'underline'];

const MARK_WRAP = {
  code: ['`', '`'],
  italic: ['*', '*'],
  bold: ['**', '**'],
  strike: ['~~', '~~'],
  // Markdown has no underline at all, and __x__ means bold. Inline HTML is the
  // only form in which the intent reaches Claude.
  underline: ['<u>', '</u>'],
};

const TAG_MARKS = {
  STRONG: 'bold',
  B: 'bold',
  EM: 'italic',
  I: 'italic',
  U: 'underline',
  S: 'strike',
  STRIKE: 'strike',
  DEL: 'strike',
  CODE: 'code',
};

const HEADING_HASHES = {
  H1: '#', H2: '##', H3: '###', H4: '####', H5: '#####', H6: '######',
};

const BLOCK_TAGS = new Set([
  'DIV', 'P', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

const nodeName = (node) => String(node?.nodeName || '').toUpperCase();
const childrenOf = (node) => Array.from(node?.childNodes || []);
const isElement = (node) => node?.nodeType === ELEMENT_NODE;
const isBlock = (node) => isElement(node) && BLOCK_TAGS.has(nodeName(node));
const hasBlockChild = (node) => childrenOf(node).some(isBlock);

function sameMarks(a, b) {
  if (a.size !== b.size) return false;
  for (const mark of a) if (!b.has(mark)) return false;
  return true;
}

function linkHref(node) {
  if (typeof node?.getAttribute === 'function') return node.getAttribute('href') || '';
  return String(node?.href || '');
}

// Ordered lists carry their numbering style on the wire (2026-09-03): an
// `<ol type="I">` emits `I.`, `II.`, `III.` and an `<ol type="a">` emits `a.`,
// `b.`, because Pat types those markers and the agent should read the list the
// way he wrote it. A list started at "3." keeps its `start`. Markdown has no
// such thing, so markdownToSpec recognises the same markers coming back.
const LIST_TYPES = new Set(['I', 'i', 'A', 'a']);
const ROMAN = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];
const ROMAN_VALUE = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function toRoman(number) {
  let rest = Math.max(1, Math.floor(number));
  let out = '';
  for (const [value, glyph] of ROMAN) {
    while (rest >= value) { out += glyph; rest -= value; }
  }
  return out;
}

function fromRoman(text) {
  const glyphs = String(text).toUpperCase();
  let total = 0;
  for (let i = 0; i < glyphs.length; i += 1) {
    const current = ROMAN_VALUE[glyphs[i]] || 0;
    const next = ROMAN_VALUE[glyphs[i + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total;
}

function toLetters(number) {
  let rest = Math.max(1, Math.floor(number));
  let out = '';
  while (rest > 0) {
    rest -= 1;
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

function fromLetters(text) {
  let total = 0;
  for (const glyph of String(text).toLowerCase()) total = total * 26 + (glyph.charCodeAt(0) - 96);
  return total;
}

function orderedMarker(number, type) {
  switch (type) {
    case 'I': return `${toRoman(number)}. `;
    case 'i': return `${toRoman(number).toLowerCase()}. `;
    case 'A': return `${toLetters(number).toUpperCase()}. `;
    case 'a': return `${toLetters(number)}. `;
    default: return `${number}. `;
  }
}

function attributeOf(node, name) {
  if (typeof node?.getAttribute === 'function') return node.getAttribute(name);
  return node?.[name] ?? null;
}

function listType(node) {
  const type = String(attributeOf(node, 'type') || '');
  return LIST_TYPES.has(type) ? type : null;
}

function listStart(node) {
  const start = parseInt(attributeOf(node, 'start'), 10);
  return Number.isFinite(start) ? start : 1;
}

// Which numbering a list's FIRST marker implies. "I" and "i" are roman, every
// other lone letter is a letter list ("C." starts a letter list at C, not a
// roman list at 100); multi-glyph roman is always roman.
function orderedListShape(marker) {
  if (/^\d+$/.test(marker)) return { type: null, start: Number(marker) };
  if (/^[IVXLCDM]+$/.test(marker) && (marker.length > 1 || marker === 'I')) {
    return { type: 'I', start: fromRoman(marker) };
  }
  if (/^[ivxlcdm]+$/.test(marker) && (marker.length > 1 || marker === 'i')) {
    return { type: 'i', start: fromRoman(marker) };
  }
  if (/^[A-Z]$/.test(marker)) return { type: 'A', start: fromLetters(marker) };
  return { type: 'a', start: fromLetters(marker) };
}

// ── DOM -> markdown ─────────────────────────────────────────────────────────

// Flatten inline content into runs of (text, marks, link). Working in runs
// rather than concatenating strings as we descend is what makes the merge and
// whitespace rules below possible at all.
function collectRuns(node, marks, link, runs) {
  if (!node) return;
  if (node.nodeType === TEXT_NODE) {
    const text = String(node.textContent || '');
    if (text) runs.push({ text, marks, link });
    return;
  }
  // Unknown nodes always emit plain text because silent content loss is worse than lost formatting.
  if (!isElement(node)) {
    const text = String(node.textContent || '');
    if (text) runs.push({ text, marks, link });
    return;
  }
  const tag = nodeName(node);
  if (tag === 'BR') {
    runs.push({ br: true });
    return;
  }
  const mark = TAG_MARKS[tag];
  const nextMarks = mark ? new Set([...marks, mark]) : marks;
  const nextLink = tag === 'A' ? (linkHref(node) || link) : link;
  const children = childrenOf(node);
  for (const child of children) collectRuns(child, nextMarks, nextLink, runs);
  if (!children.length && !TAG_MARKS[tag] && tag !== 'A' && tag !== 'BR') {
    const text = String(node.textContent || '');
    if (text) runs.push({ text, marks: nextMarks, link: nextLink });
  }
}

// `<strong>a</strong><strong>b</strong>` must emit `**ab**`, never `**a****b**`
// (four asterisks render as literal text, not as two bold runs). Chromium
// produces split marks constantly, so this is the common case, not an edge one.
function mergeRuns(runs) {
  const out = [];
  for (const run of runs) {
    const previous = out[out.length - 1];
    if (run.br) {
      out.push(run);
      continue;
    }
    if (previous && !previous.br && previous.link === run.link
      && sameMarks(previous.marks, run.marks)) {
      previous.text += run.text;
      continue;
    }
    out.push({ text: run.text, marks: new Set(run.marks), link: run.link });
  }
  // Chromium parks a filler <br> at the end of a block so an empty line has
  // height. Emitting it would append a phantom newline to every message.
  while (out.length && out[out.length - 1].br) out.pop();
  return out;
}

function emitRun(run) {
  const raw = run.text;
  const [, lead, core, trail] = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
  // Markdown will not render a delimiter with whitespace against it: `** x**`
  // is literal asterisks. Pull the padding outside the marks. A run that is
  // ONLY whitespace (or empty) gets no marks at all, which is also what stops
  // an emptied <strong> from emitting a bare `****`.
  if (!core) return raw;
  let out = core;
  for (const mark of MARK_ORDER) {
    if (!run.marks.has(mark)) continue;
    const [open, close] = MARK_WRAP[mark];
    out = `${open}${out}${close}`;
  }
  if (run.link) out = `[${out}](${run.link})`;
  return `${lead}${out}${trail}`;
}

function inlineFromNodes(nodes) {
  const runs = [];
  for (const node of nodes) collectRuns(node, new Set(), null, runs);
  return mergeRuns(runs).map((run) => (run.br ? '\n' : emitRun(run))).join('');
}

const inlineOf = (node) => inlineFromNodes(childrenOf(node));

function pushLines(lines, text, indent) {
  for (const part of String(text).split('\n')) lines.push(indent ? `${indent}${part}` : part);
}

function emitListItem(item, lines, indent, marker) {
  const body = [];
  let inline = [];
  const flush = () => {
    if (!inline.length) return;
    pushLines(body, inlineFromNodes(inline), '');
    inline = [];
  };
  for (const child of childrenOf(item)) {
    if (isBlock(child)) {
      flush();
      emitBlock(child, body, '');
    } else {
      inline.push(child);
    }
  }
  flush();
  lines.push(`${indent}${marker}${body[0] ?? ''}`);
  // A wrapped item lines up under its own text, not under the marker.
  const continuation = `${indent}${' '.repeat(marker.length)}`;
  for (const extra of body.slice(1)) lines.push(`${continuation}${extra}`);
  return continuation;
}

function emitBlock(node, lines, indent) {
  const tag = nodeName(node);

  if (tag === 'UL' || tag === 'OL') {
    const ordered = tag === 'OL';
    const type = ordered ? listType(node) : null;
    let number = ordered ? listStart(node) : 1;
    let continuation = indent;
    for (const child of childrenOf(node)) {
      const childTag = nodeName(child);
      if (childTag === 'LI') {
        continuation = emitListItem(child, lines, indent, ordered ? orderedMarker(number, type) : '- ');
        number += 1;
      } else if (childTag === 'UL' || childTag === 'OL') {
        emitBlock(child, lines, continuation);
      } else {
        // A composer serializer must never turn unrecognized content into silence.
        pushLines(lines, String(child?.textContent || ''), continuation || indent);
      }
    }
    return;
  }

  if (tag === 'PRE') {
    lines.push(`${indent}\`\`\``);
    pushLines(lines, String(node.textContent || '').replace(/\n$/, ''), indent);
    lines.push(`${indent}\`\`\``);
    return;
  }

  if (tag === 'BLOCKQUOTE') {
    const inner = [];
    emitChildren(node, inner, '');
    for (const line of inner) lines.push(`${indent}> ${line}`.trimEnd());
    return;
  }

  if (HEADING_HASHES[tag]) {
    pushLines(lines, `${HEADING_HASHES[tag]} ${inlineOf(node)}`, indent);
    return;
  }

  // Chromium nests plain divs freely; recurse rather than flattening their
  // text together onto one line.
  if (hasBlockChild(node)) {
    emitChildren(node, lines, indent);
    return;
  }
  pushLines(lines, inlineOf(node), indent);
}

function emitChildren(parent, lines, indent) {
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    pushLines(lines, inlineFromNodes(buffer), indent);
    buffer = [];
  };
  for (const child of childrenOf(parent)) {
    if (isBlock(child)) {
      flush();
      emitBlock(child, lines, indent);
    } else {
      buffer.push(child);
    }
  }
  flush();
}

function serializeDoc(root) {
  if (!root) return '';
  // Structure with no text in it is not a message. Emptying the editor leaves
  // Chromium's scaffolding behind (`<ul><li><br></li></ul>` after clearing a
  // list), which would otherwise serialize to a lone "- " and send a stray
  // dash to the agent, breaking the empty-composer no-op rule.
  if (!String(root.textContent || '').trim()) return '';
  const lines = [];
  emitChildren(root, lines, '');
  // A trailing blank line is Chromium bookkeeping, not something anyone typed.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ── markdown -> node spec ───────────────────────────────────────────────────

// Order matters: the three-asterisk form has to be tried before the two- and
// one-asterisk forms, or `***x***` reads as bold followed by stray asterisks.
const INLINE_PATTERNS = [
  { re: /^`([^`]+)`/, tag: 'code', literal: true },
  { re: /^\*\*\*([\s\S]+?)\*\*\*/, tag: 'strong', inner: 'em' },
  { re: /^\*\*([\s\S]+?)\*\*/, tag: 'strong' },
  { re: /^\*([^*\n]+?)\*/, tag: 'em' },
  { re: /^~~([\s\S]+?)~~/, tag: 's' },
  { re: /^<u>([\s\S]*?)<\/u>/, tag: 'u' },
  { re: /^\[([^\]]*)\]\(([^)\s]*)\)/, tag: 'a' },
];

function inlineToSpec(text) {
  const source = String(text ?? '');
  const out = [];
  let buffer = '';
  let index = 0;
  const flush = () => { if (buffer) { out.push(buffer); buffer = ''; } };

  while (index < source.length) {
    const rest = source.slice(index);
    let matched = null;
    for (const pattern of INLINE_PATTERNS) {
      const match = rest.match(pattern.re);
      if (!match) continue;
      matched = { pattern, match };
      break;
    }
    if (!matched) {
      buffer += source[index];
      index += 1;
      continue;
    }
    flush();
    const { pattern, match } = matched;
    if (pattern.tag === 'a') {
      out.push({ tag: 'a', href: match[2], children: inlineToSpec(match[1]) });
    } else if (pattern.literal) {
      // Nothing inside a code span is markdown, by definition.
      out.push({ tag: pattern.tag, children: [match[1]] });
    } else if (pattern.inner) {
      out.push({ tag: pattern.tag, children: [{ tag: pattern.inner, children: inlineToSpec(match[1]) }] });
    } else {
      out.push({ tag: pattern.tag, children: inlineToSpec(match[1]) });
    }
    index += match[0].length;
  }
  flush();
  return out;
}

const BULLET_RE = /^(\s*)[-*•]\s+(.*)$/;
// Numbers, roman numerals, or a single letter, each followed by "." or ")".
const NUMBER_RE = /^(\s*)(\d{1,9}|[IVXLCDM]{1,9}|[ivxlcdm]{1,9}|[A-Z]|[a-z])([.)])\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

const DIGIT_MARKER_RE = /^\d+$/;

function listLine(line) {
  const numbered = String(line).match(NUMBER_RE);
  if (numbered) {
    const marker = numbered[2];
    const delim = numbered[3];
    // A non-digit marker with ")" cannot round-trip: the DOM <ol> keeps no
    // delimiter, so "I) x" would serialize back as "I. x", altering the user's
    // bytes (2026-09-03). So only "." opens a roman or letter list; "I) x" stays
    // prose. Digit ")" is left as it was.
    if (!DIGIT_MARKER_RE.test(marker) && delim !== '.') return null;
    return { indent: numbered[1].length, ordered: true, marker, text: numbered[4] };
  }
  const bullet = String(line).match(BULLET_RE);
  if (bullet) return { indent: bullet[1].length, ordered: false, text: bullet[2] };
  return null;
}

// The marker a canonical ordered list would print at `number`, without the
// trailing ". ": "II", "b", "3". A real ordered list (one Harbor's own
// serializer produced, or an auto-formatted one) numbers its items in
// sequence, so this is how a list is told apart from ordinary prose that
// merely opens with "v." or "C.".
function canonicalMarker(number, type) {
  return orderedMarker(number, type).replace(/[.)]\s*$/, '');
}

// Whether the item at `start` is followed, at the SAME indent, by the canonical
// next marker of its shape (deeper-indented nested children are skipped over).
// This is what separates a real roman or letter list ("I. one" then "II. two")
// from ordinary prose that only opens with such a marker.
function hasCanonicalSuccessor(lines, start, baseIndent, shape) {
  for (let j = start + 1; j < lines.length; j += 1) {
    const line = listLine(lines[j]);
    // Skip a deeper-indented line whether or not it is itself a list marker: it
    // is a nested child of the first item, or a wrapped continuation of it
    // ("I. one\n   continued\nII. two"), and the successor sits below it.
    const indent = line ? line.indent : (lines[j].match(/^(\s*)/)[1].length);
    if (indent > baseIndent) continue;
    if (!line || line.indent < baseIndent) return false;
    return Boolean(line.ordered
      && !DIGIT_MARKER_RE.test(line.marker)
      && line.marker === canonicalMarker(shape.start + 1, shape.type));
  }
  return false;
}

function parseList(lines, start) {
  const first = listLine(lines[start]);
  if (!first) return null;
  const baseIndent = first.indent;
  const ordered = first.ordered;
  const list = { tag: ordered ? 'ol' : 'ul', children: [] };
  let shape = null;
  if (ordered) {
    shape = orderedListShape(first.marker);
    // A non-digit ordered marker ("v.", "C.", "I.") is prose far more often
    // than a list, and turning "v. Smith", "C. Everett" or "IV. Background" into
    // a numbered list on a draft restore rewrites how the user's text reads
    // (data loss / a surprise list, 2026-09-03). Three conditions gate it, and
    // together they mean a non-digit list is accepted ONLY in the exact shape the
    // composer can itself produce: a NATURAL START (its first marker is I, i, A
    // or a, i.e. value one, which is the only roman/letter list auto-format can
    // create), non-empty first text, and a canonical successor on the next line
    // at the same indent. So "C. Everett\nD. Eisenhower" (starts at 3) and
    // "IV. Background\nV. Smith" (starts at 4) stay prose, while "I. one\nII. two"
    // and "a. x\nb. y" are lists. Digit markers stay lenient (a plain "1." list,
    // even a single item, has always been one and older drafts rely on it).
    if (!DIGIT_MARKER_RE.test(first.marker)) {
      if (shape.start !== 1
        || !first.text.trim()
        || !hasCanonicalSuccessor(lines, start, baseIndent, shape)) return null;
    }
    if (shape.type) list.type = shape.type;
    if (shape.start !== 1) list.start = shape.start;
  }
  let i = start;
  let expected = shape ? shape.start : 1;

  while (i < lines.length) {
    const current = listLine(lines[i]);
    if (!current || current.indent < baseIndent) break;

    if (current.indent > baseIndent) {
      const parent = list.children[list.children.length - 1];
      if (!parent) break;
      const nested = parseList(lines, i);
      if (!nested) break;
      parent.children.push(nested.spec);
      i = nested.next;
      continue;
    }

    if (current.ordered !== ordered) break;
    if (ordered) {
      const currentIsDigit = DIGIT_MARKER_RE.test(current.marker);
      if (list.type) {
        // A typed (roman/letter) list only ever comes from Harbor's own
        // serializer, which numbers canonically; a line whose marker is not the
        // next in sequence is a different block, not this list.
        if (currentIsDigit || current.marker !== canonicalMarker(expected, list.type)) break;
      } else if (!currentIsDigit) {
        // A plain digit list does not absorb a stray "v." or "a." prose line.
        break;
      }
    }
    list.children.push({ tag: 'li', children: inlineToSpec(current.text) });
    expected += 1;
    i += 1;
  }

  // A list that consumed no lines is not a list, and returning next === start
  // would spin markdownToSpec forever; this is the hard floor behind the gate
  // above (2026-09-03, after a review found "IIII. four\nV. five" could freeze
  // the renderer before the natural-start rule closed that door).
  if (i === start || list.children.length === 0) return null;
  return { spec: list, next: i };
}

function markdownToSpec(markdown) {
  const source = String(markdown ?? '');
  if (!source) return [];
  const lines = source.split('\n');
  const spec = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence, if it is there at all
      spec.push({ tag: 'pre', children: [body.join('\n')] });
      continue;
    }

    const parsedList = parseList(lines, i);
    if (parsedList) {
      spec.push(parsedList.spec);
      i = parsedList.next;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      // One div per quoted line (2026-09-03), never inline runs split by <br>:
      // Chromium's Enter inside a blockquote holding bare inline content
      // splits the BLOCKQUOTE into two, while Enter inside a div splits the
      // line and stays in the quote. The editor builds the same shape.
      const children = [];
      while (i < lines.length) {
        const match = lines[i].match(QUOTE_RE);
        if (!match) break;
        children.push({ tag: 'div', children: inlineToSpec(match[1]) });
        i += 1;
      }
      spec.push({ tag: 'blockquote', children });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      spec.push({ tag: `h${heading[1].length}`, children: inlineToSpec(heading[2]) });
      i += 1;
      continue;
    }

    spec.push({ tag: 'div', children: inlineToSpec(line) });
    i += 1;
  }

  return spec;
}

// DOM adapter. Separate from markdownToSpec so the parser stays pure and the
// only code that can touch the document is these few lines.
function buildNodes(spec, doc) {
  const fragment = doc.createDocumentFragment();
  for (const item of spec) fragment.appendChild(buildNode(item, doc));
  return fragment;
}

function buildNode(item, doc) {
  if (typeof item === 'string') return doc.createTextNode(item);
  const element = doc.createElement(item.tag);
  if (item.tag === 'a' && item.href) {
    element.setAttribute('href', item.href);
  }
  if (item.tag === 'ol') {
    if (item.type) element.setAttribute('type', item.type);
    // `start` is written for any value other than the default 1, zero included:
    // a truthiness test dropped `start="0"`, so a list the user opened at 0
    // renumbered itself to 1 on the next restore (2026-09-03).
    if (item.start != null && item.start !== 1) element.setAttribute('start', String(item.start));
  }
  for (const child of item.children || []) element.appendChild(buildNode(child, doc));
  // An empty block still needs height, and Chromium will not give it any
  // without a filler; serializeDoc drops these again on the way out.
  if (!(item.children || []).length && (item.tag === 'div' || item.tag === 'li')) {
    element.appendChild(doc.createElement('br'));
  }
  return element;
}

module.exports = {
  MARK_ORDER,
  MARK_WRAP,
  TAG_MARKS,
  serializeDoc,
  markdownToSpec,
  inlineToSpec,
  buildNodes,
  orderedMarker,
  orderedListShape,
};
