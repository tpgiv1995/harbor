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
  if (!isElement(node)) return;
  const tag = nodeName(node);
  if (tag === 'BR') {
    runs.push({ br: true });
    return;
  }
  const mark = TAG_MARKS[tag];
  const nextMarks = mark ? new Set([...marks, mark]) : marks;
  const nextLink = tag === 'A' ? (linkHref(node) || link) : link;
  for (const child of childrenOf(node)) collectRuns(child, nextMarks, nextLink, runs);
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
  const inline = [];
  const nested = [];
  for (const child of childrenOf(item)) {
    if (nodeName(child) === 'UL' || nodeName(child) === 'OL') nested.push(child);
    else inline.push(child);
  }
  const parts = inlineFromNodes(inline).split('\n');
  lines.push(`${indent}${marker}${parts[0] ?? ''}`);
  // A wrapped item lines up under its own text, not under the marker.
  const continuation = `${indent}${' '.repeat(marker.length)}`;
  for (const extra of parts.slice(1)) lines.push(`${continuation}${extra}`);
  for (const list of nested) emitBlock(list, lines, continuation);
}

function emitBlock(node, lines, indent) {
  const tag = nodeName(node);

  if (tag === 'UL' || tag === 'OL') {
    let number = 1;
    for (const item of childrenOf(node)) {
      if (nodeName(item) !== 'LI') continue;
      emitListItem(item, lines, indent, tag === 'OL' ? `${number}. ` : '- ');
      number += 1;
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

const BULLET_RE = /^(\s*)[-*]\s+(.*)$/;
const NUMBER_RE = /^(\s*)\d{1,9}[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

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

    const ordered = NUMBER_RE.test(line);
    if (ordered || BULLET_RE.test(line)) {
      const itemRe = ordered ? NUMBER_RE : BULLET_RE;
      const items = [];
      while (i < lines.length) {
        const match = lines[i].match(itemRe);
        if (!match) break;
        items.push({ tag: 'li', children: inlineToSpec(match[2]) });
        i += 1;
      }
      spec.push({ tag: ordered ? 'ol' : 'ul', children: items });
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const children = [];
      while (i < lines.length) {
        const match = lines[i].match(QUOTE_RE);
        if (!match) break;
        if (children.length) children.push({ tag: 'br' });
        children.push(...inlineToSpec(match[1]));
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
};
