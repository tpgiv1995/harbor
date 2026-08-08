'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAsk, mergeAsk, matchQuestionIndex } = require('../../src/main/ask-question.js');

// Live-caught 2026-07-27, Pat: "not even showing the actual question, fix." The
// pty viewport had scrolled the question and option 1 off the top, and the pane
// buffer holds only the visible screen, so the card could only say so. The
// transcript's own AskUserQuestion tool_use had the whole thing.
//
// This payload is the SHAPE of a real one, taken from
// ~/.claude/projects/-home-you-dev-example-chatbot.../ab235f0b….jsonl
// (tool_use toolu_01ACzpkiEsJ8Wj43XnXqiX4a, three minutes before Pat's
// screenshot).
const ASK = {
  questions: [
    {
      question: 'Where should pending magic-link tokens live?',
      header: 'Token store',
      multiSelect: false,
      options: [
        {
          label: 'Sheet-backed store (Recommended)',
          description: 'A small dedicated auth-token sheet holding sha256(token).',
          preview: 'POST addRow { hash, email, exp }',
        },
        { label: 'In-memory Map', description: 'A plain Map with an expiry sweep.' },
        { label: 'Upstash Redis (free tier)', description: 'A real TTL store over HTTP.' },
      ],
    },
    {
      question: 'How should demo sign-in work?',
      header: 'Demo account',
      multiSelect: false,
      options: [
        { label: 'Shared password', description: 'One password for the demo identity.' },
        { label: 'Drop the demo account', description: 'Remove it entirely.' },
      ],
    },
  ],
};

// A pty menu as menu-parse.js returns it.
const ptyMenu = (options, extra = {}) => ({
  question: '',
  options,
  tabs: null,
  keys: {},
  clipped: false,
  footer: 'Enter to select',
  acceptsText: options.some((o) => o.isText),
  selectedIndex: null,
  ...extra,
});

const opt = (index, label, over = {}) => ({
  index, label, description: '', recommended: false, selected: false, isText: false, ...over,
});

test('normalizeAsk lifts (Recommended) out of the label, as the pty parser does', () => {
  const questions = normalizeAsk(ASK);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].options[0].label, 'Sheet-backed store');
  assert.equal(questions[0].options[0].recommended, true);
  assert.equal(questions[0].options[1].recommended, false);
});

test('normalizeAsk refuses junk instead of throwing inside the poll', () => {
  assert.equal(normalizeAsk(null), null);
  assert.equal(normalizeAsk({}), null);
  assert.equal(normalizeAsk({ questions: [] }), null);
  assert.equal(normalizeAsk({ questions: [{}] }), null);
});

test('the real question replaces a blank one on a clipped menu', () => {
  // The exact reported bug: options 2 and 3 visible, question gone.
  const menu = ptyMenu([opt(2, 'In-memory Map'), opt(3, 'Upstash Redis')], { clipped: true });
  const merged = mergeAsk(menu, ASK);
  assert.equal(merged.question, 'Where should pending magic-link tokens live?');
  assert.equal(merged.questionSource, 'transcript');
  assert.equal(merged.clipped, false, 'nothing is missing any more, so the note goes quiet');
  assert.equal(merged.ptyClipped, true, 'but the pty view is still clipped, and that is recorded');
});

test('an option clipped off the top comes back, numbered and marked offscreen', () => {
  const menu = ptyMenu([opt(2, 'In-memory Map'), opt(3, 'Upstash Redis')], { clipped: true });
  const merged = mergeAsk(menu, ASK);
  assert.deepEqual(merged.options.map((o) => o.index), [1, 2, 3]);
  assert.equal(merged.options[0].label, 'Sheet-backed store');
  assert.equal(merged.options[0].offscreen, true, 'the pointer cannot be verified there');
  assert.equal(merged.options[0].recommended, true);
  assert.equal(merged.options[1].offscreen, undefined, 'a visible option is not marked');
});

test('descriptions arrive for options the scrape only had labels for', () => {
  const menu = ptyMenu([opt(1, 'Sheet-backed store'), opt(2, 'In-memory Map')]);
  const merged = mergeAsk(menu, ASK);
  assert.match(merged.options[0].description, /auth-token sheet/);
  assert.match(merged.options[1].description, /expiry sweep/);
  assert.match(merged.options[0].preview, /POST addRow/);
});

test('a truncated pty label is replaced by the full one', () => {
  const menu = ptyMenu([opt(3, 'Upstash Redis (free tie…')], { clipped: true });
  const merged = mergeAsk(menu, ASK);
  const three = merged.options.find((o) => o.index === 3);
  assert.equal(three.label, 'Upstash Redis (free tier)');
});

test('the current question in a batch is derived from the options on screen', () => {
  const first = mergeAsk(ptyMenu([opt(1, 'Sheet-backed store'), opt(2, 'In-memory Map')]), ASK);
  assert.equal(first.batch.currentIndex, 0);
  assert.equal(first.question, 'Where should pending magic-link tokens live?');

  const second = mergeAsk(ptyMenu([opt(1, 'Shared password'), opt(2, 'Drop the demo account')]), ASK);
  assert.equal(second.batch.currentIndex, 1);
  assert.equal(second.question, 'How should demo sign-in work?');
  assert.deepEqual(second.batch.headers.map((h) => h.current), [false, true]);
});

test('ambiguity is never resolved by guessing', () => {
  // Two questions with identical options cannot be told apart from the screen,
  // and a card labelled with the wrong question is worse than an unlabelled one.
  const ask = {
    questions: [
      { question: 'Ship it?', header: 'A', options: [{ label: 'Yes' }, { label: 'No' }] },
      { question: 'Delete it?', header: 'B', options: [{ label: 'Yes' }, { label: 'No' }] },
    ],
  };
  const menu = ptyMenu([opt(1, 'Yes'), opt(2, 'No')]);
  assert.equal(matchQuestionIndex(normalizeAsk(ask), menu.options), -1);
  const merged = mergeAsk(menu, ask);
  assert.equal(merged.question, '', 'left exactly as the pty had it');
  assert.equal(merged.batch, undefined, 'no batch claim either');
});

test('a question set that matches nothing on screen leaves the menu untouched', () => {
  const menu = ptyMenu([opt(1, 'Something else entirely'), opt(2, 'Another thing')]);
  const merged = mergeAsk(menu, ASK);
  assert.deepEqual(merged, menu, 'the worst case is exactly the old behaviour');
});

test('a free-text row is never rewritten from the transcript', () => {
  // "Type something" is the CLI's own extra row, not one of Claude's options.
  const menu = ptyMenu([
    opt(1, 'Sheet-backed store'),
    opt(2, 'In-memory Map'),
    opt(3, 'Upstash Redis'),
    opt(4, 'Type something', { isText: true }),
  ]);
  const merged = mergeAsk(menu, ASK);
  const text = merged.options.find((o) => o.index === 4);
  assert.equal(text.label, 'Type something');
  assert.equal(text.isText, true);
  assert.equal(text.description, '', 'it borrowed no option description');
});

test('multiSelect is carried from the payload, since the screen only hints at it', () => {
  const ask = {
    questions: [{
      question: 'Which features?',
      header: 'Features',
      multiSelect: true,
      options: [{ label: 'Fast boot' }, { label: 'Telemetry' }],
    }],
  };
  const merged = mergeAsk(ptyMenu([opt(1, 'Fast boot'), opt(2, 'Telemetry')]), ask);
  assert.equal(merged.multiSelect, true);
});

test('a null or optionless menu is returned as-is', () => {
  assert.equal(mergeAsk(null, ASK), null);
  assert.deepEqual(mergeAsk({ foo: 1 }, ASK), { foo: 1 });
});

test('a single question still needs option evidence before it is claimed', () => {
  // Gate-caught by spec 6e: the newest unanswered AskUserQuestion in a
  // transcript is NOT necessarily the dialog on screen, so a lone question
  // matching unconditionally pasted itself onto an unrelated prompt. One shared
  // option label is the minimum proof that these are the same question.
  const ask = { questions: [{ question: 'Only one?', header: 'X', options: [{ label: 'Sure' }] }] };
  const mismatch = mergeAsk(ptyMenu([opt(2, 'garbled beyond recognition')], { clipped: true }), ask);
  assert.equal(mismatch.question, '', 'no shared option, so no claim');

  const match = mergeAsk(ptyMenu([opt(1, 'Sure')]), ask);
  assert.equal(match.question, 'Only one?', 'one shared option is enough');
});

test('a stale unanswered question is not pasted onto a different live dialog', () => {
  // The exact 6e shape: the transcript holds a live question about one thing
  // while the pane shows a dialog about another.
  const stale = {
    questions: [{
      question: 'Which of these do you want me to do about the kernel fault?',
      header: 'Kernel',
      options: [{ label: 'Collect a trace' }, { label: 'Ignore it' }],
    }],
  };
  const onScreen = ptyMenu([opt(1, 'Custom segment + inline pickers'), opt(2, 'Always-visible Start / End boxes')]);
  const merged = mergeAsk(onScreen, stale);
  assert.deepEqual(merged, onScreen, 'the pane is left to speak for itself');
});

test('normalizeAsk is idempotent, so a second pass keeps the Recommended flag', () => {
  // Gate-caught by spec 6f. mergeAsk normalizes whatever it is handed, so a
  // payload that has already been through here must survive unchanged; the flag
  // lives outside the label by then, and re-reading only the label would drop it.
  const once = normalizeAsk(ASK);
  const twice = normalizeAsk({ questions: once });
  assert.deepEqual(twice, once);
  assert.equal(twice[0].options[0].recommended, true);
});

test('mergeAsk accepts a raw question array as well as a payload object', () => {
  const raw = [{
    question: 'Which route?',
    header: 'Route',
    options: [{ label: 'Use her own run (Recommended)', description: 'Validated output.' }],
  }];
  const merged = mergeAsk(ptyMenu([opt(1, 'Use her own run')]), raw);
  assert.equal(merged.question, 'Which route?');
  assert.equal(merged.options[0].label, 'Use her own run', 'the marker is lifted out of the label');
  assert.equal(merged.options[0].recommended, true);
});

test('offscreen rows are withdrawn when the pty numbering contradicts payload order', () => {
  // The offscreen rows' numbers come from payload order (option i is "i+1"), so
  // that mapping is CONFIRMED against every visible match rather than trusted.
  // Here the CLI has numbered "In-memory Map" (payload position 1, so expected
  // "2") as 3, which means a derived number could point at the wrong option.
  const menu = ptyMenu([opt(3, 'In-memory Map')], { clipped: true });
  const merged = mergeAsk(menu, ASK);
  assert.equal(merged.question, 'Where should pending magic-link tokens live?',
    'the question is still safe to show');
  assert.equal(merged.options.some((o) => o.offscreen), false,
    'but no row gets a number that cannot be corroborated');
});

test('offscreen rows survive when the numbering does corroborate', () => {
  const menu = ptyMenu([opt(2, 'In-memory Map'), opt(3, 'Upstash Redis')], { clipped: true });
  const merged = mergeAsk(menu, ASK);
  assert.deepEqual(merged.options.filter((o) => o.offscreen).map((o) => o.index), [1]);
});

// Gate-caught 2026-07-27, and it would have been a live misrepresentation: the
// card retitled a permission prompt ("Do you want to proceed? / Yes / No") with
// a real unanswered question from the same session's transcript, because the
// prompt's "Yes" prefixed that question's "Yes, ..." and one two-way prefix hit
// was the whole bar. Two independent guards now stop it, and this pins both.
test('a permission prompt is never retitled with a pending question', () => {
  const pending = {
    questions: [{
      question: 'Which of these do you want me to do about the kernel fault?',
      header: 'Kernel',
      options: [{ label: 'Yes, collect a trace' }, { label: 'No, ignore it' }],
    }],
  };
  const prompt = {
    question: 'Do you want to proceed?',
    options: [opt(1, 'Yes'), opt(2, 'No')],
    keys: { amend: true, explain: true },
    clipped: false,
  };
  assert.deepEqual(mergeAsk(prompt, pending), prompt, 'the permission prompt keeps its own words');
});

test('a short generic label is not enough to claim a question', () => {
  // Same payload, but on an AskUserQuestion-family dialog, so the footer guard
  // does not apply and the LABEL rule has to carry it on its own.
  const pending = {
    questions: [{
      question: 'Which of these do you want me to do about the kernel fault?',
      header: 'Kernel',
      options: [{ label: 'Yes, collect a trace' }, { label: 'No, ignore it' }],
    }],
  };
  const onScreen = ptyMenu([opt(1, 'Yes'), opt(2, 'No')]);
  assert.deepEqual(mergeAsk(onScreen, pending), onScreen, 'a three-letter prefix proves nothing');
});

test('a truncated long label still matches, because that is what the pty does to them', () => {
  const pending = {
    questions: [{
      question: 'Where do the deliverables go?',
      header: 'Output',
      options: [
        { label: 'Shared Outputs deliverables folder' },
        { label: 'The repo working directory' },
      ],
    }],
  };
  const onScreen = ptyMenu([opt(1, 'Shared Outputs deliv…'), opt(2, 'The repo working directory')]);
  assert.equal(mergeAsk(onScreen, pending).question, 'Where do the deliverables go?');
});

test('a visible row the payload has never heard of disqualifies the whole match', () => {
  const pending = {
    questions: [{
      question: 'Where do the deliverables go?',
      header: 'Output',
      options: [
        { label: 'Shared Outputs deliverables folder' },
        { label: 'The repo working directory' },
      ],
    }],
  };
  // Row 2 belongs to some other dialog, so row 1 agreeing is a coincidence.
  const onScreen = ptyMenu([opt(1, 'Shared Outputs deliverables folder'), opt(2, 'Restart the daemon')]);
  assert.deepEqual(mergeAsk(onScreen, pending), onScreen);
});
