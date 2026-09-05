import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  TEXT_ROW,
  buildSheet,
  sheetIdentity,
  initialState,
  resync,
  reduce,
  isAnswered,
  answeredInTerminal,
  answeredCount,
  isComplete,
  deliveryAnswers,
  keyHints,
  sheetKeyAction,
} from './ask-sheet.cjs';

// The in-window question card, rebuilt as an ANSWER SHEET (2026-09-03).
//
// A menu is a pty-only construct (it never reaches the transcript the
// conversation renders from), so this polls the pane and answers in place: the
// question and its answer live in the window where it is being asked, never in
// the shared command bar or the raw terminal. What changed from the old card:
// the whole batch is laid out at once (discovered off the dialog by the main
// process), every choice stays local until one Submit, and no arrow key is ever
// forwarded to the pty. The model is ask-sheet.cjs (pure, tested); this file
// only renders and dispatches.

// Actions that leave the dialog up, so the card re-reads instead of clearing.
const KEEP = new Set(['key', 'raw', 'toggle', 'notes']);

// The raw screen is rendered SCROLLED TO THE BOTTOM, because the actionable line
// is always the last one and the box is shorter than the screen it shows
// (live-caught 2026-08-06: a first-run "Press Enter to continue" sat below
// fourteen lines of welcome art).
function FallbackScreen({ lines }) {
  const ref = useRef(null);
  const text = lines.join('\n');
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return <pre className="ask-screen" ref={ref}>{text}</pre>;
}

function live(next) {
  return next && (next.options?.length || next.fallback) ? next : null;
}

function Keycap({ children }) {
  return <kbd className="ask-kbd">{children}</kbd>;
}

const rowKey = (q, row) => `${q}:${row}`;

export function AskCard({ pane, sessionId, blockedHint, selected = false }) {
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [rawDraft, setRawDraft] = useState('');
  const [noteFor, setNoteFor] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const busyRef = useRef(false);
  const blockedRef = useRef(false);
  blockedRef.current = Boolean(blockedHint);
  const cardRef = useRef(null);
  // One element per row (option buttons and text inputs) so the keyboard
  // highlight and DOM focus are the same thing: whatever is highlighted is
  // focused, so a native Enter and the card's Enter can never disagree
  // (review-caught 2026-09-03), and focusing scrolls the row into view.
  const rowRefs = useRef(new Map());
  const sectionRefs = useRef(new Map());
  const paneId = pane?.paneId || null;

  // A single parse miss must not clear the card: the pane's dialog blinks out of
  // the scrape for a tick fairly often, and clearing on the first null unmounts
  // the whole card, which drops the keyboard focus (and the keystroke) of anyone
  // typing a free-form answer. The card is taken down only after two consecutive
  // misses (~1.4s); a real answer clears it instantly through `run`, so this only
  // guards the transient miss, never a genuine dismissal (2026-09-04).
  const missRef = useRef(0);
  useEffect(() => {
    if (!paneId) { setMenu(null); return undefined; }
    let alive = true;
    let timer = null;
    missRef.current = 0;
    const miss = () => { if ((missRef.current += 1) >= 2) setMenu(null); };
    const tick = async () => {
      if (!alive) return;
      if (!busyRef.current) {
        try {
          const next = await window.harbor.session.menuState({ pane, sessionId, blockedHint: blockedRef.current });
          if (alive && !busyRef.current) {
            const shown = live(next);
            if (shown) { missRef.current = 0; setMenu(shown); }
            else miss();
          }
        } catch { if (alive) miss(); }
      }
      if (alive) timer = setTimeout(tick, 700);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [paneId, sessionId, pane, blockedHint]);

  const sheet = useMemo(() => buildSheet(menu), [menu]);
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const identity = sheetIdentity(sheet);
  const [state, dispatch] = useReducer(
    (current, action) => (action.type === 'resync' ? resync(current, action.oldSheet, action.newSheet) : reduce(current, sheetRef.current, action)),
    sheet,
    initialState,
  );
  // Local answers and drafts survive polls of the SAME dialog, even when the poll
  // re-represents it (batch<->single as the transcript match comes and goes,
  // truncated<->full option labels): `resync` carries them forward instead of
  // the old hard reset that wiped every draft and pick on any identity change
  // (live-caught 2026-09-04, Pat's free-form answer deleted mid-type). The sheet
  // the current state was built for is tracked so resync can match old questions
  // to new ones; a transient null poll is skipped entirely so it never advances
  // the refs and never costs the user their typing.
  const identityRef = useRef(identity);
  const stateSheetRef = useRef(sheet);
  useEffect(() => {
    if (!sheetRef.current) return;
    if (identityRef.current === identity) return;
    const oldSheet = stateSheetRef.current;
    identityRef.current = identity;
    stateSheetRef.current = sheetRef.current;
    dispatch({ type: 'resync', oldSheet, newSheet: sheetRef.current });
  }, [identity]);

  const refresh = async () => {
    const next = await window.harbor.session.menuState({ pane, sessionId, blockedHint: blockedRef.current }).catch(() => null);
    setMenu(live(next));
  };

  // One path for every pty action. An action that ENDS the question clears
  // the card optimistically so it vanishes the instant the answer lands; one
  // that keeps it up re-reads so the pane's own state shows. A refusal is
  // shown NOW, with the card brought back, never as silence (review 2026-08-09).
  const run = async (action) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const keeps = KEEP.has(action.type);
    if (!keeps) setMenu(null);
    try {
      const res = await window.harbor.session.answerMenu({ pane, sessionId, action });
      const landed = !res || res.ok !== false;
      if (!landed) setError(res.reason || 'that answer did not land');
      if (!landed || keeps) await refresh();
      return landed;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const question = sheet?.questions[state.q] || null;
  const staged = sheet?.mode === 'staged';

  const answerNow = (index) => run({ type: 'select', index });
  const answerText = async (q) => {
    const text = String(state.drafts[q] || '').trim();
    const target = sheet?.questions[q];
    if (!text || !target?.textIndex) return;
    if (await run({ type: 'text', index: target.textIndex, text })) dispatch({ type: 'draft', q, text: '' });
  };
  const submitSheet = () => {
    const answers = deliveryAnswers(sheet, state);
    if (!answers) { setError('answer every question first'); return; }
    run({ type: 'sheet', answers });
  };
  const chatAbout = (q) => run({ type: 'chat', question: q });
  const sendNote = async (index, text) => {
    if (!text) return;
    if (await run({ type: 'notes', index, text, question: state.q })) { setNoteFor(null); setNoteDraft(''); }
  };

  const onKeyDown = (event) => {
    const verdict = sheetKeyAction(event, sheet, state);
    if (!verdict) return;
    event.preventDefault();
    event.stopPropagation();
    if (verdict.kind === 'blocked') { setError(verdict.reason); return; }
    if (verdict.kind === 'ignore') return;
    setError(null);
    switch (verdict.kind) {
      case 'move': dispatch({ type: 'move', dir: verdict.dir }); break;
      case 'goto': dispatch({ type: 'goto', q: verdict.q }); break;
      case 'pick': dispatch({ type: 'pick', q: verdict.q, index: verdict.index, advance: verdict.advance }); break;
      case 'answer': answerNow(verdict.index); break;
      case 'answer-text': answerText(state.q); break;
      case 'submit': submitSheet(); break;
      case 'cancel': run({ type: 'cancel' }); break;
      case 'blur': cardRef.current?.focus({ preventScroll: true }); break;
      default: break;
    }
  };

  // Take focus ONCE, when a question first appears in the SELECTED window and
  // focus is resting, so the keys work without a click; never out of a field
  // he is typing in (review 2026-08-09, both halves).
  const focusedForRef = useRef('');
  useEffect(() => {
    if (!sheet) { focusedForRef.current = ''; return; }
    if (!selected || focusedForRef.current === identity) return;
    const node = cardRef.current;
    if (!node) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== node && !node.contains(active)) return;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    node.focus({ preventScroll: true });
    focusedForRef.current = identity;
  }, [sheet, selected, identity]);

  // Roving focus: the highlighted row is the focused element, and only when
  // focus already lives inside this card, so nothing typed elsewhere is ever
  // interrupted. Keyed on the highlight, never on the sheet object, which a
  // 700ms poll rebuilds (review-caught 2026-09-03: the old effect re-stole
  // focus from the send button every poll).
  useEffect(() => {
    if (!identity || state.row == null) return;
    const card = cardRef.current;
    if (!card) return;
    const active = document.activeElement;
    if (!(active === card || card.contains(active))) return;
    // Never out of a field being typed in: hovering an option while typing
    // moved focus to the row and the next Enter chose it instead of sending
    // the text (review-caught 2026-09-03). A field gives focus up only by
    // Escape, Tab, or a click.
    if (active !== card && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    const target = rowRefs.current.get(rowKey(state.q, state.row));
    if (target && target !== active) target.focus({ preventScroll: false });
  }, [identity, state.q, state.row]);

  // The active question scrolls into view when the stepper or ←/→ changes it.
  useEffect(() => {
    if (!identity) return;
    const section = sectionRefs.current.get(state.q);
    if (section?.scrollIntoView) section.scrollIntoView({ block: 'nearest' });
  }, [identity, state.q]);

  if (!menu) return null;

  // The no-dead-end panel: an unrecognized blocker shows its raw screen tail
  // and direct keys, so ANY dialog shape is answerable in the window. Enter is
  // never implied (a blind Enter once compacted a 559k-token session).
  if (menu.fallback) {
    return (
      <div className="ask ask-fallback" role="group" aria-label="Answer this prompt" onClick={(e) => e.stopPropagation()}>
        <div className="ask-head">
          <span className="ask-dot" aria-hidden="true" />
          <span className="ask-eyebrow">Needs your answer</span>
          <span className="ask-count">unrecognized prompt</span>
        </div>
        <p className="ask-note">
          Harbor does not know this prompt&apos;s shape yet (a copy was saved so it can learn it).
          The keys below drive the live screen directly.
        </p>
        <FallbackScreen lines={menu.screen} />
        <div className="ask-keys">
          {[['up', '↑'], ['down', '↓'], ['space', 'Space'], ['enter', 'Enter'], ['esc', 'Esc']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="ask-keybtn"
              disabled={busy}
              aria-label={`Send ${label} to the prompt`}
              onClick={(e) => { e.stopPropagation(); run({ type: 'key', key }); }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={`ask-text${busy ? ' busy' : ''}`}>
          <input
            className="ask-input"
            type="text"
            value={rawDraft}
            disabled={busy}
            placeholder="Type into the prompt (Enter above submits)"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRawDraft(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && rawDraft) {
                e.preventDefault();
                if (await run({ type: 'raw', text: rawDraft })) setRawDraft('');
              }
            }}
          />
          <button
            type="button"
            className="ask-send"
            disabled={busy || !rawDraft}
            aria-label="Type this into the prompt"
            title="Type this into the prompt (no Enter is sent)"
            onClick={async (e) => { e.stopPropagation(); if (await run({ type: 'raw', text: rawDraft })) setRawDraft(''); }}
          >
            ⌨
          </button>
        </div>
        {error ? <div className="ask-err">{error}</div> : null}
      </div>
    );
  }

  if (!sheet) return null;

  const total = sheet.questions.length;
  const done = staged ? answeredCount(sheet, state) : 0;
  const complete = staged && isComplete(sheet, state);
  const eyebrow = sheet.kind === 'permission' ? 'Permission' : sheet.kind === 'resume' ? 'Resume' : sheet.kind === 'review' ? 'Review' : 'Claude is asking';
  const hints = keyHints(sheet, state);
  const declineTitle = total > 1
    ? 'Decline (Esc): Claude continues with NO answers to any of these questions, and everything staged here is dropped'
    : 'Decline (Esc): Claude continues without an answer';

  return (
    <div
      className={`ask ask-${sheet.kind} ask-${sheet.mode}${busy ? ' busy' : ''}`}
      role="group"
      aria-label="Answer this question"
      ref={cardRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="ask-head">
        <span className="ask-dot" aria-hidden="true" />
        <span className="ask-eyebrow">{eyebrow}</span>
        {total > 1 ? <span className="ask-count">{`${done} of ${total} answered`}</span> : null}
        {total === 1 && question?.multiSelect ? <span className="ask-count">pick any</span> : null}
        {sheet.clipped ? <span className="ask-count ask-count-warn" title="The terminal is drawing this dialog partly above its own viewport.">partly off screen</span> : null}
        <button
          type="button"
          className="ask-dismiss"
          disabled={busy}
          title={declineTitle}
          onClick={(e) => { e.stopPropagation(); run({ type: 'cancel' }); }}
        >
          Decline
        </button>
      </div>

      {sheet.kind === 'review' ? (
        <div className="ask-body">
          <p className="ask-q-text">Ready to submit these answers?</p>
          {sheet.headers.length ? (
            <ul className="ask-review">
              {sheet.headers.map((h, i) => (
                <li key={`${h.header}-${i}`} className={h.answered === false ? 'missing' : ''}>
                  <span className="ask-check" aria-hidden="true">{h.answered === false ? '○' : '●'}</span>
                  <span className="ask-review-head">{h.header}</span>
                  {h.answered === false
                    ? <span className="ask-desc">not answered</span>
                    : (h.answer ? <span className="ask-review-answer">{h.answer}</span> : null)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <>
          {total > 1 ? (
            <div className="ask-steps" role="tablist" aria-label="Questions in this batch">
              {sheet.questions.map((q, i) => {
                const answered = isAnswered(sheet, state, i);
                return (
                  <button
                    key={`${q.header}-${i}`}
                    type="button"
                    role="tab"
                    aria-selected={i === state.q}
                    className={`ask-step${i === state.q ? ' cur' : ''}${answered ? ' done' : ''}`}
                    disabled={busy}
                    title={answered ? `${q.header}: answered` : `${q.header}: not answered yet`}
                    onClick={(e) => { e.stopPropagation(); dispatch({ type: 'goto', q: i }); }}
                  >
                    <span className="ask-step-mark" aria-hidden="true">{answered ? '✓' : i + 1}</span>
                    {q.header}
                  </button>
                );
              })}
            </div>
          ) : null}
          {error ? <div className="ask-err">{error}</div> : null}
          <div className="ask-body">
            {sheet.questions.map((q, i) => {
              const active = i === state.q;
              const answer = state.answers[i] || null;
              const draft = state.drafts[i] || '';
              const textActive = active && state.row === TEXT_ROW;
              const inTerminal = answeredInTerminal(sheet, state, i);
              const textStaged = answer?.kind === 'text' || (answer?.kind === 'multi' && Boolean(answer.text?.trim()));
              return (
                <section
                  key={`${q.header}-${i}`}
                  ref={(node) => { if (node) sectionRefs.current.set(i, node); else sectionRefs.current.delete(i); }}
                  className={`ask-q${active ? ' cur' : ''}${isAnswered(sheet, state, i) ? ' done' : ''}`}
                  onClick={() => { if (!active) dispatch({ type: 'goto', q: i }); }}
                >
                  {total > 1 ? (
                    <div className="ask-q-head">
                      {q.header}
                      {inTerminal ? <span className="ask-q-done" title="Already answered in the terminal; pick again here to change it">answered in terminal</span> : null}
                    </div>
                  ) : null}
                  {q.question ? <p className="ask-q-text">{q.question}</p> : null}
                  <div
                    className="ask-rows"
                    role={staged ? (q.multiSelect ? 'group' : 'radiogroup') : 'listbox'}
                    aria-label={q.question || q.header || 'Options'}
                  >
                    {q.options.map((option) => {
                      const picked = answer?.kind === 'multi'
                        ? answer.indexes.includes(option.index)
                        : answer?.kind === 'select' && answer.index === option.index;
                      const highlighted = active && state.row === option.index;
                      const semantics = staged
                        ? { role: q.multiSelect ? 'checkbox' : 'radio', 'aria-checked': Boolean(picked) }
                        : { role: 'option', 'aria-selected': highlighted };
                      return (
                        <button
                          key={option.index}
                          type="button"
                          ref={(node) => { const k = rowKey(i, option.index); if (node) rowRefs.current.set(k, node); else rowRefs.current.delete(k); }}
                          className={`ask-row${highlighted ? ' hl' : ''}${picked ? ' picked' : ''}${option.offscreen ? ' off' : ''}`}
                          disabled={busy}
                          tabIndex={highlighted ? 0 : -1}
                          data-ask-row={option.index}
                          {...semantics}
                          onMouseEnter={() => { if (!busy) dispatch({ type: 'highlight', q: i, row: option.index }); }}
                          onFocus={() => { if (!highlighted) dispatch({ type: 'highlight', q: i, row: option.index }); }}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (staged) dispatch({ type: 'pick', q: i, index: option.index, advance: !q.multiSelect });
                            else answerNow(option.index);
                          }}
                        >
                          <span className="ask-key" aria-hidden="true">
                            {q.multiSelect ? (picked ? '☑' : '☐') : (picked ? '●' : option.index)}
                          </span>
                          <span className="ask-body-col">
                            <span className="ask-label">
                              {option.label}
                              {option.recommended ? <span className="ask-rec">Recommended</span> : null}
                            </span>
                            {option.description ? <span className="ask-desc">{option.description}</span> : null}
                          </span>
                          {!staged ? <span className="ask-go" aria-hidden="true">↵</span> : null}
                        </button>
                      );
                    })}
                    {sheet.notesKey && typeof state.row === 'number' && active ? (
                      // A note rides the dialog's own notes key when its footer
                      // advertises one, in every mode: a batch's answer can
                      // carry a note too (review-caught 2026-09-03).
                      <div className="ask-notes">
                        {noteFor === state.row ? (
                          <div className="ask-text">
                            <input
                              className="ask-input"
                              type="text"
                              autoFocus
                              value={noteDraft}
                              disabled={busy}
                              placeholder="Note on this answer"
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setNoteDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') { e.stopPropagation(); setNoteFor(null); setNoteDraft(''); }
                                if (e.key === 'Enter' && noteDraft.trim()) { e.preventDefault(); sendNote(state.row, noteDraft.trim()); }
                              }}
                            />
                            <button type="button" className="ask-send" disabled={busy || !noteDraft.trim()} title="Attach this note" onClick={(e) => { e.stopPropagation(); sendNote(state.row, noteDraft.trim()); }}>↵</button>
                          </div>
                        ) : (
                          <button type="button" className="ask-quiet" disabled={busy} onClick={(e) => { e.stopPropagation(); setNoteFor(state.row); }}>
                            {`Add a note to option ${state.row}`}
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                  {q.acceptsText ? (
                    <div className={`ask-text${textActive ? ' hl' : ''}${textStaged ? ' picked' : ''}`}>
                      <span className="ask-key" aria-hidden="true">{textStaged ? '●' : '✎'}</span>
                      <input
                        className="ask-input"
                        type="text"
                        ref={(node) => { const k = rowKey(i, TEXT_ROW); if (node) rowRefs.current.set(k, node); else rowRefs.current.delete(k); }}
                        value={draft}
                        disabled={busy}
                        tabIndex={textActive ? 0 : -1}
                        placeholder={staged ? (q.multiSelect ? 'Or add your own, alongside the ticks' : 'Or type your own answer') : `${q.textLabel || 'Type something'}…`}
                        aria-label={`Your own answer to: ${q.question || q.header}`}
                        onClick={(e) => e.stopPropagation()}
                        onFocus={() => { if (!textActive) dispatch({ type: 'highlight', q: i, row: TEXT_ROW }); }}
                        onChange={(e) => dispatch({ type: 'draft', q: i, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (!draft.trim()) { setError('type an answer first, or pick one of the options'); return; }
                          if (staged) { if (complete) submitSheet(); else dispatch({ type: 'goto', q: (i + 1) % total }); } else answerText(i);
                        }}
                      />
                      {!staged ? (
                        <button
                          type="button"
                          className="ask-send"
                          disabled={busy || !draft.trim()}
                          aria-label="Send this answer"
                          title="Send this answer"
                          onClick={(e) => { e.stopPropagation(); answerText(i); }}
                        >
                          ↵
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </>
      )}

      <div className="ask-foot">
        {sheet.kind === 'review' ? (
          <>
            {/* The CLI lets an incomplete batch through; the sheet does not,
                matching the staged delivery's own check. ← is the review's
                only way back to the open question, and it is labelled as
                exactly that key (review-caught 2026-09-03). */}
            <button
              type="button"
              className="ask-primary"
              disabled={busy || sheet.submitIndex == null || !sheet.complete}
              title={sheet.complete ? 'Submit every answer (Enter)' : 'Some questions are still unanswered'}
              onClick={(e) => { e.stopPropagation(); if (sheet.complete) answerNow(sheet.submitIndex); }}
            >
              Submit answers
            </button>
            {!sheet.complete ? (
              <button type="button" className="ask-quiet" disabled={busy} title="Back to the open questions (←)" onClick={(e) => { e.stopPropagation(); run({ type: 'key', key: 'left' }); }}>← Back to the questions</button>
            ) : null}
            {sheet.cancelIndex != null ? (
              <button type="button" className="ask-quiet" disabled={busy} onClick={(e) => { e.stopPropagation(); answerNow(sheet.cancelIndex); }}>Cancel</button>
            ) : null}
          </>
        ) : staged ? (
          <button
            type="button"
            className="ask-primary"
            disabled={busy || !complete}
            title={complete ? 'Deliver every answer to the session (Enter)' : 'Answer every question first'}
            onClick={(e) => { e.stopPropagation(); submitSheet(); }}
          >
            {busy ? 'Delivering…' : complete ? (total > 1 ? `Submit ${total} answers` : 'Submit') : `${done} of ${total} answered`}
          </button>
        ) : null}
        {question?.chatIndex ? (
          <button
            type="button"
            className="ask-quiet"
            disabled={busy}
            title="Close this question and reply in the message bar instead"
            onClick={(e) => { e.stopPropagation(); chatAbout(state.q); }}
          >
            Chat about this
          </button>
        ) : null}
        {sheet.clipped ? (
          // The pty is drawing part of this dialog above its own viewport.
          // These move the terminal highlight by hand and confirm it, which
          // keeps every option reachable without leaving the window; the
          // floor the no-dead-end guard requires (kept from the old card).
          <span className="ask-clipped">
            {[['up', '↑'], ['down', '↓'], ['enter', 'Enter']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="ask-keybtn"
                disabled={busy}
                title={key === 'enter' ? 'Choose whatever the terminal highlight is on now' : `Move the terminal highlight ${key}`}
                onClick={(e) => { e.stopPropagation(); run({ type: 'key', key }); }}
              >
                {label}
              </button>
            ))}
            <span className="ask-clipped-note">Rows above the view are reachable with these keys.</span>
          </span>
        ) : null}
        <span className="ask-hint">
          {hints.map(([key, meaning], i) => (
            <React.Fragment key={key}>
              {i ? ' · ' : ''}
              {key.split(' ').map((k) => <Keycap key={k}>{k}</Keycap>)}
              {' '}{meaning}
            </React.Fragment>
          ))}
        </span>
      </div>
    </div>
  );
}
