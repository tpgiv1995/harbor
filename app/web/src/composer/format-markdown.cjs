'use strict';

// Markdown wrap helpers for a plain textarea composer. The wire is markdown and
// the draft IS the wire, so these insert delimiters around the selection rather
// than running a second serializer. compose-doc.cjs remains the authority for
// WYSIWYG DOM conversion on desktop; this is the phone-appropriate twin.

function selectionSlice(text, start, end) {
  const value = String(text || '');
  const a = Math.max(0, Math.min(start, value.length));
  const b = Math.max(a, Math.min(end, value.length));
  return { value, start: a, end: b, selected: value.slice(a, b) };
}

function replaceRange(text, start, end, insert) {
  const next = `${text.slice(0, start)}${insert}${text.slice(end)}`;
  return { text: next, selectionStart: start, selectionEnd: start + insert.length };
}

function wrapInline(text, start, end, before, after = before) {
  const { value, start: a, end: b, selected } = selectionSlice(text, start, end);
  if (!selected) {
    const insert = `${before}${after}`;
    return replaceRange(value, a, b, insert);
  }
  if (selected.startsWith(before) && selected.endsWith(after)) {
    const inner = selected.slice(before.length, selected.length - after.length);
    return replaceRange(value, a, b, inner);
  }
  return replaceRange(value, a, b, `${before}${selected}${after}`);
}

function lineBounds(text, index) {
  const value = String(text || '');
  const pos = Math.max(0, Math.min(index, value.length));
  const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = value.indexOf('\n', pos);
  return { lineStart, lineEnd: lineEnd === -1 ? value.length : lineEnd };
}

function toggleLinePrefix(text, start, end, prefix) {
  const { value } = selectionSlice(text, start, end);
  const { lineStart } = lineBounds(value, start);
  const { lineEnd } = lineBounds(value, end);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const allPrefixed = lines.every((line) => !line.trim() || line.startsWith(prefix));
  const nextLines = lines.map((line) => {
    if (!line.trim()) return line;
    if (allPrefixed) return line.startsWith(prefix) ? line.slice(prefix.length) : line;
    return line.startsWith(prefix) ? line : `${prefix}${line}`;
  });
  const nextBlock = nextLines.join('\n');
  return replaceRange(value, lineStart, lineEnd, nextBlock);
}

function toggleQuote(text, start, end) {
  return toggleLinePrefix(text, start, end, '> ');
}

function toggleBullets(text, start, end) {
  return toggleLinePrefix(text, start, end, '- ');
}

function toggleNumbers(text, start, end) {
  const { value } = selectionSlice(text, start, end);
  const { lineStart } = lineBounds(value, start);
  const { lineEnd } = lineBounds(value, end);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const numbered = lines.every((line) => /^\d+\.\s/.test(line));
  const nextLines = lines.map((line, index) => {
    if (!line.trim()) return line;
    if (numbered) return line.replace(/^\d+\.\s/, '');
    return `${index + 1}. ${line}`;
  });
  return replaceRange(value, lineStart, lineEnd, nextLines.join('\n'));
}

function toggleHeading(text, start, end) {
  const { value } = selectionSlice(text, start, end);
  const { lineStart } = lineBounds(value, start);
  const { lineEnd } = lineBounds(value, end);
  const line = value.slice(lineStart, lineEnd).split('\n')[0] || '';
  const stripped = line.replace(/^#{1,6}\s+/, '');
  const nextLine = line.startsWith('## ') ? stripped : `## ${stripped}`;
  return replaceRange(value, lineStart, lineEnd, nextLine);
}

function toggleCodeBlock(text, start, end) {
  const { value, start: a, end: b, selected } = selectionSlice(text, start, end);
  const fenced = selected.startsWith('```') && selected.endsWith('```');
  if (fenced) {
    const inner = selected.replace(/^```\n?/, '').replace(/\n?```$/, '');
    return replaceRange(value, a, b, inner);
  }
  const body = selected || 'code';
  return replaceRange(value, a, b, `\`\`\`\n${body}\n\`\`\``);
}

const ACTIONS = {
  bold: (text, start, end) => wrapInline(text, start, end, '**'),
  italic: (text, start, end) => wrapInline(text, start, end, '*'),
  strike: (text, start, end) => wrapInline(text, start, end, '~~'),
  underline: (text, start, end) => wrapInline(text, start, end, '<u>', '</u>'),
  code: (text, start, end) => wrapInline(text, start, end, '`'),
  quote: toggleQuote,
  bullets: toggleBullets,
  numbers: toggleNumbers,
  heading: toggleHeading,
  codeblock: toggleCodeBlock,
};

function applyFormat(text, start, end, action) {
  const fn = ACTIONS[action];
  if (!fn) return { text, selectionStart: start, selectionEnd: end };
  return fn(text, start, end);
}

module.exports = { applyFormat };
