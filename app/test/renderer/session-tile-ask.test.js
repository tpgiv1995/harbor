'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const askCardSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/stage/AskCard.jsx'),
  'utf8',
);
const sessionTileSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/stage/SessionTile.jsx'),
  'utf8',
);

test('Ask card poll re-arms when sessionId changes after a provisional upgrade', () => {
  assert.match(askCardSource, /}, \[paneId, sessionId, pane, blockedHint\]\)/);
  assert.doesNotMatch(askCardSource, /eslint-disable-line react-hooks\/exhaustive-deps/);
});

test('the session window mounts the answer sheet, and nothing else answers dialogs', () => {
  assert.match(sessionTileSource, /import \{ AskCard \} from '\.\/AskCard\.jsx'/);
  assert.match(sessionTileSource, /<AskCard\n/);
  assert.doesNotMatch(sessionTileSource, /TileMenuAsk|askKeyAction|ask-keys/);
});

test('no arrow key is forwarded to the pty from the card', () => {
  // The old card sent ↑/↓/←/→ as raw keys and waited a poll for the pointer
  // to move. The sheet moves a LOCAL highlight and delivers once; the only
  // raw keys left are the fallback panel's and the clipped-pane row's, both
  // of which drive the terminal highlight by hand on purpose and say so.
  const keySends = askCardSource.match(/type: 'key'/g) || [];
  assert.equal(keySends.length, 3, 'exactly three places send raw keys: the fallback panel, the clipped-pane keys, and the review\'s labelled ← Back');
  assert.doesNotMatch(askCardSource, /key: 'right'/, 'next-question never goes to the pty');
  const lefts = askCardSource.match(/key: 'left'/g) || [];
  assert.equal(lefts.length, 1, 'one ← only: the review screen\'s way back to the open questions');
  assert.match(askCardSource, /key: 'left' \}\); \}\}>← Back to the questions/, 'and it is labelled as exactly that key');
  assert.doesNotMatch(askCardSource, /onKeyDown[\s\S]{0,400}run\(\{ type: 'key'/, 'no keyboard handler forwards a key');
});
