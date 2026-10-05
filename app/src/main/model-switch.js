'use strict';

const { isDividerLine } = require('../shared/divider.cjs');

function paragraphs(lines) {
  return lines.join('\n').trim().split(/\n\s*\n/)
    .map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' '))
    .join('\n\n');
}

// Recognize the title and pointed option block, never verbs in the labels.
function parseModelSwitch(screen) {
  const lines = String(screen || '').split('\n');
  const start = lines.findLastIndex(line => /^\s*(?:You've reached your .+ limit|Session paused)\s*$/.test(line));
  if (start < 0) return null;
  const tail = lines.slice(start + 1);
  const stale = tail.some((line, index) => /^\s*\u276f\s*$/.test(line)
    || (/^\s*\u276f\s/.test(line) && isDividerLine(tail[index - 1]))
    || /esc to interrupt/i.test(line));
  if (stale) return null;

  const pointer = tail.findIndex(line => /^\s*\u276f\s+\S/.test(line));
  const footer = tail.filter(line => /Enter to confirm|Esc to cancel/.test(line)).map(line => line.trim()).join(' ');
  const waiting = tail.find(line => /Checking usage credits/.test(line))?.trim().replace(/^[^\p{L}]+/u, '') || '';
  if (pointer < 0 && !waiting) return null;

  const options = [];
  let blockStart = pointer;
  if (pointer >= 0) {
    const pointed = tail[pointer].match(/^(\s*)\u276f\s+(?:(\d+)\.\s*)?(.*)$/u);
    const column = tail[pointer].indexOf(pointed[2] ? pointed[2] + '.' : pointed[3]);
    const numbered = Boolean(pointed[2]);
    // Blank lines delimit the block. Wrapped labels continue farther in.
    while (blockStart > 0 && tail[blockStart - 1].trim() && !isDividerLine(tail[blockStart - 1], 3)) blockStart--;
    let current = null;
    for (let index = blockStart; index < tail.length; index++) {
      const line = tail[index];
      if (!line.trim() || /Enter to confirm|Esc to cancel|Waiting for API response/.test(line) || isDividerLine(line, 3)) break;
      const match = line.match(/^(\s*)(\u276f)?\s*(?:(\d+)\.\s*)?(.*\S)\s*$/u);
      if (!match) continue;
      const contentColumn = match[2] ? column : line.search(/\S/);
      const row = contentColumn === column && (!numbered || Boolean(match[3]));
      if (row) {
        current = {
          index: numbered ? Number(match[3]) : options.length + 1,
          label: match[4].trim(),
          selected: Boolean(match[2]),
          numbered,
          isText: false,
        };
        options.push(current);
      } else if (current && contentColumn > column) {
        current.label += ' ' + line.trim();
      } else if (current) {
        break;
      }
    }
  }
  if (pointer >= 0 && !options.some(option => option.selected)) return null;
  const proseEnd = pointer >= 0 ? blockStart : tail.findIndex(line => /Checking usage credits/.test(line));
  return {
    kind: 'model-switch',
    title: lines[start].trim(),
    question: lines[start].trim(),
    explanation: paragraphs(tail.slice(0, proseEnd)),
    waiting,
    options,
    footer,
    canCancel: /Esc to cancel/.test(footer),
    selectedIndex: options.findIndex(option => option.selected),
    multiSelect: false,
  };
}

module.exports = { parseModelSwitch };
