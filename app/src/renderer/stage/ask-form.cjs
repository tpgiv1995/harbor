'use strict';

// THE QUESTION FORM'S MODEL (2026-09-05). Pure, so the whole thing has tests.
//
// A question card built from the hook's JSON is a FORM, not a remote control:
// every question of the batch is on one sheet, each with its options, a
// free-text "other" row, an optional note, and a skip. Nothing here talks to
// a pty. The only exit is one payload of `answers` + `annotations`, exactly
// the shape the CLI's own AskUserQuestion input documents, or a decline
// carrying a reply.
//
// Rules that came from the 2026-09-04 report ("wouldn't take my note, then
// wouldn't let me submit, then wouldn't let me go back"):
// - typing a note NEVER changes whether a question counts as answered, and a
//   note is kept whatever else happens to that question;
// - Submit is never a dead button: when questions are unanswered it says how
//   many and the caller scrolls to the first one; a question can also be
//   skipped outright and the batch still submits;
// - free text is an answer in its own right ("other"), for single and multi.

function entryFor(state, q) {
  return state.byIndex[q] || { picks: [], text: '', note: '', noteOpen: false, skipped: false };
}

function initialForm(questions = []) {
  const byIndex = {};
  questions.forEach((_, i) => { byIndex[i] = { picks: [], text: '', note: '', noteOpen: false, skipped: false }; });
  return { byIndex, focus: 0 };
}

function withEntry(state, q, patch) {
  return { ...state, byIndex: { ...state.byIndex, [q]: { ...entryFor(state, q), ...patch } } };
}

function reduce(state, questions, action) {
  const q = Number.isInteger(action?.q) ? action.q : state.focus;
  const question = questions[q];
  switch (action?.type) {
    case 'focus':
      return q === state.focus ? state : { ...state, focus: q };
    case 'pick': {
      if (!question || !question.options[action.option]) return state;
      const entry = entryFor(state, q);
      const picks = question.multiSelect
        ? (entry.picks.includes(action.option) ? entry.picks.filter((p) => p !== action.option) : [...entry.picks, action.option].sort((a, b) => a - b))
        : [action.option];
      // Single-select: a pick and typed text are one choice, exactly as the
      // CLI's own "Type something" row is one of the options. Picking clears
      // the text so the screen never shows an option lit while the text would
      // have been sent (review finding, 2026-09-05).
      return withEntry({ ...state, focus: q }, q, question.multiSelect ? { picks, skipped: false } : { picks, text: '', skipped: false });
    }
    case 'text': {
      const text = String(action.value ?? '');
      const entry = entryFor(state, q);
      const clearsPick = question && !question.multiSelect && text.trim().length > 0 && entry.picks.length > 0;
      return withEntry({ ...state, focus: q }, q, clearsPick ? { text, picks: [], skipped: false } : { text, skipped: false });
    }
    case 'note':
      return withEntry(state, q, { note: String(action.value ?? ''), noteOpen: true });
    case 'noteOpen':
      return withEntry(state, q, { noteOpen: Boolean(action.open) });
    case 'skip':
      return withEntry({ ...state, focus: q }, q, { skipped: true, picks: [], text: '' });
    case 'unskip':
      return withEntry(state, q, { skipped: false });
    default:
      return state;
  }
}

function settled(entry) {
  return entry.skipped || entry.picks.length > 0 || entry.text.trim().length > 0;
}

function status(questions, state) {
  const missing = [];
  let answered = 0;
  let skipped = 0;
  questions.forEach((_, i) => {
    const entry = entryFor(state, i);
    if (entry.skipped) skipped += 1;
    else if (settled(entry)) answered += 1;
    else missing.push(i);
  });
  return { complete: missing.length === 0, missing, answered, skipped, total: questions.length };
}

function answerText(question, entry) {
  const labels = entry.picks.map((p) => question.options[p]?.label).filter(Boolean);
  const text = entry.text.trim();
  if (question.multiSelect) return [...labels, ...(text ? [text] : [])].join(', ');
  return text || labels[0] || '';
}

// The payload the inbox writes and the hook turns into the tool's input.
// A note travels whether or not its question was answered: a skipped
// question with a note still tells Claude something (review finding,
// 2026-09-05: the first shape dropped that note on the floor while the button
// kept saying "Note added").
function toPayload(questions, state) {
  const answers = {};
  const annotations = {};
  questions.forEach((question, i) => {
    const entry = entryFor(state, i);
    const note = entry.note.trim();
    if (note) {
      const selected = question.options[entry.picks[0]];
      annotations[question.question] = { notes: note, ...(selected?.preview && !entry.skipped ? { preview: selected.preview } : {}) };
    }
    if (entry.skipped || !settled(entry)) return;
    answers[question.question] = answerText(question, entry);
  });
  return { answers, annotations };
}

// Every note the user typed, as one readable text: the seed for "Reply
// instead" and the reply itself when nothing was answered but notes exist.
function notesText(questions, state) {
  const parts = [];
  questions.forEach((question, i) => {
    const note = entryFor(state, i).note.trim();
    if (note) parts.push(`${question.header || `Question ${i + 1}`}: ${note}`);
  });
  return parts.join('\n');
}

// Which option's preview to show for a question: the hovered/highlighted one
// if the caller has one, else the selected one, else the first with a preview.
function previewFor(question, entry, highlighted = null) {
  const candidates = [highlighted, entry.picks[0], question.options.findIndex((o) => o.preview)].filter((i) => Number.isInteger(i) && i >= 0);
  for (const i of candidates) {
    const preview = question.options[i]?.preview;
    if (preview) return { option: i, preview };
  }
  return null;
}

// Keyboard: digits pick within the focused question; Enter submits a complete
// sheet (never from inside a text field, where Enter is the field's own);
// Escape leaves a field. Tab is never taken so the form cannot trap focus.
function keyAction(event, questions, state, { inTextField = false } = {}) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (inTextField) return event.key === 'Escape' ? { type: 'blur' } : null;
  if (/^[1-9]$/.test(event.key)) {
    const option = Number(event.key) - 1;
    return questions[state.focus]?.options[option] ? { type: 'pick', q: state.focus, option } : null;
  }
  if (event.key === 'Enter') return status(questions, state).complete ? { type: 'submit' } : { type: 'goto-missing' };
  return null;
}

module.exports = { initialForm, reduce, status, toPayload, notesText, answerText, previewFor, keyAction, entryFor };
