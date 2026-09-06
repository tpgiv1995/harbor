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
    };
  }
}

module.exports = { ScreenModel, windowsPtyCompat };
