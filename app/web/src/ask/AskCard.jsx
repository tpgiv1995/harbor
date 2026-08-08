import React, { useEffect, useRef, useState } from 'react';
import './ask.css';

// The phone's answer card: renders whatever `session:menu-state` returns and
// sends actions back through `session:menu-answer`. Both RPC methods already
// exist server-side (main/session-send.js getMenu/answerMenu, unchanged for
// this batch) and own every parsing decision — parseMenu, normalizeAsk,
// mergeAsk, matchQuestionIndex. This component only renders the result and
// forwards clicks/taps as { type: 'select' | 'toggle' | 'submit' | 'text' |
// 'notes' | 'cancel' | 'key' | 'raw' } actions, exactly the shape the desktop
// TileMenuAsk card uses (src/renderer/stage/SessionTile.jsx).
//
// The authority split is preserved verbatim: the TRANSCRIPT supplies the
// question text and every option (full, unclipped); the PTY stays authority
// on whether the dialog is still up, which row is highlighted, and which
// keys the footer offers. Neither side is asked to do the other's job here.
export function AskCard({ client, pane, sessionId, blockedHint }) {
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [notesFor, setNotesFor] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [answerError, setAnswerError] = useState(null);
  const busyRef = useRef(false);
  const blockedRef = useRef(false);
  blockedRef.current = Boolean(blockedHint);
  const paneId = pane?.paneId || null;
  const workspaceId = pane?.workspaceId || null;
  // The poll reads the CURRENT pane through a ref, so the effect never has to
  // depend on the object's identity to stay correct.
  const paneRef = useRef(pane);
  paneRef.current = pane;

  // KEYED ON PRIMITIVES, NEVER ON `pane` OR `blockedHint`.
  //
  // This effect's first act is an immediate `session:menu-state` RPC, so every
  // re-run is a network round trip. It used to list `pane` (an object its
  // parent rebuilt on every render) and `blockedHint` (already mirrored into
  // blockedRef above, so it was never read from the closure), which made the
  // poll restart on re-renders that changed nothing about which pane is being
  // watched. Measured on the real client: 40 identical visualViewport events
  // produced 40 RPCs. Pat's phone drove ~110/s, overflowed the server's
  // per-client queue and got closed 1013 every minute or two (2026-08-08).
  //
  // The parent memoizes `pane` now as well. Both fixes stay: this one is what
  // makes the poll independent of the parent's render discipline, so the next
  // component that rebuilds an object on the way in cannot rebuild the storm.
  useEffect(() => {
    if (!client || !paneId) { setMenu(null); return undefined; }
    let live = true;
    let timer = null;
    const tick = async () => {
      if (!live) return;
      if (!busyRef.current) {
        try {
          const next = await client.call('session:menu-state', { pane: paneRef.current, sessionId, blockedHint: blockedRef.current });
          if (live && !busyRef.current) setMenu(next && (next.options?.length || next.fallback) ? next : null);
        } catch { if (live) setMenu(null); }
      }
      if (live) timer = setTimeout(tick, 700);
    };
    tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [client, paneId, workspaceId, sessionId]);

  const refresh = async () => {
    const next = await client.call('session:menu-state', { pane, sessionId, blockedHint: blockedRef.current });
    setMenu(next && (next.options?.length || next.fallback) ? next : null);
  };

  const answer = async (action) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    // A toggle only ticks a box: the question stays open, so re-read instead
    // of clearing. Everything else ends the question, where clearing
    // optimistically is what makes the card disappear the instant the answer
    // lands rather than one poll later.
    const keepsCardUp = action.type === 'toggle';
    setAnswerError(null);
    if (!keepsCardUp) setMenu(null);
    try {
      const res = await client.call('session:menu-answer', { pane, action });
      if (res && res.ok === false) setAnswerError(res.reason || 'that answer did not land');
      if (action.type === 'text') setDraft('');
      if (keepsCardUp) await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const sendNote = async (index, text) => {
    if (busyRef.current || !text) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await client.call('session:menu-answer', { pane, action: { type: 'notes', index, text } });
      setNotesFor(null);
      setNoteDraft('');
      await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const pressKey = async (action) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await client.call('session:menu-answer', { pane, action });
      if (action.type === 'raw') setDraft('');
      await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (!menu) return null;

  // The no-dead-end panel: an unrecognized blocker shows its raw screen tail
  // and direct keys, so any dialog shape is answerable from the phone. Enter
  // is never implied; the keyboard button types bytes only, the Enter key
  // sends Enter.
  if (menu.fallback) {
    return (
      <div className="ask-card" role="group" aria-label="Answer this prompt">
        <div className="ask-head">
          <span className="ask-badge" aria-hidden="true">✳</span>
          <span className="ask-eyebrow">Needs your answer</span>
        </div>
        <p className="ask-note">
          Harbor does not recognize this prompt&apos;s shape yet (a copy was saved so it can learn it).
          The live screen below is driven directly by these keys.
        </p>
        <pre className="ask-screen">{menu.screen.join('\n')}</pre>
        <div className="ask-keys">
          {[['up', '↑'], ['down', '↓'], ['space', 'Space'], ['enter', 'Enter'], ['esc', 'Esc']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="ask-key"
              disabled={busy}
              aria-label={`Send ${label} to the prompt`}
              onClick={() => pressKey({ type: 'key', key })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={`ask-row text${busy ? ' busy' : ''}`}>
          <input
            className="ask-input"
            type="text"
            value={draft}
            disabled={busy}
            placeholder="Type into the prompt (use the Enter key above to submit)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft) {
                e.preventDefault();
                pressKey({ type: 'raw', text: draft });
              }
            }}
          />
          <button
            type="button"
            className="ask-send"
            disabled={busy || !draft}
            aria-label="Type this into the prompt"
            title="Type this into the prompt (no Enter is sent)"
            onClick={() => pressKey({ type: 'raw', text: draft })}
          >
            ⌨
          </button>
        </div>
      </div>
    );
  }

  const tabs = menu.tabs || null;
  const questionTabs = tabs ? tabs.filter((tab) => !tab.submit) : [];
  const answered = questionTabs.filter((tab) => tab.done).length;
  const batch = menu.batch || null;
  const multi = Boolean(menu.multiSelect);
  const clippedView = menu.ptyClipped ?? menu.clipped;
  const ticked = multi ? menu.options.filter((o) => o.checked).length : 0;

  return (
    <div className="ask-card" role="group" aria-label="Answer this question">
      <div className="ask-head">
        <span className="ask-badge" aria-hidden="true">✳</span>
        <span className="ask-eyebrow">Needs your answer</span>
        {batch ? (
          <span className="ask-count">{`Question ${batch.currentIndex + 1} of ${batch.count}`}</span>
        ) : questionTabs.length > 1 ? (
          <span className="ask-count">
            {answered ? `${answered} of ${questionTabs.length} answered` : `${questionTabs.length} questions`}
          </span>
        ) : null}
        {multi ? <span className="ask-count">{`pick any (${ticked} selected)`}</span> : null}
        <button
          type="button"
          className="ask-dismiss"
          disabled={busy}
          title="Dismiss this question (Esc)"
          onClick={() => answer({ type: 'cancel' })}
        >
          Dismiss
        </button>
      </div>
      {batch ? (
        <div className="ask-tabs" aria-label="Questions in this batch">
          {batch.headers.map((tab, i) => (
            <span
              key={`${tab.header}-${i}`}
              className={`ask-tab${tab.current ? ' cur' : ''}`}
              title={tab.current ? 'The question showing now' : `${tab.header}: use Next question to reach it`}
            >
              <span className="ask-tab-mark" aria-hidden="true">{tab.current ? '●' : '○'}</span>
              {tab.header}
            </span>
          ))}
        </div>
      ) : tabs ? (
        <div className="ask-tabs" aria-label="Questions in this batch">
          {tabs.map((tab, i) => (
            <span
              key={`${tab.label}-${i}`}
              className={`ask-tab${tab.submit ? ' submit' : ''}${tab.done ? ' done' : ''}`}
              title={tab.submit ? 'Submits the whole batch' : `${tab.label}: ${tab.done ? 'answered' : 'not answered yet'}`}
            >
              <span className="ask-tab-mark" aria-hidden="true">{tab.submit ? '➤' : (tab.done ? '✔' : '○')}</span>
              {tab.label}
            </span>
          ))}
        </div>
      ) : null}
      {/* Never fabricate a question heading: if the transcript did not
          supply one, this simply stays empty and the option list below is
          all the card shows, exactly like the desktop card. */}
      {menu.question ? <div className="ask-q">{menu.question}</div> : null}
      {answerError ? <div className="ask-err">{answerError}</div> : null}
      <div className="ask-list">
        {menu.options.map((option) => (
          <div key={option.index} className="ask-item">
            {option.isText ? (
              <>
                {option.description ? <p className="ask-desc lead">{option.description}</p> : null}
                <div className={`ask-row text${busy ? ' busy' : ''}`}>
                  <span className="ask-num" aria-hidden="true">{option.index}</span>
                  <input
                    className="ask-input"
                    type="text"
                    value={draft}
                    disabled={busy}
                    placeholder={option.label.replace(/[.…]+$/, '')}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && draft.trim()) {
                        e.preventDefault();
                        answer({ type: 'text', index: option.index, text: draft.trim() });
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="ask-send"
                    disabled={busy || !draft.trim()}
                    aria-label="Send this answer"
                    title="Send this answer"
                    onClick={() => answer({ type: 'text', index: option.index, text: draft.trim() })}
                  >
                    ↵
                  </button>
                </div>
              </>
            ) : (
              // Every option is a button, including one the pty has scrolled
              // above its own viewport (offscreen). The walk keys on the
              // option NUMBER and re-reads after every keystroke, so it steps
              // the highlight to a row it cannot currently see and only
              // presses Enter once verified there.
              <button
                type="button"
                className={`ask-row-btn${option.selected ? ' cur' : ''}${option.checked ? ' on' : ''}${option.offscreen ? ' off' : ''}`}
                disabled={busy}
                aria-pressed={multi ? Boolean(option.checked) : undefined}
                title={option.offscreen
                  ? `Option ${option.index} is above the terminal's visible area; Harbor scrolls the highlight to it and confirms before choosing.`
                  : undefined}
                onClick={() => answer(multi
                  ? { type: 'toggle', index: option.index }
                  : { type: 'select', index: option.index })}
              >
                <span className="ask-num" aria-hidden="true">
                  {multi ? (option.checked ? '☑' : '☐') : option.index}
                </span>
                <span className="ask-body">
                  <span className="ask-label">
                    {option.label}
                    {option.recommended ? <span className="ask-rec">Recommended</span> : null}
                  </span>
                  {option.description ? <span className="ask-desc">{option.description}</span> : null}
                </span>
                <span className="ask-go" aria-hidden="true">{multi ? '' : '→'}</span>
              </button>
            )}
            {menu.keys?.notes && !option.isText ? (
              <button
                type="button"
                className="ask-note-btn"
                disabled={busy}
                title="Add a note to this answer"
                onClick={() => setNotesFor(option.index)}
              >
                note
              </button>
            ) : null}
            {notesFor === option.index ? (
              <div className={`ask-row text${busy ? ' busy' : ''}`}>
                <input
                  className="ask-input"
                  type="text"
                  autoFocus
                  value={noteDraft}
                  disabled={busy}
                  placeholder={`Note on "${option.label.slice(0, 28)}"`}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { setNotesFor(null); setNoteDraft(''); }
                    if (e.key === 'Enter' && noteDraft.trim()) {
                      e.preventDefault();
                      sendNote(option.index, noteDraft.trim());
                    }
                  }}
                />
                <button
                  type="button"
                  className="ask-send"
                  disabled={busy || !noteDraft.trim()}
                  title="Attach this note to the answer"
                  onClick={() => sendNote(option.index, noteDraft.trim())}
                >
                  ↵
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {(multi || clippedView || menu.keys?.switchQuestions) ? (
        <div className="ask-foot">
          {multi ? (
            <button
              type="button"
              className="ask-key primary"
              disabled={busy}
              title="Confirm the selected options (Enter)"
              onClick={() => answer({ type: 'submit' })}
            >
              {`Submit ${ticked || 'no'} selected`}
            </button>
          ) : null}
          {menu.keys?.switchQuestions ? (
            <button
              type="button"
              className="ask-key"
              disabled={busy}
              title="Move to the next question in this batch (Tab)"
              onClick={() => pressKey({ type: 'key', key: 'tab' })}
            >
              Next question ⇥
            </button>
          ) : null}
          {clippedView ? (
            <>
              {[['up', '↑'], ['down', '↓'], ['enter', 'Enter']].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="ask-key"
                  disabled={busy}
                  title={key === 'enter'
                    ? 'Choose whatever the terminal highlight is on now'
                    : `Move the highlight ${key}`}
                  onClick={() => pressKey({ type: 'key', key })}
                >
                  {label}
                </button>
              ))}
              <span className="ask-foot-note">Rows above the view are reachable with these keys.</span>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
