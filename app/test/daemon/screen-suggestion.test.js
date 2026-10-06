'use strict';

// Claude's prompt suggestion is DIM text in its composer box; a typed draft is
// not. Only the cell attributes tell them apart, so the screen model reports
// it (src/daemon/screen.js composerSuggestion). Shapes measured against the
// real CLI 2.1.289 on 2026-10-05.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ScreenModel } = require('../../src/daemon/screen.js');

const COLS = 60;
const DIV = '─'.repeat(COLS);
const DIM = (s) => `\x1b[2m${s}\x1b[22m`;

async function read(composerRows) {
  const screen = new ScreenModel({ cols: COLS, rows: 12, scrollback: 0 });
  const lines = ['⏺ Use piexif to read EXIF dates.', '', DIV, ...composerRows, DIV, '  ⏸ manual mode on'];
  await screen.write(lines.join('\r\n'));
  return (await screen.read(0)).suggestion;
}

test('a dim composer line is the suggestion', async () => {
  assert.equal(await read([`❯ ${DIM('show me how to rename the file with that date')}`]), 'show me how to rename the file with that date');
});

test('the real CLI puts a no-break space after the glyph', async () => {
  assert.equal(await read([`❯\u00a0${DIM('show me how to rename the file with that date')}`]), 'show me how to rename the file with that date');
});

test('a suggestion that wraps inside the box is joined', async () => {
  assert.equal(await read([`❯ ${DIM('now write the loop that renames')}`, `  ${DIM('every photo in the folder')}`]), 'now write the loop that renames every photo in the folder');
});

test('typed text is a draft, never a suggestion', async () => {
  assert.equal(await read(['❯ push the guard']), null);
  assert.equal(await read([`❯ push ${DIM('the guard')}`]), null);
});

test('an empty composer and the fresh-session Try hint are not suggestions', async () => {
  assert.equal(await read(['❯ ']), null);
  assert.equal(await read([`❯ ${DIM('Try "fix typecheck errors"')}`]), null);
});

test('a ❯ row without the divider above it (a menu) is ignored', async () => {
  const screen = new ScreenModel({ cols: COLS, rows: 8, scrollback: 0 });
  await screen.write(['Pick one', `❯ ${DIM('1. Yes')}`, '  2. No'].join('\r\n'));
  assert.equal((await screen.read(0)).suggestion, null);
});
