'use strict';

// The tile and the visible-pane registration must make the SAME terminal
// decision. They diverged from the Slate redesign until 2026-08-08: the tile
// drew a fallback terminal the registration never fed, so codex fallback
// windows were an empty black box while the session wrote megabytes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalView } = require('../../src/renderer/stage/terminal-view.cjs');

const PANE = { paneId: 'p1' };

test('an explicit tty toggle shows the terminal for any provider', () => {
  for (const provider of ['claude', 'codex', 'cursor']) {
    const view = terminalView({
      session: { id: 'abc', provider }, data: { blocks: [] }, pane: PANE, tty: true,
    });
    assert.equal(view.showTerminal, true, provider);
    assert.equal(view.fallback, false, provider);
  }
});

test('an unnamed live codex pane falls back to its terminal without the toggle', () => {
  for (const provider of ['codex', 'cursor']) {
    const view = terminalView({
      session: { id: 'live:p1', provider }, data: null, pane: PANE, tty: false,
    });
    assert.equal(view.showTerminal, true, provider);
    assert.equal(view.fallback, true, provider);
  }
});

test('a transcript-missing data row still counts as no transcript', () => {
  const view = terminalView({
    session: { id: 'live:p1', provider: 'codex' }, data: { missing: true }, pane: PANE, tty: false,
  });
  assert.equal(view.showTerminal, true);
  assert.equal(view.fallback, true);
});

test('a codex window WITH a transcript renders the conversation, not the terminal', () => {
  const view = terminalView({
    session: { id: '019fe010-da88-7c13-b551-9834713b8352', provider: 'codex' },
    data: { blocks: [{}] }, pane: PANE, tty: false,
  });
  assert.equal(view.showTerminal, false);
  assert.equal(view.fallback, false);
});

test('a provisional pane: window never falls back, and claude never does', () => {
  assert.equal(terminalView({
    session: { id: 'pane:p1', provider: 'codex' }, data: null, pane: PANE, tty: false,
  }).showTerminal, false);
  assert.equal(terminalView({
    session: { id: 'live:p1', provider: 'claude' }, data: null, pane: PANE, tty: false,
  }).showTerminal, false);
});

test('no pane means no terminal, whatever the flags say', () => {
  assert.equal(terminalView({
    session: { id: 'live:p1', provider: 'codex' }, data: null, pane: null, tty: true,
  }).showTerminal, false);
});
