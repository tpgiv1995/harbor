'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sessionTileSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/stage/SessionTile.jsx'),
  'utf8',
);

test('Ask card poll re-arms when sessionId changes after a provisional upgrade', () => {
  assert.match(sessionTileSource, /}, \[paneId, sessionId, pane, blockedHint\]\)/);
  assert.doesNotMatch(sessionTileSource, /eslint-disable-line react-hooks\/exhaustive-deps/);
});
