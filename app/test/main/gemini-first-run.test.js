'use strict';

// Gemini's first-run pages as a Harbor card (2026-11-24, Pat: "you didn't even bother to build out a harbor screen for
// gemini"). The fixtures are agy 1.5.14's real pages, captured at 120x60 in a scratch home (Done never pressed). The
// walk is driven against a stand-in pane that answers keys the way agy was measured to (gemini-first-run.js header).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseGeminiFirstRun, answerGeminiFirstRun } = require('../../src/main/gemini-first-run.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'gemini-first-run', `${name}.txt`), 'utf8');
const SCHEMES = ['terminal', 'light', 'solarized light', 'colorblind-friendly light', 'dark', 'solarized dark', 'colorblind-friendly dark', 'tokyo night'];

test('the colour page reads as its eight schemes with the pointed one selected, not the preview box', () => {
  const page = parseGeminiFirstRun(fixture('scheme-start'));
  assert.equal(page.page, 'scheme');
  assert.deepEqual(page.schemes.map((s) => s.label), SCHEMES);
  assert.equal(page.schemes.find((s) => s.selected).label, 'terminal');
  assert.equal(parseGeminiFirstRun(fixture('scheme-down3')).schemes.find((s) => s.selected).label, 'colorblind-friendly light');
});

test('the Terms page reads its warning, the whole consent sentence, the box state, the links and the focus', () => {
  const page = parseGeminiFirstRun(fixture('terms-start'));
  assert.equal(page.page, 'terms');
  assert.equal(page.checked, true, "Google's box starts ticked");
  assert.equal(page.focus, 'box');
  assert.match(page.warning, /^AI coding agents are known to have certain security risks/);
  assert.match(page.consent, /^Yes, I agree to help improve Antigravity CLI by allowing Google to collect and use my Interactions data, .* via my settings\.$/);
  assert.deepEqual(page.links.map((l) => l.url), ['https://antigravity.google/terms', 'https://policies.google.com/privacy']);
  assert.equal(parseGeminiFirstRun(fixture('terms-unchecked')).checked, false);
  assert.equal(parseGeminiFirstRun(fixture('terms-focus-previous')).focus, 'previous');
  assert.equal(parseGeminiFirstRun(fixture('terms-focus-done')).focus, 'done');
});

test('no first-run page on an ordinary screen', () => {
  assert.equal(parseGeminiFirstRun(''), null);
  assert.equal(parseGeminiFirstRun('> you: Choose your words\n? for shortcuts'), null);
});

// A stand-in pane with agy's measured keys.
function fakeAgy({ scheme = 0, page = 'scheme', checked = true, focus = 'box', stuck = false } = {}) {
  const state = { scheme, page, checked, focus, keys: [], onboarded: false };
  const draw = () => {
    if (state.page === 'scheme') {
      const rows = SCHEMES.map((s, i) => `  ${i === state.scheme ? '>' : ' '} ${s.padEnd(31)}│ preview`);
      return ['Welcome to Antigravity CLI!', 'Choose your color scheme:        ╭──', ...rows, '    [Next]', '  ↑/↓ Navigate · enter Confirm'].join('\n');
    }
    if (state.page === 'terms') {
      const box = `  ${state.focus === 'box' ? '>' : ' '} [${state.checked ? 'x' : ' '}] Yes, I agree to help improve Antigravity CLI by allowing`;
      const prev = state.focus === 'previous' ? '>  Previous' : '[Previous]';
      const done = state.focus === 'done' ? '>  Done' : '[Done]';
      return ['Terms of Service & Data Use', '', 'AI coding agents are known to have certain security risks.', '', '-'.repeat(40), '', box,
        '      Google to collect and use my Interactions data.', '', '      Links:', '      - Terms of Service: https://antigravity.google/terms', '', `    ${prev}      ${done}`].join('\n');
    }
    return '─'.repeat(40) + '\n> \n' + '─'.repeat(40) + '\n? for shortcuts';
  };
  const type = async (bytes) => {
    state.keys.push(bytes);
    if (stuck) return;
    if (state.page === 'scheme') {
      if (bytes === '\x1b[B') state.scheme = Math.min(SCHEMES.length - 1, state.scheme + 1);
      if (bytes === '\x1b[A') state.scheme = Math.max(0, state.scheme - 1);
      if (bytes === '\r') state.page = 'terms';
    } else if (state.page === 'terms') {
      if (bytes === '\x1b[B' && state.focus === 'box') state.focus = 'previous';
      else if (bytes === '\t') state.focus = state.focus === 'previous' ? 'done' : state.focus === 'done' ? 'box' : 'previous';
      else if (bytes === '\r') {
        if (state.focus === 'box') state.checked = !state.checked;
        else if (state.focus === 'previous') state.page = 'scheme';
        else { state.page = 'composer'; state.onboarded = true; }
      }
    }
  };
  return { state, deps: { read: async () => draw(), type, sleep: async () => {} } };
}

test('a scheme click walks the pointer there one verified step at a time, then presses Enter once', async () => {
  const pane = fakeAgy();
  const res = await answerGeminiFirstRun({ type: 'gemini-scheme', label: 'tokyo night' }, pane.deps);
  assert.equal(res.ok, true, res.reason);
  assert.equal(pane.state.page, 'terms');
  assert.equal(pane.state.scheme, 7);
  assert.equal(pane.state.keys.filter((k) => k === '\r').length, 1);
});

test('a pointer that does not move ends the walk with no Enter', async () => {
  const pane = fakeAgy({ stuck: true });
  const res = await answerGeminiFirstRun({ type: 'gemini-scheme', label: 'dark' }, pane.deps);
  assert.equal(res.ok, false);
  assert.ok(!pane.state.keys.includes('\r'));
});

test('the box toggles only on the box, and Done presses Enter only on Done with the state the card showed', async () => {
  const pane = fakeAgy({ page: 'terms', focus: 'done' });
  assert.equal((await answerGeminiFirstRun({ type: 'gemini-terms', op: 'toggle' }, pane.deps)).ok, true);
  assert.equal(pane.state.checked, false);
  assert.equal(pane.state.onboarded, false, 'toggling never finishes onboarding');
  // The card still showed the box ticked: Done refuses and presses nothing.
  const keysBefore = pane.state.keys.length;
  const stale = await answerGeminiFirstRun({ type: 'gemini-terms', op: 'done', checked: true }, pane.deps);
  assert.equal(stale.ok, false);
  assert.equal(pane.state.keys.length, keysBefore);
  const done = await answerGeminiFirstRun({ type: 'gemini-terms', op: 'done', checked: false }, pane.deps);
  assert.equal(done.ok, true, done.reason);
  assert.equal(pane.state.onboarded, true);
  assert.equal(pane.state.checked, false, 'Done kept the choice made');
});

test('Previous goes back to the colour page', async () => {
  const pane = fakeAgy({ page: 'terms' });
  assert.equal((await answerGeminiFirstRun({ type: 'gemini-terms', op: 'previous' }, pane.deps)).ok, true);
  assert.equal(pane.state.page, 'scheme');
});
