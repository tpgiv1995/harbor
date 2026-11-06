'use strict';

// ONE SCREEN READ PER ASK INSIDE A MENU POLL (2026-11-06). Each open Claude
// window polls getMenu; one poll of a pane with no dialog used to make five or
// six daemon round trips for the same screen (readMenu recent + visible,
// readFallback recent, readList visible + recent). Measured live: 7,434 screen
// reads a minute from six windows. Reads inside one poll are now shared, and
// sharing stops the moment the poll sends a key, so a walk that types and
// re-reads still sees the redraw.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionSend } = require('../../src/main/session-send.js');

const WORKING = [
  '● Reading the transcript to find the frozen window.',
  '',
  '✻ Cultivating… (41s · ↓ 2.2k tokens · thinking)',
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ren2 · Opus 5.5 · harbor · ctx 12%',
].join('\n');


function harness(screenFor) {
  const reads = [];
  const keys = [];
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-menu-poll-'));
  const sessionSend = createSessionSend({
    snapshot: async () => ({ panes: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'claude' }], workspaces: [{ workspace_id: 'w1' }] }),
    readPane: async (paneId, lines, source) => { reads.push({ paneId, lines, source, after: keys.length }); return screenFor(keys.length); },
    terminalBridge: {
      ensureDialogSize: async () => ({ ok: true }),
      holdControl() {},
      releaseControlHold() {},
      controlReady: () => true,
      getState: () => ({ controlledPaneId: 'p1' }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_paneId, payload) => { keys.push(payload); return { ok: true }; },
    },
    launchActions: {},
    getSessionMeta: () => null,
    links: { get: () => null, set: () => {} },
    projectLabelForCwd: () => 'test',
    setXClipboardImage: async () => {},
    captureDir,
    sleep: async () => {},
  });
  return { sessionSend, reads, keys, cleanup: () => fs.rmSync(captureDir, { recursive: true, force: true }) };
}

test('one menu poll of a pane with no dialog reads each screen view once', async () => {
  const h = harness(() => WORKING);
  try {
    const menu = await h.sessionSend.getMenu({ pane: { paneId: 'p1', workspaceId: 'w1' } });
    assert.equal(menu?.kind === 'menu', false, 'a working turn is not a dialog');
    const distinct = new Set(h.reads.map((r) => `${r.lines}:${r.source}`));
    assert.equal(h.reads.length, distinct.size, `each (lines, source) read once per poll, got ${JSON.stringify(h.reads.map((r) => `${r.lines}:${r.source}`))}`);
    assert.ok(h.reads.length <= 2, `at most two round trips per poll (recent and visible), got ${h.reads.length}`);

    // The next poll reads again: nothing is shared across polls.
    const before = h.reads.length;
    await h.sessionSend.getMenu({ pane: { paneId: 'p1', workspaceId: 'w1' } });
    assert.ok(h.reads.length > before, 'a later poll sees the live screen');
  } finally { h.cleanup(); }
});

// A poll that presses keys and re-reads (the discovery walk over a question
// batch) is pinned by test/main/ask-sheet-delivery.test.js: "getMenu discovers
// a batch by walking the dialog once" requires every re-read after an arrow key
// to show the newly selected question, which a shared read would hide.

test('reads outside a menu poll are never shared', async () => {
  const h = harness(() => WORKING);
  try {
    await h.sessionSend.getWorkMeter({ pane: { paneId: 'p1', workspaceId: 'w1' } });
    await h.sessionSend.getWorkMeter({ pane: { paneId: 'p1', workspaceId: 'w1' } });
    assert.equal(h.reads.length, 2, 'two work-meter reads are two round trips');
  } finally { h.cleanup(); }
});

// Astra review 2026-11-06, finding 1: two polls of one pane await the same
// discovery walk. The walk's keys are sent from the first poll, so the second
// poll's cached pre-walk read used to survive the walk and it reported the
// wrong question (index 0) while the dialog sat on question 2 (index 1).
test('two polls that share one discovery walk both see the screen after it', async () => {
  const { FakeAskDialog } = require('../support/fake-ask-dialog.js');
  const { createLinkRegistry } = require('../../src/main/session-send.js');
  const questions = [
    { header: 'Approach', question: 'Which approach?', multiSelect: false, options: [{ label: 'First method', description: 'First' }, { label: 'Second method', description: 'Second' }] },
    { header: 'Delivery', question: 'Which delivery?', multiSelect: true, options: [{ label: 'File and note', description: 'Both' }, { label: 'File only', description: 'Only' }] },
  ];
  const dialog = new FakeAskDialog(questions, { startAt: 1 });
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-menu-walk-'));
  let unblock; let entered; let paused = false;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const send = createSessionSend({
    snapshot: async () => ({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1' }], workspaces: [{ workspace_id: 'ws-1' }] }),
    readPane: async () => dialog.screen(),
    terminalBridge: {
      getState: () => ({ controlledPaneId: 'pane-1' }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_id, text) => { dialog.input(text); return { ok: true }; },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: {},
    getSessionMeta: async () => ({ cwd: 'C:/dev/synthetic' }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'synthetic',
    sleep: async () => { if (!paused) { paused = true; entered(); await gate; } },
    setXClipboardImage: async () => {},
    captureDir,
    sendLogFile: path.join(captureDir, 'send.jsonl'),
  });
  try {
    const pane = { paneId: 'pane-1', workspaceId: 'ws-1' };
    const first = send.getMenu({ pane });
    await started;
    const second = send.getMenu({ pane });
    await new Promise((resolve) => setImmediate(resolve));
    unblock();
    const menus = await Promise.all([first, second]);
    assert.deepEqual(menus.map((menu) => menu.batch.currentIndex), [1, 1], 'both polls report the question the dialog is on');
  } finally { fs.rmSync(captureDir, { recursive: true, force: true }); }
});
