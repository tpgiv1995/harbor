'use strict';

const { Terminal } = require('@xterm/headless');

class ScreenModel {
  constructor({ cols, rows, scrollback = 10000 }) {
    this.terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
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

module.exports = { ScreenModel };
