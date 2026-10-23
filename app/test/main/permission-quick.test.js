'use strict';
// One-click Allow / Deny on a permission prompt the CLI reported (OSC 7501
// blocked/permission): the window header, the rail row, the phone and the
// keyboard shortcut all send session:menu-answer { type: 'permission-quick' }.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionSend, quickStatusFromScreen } = require('../../src/main/session-send.js');
const { fixture } = require('../support/permission-dialog-fixtures.js');

// The prompt the button showed and the pane's live OSC 7501 status agree by
// default; tests that move the prompt on change `live`.
const SHOWN = 'approve Write: C:\\Synthetic\\toy.txt';
const LIVE = { state: 'blocked', kind: 'permission', msg: SHOWN, seq: 3 };

function harness(t, screenFor, { live = () => LIVE } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-quick-answer-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let selected = 1;
  let closed = false;
  let reads = 0;
  const sent = [];
  const send = createSessionSend({
    readPane: async () => {
      reads += 1;
      return closed ? `${'─'.repeat(120)}\n❯\n${'─'.repeat(120)}` : screenFor(selected, reads);
    },
    readQuickStatus: async () => live(),
    terminalBridge: {
      getState: () => ({ controlledPaneId: 'p' }),
      ensureDialogSize: async () => {},
      sendInput: (_, text) => {
        sent.push(text);
        if (text === '\x1b[B') selected += 1;
        if (text === '\x1b[A') selected -= 1;
        if (text === '\r' || text === '\x1b') closed = true;
        return { ok: true };
      },
    },
    sleep: async () => {},
    captureDir: path.join(root, 'captures'),
    sendLogFile: path.join(root, 'send.jsonl'),
  });
  const answer = (decision, extra = {}) => send.answerMenu({
    pane: { paneId: 'p', workspaceId: 'w' },
    action: { type: 'permission-quick', decision, expect: SHOWN, expectSeq: 3, ...extra },
  });
  return { answer, sent };
}

for (const kind of ['bash', 'outside', 'compound', 'guard', 'edit', 'write', 'mcp', 'fetch']) {
  test(`${kind}: Allow picks the one-time "Yes" and nothing that widens a permission`, async (t) => {
    const h = harness(t, (selected) => fixture(kind, 120, selected));
    const res = await h.answer('allow');
    assert.equal(res.ok, true, res.reason);
    assert.deepEqual(h.sent, ['\r'], 'option 1 is already the plain Yes');
  });
}

test('plan approval has no one-time Yes, so Allow is refused and presses nothing', async (t) => {
  const h = harness(t, (selected) => fixture('plan', 120, selected));
  const res = await h.answer('allow');
  assert.equal(res.ok, false);
  assert.deepEqual(h.sent, []);
});

test('Deny is Esc and checks the prompt closed', async (t) => {
  const h = harness(t, (selected) => fixture('edit', 120, selected));
  const res = await h.answer('deny');
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(h.sent, ['\x1b']);
});

test('a prompt with no one-time Yes is refused, never answered with a broader option', async (t) => {
  const screen = (selected) => [
    'Read outside the working directories',
    'Do you want to proceed?',
    `${selected === 1 ? '❯' : ' '} 1. Yes, and keep allowing any reads outside the working directories`,
    `${selected === 2 ? '❯' : ' '} 2. No`,
    'Esc to cancel · Tab to amend',
  ].join('\n');
  const h = harness(t, screen);
  const res = await h.answer('allow');
  assert.equal(res.ok, false);
  assert.match(res.reason, /no plain "Yes"/);
  assert.deepEqual(h.sent, []);
});

test('an explicit "Yes, but ask again next time" counts as one-time', async (t) => {
  const screen = (selected) => [
    'Allow this read outside the working directories?',
    'Do you want to proceed?',
    `${selected === 1 ? '❯' : ' '} 1. Yes, and keep allowing any reads outside the working directories`,
    `${selected === 2 ? '❯' : ' '} 2. Yes, but ask again next time`,
    `${selected === 3 ? '❯' : ' '} 3. No`,
    'Esc to cancel · Tab to amend',
  ].join('\n');
  const h = harness(t, screen);
  const res = await h.answer('allow');
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(h.sent, ['\x1b[B', '\r']);
});

test('a dialog that is not a permission prompt is refused', async (t) => {
  const h = harness(t, (selected) => `Pick a colour\n${selected === 1 ? '❯' : ' '} 1. Red\n${selected === 2 ? '❯' : ' '} 2. Blue\nEnter to select · ↑/↓ to navigate · Esc to cancel`);
  const res = await h.answer('allow');
  assert.equal(res.ok, false);
  assert.deepEqual(h.sent, []);
});

test('an Allow for a prompt that has since been replaced is refused and presses nothing', async (t) => {
  const h = harness(t, (selected) => fixture('bash', 120, selected), {
    live: () => ({ state: 'blocked', kind: 'permission', msg: 'approve Bash: node blue.js', seq: 5 }),
  });
  const res = await h.answer('allow');
  assert.equal(res.ok, false);
  assert.match(res.reason, /prompt changed/);
  assert.deepEqual(h.sent, []);
});

test('a Deny after the CLI moved on is refused too', async (t) => {
  const h = harness(t, (selected) => fixture('edit', 120, selected), { live: () => ({ state: 'working', kind: null, msg: 'Writing toy.txt', seq: 4 }) });
  const res = await h.answer('deny');
  assert.equal(res.ok, false);
  assert.deepEqual(h.sent, []);
});

test('an answer that does not name its prompt is refused', async (t) => {
  const h = harness(t, (selected) => fixture('write', 120, selected));
  const res = await h.answer('allow', { expect: null });
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not say which prompt/);
  assert.deepEqual(h.sent, []);
});

test('no live status at all refuses rather than guessing', async (t) => {
  const h = harness(t, (selected) => fixture('write', 120, selected), { live: () => null });
  const res = await h.answer('allow');
  assert.equal(res.ok, false);
  assert.deepEqual(h.sent, []);
});

test('a dialog that changes to another request mid-answer is not confirmed', async (t) => {
  // The first read shows the Write prompt; from then on a Bash prompt sits there.
  // Both lead with a plain "Yes" on option 1, so only the request differs.
  const h = harness(t, (selected, reads) => fixture(reads <= 1 ? 'write' : 'bash', 120, selected));
  const res = await h.answer('allow');
  assert.equal(res.ok, false);
  assert.match(res.reason, /prompt changed/);
  assert.ok(!h.sent.includes('\r'), 'Enter is never pressed on the new request');
});

// The CLI's msg is ELIDED, so prompt #2 can carry exactly prompt #1's text
// (two edits of one file, two paths with the same tail). The keeper stamps a
// sequence on every status change and the click names it.
test('a click for prompt #1 that lands on a same-text prompt #2 is refused by its seq', async (t) => {
  const h = harness(t, (selected) => fixture('write', 120, selected), { live: () => ({ ...LIVE, seq: 4 }) });
  for (const decision of ['allow', 'deny']) {
    const res = await h.answer(decision, { expectSeq: 3 });
    assert.equal(res.ok, false, decision);
    assert.match(res.reason, /prompt changed/);
  }
  assert.deepEqual(h.sent, [], 'nothing reached prompt #2');
});

test('a click with no seq is refused when the keeper reports one', async (t) => {
  const h = harness(t, (selected) => fixture('write', 120, selected));
  const res = await h.answer('allow', { expectSeq: null });
  assert.equal(res.ok, false);
  assert.deepEqual(h.sent, []);
});

test('a keeper with no seq and a row with none: the text alone decides', async (t) => {
  const h = harness(t, (selected) => fixture('write', 120, selected), { live: () => ({ ...LIVE, seq: null }) });
  const res = await h.answer('allow', { expectSeq: null });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(h.sent, ['\r']);
});

test('quickStatusFromScreen reads the keeper status off a screen read', () => {
  assert.deepEqual(quickStatusFromScreen({ status: { state: 'blocked', kind: 'permission', msg: SHOWN, title: 'x', seq: 7 } }),
    { state: 'blocked', kind: 'permission', msg: SHOWN, seq: 7 });
  assert.deepEqual(quickStatusFromScreen({ status: { state: 'working', msg: 'Running tests' } }),
    { state: 'working', kind: null, msg: 'Running tests', seq: null });
  assert.equal(quickStatusFromScreen({ status: null }), null);
  assert.equal(quickStatusFromScreen(null), null);
});
