'use strict';

const { markdownToSpec } = require('../renderer/stage/compose-doc.cjs');

const INLINE_TAGS = new Set(['strong', 'em', 's', 'u', 'code', 'a', 'br']);

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

function paragraphBlocks(spec) {
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    const children = [];
    paragraph.forEach((line, index) => {
      if (index) children.push({ tag: 'br', children: [] });
      children.push(...line);
    });
    blocks.push({ tag: 'p', children });
    paragraph = [];
  };
  for (const item of spec) {
    if (item?.tag === 'div') {
      if ((item.children || []).length === 0) flush();
      else paragraph.push(item.children || []);
      continue;
    }
    flush();
    blocks.push(item);
  }
  flush();
  return blocks;
}

function htmlNode(node) {
  if (typeof node === 'string') return escapeHtml(node);
  if (!node || typeof node !== 'object') return '';
  const tag = String(node.tag || '').toLowerCase();
  if (tag === 'br') return '<br>';
  const children = (node.children || []).map(htmlNode).join('');
  if (tag === 'a') return `<a href="${escapeHtml(safeHref(node.href))}">${children}</a>`;
  if (tag === 'pre') return `<pre>${children}</pre>`;
  if (INLINE_TAGS.has(tag) || ['p', 'ul', 'ol', 'li', 'blockquote'].includes(tag)
    || /^h[1-6]$/.test(tag)) {
    return `<${tag}>${children}</${tag}>`;
  }
  return children;
}

function markdownToHtml(markdown) {
  const blocks = paragraphBlocks(markdownToSpec(String(markdown ?? '')));
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
