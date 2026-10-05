'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMenu } = require('../../src/main/menu-parse.js');
const { mergeAsk } = require('../../src/main/ask-question.js');
const { fixture } = require('../support/model-switch-fixtures.js');
for (const width of [120, 38]) for (const kind of ['usage', 'paused', 'checking']) {
  test(`model switch ${kind} at ${width} columns preserves labels and cost explanation`, () => {
    const menu = parseMenu(fixture(kind, width));
    assert.equal(menu?.kind, 'model-switch');
    assert.equal(menu.options.length, kind === 'checking' ? 0 : 2);
    assert.equal(menu.canCancel, kind !== 'paused');
    if (kind !== 'paused') assert.match(menu.explanation.replace(/\s+/g, ' '), /uses usage credits, purchased separately from your plan/);
    if (kind !== 'checking') assert.equal(menu.options[1].label, kind === 'paused' ? 'Edit prompt and retry with Fable Test' : 'Continue with Fable Test');
    else assert.match(menu.waiting, /Checking usage credits/);
    assert.equal(mergeAsk(menu, [{ question: 'Unrelated stale question', options: [{label:'Continue with Fable Test'}] }]), menu);
  });
}
test('model switch above a resolved composer is stale', () => {
  const screen = fixture('usage') + '\n' + '\u2500'.repeat(90) + '\n\u276f ready for toys\n' + '\u2500'.repeat(90);
  assert.equal(parseMenu(screen), null);
});

test('model switch uses pointed row structure with unfamiliar wording and real paragraphs', () => {
  const screen = "You've reached your Toy limit\nIncluded credits have been\nused this week.\n\nA second paragraph.\n\n  Try a smaller engine\n\u276f Buy more time today\n\nEnter to confirm · Esc to cancel";
  const menu = parseMenu(screen);
  assert.equal(menu.kind, 'model-switch');
  assert.deepEqual(menu.options.map(option => option.label), ['Try a smaller engine', 'Buy more time today']);
  assert.equal(menu.options[1].selected, true);
  assert.equal(menu.explanation, 'Included credits have been used this week.\n\nA second paragraph.');
  const numbered = parseMenu('Session paused\nSynthetic explanation.\n\n  1. Try a different engine\n     with room for toys\n\u276f 2. Buy time\n0. This shallower line is outside the option run');
  assert.deepEqual(numbered.options.map(option => option.label), ['Try a different engine with room for toys', 'Buy time']);
});
