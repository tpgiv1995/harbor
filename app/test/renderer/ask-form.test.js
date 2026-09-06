'use strict';
// The question form's model (2026-09-05). The rules Pat's report demanded:
// a note never changes whether a question is answered, Submit is never a dead
// button, free text is an answer, skipping is allowed, and the payload is
// exactly the CLI's own `answers` + `annotations` shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const form = require('../../src/renderer/stage/ask-form.cjs');

const QUESTIONS = [
  { index: 0, question: 'Which visual direction?', header: 'Look & feel', multiSelect: false, options: [
    { index: 0, label: 'Refined SaaS', description: 'soft', preview: '┌ mock ┐' },
    { index: 1, label: 'Bold command center', description: 'loud', preview: null },
    { index: 2, label: 'Dark cockpit', description: 'dark', preview: '┌ dark ┐' },
  ] },
  { index: 1, question: 'Which charts? (pick any)', header: 'Analytics', multiSelect: true, options: [
    { index: 0, label: 'Burndown', description: '', preview: null },
    { index: 1, label: 'Coverage', description: '', preview: null },
    { index: 2, label: 'Top carriers', description: '', preview: null },
  ] },
  { index: 2, question: 'Which QOL first?', header: 'QOL', multiSelect: false, options: [
    { index: 0, label: 'Ctrl-K palette', description: '', preview: null },
    { index: 1, label: 'Saved views', description: '', preview: null },
  ] },
];

test('a fresh form is incomplete and names every missing question', () => {
  const state = form.initialForm(QUESTIONS);
  assert.deepEqual(form.status(QUESTIONS, state), { complete: false, missing: [0, 1, 2], answered: 0, skipped: 0, total: 3 });
});

test('a note is kept and NEVER counts as an answer (the 2026-09-04 report)', () => {
  let state = form.initialForm(QUESTIONS);
  state = form.reduce(state, QUESTIONS, { type: 'note', q: 0, value: 'sleek, light mode, fancy buttons' });
  assert.equal(form.status(QUESTIONS, state).missing.includes(0), true, 'a note alone leaves the question unanswered');
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 0, option: 0 });
  assert.equal(form.status(QUESTIONS, state).missing.includes(0), false);
  assert.equal(form.entryFor(state, 0).note, 'sleek, light mode, fancy buttons', 'the note survived the pick');
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 0, option: 2 });
  assert.equal(form.entryFor(state, 0).note, 'sleek, light mode, fancy buttons', 'and a re-pick');
});

test('single-select replaces, multi-select toggles, digits pick within the focused question', () => {
  let state = form.initialForm(QUESTIONS);
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 0, option: 1 });
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 0, option: 2 });
  assert.deepEqual(form.entryFor(state, 0).picks, [2]);
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 1, option: 2 });
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 1, option: 0 });
  assert.deepEqual(form.entryFor(state, 1).picks, [0, 2]);
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 1, option: 2 });
  assert.deepEqual(form.entryFor(state, 1).picks, [0]);
  state = form.reduce(state, QUESTIONS, { type: 'focus', q: 2 });
  assert.deepEqual(form.keyAction({ key: '2' }, QUESTIONS, state), { type: 'pick', q: 2, option: 1 });
  assert.equal(form.keyAction({ key: '9' }, QUESTIONS, state), null, 'a digit with no option is nothing');
  assert.equal(form.keyAction({ key: '2' }, QUESTIONS, state, { inTextField: true }), null, 'digits typed into a field are text');
});

test('free text is an answer on its own for single and multi', () => {
  let state = form.initialForm(QUESTIONS);
  state = form.reduce(state, QUESTIONS, { type: 'text', q: 0, value: 'Something in between' });
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 1, option: 1 });
  state = form.reduce(state, QUESTIONS, { type: 'text', q: 1, value: 'a data-health score' });
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 2, option: 0 });
  const { answers } = form.toPayload(QUESTIONS, state);
  assert.equal(answers['Which visual direction?'], 'Something in between');
  assert.equal(answers['Which charts? (pick any)'], 'Coverage, a data-health score');
  assert.equal(answers['Which QOL first?'], 'Ctrl-K palette');
});

test('Submit is never dead: incomplete asks to go to the first missing question, complete submits', () => {
  let state = form.initialForm(QUESTIONS);
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 0, option: 0 });
  assert.deepEqual(form.keyAction({ key: 'Enter' }, QUESTIONS, state), { type: 'goto-missing' });
  assert.deepEqual(form.status(QUESTIONS, state).missing, [1, 2]);
  state = form.reduce(state, QUESTIONS, { type: 'skip', q: 1 });
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 2, option: 1 });
  assert.equal(form.status(QUESTIONS, state).complete, true);
  assert.deepEqual(form.keyAction({ key: 'Enter' }, QUESTIONS, state), { type: 'submit' });
});

test('the payload is the CLI shape: answers by question text, notes as annotations, skipped questions omitted', () => {
  let state = form.initialForm(QUESTIONS);
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 0, option: 0 });
  state = form.reduce(state, QUESTIONS, { type: 'note', q: 0, value: '  light mode please  ' });
  state = form.reduce(state, QUESTIONS, { type: 'skip', q: 1 });
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 2, option: 1 });
  state = form.reduce(state, QUESTIONS, { type: 'note', q: 2, value: '' });
  const payload = form.toPayload(QUESTIONS, state);
  assert.deepEqual(payload.answers, { 'Which visual direction?': 'Refined SaaS', 'Which QOL first?': 'Saved views' });
  assert.deepEqual(payload.annotations, { 'Which visual direction?': { notes: 'light mode please', preview: '┌ mock ┐' } });
});

test('skip clears picks and text, unskip restores an unanswered question, and both keep the note', () => {
  let state = form.initialForm(QUESTIONS);
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 0, option: 1 });
  state = form.reduce(state, QUESTIONS, { type: 'note', q: 0, value: 'n' });
  state = form.reduce(state, QUESTIONS, { type: 'skip', q: 0 });
  assert.deepEqual(form.entryFor(state, 0).picks, []);
  assert.equal(form.entryFor(state, 0).note, 'n');
  assert.equal(form.status(QUESTIONS, state).skipped, 1);
  state = form.reduce(state, QUESTIONS, { type: 'unskip', q: 0 });
  assert.equal(form.status(QUESTIONS, state).missing.includes(0), true);
});

test('previewFor prefers the highlighted option, then the pick, then the first option with a preview', () => {
  const state = form.reduce(form.initialForm(QUESTIONS), QUESTIONS, { type: 'pick', q: 0, option: 2 });
  assert.deepEqual(form.previewFor(QUESTIONS[0], form.entryFor(state, 0), 0), { option: 0, preview: '┌ mock ┐' });
  assert.deepEqual(form.previewFor(QUESTIONS[0], form.entryFor(state, 0), null), { option: 2, preview: '┌ dark ┐' });
  assert.deepEqual(form.previewFor(QUESTIONS[0], form.initialForm(QUESTIONS).byIndex[0], 1), { option: 0, preview: '┌ mock ┐' }, 'a highlighted option without a preview falls through');
  assert.equal(form.previewFor(QUESTIONS[1], form.initialForm(QUESTIONS).byIndex[1], null), null);
});

// Review round 1 (2026-09-05) found two ways a user's words still vanished.
test('a note on a SKIPPED question still travels as its annotation, and notesText collects every note', () => {
  let state = form.initialForm(QUESTIONS);
  state = form.reduce(state, QUESTIONS, { type: 'note', q: 1, value: 'charts later, ship the palette first' });
  state = form.reduce(state, QUESTIONS, { type: 'skip', q: 1 });
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 0, option: 0 });
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 2, option: 0 });
  const payload = form.toPayload(QUESTIONS, state);
  assert.equal('Which charts? (pick any)' in payload.answers, false, 'skipped stays unanswered');
  assert.deepEqual(payload.annotations['Which charts? (pick any)'], { notes: 'charts later, ship the palette first' }, 'but its note is delivered');
  assert.equal(form.notesText(QUESTIONS, state), 'Analytics: charts later, ship the palette first');
  // Everything skipped, notes only: the payload has no answers and the caller
  // sends the notes as the reply; nothing typed is lost either way.
  let only = form.initialForm(QUESTIONS);
  for (let i = 0; i < 3; i += 1) only = form.reduce(only, QUESTIONS, { type: 'skip', q: i });
  only = form.reduce(only, QUESTIONS, { type: 'note', q: 0, value: 'none of these' });
  assert.deepEqual(Object.keys(form.toPayload(QUESTIONS, only).answers), []);
  assert.equal(form.notesText(QUESTIONS, only), 'Look & feel: none of these');
});

test('single-select: typed text and a pick are ONE choice, so the screen never lies about what is sent', () => {
  let state = form.initialForm(QUESTIONS);
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 0, option: 0 });
  state = form.reduce(state, QUESTIONS, { type: 'text', q: 0, value: 'x' });
  assert.deepEqual(form.entryFor(state, 0).picks, [], 'typing clears the lit option');
  assert.equal(form.toPayload(QUESTIONS, state).answers['Which visual direction?'], 'x');
  state = form.reduce(state, QUESTIONS, { type: 'pick', q: 0, option: 2 });
  assert.equal(form.entryFor(state, 0).text, '', 'picking clears the text');
  assert.equal(form.toPayload(QUESTIONS, state).answers['Which visual direction?'], 'Dark cockpit');
  // Multi-select keeps both: the text is an extra tick.
  let multi = form.reduce(form.initialForm(QUESTIONS), QUESTIONS, { type: 'pick', q: 1, option: 0 });
  multi = form.reduce(multi, QUESTIONS, { type: 'text', q: 1, value: 'a health score' });
  assert.deepEqual(form.entryFor(multi, 1).picks, [0]);
  assert.equal(form.toPayload(QUESTIONS, multi).answers['Which charts? (pick any)'], 'Burndown, a health score');
});

test('Tab and modified keys are never taken; Escape only leaves a field', () => {
  const state = form.initialForm(QUESTIONS);
  assert.equal(form.keyAction({ key: 'Tab' }, QUESTIONS, state), null);
  assert.equal(form.keyAction({ key: '1', ctrlKey: true }, QUESTIONS, state), null);
  assert.equal(form.keyAction({ key: 'Escape' }, QUESTIONS, state), null);
  assert.deepEqual(form.keyAction({ key: 'Escape' }, QUESTIONS, state, { inTextField: true }), { type: 'blur' });
});
