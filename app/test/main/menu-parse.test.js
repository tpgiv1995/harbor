'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseMenu, menuArrowToward, MENU_KEYS } = require('../../src/main/menu-parse.js');

for (const fixtureName of ['handoff-target-w1T-p0.txt', 'dev-image-w1V-p1.txt']) {
  test(`parseMenu recognizes footerless resume summary dialog from ${fixtureName}`, () => {
    const screen = fs.readFileSync(
      path.join(__dirname, '../fixtures/resume-summary-dialog', fixtureName),
      'utf8',
    );
    const menu = parseMenu(screen);
    // "(recommended)" leaves the label and becomes a flag: the card renders it
    // as a badge, so the emphasis reads at a glance instead of as a
    // parenthetical buried in the middle of a row.
    assert.deepEqual(
      menu.options.map(({ index, label, selected, recommended }) => ({
        index, label, selected, recommended,
      })),
      [
        { index: 1, label: 'Resume from summary', selected: true, recommended: true },
        { index: 2, label: 'Resume full session as-is', selected: false, recommended: false },
        { index: 3, label: "Don't ask me again", selected: false, recommended: false },
      ],
    );
    assert.equal(menu.selectedIndex, 0);
    assert.equal(menu.footer, '');
  });
}

test('parseMenu does not treat footerless numbered prose as a resume dialog', () => {
  assert.equal(parseMenu('Plan\n❯ 1. First task\n  2. Second task\n  3. Third task'), null);
});

// Real shape captured from a live pane (Apply custom project folder icons):
// question + descriptions + a "Type something" and "Chat about this" option,
// footer wrapped across two lines.
const REAL_MENU = [
  'How should sibling folders be iconed?',
  '❯ 1. Shared icon family',
  '     Data-Loader→data-loader-live, team-pcm→team,',
  '     and the Report family shares one Report icon.',
  '  2. Distinct logo for each',
  '     Generate a unique logo for every variant.',
  '  3. Type something.',
  '──────────────────────────────────────────────────',
  '  4. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate · Esc',
  'to cancel',
].join('\n');

test('parseMenu extracts options, selection, text-capability, and question', () => {
  const menu = parseMenu(REAL_MENU);
  assert.ok(menu, 'recognized as a menu');
  assert.deepEqual(menu.options.map((o) => o.index), [1, 2, 3, 4]);
  assert.equal(menu.options[0].label, 'Shared icon family');
  assert.equal(menu.selectedIndex, 0, 'the ❯ row is option 1');
  assert.equal(menu.options[2].isText, true, '"Type something" is a text option');
  assert.equal(menu.acceptsText, true);
  assert.match(menu.question, /sibling folders/);
});

test('parseMenu handles a Yes/No shape and an ↑/↓ footer variant', () => {
  const menu = parseMenu([
    ' Which approach?',
    '   1. Keep it',
    ' ❯ 2. Rework it',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n'));
  assert.ok(menu);
  assert.equal(menu.selectedIndex, 1);
  assert.equal(menu.acceptsText, false);
});

test('parseMenu returns null for a normal composer (no menu footer)', () => {
  assert.equal(parseMenu('some conversation\n──────\n❯\n──────\n  opus 4.8'), null);
  assert.equal(parseMenu(''), null);
  assert.equal(parseMenu('❯ [Image #2] describe this\n  ⎿  [Image #2]'), null);
});

// Real shape captured 2026-07-20 from the live pane of session 0cbdeeb7 (the
// send Pat could not deliver): a PreToolUse hook confirmation. Its footer is
// "Esc to cancel · Tab to amend · ctrl+e to explain", NOT the select-menu
// "Enter to select … navigate" footer, which is exactly why the first Q/A
// implementation never rendered it and the window was a dead end.
const REAL_HOOK_DIALOG = [
  '   git add -A --dry-run 2>/dev/null | wc -l',
  '   Confirm build artifacts are gitignored',
  '   before staging',
  '',
  ' Hook PreToolUse:Bash requires confirmation for',
  ' this command:',
  ' Broad staging in a shared worktree requires',
  ' explicit permission and a scoped status review.',
  ' [settings]',
  ' settings.json to update hooks',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend · ctrl+e to explain',
].join('\n');

test('parseMenu recognizes the hook/permission confirmation dialog', () => {
  const menu = parseMenu(REAL_HOOK_DIALOG);
  assert.ok(menu, 'the permission dialog is an answerable question, not a dead end');
  assert.deepEqual(menu.options.map((o) => [o.index, o.label]), [[1, 'Yes'], [2, 'No']]);
  assert.equal(menu.selectedIndex, 0, 'the ❯ row is Yes');
  assert.equal(menu.acceptsText, false);
  assert.match(menu.question, /Do you want to proceed\?/);
});

test('parseMenu ignores a stale menu echo scrolled above a live composer', () => {
  // After a menu is answered its last frame can linger in the recent scrape
  // above the fresh composer; a card must never render from that ghost.
  const menu = parseMenu([
    'How should sibling folders be iconed?',
    '❯ 1. Shared icon family',
    '  2. Distinct logo for each',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    '',
    '✻ Baking… (esc to interrupt)',
    '──────',
    '❯',
    '  opus 4.8',
  ].join('\n'));
  assert.equal(menu, null);
});

test('parseMenu keeps only the dialog options, not numbered prose above it', () => {
  const menu = parseMenu([
    ' The plan has steps:',
    ' 2. refactor the parser',
    ' 3. rerun the gates',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n'));
  assert.ok(menu);
  assert.deepEqual(menu.options.map((o) => [o.index, o.label]), [[1, 'Yes'], [2, 'No']]);
});

test('parseMenu still parses a dialog with a queued message echoed below it', () => {
  // Live-caught 2026-07-20 (third real shape): a message sent while the
  // session is blocked renders as a queued echo BELOW the dialog footer. A
  // trailing-line count guard read that as a stale frame and refused to
  // parse, so the card vanished exactly when Pat had already tried to talk
  // to the session. Only composer chrome below the footer means ghost.
  const menu = parseMenu([
    ' Hook PreToolUse:Bash requires confirmation for',
    ' this command:',
    ' A glob-count pipeline is context-dependent under',
    ' pipefail; use find with an explicit',
    ' zero-result-safe count. [settings]',
    ' settings.json to update hooks',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
    '',
    '  ❯ [Image #3] can you tell me which openAI key',
    '    we are using here so i can adjust billing',
    '    to ensure it auto-tops off moving forward?',
  ].join('\n'));
  assert.ok(menu, 'queued-echo trailing lines must not void the live dialog');
  assert.deepEqual(menu.options.map((o) => [o.index, o.label]), [[1, 'Yes'], [2, 'No']]);
  assert.equal(menu.selectedIndex, 0);
  assert.match(menu.question, /Do you want to proceed\?/);
});

// A multi-select question used to get NO card, on the reasoning that a
// single-select card would submit an empty selection on the first click. True,
// but the consequence was that it dropped to the raw-screen fallback panel,
// which is the shape reported as unusable (2026-07-27). It is
// parsed now: the interaction is toggle-then-confirm, and every step of it is
// verifiable because each row draws its own state as a checkbox.
test('parseMenu parses a multi-select question and reads each row state', () => {
  const menu = parseMenu([
    ' Which features do you want to enable?',
    ' ❯ 1. [ ] Fast boot',
    '   2. [x] Telemetry',
    '   3. [ ] Auto update',
    ' Space to toggle · Enter to confirm · Esc to cancel',
  ].join('\n'));
  assert.ok(menu, 'a multi-select question is answerable, so it gets a card');
  assert.equal(menu.multiSelect, true);
  assert.equal(menu.keys.toggle, true);
  assert.equal(menu.question, 'Which features do you want to enable?');
  // The checkbox is STATE, never part of the label.
  assert.deepEqual(menu.options.map((o) => o.label), ['Fast boot', 'Telemetry', 'Auto update']);
  assert.deepEqual(menu.options.map((o) => o.checked), [false, true, false]);
  assert.equal(menu.selectedIndex, 0, 'the ❯ still says which row the cursor is on');
});

test('a single-select question is not marked multiSelect, and carries no checkbox state', () => {
  const menu = parseMenu([
    ' Pick one',
    ' ❯ 1. First',
    '   2. Second',
    ' Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n'));
  assert.equal(menu.multiSelect, false);
  assert.equal(menu.options[0].checked, undefined);
});

test('parseMenu takes the notes key from the footer rather than assuming one', () => {
  const menu = parseMenu([
    ' Pick one',
    ' ❯ 1. First',
    '   2. Second',
    ' Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
  ].join('\n'));
  assert.equal(menu.keys.notes, true);
  assert.equal(menu.notesKey, 'n');
  const without = parseMenu([
    ' Pick one',
    ' ❯ 1. First',
    ' Enter to select · Esc to cancel',
  ].join('\n'));
  assert.equal(without.notesKey, null);
});

test('menuArrowToward yields a self-correcting single step (down/up/none)', () => {
  assert.equal(menuArrowToward(1, 4), MENU_KEYS.down);
  assert.equal(menuArrowToward(4, 2), MENU_KEYS.up);
  assert.equal(menuArrowToward(3, 3), null, 'already on target -> no arrow, caller sends Enter');
  assert.equal(menuArrowToward(null, 2), null, 'unknown current -> caller re-reads');
});

// Real shape live-caught 2026-07-21 from pane wC:pC: an AskUserQuestion menu
// whose per-option descriptions overflow the small pty viewport, so the
// question, option 1, and the "❯" pointer are clipped off the top of the
// screen. The prose in the fixture is neutralised (the capture was from a real
// client session and named people and their data); the SHAPE is byte-preserved,
// which is the only thing this parser reads. The
// visible numbered run starts at "2.", which the numbered-prose guard
// rejected wholesale: the fourth live-caught Q&A dead-end shape (amber cue,
// no card). The pane buffer holds ONLY the visible screen; the clipped top
// is unrecoverable by reading more lines, so the parser must accept the tail.
test('parseMenu parses a menu whose top is clipped by the viewport', () => {
  const screen = fs.readFileSync(
    path.join(__dirname, '../fixtures/clipped-menu/clipped-descriptions-wC-pC.txt'),
    'utf8',
  );
  const menu = parseMenu(screen);
  assert.ok(menu, 'a clipped menu is still an answerable question, not a dead end');
  assert.deepEqual(menu.options.map((o) => o.index), [2, 3, 4, 5]);
  assert.equal(menu.options[0].label, 'Hand-build it now');
  assert.equal(menu.clipped, true);
  assert.equal(menu.selectedIndex, null, 'the pointer is clipped off with option 1');
  assert.equal(menu.acceptsText, true, '"Type something." stays a text option');
  assert.equal(menu.question, '', 'prose above the run is option-1 description, not the question');
});

test('parseMenu still rejects a non-1-start numbered run that is not footer-adjacent', () => {
  // Numbered prose in the scrollback must not become a ghost card just
  // because clipped runs are now accepted: only a run whose last option sits
  // directly above the footer (blank/divider lines only) can be a menu tail.
  const menu = parseMenu([
    ' The plan has steps:',
    ' 2. refactor the parser',
    ' 3. rerun the gates',
    '',
    ' waiting on the gate output before proceeding',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n'));
  assert.equal(menu, null);
});

test('parseMenu marks an unclipped menu clipped:false', () => {
  const menu = parseMenu(REAL_MENU);
  assert.ok(menu);
  assert.equal(menu.clipped, false);
});

// Real shape live-caught 2026-07-26 from pane w5:p1 (the prose is neutralised;
// the wrap points and lengths are the captured ones, "Add
// customisable date range"), the screen Pat screenshotted: a BATCHED
// AskUserQuestion. It has a tab strip for three questions, a wrapped option
// label, a "(Recommended)" marker, and, because the pane is wide enough, the
// selected option's description in a boxed SECOND COLUMN to the right of the
// options. Every one of those broke the old line-by-line read: labels came
// out as "Custom segment +         ┌──────────────────┐", and the question
// was three lines of the assistant's prose plus the tab strip.
const TWO_COLUMN_FIXTURE = path.join(
  __dirname, '../fixtures/askuserquestion/two-column-tabs-w5-p1.txt',
);

test('parseMenu reads a two-column AskUserQuestion without the side panel bleeding into labels', () => {
  const menu = parseMenu(fs.readFileSync(TWO_COLUMN_FIXTURE, 'utf8'));
  assert.ok(menu);
  assert.deepEqual(menu.options.map(({ index, label, recommended }) => ({ index, label, recommended })), [
    { index: 1, label: 'Custom segment + inline pickers', recommended: true },
    { index: 2, label: 'Always-visible Start / End boxes', recommended: false },
  ]);
  assert.equal(menu.selectedIndex, 0);
  for (const option of menu.options) {
    assert.doesNotMatch(option.label, /[─│┌┐└┘├┤]/, 'no frame glyphs survive into a label');
  }
});

test('parseMenu takes the question from inside the dialog frame, not the transcript above it', () => {
  const menu = parseMenu(fs.readFileSync(TWO_COLUMN_FIXTURE, 'utf8'));
  assert.equal(menu.question, 'How should the custom range appear in the Date filter?');
  assert.doesNotMatch(menu.question, /design forks/, 'scrollback prose is not the question');
  assert.doesNotMatch(menu.question, /☐|Submit/, 'the tab strip is not the question');
});

test('parseMenu surfaces the batch tab strip and the keys the footer advertises', () => {
  const menu = parseMenu(fs.readFileSync(TWO_COLUMN_FIXTURE, 'utf8'));
  assert.deepEqual(menu.tabs, [
    { label: 'Control', done: false, submit: false },
    { label: 'Chart win…', done: false, submit: false },
    { label: 'Period ti…', done: false, submit: false },
    // The Submit tab's check mark is its icon, never an answered question.
    { label: 'Submit', done: false, submit: true },
  ]);
  assert.equal(menu.keys.switchQuestions, true, 'this footer offers Tab to switch questions');
  assert.equal(menu.keys.amend, false, 'Tab-to-amend is a different dialog family');
});

test('parseMenu keeps per-option descriptions in a single-column menu', () => {
  const menu = parseMenu(REAL_MENU);
  assert.equal(menu.options[0].label, 'Shared icon family');
  assert.equal(
    menu.options[0].description,
    'Data-Loader→data-loader-live, team-pcm→team, and the Report family shares one Report icon.',
  );
  assert.equal(menu.options[1].description, 'Generate a unique logo for every variant.');
  assert.equal(menu.options[3].description, '', 'a bare option has no description');
  assert.equal(menu.tabs, null, 'a single question has no tab strip');
});

test('parseMenu rejoins a description the narrow pane hard-wrapped mid-word', () => {
  // A fragment pushed to column 0 by the pane edge lost no space when the
  // break fell inside a word ("(w" + "hich"), but did when it fell on one
  // ("by" + "hand"). Joining every fragment the same way mangles one or the
  // other, and the card would show the mangling.
  const menu = parseMenu(fs.readFileSync(
    path.join(__dirname, '../fixtures/clipped-menu/narrow-pane-wrapped-footer.txt'),
    'utf8',
  ));
  assert.equal(
    menu.options[0].description,
    'I build the census by hand from her files and validate it before attaching.',
  );
  assert.equal(
    menu.options[1].description,
    "With your OK I trigger a fresh run on her files to produce the tool's own output.",
  );
});

// The same batched dialog read back out of a REAL 27-column pane (captured
// from the isolated harness). At that width the CLI stacks descriptions
// instead of using a side panel, and the terminal hard-wraps the tab strip,
// the option labels and the footer. Every one of those wraps was its own
// silent corruption: a strip fragment ("riod ✔ Submit →") glued to the front
// of the question, a label cut mid-word ("Custom segment + inlin"), and a
// footer whose second half hid the question switcher.
test('parseMenu reassembles a batched dialog a 27-column pane wrapped', () => {
  const menu = parseMenu(fs.readFileSync(
    path.join(__dirname, '../fixtures/askuserquestion/batch-narrow-27col.txt'),
    'utf8',
  ));
  assert.ok(menu);
  assert.equal(menu.question, 'How should the custom range appear in the filter?');
  assert.deepEqual(menu.options.map((o) => o.label), [
    'Custom segment + inline pickers',
    'Always-visible Start / End boxes',
  ]);
  assert.equal(menu.options[0].description, 'Adds a Custom chip beside the presets, with Start and End pickers.');
  assert.equal(menu.options[0].recommended, true);
  assert.deepEqual(menu.tabs.map((t) => t.label), ['Control', 'Chart', 'Period', 'Submit']);
  assert.equal(menu.keys.switchQuestions, true, 'the wrapped footer still yields its keys');
  assert.equal(menu.keys.notes, true);
});

test('parseMenu does not eat prose that merely contains check marks', () => {
  // The tab strip is recognized by its own chrome (the ←/→ pager or a Submit
  // tab). Without that guard a reason line full of ✔ would vanish from the
  // question, and a silently missing question is the worst failure this card
  // can have.
  const menu = parseMenu([
    ' ✔ lint clean  ✔ types clean',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n'));
  assert.ok(menu);
  assert.equal(menu.tabs, null);
  assert.match(menu.question, /lint clean/);
  assert.equal(menu.keys.amend, true);
});

test('parseMenu accepts a clipped menu whose footer WRAPS across two lines', () => {
  // Captured from a narrow harness pane (spec 6c, gate-caught 2026-07-21):
  // both wrapped footer fragments match FOOTER_RE, footerIndex lands on the
  // LAST fragment, and the first fragment sits between the last option and
  // the footer. The adjacency guard must treat a contiguous block of
  // footer-matching lines as ONE footer, not as prose that vetoes the parse.
  const screen = fs.readFileSync(
    path.join(__dirname, '../fixtures/clipped-menu/narrow-pane-wrapped-footer.txt'),
    'utf8',
  );
  const menu = parseMenu(screen);
  assert.ok(menu, 'a wrapped footer must not void the clipped menu');
  assert.deepEqual(menu.options.map((o) => o.index), [2, 3, 4, 5]);
  assert.equal(menu.clipped, true);
  assert.equal(menu.acceptsText, true);
});

// The SAME real Claude dialog, captured from the SAME pane at two sizes, which
// is the measurement the whole 2026-07-27 fix rests on: the clip was never a
// property of the dialog, it was a property of the 23-row pane Harbor was
// driving. Both files are byte-exact pane reads (see test/herdr/pane-size.test.js
// for the pty half).
const realFixture = (name) => fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8');

test("a real Claude dialog at herdr's own 23x54: the question and option 1 are not on the screen", () => {
  const menu = parseMenu(realFixture('clipped-menu/real-claude-23x54.txt'));
  assert.ok(menu);
  assert.equal(menu.clipped, true);
  assert.equal(menu.question, '', 'an empty question is honest; an invented one is not');
  assert.deepEqual(menu.options.map((o) => o.index), [2, 3, 4, 5]);
});

test('the same real dialog at 120x60 parses whole, question, pointer and all', () => {
  const menu = parseMenu(realFixture('askuserquestion/real-claude-120x60.txt'));
  assert.ok(menu);
  assert.equal(menu.clipped, false);
  assert.equal(menu.question, 'Where should the per-office PDFs get generated each quarter?');
  assert.deepEqual(menu.options.map((o) => o.index), [1, 2, 3, 4, 5]);
  assert.equal(menu.options[0].label, 'In the publish workflow');
  assert.equal(menu.options[0].recommended, true);
  assert.equal(menu.options[0].selected, true, 'the "❯" is on option 1 and can be verified');
  assert.match(menu.options[0].description, /^Generate the PDFs as an automated step/);
  assert.equal(menu.options[3].isText, true);
});

test('the one-tab strip of a single-question dialog stays out of the question', () => {
  // "☐ PDF Generation" is the tab for the only question. It used to be read as
  // the first words of the question itself.
  const menu = parseMenu(realFixture('askuserquestion/real-claude-120x60.txt'));
  assert.doesNotMatch(menu.question, /PDF Generation/);
  assert.doesNotMatch(menu.question, /[\u2610\u2611\u2714]/);
});
