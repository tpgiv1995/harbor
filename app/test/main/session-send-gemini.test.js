'use strict';

// The Gemini (Antigravity CLI, `agy`) send path of main/session-send.js:
// the box reader over REAL agy 1.5.14 screens (test/fixtures/gemini-box/,
// captured in a 120-column ConPTY with the folder and account renamed), the
// transcript listing and fresh-conversation discovery, the record that confirms
// a send, and the send itself against a stand-in pane that draws agy's real
// layout. Nothing here starts agy, a daemon or a window.
//
// Two-sided where a fallback was removed: GEMINI_SEND_MODULE names the module
// under test, so the pre-change file can be run against this suite and must fail
// the specs marked "old code".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const send = require(process.env.GEMINI_SEND_MODULE || '../../src/main/session-send.js');
const {
  createSessionSend,
  createLinkRegistry,
  providerTranscriptDirs,
  geminiPromptBox,
  geminiBoxMatch,
  geminiBoxState,
  geminiBlockedKind,
  geminiSurveyShown,
  geminiQueuedShown,
  geminiHistoryPathFor,
  geminiUserRequest,
  geminiBrainDir,
  geminiWholeTranscriptPath,
  sameFolder,
} = send;
const NEW_CODE = typeof geminiPromptBox === 'function';

const fixture = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/gemini-box', name), 'utf8');
const transcriptFixture = (name) => path.join(__dirname, '../fixtures/gemini-box/transcripts', name);

const tempDirs = [];
const tempDir = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harbor-gemini-send-${label}-`));
  tempDirs.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

const ID_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const ID_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const ID_C = '33333333-cccc-4ccc-8ccc-333333333333';

// ---- the reader over real screens ------------------------------------------------

test('the box reader finds the prompt between the last two full-width rules on every real idle screen', { skip: !NEW_CODE }, () => {
  const idle = geminiPromptBox(fixture('agy-1.5.14-idle-empty-120.txt'));
  assert.equal(idle.inside, '', 'the mode placeholder is not a draft');
  assert.equal(idle.status, 'idle', '"? for shortcuts" is the idle status row');
  // A custom statusLine replaces the status row: the box is still the box.
  const tee = geminiPromptBox(fixture('agy-1.5.14-idle-tee-status-120.txt'));
  assert.equal(tee.inside, '');
  assert.equal(tee.status, 'unknown', 'the status words are a hint, never a gate');
  // After a turn: the submitted prompt above is an echo under a SHORT rule, not the box.
  for (const name of ['agy-1.5.14-after-reply-120.txt', 'agy-1.5.14-after-reply-tee-status-120.txt', 'agy-1.5.14-resumed-banner-120.txt', 'agy-1.5.14-interrupted-120.txt']) {
    assert.equal(geminiPromptBox(fixture(name)).inside, '', name);
  }
  const echoed = fixture('agy-1.5.14-after-reply-tee-status-120.txt');
  assert.match(echoed, /^> Use the shell to run exactly/m, 'the screen does echo the earlier prompt');
  assert.equal(geminiBoxState(echoed, { text: 'Use the shell to run exactly: echo hi   Then reply with only the output.' }), 'empty', 'the echo is never the box');
});

test('a working turn draws the spinner above an empty box, and the box stays readable', { skip: !NEW_CODE }, () => {
  const working = fixture('agy-1.5.14-working-120.txt');
  assert.equal(geminiPromptBox(working).inside, '');
  assert.equal(geminiPromptBox(working).status, 'working');
  assert.equal(geminiPromptBox(fixture('agy-1.5.14-working-tee-status-120.txt')).inside, '');
  assert.equal(geminiBoxState(working, { text: 'pasted one' }), 'empty');
});

test('a draft shows as exact only when it is this message, whitespace aside', { skip: !NEW_CODE }, () => {
  const two = fixture('agy-1.5.14-draft-two-lines-120.txt');
  assert.equal(geminiBoxState(two, { text: 'pasted one\npasted two' }), 'exact');
  assert.equal(geminiBoxState(two, { text: 'pasted one pasted two' }), 'exact', 'the box re-wraps, so whitespace is dropped on both sides');
  assert.equal(geminiBoxState(two, { text: 'pasted one' }), 'other', 'a prefix is not the message');
  assert.equal(geminiBoxState(two, { text: 'something else' }), 'other');
  const alt = fixture('agy-1.5.14-draft-alt-enter-120.txt');
  assert.equal(geminiBoxState(alt, { text: 'second line via alt+enter' }), 'exact');
  assert.equal(geminiPromptBox(alt).raw, '\nsecond line via alt+enter', 'a newline typed first draws a bare ">" row');
});

test('the slash menu hangs under a real box: the box holds "/", the list is not a dialog', { skip: !NEW_CODE }, () => {
  const menu = fixture('agy-1.5.14-slash-menu-120.txt');
  const found = geminiBoxMatch(menu, { text: 'hello' });
  assert.equal(found.state, 'other');
  assert.equal(found.draft, '/');
  assert.equal(found.menuOpen, true);
});

test('every dialog and first-run page is "no box", and says which', { skip: !NEW_CODE }, () => {
  const permission = fixture('agy-1.5.14-permission-prompt-120.txt');
  assert.match(permission, /^> 1\. Yes, run command$/m);
  assert.equal(geminiPromptBox(permission), null, 'the echo above the Command rule is not a box');
  assert.equal(geminiBoxState(permission, { text: 'Use the shell' }), 'noprompt');
  assert.equal(geminiBlockedKind(permission), 'permission');
  const trust = fixture('agy-1.5.14-trust-dialog-120.txt');
  assert.equal(geminiBoxState(trust, { text: 'x' }), 'noprompt');
  assert.equal(geminiBlockedKind(trust), 'trust');
  for (const name of ['agy-1.5.14-first-run-colour-scheme-120.txt', 'agy-1.5.14-first-run-terms-120.txt']) {
    assert.equal(geminiBoxState(fixture(name), { text: 'x' }), 'noprompt', name);
    assert.equal(geminiBlockedKind(fixture(name)), 'first-run', name);
  }
  assert.equal(geminiBlockedKind(''), 'blank');
  assert.equal(geminiBlockedKind(fixture('agy-1.5.14-idle-empty-120.txt')), 'unknown');
});

test('a numbered row below the last rule is a dialog even when a box-like echo sits above it', { skip: !NEW_CODE }, () => {
  const rule = '─'.repeat(120);
  const screen = `banner\n${'─'.repeat(60)}\n> Please run it\n\n${rule}\n\nRun this command?\n> 1. Yes, run command\n  2. No, cancel\n\n  ↑/↓ Navigate · tab Amend`;
  assert.equal(geminiBoxState(screen, { text: 'x' }), 'noprompt');
  // The same rows INSIDE a box (the person typed a numbered list) are a draft, not a dialog.
  const draft = `${rule}\n> 1. first\n  2. second\n${rule}\n? for shortcuts`;
  assert.equal(geminiBoxState(draft, { text: '1. first\n2. second' }), 'exact');
});

// A reply's numbered list is not a question (Pat, 2026-11-25). With no box drawn for a moment (a redraw, the survey
// under a Harbor that predates its skip), the list under the last echo rule read as 'permission': the send stopped
// waiting for the box after 8 polls and refused with "Gemini is waiting on a question (a permission or a choice)".
// Every agy question measured draws "↑/↓ Navigate" or its own words (AGY-FACTS.md: trust, first-run, permission).
test('a numbered list in a reply under the last rule is not a Gemini question (old code: "permission")', { skip: !NEW_CODE }, () => {
  const rows = fixture('agy-1.5.14-working-numbered-reply-120.txt').split('\n');
  const noBox = rows.slice(0, rows.findIndex((row) => row.startsWith('  Verification'))).join('\n');
  assert.match(noBox, /^ {2}1\. Studio Command/m);
  assert.equal(geminiPromptBox(noBox), null);
  assert.equal(geminiBlockedKind(noBox), 'unknown');
  assert.equal(geminiBlockedKind(fixture('agy-1.5.14-permission-prompt-120.txt')), 'permission', 'a real question still is one');
});

test('hyphens and rounded corners are not rules: the Terms page and the colour preview draw no box', { skip: !NEW_CODE }, () => {
  assert.equal(geminiPromptBox(`${'-'.repeat(100)}\n> [x] Yes, I agree\n${'-'.repeat(100)}`), null);
  assert.equal(geminiPromptBox(`╭${'─'.repeat(50)}╮\n│ > you: add a greeting │\n╰${'─'.repeat(50)}╯`), null);
});

// 2026-11-25: agy's feedback survey replaced the box after a long turn and every
// send to that window failed "Gemini is not showing its prompt box".
test('the feedback survey is its own kind of "no box", and only when its two rows are the last thing drawn', { skip: !NEW_CODE || typeof geminiSurveyShown !== 'function' }, () => {
  const survey = fixture('agy-1.5.14-feedback-survey-120.txt');
  assert.equal(geminiPromptBox(survey), null, 'the survey replaces the box: no rules are drawn');
  // Its screen still shows the SHORT rules over earlier prompts' echoes; read as the box they would
  // hold the last prompt, and a resend of that prompt would get a bare Enter into the survey.
  assert.equal(geminiBoxState(survey, { text: 'pasted one\npasted two/help' }), 'noprompt');
  assert.equal(geminiBoxState(survey, { text: '/Reply with exactly the word OK and nothing else. Use no tools.' }), 'noprompt');
  assert.equal(geminiSurveyShown(survey), true);
  assert.equal(geminiBlockedKind(survey), 'survey');
  // The same words quoted in a reply above a real box are prose.
  const quoted = `${BANNER}\n  The CLI asked me:\n How's the CLI experience so far? Help us improve:\n [1] Good  [2] Fine  [3] Bad  [0] Skip\n\n  and I skipped it.\n${RULE}\n> ${PLACEHOLDER}\n${RULE}\n? for shortcuts`;
  assert.equal(geminiSurveyShown(quoted), false);
  assert.notEqual(geminiBlockedKind(quoted), 'survey');
  assert.equal(geminiBoxState(quoted, { text: 'x' }), 'empty');
  // Rows under it that are not the status row: not the survey owning the keys.
  assert.equal(geminiSurveyShown(`${survey}\nmore output\nand more`), false);
  // A question row alone, or options alone, is not the survey.
  assert.equal(geminiSurveyShown(" How's the CLI experience so far? Help us improve:\n\n? for shortcuts"), false);
  assert.equal(geminiSurveyShown(' [1] Good  [2] Fine  [3] Bad  [0] Skip\n\n? for shortcuts'), false);
  for (const name of ['agy-1.5.14-idle-empty-120.txt', 'agy-1.5.14-permission-prompt-120.txt', 'agy-1.5.14-trust-dialog-120.txt']) {
    assert.equal(geminiSurveyShown(fixture(name)), false, name);
  }
});

test('a message sent while agy works waits as a "▸" row over the box, and only that message reads as queued', { skip: !NEW_CODE || typeof geminiQueuedShown !== 'function' }, () => {
  // Rows as agy 1.5.14 drew them (2026-11-25, scratch profile): the older one
  // bare, the newest marked, a multi-line one cut after its first line.
  const screen = [
    '● Running (Start-Sleep -Seconds 4) (ctrl+o to expand)',
    '⣯  Running command...',
    '▸ Reply with exactly QUEUED-TWO and nothing else. Use no tools.',
    '▸ Reply with exactly QPASTE-LINES and nothing else. Use no tools. Ignore the lines below.... (alt+m to send immediately)',
    RULE, '>', RULE,
    '  Press up to edit queued messages                                                        auto · Gemini 4 Hydrogen · low',
  ].join('\n');
  assert.equal(geminiQueuedShown(screen, 'Reply with exactly QUEUED-TWO and nothing else. Use no tools.'), true);
  assert.equal(geminiQueuedShown(screen, 'Reply with exactly QPASTE-LINES and nothing else. Use no tools. Ignore the lines below.\nqline 1: the lazy dog'), true);
  assert.equal(geminiQueuedShown(screen, 'Reply with exactly QUEUED-THREE and nothing else.'), false, 'another message is not this one');
  assert.equal(geminiQueuedShown(screen, 'Re'), false, 'a short message is matched whole, never by a shared start');
  assert.equal(geminiQueuedShown(fixture('agy-1.5.14-idle-empty-120.txt'), 'hello'), false);
  assert.equal(geminiBoxState(screen, { text: 'x' }), 'empty', 'the queue rows are above the box, never in it');
});

test('a Gemini transcript names its home\'s prompt history; any other path names none', { skip: !NEW_CODE || typeof geminiHistoryPathFor !== 'function' }, () => {
  const home = path.join('C:', 'Users', 'someone');
  const store = path.join(home, '.gemini', 'antigravity-cli');
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    assert.equal(geminiHistoryPathFor(path.join(store, 'brain', ID_A, '.system_generated', 'logs', name)), path.join(store, 'history.jsonl'), name);
  }
  assert.equal(geminiHistoryPathFor(path.join(home, '.claude', 'projects', 'C--x', `${ID_A}.jsonl`)), null);
  assert.equal(geminiHistoryPathFor(''), null);
});

test('the survey can also come up WHILE a turn runs, over the echoes of earlier prompts: still the survey, never a box', { skip: !NEW_CODE || typeof geminiSurveyShown !== 'function' }, () => {
  // Shaped on a live capture (2026-11-26, send refused GEMINI_BOX_BUSY by the old reader,
  // which took the rows between two echo rules for a box holding an earlier prompt's "Image:" line).
  const echoRule = '─'.repeat(50);
  const screen = [
    echoRule, '> Image: C:\\work\\shot.png', '  make the dock icon-only', '', '  Done. Here is the dock.', '',
    echoRule, '> redo and give me 3 different versions', '  give me 3 variations on this please',
    '⣟  Comparing the generated designs reveals distinct spatial philosophies...',
    '└ Tip: Use @ to mention files and give the model more context.',
    " How's the CLI experience so far? Help us improve:", ' [1] Good  [2] Fine  [3] Bad  [0] Skip', '',
    'esc to cancel · Gemini 4 Neon (High)',
  ].join('\n');
  assert.equal(geminiPromptBox(screen), null);
  assert.equal(geminiBoxState(screen, { text: 'anything' }), 'noprompt');
  assert.equal(geminiBlockedKind(screen), 'survey');
});

// ---- the record that confirms a send -----------------------------------------

const sendFor = (extra = {}) => {
  const dir = tempDir('confirm');
  return createSessionSend({
    snapshot: async () => ({ panes: [], workspaces: [] }),
    readPane: async () => '',
    terminalBridge: { getState: () => ({ controlledPaneId: null }), sendInput: () => ({ ok: true }) },
    launchActions: {},
    getSessionMeta: async () => ({}),
    links: createLinkRegistry(),
    projectLabelForCwd: () => 'proof',
    sleep: async () => {},
    captureDir: path.join(dir, 'unrecognized-dialogs'),
    sendLogFile: path.join(dir, 'send-log.jsonl'),
    contextDir: path.join(dir, 'context'),
    ...extra,
  });
};

test('geminiUserRequest reads the typed words out of agy\'s wrapper, and only that', { skip: !NEW_CODE }, () => {
  const [first] = fs.readFileSync(transcriptFixture('agy-1.5.14-two-prompts.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(geminiUserRequest(first.content), 'pasted one\npasted two/help', 'a bracketed paste is recorded with its newline');
  assert.equal(geminiUserRequest('<USER_REQUEST>\nquotes </USER_REQUEST> inside\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>'), 'quotes </USER_REQUEST> inside');
  assert.equal(geminiUserRequest('no wrapper'), null);
  assert.equal(geminiUserRequest(undefined), null);
});

const confirmAgainst = async (file, text, { sessionId = ID_A, path: asPath = file, preSize = 0 } = {}) => {
  const s = sendFor({ getSessionMeta: async () => ({ path: asPath }) });
  return s.confirmDelivery(sessionId, text, { timeoutMs: 40, prepared: { path: asPath, preSize } });
};

test('a USER_INPUT step holding exactly the typed words confirms the send; nothing else does', { skip: !NEW_CODE }, async () => {
  const file = transcriptFixture('agy-1.5.14-two-prompts.jsonl');
  assert.equal(await confirmAgainst(file, 'pasted one\npasted two/help'), true, 'the real multi-line paste');
  assert.equal(await confirmAgainst(file, '/Reply with exactly the word OK and nothing else. Use no tools.'), true, 'a slash-looking prompt is stored verbatim');
  // The model's own words never confirm: "OK" is in the transcript only as the answer.
  await assert.rejects(confirmAgainst(file, 'OK'), (error) => error.code === 'UNCONFIRMED');
  // A prefix of a real prompt is not the prompt.
  await assert.rejects(confirmAgainst(file, 'pasted one'), (error) => error.code === 'UNCONFIRMED');
  // And a tool result that quotes the words is not a user step.
  const shell = transcriptFixture('agy-1.5.14-shell-turn.jsonl');
  await assert.rejects(confirmAgainst(shell, 'hi'), (error) => error.code === 'UNCONFIRMED');
  assert.equal(await confirmAgainst(shell, 'Use the shell to run exactly: echo hi   Then reply with only the output.'), true);
});

test('only bytes written after the send count: an identical earlier prompt does not confirm a new one', { skip: !NEW_CODE }, async () => {
  const file = transcriptFixture('agy-1.5.14-two-prompts.jsonl');
  const size = fs.statSync(file).size;
  await assert.rejects(confirmAgainst(file, 'pasted one\npasted two/help', { preSize: size }), (error) => error.code === 'UNCONFIRMED');
});

test('a long message confirms from transcript_full.jsonl even when the row names the cut copy', { skip: !NEW_CODE }, async () => {
  const logs = path.join(tempDir('whole'), '.gemini', 'antigravity-cli', 'brain', ID_A, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const long = `Please read this carefully. ${'the quick brown fox jumps over the lazy dog. '.repeat(120)}END`;
  const step = (content) => `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-24T02:28:19Z', content: `<USER_REQUEST>\n${content}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>` })}\n`;
  // agy cuts long fields in transcript.jsonl and says which it cut.
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\n${long.slice(0, 2000)}`, truncated_fields: ['content'] })}\n`);
  assert.equal(geminiWholeTranscriptPath(path.join(logs, 'transcript.jsonl')), path.join(logs, 'transcript.jsonl'), 'no whole copy yet: the cut copy is all there is');
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), step(long));
  assert.equal(geminiWholeTranscriptPath(path.join(logs, 'transcript.jsonl')), path.join(logs, 'transcript_full.jsonl'));
  assert.equal(geminiWholeTranscriptPath('/work/claude/session.jsonl'), '/work/claude/session.jsonl', 'another provider\'s path is returned as it came');
  // The reader the rail would hand over names the cut copy; the scan must use the whole one.
  // The send happens AFTER the boundary the check records: the whole copy grows by one step while it watches.
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), '');
  const s = sendFor({ getSessionMeta: async () => ({ path: path.join(logs, 'transcript.jsonl') }) });
  setTimeout(() => fs.appendFileSync(path.join(logs, 'transcript_full.jsonl'), step(long)), 20);
  assert.equal(await s.confirmDelivery(ID_A, long, { timeoutMs: 600, prepared: null }), true);
  // Two-sided: with only the cut copy to read, the long message never confirms.
  fs.rmSync(path.join(logs, 'transcript_full.jsonl'));
  fs.appendFileSync(path.join(logs, 'transcript.jsonl'), `${JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>\n${long.slice(0, 2000)}`, truncated_fields: ['content'] })}\n`);
  await assert.rejects(s.confirmDelivery(ID_A, long, { timeoutMs: 60, prepared: { path: path.join(logs, 'transcript.jsonl'), preSize: 0 } }), (error) => error.code === 'UNCONFIRMED');
});

// ---- the transcript store: listing and fresh-conversation discovery ----------

// 2026-11-26, Pat: "Gemini sessions can't handle queue'd messages". A message
// sent while agy works is queued; agy writes it to the transcript only when the
// running turn ends, and then MERGED with every other queued message into one
// prompt, so the 20-second transcript check called it "could not confirm" and
// two queued messages never confirmed at all. agy's prompt history records each
// one the moment it is queued (measured on agy 1.5.14).
const geminiHome = (label) => {
  const store = path.join(tempDir(label), '.gemini', 'antigravity-cli');
  const logs = path.join(store, 'brain', ID_A, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const transcript = path.join(logs, 'transcript_full.jsonl');
  const history = path.join(store, 'history.jsonl');
  const userStep = (request) => `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\n${request}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nt\n</ADDITIONAL_METADATA>` })}\n`;
  const historyLine = (display, { id = ID_A, timestamp = Date.now() } = {}) => `${JSON.stringify({ display, timestamp, workspace: 'C:\\work\\proof', conversationId: id })}\n`;
  fs.writeFileSync(transcript, userStep('the first prompt'));
  fs.writeFileSync(history, historyLine('the first prompt'));
  return { transcript, history, userStep, historyLine };
};

test('a queued Gemini message is confirmed by agy\'s prompt history the moment it is queued (old code: "could not confirm")', { skip: !NEW_CODE }, async () => {
  const home = geminiHome('queued-history');
  const s = sendFor({ getSessionMeta: async () => ({ path: home.transcript, provider: 'gemini' }) });
  const prepared = await s.prepareDeliveryConfirmation(ID_A);
  assert.equal(prepared.history.path, home.history, 'the history of the home this transcript is in');
  // agy queued it: a history line now, nothing in the transcript until the turn ends.
  fs.appendFileSync(home.history, home.historyLine('Reply with exactly QUEUED-TWO. Use no tools.'));
  assert.equal(await s.confirmDelivery(ID_A, 'Reply with exactly QUEUED-TWO. Use no tools.', { timeoutMs: 200, prepared }), true);
});

test('two queued messages each confirm from their own history line, though the transcript only ever holds them merged', { skip: !NEW_CODE }, async () => {
  const home = geminiHome('queued-two');
  const s = sendFor({ getSessionMeta: async () => ({ path: home.transcript, provider: 'gemini' }) });
  const two = 'Reply with exactly QUEUED-TWO and nothing else. Use no tools.';
  const three = 'Reply with exactly QUEUED-THREE and nothing else. Use no tools.';
  const first = await s.prepareDeliveryConfirmation(ID_A);
  fs.appendFileSync(home.history, home.historyLine(two));
  const second = await s.prepareDeliveryConfirmation(ID_A);
  fs.appendFileSync(home.history, home.historyLine(three));
  // The turn ends: agy sends both as ONE prompt (real shape, 2026-11-25).
  fs.appendFileSync(home.transcript, home.userStep(`${two}\n${three}`));
  assert.equal(await s.confirmDelivery(ID_A, two, { timeoutMs: 200, prepared: first }), true);
  assert.equal(await s.confirmDelivery(ID_A, three, { timeoutMs: 200, prepared: second }), true);
  // Without the history the merged prompt confirms neither (why the history is read).
  await assert.rejects(s.confirmDelivery(ID_A, two, { timeoutMs: 100, prepared: { path: first.path, preSize: first.preSize } }), (error) => error.code === 'UNCONFIRMED');
});

test('a pasted prompt\'s history carries NUL marks; without them it is the text exactly', { skip: !NEW_CODE }, async () => {
  const home = geminiHome('queued-paste');
  const s = sendFor({ getSessionMeta: async () => ({ path: home.transcript, provider: 'gemini' }) });
  const text = 'Reply with exactly QPASTE-LINES and nothing else.\nqline 1: the lazy dog\nqline 2: the lazy dog';
  const prepared = await s.prepareDeliveryConfirmation(ID_A);
  // As agy 1.5.14 stored a bracketed paste: a NUL before some characters.
  fs.appendFileSync(home.history, home.historyLine(text.replace(/([A-Z])/g, '\u0000$1')));
  assert.equal(await s.confirmDelivery(ID_A, text, { timeoutMs: 200, prepared }), true);
});

test('the history confirms only this conversation\'s line, written after the send, with exactly the typed words', { skip: !NEW_CODE }, async () => {
  const home = geminiHome('history-strict');
  const s = sendFor({ getSessionMeta: async () => ({ path: home.transcript, provider: 'gemini' }) });
  const text = 'continue';
  const unconfirmed = (prepared) => assert.rejects(s.confirmDelivery(ID_A, text, { timeoutMs: 100, prepared }), (error) => error.code === 'UNCONFIRMED');
  // Before the send's boundary: an identical earlier prompt.
  fs.appendFileSync(home.history, home.historyLine(text));
  await unconfirmed(await s.prepareDeliveryConfirmation(ID_A));
  // Another conversation, a prefix, a longer message, an old timestamp.
  let prepared = await s.prepareDeliveryConfirmation(ID_A);
  fs.appendFileSync(home.history, home.historyLine(text, { id: ID_B }));
  fs.appendFileSync(home.history, home.historyLine('cont'));
  fs.appendFileSync(home.history, home.historyLine('continue please'));
  fs.appendFileSync(home.history, home.historyLine(text, { timestamp: Date.now() - 60_000 }));
  await unconfirmed(prepared);
  // A Claude or Codex transcript has no prompt history.
  const claude = sendFor({ getSessionMeta: async () => ({ path: path.join(tempDir('claude-home'), 'x.jsonl') }) });
  prepared = await claude.prepareDeliveryConfirmation(ID_A);
  assert.equal(prepared.history, undefined);
});

test('a message sent while Gemini works is typed, Enter pressed once, and reported as queued (old code: plain "sent", then "could not confirm")', async () => {
  const h = makeHarness();
  const pane = geminiPane(h, { working: true, queueing: true });
  const s = createSessionSend(h.deps);
  const statuses = [];
  s.emitter.on('status', (event) => statuses.push([event.phase, event.detail]));
  const result = await s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'and make the dock smaller', pane: target });
  assert.equal(result.ok, true);
  assert.deepEqual(typedKeys(h), ['and make the dock smaller', '\r'], 'no spare Enter: an empty box means agy took it');
  assert.deepEqual(pane.queued, ['and make the dock smaller']);
  const sent = statuses.find(([phase]) => phase === 'sent');
  assert.match(String(sent?.[1]), /Gemini queued it/);
});

const writeConversation = (home, id, { lines = 1 } = {}) => {
  const logs = path.join(geminiBrainDir(home), id, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), '{"step_index":0}\n'.repeat(lines));
  return path.join(logs, 'transcript_full.jsonl');
};
const writeTee = (contextDir, id, payload) => {
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(path.join(contextDir, `gemini-${id}.json`), JSON.stringify(payload));
};

test('provider transcript dirs: Gemini reads its own brain folder, and an unknown provider reads nothing', () => {
  const home = '/home/test';
  if (NEW_CODE) assert.deepEqual(providerTranscriptDirs('gemini', '/work/x', home), [path.join(home, '.gemini', 'antigravity-cli', 'brain')]);
  // Old code: ANY provider it did not know listed the CLAUDE project folder.
  assert.deepEqual(providerTranscriptDirs('antigravity', '/work/x', home), [], 'old code: the Claude project dir');
  assert.deepEqual(providerTranscriptDirs('gemini-typo', '/work/x', home), []);
  assert.deepEqual(providerTranscriptDirs('claude', '/work/x', home), [path.join(home, '.claude', 'projects', '-work-x')], 'Claude itself is unchanged');
  assert.deepEqual(providerTranscriptDirs(undefined, '/work/x', home), [path.join(home, '.claude', 'projects', '-work-x')], 'no provider is the default Claude, as the callers always meant it');
});

test('Cursor\'s project folder collapses runs of punctuation, as every other reader of that store does (a Windows path)', () => {
  // Real folder names on the machine this was found on: C-dev-cdt-app, never C--dev-cdt-app.
  assert.deepEqual(providerTranscriptDirs('cursor', 'C:\\dev\\x', '/home/test'), [
    path.join('/home/test', '.cursor', 'projects', 'C-dev-x', 'agent-transcripts'),
  ], 'old code: C--dev-x');
  assert.deepEqual(providerTranscriptDirs('cursor', 'C:\\dev\\cdt-app', 'H:\\home')[0], path.join('H:\\home', '.cursor', 'projects', 'C-dev-cdt-app', 'agent-transcripts'));
});

test('sameFolder compares one folder written two ways', () => {
  assert.equal(sameFolder('C:\\work\\Proof', 'c:/work/proof/', 'win32'), true);
  assert.equal(sameFolder('file:///C:/work/proof', 'C:\\work\\proof', 'win32'), true);
  assert.equal(sameFolder('C:\\work\\proof', 'C:\\work\\other', 'win32'), false);
  assert.equal(sameFolder('/work/Proof', '/work/proof', 'linux'), false, 'case counts off Windows');
  assert.equal(sameFolder('', ''), false, 'no folder is never a match');
});

test('listTranscriptIds names every conversation in the profile\'s brain folder', { skip: !NEW_CODE }, async () => {
  const home = tempDir('list');
  writeConversation(home, ID_A);
  writeConversation(home, ID_B);
  fs.mkdirSync(path.join(geminiBrainDir(home), 'not-a-conversation'), { recursive: true });
  const s = sendFor();
  assert.deepEqual([...await s.listTranscriptIds('C:\\work\\proof', 'gemini', home)].sort(), [ID_A, ID_B]);
  assert.deepEqual([...await s.listTranscriptIds('C:\\work\\proof', 'gemini', tempDir('empty'))], []);
});

test('a fresh Gemini pane is linked to the new conversation that started in ITS folder, never to a Claude session', { skip: !NEW_CODE }, async () => {
  const home = tempDir('fresh');
  const contextDir = path.join(home, 'context');
  const cwd = 'C:\\work\\proof';
  // A Claude project folder for the very same cwd, with a session in it: the old code listed it.
  const claudeDir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${ID_C}.jsonl`), '{}\n');
  const s = sendFor({ contextDir });
  const sinceMs = Date.now() - 1000;
  assert.equal(await s.findFreshTranscript({ cwd, provider: 'claude', sinceMs, knownIds: new Set(), timeoutMs: 200, home }), ID_C, 'the Claude folder does hold a candidate');
  // No Gemini conversation exists: the answer is nothing (old code: the Claude session id above).
  assert.equal(await s.findFreshTranscript({ cwd, provider: 'gemini', sinceMs, knownIds: new Set(), timeoutMs: 120, home }), null);
  assert.deepEqual([...await s.listTranscriptIds(cwd, 'gemini', home)], [], 'and listing a Gemini store never names a Claude session');
  // With one, it is that conversation, and only when it is new and started here.
  writeConversation(home, ID_A);
  const known = new Set([ID_A]);
  const since = Date.now();
  writeConversation(home, ID_B);
  writeTee(contextDir, ID_B, { conversation_id: ID_B, cwd });
  assert.equal(await s.findFreshTranscript({ cwd, provider: 'gemini', sinceMs: since, knownIds: known, timeoutMs: 400, home }), ID_B);
});

test('a new conversation from another folder (a worker, another pane) is not this pane\'s', { skip: !NEW_CODE }, async () => {
  const home = tempDir('other-folder');
  const contextDir = path.join(home, 'context');
  const sinceMs = Date.now();
  writeConversation(home, ID_B);
  writeTee(contextDir, ID_B, { conversation_id: ID_B, cwd: 'C:\\work\\other' });
  const s = sendFor({ contextDir });
  assert.equal(await s.findFreshTranscript({ cwd: 'C:\\work\\proof', provider: 'gemini', sinceMs, knownIds: new Set(), timeoutMs: 120, home }), null);
  // No evidence of any folder yet: never guess.
  const bare = tempDir('no-evidence');
  writeConversation(bare, ID_C);
  assert.equal(await s.findFreshTranscript({ cwd: 'C:\\work\\proof', provider: 'gemini', sinceMs, knownIds: new Set(), timeoutMs: 120, home: bare }), null);
});

test('the folder comes from the prompt history or the folder map when no tee was written', { skip: !NEW_CODE }, async () => {
  const cwd = 'C:\\work\\proof';
  const sinceMs = Date.now();
  const viaHistory = tempDir('history');
  writeConversation(viaHistory, ID_B);
  fs.writeFileSync(path.join(viaHistory, '.gemini', 'antigravity-cli', 'history.jsonl'), [
    JSON.stringify({ display: 'first prompt, no id yet', timestamp: 1, workspace: cwd }),
    JSON.stringify({ display: 'second', timestamp: 2, workspace: cwd, conversationId: ID_B }),
    '',
  ].join('\n'));
  const s = sendFor();
  assert.equal(await s.findFreshTranscript({ cwd, provider: 'gemini', sinceMs, knownIds: new Set(), timeoutMs: 200, home: viaHistory }), ID_B);
  const viaMap = tempDir('map');
  writeConversation(viaMap, ID_C);
  fs.mkdirSync(path.join(viaMap, '.gemini', 'antigravity-cli', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(viaMap, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json'), JSON.stringify({ [cwd]: ID_C }));
  assert.equal(await s.findFreshTranscript({ cwd, provider: 'gemini', sinceMs, knownIds: new Set(), timeoutMs: 200, home: viaMap }), ID_C);
});

test('a provider this module does not drive finds nothing: it is never linked to a Claude session in the same folder', async () => {
  // os.homedir() answers from USERPROFILE (HOME elsewhere), so the code that reads
  // the real profile by default reads this scratch one for the length of the spec.
  const home = tempDir('claude-home');
  const cwd = process.platform === 'win32' ? 'C:\\work\\proof' : '/work/proof';
  const claudeDir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, `${ID_C}.jsonl`), '{}\n');
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const s = sendFor();
    const args = { cwd, sinceMs: Date.now() - 5000, knownIds: new Set(), timeoutMs: 60 };
    assert.equal(await s.findFreshTranscript({ ...args, provider: 'claude' }), ID_C, 'the scratch Claude session is there to be found');
    // Old code: both of these returned that Claude session id.
    assert.equal(await s.findFreshTranscript({ ...args, provider: 'gemini' }), null);
    assert.equal(await s.findFreshTranscript({ ...args, provider: 'antigravity' }), null);
    assert.deepEqual([...await s.listTranscriptIds(cwd, 'gemini')], [], 'old code: the Claude session ids');
    assert.deepEqual([...await s.listTranscriptIds(cwd, 'antigravity')], []);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

// ---- the send itself, against a stand-in pane that draws agy's layout ------------

const RULE = '─'.repeat(120);
const SHORT_RULE = '─'.repeat(60);
const BANNER = '\n      ▄▀▀▄        Antigravity CLI 1.5.14\n     ▀▀▀▀▀▀       <account> (Google AI Ultra)\n    ▀▀▀▀▀▀▀▀      Gemini 4 Hydrogen (Low)\n   ▄▀▀    ▀▀▄     C:/work/proof\n  ▄▀▀      ▀▀▄\n';
const PLACEHOLDER = 'Auto mode: edits & safe commands auto-approved (shift+tab to cycle)';
const SURVEY = 'agy-1.5.14-feedback-survey-120.txt';

function makeHarness() {
  const dir = tempDir('send');
  const sent = [];
  const state = { controlledPaneId: 'pane-1' };
  const harness = {
    sent,
    dir,
    deps: {
      snapshot: async () => ({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1' }], workspaces: [{ workspace_id: 'ws-1', label: 'proof' }] }),
      readPane: async () => '',
      terminalBridge: {
        getState: () => ({ controlledPaneId: state.controlledPaneId }),
        requestFocusPane: async () => ({ ok: true }),
        sendInput: (paneId, text) => { sent.push(text); return { ok: true }; },
      },
      launchActions: {},
      getSessionMeta: async () => ({ cwd: 'C:\\work\\proof' }),
      links: createLinkRegistry(),
      projectLabelForCwd: () => 'proof',
      sleep: async () => {},
      captureDir: path.join(dir, 'unrecognized-dialogs'),
      sendLogFile: path.join(dir, 'send-log.jsonl'),
      contextDir: path.join(dir, 'context'),
    },
  };
  return harness;
}

// A pane that draws agy's real layout: banner, the earlier prompts echoed under a
// short rule, a spinner while working, the box between two 120-column rules, and
// the bottom status row (or a custom statusLine's one line).
function geminiPane(h, {
  swallowEnters = 0, dropTypings = 0, status = 'shortcuts', working = false, prefill = '', placeholder = true,
  dialog = null, dialogOnTyping = null, lateDraw = 0, collapse = true, survey = null,
  queueing = false, onQueued = null,
} = {}) {
  let draft = prefill;
  let swallowed = 0;
  let dropped = 0;
  let hidden = 0;
  const echoed = [];
  const typings = [];
  // agy 1.5.14 while a turn runs: an Enter QUEUES the message as a "▸" row over
  // the box (the newest one marked "alt+m"), and the status row says so.
  const queued = [];
  const state = { reads: 0, dialog: survey ? SURVEY : dialog, working };
  const boxRows = (text) => text.split('\n').map((line, i) => (i === 0 ? `>${line ? ' ' : ''}${line}` : `  ${line}`)).join('\n');
  // What the real agy 1.5.14 draws for a big paste (measured): a line over 1,000
  // characters is "[Pasted text #1 N chars]", 16 or more lines "[... +K lines]".
  const collapsed = (text) => {
    const count = text.split('\n').length;
    if (!collapse) return null;
    if (count >= 16) return `[Pasted text #1 +${count} lines]`;
    return count === 1 && [...text].length > 1000 ? `[Pasted text #1 ${[...text].length} chars]` : null;
  };
  h.deps.readPane = async () => {
    state.reads += 1;
    if (state.dialog) return fixture(state.dialog);
    const shown = hidden > 0 ? '' : draft;
    if (hidden > 0) hidden -= 1;
    const above = echoed.map((text) => `${SHORT_RULE}\n${boxRows(text)}\n\n  OK\n`).join('\n');
    const spinner = state.working ? '⢿  Generating...\n' : '';
    const queueRows = queued.map((text, i) => `▸ ${text.split('\n')[0]}${text.includes('\n') ? '...' : ''}${i === queued.length - 1 ? ' (alt+m to send immediately)' : ''}\n`).join('');
    const inBox = shown ? (collapsed(shown) ? `> ${collapsed(shown)}` : boxRows(shown)) : (placeholder ? `> ${PLACEHOLDER}` : '>');
    const bottom = status === 'tee' ? `probe-status ${state.working ? 'working' : 'idle'}`
      : `${queued.length ? '  Press up to edit queued messages' : state.working ? 'esc to cancel' : '? for shortcuts'}${' '.repeat(80)}auto · Gemini 4 Hydrogen · low`;
    return `${BANNER}\n${above}${spinner}${queueRows}${RULE}\n${inBox}\n${RULE}\n${bottom}`;
  };
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = sendInput(paneId, text);
    // The survey takes every key; 0 (Skip) closes it, unless this one is stuck.
    if (state.dialog === SURVEY) {
      typings.push(text);
      if (text === '0' && survey !== 'stuck') state.dialog = null;
      return result;
    }
    if (text === '\r') {
      if (swallowed < swallowEnters) { swallowed += 1; } else if (draft.trim() && queueing) {
        queued.push(draft);
        if (onQueued) onQueued(draft);
        draft = '';
      } else if (draft.trim()) { echoed.push(draft); draft = ''; }
      return result;
    }
    typings.push(text);
    if (dropped < dropTypings) { dropped += 1; return result; }
    draft += text.replace(/\x1b\[20[01]~/g, '');
    hidden = lateDraw;
    if (dialogOnTyping) state.dialog = dialogOnTyping;
    return result;
  };
  Object.defineProperty(state, 'draft', { get: () => draft, set: (value) => { draft = value; }, enumerable: true });
  return Object.assign(state, { echoed, typings, queued });
}

const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
const typedKeys = (h) => h.sent.slice();
const enters = (h) => h.sent.filter((text) => text === '\r').length;
const refused = async (promise, code) => {
  await assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });
};

test('a one-line message is typed once, Enter is pressed once the box shows it, and the box letting go is "taken"', async () => {
  const h = makeHarness();
  const pane = geminiPane(h);
  const s = createSessionSend(h.deps);
  const result = await s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'Reply with just OK. proof-1', pane: target });
  assert.equal(result.ok, true);
  assert.deepEqual(typedKeys(h), ['Reply with just OK. proof-1', '\r']);
  assert.deepEqual(pane.echoed, ['Reply with just OK. proof-1']);
});

test('a multi-line message goes as ONE bracketed paste, then one Enter', async () => {
  const h = makeHarness();
  const pane = geminiPane(h);
  const s = createSessionSend(h.deps);
  await s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'first line\nsecond line\n\nfourth', pane: target });
  assert.deepEqual(typedKeys(h), ['\x1b[200~first line\nsecond line\n\nfourth\x1b[201~', '\r']);
  assert.equal(pane.echoed.length, 1);
});

test('a Gemini window never gets the Claude or Codex treatment: no clipboard, no spare image chords, and the pane\'s own label in every message', async () => {
  const h = makeHarness();
  geminiPane(h, { dialog: 'agy-1.5.14-first-run-colour-scheme-120.txt' });
  const s = createSessionSend(h.deps);
  await assert.rejects(s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'hello', pane: target }), /Gemini/);
  assert.deepEqual(typedKeys(h), []);
});

test('"?" "!" "@" "#" first characters go as a paste (a typed "?" on an empty box opens the help panel)', async () => {
  for (const text of ['? what does this do', '!ls', '@file notes', '#tag']) {
    const h = makeHarness();
    geminiPane(h);
    const s = createSessionSend(h.deps);
    await s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text, pane: target });
    assert.deepEqual(typedKeys(h), [`\x1b[200~${text}\x1b[201~`, '\r'], text);
  }
});

test('a swallowed Enter is pressed again while the message still sits in the box, at most twice', async () => {
  const h = makeHarness();
  const pane = geminiPane(h, { swallowEnters: 1 });
  const s = createSessionSend(h.deps);
  await s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'swallowed once', pane: target });
  assert.deepEqual(typedKeys(h), ['swallowed once', '\r', '\r']);
  assert.deepEqual(pane.echoed, ['swallowed once']);

  const two = makeHarness();
  geminiPane(two, { swallowEnters: 2 });
  await createSessionSend(two.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'swallowed twice', pane: target });
  assert.equal(enters(two), 3);
});

test('an Enter agy never takes is the honest GEMINI_NOT_SUBMITTED after the spares, never "sent"', async () => {
  const h = makeHarness();
  geminiPane(h, { swallowEnters: 99 });
  const s = createSessionSend(h.deps);
  await refused(s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'never taken', pane: target }), 'GEMINI_NOT_SUBMITTED');
  assert.equal(enters(h), 3, 'one Enter and two spares, no more');
});

test('typing that agy dropped (its first second) presses NO Enter, and the resend does not type it twice if it shows up', async () => {
  const h = makeHarness();
  const pane = geminiPane(h, { dropTypings: 1 });
  const s = createSessionSend(h.deps);
  await refused(s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'dropped once', pane: target }), 'PROMPT_NEVER_HELD');
  assert.equal(enters(h), 0, 'no Enter over a box that never showed the text');
  // The text arrives late in the box: the next send presses Enter for it and types nothing.
  h.sent.length = 0;
  pane.typings.length = 0;
  pane.state = null;
  const late = makeHarness();
  const latePane = geminiPane(late, { prefill: 'dropped once' });
  await createSessionSend(late.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'dropped once', pane: target });
  assert.deepEqual(typedKeys(late), ['\r'], 'Enter only: the box already holds exactly this message');
  assert.deepEqual(latePane.echoed, ['dropped once']);
});

test('a box that holds other text is never typed behind (Enter would send both)', async () => {
  const h = makeHarness();
  const pane = geminiPane(h, { prefill: 'half a thought from the terminal' });
  const s = createSessionSend(h.deps);
  await assert.rejects(s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'my message', pane: target }),
    (error) => error.code === 'GEMINI_BOX_BUSY' && /half a thought/.test(error.message));
  assert.deepEqual(typedKeys(h), []);
  assert.equal(pane.draft, 'half a thought from the terminal');
});

test('a permission question owns the keys: nothing is typed, and Harbor says where to answer it', async () => {
  const h = makeHarness();
  geminiPane(h, { dialog: 'agy-1.5.14-permission-prompt-120.txt' });
  const s = createSessionSend(h.deps);
  await assert.rejects(s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: '1', pane: target }),
    (error) => error.code === 'GEMINI_NEEDS_ANSWER' && /Gemini is waiting on a question/.test(error.message) && /panel in this window/.test(error.message));
  assert.deepEqual(typedKeys(h), [], 'a typed "1" would have approved the command');
});

test('the first-run colour scheme and Terms screens are the person\'s consent: refused, never answered', async () => {
  for (const name of ['agy-1.5.14-first-run-colour-scheme-120.txt', 'agy-1.5.14-first-run-terms-120.txt']) {
    const h = makeHarness();
    geminiPane(h, { dialog: name });
    const s = createSessionSend(h.deps);
    await assert.rejects(s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'hello', pane: target }),
      (error) => error.code === 'GEMINI_FIRST_RUN' && /first-run/.test(error.message) && /Terms of Service/.test(error.message) && /setup card in this window/.test(error.message));
    assert.deepEqual(typedKeys(h), [], name);
  }
});

test('the trust dialog is refused too, with its own wording', async () => {
  const h = makeHarness();
  geminiPane(h, { dialog: 'agy-1.5.14-trust-dialog-120.txt' });
  await assert.rejects(createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'hello', pane: target }),
    (error) => error.code === 'GEMINI_NEEDS_ANSWER' && /trust this folder/.test(error.message));
  assert.deepEqual(typedKeys(h), []);
});

test('a question that appears while Harbor is typing gets no Enter', async () => {
  const h = makeHarness();
  geminiPane(h, { dialogOnTyping: 'agy-1.5.14-permission-prompt-120.txt' });
  const s = createSessionSend(h.deps);
  await assert.rejects(s.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'a message', pane: target }),
    (error) => error.code === 'GEMINI_NEEDS_ANSWER' && /while Harbor was typing/.test(error.message));
  assert.equal(enters(h), 0);
});

test('the feedback survey is skipped with one 0, then the message is typed and sent (old code: refused with no prompt box)', async () => {
  const h = makeHarness();
  const pane = geminiPane(h, { survey: 'skip' });
  const result = await createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'how is that liquid glass?', pane: target });
  assert.equal(result.ok, true);
  assert.deepEqual(typedKeys(h), ['0', 'how is that liquid glass?', '\r'], 'one 0 for Skip, then the message, then Enter');
  assert.deepEqual(pane.echoed, ['how is that liquid glass?']);
});

test('a survey that does not close on 0 gets no second key and no message', async () => {
  const h = makeHarness();
  geminiPane(h, { survey: 'stuck' });
  await assert.rejects(createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'my message', pane: target }),
    (error) => error.code === 'GEMINI_SURVEY' && /feedback survey/.test(error.message) && /Your text is kept/.test(error.message));
  assert.deepEqual(typedKeys(h), ['0']);
});

test('a digit message is never typed into the survey: Skip comes first, so "1" reaches the box, not the Good answer', async () => {
  const h = makeHarness();
  const pane = geminiPane(h, { survey: 'skip' });
  await createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: '1', pane: target });
  assert.deepEqual(typedKeys(h), ['0', '1', '\r']);
  assert.deepEqual(pane.echoed, ['1']);
});

test('the status tee: a fresh pending permission refuses even when the screen shows a box; stale or absent does not', async () => {
  const session = '4444aaaa-4444-4444-8444-444444444444';
  const h = makeHarness();
  geminiPane(h);
  writeTee(h.deps.contextDir, session, { conversation_id: session, tool_confirmation_pending: true, agent_state: 'tool_use', writtenAt: new Date().toISOString() });
  await assert.rejects(createSessionSend(h.deps).send({ sessionId: session, provider: 'gemini', text: 'hello', pane: target }),
    (error) => error.code === 'GEMINI_NEEDS_ANSWER');
  assert.deepEqual(typedKeys(h), []);
  // A stale reading (agy died, or the file is from an earlier run) never blocks.
  const stale = makeHarness();
  geminiPane(stale);
  writeTee(stale.deps.contextDir, session, { conversation_id: session, tool_confirmation_pending: true, writtenAt: new Date(Date.now() - 60_000).toISOString() });
  await createSessionSend(stale.deps).send({ sessionId: session, provider: 'gemini', text: 'hello', pane: target });
  assert.deepEqual(typedKeys(stale), ['hello', '\r']);
  // And not-pending, or no tee at all, is the ordinary send.
  const calm = makeHarness();
  geminiPane(calm);
  writeTee(calm.deps.contextDir, session, { conversation_id: session, tool_confirmation_pending: false, agent_state: 'idle', writtenAt: new Date().toISOString() });
  await createSessionSend(calm.deps).send({ sessionId: session, provider: 'gemini', text: 'hello', pane: target });
  assert.deepEqual(typedKeys(calm), ['hello', '\r']);
});

test('a working turn takes the message (agy queues it): typed, shown, Enter, taken', async () => {
  const h = makeHarness();
  const pane = geminiPane(h, { working: true });
  await createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'while you work', pane: target });
  assert.deepEqual(typedKeys(h), ['while you work', '\r']);
  assert.deepEqual(pane.echoed, ['while you work']);
});

test('a custom statusLine replaces the status row, and the send is the same', async () => {
  const h = makeHarness();
  const pane = geminiPane(h, { status: 'tee', placeholder: false });
  await createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'with a tee line', pane: target });
  assert.deepEqual(pane.echoed, ['with a tee line']);
});

test('a message that takes a while to draw is waited for, not typed again', async () => {
  const h = makeHarness();
  const pane = geminiPane(h, { lateDraw: 25 });
  await createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'drawn late', pane: target });
  assert.deepEqual(typedKeys(h), ['drawn late', '\r']);
  assert.deepEqual(pane.echoed, ['drawn late']);
});

test('/model, /effort and /logout are never typed into a Gemini window (agy persists them into the profile)', async () => {
  for (const command of ['/model gemini-4-neon', '/effort high', '/logout', '/MODEL']) {
    const h = makeHarness();
    geminiPane(h);
    await refused(createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: command, pane: target }), 'GEMINI_COMMAND_REFUSED');
    assert.deepEqual(typedKeys(h), [], command);
  }
  // Another command is typed raw with one Enter and no spare (its menu would take it).
  const h = makeHarness();
  geminiPane(h, { swallowEnters: 99 });
  await createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: '/context', pane: target });
  assert.deepEqual(typedKeys(h), ['/context', '\r']);
  // A Claude or Codex pane still gets /effort, as before.
  const claude = makeHarness();
  claude.deps.readPane = async () => `${'─'.repeat(40)}\n❯\n${'─'.repeat(40)}\n  status`;
  await createSessionSend(claude.deps).send({ sessionId: 'pane:pane-1', provider: 'claude', text: '/effort high', pane: target }).catch(() => {});
  assert.ok(claude.sent.length > 0, 'the Claude path is untouched');
});

test('pictures go as a path line in the message and are confirmed by that text', async () => {
  const h = makeHarness();
  h.deps.imageFileReady = async () => true;
  const pane = geminiPane(h);
  await createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'what is this?', images: ['C:\\work\\shot.png'], pane: target });
  assert.deepEqual(typedKeys(h), ['\x1b[200~Image: C:\\work\\shot.png\nwhat is this?\x1b[201~', '\r']);
  assert.equal(pane.echoed.length, 1);
  const missing = makeHarness();
  missing.deps.imageFileReady = async () => false;
  geminiPane(missing);
  await refused(createSessionSend(missing.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'x', images: ['C:\\gone.png'], pane: target }), 'IMAGE_MISSING');
  assert.deepEqual(typedKeys(missing), []);
});

test('an Enter whose result Harbor cannot see: a provisional pane says so, a known conversation is checked in its transcript', async () => {
  // The box holds OTHER text after the Enter (something redrew): no further keys.
  const odd = makeHarness();
  const pane = geminiPane(odd);
  const original = odd.deps.terminalBridge.sendInput;
  odd.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = original(paneId, text);
    if (text === '\r') pane.draft = 'something else drawn after the Enter';
    return result;
  };
  await refused(createSessionSend(odd.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: 'unclear outcome', pane: target }), 'GEMINI_UNCONFIRMED');
  assert.equal(enters(odd), 1, 'no spare Enter into a box that holds other text');

  const known = makeHarness();
  const knownPane = geminiPane(known);
  const logs = path.join(tempDir('own-transcript'), 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const file = path.join(logs, 'transcript_full.jsonl');
  fs.writeFileSync(file, '');
  known.deps.getSessionMeta = async () => ({ cwd: 'C:\\work\\proof', path: file, provider: 'gemini' });
  const original2 = known.deps.terminalBridge.sendInput;
  known.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = original2(paneId, text);
    if (text === '\r') {
      knownPane.draft = 'x';
      fs.appendFileSync(file, `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\nunclear outcome\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nt\n</ADDITIONAL_METADATA>' })}\n`);
    }
    return result;
  };
  const s = createSessionSend(known.deps);
  const statuses = [];
  const settled = new Promise((resolve) => s.emitter.on('status', (event) => {
    statuses.push([event.phase, event.detail]);
    if (event.phase === 'sent' || event.phase === 'error') resolve(event);
  }));
  const result = await s.send({ sessionId: ID_A, provider: 'gemini', text: 'unclear outcome', pane: target });
  assert.equal(result.delivery, 'confirming');
  assert.deepEqual(statuses[1], ['sending', 'checking that Gemini took it']);
  // The transcript's own USER_INPUT step settles it: sent, not an error.
  assert.equal((await settled).phase, 'sent');
});

const bigLine = `Reply with just OK. ${'the quick brown fox jumps over the lazy dog. '.repeat(40)}END`;
const manyLines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}: the quick brown fox`).join('\n');

test('geminiPasteFits: a placeholder fits a message of about its size, and says nothing about which text it is', { skip: !NEW_CODE }, () => {
  const { geminiPasteFits } = send;
  assert.equal(geminiPasteFits({ n: 1, chars: 1871, lines: null }, 'x'.repeat(1853)), true, 'a 1,853-character line was drawn as 1,871');
  assert.equal(geminiPasteFits({ n: 1, chars: 1001, lines: null }, 'x'.repeat(1001)), true);
  assert.equal(geminiPasteFits({ n: 1, chars: 1500, lines: null }, 'short'), false);
  assert.equal(geminiPasteFits({ n: 1, chars: 100, lines: null }, 'x'.repeat(1500)), false);
  assert.equal(geminiPasteFits({ n: 1, chars: null, lines: 25 }, manyLines), true);
  assert.equal(geminiPasteFits({ n: 1, chars: null, lines: 26 }, manyLines), true, 'a swallowed Enter may add a row');
  assert.equal(geminiPasteFits({ n: 1, chars: null, lines: 40 }, manyLines), false);
  assert.equal(geminiPasteFits(null, 'x'), false);
  assert.equal(geminiPasteFits({ n: 1, chars: 5, lines: null }, ''), false);
});

test('a box that holds one paste placeholder reads as "placeholder" for a message of that size and "other" for any other', { skip: !NEW_CODE }, () => {
  const screen = fixture('agy-1.5.14-draft-paste-chars-120.txt');
  assert.deepEqual(geminiPromptBox(screen).paste, { n: 1, chars: 1890, lines: null });
  assert.equal(geminiBoxState(screen, { text: 'x'.repeat(1890) }), 'placeholder');
  assert.equal(geminiBoxState(screen, { text: 'a short message' }), 'other', 'it cannot be this message');
  const lines = fixture('agy-1.5.14-draft-paste-lines-120.txt');
  assert.deepEqual(geminiPromptBox(lines).paste, { n: 1, chars: null, lines: 25 });
  assert.equal(geminiBoxState(lines, { text: manyLines }), 'placeholder');
  assert.equal(geminiBoxState(lines, { text: 'one line' }), 'other');
  // Typed text in front of, or a second placeholder beside, the placeholder is no placeholder box.
  assert.equal(geminiPromptBox(screen.replace('> [Pasted text #1 1890 chars]', '> hi [Pasted text #1 1890 chars]')).paste, null);
  assert.equal(geminiPromptBox(screen.replace('> [Pasted text #1 1890 chars]', '> [Pasted text #1 1890 chars] [Pasted text #2 +20 lines]')).paste, null);
  assert.equal(send.describeGeminiDraft('[Pasted text #1 1890 chars]'), 'a pasted block of 1,890 characters');
  assert.equal(send.describeGeminiDraft('[Pasted text #1 +25 lines]'), 'a pasted block of 25 lines');
});

test('a message agy draws as a paste placeholder is typed as one paste, Enter pressed once its placeholder shows, and taken', async () => {
  for (const text of [bigLine, manyLines]) {
    const h = makeHarness();
    const pane = geminiPane(h);
    await createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text, pane: target });
    assert.deepEqual(typedKeys(h), [`\x1b[200~${text}\x1b[201~`, '\r']);
    assert.deepEqual(pane.echoed, [text]);
  }
});

test('a placeholder someone else left is never typed behind, and never submitted as this message', async () => {
  const h = makeHarness();
  geminiPane(h, { prefill: bigLine.replace('OK', 'NO').slice(0, bigLine.length) });
  await assert.rejects(createSessionSend(h.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: bigLine, pane: target }),
    (error) => error.code === 'GEMINI_BOX_BUSY' && /a pasted block of [\d,]+ characters/.test(error.message));
  assert.deepEqual(typedKeys(h), [], 'the placeholder fits this message in size, so only Harbor\'s own record could make it this send\'s');
});

test('Harbor\'s own paste that its Enter never took is pressed again on a resend, not typed twice; a restart forgets it', async () => {
  const h = makeHarness();
  const pane = geminiPane(h, { swallowEnters: 3 });
  const engine = createSessionSend(h.deps);
  await refused(engine.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: manyLines, pane: target }), 'GEMINI_NOT_SUBMITTED');
  assert.equal(enters(h), 3);
  h.sent.length = 0;
  await engine.send({ sessionId: 'pane:pane-1', provider: 'gemini', text: manyLines, pane: target });
  assert.deepEqual(typedKeys(h), ['\r'], 'Enter only: the box still holds this send\'s own paste');
  assert.deepEqual(pane.echoed, [manyLines]);
  // A Harbor that restarted has no record, so the same placeholder is somebody else's.
  const restarted = makeHarness();
  geminiPane(restarted, { prefill: manyLines });
  await refused(createSessionSend(restarted.deps).send({ sessionId: 'pane:pane-1', provider: 'gemini', text: manyLines, pane: target }), 'GEMINI_BOX_BUSY');
  assert.deepEqual(typedKeys(restarted), []);
});

test('a Gemini permission menu is not read as a Claude menu: the window gets the generic answer panel, not a card that steers by arrow keys', async () => {
  const h = makeHarness();
  geminiPane(h, { dialog: 'agy-1.5.14-permission-prompt-120.txt' });
  const menu = await createSessionSend(h.deps).getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  // Old code: parseMenu returned a menu with options 2 to 4 (agy's pointer row "> 1." is not Claude's pointer).
  assert.equal(menu?.fallback, true, JSON.stringify(menu)?.slice(0, 160));
  assert.equal(menu.options, undefined);
  assert.deepEqual(typedKeys(h), [], 'reading a dialog presses nothing');
});

test('geminiDialogOwnsScreen: agy\'s dialogs yes, its idle screens no, and Claude quoting the words above its own composer no', { skip: !NEW_CODE }, () => {
  const { geminiDialogOwnsScreen } = send;
  for (const name of ['permission-prompt', 'trust-dialog', 'first-run-terms', 'first-run-colour-scheme']) assert.equal(geminiDialogOwnsScreen(fixture(`agy-1.5.14-${name}-120.txt`)), true, name);
  for (const name of ['idle-empty', 'working', 'after-reply', 'draft-two-lines', 'slash-menu']) assert.equal(geminiDialogOwnsScreen(fixture(`agy-1.5.14-${name}-120.txt`)), false, name);
  assert.equal(geminiDialogOwnsScreen(`Run this command?\n> 1. Yes, run command\n${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  status`), false);
});

test('a Gemini pane at a dead shell prompt is a dead session, not a place to type', async () => {
  const h = makeHarness();
  h.deps.readPane = async () => 'agy exited\nPS C:\\work\\proof>\n$';
  h.deps.getSessionMeta = async () => ({ cwd: 'C:\\work\\proof', provider: 'gemini' });
  h.deps.launchActions = { resumeProviderSession: async () => { throw new Error('stop: resume attempted'); } };
  const s = createSessionSend(h.deps);
  await assert.rejects(s.send({ sessionId: ID_A, provider: 'gemini', text: 'hello', pane: target }), /resume attempted/);
  assert.deepEqual(typedKeys(h), [], 'the shell never saw the text');
});
