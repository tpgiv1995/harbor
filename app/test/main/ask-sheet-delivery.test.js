'use strict';

// The answer sheet's ONE delivery (session-send.js `sheet` action), driven
// against a stand-in dialog whose transitions were measured on the real CLI
// (test/support/fake-ask-dialog.js). Every screen the driver reads is rendered
// by the stand-in and parsed by the real menu-parse.js, so a change in either
// the parser or the driver's key sequence shows up here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionSend, createLinkRegistry } = require('../../src/main/session-send.js');
const { FakeAskDialog } = require('../support/fake-ask-dialog.js');

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
});

const ASK = [
  {
    header: 'Finish approach',
    question: 'How do you want me to produce the complete BIH file for the full roster?',
    multiSelect: false,
    options: [
      { label: 'Reassemble + one BIH map (Recommended)', description: 'Take the cleaned roster data and reassemble it.' },
      { label: 'Show me the cleaned census first', description: 'Generate and display the cleaned census data.' },
      { label: 'Clean re-run of the 5 PDFs', description: 'Start fresh from the original 5 PDFs.' },
    ],
  },
  {
    header: 'Delivery',
    question: 'How should I hand off the finished file? (pick any)',
    multiSelect: true,
    options: [
      { label: 'File + note to you', description: 'Deliver both.' },
      { label: 'Just the file', description: 'Only the file.' },
      { label: 'Draft the note for someone', description: 'A draft note.' },
    ],
  },
];

function harness(dialog) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-ask-sheet-'));
  tempDirs.push(stateDir);
  const sent = [];
  const deps = {
    snapshot: async () => ({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1' }], workspaces: [{ workspace_id: 'ws-1', label: 'harbor' }] }),
    readPane: async () => dialog.screen(),
    terminalBridge: {
      getState: () => ({ controlledPaneId: 'pane-1' }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_paneId, text) => { sent.push(text); dialog.input(text); return { ok: true }; },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: { resumeSession: async () => {} },
    getSessionMeta: async () => ({ cwd: '/home/x/dev/harbor' }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'harbor',
    sleep: async () => {},
    setXClipboardImage: async () => {},
    captureDir: path.join(stateDir, 'unrecognized-dialogs'),
    sendLogFile: path.join(stateDir, 'send-log.jsonl'),
  };
  return { send: createSessionSend(deps), sent };
}

const deliver = (send, answers, ask = ASK) => send.answerMenu({
  pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  action: { type: 'sheet', answers },
  ask,
});

test('a batch is delivered top to bottom and submitted through the review screen', async () => {
  const dialog = new FakeAskDialog(ASK);
  const { send } = harness(dialog);
  const res = await deliver(send, [
    { question: 0, kind: 'select', index: 2 },
    { question: 1, kind: 'multi', indexes: [1, 3] },
  ]);
  assert.deepEqual(res, { ok: true, action: 'sheet', delivered: 2 });
  assert.equal(dialog.outcome, 'submitted');
  assert.deepEqual(dialog.answers, ['Show me the cleaned census first', 'File + note to you, Draft the note for someone']);
});

test('the driver first walks BACK to question 1 when the dialog was left on question 2', async () => {
  // Pat had arrowed to the second question in the terminal before submitting
  // the sheet; the pane, not the sheet, says where the dialog is.
  const dialog = new FakeAskDialog(ASK, { startAt: 1 });
  const { send, sent } = harness(dialog);
  const res = await deliver(send, [
    { question: 0, kind: 'select', index: 1 },
    { question: 1, kind: 'multi', indexes: [2] },
  ]);
  assert.equal(res.ok, true, res.reason);
  assert.equal(sent[0], '\x1b[D', 'the first keystroke is ← to reach question 1');
  assert.equal(dialog.outcome, 'submitted');
  assert.deepEqual(dialog.answers, ['Reassemble + one BIH map (Recommended)', 'Just the file']);
});

test('a typed answer is delivered through the free-text row, verified before Enter', async () => {
  const dialog = new FakeAskDialog(ASK);
  const { send } = harness(dialog);
  const res = await deliver(send, [
    { question: 0, kind: 'text', text: 'A but stop after the census' },
    { question: 1, kind: 'multi', indexes: [1] },
  ]);
  assert.equal(res.ok, true, res.reason);
  assert.equal(dialog.answers[0], 'A but stop after the census');
  assert.equal(dialog.outcome, 'submitted');
});

test('a multi-select answer unticks what the pane already had ticked and is not wanted', async () => {
  const dialog = new FakeAskDialog(ASK, { startAt: 1 });
  dialog.ticks[1].add(2); // ticked in the terminal earlier
  const { send } = harness(dialog);
  const res = await deliver(send, [
    { question: 0, kind: 'select', index: 3 },
    { question: 1, kind: 'multi', indexes: [1] },
  ]);
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(dialog.answers, ['Clean re-run of the 5 PDFs', 'File + note to you']);
});

test('a step that cannot be verified stops, names the question, and leaves the dialog where it is', async () => {
  const dialog = new FakeAskDialog(ASK);
  const { send } = harness(dialog);
  const res = await deliver(send, [
    { question: 0, kind: 'select', index: 9 },
    { question: 1, kind: 'multi', indexes: [1] },
  ]);
  assert.equal(res.ok, false);
  assert.equal(res.question, 0);
  assert.match(res.reason, /"Finish approach"/);
  assert.match(res.reason, /option 9 is not on the menu/);
  assert.equal(dialog.stage, 'questions', 'the dialog is still up');
  assert.equal(dialog.q, 0, 'and still on question 1');
  assert.deepEqual(dialog.answers, [null, null], 'nothing was answered');
});

test('a lone multi-select question is confirmed in place, with no review screen', async () => {
  const dialog = new FakeAskDialog([ASK[1]]);
  const { send } = harness(dialog);
  const res = await deliver(send, [{ question: 0, kind: 'multi', indexes: [2, 3] }], [ASK[1]]);
  assert.equal(res.ok, true, res.reason);
  assert.equal(dialog.outcome, 'submitted');
  assert.deepEqual(dialog.answers, ['Just the file, Draft the note for someone']);
});

test('a lone single-select question through the sheet is answered in place', async () => {
  const dialog = new FakeAskDialog([ASK[0]]);
  const { send } = harness(dialog);
  const res = await deliver(send, [{ question: 0, kind: 'select', index: 2 }], [ASK[0]]);
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(dialog.answers, ['Show me the cleaned census first']);
});

test('a sheet with nothing in it is refused before any key is sent', async () => {
  const dialog = new FakeAskDialog(ASK);
  const { send, sent } = harness(dialog);
  const res = await deliver(send, []);
  assert.equal(res.ok, false);
  assert.deepEqual(sent, []);
});

test('without the transcript, a batch cannot be navigated and says so instead of guessing', async () => {
  const dialog = new FakeAskDialog(ASK, { startAt: 1 });
  const { send } = harness(dialog);
  // No `ask`: the driver treats the dialog as a lone question and answers what
  // is on screen, which is question 2, so question 1 is not silently answered
  // with question 2's rows: index 2 lands on "Just the file", a multi row, and
  // the select is refused... unless it is not. The honest contract is simply
  // that nothing is claimed as question 1.
  const res = await deliver(send, [{ question: 0, kind: 'select', index: 2 }], null);
  assert.equal(dialog.answers[0], null, 'question 1 was never answered');
  assert.equal(res.ok, false, 'and the refusal is explicit');
});

// ---- review-caught 2026-09-03 --------------------------------------------

test('a multi-select whose pointer already sits on its Submit row is confirmed, not refused', async () => {
  const dialog = new FakeAskDialog(ASK, { startAt: 1 });
  dialog.ticks[1].add(1);
  dialog.ticks[1].add(2);
  dialog.hl[1] = ASK[1].options.length + 2; // the unnumbered confirm row
  const { send } = harness(dialog);
  const res = await deliver(send, [
    { question: 0, kind: 'select', index: 1 },
    { question: 1, kind: 'multi', indexes: [1, 2] },
  ]);
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(dialog.answers[1], 'File + note to you, Just the file');
});

test('a toggle that has to start from the confirm row walks UP to its option', async () => {
  const dialog = new FakeAskDialog([ASK[1]]);
  dialog.hl[0] = ASK[1].options.length + 2;
  const { send } = harness(dialog);
  const res = await deliver(send, [{ question: 0, kind: 'multi', indexes: [2] }], [ASK[1]]);
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(dialog.answers, ['Just the file']);
});

test('an Enter the CLI never saw is reported, and nothing after it is sent', async () => {
  const dialog = new FakeAskDialog(ASK);
  dialog.dropEnters = 1;
  const { send } = harness(dialog);
  const res = await deliver(send, [
    { question: 0, kind: 'select', index: 2 },
    { question: 1, kind: 'multi', indexes: [1] },
  ]);
  assert.equal(res.ok, false);
  assert.equal(res.question, 0);
  assert.match(res.reason, /did not register/);
  assert.equal(dialog.stage, 'questions');
  assert.deepEqual(dialog.answers, [null, null], 'question 2 was never touched and nothing was submitted');
});

test('a batch with no known question set is refused, never answered as a lone question', async () => {
  const dialog = new FakeAskDialog(ASK, { startAt: 1 });
  const { send, sent } = harness(dialog);
  const res = await deliver(send, [{ question: 0, kind: 'select', index: 2 }], null);
  assert.equal(res.ok, false);
  assert.match(res.reason, /not known yet/);
  assert.deepEqual(sent, [], 'no key reached the dialog');
  assert.deepEqual(dialog.answers, [null, null]);
});

test('a multi-select delivers its ticks AND its typed row together', async () => {
  const dialog = new FakeAskDialog(ASK);
  const { send } = harness(dialog);
  const res = await deliver(send, [
    { question: 0, kind: 'select', index: 1 },
    { question: 1, kind: 'multi', indexes: [2], text: 'include provenance' },
  ]);
  assert.equal(res.ok, true, res.reason);
  assert.equal(dialog.answers[1], 'Just the file, include provenance');
  assert.equal(dialog.outcome, 'submitted');
});

test('a sheet with nothing local to deliver on a batch goes straight to the review and submits', async () => {
  const dialog = new FakeAskDialog(ASK);
  dialog.answers[0] = 'Reassemble + one BIH map (Recommended)';
  dialog.q = 1;
  dialog.ticks[1].add(3);
  const { send } = harness(dialog);
  const res = await deliver(send, []);
  assert.equal(res.ok, true, res.reason);
  assert.equal(dialog.outcome, 'submitted');
});

test('"Chat about this" reaches the named question first, then chooses that screen\'s Chat row', async () => {
  const dialog = new FakeAskDialog(ASK, { startAt: 0 });
  const { send, sent } = harness(dialog);
  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'chat', question: 1 },
    ask: ASK,
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(sent[0], '\x1b[C', 'walked to question 2 first');
  assert.equal(dialog.outcome, 'chat');
  assert.deepEqual(dialog.answers, [null, null], 'no option was chosen by mistake');
});

test('getMenu discovers a batch by walking the dialog once and puts it back where it was', async () => {
  const dialog = new FakeAskDialog(ASK, { startAt: 1 });
  const { send, sent } = harness(dialog);
  const pane = { paneId: 'pane-1', workspaceId: 'ws-1' };
  const menu = await send.getMenu({ pane });
  assert.ok(menu.asked, 'the batch is known without a transcript');
  assert.deepEqual(menu.asked.map((q) => q.header), ['Finish approach', 'Delivery']);
  assert.deepEqual(menu.asked[0].options.map((o) => o.label), ['Reassemble + one BIH map', 'Show me the cleaned census first', 'Clean re-run of the 5 PDFs']);
  assert.equal(menu.asked[1].multiSelect, true);
  assert.equal(menu.batch.currentIndex, 1, 'the question on screen is the one the user was on');
  assert.equal(dialog.q, 1, 'the dialog was put back on question 2');
  assert.deepEqual(sent, ['\x1b[D', '\x1b[D', '\x1b[C'], 'back to the first question, verified stable, forward once');
  sent.length = 0;
  const again = await send.getMenu({ pane });
  assert.deepEqual(sent, [], 'the second poll costs no keystroke');
  assert.equal(again.asked.length, 2);
  // And the sheet delivery navigates by the discovered set with no `ask`.
  const res = await send.answerMenu({ pane, action: { type: 'sheet', answers: [{ question: 0, kind: 'select', index: 3 }, { question: 1, kind: 'multi', indexes: [1] }] } });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(dialog.answers, ['Clean re-run of the 5 PDFs', 'File + note to you']);
});

// ---- round two, 2026-09-03 ----------------------------------------------

test('a card action arriving during a discovery walk waits for the walk; nothing interleaves', async () => {
  const dialog = new FakeAskDialog(ASK, { startAt: 1 });
  const { send, sent } = harness(dialog);
  const pane = { paneId: 'pane-1', workspaceId: 'ws-1' };
  const discovery = send.getMenu({ pane });
  const answer = send.answerMenu({ pane, action: { type: 'select', index: 2 } });
  const [menu, res] = await Promise.all([discovery, answer]);
  assert.equal(menu.asked.length, 2);
  assert.equal(res.ok, true, res.reason);
  // The click was queued before the walk began (getMenu reads first), so it
  // runs first and whole; the walk's three keys then run whole. What can
  // never happen is a walk key between the answer's keys or the reverse.
  const walk = ['\x1b[D', '\x1b[D', '\x1b[C'];
  const answerKeys = sent.filter((k) => !walk.includes(k));
  assert.deepEqual(sent, [...answerKeys, ...walk], 'two contiguous blocks, no interleaving');
  assert.deepEqual(answerKeys, ['\x1b[B', '\r'], 'the answer walked one row and pressed Enter, on the question that was current when it ran');
  assert.equal(dialog.answers[0], null, 'question 1 was never touched');
  assert.equal(dialog.q, 1, 'and the walk left the dialog where it found it');
});

test('two questions with the same words but different shapes are two questions to the walk', async () => {
  const twins = [
    { ...ASK[0], header: 'First', multiSelect: false },
    { ...ASK[0], header: 'Second', multiSelect: true },
  ];
  const dialog = new FakeAskDialog(twins);
  const { send } = harness(dialog);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.ok(menu.asked, 'the batch was discovered');
  assert.deepEqual(menu.asked.map((q) => q.multiSelect), [false, true]);
  assert.equal(dialog.q, 0, 'and the dialog is back where it started');
});

test('an empty read in the middle of the walk is retried, and the dialog still comes back home', async () => {
  const dialog = new FakeAskDialog(ASK, { startAt: 1 });
  const { send } = harness(dialog);
  let reads = 0;
  const real = send;
  void real;
  const pane = { paneId: 'pane-1', workspaceId: 'ws-1' };
  // Drop exactly the read that follows the first → of the walk.
  const original = dialog.screen.bind(dialog);
  let rightSeen = false;
  dialog.input = ((inner) => (bytes) => { if (bytes === '\x1b[C') rightSeen = true; return inner(bytes); })(dialog.input.bind(dialog));
  dialog.screen = () => { reads += 1; if (rightSeen && reads > 0 && !dialog.__dropped) { dialog.__dropped = true; return ''; } return original(); };
  const menu = await send.getMenu({ pane });
  assert.ok(menu.asked, 'the walk survived one empty read');
  assert.equal(menu.asked.length, 2);
  assert.equal(dialog.q, 1, 'the dialog was put back on question 2');
});

test('the discovery cache dies with its dialog, so a later batch with the same headers is read afresh', async () => {
  const holder = { dialog: new FakeAskDialog(ASK) };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-ask-sheet-'));
  tempDirs.push(stateDir);
  const deps = {
    snapshot: async () => ({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1' }], workspaces: [{ workspace_id: 'ws-1', label: 'harbor' }] }),
    readPane: async () => holder.dialog.screen(),
    terminalBridge: {
      getState: () => ({ controlledPaneId: 'pane-1' }),
      requestFocusPane: async () => ({ ok: true }),
      sendInput: (_paneId, text) => { holder.dialog.input(text); return { ok: true }; },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: { resumeSession: async () => {} },
    getSessionMeta: async () => ({ cwd: '/home/x/dev/harbor' }),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'harbor',
    sleep: async () => {},
    setXClipboardImage: async () => {},
    captureDir: path.join(stateDir, 'unrecognized-dialogs'),
    sendLogFile: path.join(stateDir, 'send-log.jsonl'),
  };
  const send = createSessionSend(deps);
  const pane = { paneId: 'pane-1', workspaceId: 'ws-1' };
  const first = await send.getMenu({ pane });
  assert.equal(first.asked[0].question, ASK[0].question);
  holder.dialog.close('declined');
  assert.equal(await send.getMenu({ pane }), null, 'a composer: no dialog, no card');
  holder.dialog = new FakeAskDialog([
    { ...ASK[0], question: 'A NEW and materially different question with the same header?' },
    ASK[1],
  ]);
  const second = await send.getMenu({ pane });
  assert.equal(second.asked[0].question, 'A NEW and materially different question with the same header?');
});

test('a lone question whose Enter the CLI never saw is reported, not claimed', async () => {
  const dialog = new FakeAskDialog([ASK[0]]);
  dialog.dropEnters = 1;
  const { send } = harness(dialog);
  const res = await send.answerMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, action: { type: 'select', index: 2 } });
  assert.equal(res.ok, false);
  assert.match(res.reason, /did not register/);
  assert.equal(dialog.stage, 'questions');
});

test('text already typed on a multi-select row survives delivery, and is unticked only when the sheet drops it', async () => {
  const typedOnce = () => {
    const dialog = new FakeAskDialog([ASK[1]]);
    dialog.hl[0] = 4;
    dialog.input('\x1b[200~keep provenance\x1b[201~'); // types, which ticks the row
    dialog.hl[0] = 1;
    return dialog;
  };
  let dialog = typedOnce();
  let { send } = harness(dialog);
  let res = await deliver(send, [{ question: 0, kind: 'multi', indexes: [1], text: 'keep provenance' }], [ASK[1]]);
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(dialog.answers, ['File + note to you, keep provenance']);

  dialog = typedOnce();
  ({ send } = harness(dialog));
  res = await deliver(send, [{ question: 0, kind: 'multi', indexes: [1] }], [ASK[1]]);
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(dialog.answers, ['File + note to you'], 'the sheet carried no text, so the typed row was unticked');

  dialog = typedOnce();
  ({ send } = harness(dialog));
  res = await deliver(send, [{ question: 0, kind: 'multi', indexes: [1], text: 'something else' }], [ASK[1]]);
  assert.equal(res.ok, false);
  assert.match(res.reason, /already holds "keep provenance"/);
});

test('a note reaches the named question before it is attached', async () => {
  const dialog = new FakeAskDialog(ASK);
  const { send, sent } = harness(dialog);
  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'notes', index: 2, text: 'be careful here', question: 1 },
    ask: ASK,
  });
  assert.equal(sent[0], '\x1b[C', 'walked to question 2 first');
  assert.equal(dialog.q, 1);
  // The measured CLI advertises no notes key, so the attach itself is refused
  // honestly; what matters is that it was refused on the RIGHT question.
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not offer notes/);
});

test('the review screen after a discovered batch is labelled from the same cache', async () => {
  const dialog = new FakeAskDialog(ASK);
  const { send } = harness(dialog);
  const pane = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await send.getMenu({ pane });
  dialog.answers[0] = 'Just the file';
  dialog.stage = 'review';
  const menu = await send.getMenu({ pane });
  assert.equal(menu.review, true);
  assert.deepEqual(menu.batch.headers.map((h) => h.header), ['Finish approach', 'Delivery']);
});
