#!/usr/bin/env node
'use strict';

// E2E stand-in for a Claude session parked on an interactive dialog. Scenes
// are exact shapes live-caught from real panes; arrows move the "❯" pointer,
// Enter prints PICKED:<n> and exits, Esc prints CANCELLED and exits. Runs
// inside an isolated harness pane only; never against the real daemon.
//
// Scenes (argv[2], default "hook"):
//   hook:    PreToolUse hook confirmation, live-caught 2026-07-20 (footer
//             "Esc to cancel · Tab to amend · ctrl+e to explain", NOT the
//             select-menu footer).
//   clipped: AskUserQuestion tail, live-caught 2026-07-21 (pane wC:pC): the
//             question, option 1, and the pointer overflow the pty viewport,
//             so the screen opens mid-description and the visible numbered
//             run starts at 2. The pointer stays invisible while it sits on
//             the clipped option 1, exactly as captured.
//   mystery: a dialog shape Harbor has NEVER seen (lettered options, unknown
//             footer). Exercises the no-dead-end fallback panel: no parse is
//             possible, only the blocked-text signal, the raw screen, and
//             direct keys. Arrows move a visible cursor line, a letter picks,
//             Esc cancels.
//   batch:   a BATCHED AskUserQuestion, live-caught 2026-07-26 (pane w5:p1):
//             three questions behind one tab strip, wrapped option labels, a
//             "(Recommended)" marker, and the selected option's description in
//             a boxed SECOND COLUMN to the right of the options. Transcript
//             prose sits above the dialog frame. Reading this screen line by
//             line glued the panel's box drawing onto every label and made the
//             prose part of the question. Tab switches question, Enter answers
//             the current one and moves on.

//   multi:   a MULTI-SELECT AskUserQuestion ("Space to toggle · Enter to
//             confirm"). Each row draws its own [ ] / [x] state. This shape got
//             no card at all until 2026-07-27, so it fell through to the
//             raw-screen fallback panel; Space toggles, Enter submits the set.
//             NOTE: unlike the other scenes this one is CONSTRUCTED, not a live
//             capture, because no real multi-select screen has been caught yet.
//             Its frame and footer follow the batch scene, which is real. Replace
//             it with real bytes the first time one is captured.
const SCENE = ['clipped', 'mystery', 'batch', 'multi'].includes(process.argv[2]) ? process.argv[2] : 'hook';

// selected is the 1-based option number across ALL options, drawn or not.
let selected = 1;
let escTimer = null;

function drawHook() {
  const rows = ['Yes', 'No'].map((label, i) => ` ${i + 1 === selected ? '❯' : ' '} ${i + 1}. ${label}`);
  process.stdout.write(`\x1b[2J\x1b[H${[
    ' Hook PreToolUse:Bash requires confirmation for',
    ' this command:',
    ' Broad staging in a shared worktree requires',
    ' explicit permission and a scoped status review.',
    '',
    ' Do you want to proceed?',
    ...rows,
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\r\n')}\r\n`);
}

function drawClipped() {
  const mark = (n) => (n === selected ? '❯' : ' ');
  process.stdout.write(`\x1b[2J\x1b[H${[
    "     own run in the tool (which is what it's",
    "     for), and gets the tool's own validated",
    '     output.',
    `${mark(2)} 2. Hand-build it now`,
    '     I build the census by hand from her files',
    '     and validate it before attaching.',
    `${mark(3)} 3. Re-run it in the tool`,
    '     With your OK I trigger a fresh run on her',
    "     files to produce the tool's own output.",
    `${mark(4)} 4. Type something.`,
    '──────────────────────────────────────────────────',
    `${mark(5)} 5. Chat about this`,
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\r\n')}\r\n`);
}

// ---- multi-select scene ----------------------------------------------------
// Each row carries its own checkbox, which is what makes a toggle verifiable:
// Harbor reads the state back rather than assuming the keystroke landed.
const MULTI_OPTIONS = [
  'Fast boot',
  'Telemetry',
  'Auto update',
  'Crash reports',
];
const multiChecked = new Set();

function drawMulti() {
  const rows = MULTI_OPTIONS.map((label, i) => {
    const n = i + 1;
    return ` ${n === selected ? '❯' : ' '} ${n}. [${multiChecked.has(n) ? 'x' : ' '}] ${label}`;
  });
  // The dialog draws its own TOP EDGE, like the batch scene taken from a real
  // capture does. Without it the question scan has no upper bound and walks into
  // whatever sits above in the pane: gate-caught 2026-07-27, where the shell's
  // echoed "node .../e2e-ask-dialog-sim.js multi" became part of the question.
  // That is the parser behaving as designed (a frameless dialog, like a hook
  // confirmation, keeps the prose above it because those lines are the reason
  // for the choice); this scene was simply drawing an unrealistic screen.
  process.stdout.write(`\x1b[2J\x1b[H${[
    '  Enabling these turns on the optional subsystems.',
    '',
    '─'.repeat(52),
    ' Which features do you want to enable?',
    '',
    ...rows,
    '',
    ' Space to toggle · Enter to confirm · Esc to cancel',
  ].join('\r\n')}\r\n`);
}

let cursor = 1;
function drawMystery() {
  process.stdout.write(`\x1b[2J\x1b[H${[
    ' Continue the migration ritual?',
    ' Do you want to continue?',
    ' (a) Absolutely   (b) Never mind',
    ` cursor:${cursor}`,
    ' Choose a letter · ctrl+q aborts',
  ].join('\r\n')}\r\n`);
}

// ---- batch scene -----------------------------------------------------------
// 50 columns, gutter at 28: the same geometry as the live capture, at the
// width the harness panes are known to hold.
// The real CLI only splits into two columns when the pane is wide enough; in
// a narrow pane it stacks the description under each option. The sim picks
// the same way, so a narrow harness pane yields a REAL narrow shape instead
// of an impossible wrapped-two-column one.
const WIDTH = 50;
const GUTTER = 28;
const PANE_COLS = process.stdout.columns || WIDTH;
const TWO_COLUMN = PANE_COLS >= WIDTH;
const RULE = '─'.repeat(Math.min(WIDTH, PANE_COLS));
// The side panel: the selected option's description, drawn in its own box.
// None of it may ever reach an option label.
const PANEL = [
  '┌────────────────────┐',
  '│ DATE  ▾            │',
  '│  ✂ 18 lines hidden │',
  '│                    │',
  '└────────────────────┘',
];
const QUESTIONS = [
  {
    header: 'Control',
    text: 'How should the custom range appear in the filter?',
    options: [
      {
        title: 'Custom segment + inline pickers',
        recommended: true,
        desc: 'Adds a Custom chip beside the presets, with Start and End pickers.',
      },
      {
        title: 'Always-visible Start / End boxes',
        desc: 'Two date boxes sit in the filter bar at all times.',
      },
    ],
  },
  {
    header: 'Chart',
    text: 'Which totals should a custom range show?',
    options: [
      { title: 'Range total, Daily average, Busiest day', desc: 'The four tiles re-derive from the chosen range.' },
      { title: 'Leave the rolling buckets as they are', desc: 'Today and This week keep their own windows.' },
    ],
  },
  {
    header: 'Period',
    text: 'What should the period title say?',
    options: [
      { title: 'Show the exact dates', desc: 'For example: 1 Jul 2026 to 18 Jul 2026.' },
      { title: 'Show "Custom range"', recommended: true, desc: 'Short and stable however wide the range is.' },
    ],
  },
];
let questionIndex = 0;
const answers = [null, null, null];

// Break text to a column the way the CLI's own wrapper does: whole words,
// never mid-word.
function wrapWords(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && `${line} ${word}`.length > width) { out.push(line); line = word; } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

function drawBatch() {
  const question = QUESTIONS[questionIndex];
  const body = [];
  if (TWO_COLUMN) {
    // Options on the left, the SELECTED option's description boxed on the
    // right. Nothing from that box may reach a label.
    const left = [];
    question.options.forEach((option, i) => {
      const wrapped = wrapWords(option.title, GUTTER - 6);
      left.push(`${i + 1 === selected ? '❯' : ' '} ${i + 1}. ${wrapped[0]}`);
      for (const rest of wrapped.slice(1)) left.push(`    ${rest}`);
      if (option.recommended) left.push('    (Recommended)');
    });
    for (let i = 0; i < Math.max(left.length, PANEL.length); i += 1) {
      body.push(PANEL[i] ? (left[i] || '').padEnd(GUTTER, ' ') + PANEL[i] : left[i]);
    }
    body.push('', `${' '.repeat(GUTTER)}Notes: press n to add`, `${' '.repeat(GUTTER)}notes`);
  } else {
    question.options.forEach((option, i) => {
      const title = option.recommended ? `${option.title} (Recommended)` : option.title;
      body.push(`${i + 1 === selected ? '❯' : ' '} ${i + 1}. ${title}`);
      for (const line of wrapWords(option.desc, Math.max(20, PANE_COLS - 6))) body.push(`     ${line}`);
    });
  }
  const strip = `←  ${QUESTIONS
    .map((q, i) => `${answers[i] ? '☑' : '☐'} ${q.header}`)
    .join('  ')}  ✔ Submit  →`;
  process.stdout.write(`\x1b[2J\x1b[H${[
    '  code path, so a custom range flows into the PDF',
    '  automatically once the date filter understands',
    '  it. Three design forks matter before I build:',
    '',
    RULE,
    strip,
    '',
    question.text,
    '',
    ...body,
    '',
    RULE,
    '  Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · n to add notes',
    'Tab to switch questions · Esc to cancel',
  ].join('\r\n')}\r\n`);
}

const MAX_OPTION = SCENE === 'clipped' ? 5 : SCENE === 'multi' ? MULTI_OPTIONS.length : 2;
const draw = SCENE === 'mystery' ? drawMystery
  : SCENE === 'clipped' ? drawClipped
    : SCENE === 'batch' ? drawBatch
      : SCENE === 'multi' ? drawMulti : drawHook;

function finish(text) {
  process.stdout.write(`\x1b[2J\x1b[H${text}\r\n`);
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdin.resume();
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  if (escTimer) { clearTimeout(escTimer); escTimer = null; }
  for (;;) {
    if (buf.startsWith('\x1b[B')) {
      if (SCENE === 'mystery') cursor += 1;
      else selected = Math.min(MAX_OPTION, selected + 1);
      buf = buf.slice(3); draw(); continue;
    }
    if (buf.startsWith('\x1b[A')) {
      if (SCENE === 'mystery') cursor = Math.max(1, cursor - 1);
      else selected = Math.max(1, selected - 1);
      buf = buf.slice(3); draw(); continue;
    }
    if (SCENE === 'mystery' && /^[ab]/i.test(buf)) { finish(`PICKED:${buf[0].toLowerCase()}`); }
    if (SCENE === 'multi' && buf.startsWith(' ')) {
      if (multiChecked.has(selected)) multiChecked.delete(selected);
      else multiChecked.add(selected);
      buf = buf.slice(1); draw(); continue;
    }
    if (SCENE === 'batch' && buf.startsWith('\t')) {
      questionIndex = (questionIndex + 1) % QUESTIONS.length;
      selected = 1;
      buf = buf.slice(1); draw(); continue;
    }
    if (buf.startsWith('\r') || buf.startsWith('\n')) {
      if (SCENE === 'batch') {
        // A batch answers one question at a time and only submits once every
        // question has an answer, exactly like the real dialog.
        answers[questionIndex] = selected;
        const next = answers.findIndex((answer) => answer === null);
        if (next < 0) finish(`PICKED:${answers.join(',')}`);
        questionIndex = next;
        selected = 1;
        buf = buf.slice(1); draw(); continue;
      }
      if (SCENE === 'multi') {
        finish(`PICKED:${[...multiChecked].sort((a, b) => a - b).join(',') || 'none'}`);
      }
      if (SCENE !== 'mystery') finish(`PICKED:${selected}`);
    }
    if (buf === '\x1b' || buf === '\x1b[') {
      // Possibly a partial arrow sequence; a lone Esc resolves after a beat.
      escTimer = setTimeout(() => finish('CANCELLED'), 120);
      return;
    }
    if (buf.startsWith('\x1b') && !buf.startsWith('\x1b[')) { finish('CANCELLED'); }
    if (!buf.length) return;
    buf = buf.slice(1);
  }
});

// Redraw on SIGWINCH, because the thing this stands in for does. Claude Code
// is an Ink app and Ink re-renders its whole frame when the pty resizes: that
// is what makes Harbor's "grow the pane so the dialog fits" fix heal a dialog
// that is already on screen (proven against a real dialog, 2026-07-27, see
// test/fixtures/askuserquestion/real-claude-120x60.txt). A stand-in that went
// blank on resize instead would make the gate assert the opposite of reality.
process.stdout.on('resize', () => draw());

draw();
