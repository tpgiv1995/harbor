'use strict';

// THE MODELED SCREEN KEEPS WHAT A READER CAN ASK FOR, NOT 10,000 LINES
// (2026-11-06). Every session's keeper holds one ScreenModel; with 10,000 lines
// of modeled scrollback sixteen keepers each committed 53-194 MB, against about
// 46 MB for a bare node + ConPTY + empty model, and the largest read anywhere is
// 200 lines. The bound is a named constant; this pins that it still covers every
// reader with margin and that the model really stops at it (two-sided: a model
// built with the old 10,000 keeps far more).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ScreenModel, MODELED_SCROLLBACK_LINES } = require('../../src/daemon/screen.js');

const SRC = path.resolve(__dirname, '../../src');
const ROWS = 24;
const WRITTEN = 5000;

async function fill(screen) {
  for (let start = 1; start <= WRITTEN; start += 500) {
    let chunk = '';
    for (let i = start; i < start + 500; i += 1) chunk += `line ${i}\r\n`;
    await screen.write(chunk);
  }
}

test('the default model keeps its scrollback bounded, and a reader of 200 lines still gets 200 lines', async () => {
  const screen = new ScreenModel({ cols: 80, rows: ROWS });
  await fill(screen);
  const read = await screen.read(200);
  const lines = read.text.split('\n');
  assert.ok(lines.length >= 200, `a 200-line read returned ${lines.length} lines`);
  assert.ok(read.text.includes(`line ${WRITTEN}`), 'the newest line is there');
  assert.ok(read.text.includes(`line ${WRITTEN - 190}`), 'and so are lines 190 back');

  const deep = await screen.read(WRITTEN);
  assert.ok(deep.scrollback_lines <= MODELED_SCROLLBACK_LINES,
    `the model kept ${deep.scrollback_lines} lines above the screen, more than the ${MODELED_SCROLLBACK_LINES} it is allowed`);
  assert.ok(deep.scrollback_lines >= MODELED_SCROLLBACK_LINES - 1, 'and it did fill what it is allowed');
  assert.ok(!deep.text.includes('line 100\n'), 'the oldest lines are gone');
});

test('the previous 10,000-line model keeps several times as much (the control)', async () => {
  const screen = new ScreenModel({ cols: 80, rows: ROWS, scrollback: 10000 });
  await fill(screen);
  const deep = await screen.read(WRITTEN);
  assert.ok(deep.scrollback_lines > MODELED_SCROLLBACK_LINES * 2,
    `the control kept only ${deep.scrollback_lines} lines`);
});

test('the bound covers the largest read anywhere in the app, with margin', () => {
  const bridge = fs.readFileSync(path.join(SRC, 'main/terminal-bridge.js'), 'utf8');
  const backfill = Number(/const BACKFILL_LINES = (\d+);/.exec(bridge)?.[1]);
  assert.ok(Number.isInteger(backfill) && backfill > 0, 'terminal-bridge BACKFILL_LINES moved: update this test');
  const client = fs.readFileSync(path.join(SRC, 'main/session-daemon/client.js'), 'utf8');
  const readDefault = Number(/params\.lines > 0 \? params\.lines : (\d+);/.exec(client)?.[1]);
  assert.ok(Number.isInteger(readDefault) && readDefault > 0, 'readPane default moved: update this test');
  const largest = Math.max(backfill, readDefault);
  assert.ok(MODELED_SCROLLBACK_LINES >= largest * 5,
    `${MODELED_SCROLLBACK_LINES} modeled lines is under 5x the largest read (${largest}); raise it with the reader`);
});
