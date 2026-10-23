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
  assert.match(askCardSource, /}, \[paneId, sessionId, pane, blockedHint, watchOnly\]\)/);
  assert.doesNotMatch(askCardSource, /eslint-disable-line react-hooks\/exhaustive-deps/);
});

// 2026-10-14: a window left on its raw terminal must still mark its session
// as waiting on you, so the card stays mounted there, watching only (it
// renders nothing and its poll never sends a key), and every dialog it sees
// is published, not only the model switch.
test('the card stays mounted behind the raw terminal, watching, and publishes every dialog', () => {
  assert.match(sessionTileSource, /watchOnly=\{showTerminal\}/);
  assert.doesNotMatch(sessionTileSource, /!readOnly && !showTerminal && session\.provider === 'claude'/);
  assert.match(askCardSource, /observe: watchOnly/);
  assert.match(askCardSource, /if \(watchOnly\) return null;/);
  assert.match(askCardSource, /const waiting = Boolean\(menu\);/);
  assert.match(askCardSource, /dialogStore\.set\(sessionId, waiting\)/);
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

// Codex's approvals and request_user_input questions parse into the same menu
// shape (codex-screen.js), so the same card answers them.
test('the answer sheet mounts for Codex windows as well as Claude ones', () => {
  assert.match(sessionTileSource, /\(session\.provider === 'claude' \|\| session\.provider === 'codex'\) \? \(/);
  assert.match(askCardSource, /codex \? 'Codex is asking' : 'Claude is asking'/);
});
