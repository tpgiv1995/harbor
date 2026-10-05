'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionSend } = require('../../src/main/session-send.js');
const { fixture } = require('../support/permission-dialog-fixtures.js');

function harness(t, kind, { dropArrows = false, dropText = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-permission-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sent = [];
  let selected = 1;
  let closed = false;
  let typed = '';
  const send = createSessionSend({
    readPane: async () => closed ? '─'.repeat(120) + '\n❯\n' + '─'.repeat(120)
      : fixture(kind, 120, selected).replace('Tell Claude what to change', typed || 'Tell Claude what to change'),
    terminalBridge: { getState: () => ({ controlledPaneId: 'p' }), ensureDialogSize: async () => {}, sendInput: (_, text) => {
      sent.push(text);
      if (!dropArrows && text === '\x1b[B') selected += 1;
      if (!dropArrows && text === '\x1b[A') selected -= 1;
      if (!dropText && text === 'Keep the blue sample.') typed = text;
      if (text === '\r') closed = true;
      return { ok: true };
    } },
    sleep: async () => {}, captureDir: path.join(root, 'captures'), sendLogFile: path.join(root, 'send.jsonl'),
  });
  return { sent, send, pane: { paneId: 'p', workspaceId: 'w' } };
}

for (const kind of ['bash', 'outside', 'guard', 'edit', 'write', 'mcp', 'fetch', 'plan']) {
  test(`${kind}: native option 2 still walks, rereads, enters and verifies closure`, async t => {
    const h = harness(t, kind);
    assert.ok((await h.send.getMenu({ pane: h.pane })).permission);
    assert.equal((await h.send.answerMenu({ pane: h.pane, action: { type: 'select', index: 2 } })).ok, true);
    assert.deepEqual(h.sent, ['\x1b[B', '\r']);
  });
}
test('permission: dropped arrows refuse without Enter or feedback bytes', async t => {
  const h = harness(t, 'bash', { dropArrows: true });
  assert.equal((await h.send.answerMenu({ pane: h.pane, action: { type: 'notes', index: 3, text: 'Keep the blue sample.' } })).ok, false);
  assert.ok(h.sent.length > 0);
  assert.ok(h.sent.every(key => key === '\x1b[B'));
});
test('permission amendment uses the screen Tab key after verifying the negative row', async t => {
  const h = harness(t, 'bash');
  assert.equal((await h.send.answerMenu({ pane: h.pane, action: { type: 'notes', index: 3, text: 'Keep the blue sample.' } })).ok, true);
  assert.deepEqual(h.sent, ['\x1b[B', '\x1b[B', '\t', 'Keep the blue sample.', '\r']);
});
for (const dropText of [false, true]) test(`plan feedback verifies text before Enter: dropped=${dropText}`, async t => {
  const h = harness(t, 'plan', { dropText });
  assert.equal((await h.send.answerMenu({ pane: h.pane, action: { type: 'text', index: 3, text: 'Keep the blue sample.' } })).ok, !dropText);
  assert.equal(h.sent.includes('\r'), !dropText);
});
