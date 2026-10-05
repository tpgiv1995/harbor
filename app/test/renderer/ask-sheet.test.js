'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sheetModel = require('../../src/renderer/stage/ask-sheet.cjs');
const { parseMenu } = require('../../src/main/menu-parse.js');
const { mergeAsk } = require('../../src/main/ask-question.js');

const {
  TEXT_ROW, buildSheet, sheetIdentity, initialState, resync, findContinuedQuestion, reduce, isAnswered, isComplete, deliveryAnswers, sheetKeyAction, keyHints, answeredInTerminal,
} = sheetModel;

const fixture = (name) => fs.readFileSync(path.resolve(__dirname, '../fixtures/askuserquestion', name), 'utf8');

// The real two-question batch the probe drove on 2026-09-03, as the transcript
// records it.
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

const batchMenu = () => mergeAsk(parseMenu(fixture('real-batch-q1-2.1.258.txt')), ASK);
const key = (k, extra = {}) => ({ key: k, target: { tagName: 'DIV' }, ...extra });

test('a batch builds a staged sheet with every question laid out from the transcript', () => {
  const sheet = buildSheet(batchMenu());
  assert.equal(sheet.kind, 'ask');
  assert.equal(sheet.mode, 'staged');
  assert.equal(sheet.source, 'batch');
  assert.equal(sheet.questions.length, 2);
  assert.equal(sheet.currentIndex, 0);
  assert.deepEqual(sheet.questions.map((q) => q.header), ['Finish approach', 'Delivery']);
  // The question on screen carries the pty's rows: text at 4, chat at 5.
  assert.equal(sheet.questions[0].textIndex, 4);
  assert.equal(sheet.questions[0].chatIndex, 5);
  // The one not on screen is numbered the way the CLI numbers it.
  assert.equal(sheet.questions[1].textIndex, 4);
  assert.equal(sheet.questions[1].chatIndex, 5);
  assert.equal(sheet.questions[1].multiSelect, true);
  assert.equal(sheet.questions[0].options[0].recommended, true);
  assert.equal(sheet.questions[0].options[0].label, 'Reassemble + one BIH map');
});

test('a lone single-select question is an immediate sheet', () => {
  const menu = parseMenu(fixture('real-claude-120x60.txt'));
  const sheet = buildSheet(menu);
  assert.equal(sheet.mode, 'immediate');
  assert.equal(sheet.source, 'pty');
  assert.equal(sheet.questions.length, 1);
  assert.equal(sheet.questions[0].options.length, 3, 'the text row and Chat row are not options');
  assert.equal(sheet.questions[0].textIndex, 4);
  assert.equal(sheet.questions[0].chatIndex, 5);
  assert.equal(sheet.questions[0].highlighted, 1);
});

test('a permission prompt is an immediate sheet with no text row', () => {
  const menu = parseMenu([
    'Hook PreToolUse:Bash requires confirmation for this command:',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No',
    'Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n'));
  const sheet = buildSheet(menu);
  assert.equal(sheet.kind, 'permission');
  assert.equal(sheet.mode, 'immediate');
  assert.equal(sheet.questions[0].acceptsText, false);
  assert.equal(sheet.questions[0].chatIndex, null);
});

test('the review screen is its own sheet with the CLI\'s Submit and Cancel rows', () => {
  const menu = mergeAsk(parseMenu(fixture('real-batch-review-2.1.258.txt')), ASK);
  const sheet = buildSheet(menu);
  assert.equal(sheet.kind, 'review');
  assert.equal(sheet.submitIndex, 1);
  assert.equal(sheet.cancelIndex, 2);
  assert.deepEqual(sheet.headers.map((h) => [h.header, h.answered]), [['Finish approach', true], ['Delivery', true]]);
  assert.deepEqual(
    sheet.headers.map((h) => h.answer),
    ['Show me the cleaned census first', 'File + note to you, Just the file'],
    'the answers the CLI says it will submit ride the headers',
  );
});

test('the fallback panel and a missing menu build no sheet', () => {
  assert.equal(buildSheet(null), null);
  assert.equal(buildSheet({ fallback: true, screen: ['x'] }), null);
});

test('staged picks stay local, a single-select pick advances, and the sheet completes', () => {
  const sheet = buildSheet(batchMenu());
  let state = initialState(sheet);
  assert.equal(state.q, 0);
  assert.equal(state.row, 1, 'the highlight starts where the pty has its pointer');
  assert.equal(isComplete(sheet, state), false);
  assert.equal(deliveryAnswers(sheet, state), null, 'nothing half-made can be delivered');

  state = reduce(state, sheet, { type: 'pick', q: 0, index: 2, advance: true });
  assert.equal(isAnswered(sheet, state, 0), true);
  assert.equal(state.q, 1, 'a single-select pick moves on to the next unanswered question');

  state = reduce(state, sheet, { type: 'pick', q: 1, index: 1 });
  state = reduce(state, sheet, { type: 'pick', q: 1, index: 3 });
  assert.deepEqual(state.answers[1], { kind: 'multi', indexes: [1, 3], text: '' });
  state = reduce(state, sheet, { type: 'pick', q: 1, index: 3 });
  assert.deepEqual(state.answers[1], { kind: 'multi', indexes: [1], text: '' }, 'a second pick on a multi row unticks it');
  assert.equal(isComplete(sheet, state), true);
  assert.deepEqual(deliveryAnswers(sheet, state), [
    { question: 0, kind: 'select', index: 2 },
    { question: 1, kind: 'multi', indexes: [1] },
  ]);
});

test('a typed draft stages a text answer and an emptied draft withdraws it', () => {
  const sheet = buildSheet(batchMenu());
  let state = initialState(sheet);
  state = reduce(state, sheet, { type: 'draft', q: 0, text: 'my own plan' });
  assert.deepEqual(state.answers[0], { kind: 'text', text: 'my own plan' });
  state = reduce(state, sheet, { type: 'draft', q: 0, text: '   ' });
  assert.equal(state.answers[0], undefined);
});

test('ticks the pane already shows seed the sheet, never fewer than drawn', () => {
  const menu = mergeAsk(parseMenu(fixture('real-batch-two-answered-2.1.258.txt')), ASK);
  const sheet = buildSheet(menu);
  assert.equal(sheet.currentIndex, 1, 'the multi-select question is the one on screen');
  const state = initialState(sheet);
  assert.deepEqual(state.answers[1], { kind: 'multi', indexes: [1], text: '' });
});

test('the keyboard: arrows move a LOCAL highlight, digits pick, Enter picks then submits, no key reaches the pty', () => {
  const sheet = buildSheet(batchMenu());
  let state = initialState(sheet);
  assert.deepEqual(sheetKeyAction(key('ArrowDown'), sheet, state), { kind: 'move', dir: 1 });
  state = reduce(state, sheet, { type: 'move', dir: 1 });
  assert.equal(state.row, 2);
  assert.deepEqual(sheetKeyAction(key('ArrowRight'), sheet, state), { kind: 'goto', q: 1 });
  assert.deepEqual(sheetKeyAction(key('ArrowLeft'), sheet, state), { kind: 'goto', q: 0 }, 'clamped at the first question');
  assert.equal(sheetKeyAction(key('Tab'), sheet, state), null, 'Tab is ordinary focus movement, never a trap');
  assert.equal(sheetKeyAction(key('Tab', { shiftKey: true }), sheet, state), null);
  assert.deepEqual(sheetKeyAction(key('3'), sheet, state), { kind: 'pick', q: 0, index: 3, advance: true }, 'a digit picks and moves on, like a click');
  assert.equal(sheetKeyAction(key('7'), sheet, state), null, 'a digit with no option is ignored');
  // Enter on an unanswered sheet picks the highlighted row and advances.
  assert.deepEqual(sheetKeyAction(key('Enter'), sheet, state), { kind: 'pick', q: 0, index: 2, advance: true });
  state = reduce(state, sheet, { type: 'pick', q: 0, index: 2, advance: true });
  assert.deepEqual(sheetKeyAction(key(' '), sheet, state), { kind: 'pick', q: 1, index: 1 }, 'Space ticks the multi row');
  state = reduce(state, sheet, { type: 'pick', q: 1, index: 1 });
  // Enter on a complete sheet, on an answered question, submits.
  assert.deepEqual(sheetKeyAction(key('Enter'), sheet, state), { kind: 'submit' });
  assert.deepEqual(sheetKeyAction(key('Escape'), sheet, state), { kind: 'cancel' });
});

test('an immediate sheet answers on Enter and on a digit, and refuses an empty text row', () => {
  const sheet = buildSheet(parseMenu(fixture('real-claude-120x60.txt')));
  let state = initialState(sheet);
  assert.deepEqual(sheetKeyAction(key('Enter'), sheet, state), { kind: 'answer', index: 1 });
  assert.deepEqual(sheetKeyAction(key('2'), sheet, state), { kind: 'answer', index: 2 });
  assert.equal(sheetKeyAction(key('ArrowRight'), sheet, state), null, 'a lone question has nothing to switch to');
  assert.equal(sheetKeyAction(key(' '), sheet, state), null, 'Space never answers an immediate sheet by accident');
  state = reduce(state, sheet, { type: 'highlight', q: 0, row: TEXT_ROW });
  assert.equal(sheetKeyAction(key('Enter'), sheet, state).kind, 'blocked', 'an empty text row would decline every question');
  state = reduce(state, sheet, { type: 'draft', q: 0, text: 'both' });
  assert.deepEqual(sheetKeyAction(key('Enter'), sheet, state), { kind: 'answer-text' });
});

test('keys inside a text field belong to the field', () => {
  const sheet = buildSheet(batchMenu());
  const state = initialState(sheet);
  const input = { tagName: 'INPUT' };
  assert.equal(sheetKeyAction({ key: 'ArrowDown', target: input }, sheet, state), null);
  assert.equal(sheetKeyAction({ key: 'Enter', target: input }, sheet, state), null);
  assert.equal(sheetKeyAction({ key: '2', target: input }, sheet, state), null, 'digits typed into a field are text');
  assert.equal(sheetKeyAction({ key: 'Tab', target: input }, sheet, state), null, 'Tab leaves the field the ordinary way');
  assert.deepEqual(sheetKeyAction({ key: 'Escape', target: input }, sheet, state), { kind: 'blur' }, 'Escape in a field leaves the field; it never declines the batch from there');
});

test('a focused button keeps its own Enter and Space', () => {
  const sheet = buildSheet(batchMenu());
  const state = initialState(sheet);
  const button = { tagName: 'BUTTON' };
  assert.equal(sheetKeyAction({ key: 'Enter', target: button }, sheet, state), null);
  assert.equal(sheetKeyAction({ key: ' ', target: button }, sheet, state), null);
  assert.deepEqual(sheetKeyAction({ key: 'ArrowDown', target: button }, sheet, state), { kind: 'move', dir: 1 });
});

test('a focused OPTION ROW hands Enter and Space to the sheet, never to its own click', () => {
  // Roving focus parks the keyboard on the highlighted row's button. Driven in
  // the harness: Enter there toggled the row instead of submitting a complete
  // sheet, because the button's native click won.
  const sheet = buildSheet(batchMenu());
  const row = { tagName: 'BUTTON', dataset: { askRow: '2' }, getAttribute: (name) => (name === 'data-ask-row' ? '2' : null) };
  let state = reduce(initialState(sheet), sheet, { type: 'highlight', q: 0, row: 2 });
  assert.deepEqual(sheetKeyAction({ key: 'Enter', target: row }, sheet, state), { kind: 'pick', q: 0, index: 2, advance: true });
  assert.deepEqual(sheetKeyAction({ key: ' ', target: row }, sheet, state), { kind: 'pick', q: 0, index: 2 });
  state = reduce(state, sheet, { type: 'pick', q: 0, index: 2, advance: true });
  state = reduce(state, sheet, { type: 'pick', q: 1, index: 1 });
  assert.equal(isComplete(sheet, state), true);
  assert.deepEqual(sheetKeyAction({ key: 'Enter', target: row }, sheet, state), { kind: 'submit' }, 'a complete sheet submits from a focused row');
  const lone = buildSheet(parseMenu(fixture('real-claude-120x60.txt')));
  const loneState = initialState(lone);
  assert.deepEqual(sheetKeyAction({ key: 'Enter', target: row }, lone, loneState), { kind: 'answer', index: 1 });
  assert.deepEqual(sheetKeyAction({ key: ' ', target: row }, lone, loneState), { kind: 'ignore' }, 'Space on an immediate row is swallowed, so the native click cannot answer');
});

test('the review sheet answers Submit on Enter', () => {
  const sheet = buildSheet(mergeAsk(parseMenu(fixture('real-batch-review-2.1.258.txt')), ASK));
  const state = initialState(sheet);
  assert.deepEqual(sheetKeyAction(key('Enter'), sheet, state), { kind: 'answer', index: 1 });
});

test('an incomplete review offers no Submit, from the button or from Enter', () => {
  const menu = mergeAsk(parseMenu(fixture('real-batch-review-2.1.258.txt')), ASK);
  const incomplete = { ...menu, batch: { ...menu.batch, headers: menu.batch.headers.map((h, i) => (i ? { ...h, answered: false } : h)) } };
  const sheet = buildSheet(incomplete);
  assert.equal(sheet.complete, false);
  assert.equal(sheetKeyAction(key('Enter'), sheet, initialState(sheet)).kind, 'blocked');
  const complete = buildSheet(menu);
  assert.equal(complete.complete, true);
  assert.deepEqual(sheetKeyAction(key('Enter'), complete, initialState(complete)), { kind: 'answer', index: 1 });
});

test('text already typed on the free-text row is the sheet\'s draft, never one of its options', () => {
  const menu = parseMenu([
    ' ☐ Delivery',
    'How should I hand off the finished file? (pick any)',
    '  1. [✔] File + note to you',
    '  2. [ ] Just the file',
    '  3. [ ] Draft the note for someone',
    '❯ 4. [✔] keep provenance',
    '     Submit',
    '─'.repeat(120),
    '  5. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n'));
  const sheet = buildSheet(menu);
  const question = sheet.questions[0];
  assert.deepEqual(question.options.map((o) => o.label), ['File + note to you', 'Just the file', 'Draft the note for someone']);
  assert.equal(question.typedText, 'keep provenance');
  assert.equal(question.typedTicked, true);
  assert.equal(question.textIndex, 4);
  const state = initialState(sheet);
  assert.deepEqual(state.answers[0], { kind: 'multi', indexes: [1], text: 'keep provenance' });
  assert.equal(state.drafts[0], 'keep provenance');
  assert.equal(state.row, TEXT_ROW, 'the pointer was on the typed row');
});

test('the sheet identity follows the question set, not the poll', () => {
  const a = buildSheet(batchMenu());
  const b = buildSheet(mergeAsk(parseMenu(fixture('real-batch-one-answered-2.1.258.txt')), ASK));
  assert.equal(sheetIdentity(a), sheetIdentity(b), 'the same batch, a question later, is the same dialog');
  const c = buildSheet(parseMenu(fixture('real-claude-120x60.txt')));
  assert.notEqual(sheetIdentity(a), sheetIdentity(c));
  const relabelled = buildSheet(mergeAsk(
    parseMenu(fixture('real-batch-q1-2.1.258.txt')),
    ASK.map((q, i) => (i ? q : { ...q, options: [{ label: 'Something else' }, ...q.options.slice(1)] })),
  ));
  assert.notEqual(sheetIdentity(a), sheetIdentity(relabelled), 'the same wording with different choices is a different dialog');
});

test('a multi-select keeps its ticks and its typed row together, as the CLI does', () => {
  const sheet = buildSheet(batchMenu());
  let state = reduce(initialState(sheet), sheet, { type: 'pick', q: 1, index: 1 });
  state = reduce(state, sheet, { type: 'draft', q: 1, text: 'include provenance' });
  assert.deepEqual(state.answers[1], { kind: 'multi', indexes: [1], text: 'include provenance' });
  state = reduce(state, sheet, { type: 'pick', q: 1, index: 3 });
  assert.deepEqual(state.answers[1], { kind: 'multi', indexes: [1, 3], text: 'include provenance' }, 'a tick after typing keeps the text');
  state = reduce(state, sheet, { type: 'pick', q: 0, index: 2 });
  assert.deepEqual(deliveryAnswers(sheet, state)[1], { question: 1, kind: 'multi', indexes: [1, 3], text: 'include provenance' });
  state = reduce(state, sheet, { type: 'draft', q: 1, text: '' });
  assert.deepEqual(state.answers[1], { kind: 'multi', indexes: [1, 3], text: '' }, 'clearing the text keeps the ticks');
});

// ── resync: local input survives a re-represented dialog (2026-09-04) ──────
// The 700ms poll re-draws the SAME AskUserQuestion in different shapes as the
// transcript match comes and goes and the pty truncates labels. The old card
// hard-reset on every such change and deleted the user's typing; resync carries
// it forward. Crafted sheets keep these deterministic; one rides the real
// fixtures to prove the shape the parser actually produces.
const mkQ = (header, question, labels, { multi = false, text = true } = {}) => ({
  header,
  question,
  multiSelect: multi,
  options: labels.map((label, k) => ({ index: k + 1, label, description: '', recommended: false })),
  acceptsText: text,
  textIndex: text ? labels.length + 1 : null,
  textLabel: 'Type something',
  typedText: '',
  typedTicked: false,
  chatIndex: labels.length + 2,
  answered: null,
  current: false,
  highlighted: null,
});
const mkSheet = (questions, currentIndex = 0) => ({
  kind: 'ask',
  mode: questions.length > 1 || questions.some((q) => q.multiSelect) ? 'staged' : 'immediate',
  questions: questions.map((q, i) => ({ ...q, index: i, current: i === currentIndex })),
  currentIndex,
  source: 'batch',
  clipped: false,
  keys: {},
  notesKey: null,
});

test('resync keeps a free-form draft when the same dialog is redrawn with truncated labels', () => {
  const full = mkSheet([mkQ('Finish', 'How do you want me to produce the complete file?', ['Reassemble now', 'Show the census first'])]);
  const state = reduce(initialState(full), full, { type: 'draft', q: 0, text: 'my own answer' });
  assert.equal(state.drafts[0], 'my own answer');
  const truncated = mkSheet([mkQ('Finish', 'How do you want me to produce the complete file?', ['Reassemble n…', 'Show the cens…'])]);
  assert.notEqual(sheetIdentity(full), sheetIdentity(truncated), 'the label truncation changes identity, so the old reset would have fired');
  const after = resync(state, full, truncated);
  assert.equal(after.drafts[0], 'my own answer', 'the draft survives the re-representation');
  assert.equal(after.answers[0].text, 'my own answer');
});

test('resync keeps staged multi-select ticks across a redraw', () => {
  const a = mkSheet([mkQ('Delivery', 'How should I hand off the file?', ['File + note', 'Just the file', 'Draft the note'], { multi: true })]);
  let state = reduce(initialState(a), a, { type: 'pick', q: 0, index: 1 });
  state = reduce(state, a, { type: 'pick', q: 0, index: 3 });
  assert.deepEqual(state.answers[0].indexes, [1, 3]);
  const b = mkSheet([mkQ('Delivery', 'How should I hand off the file?', ['File + n…', 'Just the f…', 'Draft the n…'], { multi: true })]);
  const after = resync(state, a, b);
  assert.deepEqual(after.answers[0].indexes, [1, 3], 'the ticks survive the redraw');
});

test('resync drops an index the new option set no longer has', () => {
  const a = mkSheet([mkQ('Delivery', 'How should I hand off the file?', ['File + note', 'Just the file', 'Draft the note'], { multi: true })]);
  let state = reduce(initialState(a), a, { type: 'pick', q: 0, index: 3 });
  const shorter = mkSheet([mkQ('Delivery', 'How should I hand off the file?', ['File + note', 'Just the file'], { multi: true })]);
  const after = resync(state, a, shorter);
  assert.deepEqual(after.answers[0]?.indexes ?? [], [], 'a pick whose option is gone is dropped, not delivered');
});

test('resync does NOT carry a draft into a genuinely different dialog', () => {
  const a = mkSheet([mkQ('Finish', 'How do you want me to produce the file?', ['Reassemble', 'Census first'])]);
  const state = reduce(initialState(a), a, { type: 'draft', q: 0, text: 'my own answer' });
  const other = mkSheet([mkQ('Colour', 'Which heatmap colour range?', ['Warm', 'Cool'])]);
  const after = resync(state, a, other);
  assert.equal(after.drafts[0] || '', '', 'an unrelated question starts clean');
  assert.equal(after.answers[0], undefined);
});

test('resync on a transient null keeps the whole state untouched', () => {
  const a = mkSheet([mkQ('Finish', 'How to produce the file?', ['Reassemble', 'Census first'])]);
  const state = reduce(initialState(a), a, { type: 'draft', q: 0, text: 'half-typed' });
  assert.equal(resync(state, a, null), state, 'a poll that sees no dialog for a tick loses nothing');
});

test('resync keeps the current question when the batch downgrades to the single on-screen one', () => {
  const batch = mkSheet([
    mkQ('Finish', 'How do you want me to produce the complete file?', ['Reassemble', 'Census first']),
    mkQ('Delivery', 'How should I hand off the file?', ['File + note', 'Just the file'], { multi: true }),
  ]);
  let state = reduce(initialState(batch), batch, { type: 'draft', q: 0, text: 'custom finish' });
  state = reduce(state, batch, { type: 'pick', q: 1, index: 1 });
  const single = mkSheet([mkQ('Finish', 'How do you want me to produce the complete file?', ['Reassemb…', 'Census…'])]);
  const after = resync(state, batch, single);
  assert.equal(after.drafts[0], 'custom finish', 'the question the user was typing on is carried');
});

test('findContinuedQuestion matches by header and by truncated question, and refuses the unrelated', () => {
  const batch = mkSheet([
    mkQ('Finish', 'How do you want me to produce the complete file?', ['Reassemble', 'Census first']),
    mkQ('Delivery', 'How should I hand off the file?', ['File + note'], { multi: true }),
  ]);
  const single = mkSheet([mkQ('Finish', 'How do you want me to produce the c…', ['Reassemble'])]);
  assert.equal(findContinuedQuestion(batch, single, single.questions[0], 0), 0, 'the on-screen question matches its batch entry by header/prefix');
  const other = mkSheet([mkQ('Colour', 'Which heatmap colour range?', ['Warm'])]);
  assert.equal(findContinuedQuestion(batch, other, other.questions[0], 0), -1, 'an unrelated question corresponds to nothing');
});

test('resync carries the real pty downgrade of the fixture batch', () => {
  const batch = buildSheet(batchMenu());
  const state = reduce(initialState(batch), batch, { type: 'draft', q: 0, text: 'my own finish plan' });
  // the poll momentarily fails to match the transcript: only the single
  // on-screen question, drawn from the pty, reaches the card.
  const single = buildSheet(parseMenu(fixture('real-batch-q1-2.1.258.txt')));
  assert.equal(single.questions.length, 1);
  assert.notEqual(sheetIdentity(batch), sheetIdentity(single), 'the downgrade changes identity, so the old reset would have fired');
  const after = resync(state, batch, single);
  assert.equal(after.drafts[0], 'my own finish plan', 'the draft survives the real pty downgrade');
});

test('a question the strip marks answered counts as answered until a local pick overrides it', () => {
  const sheet = buildSheet(mergeAsk(parseMenu(fixture('real-batch-one-answered-2.1.258.txt')), ASK));
  let state = initialState(sheet);
  assert.equal(sheet.questions[0].answered, true);
  assert.equal(answeredInTerminal(sheet, state, 0), true);
  assert.equal(isAnswered(sheet, state, 0), true, 'question 1 was answered in the terminal');
  assert.equal(isComplete(sheet, state), false, 'question 2 is still open');
  state = reduce(state, sheet, { type: 'pick', q: 1, index: 2 });
  assert.equal(isComplete(sheet, state), true);
  assert.deepEqual(deliveryAnswers(sheet, state), [{ question: 1, kind: 'multi', indexes: [2] }], 'only the local answer is delivered');
  state = reduce(state, sheet, { type: 'pick', q: 0, index: 3 });
  assert.equal(answeredInTerminal(sheet, state, 0), false, 'a local pick overrides the terminal answer');
  assert.deepEqual(deliveryAnswers(sheet, state)[0], { question: 0, kind: 'select', index: 3 });
});

test('a complete sheet whose answers already live in the dialog still delivers only what is local', () => {
  const sheet = buildSheet(mergeAsk(parseMenu(fixture('real-batch-two-answered-2.1.258.txt')), ASK));
  const state = initialState(sheet);
  // Question 1 is ☒ in the strip; question 2 is ☒ and shows its tick, which
  // the initial state adopts as a local multi answer.
  assert.equal(isComplete(sheet, state), true);
  assert.deepEqual(deliveryAnswers(sheet, state), [{ question: 1, kind: 'multi', indexes: [1] }]);
});

test('the footer hints say only what the keys do', () => {
  const batch = buildSheet(batchMenu());
  let state = initialState(batch);
  assert.deepEqual(keyHints(batch, state).map(([k]) => k), ['← →', '↑ ↓', '1-9', 'Enter', 'Esc']);
  assert.deepEqual(keyHints(batch, state).find(([k]) => k === 'Enter'), ['Enter', 'pick']);
  state = reduce(state, batch, { type: 'goto', q: 1 });
  assert.ok(keyHints(batch, state).some(([k, m]) => k === 'Space' && m === 'tick'), 'a multi-select question advertises Space');
  const review = buildSheet(mergeAsk(parseMenu(fixture('real-batch-review-2.1.258.txt')), ASK));
  const reviewState = initialState(review);
  assert.deepEqual(keyHints(review, reviewState).map(([k]) => k), ['Enter', '1', '2', 'Esc']);
  assert.deepEqual(sheetKeyAction(key('2'), review, reviewState), { kind: 'answer', index: 2 }, 'and 2 really cancels');
  assert.equal(sheetKeyAction(key('3'), review, reviewState), null);
  const lone = buildSheet(parseMenu(fixture('real-claude-120x60.txt')));
  assert.ok(!keyHints(lone, initialState(lone)).some(([k]) => k === '← →'), 'a lone question has no question keys');
});
