'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnboundWatch } = require('../../src/renderer/stage/unbound-watch.cjs');

test('a window stuck unbound is reported once after 45 s, with what the rail knew, and again when it binds', () => {
  const check = createUnboundWatch();
  const sessions = new Map([['real-1', { id: 'real-1', paneId: 'p1', provider: 'claude' }]]);
  const tiles = [{ sessionId: 'pane:p1' }, { sessionId: 'real-2' }, { sessionId: 'real-3' }];
  const transcripts = new Map([['real-2', { blocks: [], missing: true }], ['real-3', { blocks: [{}] }]]);
  assert.deepEqual(check({ tiles, transcripts, sessions, now: 0 }), []);
  assert.deepEqual(check({ tiles, transcripts, sessions, now: 44_000 }), []);
  const events = check({ tiles, transcripts, sessions, now: 45_000 });
  assert.deepEqual(events, [
    { kind: 'window-unbound', ms: 45_000, context: { window: 'pane:p1', provisional: true, transcriptMissing: false, neverOpened: false, rail: { id: 'real-1', paneId: 'p1', provider: 'claude', live: true } } },
    { kind: 'window-unbound', ms: 45_000, context: { window: 'real-2', provisional: false, transcriptMissing: true, neverOpened: false, rail: null } },
  ]);
  assert.deepEqual(check({ tiles, transcripts, sessions, now: 90_000 }), [], 'once only');
  // The pane window is renamed to its session; real-2's transcript arrives.
  const later = [{ sessionId: 'real-1' }, { sessionId: 'real-2' }, { sessionId: 'real-3' }];
  const loaded = new Map([['real-1', { blocks: [{}] }], ['real-2', { blocks: [{}] }], ['real-3', { blocks: [{}] }]]);
  assert.deepEqual(check({ tiles: later, transcripts: loaded, sessions, now: 100_000 }), [
    { kind: 'window-bound', ms: 100_000, context: { window: 'real-2' } },
    { kind: 'window-left', ms: 100_000, context: { window: 'pane:p1' } },
  ]);
});

test('a window that binds before 45 s leaves nothing in the log', () => {
  const check = createUnboundWatch();
  check({ tiles: [{ sessionId: 'pane:p9' }], now: 0 });
  assert.deepEqual(check({ tiles: [{ sessionId: 'real-9' }], transcripts: new Map([['real-9', { blocks: [] }]]), now: 20_000 }), []);
});

// Astra's round 3: a transcript open that keeps failing leaves no "missing"
// record at all, and that window must be reported too.
test('a window whose transcript open never answered is reported as never opened', () => {
  const check = createUnboundWatch();
  const tiles = [{ sessionId: 'real-7' }];
  check({ tiles, transcripts: new Map(), now: 0 });
  assert.deepEqual(check({ tiles, transcripts: new Map(), now: 46_000 }), [
    { kind: 'window-unbound', ms: 46_000, context: { window: 'real-7', provisional: false, transcriptMissing: false, neverOpened: true, rail: null } },
  ]);
});
