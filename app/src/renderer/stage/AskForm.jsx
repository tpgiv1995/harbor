import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { replyStore, useQuestionReply } from './use-question-reply.js';
import { quotePath } from './question-reply.cjs';
import { splitDroppedFiles, imageExtension } from './file-drop.cjs';
import './question-reply.css';
import { initialForm, reduce, status as formStatus, toPayload, previewFor, keyAction, entryFor } from './ask-form.cjs';

// THE QUESTION FORM (2026-09-05): AskUserQuestion answered from JSON.
//
// The question arrives through bin/harbor-ask-hook as the tool's own input
// (questions, headers, options with descriptions and previews, multiSelect),
// so this card is a plain form: every question of the batch on one sheet, no
// pty read, no key typed into a terminal, one Submit that hands back
// `answers` + `annotations` exactly as the CLI documents them. The screen-
// scraping AskCard remains the floor for sessions started without the hook.
//
// Submit sends partial answers, while Enter requires a complete sheet.
// Notes survive skips. Chat arms the session's ordinary composer.

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
              data-askf-field="text"
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

      </div>
      {entry.noteOpen ? (
        <textarea
          className="askf-note"
          data-askf-field="note"
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

export function AskForm({ ask, onAnswer, onChat, attachments = true, selected = false }) {
  const questions = ask?.questions || [];
  const [state, setState] = useState(() => initialForm(questions));
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState(null);
  const replying = useQuestionReply(ask?.sessionId);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
    block?.scrollIntoView({ block: 'start', behavior: 'instant' });
    block?.querySelector('[data-askf-row]')?.focus();
  }, [st.missing, dispatch]);

  const submit = useCallback(async () => {
    if (busy || saving) return;
    const payload = toPayload(questions, state);
    setBusy(true);
    setError(null);
    try {
      const result = await onAnswer(ask.id, payload);
      if (!result?.ok) { setError(result?.reason || 'the answer could not be delivered'); setBusy(false); }
    } catch (e) {
      setError(String(e?.message || e));
      setBusy(false);
    }
  }, [busy, saving, questions, state, onAnswer, ask]);

  const attachFiles = async (event, files) => {
    if (!attachments || !files?.length) return;
    event.preventDefault(); event.stopPropagation();
    const field = event.target?.closest?.('[data-askf-field]');
    const block = event.target?.closest?.('[data-askf-q]');
    const q = block ? Number(block.dataset.askfQ) : state.focus;
    const target = field?.dataset.askfField || 'note';
    const paths = [];
    setSaving(count => count + 1);
    try {
      const split = splitDroppedFiles(files);
      for (const file of split.images) {
        const buffer = await file.arrayBuffer();
        const saved = await window.harbor.clipboard.saveImage({ buffer, ext: imageExtension(file) });
        if (!saved) throw new Error('The image could not be saved');
        paths.push(saved);
      }
      for (const file of split.others) {
        const saved = window.harbor.files?.pathFor?.(file);
        if (!saved) throw new Error('The file path could not be read');
        paths.push(saved);
      }
    } catch (error) { if (alive.current) setError(String(error.message || error)); }
    finally {
      if (alive.current) {
        if (paths.length) dispatch({ type: 'append', q, field: target, value: paths.map(quotePath).join(target === 'text' ? ' ' : '\n') });
        setSaving(count => count - 1);
      }
    }
  };

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
  const skipped = st.missing.length + st.skipped;
  const submitLabel = busy ? 'Sending…' : skipped ? `Submit · ${skipped} will be skipped` : 'Submit';
  if (replying?.id === ask.id && replying.collapsed) return <div className="question-reply-collapsed">
    Claude asked {questions.length} question{questions.length === 1 ? '' : 's'} <button type="button" onClick={() => replyStore.show(ask.sessionId)}>Show</button>
  </div>;

  return (
    <div
      ref={rootRef}
      className={`ask askf${selected ? ' sel' : ''}`}
      data-ask-form="hook"
      onDragOver={attachments ? event => { event.preventDefault(); event.stopPropagation(); } : undefined}
      onDrop={attachments ? event => { event.preventDefault(); event.stopPropagation(); attachFiles(event, Array.from(event.dataTransfer?.files || [])); } : undefined}
      onPaste={attachments ? event => attachFiles(event, Array.from(event.clipboardData?.files || [])) : undefined}
      // Focusable, so the key hints are true from the first Tab or click into
      // the card; focus is never TAKEN on mount (that would steal it from the
      // command bar or another window).
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      <header className="askf-head">
        <span className="askf-eyebrow">Claude asked {st.total} question{st.total === 1 ? '' : 's'}</span>
        <span className="askf-progress" aria-label={`${st.answered + st.skipped} of ${st.total} settled`}>
          {questions.map((q, i) => {
            const e = entryFor(state, i);
            const done = e.skipped || e.picks.length > 0 || e.text.trim();
            return <span key={i} className={`askf-dot${done ? ' on' : ''}${state.focus === i ? ' cur' : ''}`} title={q.header || `Question ${i + 1}`} />;
          })}
        </span>
        <button type="button" className="askf-chat" disabled={busy || saving > 0} onClick={() => { replyStore.arm(ask); onChat?.(); }}>Chat about this</button>
      </header>
      {!attachments && questions.length > 1 ? <nav className="askf-stepper" aria-label="Question navigation">
        <button type="button" disabled={state.focus === 0} onClick={() => { const next = state.focus - 1; dispatch({ type: 'focus', q: next }); blockRefs.current[next]?.scrollIntoView({ block: 'nearest' }); }}>Previous</button>
        <span>Question {state.focus + 1} of {questions.length}</span>
        <button type="button" disabled={state.focus === questions.length - 1} onClick={() => { const next = state.focus + 1; dispatch({ type: 'focus', q: next }); blockRefs.current[next]?.scrollIntoView({ block: 'nearest' }); }}>Next</button>
      </nav> : null}
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

      </div>
      <footer className="askf-foot">
        {error ? <span className="askf-err" role="alert">{error}</span> : null}
        <button
          type="button"
          className="askf-primary"
          disabled={busy || saving > 0}
          title={skipped ? `Submit answered questions and skip ${skipped}` : 'Send every answer to Claude'}
          onClick={submit}
        >
          {submitLabel}
        </button>
        <span className="askf-hints" aria-hidden="true">Enter submits a complete sheet · Submit skips unanswered questions</span>
      </footer>
    </div>
  );
}
