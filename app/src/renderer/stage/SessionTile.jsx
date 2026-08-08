import React, { forwardRef, memo, useEffect, useMemo, useRef, useState } from 'react';
import { Conversation } from './Conversation.jsx';
import { XtermPane } from '../terminal/XtermPane.jsx';
import { projectColor } from './project-colors.js';
import { ProjectIcon } from './ProjectIcon.jsx';
import { providerIdentity, providerModel, ProfileBadge, useProfiles, resolveProfile } from '../providers.js';
import { WorkflowStrip } from './WorkflowStrip.jsx';
import { terminalView } from './terminal-view.cjs';

// The raw screen is rendered SCROLLED TO THE BOTTOM, because the actionable line
// is always the last one and the box is shorter than the screen it shows.
// Live-caught 2026-08-06: a brand-new session sat on Claude's first-run
// "Press Enter to continue" gate, and the panel dutifully rendered fourteen
// lines of the welcome ASCII art with the one sentence that mattered below the
// fold. Pat saw a box of noise, sent /acclimate twice into a session that had
// never reached a composer, and had no way to know why.
function FallbackScreen({ lines }) {
  const ref = React.useRef(null);
  const text = lines.join('\n');
  React.useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return <pre className="tile-ask-screen" ref={ref}>{text}</pre>;
}


const EFFORT_LABEL = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' };

// Compact token count for the gauge's honest no-percent state ("151k").
function formatContextTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return `${Math.max(1, Math.round(tokens / 1000))}k`;
}

function ContextGauge({ pct, tokens }) {
  if (typeof pct === 'number') {
    const warn = pct >= 70;
    const color = warn ? 'var(--warn)' : 'var(--ac)';
    return (
      <span
        className={`gauge${warn ? ' warn' : ''}`}
        style={{ background: `conic-gradient(${color} ${pct}%, rgba(255, 255, 255,.12) 0)` }}
        title={`${pct}% of context used`}
      >
        <span>{pct}</span>
      </span>
    );
  }
  // No percent is known yet (Claude has not reported its own math for this
  // session): show the real token count rather than a guessed fraction.
  if (typeof tokens === 'number' && tokens > 0) {
    return (
      <span
        className="gauge gauge-tokens"
        title={`${tokens.toLocaleString()} tokens in context; window size not yet reported by Claude`}
      >
        <span>{formatContextTokens(tokens)}</span>
      </span>
    );
  }
  return null;
}

function sessionLiveOwned(session, pane, header) {
  if (session.isLive || pane) return true;
  if (header?.processAlive != null) return header.processAlive;
  return Boolean(header?.lastWriteMs && Date.now() - header.lastWriteMs < 3 * 60 * 1000);
}

function runStateCue(session, pane, header) {
  if (header?.blocked) {
    return { kind: 'blocked', label: 'needs your answer', ariaLabel: 'blocked: needs your answer' };
  }
  if (header?.working) {
    const verb = header.workingText || header.text || 'Working';
    return { kind: 'running', label: verb, ariaLabel: `running: ${verb}` };
  }
  if (sessionLiveOwned(session, pane, header)) {
    return { kind: 'ready', label: 'ready', ariaLabel: 'ready' };
  }
  return null;
}

function headerForOwnedPane(session, pane, header) {
  if (!pane || !session.agentStatus) return header;
  // Herdr's agent detection lags 60-150s on a busy daemon, so it must never
  // OVERRIDE the transcript's own fresh working signal (live-caught: a session
  // mid-turn showed "ready"). Either source saying "working" wins; a pane
  // blocked on a dialog/question beats both, because typing at it eats input.
  const blocked = session.agentStatus === 'blocked';
  const working = !blocked && (session.agentStatus === 'working' || Boolean(header?.working));
  return {
    ...header,
    blocked,
    working,
    workingText: working
      ? (header?.workingText || header?.text || 'Working…')
      : null,
  };
}

function ModelChip({ model, effort, provider = 'claude', home, profiles, onClick }) {
  const identity = providerIdentity(provider);
  const label = model?.name || identity.label;
  return (
    <button type="button" className={`model model-chip tone-${model?.tone || 'other'}`} title="Configure this session" onClick={(event) => { event.stopPropagation(); onClick(); }}>
      <img className="logomk" src={identity.logo} alt="" aria-hidden="true" />
      {label}
      {effort ? <span className="eff">{EFFORT_LABEL[effort] || effort}</span> : null}
      {provider === 'claude' && home ? (
        <ProfileBadge profileId={home} profiles={profiles} className="model-acct" />
      ) : null}
    </button>
  );
}

function OrchestrationPill({ summary, onClick }) {
  if (!summary?.visible) return null;
  const engine = summary.workerEngine ? ` - ${summary.workerEngine}` : '';
  const label = summary.state === 'abandoned'
    ? `Orch abandoned ${summary.done}/${summary.total}`
    : summary.state === 'completed'
      ? `Orch complete ${summary.done}/${summary.total}`
      : `Orch ${summary.done}/${summary.total}${engine}`;
  return (
    <button
      type="button"
      className="orch-pill"
      title="Open orchestration status"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
    >
      {label}
    </button>
  );
}

// One Slate session window: designed conversation by default, the real
// terminal behind the TTY toggle (permission prompts and menus live in the
// pty, not the transcript; a session waiting on one must never be a dead end).
// The inline question/answer interface, rendered INSIDE the window whose
// session is parked on a Claude select menu. A menu is a pty-only construct
// (it never reaches the transcript the conversation renders from), so this
// polls the pane directly and answers in place: the whole point is that the
// question and its answer live in the window where it is being asked, never in
// the shared command bar or the raw terminal.
function TileMenuAsk({ pane, sessionId, blockedHint }) {
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  // Which option is having a note written for it, and the note itself.
  const [notesFor, setNotesFor] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  // Why an answer did not land. A pick that quietly does nothing is the same
  // dead end as a card with no buttons: the card comes straight back and the
  // human is left guessing whether the click registered.
  const [answerError, setAnswerError] = useState(null);
  const busyRef = useRef(false);
  const blockedRef = useRef(false);
  blockedRef.current = Boolean(blockedHint);
  const paneId = pane?.paneId || null;

  useEffect(() => {
    if (!paneId) { setMenu(null); return undefined; }
    let live = true;
    let timer = null;
    const tick = async () => {
      if (!live) return;
      if (!busyRef.current) {
        try {
          const next = await window.harbor.session.menuState({ pane, sessionId, blockedHint: blockedRef.current });
          if (live && !busyRef.current) setMenu(next && (next.options?.length || next.fallback) ? next : null);
        } catch { if (live) setMenu(null); }
      }
      if (live) timer = setTimeout(tick, 700);
    };
    tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [paneId, sessionId, pane, blockedHint]);

  const answer = async (action) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    // A toggle only ticks a box: the question is still open and the card must
    // stay up, so it re-reads instead of clearing. Everything else ENDS the
    // question, where clearing optimistically is what makes the card disappear
    // the instant the answer lands rather than one poll later.
    const keepsCardUp = action.type === 'toggle';
    setAnswerError(null);
    if (!keepsCardUp) setMenu(null);
    try {
      const res = await window.harbor.session.answerMenu({ pane, action });
      if (res && res.ok === false) setAnswerError(res.reason || 'that answer did not land');
      if (action.type === 'text') setDraft('');
      if (keepsCardUp) {
        const next = await window.harbor.session.menuState({ pane, sessionId, blockedHint: blockedRef.current });
        setMenu(next && (next.options?.length || next.fallback) ? next : null);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Attach a note to one answer without leaving the window. The dialog's own
  // notes key (whatever the footer advertises) is pressed on that row, then the
  // text is delivered; the card stays up, because a note is not an answer.
  const sendNote = async (index, text) => {
    if (busyRef.current || !text) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await window.harbor.session.answerMenu({ pane, action: { type: 'notes', index, text } });
      setNotesFor(null);
      setNoteDraft('');
      const next = await window.harbor.session.menuState({ pane, sessionId, blockedHint: blockedRef.current });
      setMenu(next && (next.options?.length || next.fallback) ? next : null);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Fallback keys are incremental: the panel stays up and re-reads the screen
  // right away, so the pointer visibly moves in place instead of waiting out
  // the 700ms poll.
  const pressKey = async (action) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await window.harbor.session.answerMenu({ pane, action });
      if (action.type === 'raw') setDraft('');
      const next = await window.harbor.session.menuState({ pane, sessionId, blockedHint: blockedRef.current });
      setMenu(next && (next.options?.length || next.fallback) ? next : null);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (!menu) return null;

  // The no-dead-end panel: an unrecognized blocker shows its raw screen tail
  // and direct keys, so ANY dialog shape is answerable in the window. Enter is
  // never implied (a blind Enter once compacted a 559k-token session); the
  // text button types bytes only, the Enter key sends Enter.
  if (menu.fallback) {
    return (
      <div className="tile-ask" role="group" aria-label="Answer this prompt" onClick={(e) => e.stopPropagation()}>
        <div className="tile-ask-head">
          <span className="tile-ask-badge" aria-hidden="true">✳</span>
          <span className="tile-ask-eyebrow">Needs your answer</span>
        </div>
        <div className="tile-ask-note">
          Harbor does not recognize this prompt&apos;s shape yet (a copy was saved so it can learn it).
          The live screen below is driven directly by these keys.
        </div>
        <FallbackScreen lines={menu.screen} />
        <div className="tile-ask-keys">
          {[['up', '↑'], ['down', '↓'], ['space', 'Space'], ['enter', 'Enter'], ['esc', 'Esc']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="tile-ask-key"
              disabled={busy}
              aria-label={`Send ${label} to the prompt`}
              onClick={(e) => { e.stopPropagation(); pressKey({ type: 'key', key }); }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={`tile-ask-row text${busy ? ' busy' : ''}`}>
          <input
            className="tile-ask-input"
            type="text"
            value={draft}
            disabled={busy}
            placeholder="Type into the prompt (use the Enter key above to submit)"
            onClick={(e) => e.stopPropagation()}
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
            className="tile-ask-send"
            disabled={busy || !draft}
            aria-label="Type this into the prompt"
            title="Type this into the prompt (no Enter is sent)"
            onClick={(e) => { e.stopPropagation(); pressKey({ type: 'raw', text: draft }); }}
          >
            ⌨
          </button>
        </div>
      </div>
    );
  }
  // A batched AskUserQuestion draws a tab strip: several questions behind one
  // dialog, Tab to move between them. Which tab is CURRENT is carried in
  // colour alone and does not survive ANSI stripping, so the strip shows each
  // question's answered state and never a guessed "you are here".
  const tabs = menu.tabs || null;
  const questionTabs = tabs ? tabs.filter((tab) => !tab.submit) : [];
  const answered = questionTabs.filter((tab) => tab.done).length;
  // The batch, as the TRANSCRIPT describes it: real per-question headers and,
  // crucially, WHICH one is current. The pty's tab strip carries the current tab
  // in colour alone, which does not survive ANSI stripping, so it was never
  // shown; matching the on-screen options back to the question they belong to
  // derives it (ask-question.js). Absent that, the old strip still renders.
  const batch = menu.batch || null;
  const multi = Boolean(menu.multiSelect);
  // The pty view is clipped whether or not the transcript filled the gap in, and
  // either way the rows above the view need a way to be reached.
  const clippedView = menu.ptyClipped ?? menu.clipped;
  const ticked = multi ? menu.options.filter((o) => o.checked).length : 0;
  return (
    <div className="tile-ask" role="group" aria-label="Answer this question" onClick={(e) => e.stopPropagation()}>
      <div className="tile-ask-head">
        <span className="tile-ask-badge" aria-hidden="true">✳</span>
        <span className="tile-ask-eyebrow">Needs your answer</span>
        {batch ? (
          <span className="tile-ask-count">{`Question ${batch.currentIndex + 1} of ${batch.count}`}</span>
        ) : questionTabs.length > 1 ? (
          <span className="tile-ask-count">
            {answered ? `${answered} of ${questionTabs.length} answered` : `${questionTabs.length} questions`}
          </span>
        ) : null}
        {multi ? (
          <span className="tile-ask-count">{`pick any (${ticked} selected)`}</span>
        ) : null}
        <button
          type="button"
          className="tile-ask-dismiss"
          disabled={busy}
          title="Dismiss this question (Esc)"
          onClick={(e) => { e.stopPropagation(); answer({ type: 'cancel' }); }}
        >
          Dismiss
        </button>
      </div>
      {batch ? (
        <div className="tile-ask-tabs" aria-label="Questions in this batch">
          {batch.headers.map((tab, i) => (
            <span
              key={`${tab.header}-${i}`}
              className={`tile-ask-tab${tab.current ? ' cur' : ''}`}
              title={tab.current ? 'The question showing now' : `${tab.header}: use Next question to reach it`}
            >
              <span className="tile-ask-tab-mark" aria-hidden="true">{tab.current ? '●' : '○'}</span>
              {tab.header}
            </span>
          ))}
        </div>
      ) : tabs ? (
        <div className="tile-ask-tabs" aria-label="Questions in this batch">
          {tabs.map((tab, i) => (
            <span
              key={`${tab.label}-${i}`}
              className={`tile-ask-tab${tab.submit ? ' submit' : ''}${tab.done ? ' done' : ''}`}
              title={tab.submit ? 'Submits the whole batch' : `${tab.label}: ${tab.done ? 'answered' : 'not answered yet'}`}
            >
              <span className="tile-ask-tab-mark" aria-hidden="true">{tab.submit ? '➤' : (tab.done ? '✔' : '○')}</span>
              {tab.label}
            </span>
          ))}
        </div>
      ) : null}
      {menu.question ? <div className="tile-ask-q">{menu.question}</div> : null}
      {/* There is deliberately NO "the question scrolled out of the terminal
          view" note here any more, removed on explicit user request 2026-07-27: never
          show it again. It was never information anyone could act on, only a
          confession that Harbor was driving a 23-row pane at a 35-row dialog.
          The pane is grown to fit the dialog now (terminal-bridge
          ensureDialogSize) and the question is read from the transcript file
          (providers/pending-ask.js), so the card either knows the question or
          shows the raw screen in the fallback panel. */}
      {answerError ? <div className="tile-ask-err">{answerError}</div> : null}
      {/* The list scrolls INSIDE the card. It used to grow with the batch and
          run off the bottom of the window, which is what Pat hit: "i am scrolled
          down as far as possible and its still cut off" (2026-07-27). */}
      <div className="tile-ask-list">
        {menu.options.map((option) => (
          <div key={option.index} className="tile-ask-item">
            {option.isText ? (
              <>
                {option.description ? <p className="tile-ask-desc lead">{option.description}</p> : null}
                <div className={`tile-ask-row text${busy ? ' busy' : ''}`}>
                  <span className="tile-ask-num" aria-hidden="true">{option.index}</span>
                  <input
                    className="tile-ask-input"
                    type="text"
                    value={draft}
                    disabled={busy}
                    placeholder={option.label.replace(/[.…]+$/, '')}
                    onClick={(e) => e.stopPropagation()}
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
                    className="tile-ask-send"
                    disabled={busy || !draft.trim()}
                    aria-label="Send this answer"
                    title="Send this answer"
                    onClick={(e) => { e.stopPropagation(); answer({ type: 'text', index: option.index, text: draft.trim() }); }}
                  >
                    ↵
                  </button>
                </div>
              </>
            ) : (
              // Every option is a button, including one the pty has scrolled
              // above its own viewport. It used to be rendered dead, on the
              // grounds that the "❯" cannot be verified on a row the pane does
              // not draw; that reasoning was sound and the conclusion was
              // wrong. The walk keys on the option NUMBER and re-reads after
              // every keystroke, so it steps the highlight up until the row it
              // wants scrolls into view and only then presses Enter, and if it
              // never can it refuses out loud (shown above) instead of
              // guessing. Leaving the row dead just made Pat do the arrowing.
              <button
                type="button"
                className={`tile-ask-row${option.selected ? ' cur' : ''}${option.checked ? ' on' : ''}${option.offscreen ? ' off' : ''}`}
                disabled={busy}
                aria-pressed={multi ? Boolean(option.checked) : undefined}
                title={option.offscreen
                  ? `Option ${option.index} is above the terminal's visible area; Harbor scrolls the highlight to it and confirms before choosing.`
                  : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  // A tick is not a submit. On a multi-select question the click
                  // toggles and the batch is confirmed by its own button, so no
                  // single click can ever send a half-made answer.
                  answer(multi
                    ? { type: 'toggle', index: option.index }
                    : { type: 'select', index: option.index });
                }}
              >
                <span className="tile-ask-num" aria-hidden="true">
                  {multi ? (option.checked ? '☑' : '☐') : option.index}
                </span>
                <span className="tile-ask-body">
                  <span className="tile-ask-label">
                    {option.label}
                    {option.recommended ? <span className="tile-ask-rec">Recommended</span> : null}
                  </span>
                  {option.description ? <span className="tile-ask-desc">{option.description}</span> : null}
                </span>
                <span className="tile-ask-go" aria-hidden="true">{multi ? '' : '→'}</span>
              </button>
            )}
            {/* A SIBLING of the option button, overlaid on its right edge, never
                nested inside it: a button within a button is invalid markup and
                gives the row two conflicting accessible names. */}
            {menu.keys?.notes && !option.isText ? (
              <button
                type="button"
                className="tile-ask-note-btn"
                disabled={busy}
                title="Add a note to this answer"
                onClick={(e) => { e.stopPropagation(); setNotesFor(option.index); }}
              >
                note
              </button>
            ) : null}
            {notesFor === option.index ? (
              // Notes used to be a sentence telling Pat to go to the terminal
              // view, which is the dead end the in-window card exists to remove.
              <div className={`tile-ask-row text${busy ? ' busy' : ''}`}>
                <input
                  className="tile-ask-input"
                  type="text"
                  autoFocus
                  value={noteDraft}
                  disabled={busy}
                  placeholder={`Note on "${option.label.slice(0, 28)}"`}
                  onClick={(e) => e.stopPropagation()}
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
                  className="tile-ask-send"
                  disabled={busy || !noteDraft.trim()}
                  title="Attach this note to the answer"
                  onClick={(e) => { e.stopPropagation(); sendNote(option.index, noteDraft.trim()); }}
                >
                  ↵
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {(multi || clippedView || menu.keys?.switchQuestions) ? (
        <div className="tile-ask-foot">
          {multi ? (
            <button
              type="button"
              className="tile-ask-key primary"
              disabled={busy}
              title="Confirm the selected options (Enter)"
              onClick={(e) => { e.stopPropagation(); answer({ type: 'submit' }); }}
            >
              {`Submit ${ticked || 'no'} selected`}
            </button>
          ) : null}
          {menu.keys?.switchQuestions ? (
            <button
              type="button"
              className="tile-ask-key"
              disabled={busy}
              title="Move to the next question in this batch (Tab)"
              onClick={(e) => { e.stopPropagation(); pressKey({ type: 'key', key: 'tab' }); }}
            >
              Next question ⇥
            </button>
          ) : null}
          {clippedView ? (
            // The option list is taller than the pane, so its top rows are drawn
            // off screen. These move the highlight by hand and confirm it, which
            // keeps every option reachable without leaving the window.
            <>
              {[['up', '↑'], ['down', '↓'], ['enter', 'Enter']].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="tile-ask-key"
                  disabled={busy}
                  title={key === 'enter'
                    ? 'Choose whatever the terminal highlight is on now'
                    : `Move the highlight ${key}`}
                  onClick={(e) => { e.stopPropagation(); pressKey({ type: 'key', key }); }}
                >
                  {label}
                </button>
              ))}
              <span className="tile-ask-foot-note">
                Rows above the view are reachable with these keys.
              </span>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const SessionTile = memo(forwardRef(function SessionTile({
  session,
  data,
  pane,
  selected,
  index,
  slot,
  readOnly,
  tty,
  focused,
  focusHidden,
  dragging,
  dragStyle,
  placeholder,
  onHeaderPointerDown,
  onSelect,
  onClose,
  onToggleTty,
  onToggleFocus,
  onNewSibling,
  onOpenConfig,
  queueSummary,
  onOpenOrch,
  externallyControlled,
  xterm,
}, ref) {
  const { profiles } = useProfiles();
  const header = headerForOwnedPane(session, pane, data?.header || null);
  const blocks = useMemo(() => data?.blocks || [], [data?.blocks]);
  const color = projectColor(session.project);
  const live = Boolean(session.isLive || pane || header?.working);
  const runState = runStateCue(session, pane, header);
  const title = session.isChildTask && session.childTitle ? session.childTitle : session.title;
  const projectLabel = !session.project || session.project === '~' ? 'home' : session.project;
  const showKeycap = index < 9;
  // The + button says WHICH plan it will launch on, resolved the same way the
  // launch itself resolves it: a session with no home of its own (a codex or
  // cursor window, a provisional pane) falls back to the default profile, so
  // the tooltip and the outcome cannot disagree.
  const newSiblingProfile = resolveProfile(profiles, session.home);
  const newSiblingTitle = newSiblingProfile
    ? `New ${newSiblingProfile.label} session in ${projectLabel}`
    : `New session in ${projectLabel}`;
  const noTranscript = !data || data.missing;
  // A codex/cursor window is a DESIGNED window, same as claude's: the raw
  // terminal is what the >_ toggle is for. The one exception is a pane Harbor
  // cannot name at all (a live: row whose session id no evidence resolved).
  // The rule lives in terminal-view.cjs because the stage's visible-pane
  // registration must reach the SAME verdict, or this tile draws a terminal
  // nothing feeds (the 2026-08-08 empty black box).
  const { fallback: terminalFallback, showTerminal } = terminalView({ session, data, pane, tty });
  const displayModel = header?.model || providerModel(session.model, session.modelLabel);

  return (
    <div
      ref={ref}
      className={`win2 ${selected ? 'sel' : 'rest'}${header?.working ? ' working' : ''}${dragging ? ' dragging' : ''}${placeholder ? ' drag-placeholder' : ''}${focused ? ' focused' : ''}${focusHidden ? ' focus-hidden' : ''}`}
      style={{ '--pj': color, ...dragStyle }}
      data-session-id={session.id}
      data-slot={slot}
      onClick={dragging ? undefined : (event) => {
        onSelect();
        // Clicking a window ARMS its composer (Pat, 2026-07-25: no second
        // click into the text box), except when the click was aimed at
        // something interactive inside the window (an ask-panel input, the
        // raw terminal, any button) or just finished selecting conversation
        // text, where stealing focus would break the thing being done.
        if (event.target.closest('button, input, textarea, select, a, [contenteditable], .terminal-pane')) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        window.dispatchEvent(new CustomEvent('harbor-focus-composer'));
      }}
      onPointerDown={onHeaderPointerDown}
      onContextMenu={(event) => event.preventDefault()}
      role="group"
      aria-label={`${session.project} · ${title}`}
    >
      <div
        className="wh drag-handle"
      >
        <span className="wh-grip" aria-hidden="true" title="Drag to rearrange">⋮⋮</span>
        {showKeycap ? (
          <span className="kc" title={`Ctrl+${index + 1} selects this window`}>{`^${index + 1}`}</span>
        ) : null}
        <ProjectIcon label={session.project} iconClass="pj-icon" dotClass="pjdot" />
        <div className="who">
          <div className="pj">{projectLabel}</div>
          <div className="ti" title={title}>{title}</div>
          {runState ? (
            <span
              className={`runstate runstate-${runState.kind}`}
              role="status"
              aria-label={runState.ariaLabel}
            >
              <span className="runstate-dot" aria-hidden="true" />
              <span className="runstate-verb">{runState.label}</span>
            </span>
          ) : null}
        </div>
        <span className="spacer" aria-hidden="true" />
        {/* The status chips and the window controls are GROUPED so a dense grid
            can wrap the chips onto a second header line as one unit while
            identity and controls keep the first. Ungrouped, the header was a
            single nowrap flex row where `.who` was the only shrinkable child:
            at 12 windows it squeezed to zero (no project, no title) and the
            row then overflowed, and since the close button is the last child,
            `.win2{overflow:hidden}` clipped it away. Pat read that as "the x
            only shows on the highlighted one" (2026-07-27), which was really
            just whichever tile happened to carry fewer chips. */}
        <div className="wh-meta">
          {selected ? (
            <span className="selflag">active</span>
          ) : live ? (
            <span className="lv"><span className="pulse" aria-hidden="true" />live</span>
          ) : null}
          <OrchestrationPill summary={queueSummary} onClick={onOpenOrch} />
          {readOnly ? <span className="ro-flag" title="Orchestration worker: read-only">read-only</span> : null}
          <ModelChip
            model={displayModel}
            effort={header?.effort || session.effort}
            provider={session.provider}
            home={session.home}
            profiles={profiles}
            onClick={onOpenConfig}
          />
          <ContextGauge pct={header?.contextPct} tokens={header?.contextTokens} />
          <ProfileBadge profileId={session.home} profiles={profiles} className="apill" />
        </div>
        <div className="wh-ctl">
          {/* A sibling session in the SAME project on the SAME plan, launched
              with the standard defaults and no picker and no popover (Pat,
              2026-08-02). The whole point is that it is one click from a
              window he is already looking at, so it deliberately does NOT
              route through NewSessionConfig; the folder and the account come
              from this window, everything else from the saved default. It is
              first in the control group so it can never be mistaken for, or
              misclicked into, the close button at the other end. */}
          <button
            type="button"
            className="ico tile-new"
            title={newSiblingTitle}
            aria-label={`New session in ${projectLabel}`}
            onClick={(e) => { e.stopPropagation(); onNewSibling?.(); }}
          >
            +
          </button>
          {pane && !readOnly ? (
            <button
              type="button"
              className={`ico tty${tty ? ' on' : ''}`}
              title={tty ? 'Back to the conversation view' : 'Raw terminal (permission prompts live here)'}
              onClick={(e) => { e.stopPropagation(); onToggleTty(); }}
            >
              {'>_'}
            </button>
          ) : null}
          <button
            type="button"
            className={`ico tile-focus${focused ? ' on' : ''}`}
            title={focused ? 'Back to the grid' : 'Focus: this window takes the full stage'}
            aria-label={focused ? 'Collapse window back to the grid' : 'Focus this window'}
            onClick={(e) => { e.stopPropagation(); onToggleFocus(); }}
          >
            {focused ? '⇲' : '⛶'}
          </button>
          <button
            type="button"
            className="ico tile-close"
            title="Remove from the grid (the session keeps running)"
            aria-label="Close window"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          >
            ×
          </button>
        </div>
      </div>
      {!session.isChildTask ? <WorkflowStrip sessionId={session.id} /> : null}
      {showTerminal ? (
        <div className="tile-tty">
          {terminalFallback ? (
            <div className="terminal-provider-note">
              {`this ${providerIdentity(session.provider).label.toLowerCase()} pane has not named its session yet; showing its terminal`}
            </div>
          ) : null}
          <XtermPane
            paneId={pane.paneId}
            style={{}}
            focused={selected}
            highlighted={false}
            externallyControlled={externallyControlled}
            onFocusPane={xterm.onFocusPane}
            onBlurPane={xterm.onBlurPane}
            onResizePane={xterm.onResizePane}
            onSendInput={xterm.onSendInput}
            onFrame={xterm.onFrame}
            onBackfill={xterm.onBackfill}
            onReset={xterm.onReset}
          />
        </div>
      ) : (
        <Conversation
          blocks={blocks}
          header={header}
          provider={session.provider || 'claude'}
          home={session.home}
          profiles={profiles}
          empty={data && !data.missing
            ? 'No conversation in this session yet.'
            : String(session.id).startsWith('pane:')
              ? 'Fresh session. Type below to start it.'
              : String(session.id).startsWith('live:') || data?.missing
                ? 'No transcript yet. If this session is live, the >_ toggle shows its terminal.'
                : 'Loading transcript…'}
          // Nothing to read yet and a live pane behind it: the terminal is one
          // click away, never a hunt for the header toggle.
          emptyAction={pane && !readOnly && noTranscript ? (
            <button
              type="button"
              className="conv-empty-act"
              onClick={(event) => { event.stopPropagation(); onToggleTty(); }}
            >
              {'Open the raw terminal (>_)'}
            </button>
          ) : null}
        />
      )}
      {pane && !readOnly && !showTerminal && session.provider === 'claude' ? (
        <TileMenuAsk
          pane={pane}
          sessionId={session.id}
          blockedHint={runState?.kind === 'blocked'}
        />
      ) : null}
    </div>
  );
}));
