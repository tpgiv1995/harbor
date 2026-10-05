'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionSend } = require('../../src/main/session-send.js');
const { parseMenu } = require('../../src/main/menu-parse.js');
const { fixture } = require('../support/permission-dialog-fixtures.js');
const message = 'Keep the red toy unchanged.';
for (const [kind, question] of [['edit', 'Do you want to make this edit to toy.txt?'], ['write', 'Do you want to create toy.txt?']]) {
  test(`${kind}: separate the live native question from request details`, () => {
    const menu = parseMenu((fixture(kind) + '\nEsc to cancel · Tab to amend').replace('Do you want to proceed?', question));
    assert.equal(menu.permission.question, question);
    assert.ok(!menu.permission.blocks.some(block => block.text.includes(question)));
  });
}
function harness({ kind = 'edit', destination = 'composer', dropArrows = false, dropEnters = 0, delay = 0, changed = false } = {}) {
  let selected = 1, rejected = false, draft = '', echoed = '', reads = 0, enters = 0;
  const sent = [];
  const edge = '─'.repeat(120);
  const read = async () => {
    if (!rejected) return fixture(kind, 120, selected).replace('Red toy', changed && selected === 3 ? 'Changed request' : 'Red toy');
    if (++reads <= delay || destination === 'blocked') return 'Choose a model\n❯ 1. Continue\n  2. Cancel\nEnter to confirm';
    if (destination === 'shell') return 'PS C:\\Synthetic>';
    if (destination === 'unreadable') return '';
    return [echoed, edge, '❯ ' + draft, edge].join('\n');
  };
  const send = createSessionSend({ readPane: read, sleep: async () => {},
    terminalBridge: { getState: () => ({ controlledPaneId: 'p' }), ensureDialogSize: async () => {}, sendInput: (_, text) => {
      sent.push(text);
      if (!rejected) {
        if (!dropArrows && text === '\x1b[B') selected += 1;
        if (text === '\r') rejected = true;
      } else if (text === '\r') { if (++enters > dropEnters) { echoed = '❯ ' + draft; draft = ''; } }
      else draft += text;
      return { ok: true };
    } } });
  const answer = (action = { type: 'permission-feedback', index: 3, text: message }) => send.answerMenu({ pane: { paneId: 'p', workspaceId: 'w' }, action });
  return { answer, sent, read, get reads() { return reads; } };
}
for (const kind of ['edit', 'write', 'fetch']) test(`${kind}: reject then deliver feedback exactly once through the composer`, async () => {
  const h = harness({ kind }); assert.equal((await h.answer()).ok, true);
  assert.deepEqual(h.sent, ['\x1b[B', '\x1b[B', '\r', message, '\r']);
});
test('empty feedback only selects the native negative option', async () => {
  const h = harness(); assert.equal((await h.answer({ type: 'permission-feedback', index: 3, text: '' })).ok, true);
  assert.deepEqual(h.sent, ['\x1b[B', '\x1b[B', '\r']);
});
test('feedback refuses an affirmative option without sending any key', async () => {
  const h = harness(); assert.equal((await h.answer({ type: 'permission-feedback', index: 1, text: message })).ok, false);
  assert.deepEqual(h.sent, []);
});
test('the plan input cannot use reject-then-send', async () => {
  const h = harness({ kind: 'plan' }); assert.equal((await h.answer()).ok, false); assert.deepEqual(h.sent, []);
});
test('dropped arrows do not reject or type feedback', async () => {
  const h = harness({ dropArrows: true }); assert.equal((await h.answer()).ok, false);
  assert.ok(h.sent.length); assert.ok(h.sent.every(key => key === '\x1b[B'));
});
test('a changed permission request is not rejected by the old feedback action', async () => {
  const h = harness({ changed: true }); assert.equal((await h.answer()).ok, false); assert.ok(!h.sent.includes('\r'));
});
for (const destination of ['blocked', 'shell', 'unreadable']) test(`no feedback bytes reach a ${destination} screen after rejection`, async () => {
  const h = harness({ destination }); assert.equal((await h.answer()).ok, false);
  assert.deepEqual(h.sent, ['\x1b[B', '\x1b[B', '\r']);
});
test('feedback waits through intermediate blocked frames for the real composer', async () => {
  const h = harness({ delay: 5 }); assert.equal((await h.answer()).ok, true);
  assert.ok(h.reads > 5); assert.equal(h.sent.filter(x => x === message).length, 1);
});
test('one swallowed submit Enter is retried without duplicating the feedback text', async () => {
  const h = harness({ dropEnters: 1 }); assert.equal((await h.answer()).ok, true);
  assert.equal(h.sent.filter(x => x === message).length, 1); assert.equal(h.sent.filter(x => x === '\r').length, 3);
});
test('feedback is not reported delivered when all submit Enters are swallowed', async () => {
  const h = harness({ dropEnters: 99 }); assert.equal((await h.answer()).ok, false);
  assert.equal(h.sent.filter(x => x === message).length, 1);
});
test('a competing pane action runs only after rejection and feedback submission finish', async () => {
  const h = harness({ delay: 4 });
  const first = h.answer(); const second = h.answer({ type: 'raw', text: 'INTERLOPER' });
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(h.sent.filter(x => x === message).length, 1);
  assert.deepEqual(h.sent.slice(-3), [message, '\r', 'INTERLOPER']);
});
