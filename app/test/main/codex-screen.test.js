'use strict';

// Codex's TUI read off the screen (codex-screen.js). The screens are Codex
// 0.160 frames captured in a throwaway pty through the daemon's headless xterm,
// with paths and prose made synthetic (test/fixtures/codex-tui/).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseCodexMenu, codexComposer, codexPendingInputs, codexSendState, composerImageCount,
  isCodexBlocked, isCodexWorking, isCodexIdle,
} = require('../../src/main/codex-screen.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/codex-tui', name), 'utf8');

test('an approval parses as a permission prompt with its command and one-key hints', () => {
  const menu = parseCodexMenu(fixture('approval-command-0.160.0.txt'));
  assert.equal(menu.provider, 'codex');
  assert.equal(menu.clipped, false);
  assert.deepEqual(menu.options.map((o) => [o.index, o.label, o.selected, o.key]), [
    [1, 'Yes, proceed', true, 'y'],
    [2, 'Yes, and don\'t ask again for commands that start with `echo hello > probe.txt`', false, 'p'],
    [3, 'No, and tell Codex what to do differently', false, 'esc'],
  ]);
  assert.equal(menu.permission.toolTitle, 'Run command');
  assert.deepEqual(menu.permission.blocks.find((b) => b.type === 'code'), { type: 'code', text: 'echo hello > probe.txt' });
  const edits = parseCodexMenu(fixture('approval-edits-0.160.0.txt'));
  assert.equal(edits.permission.toolTitle, 'Edit files');
  assert.match(edits.permission.blocks[0].text, /Destination:\n\/home\/user\/project\/notes\.md/);
});

test('a request_user_input question parses with its batch position, notes line and free-form row', () => {
  const q1 = parseCodexMenu(fixture('question-batch-q1-0.160.0.txt'));
  assert.equal(q1.question, 'Which color?');
  assert.deepEqual(q1.options.map((o) => [o.label, o.description, o.isText]), [
    ['Red', 'Choose red.', false], ['Blue', 'Choose blue.', false], ['None of the above', 'Optionally, add details in notes (tab)', true],
  ]);
  assert.equal(q1.codex.questionIndex, 0);
  assert.equal(q1.codex.questionCount, 2);
  assert.equal(q1.keys.switchQuestions, true);
  assert.equal(q1.tabs.length, 2);
  assert.equal(q1.codex.submitsAll, false);
  assert.equal(parseCodexMenu(fixture('question-batch-q1-down-0.160.0.txt')).selectedIndex, 1);
  assert.equal(parseCodexMenu(fixture('question-batch-q2-last-0.160.0.txt')).codex.submitsAll, true);
  assert.equal(parseCodexMenu(fixture('question-notes-typed-0.160.0.txt')).codex.notes, 'a note');
  assert.equal(parseCodexMenu(fixture('question-notes-empty-0.160.0.txt')).codex.notes, '');
  assert.equal(parseCodexMenu(fixture('question-auto-resolve-0.160.0.txt')).codex.autoResolveSeconds, 54);
});

test('a note that wraps onto a second line still parses, with the whole note', () => {
  const long = 'pick whichever fruit is in season where I live, and if neither of them is then say so and suggest one';
  const cut = long.indexOf(' ', 55);
  const screen = fixture('question-notes-typed-0.160.0.txt').replace('  › a note', `  › ${long.slice(0, cut)}\n    ${long.slice(cut + 1)}`);
  const menu = parseCodexMenu(screen);
  assert.ok(menu, 'the question still parses');
  assert.equal(menu.question, 'Which fruit?');
  assert.equal(menu.codex.notesOpen, true);
  assert.equal(menu.codex.notes, long);
});

test('any other pointed picker is a blocker too (the update prompt)', () => {
  const menu = parseCodexMenu(fixture('update-picker-0.160.0.txt'));
  assert.equal(menu.codex.kind, 'picker');
  assert.equal(menu.options[0].label.startsWith('Update now'), true);
  assert.equal(isCodexBlocked(fixture('update-picker-0.160.0.txt')), true);
});

test('composers, working turns and answered questions never parse as a dialog', () => {
  for (const name of ['idle-composer-0.160.0.txt', 'idle-typed-0.160.0.txt', 'working-0.160.0.txt', 'working-queued-0.160.0.txt',
    'working-steer-and-queued-0.160.0.txt', 'question-answered-working-0.160.0.txt', 'image-and-text-in-composer-0.160.0.txt',
    'steer-sent-after-esc-0.160.0.txt']) {
    assert.equal(parseCodexMenu(fixture(name)), null, name);
  }
});

test('the composer is the last column-0 pointer line, and none is drawn under a dialog', () => {
  assert.deepEqual(
    (({ text, placeholder }) => ({ text, placeholder }))(codexComposer(fixture('idle-composer-0.160.0.txt'))),
    { text: '', placeholder: true },
  );
  assert.match(codexComposer(fixture('idle-typed-0.160.0.txt')).text, /reply with the single word DONE\.$/);
  for (const name of ['approval-command-0.160.0.txt', 'question-batch-q1-0.160.0.txt', 'question-notes-typed-0.160.0.txt']) {
    assert.equal(codexComposer(fixture(name)), null, name);
  }
});

// A draft taller than the bottom of the screen pushed its own `›` line out of
// the window the composer was looked for in, so a send was refused as "Codex
// is not showing its message box".
test('a draft taller than the bottom window is still the composer', () => {
  const screen = fixture('idle-typed-0.160.0.txt');
  const lines = screen.split('\n');
  const at = lines.findIndex((line) => line.startsWith('› Run the shell command'));
  const wrapped = Array.from({ length: 20 }, (_, i) => `  draft line ${i + 1}`);
  const tall = [...lines.slice(0, at + 1), ...wrapped, ...lines.slice(at + 1)].join('\n');
  const composer = codexComposer(tall);
  assert.ok(composer, 'the tall draft is found');
  assert.match(composer.text, /draft line 20$/);
  assert.equal(codexSendState(tall, { text: 'draft line 20' }), 'holds');
  // An older prompt echo high on the screen, with the composer gone, is not one.
  const echoOnly = [...lines.slice(0, at + 1), '', ...Array.from({ length: 20 }, (_, i) => `• output ${i}`)].join('\n');
  assert.equal(codexComposer(echoOnly), null);
});

test('steers and queued follow-ups are read off the screen', () => {
  assert.deepEqual(codexPendingInputs(fixture('working-steer-and-queued-0.160.0.txt')), {
    steer: ['second note PEAR'], queued: ['also say BANANA at the end'],
  });
  assert.deepEqual(codexPendingInputs(fixture('idle-composer-0.160.0.txt')), { steer: [], queued: [] });
});

test('a send is read as holds, taken, pending or nobox', () => {
  assert.equal(codexSendState(fixture('idle-typed-0.160.0.txt'), { text: 'Then reply with the single word DONE.' }), 'holds');
  assert.equal(codexSendState(fixture('working-0.160.0.txt'), { text: 'Then reply with the single word DONE.' }), 'taken');
  assert.equal(codexSendState(fixture('working-steer-and-queued-0.160.0.txt'), { text: 'second note PEAR' }), 'taken');
  assert.equal(codexSendState(fixture('idle-composer-0.160.0.txt'), { text: 'not typed yet' }), 'pending');
  assert.equal(codexSendState(fixture('approval-command-0.160.0.txt'), { text: 'x' }), 'nobox');
});

test('image markers are counted in the composer only, never in the echo above it', () => {
  assert.equal(composerImageCount(fixture('image-in-composer-0.160.0.txt')), 1);
  assert.equal(composerImageCount(fixture('image-and-text-in-composer-0.160.0.txt')), 1);
  assert.equal(composerImageCount(fixture('image-sent-idle-0.160.0.txt')), 0, 'the sent message still shows [Image #1] above an empty composer');
});

test('working and idle: a titled working line is a turn in flight, and never an idle TUI', () => {
  assert.equal(isCodexWorking(fixture('working-0.160.0.txt')), true);
  assert.equal(isCodexIdle(fixture('working-0.160.0.txt')), false);
  assert.equal(isCodexIdle(fixture('idle-composer-0.160.0.txt')), true);
  assert.equal(isCodexIdle(fixture('approval-command-0.160.0.txt')), false);
  assert.equal(isCodexIdle(''), false, 'an unreadable screen is never idle');
  const titled = fixture('working-0.160.0.txt').replace(/• Working \(/, '• Inspecting the repo (');
  assert.equal(isCodexWorking(titled), true);
  assert.equal(isCodexIdle(titled), false);
  // The question footer says "esc to interrupt" but is not a working line.
  assert.equal(isCodexWorking(fixture('question-batch-q1-0.160.0.txt')), false);
});
