'use strict';

// CODEX'S TUI, READ OFF THE SCREEN (2026-10-15, Codex CLI 0.160.0). Every shape
// here was captured from the real TUI driven in a throwaway pty through the
// daemon's own headless xterm (Unicode 11), the same model Harbor's pane reads
// come from; fixtures in test/fixtures/codex-tui/ are those frames with the
// paths and prose made synthetic. Codex is NOT Claude in a different font, and
// the differences are exactly the ones that made every Claude-keyed guard blind
// to it:
//
//   * The pointer is `›` (U+203A), never `❯`, and the composer has no box: it is
//     one `› text` line at column 0 (wrapped lines indented two) above a status
//     line ("GPT-6-Astra low · /path…", "tab to queue message  94% context left").
//     An empty composer draws the placeholder `› Ask Codex to do anything`.
//   * An APPROVAL replaces the composer: "Would you like to run the following
//     command?" (or "...make the following edits?", "...grant these
//     permissions?", "Do you want to approve network access to ..."), detail
//     lines, then `› 1. Yes, proceed (y)` rows at column 0 and the footer
//     "Press enter to confirm or esc to cancel". Esc is option 3, "No, and tell
//     Codex what to do differently", and it INTERRUPTS the turn.
//   * A request_user_input QUESTION replaces it too: "Question 1/2 (2
//     unanswered)" (later "· auto-resolves in 54s"), the question, two-column
//     rows `  › 1. Red      Choose red.` indented two, a trailing "None of the
//     above" row, and "tab to add notes | enter to submit answer | ←/→ to
//     navigate questions | esc to interrupt". Enter answers and ADVANCES; on the
//     last open question the footer says "enter to submit all" and Enter sends
//     the whole set. Tab opens a notes line (`  › text` under the rows, footer
//     "tab or esc to clear notes | enter to submit all").
//   * That question footer says "esc to interrupt", the very phrase every Claude
//     guard reads as "a working turn, nothing to answer", which is why a send
//     typed into a Codex question and its Enter picked an option.
//   * Anything else that points at numbered rows (the update prompt "enter
//     continue · esc skip", the folder-trust prompt) is still a blocker.
//   * Mid-turn, Enter STEERS ("Messages to be submitted after next tool call
//     (press esc to interrupt and send immediately)", then `↳ text`) and Tab
//     QUEUES ("Queued follow-up inputs"). Esc on a pending steer interrupts and
//     sends it at once ("Model interrupted to submit steer instructions.").
//   * A pasted image path becomes `[Image #N]` in the composer, numbered per
//     message, so a count taken across the whole screen (where the previous
//     message's echo still shows `[Image #1]`) never goes up.

const POINTER = '›';
const ROW_RE = /^(\s*)(›)?\s*(\d+)\.\s+(.+?)\s*$/;
const COMPOSER_RE = /^›(?:\s(.*))?$/;
const PLACEHOLDER_RE = /^Ask Codex to do anything$/;
// The status line of a turn in flight. Plain, it reads "• Working (12s • esc to
// interrupt)"; once the model streams a reasoning summary, Codex shows that
// summary's TITLE instead of "Working" ("• Inspecting the repo (12s • esc to
// interrupt)"), so the header word cannot be the test. What every form keeps
// is the elapsed-time tail, "(<n>s • esc to interrupt)" with Codex's compact
// elapsed ("12s", "1m 05s", "1h 02m 03s"). The bullet blinks between • and ◦.
// Neither the question footer ("… | esc to interrupt") nor a pending steer's
// hint ("(press esc to interrupt and send immediately)") carries that tail.
const WORKING_RE = /^\s*[•◦]\s+(?:Working\b.*esc to interrupt|.*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*•\s*esc to interrupt\))/i;

const APPROVAL_FOOTER_RE = /^\s*Press enter to confirm or esc to cancel\s*$/i;
const APPROVAL_QUESTION_RE = /^\s*(Would you like to (?:run the following command|make the following edits|grant these permissions|send input to [^?]*)\?|Do you want to approve network access to .+|.+ needs your approval\.)\s*$/i;
const QUESTION_FOOTER_RE = /enter to submit (?:answer|all)|tab or esc to clear notes/i;
const QUESTION_HEADER_RE = /^\s*Question (\d+)\/(\d+)(?:\s*\((\d+) unanswered\))?(?:\s*·\s*auto-resolves in (\d+)s)?/i;
const NONE_OF_ABOVE_RE = /^None of the above$/i;
// The trailing single-key hint Codex prints after an approval option, e.g.
// "Yes, proceed (y)", "No, and tell Codex what to do differently (esc)".
const HOTKEY_RE = /\s+\(([a-z]|esc)\)$/i;
// A generic picker's footer names its keys: "enter continue · esc skip",
// "Press enter to continue and create a sandbox...".
const GENERIC_FOOTER_RE = /\benter\b.*|\besc\b.*/i;
const STATUS_LINE_RE = /context left|·\s*\/|tab to queue message|f2 to view|esc to interrupt/i;

const PENDING_HEADERS = [
  { re: /^\s*•\s+Messages to be submitted after next tool call/i, kind: 'steer' },
  { re: /^\s*•\s+Messages to be submitted at end of turn/i, kind: 'queued' },
  { re: /^\s*•\s+Queued follow-up inputs/i, kind: 'queued' },
];

const lineList = (screen) => String(screen || '').split('\n').map((line) => line.replace(/\r$/, ''));
const blank = (line) => !String(line || '').trim();
const lastTextIndex = (lines) => {
  for (let i = lines.length - 1; i >= 0; i -= 1) if (!blank(lines[i])) return i;
  return -1;
};

// The run of numbered rows ending directly above `end` (blank lines allowed
// between the run and `end`), ascending from 1, with wrapped continuation lines
// folded into the row above. Returns { options, first, last } or null.
function optionRunAbove(lines, end) {
  let last = end - 1;
  while (last >= 0 && blank(lines[last])) last -= 1;
  const rows = [];
  let i = last;
  let pendingWrap = [];
  for (; i >= 0; i -= 1) {
    const line = lines[i];
    if (blank(line)) break;
    const row = ROW_RE.exec(line);
    if (row) {
      rows.unshift({ line: i, indent: row[1].length, selected: Boolean(row[2]), index: Number(row[3]), text: row[4], wrap: pendingWrap });
      pendingWrap = [];
      if (Number(row[3]) === 1) break;
      continue;
    }
    // A continuation: indented deeper than a row's number column.
    if (/^\s{3,}\S/.test(line)) { pendingWrap.unshift(line.trim()); continue; }
    break;
  }
  if (!rows.length || pendingWrap.length || rows[0].index !== 1) return null;
  for (let r = 1; r < rows.length; r += 1) if (rows[r].index !== rows[r - 1].index + 1) return null;
  return { rows, first: rows[0].line, last };
}

// Codex APPROVAL prompt -> the same menu shape menu-parse returns for Claude's
// permission prompts, so the permission card and its one-click answers apply.
function parseApproval(lines) {
  const footerAt = lastTextIndex(lines);
  if (footerAt < 0 || !APPROVAL_FOOTER_RE.test(lines[footerAt])) return null;
  const run = optionRunAbove(lines, footerAt);
  if (!run) return null;
  let questionAt = -1;
  for (let i = run.first - 1; i >= 0 && i >= run.first - 40; i -= 1) {
    if (APPROVAL_QUESTION_RE.test(lines[i])) { questionAt = i; break; }
  }
  if (questionAt < 0) return null;
  const question = lines[questionAt].trim();
  const options = run.rows.map((row) => {
    const label = [row.text, ...row.wrap].join(' ').replace(/\s+/g, ' ').trim();
    const hot = HOTKEY_RE.exec(label);
    return {
      index: row.index,
      label: hot ? label.slice(0, hot.index).trim() : label,
      description: '',
      recommended: false,
      selected: row.selected,
      isText: false,
      ...(hot ? { key: hot[1].toLowerCase() } : {}),
    };
  });
  const body = lines.slice(questionAt + 1, run.first).map((line) => line.replace(/^ {2}/, ''));
  const blocks = [];
  let buffer = [];
  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) blocks.push({ type: 'text', text });
    buffer = [];
  };
  for (const line of body) {
    if (blank(line)) { flush(); continue; }
    const command = /^\$\s+(.*)$/.exec(line);
    if (command) { flush(); blocks.push({ type: 'code', text: command[1] }); continue; }
    buffer.push(line.trimEnd());
  }
  flush();
  const command = /run the following command/i.test(question);
  const edits = /make the following edits/i.test(question);
  const network = /network access/i.test(question);
  const toolTitle = command ? 'Run command' : edits ? 'Edit files' : network ? 'Network access' : 'Permission';
  const footer = lines[footerAt].trim();
  return {
    provider: 'codex',
    question,
    options,
    tabs: null,
    keys: { switchQuestions: false, notes: false, amend: false, explain: false, toggle: false },
    notesKey: null,
    multiSelect: false,
    clipped: false,
    confirmSelected: false,
    submitReview: false,
    reviewAnswers: [],
    footer,
    acceptsText: false,
    selectedIndex: options.some((o) => o.selected) ? options.findIndex((o) => o.selected) : null,
    permission: {
      toolTitle,
      ...(command ? { toolName: 'Bash' } : edits ? { toolName: 'Edit' } : {}),
      blocks,
      question,
      canCancel: true,
    },
  };
}

// Codex request_user_input picker -> the AskUserQuestion menu shape.
function parseQuestion(lines) {
  const footerAt = lastTextIndex(lines);
  if (footerAt < 0 || !QUESTION_FOOTER_RE.test(lines[footerAt])) return null;
  const footer = lines[footerAt].trim();
  let headerAt = -1;
  for (let i = footerAt - 1; i >= 0 && i >= footerAt - 60; i -= 1) {
    if (QUESTION_HEADER_RE.test(lines[i])) { headerAt = i; break; }
  }
  if (headerAt < 0) return null;
  const header = QUESTION_HEADER_RE.exec(lines[headerAt]);
  // Rows, the optional notes line, then the footer.
  let notes = null;
  let rowsEnd = footerAt;
  const notesMode = /tab or esc to clear notes/i.test(footer);
  if (notesMode) {
    // The note is a `  › text` line under the rows, and a note longer than
    // the pane is wide WRAPS onto indented continuation lines below it. Reading
    // only the line above the footer made a wrapped note fail the parse, the
    // card vanished, and a send then pasted into the note and its Enter
    // submitted every answer. So walk up from the footer
    // over the continuation lines to the `›` line that opens the note.
    let n = footerAt - 1;
    while (n > headerAt && blank(lines[n])) n -= 1;
    const wrapped = [];
    for (; n > headerAt; n -= 1) {
      const line = lines[n] || '';
      if (ROW_RE.test(line)) break;
      const notesLine = /^\s*›\s?(.*)$/.exec(line);
      if (notesLine) {
        const text = [notesLine[1].trim(), ...wrapped].join(' ').trim();
        notes = !wrapped.length && PLACEHOLDER_NOTES_RE.test(text) ? '' : text;
        rowsEnd = n;
        break;
      }
      if (blank(line) || !/^\s{2,}\S/.test(line)) break;
      wrapped.unshift(line.trim());
    }
  }
  const run = optionRunAbove(lines, rowsEnd);
  if (!run || run.first <= headerAt) return null;
  const questionText = [];
  for (let i = headerAt + 1; i < run.first; i += 1) {
    if (blank(lines[i])) { if (questionText.length) break; continue; }
    questionText.push(lines[i].trim());
  }
  const options = run.rows.map((row) => {
    const split = /^(.*?\S)\s{2,}(\S.*)$/.exec(row.text);
    const label = (split ? split[1] : row.text).trim();
    const description = [split ? split[2] : '', ...row.wrap].join(' ').replace(/\s+/g, ' ').trim();
    return {
      index: row.index,
      label,
      description,
      recommended: false,
      selected: row.selected,
      // "None of the above" + a note is Codex's free-form answer: the card's
      // text row lands on it, opens notes with Tab, and types the answer there.
      isText: NONE_OF_ABOVE_RE.test(label),
    };
  });
  const index = Number(header[1]);
  const count = Number(header[2]);
  return {
    provider: 'codex',
    question: questionText.join(' ').replace(/\s+/g, ' ').trim(),
    options,
    // Codex draws no tab strip, only "Question i/N". Positional tabs keep the
    // batch machinery (question switching, staged sheet) working; which ones
    // are answered is NOT on screen, so `done` stays false rather than guessed.
    tabs: count > 1
      ? Array.from({ length: count }, (_, i) => ({ label: `Question ${i + 1}`, done: false, submit: false }))
      : null,
    keys: {
      switchQuestions: count > 1 && /←\/→ to navigate questions/i.test(footer),
      notes: /tab to add notes/i.test(footer) || notesMode,
      amend: false,
      explain: false,
      toggle: false,
    },
    notesKey: '\t',
    multiSelect: false,
    clipped: false,
    confirmSelected: false,
    submitReview: false,
    reviewAnswers: [],
    footer,
    acceptsText: options.some((o) => o.isText),
    selectedIndex: options.some((o) => o.selected) ? options.findIndex((o) => o.selected) : null,
    codex: {
      kind: 'question',
      questionIndex: index - 1,
      questionCount: count,
      unanswered: header[3] == null ? null : Number(header[3]),
      autoResolveSeconds: header[4] == null ? null : Number(header[4]),
      submitsAll: /enter to submit all/i.test(footer),
      notesOpen: notes != null,
      notes,
    },
  };
}
const PLACEHOLDER_NOTES_RE = /^Add notes$/i;

// Any other Codex picker: a `›`-pointed numbered run whose footer names enter
// or esc (update prompt, folder trust). Labeled buttons, nothing more.
function parseGenericPicker(lines) {
  const footerAt = lastTextIndex(lines);
  if (footerAt < 0) return null;
  const footer = lines[footerAt].trim();
  if (!GENERIC_FOOTER_RE.test(footer) || STATUS_LINE_RE.test(footer) || ROW_RE.test(lines[footerAt])) return null;
  const run = optionRunAbove(lines, footerAt);
  if (!run || !run.rows.some((row) => row.selected) || run.rows[0].indent > 2) return null;
  const question = [];
  for (let i = run.first - 1; i >= 0 && question.length < 6; i -= 1) {
    if (blank(lines[i])) { if (question.length) break; continue; }
    question.unshift(lines[i].trim());
  }
  const options = run.rows.map((row) => ({
    index: row.index,
    label: [row.text, ...row.wrap].join(' ').replace(/\s+/g, ' ').trim(),
    description: '',
    recommended: false,
    selected: row.selected,
    isText: false,
  }));
  return {
    provider: 'codex',
    question: question.join(' '),
    options,
    tabs: null,
    keys: { switchQuestions: false, notes: false, amend: false, explain: false, toggle: false },
    notesKey: null,
    multiSelect: false,
    clipped: false,
    confirmSelected: false,
    submitReview: false,
    reviewAnswers: [],
    footer,
    acceptsText: false,
    selectedIndex: options.some((o) => o.selected) ? options.findIndex((o) => o.selected) : null,
    codex: { kind: 'picker' },
  };
}

function parseCodexMenu(screen) {
  const lines = lineList(screen);
  while (lines.length && blank(lines.at(-1))) lines.pop();
  if (!lines.length || !lines.some((line) => line.includes(POINTER))) return null;
  return parseApproval(lines) || parseQuestion(lines) || parseGenericPicker(lines);
}

// The composer: the last column-0 `›` line in the bottom of the screen, with its
// two-space continuation lines. Null when no composer is drawn (a dialog has
// replaced it) or a Codex dialog is on screen.
const BOTTOM_LINES = 14;
function codexComposer(screen) {
  const lines = lineList(screen);
  while (lines.length && blank(lines.at(-1))) lines.pop();
  if (parseCodexMenu(lines.join('\n'))) return null;
  // A dialog footer at the bottom means a dialog is drawn where the composer
  // goes, even one whose body did not parse; a prompt echo `› text` above it
  // is not a composer.
  const footer = lines.at(-1) || '';
  if (APPROVAL_FOOTER_RE.test(footer) || QUESTION_FOOTER_RE.test(footer)) return null;
  // The composer sits in the bottom BOTTOM_LINES lines, but a tall draft
  // pushes its own `›` line above that window; it still counts when its
  // continuation lines reach down into it. The LAST `›` line decides: an older
  // one higher up is a prompt echo, never the composer.
  const floor = lines.length - BOTTOM_LINES;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = COMPOSER_RE.exec(lines[i]);
    if (!match) continue;
    const parts = [match[1] || ''];
    let j = i + 1;
    for (; j < lines.length && /^ {2}\S/.test(lines[j]) && !STATUS_LINE_RE.test(lines[j]); j += 1) parts.push(lines[j].trim());
    if (i < floor && j <= floor) return null;
    const text = parts.join(' ').trim();
    return { line: i, end: j, text: PLACEHOLDER_RE.test(text) ? '' : text, placeholder: PLACEHOLDER_RE.test(text) };
  }
  return null;
}

// Messages Codex is holding for this turn: `steer` (Enter mid-turn; delivered
// after the next tool call, or at once on Esc) and `queued` (Tab; delivered
// when the turn ends).
function codexPendingInputs(screen) {
  const lines = lineList(screen);
  const out = { steer: [], queued: [] };
  let kind = null;
  for (const line of lines) {
    const header = PENDING_HEADERS.find((entry) => entry.re.test(line));
    if (header) { kind = header.kind; continue; }
    if (!kind) continue;
    const item = /^\s*↳\s?(.*)$/.exec(line);
    if (item) { out[kind].push(item[1].trim()); continue; }
    if (/^\s{4,}\S/.test(line) && out[kind].length && !/edit last queued message/i.test(line)) {
      out[kind][out[kind].length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (blank(line) || /edit last queued message/i.test(line)) continue;
    kind = null;
  }
  return out;
}

const isCodexWorking = (screen) => lineList(screen).slice(-30).some((line) => WORKING_RE.test(line));

// The TUI at rest: a composer is drawn, no dialog replaces it, and nothing in
// the bottom of the screen offers "esc to interrupt" (the working line, under
// whatever header Codex gives it, and a pending steer's hint both do). This is
// what a session whose rollout still says "working" or "question pending"
// looks like after the turn died under it and the session was resumed: the
// screen is the only witness that the turn is gone.
// An empty or unreadable screen is never idle.
// Every line isCodexWorking accepts says "esc to interrupt", so the second
// test is a superset of the first: whatever reads as working never reads idle.
function isCodexIdle(screen) {
  if (!screen || !codexComposer(screen)) return false;
  return !lineList(screen).slice(-30).some((line) => WORKING_RE.test(line) || /esc to interrupt/i.test(line));
}

// Where a send stands, from one read. Same contract as composerSendState for
// Claude: `holds` (the composer ENDS with this send), `taken` (echoed above the
// composer: a submitted prompt, a pending steer or a queued follow-up), else
// `pending`; `nobox` when no composer is drawn.
const SEND_TAIL_CHARS = 24;
const squash = (value) => String(value || '').replace(/\s+/g, '');
const PASTED_RE = /\[PastedContent\d+chars\]/;
function codexSendState(screen, { text = '', pasted = false, imageMarker = null } = {}) {
  const composer = codexComposer(screen);
  if (!composer) return 'nobox';
  const lines = lineList(screen);
  const inside = squash(composer.text);
  const above = squash(lines.slice(0, composer.line).join('\n'));
  const tail = squash(text).slice(-SEND_TAIL_CHARS);
  const marker = squash(imageMarker);
  if (tail ? inside.endsWith(tail) : Boolean(marker && inside.endsWith(marker))) return 'holds';
  if (pasted && new RegExp(`${PASTED_RE.source}$`).test(inside)) return 'holds';
  if (tail ? above.includes(tail) : Boolean(marker && above.includes(marker))) return 'taken';
  if (pasted && PASTED_RE.test(above)) return 'taken';
  return 'pending';
}

// The highest `[Image #N]` in the COMPOSER only (see the header).
function composerImageCount(screen) {
  const composer = codexComposer(screen);
  if (!composer) return null;
  return (composer.text.match(/\[Image #(\d+)\]/g) || [])
    .reduce((max, marker) => Math.max(max, Number(marker.match(/\d+/)[0])), 0);
}

// A Codex dialog of any kind is up (the send refusal and the card share this).
function isCodexBlocked(screen) {
  return Boolean(parseCodexMenu(screen));
}

module.exports = {
  parseCodexMenu,
  codexComposer,
  codexPendingInputs,
  codexSendState,
  composerImageCount,
  isCodexBlocked,
  isCodexWorking,
  isCodexIdle,
};
