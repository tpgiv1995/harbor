'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// Import only the existing model: baseline must reach these assertions.
const form = require('../../src/renderer/stage/ask-form.cjs');
const questions = [
  { question: 'Which color?', options: [{ label: 'Blue' }] },
  { question: 'Which size?', options: [{ label: 'Small' }] },
];

test('ask form partial and empty payloads preserve notes and conservative Enter', () => {
  let state = form.initialForm(questions);
  state = form.reduce(state, questions, { type: 'note', q: 1, value: 'Use a ruler' });
  assert.deepEqual(form.toPayload(questions, state), { answers: {}, annotations: { 'Which size?': { notes: 'Use a ruler' } } });
  assert.deepEqual(form.keyAction({ key: 'Enter' }, questions, state), { type: 'goto-missing' });
  state = form.reduce(state, questions, { type: 'pick', q: 0, option: 0 });
  assert.deepEqual(form.toPayload(questions, state).answers, { 'Which color?': 'Blue' });
  assert.deepEqual(form.keyAction({ key: 'Enter' }, questions, state), { type: 'goto-missing' });
  state = form.reduce(state, questions, { type: 'pick', q: 1, option: 0 });
  assert.deepEqual(form.keyAction({ key: 'Enter' }, questions, state), { type: 'submit' });
});

test('ask form attachment append preserves intervening text and skipped-question notes', () => {
  let state = form.initialForm(questions);
  state = form.reduce(state, questions, { type: 'text', q: 0, value: 'Blue please' });
  state = form.reduce(state, questions, { type: 'append', q: 0, field: 'text', value: '"C:\\Toy Images\\blue.png"' });
  state = form.reduce(state, questions, { type: 'append', q: 1, field: 'note', value: 'C:\\toys.txt' });
  const payload = form.toPayload(questions, state);
  assert.equal(payload.answers['Which color?'], 'Blue please "C:\\Toy Images\\blue.png"');
  assert.equal(payload.annotations['Which size?'].notes, 'C:\\toys.txt');
  assert.equal(state.byIndex[1].noteOpen, true);
});
