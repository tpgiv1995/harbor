import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as sidebarModel from '../../shared/sidebar-model.js';
import * as dateRoll from '../../shared/date-roll.js';
import { homeLabel, projectRowFill } from '../stage/project-colors.js';
import { ProjectIcon } from '../stage/ProjectIcon.jsx';
import { providerIdentity, ProfileBadge, useProfiles } from '../providers.js';
import { resumeCommandForProfile, railWidthForProfileCount, profileStyle } from '../profiles.cjs';
import { ViewSwitch } from '../ViewSwitch.jsx';
import { resetBadge, resetTooltip } from './usage-reset.cjs';

const { filterProjects, flattenSidebarRows, normalizeHome, regroupSidebarModel } = sidebarModel;
const { formatRelative } = dateRoll;

const ROW_HEIGHT = 34;
const PROJECT_ROW_HEIGHT = 44;
const DATE_ROW_HEIGHT = 44;
const RAIL_STORE_KEY = 'harbor-rail';
const ARCHIVE_STORE_KEY = 'harbor-archived';
// 292px, not the old 236px: the usage meters carry BOTH windows' reset instants
// on one line now (Pat, 2026-07-27), and 236 fit neither. 284 is the measured
// width at which even the WORST case renders in full ("100% ↻11:45pm  100%
// ↻12/31 12:30pm"), so no real value ever ellipsizes. The rail stays draggable,
// and the meters degrade rather than clip if it is dragged narrow (see the
// @container rules in styles.css).
const DEFAULT_RAIL_STATE = { width: 292, hidden: false, grouping: 'project' };
// Bump to re-seed a stored rail width from the default above.
const RAIL_STATE_VERSION = 3;

function restoreArchived() {
  try {
    const saved = JSON.parse(localStorage.getItem(ARCHIVE_STORE_KEY) || 'null');
    return new Set(Array.isArray(saved) ? saved : []);
  } catch { return new Set(); }
}
const MIN_RAIL_WIDTH = 190;
const MAX_RAIL_WIDTH = 420;

function clampRailWidth(width) {
  const numeric = Number(width);
  if (!Number.isFinite(numeric)) return DEFAULT_RAIL_STATE.width;
  return Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, Math.round(numeric)));
}

function restoreRailState(profileCount = 3) {
  const measuredDefault = railWidthForProfileCount(profileCount);
  try {
    const saved = JSON.parse(localStorage.getItem(RAIL_STORE_KEY) || 'null');
    const staleWidth = !saved || saved.v !== RAIL_STATE_VERSION;
    return {
      width: staleWidth ? measuredDefault : clampRailWidth(saved?.width),
      hidden: saved?.hidden === true,
      grouping: saved?.grouping === 'date' ? 'date' : 'project',
    };
  } catch {
    return { ...DEFAULT_RAIL_STATE, width: measuredDefault };
  }
}

function rowHeight(row) {
  if (row.kind === 'project') return PROJECT_ROW_HEIGHT;
  return row.kind === 'session' && row.project.isDateGroup ? DATE_ROW_HEIGHT : ROW_HEIGHT;
}

function VirtualList({ rows, renderRow }) {
  const containerRef = useRef(null);
  const [viewport, setViewport] = useState({ height: 600, scrollTop: 0 });

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const onScroll = () => setViewport((prev) => ({
      ...prev,
      scrollTop: node.scrollTop,
    }));
    const observer = new ResizeObserver(([entry]) => {
      setViewport((prev) => ({
        ...prev,
        height: entry.contentRect.height,
      }));
    });
    observer.observe(node);
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', onScroll);
    };
  }, []);

  const layout = useMemo(() => {
    let offset = 0;
    const positioned = rows.map((row) => {
      const height = rowHeight(row);
      const item = { row, top: offset, height };
      offset += height;
      return item;
    });
    return { positioned, totalHeight: offset };
  }, [rows]);

  const overscan = 8;
  const start = Math.max(0, viewport.scrollTop - overscan * ROW_HEIGHT);
  const end = viewport.scrollTop + viewport.height + overscan * ROW_HEIGHT;
  const visible = layout.positioned.filter((item) => item.top + item.height >= start && item.top <= end);

  return (
    <div className="sidebar-virtual-list" ref={containerRef}>
      <div className="sidebar-virtual-spacer" style={{ height: layout.totalHeight }}>
        {visible.map(({ row, top, height }) => (
          <div
            key={row.key}
            className="sidebar-virtual-item"
            style={{ transform: `translateY(${top}px)`, height }}
          >
            {renderRow(row)}
          </div>
        ))}
      </div>
    </div>
  );
}

function AccountBadge({ home, profiles }) {
  return <ProfileBadge profileId={normalizeHome(home, profiles)} profiles={profiles} className="sr-b" />;
}

// `short` marks the 5-hour group: it is the one that gives up its inline reset
// badge first when the rail is dragged narrow, because a 5-hour window resets
// again within the day while the weekly one is the planning number.
function MeterDonut({ pct, reset, title, short = false }) {
  const has = typeof pct === 'number' && Number.isFinite(pct);
  const shown = has ? Math.round(pct) : null;
  const fill = has ? Math.max(2, Math.min(100, pct)) : 0;
  const color = !has ? 'var(--fnt)' : pct >= 75 ? 'var(--warn)' : 'currentColor';
  return (
    <span className={`rm-g${short ? ' rm-g-5h' : ''}`} title={title}>
      <span
        className="rm-donut"
        style={{ background: `conic-gradient(${color} ${fill}%, rgba(255,255,255,.12) 0)` }}
        aria-hidden="true"
      >
        <span />
      </span>
      <b>{has ? `${shown}%` : '--'}</b>
      {reset ? <em>{reset}</em> : null}
    </span>
  );
}

// The per-account usage breakdown, pinned at the rail's bottom: 5-hour and
// weekly windows per plan, each with the INSTANT it resets. The weekly badge
// showed a bare date until 2026-07-27 ("7/31"), which told Pat the day but not
// the hour, so a reset that lands at 8pm was indistinguishable from one at
// 6am; the timestamp always carried the time, only the renderer dropped it.
// Every badge's own tooltip spells the same instant out in full, from one
// formatter, so the two can never disagree. The title-bar rings stay as the
// at-a-glance version.
function RailMeters({ profiles }) {
  const [usage, setUsage] = useState({});
  const refresh = React.useCallback(async () => {
    try { setUsage(await window.harbor.usage.getAll()); } catch { /* keep previous */ }
  }, []);
  useEffect(() => {
    refresh();
    const unsubscribe = window.harbor.usage.onUpdate(refresh);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { unsubscribe(); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  if (!profiles.length) return null;

  return (
    <div className="rail-meters" aria-label="Plan usage" data-profile-count={profiles.length}>
      {profiles.map((profile) => {
        const account = profile.id;
        const data = usage[account];
        const tooltip = [
          `${profile.label}${data?.email ? `: ${data.email}` : ''}`,
          typeof data?.cost === 'number' ? `last session $${data.cost.toFixed(2)}` : null,
          data?.updatedAt ? `updated ${formatRelative(data.updatedAt)}` : null,
          data?.unavailable ? (data?.reason || 'no data yet') : null,
        ].filter(Boolean).join(' · ') || undefined;
        const fiveHourBadge = resetBadge(data?.fiveHourResetsAt, { window: 'fiveHour' });
        const weeklyBadge = resetBadge(data?.weeklyResetsAt, { window: 'weekly' });
        return (
          <div
            className="rm-row"
            key={account}
            title={tooltip}
            data-account={account}
            style={profileStyle(profile)}
          >
            <ProfileBadge profileId={account} profiles={profiles} className="rm-b" title={profile.label} />
            <MeterDonut
              pct={data?.fiveHourPct}
              title={resetTooltip({
                window: 'fiveHour',
                pct: data?.fiveHourPct,
                resetsAt: data?.fiveHourResetsAt,
                rolled: data?.fiveHourRolled,
              })}
              reset={fiveHourBadge ? `↻${fiveHourBadge}` : ''}
              short
            />
            <MeterDonut
              pct={data?.weeklyPct}
              title={resetTooltip({
                window: 'weekly',
                pct: data?.weeklyPct,
                resetsAt: data?.weeklyResetsAt,
                rolled: data?.weeklyRolled,
              })}
              reset={weeklyBadge ? `↻${weeklyBadge}` : ''}
            />
          </div>
        );
      })}
    </div>
  );
}

function FilterChip({ label, active, onClick, dataFilter }) {
  return (
    <button
      type="button"
      className={`sidebar-filter-chip${active ? ' active' : ''}`}
      onClick={onClick}
      data-filter={dataFilter}
    >
      {label}
    </button>
  );
}

// The rail: Harbor's one and only session browser. Clicking a row OPENS the
// session as a window on the stage (read instantly; resume happens later, from
// the command bar, only when Pat actually sends something).
export function Sidebar({ onOpenOrch, onOpenSession, onCloseSession, onNewSession, openSessionIds, selectedSessionId, searchRef, view, onViewChange, orchEnabled = true, taskAlert = 0 }) {
  const { profiles, defaults, loaded: profilesLoaded } = useProfiles();
  const [railState, setRailState] = useState(() => restoreRailState(3));
  const [model, setModel] = useState({ projects: [], liveProjects: [] });
  const [indexerSessionCount, setIndexerSessionCount] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState({ kind: 'rolling', days: 2 });
  const [customSince, setCustomSince] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState(() => new Set());
  const [expandedOlder, setExpandedOlder] = useState(() => new Set());
  const [initializedCollapse, setInitializedCollapse] = useState(false);
  const [accountEmails, setAccountEmails] = useState({});
  const [archived, setArchived] = useState(restoreArchived);
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState(null); // { session, x, y, armedDelete }
  const inputRef = useRef(null);
  const pendingFocusRef = useRef(false);
  const dragRef = useRef(null);
  const { width, hidden, grouping } = railState;

  useEffect(() => {
    try { localStorage.setItem(ARCHIVE_STORE_KEY, JSON.stringify([...archived])); } catch { /* keep in-memory */ }
  }, [archived]);

  const archiveSession = useCallback((id) => {
    setArchived((prev) => new Set(prev).add(id));
    // Archiving a session also removes its window from the stage: hiding it from
    // the rail but leaving it open on the main view would be inconsistent.
    onCloseSession?.(id);
    setMenu(null);
  }, [onCloseSession]);
  const unarchiveSession = useCallback((id) => {
    setArchived((prev) => { const next = new Set(prev); next.delete(id); return next; });
    setMenu(null);
  }, []);
  useEffect(() => {
    if (showArchived && archived.size === 0) setShowArchived(false);
  }, [archived.size, showArchived]);
  const deleteSession = useCallback(async (session) => {
    setMenu(null);
    // Optimistically hide it so the row goes away immediately; the fs-watch
    // refresh confirms. Archive doubles as the local hide (and as the recovery
    // record if the delete IPC refuses). Also drop its stage window.
    setArchived((prev) => new Set(prev).add(session.id));
    onCloseSession?.(session.id);
    const res = await window.harbor.session.remove({ sessionId: session.id, isLive: session.isLive })
      .catch((error) => ({ ok: false, reason: error?.message }));
    if (!res?.ok) {
      // Delete failed (e.g. live session): un-hide and leave it visible so the
      // failure is honest rather than a silent vanish.
      setArchived((prev) => { const next = new Set(prev); next.delete(session.id); return next; });
    }
  }, [onCloseSession]);

  const updateRailState = useCallback((update) => {
    setRailState((previous) => {
      const next = typeof update === 'function' ? update(previous) : { ...previous, ...update };
      return { ...next, width: clampRailWidth(next.width) };
    });
  }, []);

  const toggleHidden = useCallback(() => {
    updateRailState((previous) => ({ ...previous, hidden: !previous.hidden }));
  }, [updateRailState]);

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_STORE_KEY, JSON.stringify({ ...railState, v: RAIL_STATE_VERSION }));
    } catch { /* keep in-memory state */ }
  }, [railState]);

  // The title-bar rail button drives and mirrors the same hidden state.
  useEffect(() => {
    const onToggle = () => toggleHidden();
    window.addEventListener('harbor-rail-toggle', onToggle);
    window.dispatchEvent(new CustomEvent('harbor-rail-state', { detail: { hidden: railState.hidden } }));
    return () => window.removeEventListener('harbor-rail-toggle', onToggle);
  }, [toggleHidden, railState.hidden]);

  useEffect(() => {
    const onKey = (event) => {
      // Ctrl+SHIFT+B, because plain Ctrl+B is bold in the composer (Pat,
      // 2026-07-26: "change the rail ctrl+b to something obscure, ive never
      // used it once"). The title-bar .rail-toggle-btn remains the discoverable
      // way in; this is the shortcut for it.
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      if (event.key.toLowerCase() !== 'b') return;
      event.preventDefault();
      event.stopPropagation();
      toggleHidden();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggleHidden]);

  useImperativeHandle(searchRef, () => ({
    focus() {
      if (hidden) {
        pendingFocusRef.current = true;
        updateRailState((previous) => ({ ...previous, hidden: false }));
      } else {
        inputRef.current?.focus();
      }
    },
  }), [hidden, searchRef, updateRailState]);

  // A focus requested while the rail was hidden can only land after the rail
  // (and its search input) has re-mounted; a single rAF is not enough under
  // load, so focus from the post-commit effect instead.
  useEffect(() => {
    if (!hidden && pendingFocusRef.current) {
      pendingFocusRef.current = false;
      inputRef.current?.focus();
    }
  }, [hidden]);

  // The rail renders from THIS component's model, not the app-level copy, so
  // harness fabrications need their own hook here; pinned so real pushes do
  // not clobber a test model mid-scenario. E2E-gated: absent in production.
  const pinnedTestModelRef = useRef(false);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const state = await window.harbor.sidebar.getState();
      if (!active || pinnedTestModelRef.current) return;
      setModel(state.model);
      setIndexerSessionCount(state.indexerSessionCount || 0);
      window.__harborSidebarStats = {
        indexerSessionCount: state.indexerSessionCount || 0,
      };
    };
    load();
    const unsubscribe = window.harbor.sidebar.onUpdate((state) => {
      if (pinnedTestModelRef.current) return;
      setModel(state.model);
      setIndexerSessionCount(state.indexerSessionCount || 0);
      window.__harborSidebarStats = {
        indexerSessionCount: state.indexerSessionCount || 0,
      };
    });
    if (window.harbor?.e2e) {
      window.__setRailModelForTest = (next) => {
        pinnedTestModelRef.current = next != null;
        if (next != null) setModel(next);
        else load();
      };
    }
    return () => {
      active = false;
      unsubscribe();
      delete window.__setRailModelForTest;
    };
  }, []);

  useEffect(() => {
    if (!profiles.length) return;
    const measured = railWidthForProfileCount(profiles.length);
    updateRailState((previous) => {
      if (previous.width === measured) return previous;
      try {
        const saved = JSON.parse(localStorage.getItem(RAIL_STORE_KEY) || 'null');
        if (saved?.v === RAIL_STATE_VERSION && Number.isFinite(saved?.width)) return previous;
      } catch { /* re-seed below */ }
      return { ...previous, width: measured };
    });
  }, [profiles.length, updateRailState]);

  useEffect(() => {
    window.harbor.accounts.readEmails().then(setAccountEmails).catch(() => {});
  }, []);

  useEffect(() => {
    if (initializedCollapse || !model.projects.length) return;
    const collapsed = new Set(
      model.projects
        .filter((project) => !project.hasLive && !model.liveProjects.includes(project.label))
        .map((project) => project.label),
    );
    setCollapsedProjects(collapsed);
    setInitializedCollapse(true);
  }, [model, initializedCollapse]);

  // Archive is a reversible rail view, independent from transcript deletion.
  // Select active OR archived sessions at the source so regroupSidebarModel
  // re-derives coherent projects, live counts, and row counts for either view.
  const visibleModel = useMemo(() => {
    if (!showArchived && archived.size === 0) return model;
    return {
      ...model,
      projects: (model.projects || []).map((project) => ({
        ...project,
        sessions: (project.sessions || []).filter((session) => archived.has(session.id) === showArchived),
      })),
    };
  }, [model, archived, showArchived]);

  const groupedModel = useMemo(
    () => regroupSidebarModel(visibleModel, { grouping }),
    [visibleModel, grouping],
  );

  const filtered = useMemo(
    () => filterProjects(groupedModel, {
      filter: filter.kind === 'since' && !customSince ? { kind: 'all' } : filter,
      query,
    }),
    [groupedModel, filter, query, customSince],
  );

  const searching = Boolean(query.trim());
  const timeFilterActive = filter.kind !== 'all' && !(filter.kind === 'since' && !customSince);
  const narrowing = searching || timeFilterActive;
  const filteredSessionIds = useMemo(() => filtered.projects
    .flatMap((project) => project.sessions || [])
    // Match the rail's orchestration-worker rule: workers only participate in
    // a bulk archive when search has explicitly surfaced them.
    .filter((session) => searching || !session.isChildTask)
    .map((session) => session.id), [filtered, searching]);
  const archiveAllFiltered = useCallback(() => {
    if (showArchived || filteredSessionIds.length === 0) return;
    setArchived((previous) => {
      const next = new Set(previous);
      for (const id of filteredSessionIds) next.add(id);
      return next;
    });
    for (const id of filteredSessionIds) onCloseSession?.(id);
    setMenu(null);
  }, [filteredSessionIds, onCloseSession, showArchived]);
  const { rows, sessionRowCount } = useMemo(
    () => flattenSidebarRows(filtered, {
      // While searching or time-filtering, collapse is ignored: a match hidden
      // inside a collapsed project is indistinguishable from no match at all.
      collapsedProjects: narrowing ? new Set() : collapsedProjects,
      expandedOlder,
      // Orchestration workers are excluded from the browser by default; an active
      // search re-includes matching ones so a specific worker can still be found.
      includeChildren: searching,
    }),
    [filtered, collapsedProjects, expandedOlder, narrowing, searching],
  );

  const toggleProject = (label) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const [copiedSessionId, setCopiedSessionId] = useState(null);
  const copyResumeCommand = useCallback(async (session) => {
    const profile = profiles.find((item) => item.id === session.home);
    // CLAUDE_CONFIG_DIR rather than a per-account flag: it is what the account
    // actually IS, it works for any launcher, and it can express a profile
    // whose name no hardcoded flag has ever heard of.
    const command = resumeCommandForProfile(profile, profiles, session.id);
    try {
      await navigator.clipboard.writeText(command);
      setCopiedSessionId(session.id);
      setTimeout(() => setCopiedSessionId(null), 1600);
    } catch { /* clipboard unavailable; do nothing rather than pop anything up */ }
    setMenu(null);
  }, [profiles]);

  const launchDefaultsForProfile = useMemo(() => ({
    provider: defaults?.provider || 'claude',
    model: defaults?.model || 'opus',
    effort: defaults?.effort || 'xhigh',
  }), [defaults]);

  const renderProfileLaunchButtons = (className, { folder, sessionId, immediate = false } = {}) => (
    profiles.map((profile) => (
      <button
        type="button"
        key={profile.id}
        className={`${className} ${profile.id}`}
        style={profileStyle(profile)}
        title={`New ${profile.label} session${folder ? ` in ${folder}` : ''}${accountEmails[profile.id] ? `: ${accountEmails[profile.id]}` : ''}`}
        onClick={async () => {
          let resolvedFolder = folder;
          if (!resolvedFolder) {
            resolvedFolder = await window.harbor.session.pickFolder();
            if (!resolvedFolder) return;
          }
          onNewSession({
            account: profile.id,
            provider: launchDefaultsForProfile.provider,
            model: launchDefaultsForProfile.model,
            effort: launchDefaultsForProfile.effort,
            folder: resolvedFolder,
            sessionId,
            immediate,
          });
        }}
      >
        {`+ ${profile.letter}`}
      </button>
    ))
  );

  const handleSessionContextMenu = (event, session) => {
    // Right-click opens a small options menu (copy resume command, archive,
    // delete). Rendered through a portal to document.body because a
    // backdrop-filter ancestor traps fixed-position descendants.
    event.preventDefault();
    setMenu({ session, x: event.clientX, y: event.clientY });
  };

  // Any click, scroll, or Escape dismisses the context menu.
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (event) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const renderRow = (row) => {
    if (row.kind === 'project') {
      const { project, collapsed } = row;
      // Orchestration still needs a historical session id, but new-session
      // actions use the full-corpus project anchor computed before filtering.
      // That anchor never substitutes an unresolved agent-detected live id,
      // preserving the 2026-07-18 protection against silent $HOME reroutes.
      const newSessionId = project.sessions?.find(
        (s) => !s.isWindowsEra && !s.isLive && !String(s.id).startsWith('live:'),
      )?.id || null;
      const newSessionFolder = project.newSessionCwd || null;
      // Orch asks a different question than the launch anchor above: it only
      // needs a project root, which a LIVE session answers just as well. Using
      // the dead-session anchor here hid the chip from all-live projects.
      const canOrch = !project.isDateGroup && !project.isWindowsEra
        && sidebarModel.projectRootSessionId(project) && onOpenOrch;
      const liveCount = project.sessions.filter((s) => s.isLive && !s.isChildTask).length;
      return (
        <div
          className={`sidebar-project-wrap${project.isDateGroup ? ' date-group' : ''}`}
          style={project.isDateGroup ? undefined : { '--pg-fill': projectRowFill(project.label) }}
        >
          <button
            type="button"
            className="pg"
            onClick={() => toggleProject(project.label)}
            title={`${project.label} · ${project.sessionCount} sessions`}
          >
            <span className="sidebar-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            {!project.isDateGroup ? <ProjectIcon label={project.label} /> : null}
            <span className="pg-label">{homeLabel(project.label)}</span>
            <span className="pg-meta">
              {project.isDateGroup
                ? `${project.sessionCount}`
                : liveCount > 0 ? `${liveCount} live` : formatRelative(project.sessions[0]?.lastActive || '')}
            </span>
          </button>
          {!project.isDateGroup && !project.isWindowsEra && newSessionFolder && profiles.length > 0 ? (
            <div className="sidebar-project-actions" data-profile-count={profiles.length}>
              {renderProfileLaunchButtons('sidebar-proj-new', {
                folder: newSessionFolder,
                sessionId: newSessionId,
                immediate: true,
              })}
              {canOrch && (
                <button
                  type="button"
                  className="sidebar-orch-btn"
                  title="Open orchestration panel"
                  onClick={() => onOpenOrch(project)}
                >
                  Orch
                </button>
              )}
            </div>
          ) : null}
        </div>
      );
    }

    if (row.kind === 'session') {
      const { session } = row;
      const provider = providerIdentity(session.provider);
      const disabled = session.isWindowsEra;
      const isChild = session.isChildTask;
      const displayTitle = isChild && session.childTitle ? session.childTitle : session.title;
      const isOpen = openSessionIds?.has(session.id);
      const isSelected = selectedSessionId === session.id;
      const isArchived = archived.has(session.id);
      return (
        <div
          className={`sr-wrap${isArchived ? ' archived' : ''}`}
          onContextMenu={(event) => handleSessionContextMenu(event, session)}
        >
          <button
            type="button"
            className={`sr${session.isLive ? ' live' : ''}${isOpen ? ' open' : ''}${isSelected ? ' sel' : ''}${disabled ? ' disabled' : ''}${isChild ? ' child' : ''}`}
            data-session-id={session.id}
            onClick={() => { if (!disabled) { setQuery(''); onOpenSession(session); } }}
            title={disabled
              ? 'Windows-era session: original folder no longer exists'
              : isChild
                ? 'Orchestration worker. Click to open read-only. Right-click for options.'
                : 'Click to open on the stage. Right-click for options.'}
            disabled={disabled}
          >
            <span className={`sr-d${session.isLive ? ' on' : ''}`} aria-hidden="true" />
            <img className="sr-provider" src={provider.logo} alt="" aria-hidden="true" />
            <span className="sr-copy">
              <span className="sr-t">
                {copiedSessionId === session.id ? 'Resume command copied' : displayTitle}
              </span>
              {session.model && session.model !== 'default' ? <span className="sr-project">{session.model}</span> : null}
              {grouping === 'date' ? <span className="sr-project">{homeLabel(session.project)}</span> : null}
            </span>
            <span className="sr-tm">{formatRelative(session.lastActive)}</span>
            <AccountBadge home={session.home} profiles={profiles} />
            {session.isWindowsEra ? <span className="sidebar-win-tag">win:</span> : null}
          </button>
          <button
            type="button"
            className="sr-x"
            data-session-id={session.id}
            title={isArchived ? 'Unarchive (show in rail again)' : 'Archive (hide from rail)'}
            aria-label={isArchived ? 'Unarchive session' : 'Archive session'}
            onClick={(event) => {
              event.stopPropagation();
              if (isArchived) unarchiveSession(session.id); else archiveSession(session.id);
            }}
          >
            {isArchived ? '↩' : '×'}
          </button>
        </div>
      );
    }

    if (row.kind === 'older') {
      return (
        <button
          type="button"
          className="sidebar-older-button"
          onClick={() => setExpandedOlder((prev) => new Set(prev).add(row.project.label))}
        >
          older...
          {' '}
          (
          {row.hiddenCount}
          )
        </button>
      );
    }

    return null;
  };

  const handleResizeStart = (event) => {
    dragRef.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handleResizeMove = (event) => {
    if (!dragRef.current) return;
    updateRailState((previous) => ({
      ...previous,
      width: dragRef.current.width + event.clientX - dragRef.current.x,
    }));
  };
  const handleResizeEnd = (event) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (hidden) {
    return (
      <aside className="rail-reopen-strip" aria-label="Session rail hidden">
        <button type="button" className="rail-reopen" onClick={toggleHidden} title="Show session rail (Ctrl+Shift+B)" aria-label="Show session rail">
          <span aria-hidden="true">›</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="rail" aria-label="Session rail" style={{ '--rail-width': `${width}px` }} data-grouping={grouping} data-profile-count={profiles.length}>
      {onViewChange ? (
        <div className="rail-view-switch">
          <ViewSwitch view={view} onViewChange={onViewChange} orchEnabled={orchEnabled} taskAlert={taskAlert} />
        </div>
      ) : null}
      <div className="rail-head">
        <span className="rail-eyebrow">Sessions</span>
        <span className="rail-count">
          {narrowing || sessionRowCount > 0
            ? `${sessionRowCount} / ${indexerSessionCount}`
            : indexerSessionCount}
        </span>
        {profiles.length > 0 ? (
          <div className="rail-new-split" data-profile-count={profiles.length}>
            {renderProfileLaunchButtons('sidebar-global-new')}
          </div>
        ) : profilesLoaded ? (
          <span className="rail-setup-hint" title="Add a Claude profile in Harbor settings">Set up a profile</span>
        ) : null}
      </div>

      {profilesLoaded && profiles.length === 0 ? (
        <div className="rail-setup-banner" role="status">
          No Claude profiles are configured yet. Add one in Harbor settings to start sessions.
        </div>
      ) : null}

      <div className="rail-find-wrap">
        <input
          ref={inputRef}
          className="rail-find sidebar-search-input"
          type="search"
          placeholder="Search…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search sessions"
        />
        {query ? (
          <button
            type="button"
            className="sidebar-search-clear"
            aria-label="Clear search"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        ) : (
          <span className="rail-find-kbd" aria-hidden="true">^K</span>
        )}
      </div>
      <div className="sidebar-controls">
        <div className="sidebar-filters" role="group" aria-label="Time filters">
          <FilterChip label="Today" dataFilter="today" active={filter.kind === 'today'} onClick={() => setFilter({ kind: 'today' })} />
          <FilterChip label="48h" dataFilter="48h" active={filter.kind === 'rolling' && filter.days === 2} onClick={() => setFilter({ kind: 'rolling', days: 2 })} />
          <FilterChip label="7d" dataFilter="7d" active={filter.kind === 'rolling' && filter.days === 7} onClick={() => setFilter({ kind: 'rolling', days: 7 })} />
          <FilterChip label="30d" dataFilter="30d" active={filter.kind === 'rolling' && filter.days === 30} onClick={() => setFilter({ kind: 'rolling', days: 30 })} />
          <FilterChip label="All" dataFilter="all" active={filter.kind === 'all'} onClick={() => setFilter({ kind: 'all' })} />
          <input
            className="sidebar-since-input"
            type="date"
            title="Only sessions since this date"
            value={customSince}
            onChange={(event) => {
              setCustomSince(event.target.value);
              if (event.target.value) setFilter({ kind: 'since', value: event.target.value });
            }}
          />
        </div>
        <div className="rail-view-controls">
          <div className="rail-grouping-toggle" role="group" aria-label="Group sessions by">
            {['project', 'date'].map((mode) => (
              <button
                key={mode}
                type="button"
                className={grouping === mode ? 'active' : ''}
                data-grouping={mode}
                aria-pressed={grouping === mode}
                onClick={() => updateRailState((previous) => ({ ...previous, grouping: mode }))}
              >
                {mode === 'project' ? 'Project' : 'Date'}
              </button>
            ))}
          </div>
          {!showArchived && filteredSessionIds.length > 0 ? (
            <button
              type="button"
              className="rail-archive-filtered"
              title={`Archive all ${filteredSessionIds.length} filtered sessions`}
              aria-label={`Archive all ${filteredSessionIds.length} filtered sessions`}
              onClick={archiveAllFiltered}
            >
              {`Archive ${filteredSessionIds.length}`}
            </button>
          ) : null}
          {archived.size > 0 ? (
            <button
              type="button"
              className={`rail-archived-toggle${showArchived ? ' active' : ''}`}
              aria-pressed={showArchived}
              title={showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
              onClick={() => setShowArchived((v) => !v)}
            >
              {`Archived ${archived.size}`}
            </button>
          ) : null}
          {/* Rail hide/show lives in the title bar (.rail-toggle-btn) and Ctrl+Shift+B;
              a second in-rail collapse button here only overflowed this row onto
              its own wasted line, so it is intentionally not duplicated. */}
        </div>
      </div>

      <VirtualList rows={rows} renderRow={renderRow} />

      <RailMeters profiles={profiles} />
      <div
        className={`rail-resize-handle${width === MIN_RAIL_WIDTH ? ' at-min' : ''}${width === MAX_RAIL_WIDTH ? ' at-max' : ''}`}
        role="separator"
        title={width === MIN_RAIL_WIDTH ? 'Minimum rail width' : width === MAX_RAIL_WIDTH ? 'Maximum rail width' : 'Drag to resize session rail'}
        aria-label="Resize session rail"
        aria-orientation="vertical"
        aria-valuemin={MIN_RAIL_WIDTH}
        aria-valuemax={MAX_RAIL_WIDTH}
        aria-valuenow={width}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      {menu ? createPortal(
        <div
          className="sr-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <span className="sr-menu-title">{menu.session.childTitle || menu.session.title || 'Session'}</span>
          {!menu.session.isWindowsEra ? (
            <button type="button" role="menuitem" className="sr-menu-item" onClick={() => copyResumeCommand(menu.session)}>
              Copy resume command
            </button>
          ) : null}
          {archived.has(menu.session.id) ? (
            <button type="button" role="menuitem" className="sr-menu-item" onClick={() => unarchiveSession(menu.session.id)}>
              Unarchive
            </button>
          ) : (
            <button type="button" role="menuitem" className="sr-menu-item" onClick={() => archiveSession(menu.session.id)}>
              Archive (hide from rail)
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={`sr-menu-item danger${menu.armedDelete ? ' armed' : ''}`}
            disabled={menu.session.isLive}
            title={menu.session.isLive ? 'Stop the live session before deleting' : 'Move the transcript to trash'}
            onClick={() => {
              if (menu.armedDelete) deleteSession(menu.session);
              else setMenu((m) => (m ? { ...m, armedDelete: true } : m));
            }}
          >
            {menu.session.isLive
              ? 'Delete (stop the live session first)'
              : menu.armedDelete ? 'Click again to delete for good' : 'Delete…'}
          </button>
        </div>,
        document.body,
      ) : null}
    </aside>
  );
}
