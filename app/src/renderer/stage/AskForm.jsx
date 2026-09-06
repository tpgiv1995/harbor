import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { initialForm, reduce, status as formStatus, toPayload, notesText, previewFor, keyAction, entryFor } from './ask-form.cjs';

// THE QUESTION FORM (2026-09-05): AskUserQuestion answered from JSON.
//
// The question arrives through bin/harbor-ask-hook as the tool's own input
// (questions, headers, options with descriptions and previews, multiSelect),
// so this card is a plain form: every question of the batch on one sheet, no
// pty read, no key typed into a terminal, one Submit that hands back
// `answers` + `annotations` exactly as the CLI documents them. The screen-
// scraping AskCard remains the floor for sessions started without the hook.
//
// What the 2026-09-04 report demanded, in the markup: a note field per
// question that never blocks anything; a Submit that is never dead (when
// questions are unanswered it says how many and scrolls to the first); a
// Skip per question; free text as a real answer; a preview pane for the
// option under the pointer; Reply instead for "talk to me about this".

function OptionRow({ q, option, picked, multi, onPick, onHover, focusRef }) {
  return (
    <button
      type="button"
      ref={focusRef}
      className={`askf-opt${picked ? ' on' : ''}`}
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={picked}
      data-askf-row={`${q}:${option.index}`}
      onMouseEnter={() => onHover(option.index)}
      onFocus={() => onHover(option.index)}
      onClick={(event) => { event.stopPropagation(); onPick(option.index); }}
    >
      <span className="askf-key" aria-hidden="true">{multi ? (picked ? '☑' : '☐') : option.index + 1}</span>
      <span className="askf-opt-body">
        <span className="askf-opt-label">{option.label}</span>
        {option.description ? <span className="askf-opt-desc">{option.description}</span> : null}
      </span>
      {option.preview ? <span className="askf-opt-has-preview" title="This option has a preview">◫</span> : null}
    </button>
  );
}

function QuestionBlock({ question, entry, index, total, focused, missing, dispatch, blockRef }) {
  const [hover, setHover] = useState(null);
  const preview = previewFor(question, entry, hover);
  const multi = question.multiSelect;
  return (
    <section
      ref={blockRef}
      className={`askf-q${focused ? ' focused' : ''}${missing ? ' missing' : ''}${entry.skipped ? ' skipped' : ''}`}
      data-askf-q={index}
      onFocusCapture={() => dispatch({ type: 'focus', q: index })}
      onMouseDown={() => dispatch({ type: 'focus', q: index })}
      onMouseLeave={() => setHover(null)}
    >
      <header className="askf-q-head">
        <span className="askf-chip">{question.header || `Question ${index + 1}`}</span>
        <span className="askf-q-n">{index + 1} of {total}</span>
        {multi ? <span className="askf-q-multi">pick any</span> : null}
        {entry.skipped ? <span className="askf-q-state">skipped</span> : null}
      </header>
      <p className="askf-q-text">{question.question}</p>
      <div className={`askf-opts${preview ? ' with-preview' : ''}`}>
        <div className="askf-opt-list">
          {question.options.map((option) => (
            <OptionRow
              key={option.index}
              q={index}
              option={option}
              multi={multi}
              picked={entry.picks.includes(option.index)}
              onPick={(o) => dispatch({ type: 'pick', q: index, option: o })}
              onHover={setHover}
            />
          ))}
          <label className="askf-other">
            <span className="askf-key" aria-hidden="true">✎</span>
            <input
              type="text"
              className="askf-text"
              placeholder={multi ? 'Add your own (optional)' : 'Or type your own answer'}
              value={entry.text}
              onChange={(event) => dispatch({ type: 'text', q: index, value: event.target.value })}
              onClick={(event) => event.stopPropagation()}
            />
          </label>
        </div>
        {preview ? (
          <figure className="askf-preview" aria-label={`Preview of ${question.options[preview.option]?.label}`}>
            <figcaption>{question.options[preview.option]?.label}</figcaption>
            <pre>{preview.preview}</pre>
          </figure>
        ) : null}
      </div>
      <div className="askf-q-foot">
        <button
          type="button"
          className={`askf-quiet${entry.noteOpen || entry.note ? ' on' : ''}`}
          onClick={(event) => { event.stopPropagation(); dispatch({ type: 'noteOpen', q: index, open: !entry.noteOpen }); }}
        >
          {entry.note ? 'Note added' : 'Add a note'}
        </button>
        {entry.skipped ? (
          <button type="button" className="askf-quiet" onClick={(event) => { event.stopPropagation(); dispatch({ type: 'unskip', q: index }); }}>Answer instead</button>
        ) : (
          <button type="button" className="askf-quiet" onClick={(event) => { event.stopPropagation(); dispatch({ type: 'skip', q: index }); }}>Skip this one</button>
        )}
      </div>
      {entry.noteOpen ? (
        <textarea
          className="askf-note"
          rows={2}
          placeholder="A note for Claude about this answer (kept with your answer, never required)"
          value={entry.note}
          autoFocus
          onChange={(event) => dispatch({ type: 'note', q: index, value: event.target.value })}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
    </section>
  );
}

export function AskForm({ ask, onAnswer, onDecline, selected = false }) {
  const questions = ask?.questions || [];
  const [state, setState] = useState(() => initialForm(questions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const rootRef = useRef(null);
  const blockRefs = useRef([]);
  const dispatch = useCallback((action) => setState((prev) => reduce(prev, questions, action)), [questions]);
  const st = useMemo(() => formStatus(questions, state), [questions, state]);

  // A different question set (a new batch under the same session) starts a
  // fresh form; the same set keeps every pick, text and note.
  useEffect(() => { setState(initialForm(questions)); setError(null); setBusy(false); }, [ask?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const gotoMissing = useCallback(() => {
    const first = st.missing[0];
    if (!Number.isInteger(first)) return;
    dispatch({ type: 'focus', q: first });
    const block = blockRefs.current[first];
    block?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    block?.querySelector('[data-askf-row]')?.focus();
  }, [st.missing, dispatch]);

  const submit = useCallback(async () => {
    if (busy) return;
    if (!st.complete) { gotoMissing(); return; }
    const payload = toPayload(questions, state);
    const notes = notesText(questions, state);
    if (!Object.keys(payload.answers).length && !notes) { setError('Every question was skipped; answer at least one, add a note, or reply instead.'); return; }
    setBusy(true);
    setError(null);
    try {
      // Nothing answered but notes typed: the notes ARE the reply, sent as a
      // decline so Claude reads them as text rather than as empty answers.
      const result = Object.keys(payload.answers).length
        ? await onAnswer(ask.id, payload)
        : await onDecline(ask.id, `No option chosen. Notes: ${notes}`);
      if (!result?.ok) { setError(result?.reason || 'the answer could not be delivered'); setBusy(false); }
    } catch (e) {
      setError(String(e?.message || e));
      setBusy(false);
    }
  }, [busy, st.complete, gotoMissing, questions, state, onAnswer, ask]);

  const sendReply = useCallback(async () => {
    const text = reply.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onDecline(ask.id, text);
      if (!result?.ok) { setError(result?.reason || 'the reply could not be delivered'); setBusy(false); }
    } catch (e) {
      setError(String(e?.message || e));
      setBusy(false);
    }
  }, [reply, busy, onDecline, ask]);

  const onKeyDown = useCallback((event) => {
    const target = event.target;
    const inTextField = target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type === 'text'));
    const action = keyAction(event, questions, state, { inTextField });
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.type === 'pick') dispatch(action);
    else if (action.type === 'submit') submit();
    else if (action.type === 'goto-missing') gotoMissing();
    else if (action.type === 'blur') target.blur();
  }, [questions, state, dispatch, submit, gotoMissing]);

  if (!ask || !questions.length) return null;
  const submitLabel = busy ? 'Sending…'
    : st.complete ? (st.total === 1 ? 'Answer' : `Submit ${st.answered} answer${st.answered === 1 ? '' : 's'}${st.skipped ? ` (${st.skipped} skipped)` : ''}`)
      : `Answer ${st.missing.length} more`;

  return (
    <div
      ref={rootRef}
      className={`ask askf${selected ? ' sel' : ''}`}
      data-ask-form="hook"
      // Focusable, so the key hints are true from the first Tab or click into
      // the card; focus is never TAKEN on mount (that would steal it from the
      // command bar or another window).
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      <header className="askf-head">
        <span className="askf-eyebrow">Claude is asking</span>
        <span className="askf-count">{st.total} question{st.total === 1 ? '' : 's'}</span>
        <span className="askf-progress" aria-label={`${st.answered + st.skipped} of ${st.total} settled`}>
          {questions.map((q, i) => {
            const e = entryFor(state, i);
            const done = e.skipped || e.picks.length > 0 || e.text.trim();
            return <span key={i} className={`askf-dot${done ? ' on' : ''}${state.focus === i ? ' cur' : ''}`} title={q.header || `Question ${i + 1}`} />;
          })}
        </span>
      </header>
      <div className="askf-body">
        {questions.map((question, i) => (
          <QuestionBlock
            key={i}
            question={question}
            entry={entryFor(state, i)}
            index={i}
            total={questions.length}
            focused={state.focus === i}
            missing={st.missing.includes(i)}
            dispatch={dispatch}
            blockRef={(el) => { blockRefs.current[i] = el; }}
          />
        ))}
        {replying ? (
          <section className="askf-q askf-reply">
            <p className="askf-q-text">Reply instead of answering</p>
            <textarea
              className="askf-note"
              rows={3}
              autoFocus
              placeholder="Tell Claude what you want instead; the questions are set aside."
              value={reply}
              onChange={(event) => setReply(event.target.value)}
            />
            <div className="askf-q-foot">
              <button type="button" className="askf-primary" disabled={!reply.trim() || busy} onClick={sendReply}>Send reply</button>
              <button type="button" className="askf-quiet" onClick={() => setReplying(false)}>Back to the questions</button>
            </div>
          </section>
        ) : null}
      </div>
      <footer className="askf-foot">
        {error ? <span className="askf-err" role="alert">{error}</span> : null}
        <button
          type="button"
          className={`askf-primary${st.complete ? '' : ' partial'}`}
          disabled={busy}
          title={st.complete ? 'Send every answer to Claude' : `Go to the first unanswered question (${st.missing.length} left)`}
          onClick={submit}
        >
          {submitLabel}
        </button>
        {!replying ? (
          <button
            type="button"
            className="askf-quiet"
            disabled={busy}
            // Notes already typed seed the reply, so nothing written is lost.
            onClick={() => { setReplying(true); if (!reply.trim()) setReply(notesText(questions, state)); }}
          >
            Reply instead
          </button>
        ) : null}
        <span className="askf-hints" aria-hidden="true">digits pick · Enter submits · notes are optional</span>
      </footer>
    </div>
  );
}
