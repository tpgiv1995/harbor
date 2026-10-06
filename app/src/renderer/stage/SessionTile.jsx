import React, { forwardRef, memo, useEffect, useMemo, useRef, useState } from 'react';
import { Conversation } from './Conversation.jsx';
import { XtermPane } from '../terminal/XtermPane.jsx';
import { projectColor } from './project-colors.js';
import { ProjectIcon } from './ProjectIcon.jsx';
import { providerIdentity, providerModel, ProfileBadge, useProfiles, resolveProfile } from '../providers.js';
import { AskCard } from './AskCard.jsx';
import turnMetaHelpers from './turn-meta.cjs';
import { AskForm } from './AskForm.jsx';
import { PromptForm } from './PromptForm.jsx';
import { useModelDialogs } from './use-dialog-state.js';
import { cacheFreshness, describeCacheFreshness } from './cache-freshness.cjs';
import { WorkflowStrip } from './WorkflowStrip.jsx';
import { terminalView } from './terminal-view.cjs';
import { copyText } from './md.jsx';
import { runStateCue } from '../../shared/session-run-state.cjs';
import { createPortal } from 'react-dom';

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

// Prompt-cache warmth beside the context gauge, from the transcript's own
// usage facts (never guessed; no facts, no chip). Re-derived on a timer
// because warmth expires with no transcript event to repaint on.
function CacheChip({ touchedMs, ttlMs }) {
  const [, bump] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    if (!touchedMs || !ttlMs) return undefined;
    const timer = setInterval(bump, 30_000);
    return () => clearInterval(timer);
  }, [touchedMs, ttlMs]);
  const info = describeCacheFreshness(cacheFreshness({ touchedMs, ttlMs }));
  if (!info) return null;
  return (
    <span className={`cache-chip cache-${info.state}`} title={info.title}>
      {info.label}
    </span>
  );
}

function headerForOwnedPane(session, pane, header) {
  if (!pane || !session.agentStatus) return header;
  // Agent detection can lag on a busy daemon, so it must never
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
  const label = summary.state === 'abandoned'
    ? `Orch abandoned ${summary.done}/${summary.total}`
    : summary.state === 'completed'
      ? `Orch complete ${summary.done}/${summary.total}`
      : `Orch ${summary.done}/${summary.total} ${summary.stateWord || 'no signal'}${summary.signal ? `, ${summary.signal}` : ''}`;
  return (
    <button
      type="button"
      className={`orch-pill ${summary.currentState === 'quiet' ? 'quiet' : ''}`}
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
// The question card itself is stage/AskCard.jsx (the answer sheet, 2026-09-03).
const { parseTokenCount, liveMeterLabel } = turnMetaHelpers;

// LIVE WORK METER (2026-10-05). While a Claude window is mid-turn the header
// shows "38s · ↓ 2.4k" beside the run state, like the CLI's own working line.
// Main reads that line off the pane (main/work-meter.js), but the CLI HIDES it
// while prose streams, so the chip does not mirror it frame by frame: elapsed
// ticks locally from the task's prompt, and tokens are the larger of the last
// count the CLI showed and the transcript's running total for the task
// (turn-meta.cjs liveMeterLabel). Polled only while the window is working.
function useWorkMeter(session, pane, working, prompt) {
  const paneId = pane?.paneId || null;
  const active = Boolean(working && paneId && (session.provider || 'claude') === 'claude');
  const promptKey = prompt?.key || null;
  const [cli, setCli] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setCli(null);
    if (!active) return undefined;
    let alive = true;
    let timer = null;
    const tick = async () => {
      const next = await window.harbor?.session?.workMeter?.({ pane, sessionId: session.id }).catch(() => null);
      if (!alive) return;
      // Keep the last count through the stretches the CLI hides its line.
      if (next) setCli((prev) => ({ elapsed: next.elapsed || prev?.elapsed || null, tokens: parseTokenCount(next.tokens) ?? prev?.tokens ?? null, verb: next.verb, thinking: next.thinking }));
      setNow(Date.now());
      timer = setTimeout(tick, 1000);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // pane is read through paneId; a fresh pane object for the same id is the same pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, paneId, session.id, promptKey]);
  if (!active) return null;
  const startMs = prompt?.ts ? Date.parse(prompt.ts) : NaN;
  const label = liveMeterLabel({
    startMs: Number.isFinite(startMs) ? startMs : null,
    now,
    cliTokens: cli?.tokens ?? null,
    turnTokens: prompt?.turnMeta?.outputTokens ?? null,
    cliElapsed: cli?.elapsed || null,
  });
  return label ? { label, title: cli?.verb ? `${cli.verb}${cli.thinking ? ' · thinking' : ''}` : 'Working' } : null;
}

export const SessionTile = memo(forwardRef(function SessionTile({
  session,
  data,
  pendingAsk,
  pane,
  selected,
  attention,
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
  onOpenDelegations,
  externallyControlled,
  xterm,
}, ref) {
  const { profiles } = useProfiles();
  const [copiedId, setCopiedId] = useState(false);
  const [taskTip, setTaskTip] = useState(null);
  const header = headerForOwnedPane(session, pane, data?.header || null);
  const blocks = useMemo(() => data?.blocks || [], [data?.blocks]);
  const color = projectColor(session.project);
  const modelDialogs = useModelDialogs();
  const awaitingAnswer = pendingAsk && !pendingAsk.answered || modelDialogs.has(session.id);
  const runState = runStateCue(session, pane, awaitingAnswer ? { ...header, blocked: true } : header);
  const lastPrompt = useMemo(() => { for (let i = blocks.length - 1; i >= 0; i -= 1) if (blocks[i].kind === 'user' && !blocks[i].queued) return blocks[i]; return null; }, [blocks]);
  const workMeter = useWorkMeter(session, pane, Boolean(header?.working) && !awaitingAnswer, lastPrompt);
  const title = session.isChildTask && session.childTitle ? session.childTitle : session.title;
  const projectLabel = !session.project || session.project === '~' ? 'home' : session.project;
  const showKeycap = index < 9;
  // The id button copies the session's real UUID so it can be handed to another
  // session (`claude --resume <id>`, or just "look at session <id>"). A
  // provisional pane (`pane:`) or an unresolved live row (`live:`) carries only
  // a synthetic id no other session can act on, so the button stays hidden until
  // a real transcript id lands.
  const sessionIdStr = String(session.id);
  const canCopyId = !sessionIdStr.startsWith('pane:') && !sessionIdStr.startsWith('live:');
  // The + button says WHICH plan it will launch on, resolved the same way the
  // launch itself resolves it: a session with no home of its own (a codex or
  // cursor window, a provisional pane) falls back to the default profile, so
  // the tooltip and the outcome cannot disagree.
  const newSiblingProvider = session.provider || 'claude';
  const newSiblingProfile = resolveProfile(profiles.filter(p => (p.provider || 'claude') === newSiblingProvider), session.home);
  const newSiblingTitle = newSiblingProfile
    ? `New ${providerIdentity(newSiblingProvider).label} session (${newSiblingProfile.label}) in ${projectLabel}`
    : `New ${providerIdentity(newSiblingProvider).label} session in ${projectLabel}`;
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
      role="group"
      aria-label={`${session.project} · ${title}`}
    >
      <div
        className="wh drag-handle"
      >
        {/* Top row: the project name grows and truncates, and the window controls
            pin to the top-right on the SAME row (Pat, 2026-08-31: "controls should
            be in the top right, same row as project title"). The session title
            gets its OWN full-width row below, so it shows as much as it can before
            clipping and never loses width to the buttons. */}
        <div className="wh-top">
          {showKeycap ? (
            <span className="kc" title={`Ctrl+${index + 1} selects this window`}>{`^${index + 1}`}</span>
          ) : null}
          <ProjectIcon label={session.project} iconClass="pj-icon" dotClass="pjdot" />
          <div className="pj" title={projectLabel}>{projectLabel}</div>
          <div className="wh-ctl">
            {/* Sibling session in the SAME project on the SAME plan (Pat,
                2026-08-02); first in the group so it is never mistaken for the
                close button at the other end. */}
            <button
              type="button"
              className="ico tile-new"
              title={newSiblingTitle}
              aria-label={newSiblingTitle}
              onClick={(e) => { e.stopPropagation(); onNewSibling?.(); }}
            >
              +
            </button>
            {/* Copy the session's unique id to the clipboard, to hand to another
                session for referencing. `copyText` reports whether it landed
                (navigator.clipboard fails silently over file://), so the ✓ only
                shows on a real copy. */}
            {canCopyId ? (
              <button
                type="button"
                className={`ico tile-id${copiedId ? ' ok' : ''}`}
                title={copiedId ? 'Session id copied' : 'Copy this session’s id'}
                aria-label="Copy session id"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (await copyText(session.id)) {
                    setCopiedId(true);
                    setTimeout(() => setCopiedId(false), 1200);
                  }
                }}
              >
                {copiedId ? '✓' : 'id'}
              </button>
            ) : null}
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
        <div className="ti" title={title}>{title}</div>
        {/* One status line: the run state (ready / working / blocked) folded in
            with the model and context chips. The old separate "live" chip and the
            window attention pip both said the same thing as this and were dropped
            (Pat, 2026-08-31: "you have ready, live, and a blue dot? insanely
            inefficient"); selection is shown by the window ring, not a chip. */}
        <div className="wh-meta">
          {runState ? (
            <span
              className={`runstate runstate-${runState.kind}`}
              role="status"
              aria-label={runState.ariaLabel}
              tabIndex={runState.tooltip ? 0 : undefined}
              onMouseEnter={(event) => { if (runState.tooltip) setTaskTip(event.currentTarget.getBoundingClientRect()); }}
              onMouseLeave={() => setTaskTip(null)}
              onFocus={(event) => { if (runState.tooltip) setTaskTip(event.currentTarget.getBoundingClientRect()); }}
              onBlur={() => setTaskTip(null)}
            >
              <span className="runstate-dot" aria-hidden="true" />
              <span className="runstate-verb">{runState.label}</span>
            </span>
          ) : null}
          {workMeter ? (
            <span className="work-meter" title={workMeter.title}>{workMeter.label}</span>
          ) : null}
          {taskTip && runState?.tooltip ? createPortal(<div role="tooltip" className="background-task-tip" style={{ left: Math.min(taskTip.left, window.innerWidth - 370), top: taskTip.bottom + 6 }}>{runState.tooltip}</div>, document.body) : null}
          {session.delegationSummary?.total ? <button className="orch-pill delegation-pill" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onOpenDelegations(); }}>agents {session.delegationSummary.running} running / {session.delegationSummary.total}</button> : null}
          <OrchestrationPill summary={queueSummary} onClick={onOpenOrch} />
          {readOnly ? <span className="ro-flag" title="Orchestration worker: read-only">read-only</span> : null}
          <ModelChip
            model={displayModel}
            effort={header?.effort || session.effort}
            provider={session.provider}
            home={session.home}
            profiles={profiles}
            onClick={readOnly ? () => {} : onOpenConfig}
          />
          <ContextGauge pct={header?.contextPct} tokens={header?.contextTokens} />
          <CacheChip touchedMs={header?.cacheTouchedMs} ttlMs={header?.cacheTtlMs} />
          {/* Account shown once: the ModelChip already carries a `.model-acct`
              badge for a claude session, so the standalone `.apill` shows ONLY for
              a non-claude provider whose chip carries none. */}
          {session.home && session.provider !== 'claude' ? (
            <ProfileBadge profileId={session.home} profiles={profiles} className="apill" />
          ) : null}
        </div>
      </div>
      {!readOnly ? <WorkflowStrip sessionId={session.id} /> : null}
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
            externallyControlled={externallyControlled || readOnly}
            onFocusPane={xterm.onFocusPane}
            onBlurPane={xterm.onBlurPane}
            onResizePane={xterm.onResizePane}
            onSendInput={readOnly ? () => {} : xterm.onSendInput}
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
      {/* A question that arrived through the hook (JSON, every option and
          preview intact) is a FORM and takes precedence; the screen-scraping
          card stays as the floor for a session started without the hook. */}
      {/* Rendered in the raw-terminal view too: with the hook holding the
          question, the pty shows a spinner and nothing else, so the form is
          the only place the question exists. */}
      {pendingAsk && !readOnly && pendingAsk.kind && pendingAsk.kind !== 'ask' ? (
        <PromptForm key={pendingAsk.id} ask={pendingAsk} onAnswer={(id, payload) => window.harbor.asks.answer({id,...payload})} />
      ) : pendingAsk && !readOnly ? (
        <AskForm
          key={pendingAsk.id}
          ask={pendingAsk}
          selected={selected}
          onChat={() => { onSelect(); window.dispatchEvent(new Event('harbor-focus-composer')); }}
          onAnswer={(id, payload) => window.harbor.asks.answer({ id, ...payload })}
          onDecline={(id, reason) => window.harbor.asks.decline({ id, reason })}
        />
      ) : pane && !readOnly && !showTerminal && session.provider === 'claude' ? (
        <AskCard
          pane={pane}
          sessionId={session.id}
          selected={selected}
          blockedHint={runState?.kind === 'blocked'}
        />
      ) : null}
    </div>
  );
}));
