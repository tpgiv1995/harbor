'use strict';

// The modeled screen has to agree with ConPTY about how wide a glyph is.
//
// Live-caught 2026-09-03 off Pat's Data-Mapper-Live pane and reproduced against
// the real CLI in an isolated daemon: ConPTY writes a full-width row and trusts
// the terminal to wrap at the edge, and it counts `❌`/`✅` as two cells.
// xterm-headless's default Unicode 6 table counted them as one, so the modeled
// row ended a cell short, never wrapped, and the next row's first character was
// painted onto the previous row's last column. Every emoji-bearing row shifted
// the rows under it one more column left, which is how `  1. Reassemble…`
// became `1` at the end of one row and `. Reassemble…` at the start of the
// next, and how the question card lost options 1 to 3.
//
// Two-sided on purpose: the ASCII control proves the wrap itself works either
// way, so a pass cannot come from the emoji row being ignored.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ScreenModel, windowsPtyCompat } = require('../../src/daemon/screen.js');

const COLS = 24;

// A row that is EXACTLY `COLS` cells wide by ConPTY's arithmetic (an emoji is
// two cells), followed by the next row's text with no carriage return, which
// is the shape ConPTY emits when it relies on the terminal's wrap.
function fullRowThen(glyph, glyphCells, next) {
  return 'x'.repeat(COLS - glyphCells) + glyph + next;
}

async function rowsAfter(text) {
  const screen = new ScreenModel({ cols: COLS, rows: 4 });
  await screen.write(text);
  const read = await screen.read();
  return read.visible.split('\n');
}

test('an ASCII row that fills the pane wraps the next character to column 0 (control)', async () => {
  const rows = await rowsAfter(fullRowThen('z', 1, 'NEXT'));
  assert.equal(rows[0], 'x'.repeat(COLS - 1) + 'z');
  assert.equal(rows[1], 'NEXT');
});

for (const glyph of ['❌', '✅', '📊']) {
  test(`a full row ending in ${glyph} wraps the next character to column 0, as ConPTY expects`, async () => {
    const rows = await rowsAfter(fullRowThen(glyph, 2, 'NEXT'));
    assert.equal(rows[0], 'x'.repeat(COLS - 2) + glyph, `the ${glyph} row must end at the pane edge, not a cell short`);
    assert.equal(rows[1], 'NEXT', `the next row's first character must not land on the ${glyph} row`);
  });
}

test('the shift compounds per emoji row without the fix, and does not with it', async () => {
  // Three ConPTY-style full rows in a row, each carrying one emoji, then an
  // option row. This is the Data-Mapper pane in miniature.
  const text = [
    fullRowThen('❌', 2, ''),
    fullRowThen('❌', 2, ''),
    fullRowThen('❌', 2, ''),
    '  1. Reassemble',
  ].join('');
  const rows = await rowsAfter(text);
  assert.equal(rows[3], '  1. Reassemble', 'the option row must start on its own row at column 0');
});

test('windowsPtyCompat names ConPTY only on win32', () => {
  const compat = windowsPtyCompat();
  if (process.platform === 'win32') {
    assert.equal(compat.backend, 'conpty');
    assert.ok(Number.isInteger(compat.buildNumber) && compat.buildNumber > 0);
  } else {
    assert.equal(compat, undefined);
  }
});
