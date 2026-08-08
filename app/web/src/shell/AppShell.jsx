import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { CONNECTION, createRpcClient } from '../rpc/client.js';
import { RpcProvider } from '../rpc/rpc-context.jsx';
import { useOpenSessions } from '../nav/useOpenSessions.js';
import { useSidebar } from '../rail/useSidebar.js';
import { useProjectIcons } from '../rail/useProjectIcons.js';
import { Conversation } from '../conversation/Conversation.jsx';
import { useTranscript } from '../conversation/use-transcript.js';
import { AskCard } from '../ask/AskCard.jsx';
import { SessionBrowser } from '../browse/SessionBrowser.jsx';
import { ProjectIcon } from '../rail/ProjectIcon.jsx';
import { Composer } from '../composer/Composer.jsx';
import { NewSessionSheet } from '../newsession/NewSessionSheet.jsx';
import { SettingsSheet } from '../settings/SettingsSheet.jsx';
import { CapabilitySheet } from '../capability/CapabilitySheet.jsx';
import { PlanSheet } from '../plan/PlanSheet.jsx';
import { buildBrowserRows } from '../browse/rows.js';
import { useVisualViewport } from './use-visual-viewport.js';
import { prettyModelId } from './model-label.js';
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

function connectionLabel(state, error) {
  if (state === CONNECTION.connected) return 'Connected';
  if (state === CONNECTION.connecting) return 'Connecting…';
  if (state === CONNECTION.error) return error || 'Connection error';
  return 'Disconnected';
}

// The header carries WHERE YOU ARE, which on a phone is the one thing the
// screen has to tell you. It used to say "Harbor", the name of the app you are
// already looking at, and nothing about which session was on screen. The
// session identity now takes the whole bar and IS the control that opens the
// browser, so switching sessions is a thumb-sized target instead of a 13px
// text button in the corner.
function SessionHeaderButton({ session, iconUrl, onOpenBrowse }) {
  const project = session?.project && session.project !== '~' ? session.project : 'home';
  const title = session ? (session.childTitle || session.title || 'Untitled session') : 'Choose a session';
  const state = session?.agentStatus === 'blocked'
    ? 'blocked'
    : session?.agentStatus === 'working'
      ? 'working'
      : session?.isLive ? 'live' : 'idle';
  return (
    <button type="button" className="hdr-session" onClick={onOpenBrowse} aria-label="Switch session">
      {session ? <ProjectIcon label={session.project} url={iconUrl} /> : null}
      <span className="hdr-id">
        <span className="hdr-project">{session ? project : 'Harbor'}</span>
        <span className="hdr-title">{title}</span>
      </span>
      <span className={`hdr-state hdr-state-${state}`} aria-hidden="true" />
      <svg className="hdr-chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function SessionScreen({
  client, session, onOpenBrowse, onHeader,
}) {
  const { blocks, header, missing, loading } = useTranscript(client, session?.id);
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

  useEffect(() => { onHeader?.(header || null); }, [header, onHeader]);

  if (!session) {
    return (
      <div className="conv-pane empty">
        <p className="conv-empty-title">No session open</p>
        <p className="conv-empty-hint">Pick a session to start.</p>
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
      ? (String(session.id).startsWith('pane:')
        ? 'Fresh session. Nothing sent yet.'
        : 'No transcript yet.')
      : 'No conversation in this session yet.';

  return (
    <section className="conv-pane shell-screen shell-screen-sessions">
      <Conversation
        blocks={blocks}
        header={header}
        provider={session.provider || 'claude'}
        empty={empty}
      />
      {pane && session.provider === 'claude' ? (
        <AskCard client={client} pane={pane} sessionId={session.id} blockedHint={blockedHint} />
      ) : null}
      <Composer
        sessionId={session.id}
        paneId={session.paneId}
        disabled={false}
        working={Boolean(header?.working)}
        onSent={() => {}}
      />
    </section>
  );
}

export function AppShell({ settings, auth, onRequestSetup, onSignOut }) {
  useVisualViewport();

  const [connection, setConnection] = useState(CONNECTION.disconnected);
  const [connectionError, setConnectionError] = useState(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [activeHeader, setActiveHeader] = useState(null);

  const [client, setClient] = useState(null);
  const { model, loadError, refresh: refreshSidebar, applyPush: applySidebarPush } = useSidebar(client);
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

  const activeSession = activeId ? sessionsById.get(activeId) : null;
  const visibleModel = activeHeader?.model?.label
    || activeSession?.modelLabel
    || (activeHeader?.model?.id ? prettyModelId(activeHeader.model.id) : null)
    || (activeSession?.model ? prettyModelId(activeSession.model) : null)
    || 'Model';
  const visibleEffort = activeHeader?.effort || activeSession?.effort || null;
  const disconnected = connection !== CONNECTION.connected;

  const browserRows = useMemo(
    () => buildBrowserRows(model, { iconUrl }),
    [model, iconUrl],
  );

  const openBrowse = useCallback(() => setBrowseOpen(true), []);
  const closeBrowse = useCallback(() => setBrowseOpen(false), []);

  return (
    <RpcProvider client={client}>
      <div
        className={`app-shell${disconnected ? ' is-disconnected' : ''}${browseOpen ? ' is-browsing' : ''}`}
        data-connection={disconnected ? 'offline' : 'online'}
      >
        <div className="aurora" aria-hidden="true" />
        <>
            <header className="app-header">
              <div className="header-top">
                <SessionHeaderButton
                  session={activeSession}
                  iconUrl={activeSession ? iconUrl(activeSession.project) : null}
                  onOpenBrowse={openBrowse}
                />
                {activeSession ? <div className="hdr-cap-actions">
                  <button type="button" onClick={() => setCapabilityOpen(true)} aria-label="Model, effort and permissions" title={`${visibleModel}${visibleEffort ? ` · ${visibleEffort}` : ''}`}>{visibleModel}{visibleEffort ? ` · ${visibleEffort}` : ''}</button>
                  <button type="button" onClick={() => setPlanOpen(true)} aria-label="Plan and usage" title={planLabel(activeSession)}>{planLabel(activeSession)}</button>
                </div> : null}
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
              {/* Connection state is silent while it is fine. A permanent green
                  "Connected" bar spent a row telling Pat
                  something that is true almost always; the shell carries it as
                  a data attribute for anything that needs to read it, and the
                  banner appears only when there is something to say. */}
              {disconnected ? (
                <div className="connection-banner offline" role="status">
                  <span className="connection-dot" aria-hidden="true" />
                  <span>{connectionLabel(connection, connectionError)}</span>
                </div>
              ) : null}
            </header>

            <main className="app-main">
              {disconnected ? (
                <div className="offline-panel" role="alert">
                  <p>Cannot reach harbor-server.</p>
                  <p className="offline-detail">
                    Check Tailscale and that harbor-server is running.
                  </p>
                  {connectionError ? (
                    <p className="offline-detail offline-reason">{connectionError}</p>
                  ) : null}
                </div>
              ) : null}
              {loadError ? <div className="load-error" role="alert">{loadError}</div> : null}

              <SessionScreen
                client={client}
                session={activeSession}
                onOpenBrowse={openBrowse}
                onHeader={setActiveHeader}
              />
            </main>
        </>

        {browseOpen && !disconnected ? (
          <div className="shell-drawer-layer">
            <button type="button" className="shell-drawer-backdrop" onClick={closeBrowse} aria-label="Close sessions" />
            <div className="shell-drawer">
              <SessionBrowser
                open
                model={model}
                rows={browserRows}
                activeSessionId={activeId}
                onPick={(session) => openSession(session.id)}
                onClose={closeBrowse}
                onNewSession={() => setNewSessionOpen(true)}
              />
            </div>
          </div>
        ) : null}

        <NewSessionSheet
          client={client}
          open={newSessionOpen}
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
          auth={auth}
          onRequestSetup={onRequestSetup}
          onSignOut={onSignOut}
        />
        <CapabilitySheet open={capabilityOpen} onClose={() => setCapabilityOpen(false)} client={client} session={activeSession} header={activeHeader} onApplied={({ model: nextModel, effort: nextEffort }) => setActiveHeader((current) => ({ ...(current || {}), ...(nextEffort ? { effort: nextEffort } : {}), ...(nextModel ? { model: { id: nextModel, label: nextModel } } : {}) }))} />
        <PlanSheet open={planOpen} onClose={() => setPlanOpen(false)} client={client} session={activeSession} />
      </div>
    </RpcProvider>
  );
}
