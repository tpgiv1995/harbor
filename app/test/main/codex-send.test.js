'use strict';

// Codex through the send path and the question card (2026-10-15). Screens are
// the real Codex 0.160.0 frames in test/fixtures/codex-tui/ (paths and prose
// made synthetic), plus a small stand-in TUI built from those frames' grammar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionSend, createLinkRegistry } = require('../../src/main/session-send.js');
const { parseMenu } = require('../../src/main/menu-parse.js');
const { composerImageCount } = require('../../src/main/codex-screen.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/codex-tui', name), 'utf8');
const tempDirs = [];
test.after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-send-')); tempDirs.push(dir); return dir; };

function harness({ screen, agentSession = 'codex-thread-1' } = {}) {
  const dir = tempDir();
  const sent = [];
  const state = { screen: screen || fixture('idle-composer-0.160.0.txt'), onInput: null, controlled: 'pane-1' };
  const deps = {
    snapshot: async () => ({
      panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent: 'codex', agent_session: { kind: 'id', value: agentSession } }],
      workspaces: [{ workspace_id: 'ws-1', label: 'harbor' }],
    }),
    readPane: async () => (typeof state.screen === 'function' ? state.screen() : state.screen),
    terminalBridge: {
      getState: () => ({ controlledPaneId: state.controlled }),
      requestFocusPane: async ({ paneId }) => { state.controlled = paneId; return { ok: true }; },
      sendInput: (paneId, text) => { sent.push(text); state.onInput?.(text); return { ok: true }; },
      ensureDialogSize: async () => ({ ok: true }),
    },
    launchActions: { resumeSession: async () => {}, resumeProviderSession: async () => {} },
    getSessionMeta: async () => ({ cwd: '/home/user/project', provider: 'codex' }),
    resolveTranscriptPath: async () => null,
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'harbor',
    sleep: async () => {},
    captureDir: path.join(dir, 'unrecognized'),
    sendLogFile: path.join(dir, 'send-log.jsonl'),
  };
  return { deps, sent, state, dir };
}
const pane = { paneId: 'pane-1', workspaceId: 'ws-1' };

// --- the parse ---------------------------------------------------------------

test('a Codex approval parses as a permission prompt, not a clipped Claude menu', () => {
  const menu = parseMenu(fixture('approval-command-0.160.0.txt'));
  assert.equal(menu.provider, 'codex');
  assert.equal(menu.clipped, false);
  assert.deepEqual(menu.options.map((o) => [o.index, o.label, o.selected]), [
    [1, 'Yes, proceed', true],
    [2, 'Yes, and don\'t ask again for commands that start with `echo hello > probe.txt`', false],
    [3, 'No, and tell Codex what to do differently', false],
  ]);
  assert.equal(menu.permission.toolTitle, 'Run command');
  assert.deepEqual(menu.permission.blocks.find((b) => b.type === 'code'), { type: 'code', text: 'echo hello > probe.txt' });
  const edits = parseMenu(fixture('approval-edits-0.160.0.txt'));
  assert.equal(edits.permission.toolTitle, 'Edit files');
  assert.match(edits.permission.blocks[0].text, /Destination:\n\/home\/user\/project\/notes\.md/);
});

test('composer and Codex screens never parse as a menu', () => {
  for (const name of ['idle-composer-0.160.0.txt', 'idle-typed-0.160.0.txt', 'working-0.160.0.txt',
    'working-steer-and-queued-0.160.0.txt', 'question-answered-working-0.160.0.txt', 'image-and-text-in-composer-0.160.0.txt']) {
    assert.equal(parseMenu(fixture(name)), null, name);
  }
});

// --- the send refusal: one decision with the card ---------------------------

for (const name of ['question-batch-q1-0.160.0.txt', 'approval-command-0.160.0.txt', 'question-notes-typed-0.160.0.txt', 'update-picker-0.160.0.txt']) {
  test(`a send into a Codex pane showing ${name} is refused and types nothing`, async () => {
    const h = harness({ screen: fixture(name) });
    const send = createSessionSend(h.deps);
    await assert.rejects(send.send({ sessionId: 'codex-thread-1', text: 'hello', provider: 'codex', pane }),
      /asking a question in its window/);
    assert.deepEqual(h.sent, [], 'no byte, and above all no Enter, reached the dialog');
  });
}

// A note longer than the pane wraps onto an indented continuation line. The
// parse read only the line above the footer, so the question vanished (no card)
// and a send pasted into the note and its Enter submitted every answer.
const LONG_NOTE = 'pick whichever fruit is in season where I live, and if neither of them is then say so and suggest one';
const wrappedNote = () => fixture('question-notes-typed-0.160.0.txt')
  .replace('  › a note', `  › ${LONG_NOTE.slice(0, LONG_NOTE.indexOf(' ', 55))}\n    ${LONG_NOTE.slice(LONG_NOTE.indexOf(' ', 55) + 1)}`);

test('a send into a Codex question with a wrapped note is refused and types nothing', async () => {
  const h = harness({ screen: wrappedNote() });
  const send = createSessionSend(h.deps);
  await assert.rejects(send.send({ sessionId: 'codex-thread-1', text: 'hello', provider: 'codex', pane }),
    /asking a question in its window/);
  assert.deepEqual(h.sent, []);
});

// A Codex screen with no composer and no dialog codex-screen.js can parse (here
// a question whose header scrolled away) must not be typed into: a Codex send
// needs Codex's own composer on screen.
const noComposer = () => fixture('question-notes-typed-0.160.0.txt').replace('  Question 2/2 (1 unanswered)\n', '');
test('a Codex send with no composer on screen and no parsed dialog is refused, fresh pane or not', async () => {
  assert.equal(parseMenu(noComposer()), null, 'the dialog does not parse, so only the composer test can stop the send');
  const fresh = harness({ screen: noComposer() });
  await assert.rejects(createSessionSend(fresh.deps).send({ sessionId: 'codex-thread-1', text: 'hello', provider: 'codex', pane }),
    /not showing its message box/);
  assert.deepEqual(fresh.sent, [], 'a fresh pane refuses once it has settled');

  const h = harness();
  const send = createSessionSend(h.deps);
  h.state.onInput = (bytes) => { if (bytes === '\r') h.state.screen = withEcho('first'); };
  await send.send({ sessionId: 'codex-thread-1', text: 'first', provider: 'codex', pane });
  assert.ok(h.sent.length, 'the first send was delivered');
  h.sent.length = 0;
  h.state.onInput = null;
  h.state.screen = noComposer();
  await assert.rejects(send.send({ sessionId: 'codex-thread-1', text: 'hello', provider: 'codex', pane }),
    /not showing its message box/);
  assert.deepEqual(h.sent, [], 'no paste and no Enter reached the note');
});

test('the card and the refusal agree: the menu poll returns the same Codex dialog', async () => {
  const h = harness({ screen: fixture('question-batch-q1-0.160.0.txt') });
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane, ask: [
    { header: 'Color', question: 'Which color?', options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue', description: 'Choose blue.' }] },
    { header: 'Fruit', question: 'Which fruit?', options: [{ label: 'Apple', description: 'Choose apple.' }, { label: 'Pear', description: 'Choose pear.' }] },
  ] });
  assert.equal(menu.provider, 'codex');
  assert.ok(menu.asked, 'the rollout\'s questions label the card');
  assert.equal(menu.asked.length, 2);
});

// --- Enter confirmation -------------------------------------------------------

const withComposer = (text) => fixture('idle-composer-0.160.0.txt').replace('› Ask Codex to do anything', `› ${text}`);
const withEcho = (text) => fixture('idle-composer-0.160.0.txt').replace('› Ask Codex to do anything', `› ${text}\n\n• Working (0s • esc to interrupt)\n\n› Ask Codex to do anything`);

test('a swallowed Enter into Codex is pressed again, once the composer has held the text twice', async () => {
  const h = harness();
  const text = 'please run the tests';
  let enters = 0;
  h.state.onInput = (bytes) => {
    if (bytes.includes(text)) h.state.screen = withComposer(text);
    if (bytes === '\r') { enters += 1; if (enters === 2) h.state.screen = withEcho(text); }
  };
  const send = createSessionSend(h.deps);
  // Not a fresh pane: an earlier delivery already happened.
  h.deps.sleep = async () => {};
  await send.send({ sessionId: 'pane:codex', text: 'first', provider: 'codex', pane }).catch(() => {});
  h.sent.length = 0; enters = 0; h.state.screen = fixture('idle-composer-0.160.0.txt');
  await send.send({ sessionId: 'pane:codex', text, provider: 'codex', pane });
  assert.equal(h.sent.filter((b) => b === '\r').length, 2, 'the first Enter was lost; exactly one spare');
});

test('a mid-turn Codex send that STEERS is reported as waiting for the next tool call', async () => {
  const h = harness();
  const text = 'second note PEAR';
  const statuses = [];
  h.state.onInput = (bytes) => {
    if (bytes.includes(text)) h.state.screen = fixture('working-typed-0.160.0.txt').replace('also say BANANA at the end', text);
    if (bytes === '\r') h.state.screen = fixture('working-steer-and-queued-0.160.0.txt');
  };
  const send = createSessionSend(h.deps);
  send.emitter.on('status', (s) => statuses.push(s));
  await send.send({ sessionId: 'pane:codex', text, provider: 'codex', pane });
  assert.match(statuses.find((s) => s.phase === 'sent').detail, /after its next tool call/);
});

// --- images -------------------------------------------------------------------

test('a Codex image is pasted as its PATH and waits for the composer\'s own [Image #N]', async () => {
  // The previous message's echo already shows "[Image #1]" above the composer,
  // which is exactly what the whole-screen count tripped on.
  const sentBefore = fixture('image-sent-idle-0.160.0.txt');
  const h = harness({ screen: sentBefore });
  h.state.onInput = (bytes) => {
    if (bytes.includes('/tmp/shot.png')) h.state.screen = sentBefore.replace('› Ask Codex to do anything', '› [Image #1]');
    if (bytes.includes('what is this')) h.state.screen = sentBefore.replace('› Ask Codex to do anything', '› [Image #1]  what is this');
    if (bytes === '\r') h.state.screen = sentBefore.replace('› Ask Codex to do anything', '› [Image #1]  what is this\n\n• Working (0s • esc to interrupt)\n\n› Ask Codex to do anything');
  };
  h.deps.setXClipboardImage = async () => { throw new Error('the clipboard must not be used for Codex'); };
  assert.equal(composerImageCount(sentBefore), 0);
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 'pane:codex-img', text: 'what is this', images: ['/tmp/shot.png'], provider: 'codex', pane });
  assert.equal(h.sent[0], '\x1b[200~/tmp/shot.png\x1b[201~');
  assert.ok(!h.sent.includes('\x16') && !h.sent.includes('\x1bv'), 'no Claude paste chord');
});

test('a Codex image that never attaches fails honestly instead of sending text alone', async () => {
  const h = harness();
  let t = 0;
  h.deps.clock = () => t;
  h.deps.sleep = async (ms) => { t += ms; };
  const send = createSessionSend(h.deps);
  await assert.rejects(send.send({ sessionId: 'pane:codex-img', text: 'x', images: ['/tmp/missing.png'], provider: 'codex', pane }),
    /Codex never attached the image/);
  assert.ok(!h.sent.includes('\r'));
});

// --- answering ------------------------------------------------------------------

// A stand-in request_user_input built from the measured frames: ↓ moves the
// pointer, Enter answers and advances (submits on the last), Tab opens notes.
function fakeQuestions(h) {
  const questions = [
    { q: 'Which color?', options: [['Red', 'Choose red.'], ['Blue', 'Choose blue.']] },
    { q: 'Which fruit?', options: [['Apple', 'Choose apple.'], ['Pear', 'Choose pear.']] },
  ];
  const st = { at: 0, pointer: [1, 1], answers: [null, null], notes: null, closed: false };
  const draw = () => {
    if (st.closed) return fixture('question-answered-working-0.160.0.txt');
    const open = st.answers.filter((a) => a == null).length;
    const cur = questions[st.at];
    const rows = [...cur.options, ['None of the above', 'Optionally, add details in notes (tab)']]
      .map(([label, desc], i) => `  ${st.pointer[st.at] === i + 1 ? '›' : ' '} ${i + 1}. ${label.padEnd(19)}${desc}`);
    const last = open === 1 && st.answers[st.at] == null;
    const footer = st.notes != null ? '  tab or esc to clear notes | enter to submit all'
      : `  tab to add notes | enter to submit ${last ? 'all' : 'answer'} | ←/→ to navigate questions | esc to interrupt`;
    return ['› earlier prompt', '', ' ', ` `, `  Question ${st.at + 1}/2 (${open} unanswered)`, `  ${cur.q}`, ' ', ...rows, ' ',
      ...(st.notes != null ? [`  › ${st.notes || 'Add notes'}`, ' '] : []), footer].join('\n');
  };
  h.state.screen = draw;
  h.state.onInput = (bytes) => {
    if (st.closed) return;
    if (bytes === '\x1b[B') st.pointer[st.at] = Math.min(3, st.pointer[st.at] + 1);
    else if (bytes === '\x1b[A') st.pointer[st.at] = Math.max(1, st.pointer[st.at] - 1);
    else if (bytes === '\x1b[C') st.at = Math.min(1, st.at + 1);
    else if (bytes === '\x1b[D') st.at = Math.max(0, st.at - 1);
    else if (bytes === '\t') st.notes = st.notes == null ? '' : null;
    else if (bytes.startsWith('\x1b[200~') && st.notes != null) st.notes += bytes.slice(6, -6);
    else if (bytes === '\r') {
      st.answers[st.at] = { pick: st.pointer[st.at], note: st.notes };
      st.notes = null;
      const next = st.answers.findIndex((a) => a == null);
      if (next < 0) st.closed = true; else st.at = next;
    }
  };
  return { st, questions: questions.map((x, i) => ({ header: i ? 'Fruit' : 'Color', question: x.q, options: x.options.map(([label, description]) => ({ label, description })) })) };
}

test('one click answers a lone Codex question by walking to the row and pressing Enter', async () => {
  const h = harness();
  const fake = fakeQuestions(h);
  const send = createSessionSend(h.deps);
  const result = await send.answerMenu({ pane, action: { type: 'select', index: 2 } });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.st.answers[0], { pick: 2, note: null });
  assert.deepEqual(h.sent, ['\x1b[B', '\r']);
});

test('the staged sheet delivers a Codex batch and treats the dialog closing as the submit', async () => {
  const h = harness();
  const fake = fakeQuestions(h);
  const send = createSessionSend(h.deps);
  const result = await send.answerMenu({
    pane,
    action: { type: 'sheet', answers: [{ question: 0, kind: 'select', index: 2 }, { question: 1, kind: 'text', text: 'Mango' }] },
    ask: fake.questions,
  });
  assert.deepEqual(result, { ok: true, action: 'sheet', delivered: 2 });
  assert.deepEqual(fake.st.answers, [{ pick: 2, note: null }, { pick: 3, note: 'Mango' }]);
});

test('Allow on a Codex approval picks "Yes, proceed", never the don\'t-ask-again row', async () => {
  const h = harness({ screen: fixture('approval-command-0.160.0.txt') });
  h.state.onInput = (bytes) => { if (bytes === '\r') h.state.screen = fixture('working-0.160.0.txt'); };
  // The click names the prompt it was shown for, in the words codex-status.js
  // publishes for the dialog on screen.
  const shown = 'approve: echo hello > probe.txt';
  const send = createSessionSend({ ...h.deps, readQuickStatus: async () => ({ state: 'blocked', kind: 'permission', msg: shown }) });
  const result = await send.answerMenu({ pane, action: { type: 'permission-quick', decision: 'allow', expect: shown } });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.sent, ['\r'], 'row 1 was already pointed at: Enter only');
});

// Approval A ("echo hello > probe.txt") was answered and Codex raised approval B
// within the 1.5 s poll, so the PUBLISHED status (all readQuickStatus has for a
// Codex pane) still says A. A stale click for A must not land on B: it is
// checked against the dialog just read, not the published status the chip
// itself came from.
const approvalB = () => fixture('approval-command-0.160.0.txt').split('echo hello > probe.txt').join('rm -rf build');
test('a stale Codex Allow for an answered approval is refused when the next approval is up, whatever the published status says', async () => {
  const h = harness({ screen: approvalB() });
  const stale = 'approve: echo hello > probe.txt';
  const send = createSessionSend({ ...h.deps, readQuickStatus: async () => ({ state: 'blocked', kind: 'permission', msg: stale }) });
  for (const decision of ['allow', 'deny']) {
    const result = await send.answerMenu({ pane, action: { type: 'permission-quick', decision, expect: stale } });
    assert.equal(result.ok, false, decision);
    assert.match(result.reason, /prompt changed/);
  }
  assert.deepEqual(h.sent, [], 'no Enter and no Esc reached approval B');
});

test('a Codex Allow for the approval on screen goes through even while the published status still names the last one', async () => {
  const h = harness({ screen: approvalB() });
  h.state.onInput = (bytes) => { if (bytes === '\r') h.state.screen = fixture('working-0.160.0.txt'); };
  const send = createSessionSend({ ...h.deps, readQuickStatus: async () => ({ state: 'blocked', kind: 'permission', msg: 'approve: echo hello > probe.txt' }) });
  const result = await send.answerMenu({ pane, action: { type: 'permission-quick', decision: 'allow', expect: 'approve: rm -rf build' } });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.sent, ['\r']);
});

// Two approvals of the same command read the same words. The click also names
// the seq codex-status gave the prompt it was shown for; a click for an older
// seq, or a second click once that prompt was answered here, is refused.
test('a Codex Allow whose seq is not the live prompt\'s is refused, and an answered prompt\'s seq is spent', async () => {
  const h = harness({ screen: fixture('approval-command-0.160.0.txt') });
  h.state.onInput = (bytes) => { if (bytes === '\r') h.state.screen = fixture('working-0.160.0.txt'); };
  let seq = 4;
  const spent = [];
  const send = createSessionSend({
    ...h.deps,
    readCodexPromptSeq: () => seq,
    codexPromptAnswered: (paneId) => { spent.push(paneId); seq = null; },
  });
  const expect = 'approve: echo hello > probe.txt';
  const stale = await send.answerMenu({ pane, action: { type: 'permission-quick', decision: 'allow', expect, expectSeq: 3 } });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /prompt changed/);
  assert.deepEqual(h.sent, []);
  const live = await send.answerMenu({ pane, action: { type: 'permission-quick', decision: 'allow', expect, expectSeq: 4 } });
  assert.equal(live.ok, true, live.reason);
  assert.deepEqual(spent, ['pane-1']);
  // The same prompt again (another surface's click, same words, same seq).
  h.state.screen = fixture('approval-command-0.160.0.txt');
  const again = await send.answerMenu({ pane, action: { type: 'permission-quick', decision: 'allow', expect, expectSeq: 4 } });
  assert.equal(again.ok, false);
  assert.deepEqual(h.sent, ['\r'], 'only the first click pressed anything');
});

// An IDLE Codex screen whose last answer reads like a
// Claude blocker ("Do you want…" starting a line, "Press Enter to continue",
// "Enter to confirm", "Esc to cancel") is not blocked: Codex's own composer is
// right under it. It used to refuse the send as "a prompt Harbor cannot fully
// read" and draw the fallback panel over an idle session.
const idleQuoting = () => fixture('idle-composer-0.160.0.txt').replace('• Created probe2.txt containing hello.', [
  '• Created probe2.txt containing hello. The installer it wraps prints',
  '  "Press Enter to continue" and its picker says "Enter to confirm · Esc to cancel".',
  '',
  '  Do you want me to add probe2.txt to .gitignore as well?',
].join('\n'));
test('an idle Codex screen whose answer reads like a Claude prompt is not blocked: no panel, and the send goes through', async () => {
  const h = harness({ screen: idleQuoting() });
  const send = createSessionSend(h.deps);
  assert.equal(await send.getMenu({ pane }), null, 'no fallback panel over an idle session');
  assert.equal(await send.getMenu({ pane, blockedHint: true }), null, 'a stale blocked hint does not raise one either');
  h.state.onInput = (bytes) => { if (bytes === '\r') h.state.screen = withEcho('hello'); };
  await send.send({ sessionId: 'codex-thread-1', text: 'hello', provider: 'codex', pane });
  assert.ok(h.sent.length, 'the send was typed');
  assert.equal(h.sent.at(-1), '\r');
});

test('a working Codex turn quoting a Claude prompt is not blocked either', async () => {
  const working = fixture('working-0.160.0.txt');
  const screen = working.replace(/\n(• Working)/, '\n  Do you want to proceed? Press Enter to continue.\n\n$1');
  assert.notEqual(screen, working, 'the fixture has a working line to quote above');
  const h = harness({ screen });
  assert.equal(await createSessionSend(h.deps).getMenu({ pane, blockedHint: true }), null);
});

// --- the queue, send now, permissions -------------------------------------------

test('the Codex queue is read off the screen and Send now is Esc, only over a pending steer', async () => {
  const h = harness({ screen: fixture('working-steer-and-queued-0.160.0.txt') });
  const send = createSessionSend(h.deps);
  assert.deepEqual(await send.getCliQueue({ pane, provider: 'codex' }),
    { working: true, steer: ['second note PEAR'], queued: ['also say BANANA at the end'], count: 2 });
  assert.equal(await send.getCliQueue({ pane, provider: 'claude' }), null);
  assert.deepEqual(await send.sendNowCodex({ pane }), { ok: true });
  assert.deepEqual(h.sent, ['\x1b']);
  h.state.screen = fixture('working-queued-0.160.0.txt');
  assert.equal((await send.sendNowCodex({ pane })).ok, false, 'Esc with only a queued follow-up would just interrupt');
  assert.deepEqual(h.sent, ['\x1b']);
});

// The steer was taken at the turn's next tool call while Send now was still
// acquiring control: Esc then has nothing to send and only aborts the turn, so
// the screen is re-read once control is held and nothing is pressed.
test('Send now presses nothing when the steer was delivered while control was being acquired', async () => {
  const h = harness({ screen: fixture('working-steer-and-queued-0.160.0.txt') });
  h.state.controlled = 'another-pane';
  h.deps.terminalBridge.requestFocusPane = async ({ paneId }) => {
    h.state.controlled = paneId;
    h.state.screen = fixture('working-queued-0.160.0.txt');
    return { ok: true };
  };
  const send = createSessionSend(h.deps);
  const result = await send.sendNowCodex({ pane });
  assert.equal(result.ok, false);
  assert.match(result.reason, /already sent into the turn/);
  assert.deepEqual(h.sent, [], 'no Esc: it would only have interrupted the turn');
});

test('Send now still presses Esc when the same steer is pending after control is acquired', async () => {
  const h = harness({ screen: fixture('working-steer-and-queued-0.160.0.txt') });
  h.state.controlled = 'another-pane';
  const send = createSessionSend(h.deps);
  assert.deepEqual(await send.sendNowCodex({ pane }), { ok: true });
  assert.deepEqual(h.sent, ['\x1b']);
});

test('a Codex pane reports the permission mode its rollout records, and refuses shift+tab', async () => {
  const h = harness();
  const file = path.join(h.dir, 'rollout.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: '2026-10-15T12:00:00Z', type: 'turn_context', payload: { approval_policy: 'never', approvals_reviewer: 'user', sandbox_policy: { type: 'danger-full-access' } } })}\n`);
  h.deps.resolveTranscriptPath = async (id) => (id === 'codex-thread-1' ? file : null);
  const send = createSessionSend(h.deps);
  assert.equal((await send.readPermissionMode('pane-1')).mode, 'bypass');
  await assert.rejects(send.cyclePermissionMode('pane-1', 'ws-1'), /set when it launches/);
  assert.deepEqual(h.sent, []);
});

test('"No, and tell Codex what to do differently" carries feedback as a Codex send', async () => {
  const h = harness({ screen: fixture('approval-command-0.160.0.txt') });
  const text = 'use a temp file instead';
  let pointer = 1;
  const approval = () => fixture('approval-command-0.160.0.txt')
    .replace('› 1. Yes, proceed (y)', `${pointer === 1 ? '›' : ' '} 1. Yes, proceed (y)`)
    .replace('  3. No, and tell Codex', `${pointer === 3 ? '›' : ' '} 3. No, and tell Codex`);
  h.state.screen = approval;
  h.state.onInput = (bytes) => {
    if (bytes === '\x1b[B') { pointer += 1; h.state.screen = approval; }
    else if (bytes === '\r' && typeof h.state.screen === 'function') h.state.screen = fixture('idle-composer-0.160.0.txt');
    else if (bytes.includes(text)) h.state.screen = withComposer(text);
    else if (bytes === '\r') h.state.screen = withEcho(text);
  };
  const send = createSessionSend(h.deps);
  const result = await send.answerMenu({ pane, action: { type: 'permission-feedback', index: 3, text } });
  assert.deepEqual(result, { ok: true, action: 'permission-feedback', index: 3 });
});
