import { subSessionReadOnly } from '../../../src/shared/sub-sessions.js';
import { runStateCue } from '../../../src/shared/session-run-state.cjs';
import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { CONNECTION, createRpcClient } from '../rpc/client.js';
import { RpcProvider } from '../rpc/rpc-context.jsx';
import { useOpenSessions } from '../nav/useOpenSessions.js';
import { useSidebar } from '../rail/useSidebar.js';
import { useProjectIcons } from '../rail/useProjectIcons.js';
import { Conversation } from '../conversation/Conversation.jsx';
import { useTranscript } from '../conversation/use-transcript.js';
import { AskCard } from '../ask/AskCard.jsx';
import { HookPrompt } from '../ask/HookPrompt.jsx';
import { useHookAsks } from '../ask/use-hook-asks.js';
import { SessionBrowser } from '../browse/SessionBrowser.jsx';
import { ProjectIcon } from '../rail/ProjectIcon.jsx';
import { Composer } from '../composer/Composer.jsx';
import { NewSessionSheet } from '../newsession/NewSessionSheet.jsx';
import { SettingsSheet } from '../settings/SettingsSheet.jsx';
import { CapabilitySheet } from '../capability/CapabilitySheet.jsx';
import { PlanSheet } from '../plan/PlanSheet.jsx';
import { BottomNav } from '../nav/BottomNav.jsx';
import { TasksView } from '../tasks/TasksView.jsx';
import { NotesView } from '../notes/NotesView.jsx';
import { useNotes } from '../notes/useNotes.js';
import { buildBrowserRows } from '../browse/rows.js';
import { useVisualViewport } from './use-visual-viewport.js';
import { useTyping } from './use-typing.js';
import { prettyModelId } from './model-label.js';
import { SessionMeta, SessionStatus, useSessionFacts } from './SessionMeta.jsx';
import { CopySessionIdButton, NewSessionHereButton } from './SessionActions.jsx';
import { newSessionHerePreset } from './session-actions.cjs';
import { ErrorBoundary } from '../../../src/renderer/ErrorBoundary.jsx';
import './shell.css';

// The plan chip used to render String(home).slice(0, 1).toUpperCase(): a bare
// "P". It means nothing to anyone who has not read the source, and it was the
// only label on a 44px square button. The profile's own name is what it should
// have said all along, so it says that. Deliberately NOT a fixed vocabulary:
// profiles are a user-defined ordered list, so whatever the profile is called
// is what shows, and an unknown one falls back to a word rather than a letter.
function planLabel(session) {
  const raw = String(session?.home || session?.account || '').trim();
  if (!raw) return 'Plan';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// CONNECTION STATE COSTS ONE PILL, NEVER HALF THE SCREEN (2026-10-21, Pat: "if
// it disconnects then theres this massive fucking pinned header section that
// takes up over half the screen"). A drop used to add a full-width banner row to
// the header AND a "Cannot reach harbor-server" card above the conversation,
// 340px together on a 932px phone, and with the keyboard up that pushed the box
// he was typing in under the keyboard. The state now lives in a pill on the
// header's identity row: "Reconnecting" for the first seconds, "Offline" after.
// Tapping it retries at once and says why; the conversation, the list and the
// typed text all stay where they are. The full-screen explanation is kept for the
// one case where there is nothing else to show: a first start that has never
// connected and has nothing cached.
function ConnectionPill({ long, error, onRetry }) {
  const [open, setOpen] = useState(false);
  const label = long ? 'Offline' : 'Reconnecting';
  return (
    <div className="conn">
      <button
        type="button"
        className={`conn-pill ${long ? 'is-offline' : 'is-reconnecting'}`}
        aria-expanded={open}
        aria-label={long ? 'Offline. Show details and retry' : 'Reconnecting. Show details'}
        onClick={() => { setOpen((value) => !value); onRetry?.(); }}
      >
        <span className="conn-dot" aria-hidden="true" />
        <span>{label}</span>
      </button>
      {open ? (
        <div className="conn-pop" role="status">
          <p className="conn-pop-title">{long ? 'Can’t reach Harbor on your PC' : 'Reconnecting to Harbor'}</p>
          <p className="conn-pop-detail">
            {long
              ? 'Retrying on its own. Your conversation and anything you type stay here.'
              : 'The phone dropped the connection; this usually takes a second or two.'}
          </p>
          {error ? <p className="conn-pop-reason">{error}</p> : null}
          <div className="conn-pop-actions">
            <button type="button" className="conn-pop-retry" onClick={() => onRetry?.()}>Retry now</button>
            <button type="button" className="conn-pop-close" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function OfflineScreen({ error, onRetry }) {
  return (
    <div className="conv-pane empty offline-screen" role="alert">
      <span className="offline-mark" aria-hidden="true" />
      <p className="conv-empty-title">Can’t reach Harbor on your PC</p>
      <p className="conv-empty-hint">Check that Tailscale is on (with no exit node) and that Harbor is running on the PC. This screen retries on its own.</p>
      {error ? <p className="offline-reason">{error}</p> : null}
      <button type="button" className="btn-primary conv-pick" onClick={onRetry}>Retry now</button>
    </div>
  );
}

const PROVIDER_NAME = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

// The effort as the desktop's model chip badges it (MED, not "medium"), so the
// facts strip has room for the status.
const EFFORT_BADGE = { medium: 'med' };
const PICKED_KEY = 'harbor-picked-session';

function greeting(name) {
  const hour = new Date().getHours();
  const time = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return `Good ${time}${name && name !== 'Plan' ? `, ${name}` : ''}`;
}

function NotesScreen({ client }) {
  return <NotesView {...useNotes(client)} />;
}

// The header carries WHERE YOU ARE, which on a phone is the one thing the
// screen has to tell you. It used to say "Harbor", the name of the app you are
// already looking at, and nothing about which session was on screen. The
// session identity now takes the whole bar and IS the control that opens the
// browser, so switching sessions is a thumb-sized target instead of a 13px
// text button in the corner.
function SessionHeaderButton({ session, header, facts, iconUrl, onOpenBrowse }) {
  const project = session?.project && session.project !== '~' ? session.project : 'home';
  const title = session ? (session.childTitle || session.title || 'Untitled session') : 'Choose a session';
  const cue = runStateCue(session, null, header);
  const state = cue?.kind === 'background' ? 'background' : cue?.kind === 'blocked'
    ? 'blocked'
    : cue?.kind === 'running'
      ? 'working'
      : session?.isLive ? 'live' : 'idle';
  return (
    <button type="button" className={`hdr-session${session ? '' : ' is-empty'}`} onClick={onOpenBrowse} aria-label={session ? `Switch session (now: ${title})` : 'Switch session'}>
      {session ? <ProjectIcon label={session.project} url={iconUrl} /> : null}
      <span className="hdr-id">
        <span className="hdr-kicker">
          <span className="hdr-project">{session ? project : 'Harbor'}</span>
          {session ? <SessionStatus facts={facts} /> : null}
        </span>
        <span className="hdr-title">{title}</span>
      </span>
      <span className={`hdr-state hdr-state-${state}`} title={cue?.tooltip || cue?.label} aria-label={cue?.ariaLabel} />
      <svg className="hdr-chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function ViewHeader({ view }) {
  const title = view === 'tasks' ? 'Tasks' : 'Notes';
  return <div className="hdr-view"><span className="hdr-view-kicker">Harbor</span><h1>{title}</h1></div>;
}

function SessionScreen({
  client, session, onOpenBrowse, onHeader, accountName, offline,
}) {
  const asks = useHookAsks(client);
  const pendingAsk = asks.find(ask => ask.sessionId === session?.id && !ask.answered);
  const { blocks, header, missing, loading, stale } = useTranscript(client, session?.id);
  // MEMOIZED ON THE IDS, NOT REBUILT PER RENDER. AskCard's poll effect takes
  // this object as a dependency, so a fresh identity on every render tore that
  // effect down and re-ran it, and its first act is an immediate
  // `session:menu-state` RPC. That turned every re-render of this component
  // into a network round trip; with iOS firing visualViewport events at the
  // refresh rate it measured 40 RPCs for 40 events, which is what overflowed
  // the server's per-client queue and flapped Pat's phone (2026-08-08).
  const paneId = session?.paneId || null;
  const workspaceId = session?.workspaceId || null;
  const pane = useMemo(
    () => (paneId ? { paneId, workspaceId } : null),
    [paneId, workspaceId],
  );

  // The header row's live meter times the task from its prompt, as the
  // desktop window header does, so the last real prompt rides up with it.
  const lastPrompt = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i];
      if (block.kind === 'user' && !block.queued) return { ts: block.ts || null, turnMeta: block.turnMeta || null };
    }
    return null;
  }, [blocks]);
  useEffect(() => { onHeader?.(header ? { ...header, lastPrompt, stale: Boolean(stale) } : null); }, [header, lastPrompt, stale, onHeader]);

  if (!session) {
    return (
      <div className="conv-pane empty warm-empty motion-fade-up">
        <p className="conv-empty-eyebrow">WELCOME TO HARBOR</p>
        <p className="conv-empty-title">{greeting(accountName)}</p>
        <p className="conv-empty-hint">Choose a session when you’re ready to pick up the thread.</p>
        <button type="button" className="btn-primary conv-pick" onClick={onOpenBrowse}>
          Open sessions
        </button>
      </div>
    );
  }

  const blockedHint = session.agentStatus === 'blocked' || header?.blocked;
  const empty = loading
    ? 'Loading transcript…'
    : missing
      ? 'No transcript yet.'
      : 'Nothing sent in this session yet.';

  return (
    <section className="conv-pane shell-screen shell-screen-sessions">
      {/* Background work ("7 tasks running") is a status in the header strip
          now, not a row of its own above the conversation. */}
      <Conversation
        blocks={blocks}
        header={header}
        empty={empty}
      />
      {pane && !subSessionReadOnly(session) && session.provider === 'claude' ? (
        // ONE FOLD FOR EVERY QUESTION SURFACE (2026-10-21). While the composer
        // has the keyboard, whatever is asking (a parsed card, a hook form, a
        // permission card, the raw-screen fallback) folds to this one bar so
        // the text being typed keeps the screen; Answer puts the keyboard away
        // and the full surface returns. Per-card folds missed the hook and
        // fallback renderers (second review). shell.css draws the bar only
        // when a surface is actually present.
        <div className="question-dock">
          <div className="question-fold">
            <span className="question-fold-badge" aria-hidden="true">{'\u2733\uFE0E'}</span>
            <span className="question-fold-text">Claude is asking you something</span>
            <button type="button" className="question-fold-open" onClick={() => document.activeElement?.blur?.()}>Answer</button>
          </div>
          {pendingAsk ? <HookPrompt client={client} ask={pendingAsk} /> : <AskCard client={client} pane={pane} sessionId={session.id} blockedHint={blockedHint} />}
        </div>
      ) : null}
      <Composer
        sessionId={session.id}
        paneId={session.paneId}
        disabled={subSessionReadOnly(session)}
        working={Boolean(header?.working)}
        onSent={() => {}}
        offline={offline}
      />
    </section>
  );
}

export function AppShell({ settings, auth, onRequestSetup, onSignOut }) {
  useVisualViewport();
  const shellRef = useRef(null);
  const typing = useTyping(shellRef);

  const [connection, setConnection] = useState(CONNECTION.disconnected);
  const [connectionError, setConnectionError] = useState(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  // What the sheet opens on: null from the session browser's plus, a chat's folder,
  // provider and plan from that chat's header button.
  const [newSessionPreset, setNewSessionPreset] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [activeHeader, setActiveHeader] = useState(null);
  const [view, setView] = useState('chat');

  const [client, setClient] = useState(null);
  const { model, loadError, refresh: refreshSidebar, applyPush: applySidebarPush, fetchSlice } = useSidebar(client);
  const { iconUrl, refresh: refreshIcons } = useProjectIcons(client, settings.serverUrl);
  const { activeId, openSession } = useOpenSessions();

  const refreshRef = useRef({});
  refreshRef.current = {
    sidebar: refreshSidebar,
    sidebarPush: applySidebarPush,
    icons: refreshIcons,
  };

  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || activeId) return;
    const projects = model?.projects;
    if (!Array.isArray(projects) || !projects.length) return;
    const sessions = projects.flatMap((p) => p.sessions || []);
    if (!sessions.length) return;
    const byRecency = (a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0);
    const REAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const hasContent = (s) => REAL_ID.test(String(s.id || ''))
      && (Boolean(s.firstPrompt) || Boolean(s.title && !/^✳/.test(s.title)));
    const withContent = sessions.filter(hasContent);
    const pick = withContent.filter((s) => s.needsAnswer || s.blocked).sort(byRecency)[0]
      || withContent.filter((s) => s.isLive).sort(byRecency)[0]
      || withContent.sort(byRecency)[0]
      || [...sessions].sort(byRecency)[0];
    if (!pick?.id) return;
    autoOpened.current = true;
    openSession(pick.id);
  }, [model, activeId, openSession]);

  useEffect(() => {
    const rpc = createRpcClient({
      serverUrl: settings.serverUrl,
      token: settings.token,
      onPush: (channel, ...args) => {
        // Apply the pushed payload directly instead of re-fetching (see
        // useSidebar's applyPush comment): a fetch-on-push here is what
        // turned every sidebar change into a second, uncoalesced ~680KB RPC
        // round trip.
        if (channel === 'sidebar:update') refreshRef.current.sidebarPush?.(args[0]);
        if (channel === 'project-icons:update') refreshRef.current.icons?.();
      },
      onConnectionChange: (state, error) => {
        setConnection(state);
        setConnectionError(error || null);
        if (state === CONNECTION.connected) {
          refreshRef.current.sidebar?.();
          refreshRef.current.icons?.();
        }
      },
    });
    setClient(rpc);
    rpc.connect();
    return () => {
      rpc.disconnect();
      setClient(null);
    };
  }, [settings.serverUrl, settings.token]);

  const sessionsById = useMemo(() => {
    const map = new Map();
    for (const project of model.projects || []) {
      for (const session of project.sessions || []) {
        map.set(session.id, session);
      }
    }
    return map;
  }, [model]);

  // A SESSION PICKED FROM SEARCH OPENS (2026-10-21 review, finding 16). The
  // list the shell holds is the phone's 48-hour projection, so a row the
  // drawer found in 7d, 30d, All or search was missing from it and the pick
  // landed on "Choose a session". The picked row is kept (and survives a
  // reload) as the fallback until the live list carries that session.
  const [pickedSession, setPickedSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem(PICKED_KEY) || 'null'); } catch { return null; }
  });
  const pickSession = useCallback((session) => {
    if (!session?.id) return;
    setPickedSession(session);
    try { localStorage.setItem(PICKED_KEY, JSON.stringify(session)); } catch { /* memory only */ }
    openSession(session.id);
  }, [openSession]);
  const activeSession = activeId
    ? (sessionsById.get(activeId) || (pickedSession?.id === activeId ? pickedSession : null))
    : null;
  const modelIdentity = activeHeader?.model?.id
    || activeSession?.model
    || activeHeader?.model?.label
    || activeSession?.modelLabel
    || '';
  const visibleModel = activeHeader?.model?.label
    || activeSession?.modelLabel
    || (activeHeader?.model?.id ? prettyModelId(activeHeader.model.id) : null)
    || (activeSession?.model ? prettyModelId(activeSession.model) : null)
    || 'Model';
  const visibleEffort = activeHeader?.effort || activeSession?.effort || null;
  const compactModel = prettyModelId(modelIdentity) || visibleModel;
  const modelTier = /opus/i.test(modelIdentity)
    ? 'high'
    : /sonnet/i.test(modelIdentity) ? 'medium' : 'low';
  const disconnected = connection !== CONNECTION.connected;
  // A drop is routine on a phone (iOS closes a backgrounded app's socket) and
  // the client now reconnects the moment the app is visible again, so the first
  // seconds of one show a small "Reconnecting" pill over the content you were
  // reading. Only a drop that lasts says "Cannot reach harbor-server".
  const [offlineLong, setOfflineLong] = useState(false);
  useEffect(() => {
    if (!disconnected) { setOfflineLong(false); return undefined; }
    const timer = setTimeout(() => setOfflineLong(true), 5000);
    return () => clearTimeout(timer);
  }, [disconnected]);
  const hasCachedRail = Boolean(model?.projects?.length);
  const activePane = activeSession?.paneId ? { paneId: activeSession.paneId, workspaceId: activeSession.workspaceId || null } : null;
  const activeCue = activeSession ? runStateCue(activeSession, activePane, activeHeader) : null;
  const backgroundLabel = activeCue?.kind === 'background' ? activeCue.label : null;
  // While the link is down every fact is last-known, and says so ("Last seen
  // working"); the dots go grey in shell.css (2026-10-21 review, finding 6).
  const factsHeader = disconnected && activeHeader ? { ...activeHeader, stale: true } : activeHeader;
  const facts = useSessionFacts({ client, session: activeSession, header: factsHeader, pane: activePane, background: disconnected ? null : backgroundLabel });
  const retryNow = useCallback(() => client?.reconnectNow?.(), [client]);
  // The one case the full explanation is for: nothing cached and no session to
  // show, so the screen would otherwise be an empty welcome that cannot work.
  const coldOffline = disconnected && offlineLong && !hasCachedRail && !activeSession;

  const browserRows = useMemo(
    () => buildBrowserRows(model, { iconUrl }),
    [model, iconUrl],
  );

  const openNewSession = useCallback(() => { setNewSessionPreset(null); setNewSessionOpen(true); }, []);
  const hereRequest = useMemo(() => newSessionHerePreset(activeSession), [activeSession]);
  const openNewSessionHere = useCallback(() => {
    if (!hereRequest) return;
    setNewSessionPreset(hereRequest);
    setNewSessionOpen(true);
  }, [hereRequest]);
  // Named like desktop's "+" tooltip: which provider and plan it starts on, and where.
  const newHereLabel = activeSession
    ? (() => {
      const provider = activeSession.provider || 'claude';
      const hasPlan = provider !== 'cursor' && (activeSession.home || activeSession.account);
      const project = activeSession.project && activeSession.project !== '~' ? activeSession.project : 'home';
      return `New ${PROVIDER_NAME[provider] || provider} session${hasPlan ? ` (${planLabel(activeSession)})` : ''} in ${project}`;
    })()
    : 'New session';

  // The project line reserves room for the buttons beside it by their measured
  // width (a connection pill joins them when the link drops, and typing takes two
  // away), so nothing is a guessed number.
  const headerTopRef = useRef(null);
  const toolsRef = useRef(null);
  useLayoutEffect(() => {
    const top = headerTopRef.current;
    const tools = toolsRef.current;
    if (!top || !tools) return undefined;
    const measure = () => top.style.setProperty('--hdr-tools-w', `${tools.offsetWidth}px`);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(tools);
    return () => observer.disconnect();
  }, [view]);

  const openBrowse = useCallback(() => setBrowseOpen(true), []);
  const closeBrowse = useCallback(() => setBrowseOpen(false), []);

  return (
    <RpcProvider client={client}>
      <div
        ref={shellRef}
        className={`app-shell${disconnected ? ' is-disconnected' : ''}${browseOpen ? ' is-browsing' : ''}`}
        data-connection={disconnected ? 'offline' : 'online'}
        data-typing={typing ? 'true' : 'false'}
      >
        <>
            {/* TWO ROWS AT MOST, ONE WHILE TYPING (2026-10-21). Row one is
                where you are (the session, which opens the switcher), the
                connection pill when there is something to say, and settings.
                Row two is one strip of facts and controls: model, plan,
                context, status, cache. It used to be three rows (identity,
                chips, facts) plus a banner row and an error card. */}
            <header className="app-header">
              <span className="pane-glass" aria-hidden="true" />
              <div className={`header-top${view === 'chat' ? ' has-session' : ''}`} ref={headerTopRef}>
                {view === 'chat' ? <SessionHeaderButton
                  header={activeHeader}
                  facts={facts}
                  session={activeSession}
                  iconUrl={activeSession ? iconUrl(activeSession.project) : null}
                  onOpenBrowse={openBrowse}
                /> : <ViewHeader view={view} />}
                <div className="hdr-tools" ref={toolsRef}>
                {disconnected ? <ConnectionPill long={offlineLong} error={connectionError} onRetry={retryNow} /> : null}
                {view === 'chat' && activeSession ? (
                  <>
                    {/* Offline neither button has a job worth its room: a new session
                        needs the host, and at 375 the connection pill's own words
                        (Reconnecting) plus two more 44px buttons left the project
                        reading 'HAR...' (2026-10-31 review). The room is the pill's. */}
                    {disconnected ? null : <NewSessionHereButton label={newHereLabel} disabled={!hereRequest} onOpen={openNewSessionHere} />}
                    {disconnected ? null : <CopySessionIdButton sessionId={activeSession.id} />}
                  </>
                ) : null}
                <button
                  type="button"
                  className="btn-ghost hdr-settings"
                  onClick={() => setSettingsOpen(true)}
                  aria-label="Settings"
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                    <path
                      d="M3.5 6h13M3.5 10h13M3.5 14h13"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                    <circle cx="8" cy="6" r="2" fill="currentColor" />
                    <circle cx="12.5" cy="10" r="2" fill="currentColor" />
                    <circle cx="9" cy="14" r="2" fill="currentColor" />
                  </svg>
                </button>
                </div>
              </div>
              {view === 'chat' && activeSession ? (
                <div className="hdr-strip">
                  <button type="button" disabled={subSessionReadOnly(activeSession)} className={`hdr-chip hdr-model-chip tier-${modelTier} effort-${visibleEffort || 'default'}`} onClick={() => setCapabilityOpen(true)} aria-label={`Model ${visibleModel}${visibleEffort ? `, effort ${visibleEffort}` : ''}`}><span className="hdr-chip-face">{compactModel}{visibleEffort ? <span className="hdr-chip-effort">{EFFORT_BADGE[visibleEffort] || visibleEffort}</span> : null}</span></button>
                  <button type="button" className="hdr-chip hdr-plan-chip" onClick={() => setPlanOpen(true)} aria-label={`Plan ${planLabel(activeSession)} and usage`}><span className="hdr-chip-face">{planLabel(activeSession)}</span></button>
                  <SessionMeta facts={facts} />
                </div>
              ) : null}
            </header>

            <main className="app-main">
              {loadError && !disconnected ? <div className="load-error" role="alert">{loadError}</div> : null}

              <ErrorBoundary key={view === 'chat' ? `chat:${activeId || ''}` : view} name={view === 'tasks' ? 'Tasks' : view === 'notes' ? 'Notes' : 'Session'}>
              {/* The cached list (local-cache.js) can name a session on the very
                  first render, before the effect above has created the RPC
                  client; the composer's useRpc() would throw, and the error
                  boundary would hold that error after the client arrives
                  (caught in the 2026-10-11 cold-boot screenshot). The client
                  exists one effect later, so waiting for it costs nothing. */}
              {view === 'chat' && coldOffline ? <OfflineScreen error={connectionError} onRetry={retryNow} /> : null}
              {view === 'chat' && client && !coldOffline ? <SessionScreen
                client={client}
                session={activeSession}
                onOpenBrowse={openBrowse}
                onHeader={setActiveHeader}
                accountName={planLabel(activeSession)}
                offline={disconnected}
              /> : null}
              {view === 'tasks' ? <TasksView client={client} /> : null}
              {view === 'notes' ? <NotesScreen client={client} /> : null}
              </ErrorBoundary>
            </main>
            <BottomNav active={view} onSelect={setView} />
        </>

        {browseOpen && (!disconnected || hasCachedRail) ? (
          <div className="shell-drawer-layer">
            <button type="button" className="shell-drawer-backdrop" onClick={closeBrowse} aria-label="Close sessions" />
            <div className="shell-drawer">
              <SessionBrowser
                open
                model={model}
                rows={browserRows}
                activeSessionId={activeId}
                onPick={pickSession}
                onClose={closeBrowse}
                onNewSession={openNewSession}
                fetchSlice={fetchSlice}
              />
            </div>
          </div>
        ) : null}

        <NewSessionSheet
          client={client}
          open={newSessionOpen}
          preset={newSessionPreset}
          onClose={() => setNewSessionOpen(false)}
          onCreated={({ sessionId }) => {
            setNewSessionOpen(false);
            setBrowseOpen(false);
            if (sessionId) openSession(sessionId);
            refreshSidebar();
          }}
        />

        <SettingsSheet
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          serverUrl={settings.serverUrl}
          hasToken={Boolean(settings.token)}
          connection={connection}
          onRetry={retryNow}
          auth={auth}
          onRequestSetup={onRequestSetup}
          onSignOut={onSignOut}
        />
        <CapabilitySheet open={capabilityOpen && !subSessionReadOnly(activeSession)} onClose={() => setCapabilityOpen(false)} client={client} session={activeSession} header={activeHeader} onApplied={({ model: nextModel, effort: nextEffort }) => setActiveHeader((current) => ({ ...(current || {}), ...(nextEffort ? { effort: nextEffort } : {}), ...(nextModel ? { model: { id: nextModel, label: nextModel } } : {}) }))} />
        <PlanSheet open={planOpen} onClose={() => setPlanOpen(false)} client={client} session={activeSession} />
      </div>
    </RpcProvider>
  );
}
