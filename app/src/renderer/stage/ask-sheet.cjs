'use strict';

// The answer sheet: the question card's whole model, pure and unit-tested.
//
// Rebuilt 2026-09-03 after Pat's "Q&A interface busted ... clunky from the
// start". The old card was a remote control for the pty: every arrow was a
// keystroke into the pane followed by a 700ms poll, question 2 of a batch was
// reachable only through Previous/Next buttons, and the card only ever showed
// the ONE question the pane happened to be drawing. The sheet lays the whole
// batch out as a form, keeps every choice LOCAL until one Submit, and hands the
// pty exactly one delivery (session-send.js `sheet` action) that verifies each
// step.
//
// Where the batch comes from: the pty. Measured the same day, Claude Code
// v2.1.258 writes nothing from the assistant turn to the transcript until the
// question is answered, so session-send.js discovers a batch by walking the
// dialog once and the merge (ask-question.js) lays it onto the current screen
// as `asked` + `batch`. The transcript stays in front of that as an additive
// enhancement. `menu` here is that merged menu-state payload.
//
// Two modes, decided by the shape of what was asked and nothing else:
//   immediate  a lone single-select question (an AskUserQuestion with one
//              question, a permission prompt, the resume dialog): one click is
//              the answer, exactly as before, because a form with a Submit
//              button under a Yes/No is slower than the thing it replaces.
//   staged     a batch, or any multi-select question: clicks mark the sheet,
//              one Submit delivers it all.

const CHAT_ROW_RE = /^chat about this$/i;
const TEXT_ROW = 'text';

function isTextEntry(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return Boolean(target.isContentEditable);
}

function isActivatableControl(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'a') return true;
  return String(target.getAttribute?.('role') || '') === 'button';
}

// One of the sheet's OWN option rows (they carry data-ask-row). Roving focus
// puts the highlighted row's button under the keyboard, so Enter and Space
// there belong to the SHEET, never to the button's native click: driven live
// in the harness 2026-09-03, Enter on a focused row toggled it again instead
// of submitting a complete sheet, and no unit test could see that.
function isOwnRow(target) {
  if (!target) return false;
  if (target.dataset && target.dataset.askRow != null) return true;
  return target.getAttribute?.('data-ask-row') != null;
}

function questionFromPty(menu) {
  const rows = Array.isArray(menu?.options) ? menu.options : [];
  const chatRow = rows.find((row) => !row.isText && CHAT_ROW_RE.test(row.label || '')) || null;
  // Once something is typed on the free-text row the CLI rewrites its label to
  // the typed words and it no longer reads as a text row; it is still the row
  // just above Chat. It is exposed as typedText, never as an option, so the
  // delivery neither unticks it nor offers it as a choice (review-caught
  // 2026-09-03).
  const typedRow = !rows.some((row) => row.isText) && chatRow
    ? rows.find((row) => !row.isText && row.index === chatRow.index - 1) || null
    : null;
  const textRow = rows.find((row) => row.isText) || typedRow;
  const options = rows
    .filter((row) => !row.isText && row !== chatRow && row !== typedRow)
    .map((row) => ({
      index: row.index,
      label: row.label,
      description: row.description || '',
      recommended: Boolean(row.recommended),
      checked: row.checked,
      offscreen: Boolean(row.offscreen),
      selected: Boolean(row.selected),
    }));
  return {
    index: 0,
    header: menu?.header || '',
    question: menu?.question || '',
    multiSelect: Boolean(menu?.multiSelect),
    options,
    acceptsText: Boolean(textRow),
    textIndex: textRow ? textRow.index : null,
    textLabel: typedRow ? 'Type something' : (textRow ? String(textRow.label || '').replace(/[.…]+$/, '') : ''),
    typedText: typedRow ? String(typedRow.label || '') : '',
    typedTicked: typedRow ? typedRow.checked === true : false,
    chatIndex: chatRow ? chatRow.index : null,
    answered: null,
    current: true,
    highlighted: rows.find((row) => row.selected)?.index ?? null,
  };
}

function questionsFromBatch(menu) {
  const asked = menu.asked;
  const batch = menu.batch;
  const currentIndex = batch ? batch.currentIndex : 0;
  const onScreen = questionFromPty(menu);
  return asked.map((question, i) => {
    const current = i === currentIndex;
    const count = question.options.length;
    // The question on screen carries the pty's own facts: which row is
    // highlighted, whether a checkbox is ticked, and where its extra rows are.
    // The others are laid out in the CLI's numbering.
    const live = current ? onScreen : null;
    const options = question.options.map((option, k) => {
      const seen = live ? live.options.find((row) => row.index === k + 1) : null;
      return {
        index: k + 1,
        label: option.label,
        description: option.description || '',
        recommended: Boolean(option.recommended),
        checked: seen ? seen.checked : undefined,
        // Only the question on screen can have rows the pane clipped; a
        // question the sheet merely is not showing yet is fully answerable.
        offscreen: seen ? seen.offscreen : false,
        selected: seen ? seen.selected : false,
      };
    });
    return {
      index: i,
      header: question.header || batch?.headers?.[i]?.header || `Question ${i + 1}`,
      question: question.question,
      multiSelect: Boolean(question.multiSelect),
      options,
      acceptsText: true,
      textIndex: live?.textIndex ?? count + 1,
      textLabel: live?.textLabel || 'Type something',
      typedText: live?.typedText || '',
      typedTicked: Boolean(live?.typedTicked),
      chatIndex: live?.chatIndex ?? count + 2,
      // The strip's own ☒: answered in the terminal already (or ticked, for a
      // multi-select). Null when the strip is not on screen.
      answered: batch?.headers?.[i]?.answered ?? null,
      current,
      highlighted: live ? live.highlighted : null,
    };
  });
}

// Build the sheet from a menu-state payload, or null when there is nothing to
// lay out (no menu, or the raw-screen fallback, which is its own panel).
function buildSheet(menu) {
  if (!menu || menu.fallback || !Array.isArray(menu.options)) return null;
  const keys = menu.keys || {};
  const permission = Boolean(keys.amend || keys.explain);
  if (menu.review) {
    const submitRow = menu.options.find((row) => /^submit answers$/i.test(row.label || ''));
    const cancelRow = menu.options.find((row) => /^cancel$/i.test(row.label || ''));
    // The review lists one "→ answer" per ANSWERED question, in batch order,
    // so the k-th listed answer belongs to the k-th header the strip marks ☒.
    const listed = Array.isArray(menu.reviewAnswers) ? [...menu.reviewAnswers] : [];
    const headers = (menu.batch?.headers || []).map((h) => ({
      ...h,
      answer: h.answered === false ? null : (listed.shift() ?? null),
    }));
    return {
      kind: 'review',
      mode: 'immediate',
      questions: [],
      currentIndex: -1,
      submitIndex: submitRow ? submitRow.index : null,
      cancelIndex: cancelRow ? cancelRow.index : null,
      headers,
      // Submit is offered only when nothing is open, the staged delivery's
      // own rule; the CLI's warning line is the second witness.
      complete: !headers.some((h) => h.answered === false) && !/you have not answered all questions/i.test(menu.question || ''),
      keys,
      clipped: false,
      notesKey: null,
    };
  }
  const fromBatch = Array.isArray(menu.asked) && menu.asked.length > 0 && menu.batch !== undefined;
  const questions = fromBatch ? questionsFromBatch(menu) : [questionFromPty(menu)];
  const kind = permission ? 'permission' : (menu.footer === '' && !fromBatch ? 'resume' : 'ask');
  const staged = questions.length > 1 || questions.some((question) => question.multiSelect);
  return {
    kind,
    mode: staged ? 'staged' : 'immediate',
    questions,
    currentIndex: Math.max(0, questions.findIndex((question) => question.current)),
    source: fromBatch ? 'batch' : 'pty',
    clipped: Boolean(menu.ptyClipped ?? menu.clipped),
    keys,
    notesKey: menu.notesKey || null,
  };
}

// A stable key for "is this the same dialog as a moment ago": local answers
// survive polls of the same dialog and reset when a different one appears.
// Option labels and the multi-select shape are part of it, so a new dialog
// with the same wording never inherits numbered picks made against the old
// one (review-caught 2026-09-03).
function sheetIdentity(sheet) {
  if (!sheet) return '';
  const parts = sheet.questions.map((q) => [
    q.header, q.question, q.multiSelect ? 'm' : 's', q.options.map((o) => o.label).join(''),
  ].join(''));
  return `${sheet.kind}:${sheet.questions.length}:${parts.join('')}`;
}

function rowsOf(question) {
  const rows = question.options.map((option) => option.index);
  if (question.acceptsText) rows.push(TEXT_ROW);
  return rows;
}

function initialState(sheet) {
  if (!sheet) return { q: 0, row: null, answers: {}, drafts: {} };
  const q = Math.max(0, sheet.currentIndex);
  const question = sheet.questions[q] || null;
  const rows = question ? rowsOf(question) : [];
  const highlighted = question?.highlighted;
  const row = highlighted != null && rows.includes(highlighted)
    ? highlighted
    : (highlighted != null && highlighted === question?.textIndex ? TEXT_ROW : (rows[0] ?? null));
  const answers = {};
  const drafts = {};
  // A multi-select question on screen already shows its ticks; start from them
  // so the sheet never claims fewer ticks than the pane draws. Text already
  // typed on its free-text row rides along the same way.
  if (question?.multiSelect) {
    const ticked = question.options.filter((option) => option.checked === true).map((option) => option.index);
    const text = question.typedTicked ? question.typedText : '';
    if (ticked.length || text) answers[q] = { kind: 'multi', indexes: ticked, text };
    if (text) drafts[q] = text;
  }
  return { q, row, answers, drafts };
}

function normKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Which question in the OLD sheet the new sheet's question continues, so local
// input survives a poll that merely RE-REPRESENTS the same dialog rather than
// replacing it. The 700ms poll legitimately re-draws the same AskUserQuestion in
// different shapes: the whole batch when mergeAsk matches the transcript onto the
// screen, a single on-screen question when the match momentarily fails, and
// option labels that flip between the transcript's full text and the pty's
// truncated text. Match on the header first (the most stable signal), then the
// question text (prefix-tolerant, since one side may be truncated), then, only
// when neither side names the question and the counts line up, position. -1 when
// nothing corresponds, which is a genuinely different dialog.
function findContinuedQuestion(oldSheet, newSheet, newQ, newIndex) {
  if (!oldSheet || !Array.isArray(oldSheet.questions) || !oldSheet.questions.length) return -1;
  const nH = normKey(newQ.header);
  if (nH) {
    const j = oldSheet.questions.findIndex((oq) => normKey(oq.header) === nH);
    if (j >= 0) return j;
  }
  const nQ = normKey(newQ.question);
  if (nQ) {
    const j = oldSheet.questions.findIndex((oq) => {
      const oQ = normKey(oq.question);
      if (!oQ) return false;
      if (oQ === nQ) return true;
      const short = oQ.length < nQ.length ? oQ : nQ;
      return short.length >= 8 && (oQ.startsWith(nQ) || nQ.startsWith(oQ));
    });
    if (j >= 0) return j;
  }
  if (!nH && !nQ && oldSheet.questions.length === newSheet.questions.length) {
    const oq = oldSheet.questions[newIndex];
    if (oq && !normKey(oq.header) && !normKey(oq.question)) return newIndex;
  }
  return -1;
}

// Rebuild state for a NEW sheet without throwing away local input for a dialog
// that is still the same one, only re-drawn. `initialState` seeds the fresh
// current/highlight (and any ticks the pane already shows); on top of that every
// draft and staged answer whose question the new sheet still has is carried
// forward, dropping only what no longer fits (a multi index the option set lost,
// a select whose option is gone). A poll that yields NO sheet keeps the whole
// state untouched, so a dialog blinking out of the parse for one tick never
// costs the user their typing. This REPLACES the old hard reset, which wiped
// every draft and pick on any identity change (live-caught 2026-09-04, Pat: a
// free-form answer "literally deleted what i had out of nowhere").
function resync(oldState, oldSheet, newSheet) {
  if (!newSheet) return oldState;
  const base = initialState(newSheet);
  if (!oldState) return base;
  const drafts = { ...base.drafts };
  const answers = { ...base.answers };
  newSheet.questions.forEach((nq, i) => {
    const oi = findContinuedQuestion(oldSheet, newSheet, nq, i);
    if (oi < 0) return;
    const draft = oldState.drafts[oi];
    if (typeof draft === 'string' && draft !== '') drafts[i] = draft;
    const answer = oldState.answers[oi];
    if (!answer) return;
    if (answer.kind === 'multi') {
      const indexes = answer.indexes.filter((ix) => nq.options.some((o) => o.index === ix));
      const text = answer.text || '';
      if (indexes.length || text.trim()) answers[i] = { kind: 'multi', indexes, text };
    } else if (answer.kind === 'select') {
      if (nq.options.some((o) => o.index === answer.index)) answers[i] = answer;
    } else if (answer.kind === 'text') {
      if (answer.text && answer.text.trim()) answers[i] = answer;
    }
  });
  return { ...base, drafts, answers };
}

function answerOf(state, q) {
  return state.answers[q] || null;
}

// Answered locally, or already answered in the terminal (the strip's ☒) with
// nothing staged over it. A terminal answer counts toward completion and is
// left alone by the delivery; a local answer for the same question overrides.
function isAnswered(sheet, state, q) {
  const answer = answerOf(state, q);
  if (!answer) return sheet.questions[q]?.answered === true;
  if (answer.kind === 'multi') return answer.indexes.length > 0 || Boolean(answer.text && answer.text.trim());
  if (answer.kind === 'text') return Boolean(answer.text.trim());
  return true;
}

function answeredInTerminal(sheet, state, q) {
  return !answerOf(state, q) && sheet.questions[q]?.answered === true;
}

function answeredCount(sheet, state) {
  return sheet.questions.filter((_q, i) => isAnswered(sheet, state, i)).length;
}

function isComplete(sheet, state) {
  return sheet.questions.length > 0 && sheet.questions.every((_q, i) => isAnswered(sheet, state, i));
}

function nextUnanswered(sheet, state, from) {
  const n = sheet.questions.length;
  for (let step = 1; step <= n; step += 1) {
    const i = (from + step) % n;
    if (!isAnswered(sheet, state, i)) return i;
  }
  return -1;
}

function clampQ(sheet, q) {
  return Math.min(Math.max(0, q), Math.max(0, sheet.questions.length - 1));
}

// The reducer. Every transition the card can make, so the JSX only dispatches.
function reduce(state, sheet, action) {
  if (!sheet) return state;
  switch (action.type) {
    case 'highlight': {
      return { ...state, q: clampQ(sheet, action.q), row: action.row };
    }
    case 'move': {
      const question = sheet.questions[state.q];
      if (!question) return state;
      const rows = rowsOf(question);
      if (!rows.length) return state;
      const at = rows.indexOf(state.row);
      const next = at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + action.dir));
      return { ...state, row: rows[next] };
    }
    case 'goto': {
      const q = clampQ(sheet, action.q);
      const question = sheet.questions[q];
      const rows = question ? rowsOf(question) : [];
      const answer = answerOf(state, q);
      const row = answer?.kind === 'select' ? answer.index : (answer?.kind === 'text' ? TEXT_ROW : (rows[0] ?? null));
      return { ...state, q, row };
    }
    case 'pick': {
      const q = clampQ(sheet, action.q);
      const question = sheet.questions[q];
      if (!question) return state;
      const option = question.options.find((candidate) => candidate.index === action.index);
      if (!option) return state;
      if (question.multiSelect) {
        const current = answerOf(state, q);
        const indexes = current?.kind === 'multi' ? current.indexes : [];
        const text = current?.kind === 'multi' ? current.text || '' : (current?.kind === 'text' ? current.text : '');
        const nextIndexes = indexes.includes(action.index)
          ? indexes.filter((index) => index !== action.index)
          : [...indexes, action.index].sort((a, b) => a - b);
        return { ...state, q, row: action.index, answers: { ...state.answers, [q]: { kind: 'multi', indexes: nextIndexes, text } } };
      }
      const picked = { ...state, q, row: action.index, answers: { ...state.answers, [q]: { kind: 'select', index: action.index } } };
      // A single-select pick in a batch moves on to the next unanswered
      // question, the way the dialog itself advances on Enter, so a batch is
      // answered top to bottom without a click per question to get there.
      if (action.advance) {
        const next = nextUnanswered(sheet, picked, q);
        if (next >= 0 && next !== q) return reduce(picked, sheet, { type: 'goto', q: next });
      }
      return picked;
    }
    case 'draft': {
      const q = clampQ(sheet, action.q);
      const question = sheet.questions[q];
      const text = String(action.text || '');
      const answers = { ...state.answers };
      if (question?.multiSelect) {
        // A multi-select keeps its ticks AND its typed row together, as the
        // CLI does (typing on the row ticks it beside the others).
        const current = answers[q]?.kind === 'multi' ? answers[q] : { kind: 'multi', indexes: [], text: '' };
        const next = { ...current, text };
        if (next.indexes.length || text.trim()) answers[q] = next;
        else delete answers[q];
      } else if (text.trim()) {
        answers[q] = { kind: 'text', text };
      } else if (answers[q]?.kind === 'text') {
        delete answers[q];
      }
      return { ...state, drafts: { ...state.drafts, [q]: text }, answers };
    }
    case 'clear': {
      const answers = { ...state.answers };
      delete answers[clampQ(sheet, action.q)];
      return { ...state, answers };
    }
    default:
      return state;
  }
}

// What the driver needs, in question order: the LOCAL answers only. A question
// answered in the terminal is left as the CLI has it. Null while the sheet is
// incomplete, so nothing half-made can ever be delivered; an empty list is a
// complete sheet whose every answer already lives in the dialog, which the
// driver then only submits.
function deliveryAnswers(sheet, state) {
  if (!isComplete(sheet, state)) return null;
  const out = [];
  sheet.questions.forEach((question, i) => {
    const answer = answerOf(state, i);
    if (!answer) return;
    if (answer.kind === 'multi') {
      const text = String(answer.text || '').trim();
      out.push({ question: i, kind: 'multi', indexes: [...answer.indexes], ...(text ? { text } : {}) });
    } else if (answer.kind === 'text') {
      out.push({ question: i, kind: 'text', text: answer.text.trim() });
    } else {
      out.push({ question: i, kind: 'select', index: answer.index });
    }
  });
  return out;
}

// The keys the footer may honestly advertise for this sheet in this state.
// Returns [[keyLabel, meaning], ...]; the card renders them verbatim, so the
// hint can never promise a key the model does not take (review-caught
// 2026-09-03: the review screen advertised digits it ignored).
function keyHints(sheet, state) {
  if (!sheet) return [];
  if (sheet.kind === 'review') return [['Enter', 'submit'], ['1', 'submit'], ['2', 'cancel'], ['Esc', 'decline']];
  const staged = sheet.mode === 'staged';
  const question = sheet.questions[state.q];
  const hints = [];
  if (staged && sheet.questions.length > 1) hints.push(['← →', 'question']);
  hints.push(['↑ ↓', 'option']);
  hints.push(['1-9', staged ? 'pick' : 'answer']);
  if (staged && question?.multiSelect) hints.push(['Space', 'tick']);
  if (staged) hints.push(['Enter', isComplete(sheet, state) ? 'submit' : (question?.multiSelect ? 'tick' : 'pick')]);
  else hints.push(['Enter', 'answer']);
  hints.push(['Esc', 'decline']);
  return hints;
}

// Translate a keydown into a sheet verdict, or null to leave it alone.
//
// Measured key meanings of the dialog underneath are NOT reproduced here on
// purpose: no arrow reaches the pty from the card any more. The card moves a
// local highlight and the delivery walks the pty once, verified, at the end.
//
//   ↑ ↓          highlight up/down within the question
//   ← →          previous/next question (staged sheets only)
//   1-9          pick option N (immediate: answer with it; review: 1/2)
//   Space        pick the highlighted row (staged only)
//   Enter        immediate: answer with the highlighted row
//                staged: pick the highlighted row; when the sheet is complete, submit
//   Esc          decline (in a text field: leave the field instead)
//   Tab          never taken: ordinary focus movement, so the card cannot trap
//                the keyboard (review-caught 2026-09-03)
function sheetKeyAction(event, sheet, state) {
  if (!event || !sheet) return null;
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const key = event.key;
  const inText = isTextEntry(event.target);
  if (key === 'Tab') return null;
  if (key === 'Escape') return inText ? { kind: 'blur' } : { kind: 'cancel' };
  // A text field owns its keys.
  if (inText) return null;
  const ownRow = isOwnRow(event.target);
  if (['Enter', ' ', 'Spacebar'].includes(key) && isActivatableControl(event.target) && !ownRow) return null;
  if (sheet.kind === 'review') {
    if (key === 'Enter' || key === '1') {
      if (!sheet.complete) return { kind: 'blocked', reason: 'some questions are still unanswered; go back with ← first' };
      return sheet.submitIndex != null ? { kind: 'answer', index: sheet.submitIndex } : null;
    }
    if (key === '2') return sheet.cancelIndex != null ? { kind: 'answer', index: sheet.cancelIndex } : null;
    return null;
  }
  const question = sheet.questions[state.q];
  if (!question) return null;
  const staged = sheet.mode === 'staged';

  if (key === 'ArrowDown') return { kind: 'move', dir: 1 };
  if (key === 'ArrowUp') return { kind: 'move', dir: -1 };
  if (key === 'ArrowRight') return staged && sheet.questions.length > 1 ? { kind: 'goto', q: clampQ(sheet, state.q + 1) } : null;
  if (key === 'ArrowLeft') return staged && sheet.questions.length > 1 ? { kind: 'goto', q: clampQ(sheet, state.q - 1) } : null;
  if (/^[1-9]$/.test(key)) {
    const index = Number(key);
    if (!question.options.some((option) => option.index === index)) return null;
    // A digit is a pick like a click or Enter, and on a single-select question
    // it moves on the same way: driven in the harness, "2, Space, Enter" on a
    // batch kept re-picking question 1 because the digit alone stayed put.
    return staged ? { kind: 'pick', q: state.q, index, advance: !question.multiSelect } : { kind: 'answer', index };
  }
  if (key === ' ' || key === 'Spacebar') {
    // On an immediate sheet Space never answers; on a focused row it has to be
    // SWALLOWED too, or the button's native click would answer for it.
    if (!staged) return ownRow ? { kind: 'ignore' } : null;
    if (typeof state.row !== 'number') return null;
    return { kind: 'pick', q: state.q, index: state.row };
  }
  if (key === 'Enter') {
    if (state.row === TEXT_ROW) {
      const draft = String(state.drafts[state.q] || '').trim();
      if (!draft) return { kind: 'blocked', reason: 'type an answer first, or pick one of the options' };
      return staged
        ? (isComplete(sheet, state) ? { kind: 'submit' } : { kind: 'goto', q: nextUnanswered(sheet, state, state.q) })
        : { kind: 'answer-text' };
    }
    if (typeof state.row !== 'number') return null;
    if (!staged) return { kind: 'answer', index: state.row };
    if (isComplete(sheet, state) && isAnswered(sheet, state, state.q)) return { kind: 'submit' };
    return { kind: 'pick', q: state.q, index: state.row, advance: !question.multiSelect };
  }
  return null;
}

module.exports = {
  TEXT_ROW,
  buildSheet,
  sheetIdentity,
  initialState,
  resync,
  findContinuedQuestion,
  reduce,
  rowsOf,
  answerOf,
  isAnswered,
  answeredInTerminal,
  answeredCount,
  isComplete,
  nextUnanswered,
  deliveryAnswers,
  keyHints,
  sheetKeyAction,
  isTextEntry,
  isActivatableControl,
  isOwnRow,
};
