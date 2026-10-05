'use strict';

const { markdownToSpec } = require('../renderer/stage/compose-doc.cjs');

const INLINE_TAGS = new Set(['strong', 'em', 's', 'u', 'code', 'a', 'br']);

// Paste target is Word (Outlook and Teams both route through it). Pat's manual
// cleanup of a pasted draft is always the same four moves: zero the space
// BEFORE each paragraph, zero the space AFTER it, set line spacing to 1.15, and
// put a REAL empty line between paragraphs. A paragraph bottom-margin is exactly
// the "fake line skip" he then has to strip: Word shows it as space-after, but
// it is not a line he can click into. So this exporter does his four moves for
// him. Every block carries margin:0 (no space before or after) and
// line-height:1.15, and a genuine empty paragraph (an EMPTY_LINE spacer) is
// emitted wherever the source markdown had a blank line between blocks. Result:
// no gap above line one, tight bullets, and one true empty line between
// paragraphs, nothing left to fix by hand. Hard contract, covered by the tests.
const PARA_STYLE = 'margin:0; line-height:1.15';
const BLOCK_STYLE = {
  p: PARA_STYLE,
  h1: PARA_STYLE,
  h2: PARA_STYLE,
  h3: PARA_STYLE,
  h4: PARA_STYLE,
  h5: PARA_STYLE,
  h6: PARA_STYLE,
  ul: 'margin:0; padding-left:24px',
  ol: 'margin:0; padding-left:24px',
  li: PARA_STYLE,
  blockquote: 'margin:0 0 0 24px; line-height:1.15',
  pre: PARA_STYLE,
};

// A real empty paragraph, not a margin. This is the "actual line skipped" Pat
// wants between paragraphs instead of paragraph spacing.
const EMPTY_LINE = `<p style="${PARA_STYLE}"><br></p>`;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(value) {
  // Allowlist, not a denylist: this module lives in shared/ and its output
  // will not always stop at the clipboard, so data:, vbscript:, and every
  // scheme nobody thought of die here too. Scheme-less (relative, anchor)
  // hrefs pass through, and file: stays because intranet share links are
  // ordinary content in the Teams/Outlook drafts this feature exists for.
  const href = String(value ?? '').replace(/^[\u0000-\u0020]+/, '').trim();
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return href;
  return ['http', 'https', 'mailto', 'file'].includes(scheme[1].toLowerCase()) ? href : '#';
}

// Consecutive non-blank lines merge into one <p> (joined by <br>, a soft break
// like "Thanks,\nPat"); a blank line ends the paragraph. With { spacers: true }
// a blank line BETWEEN two blocks also records a `{ tag: 'spacer' }` marker, so
// the HTML export can render it as a real empty paragraph. Leading, trailing,
// and repeated blanks never produce a spacer (nothing to separate), which is
// why the guard is `blankPending && blocks.length`.
function paragraphBlocks(spec, { spacers = false } = {}) {
  const blocks = [];
  let paragraph = [];
  let blankPending = false;
  const push = (block) => {
    if (spacers && blankPending && blocks.length) blocks.push({ tag: 'spacer', children: [] });
    blocks.push(block);
    blankPending = false;
  };
  const flush = () => {
    if (!paragraph.length) return;
    const children = [];
    paragraph.forEach((line, index) => {
      if (index) children.push({ tag: 'br', children: [] });
      children.push(...line);
    });
    push({ tag: 'p', children });
    paragraph = [];
  };
  for (const item of spec) {
    if (item?.tag === 'div') {
      if ((item.children || []).length === 0) { flush(); blankPending = true; }
      else paragraph.push(item.children || []);
      continue;
    }
    flush();
    push(item);
  }
  flush();
  return blocks;
}

function htmlNode(node) {
  if (typeof node === 'string') return escapeHtml(node);
  if (!node || typeof node !== 'object') return '';
  const tag = String(node.tag || '').toLowerCase();
  if (tag === 'br') return '<br>';
  if (tag === 'spacer') return EMPTY_LINE;
  const children = (node.children || []).map(htmlNode).join('');
  if (tag === 'a') return `<a href="${escapeHtml(safeHref(node.href))}">${children}</a>`;
  const attr = BLOCK_STYLE[tag] ? ` style="${BLOCK_STYLE[tag]}"` : '';
  if (tag === 'pre') return `<pre${attr}>${children}</pre>`;
  if (INLINE_TAGS.has(tag) || ['p', 'ul', 'ol', 'li', 'blockquote'].includes(tag)
    || /^h[1-6]$/.test(tag)) {
    return `<${tag}${attr}>${children}</${tag}>`;
  }
  return children;
}

function markdownToHtml(markdown) {
  const blocks = paragraphBlocks(markdownToSpec(String(markdown ?? '')), { spacers: true });
  return `<div>${blocks.map(htmlNode).join('')}</div>`;
}

function inlineText(nodes) {
  return (nodes || []).map((node) => {
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return '';
    if (node.tag === 'br') return '\n';
    return inlineText(node.children);
  }).join('');
}

function listText(node, depth = 0) {
  const lines = [];
  let number = 1;
  for (const item of node.children || []) {
    if (item?.tag !== 'li') continue;
    const inline = (item.children || []).filter((child) => !['ul', 'ol'].includes(child?.tag));
    const nested = (item.children || []).filter((child) => ['ul', 'ol'].includes(child?.tag));
    const marker = node.tag === 'ol' ? `${number}. ` : '- ';
    const textLines = inlineText(inline).split('\n');
    lines.push(`${'  '.repeat(depth)}${marker}${textLines[0] || ''}`);
    for (const continuation of textLines.slice(1)) {
      lines.push(`${'  '.repeat(depth)}${' '.repeat(marker.length)}${continuation}`);
    }
    for (const child of nested) lines.push(...listText(child, depth + 1));
    number += 1;
  }
  return lines;
}

function plainBlock(node) {
  const tag = node?.tag;
  if (tag === 'ul' || tag === 'ol') return listText(node).join('\n');
  if (tag === 'blockquote') {
    return inlineText(node.children).split('\n').map((line) => `> ${line}`).join('\n');
  }
  if (tag === 'pre') return inlineText(node.children);
  return inlineText(node?.children);
}

function markdownToPlainText(markdown) {
  return paragraphBlocks(markdownToSpec(String(markdown ?? '')))
    .map(plainBlock)
    .filter((block) => block !== '')
    .join('\n\n');
}

module.exports = { markdownToHtml, markdownToPlainText };
