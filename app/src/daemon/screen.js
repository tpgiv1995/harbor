'use strict';

const os = require('node:os');
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

// ConPTY's own cursor arithmetic is the contract this model has to keep, and
// the width table is half of it (live-caught 2026-09-03 off Pat's Data-Mapper
// pane, reproduced against the real CLI in an isolated daemon). ConPTY writes a
// full-width row and TRUSTS the terminal to wrap; it counts `❌` and `✅` as two
// cells, xterm-headless's default Unicode 6 table counts them as one, so the
// modeled row ends a cell short, never wraps, and the next row's first
// character lands on THIS row's last column. Every such row shifts everything
// under it one more column left until ConPTY next positions the cursor
// absolutely, which is what turned `  1. Reassemble…` into `1` at the end of
// one row and `. Reassemble…` at the start of the next and made the question
// card lose its first three options. Unicode 11 widths are what VS Code pairs
// with ConPTY for the same reason.
function windowsPtyCompat() {
  if (process.platform !== 'win32') return undefined;
  const build = Number(String(os.release()).split('.')[2]);
  return { backend: 'conpty', ...(Number.isFinite(build) ? { buildNumber: build } : {}) };
}

// CLAUDE'S PROMPT SUGGESTION (2026-10-05). After a turn, Claude Code can draw a
// predicted next prompt in its composer as DIM text that Tab accepts. It never
// reaches the transcript and an ANSI-stripped scrape cannot tell it from a typed
// draft, so it is read here, where the cells still carry their attributes. The
// composer is the box under a full-width divider whose first row starts "❯ ";
// the suggestion is that box's text when EVERY visible cell after the glyph is
// dim (one typed character means it is a draft, not a suggestion). A fresh
// session's empty composer draws a dim `Try "…"` hint the same way, which is a
// placeholder, not a prediction, so it is dropped. Measured against CLI 2.1.289.
const DIVIDER_RE = /^\s*─{8,}\s*$/;
// The glyph is followed by a NO-BREAK SPACE (U+00A0) in the real CLI; JS \s covers both.
const COMPOSER_RE = /^(\s*)❯\s/;
const PLACEHOLDER_RE = /^Try ".*"$/;

function composerSuggestion(terminal) {
  const buffer = terminal.buffer.active;
  const top = buffer.viewportY;
  const rows = [];
  for (let y = 0; y < terminal.rows; y += 1) rows.push(buffer.getLine(top + y));
  const text = (line) => line?.translateToString(true) || '';
  const cell = buffer.getNullCell();
  for (let y = rows.length - 1; y > 0; y -= 1) {
    const match = COMPOSER_RE.exec(text(rows[y]));
    if (!match || !DIVIDER_RE.test(text(rows[y - 1]))) continue;
    const parts = [];
    for (let row = y; row < rows.length && !DIVIDER_RE.test(text(rows[row])); row += 1) {
      const line = rows[row];
      if (!line) break;
      const start = row === y ? match[1].length + 2 : 0;
      let chunk = '';
      for (let x = start; x < terminal.cols; x += 1) {
        line.getCell(x, cell);
        const ch = cell.getChars();
        if (ch && ch.trim() && !cell.isDim()) return null;
        chunk += ch || ' ';
      }
      if (chunk.trim()) parts.push(chunk.trim());
    }
    const suggestion = parts.join(' ').replace(/\s+/g, ' ').trim();
    return suggestion && !PLACEHOLDER_RE.test(suggestion) ? suggestion : null;
  }
  return null;
}

class ScreenModel {
  constructor({ cols, rows, scrollback = 10000 }) {
    this.terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true, windowsPty: windowsPtyCompat() });
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.pending = Promise.resolve();
  }

  write(data) {
    this.pending = this.pending.then(() => new Promise((resolve) => this.terminal.write(data, resolve)));
    return this.pending;
  }

  resize(cols, rows) {
    this.terminal.resize(cols, rows);
  }

  async read(scrollback = 0) {
    await this.pending;
    const buffer = this.terminal.buffer.active;
    const visibleStart = buffer.viewportY;
    const first = Math.max(0, visibleStart - Math.max(0, scrollback));
    const last = Math.min(buffer.length, visibleStart + this.terminal.rows);
    const lines = [];
    const visible = [];
    for (let index = first; index < last; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) || '';
      lines.push(line);
      if (index >= visibleStart) visible.push(line);
    }
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      text: lines.join('\n'),
      visible: visible.join('\n'),
      scrollback_lines: visibleStart,
      suggestion: safeSuggestion(this.terminal),
    };
  }
}

// Every pane read in Harbor (dialog detection, menus, sends, the raw terminal)
// comes through read() above. The suggestion is a convenience, so a fault in
// reading it is "no suggestion", never a failed read.
function safeSuggestion(terminal) {
  try { return composerSuggestion(terminal); } catch { return null; }
}

module.exports = { ScreenModel, windowsPtyCompat, composerSuggestion };
