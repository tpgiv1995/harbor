'use strict';

// The screen model states the pane's input modes (src/daemon/screen.js
// inputModes, 2026-10-24) so a >_ view opened long after the CLI switched them
// on can copy them. The switches are the ones Claude Code 2.1.303 sends at
// startup in its fullscreen renderer, measured in an isolated daemon.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ScreenModel } = require('../../src/daemon/screen.js');

test('mouse reporting, its SGR encoding, bracketed paste and a hidden cursor are reported', async () => {
  const screen = new ScreenModel({ cols: 60, rows: 10, scrollback: 0 });
  await screen.write('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?25l');
  await screen.write('   Manage MCP servers\r\n   ❯ ✔ azure-sandbox   9 tools');
  const read = await screen.read(0);
  assert.equal(read.modes?.mouseTracking, 'any');
  assert.equal(read.modes?.mouseEncoding, 'SGR');
  assert.equal(read.modes?.bracketedPaste, true);
  assert.equal(read.modes?.cursorHidden, true);
  assert.equal(read.modes?.applicationCursorKeys, false);
});

test('a mode switched off again is reported off', async () => {
  const screen = new ScreenModel({ cols: 60, rows: 10, scrollback: 0 });
  await screen.write('\x1b[?1003h\x1b[?1006h\x1b[?2004h');
  await screen.write('\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h');
  const read = await screen.read(0);
  assert.equal(read.modes?.mouseTracking, 'none');
  assert.equal(read.modes?.bracketedPaste, false);
  assert.equal(read.modes?.cursorHidden, false);
});
