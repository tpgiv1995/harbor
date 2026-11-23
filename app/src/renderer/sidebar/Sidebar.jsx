import { subSessionReadOnly } from '../../shared/sub-sessions.js';
import { useSidebarState } from './store.js';
import { runStateCue } from '../../shared/session-run-state.cjs';
import React, {
  useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import * as sidebarModel from '../../shared/sidebar-model.js';
import * as dateRoll from '../../shared/date-roll.js';
import { homeLabel, projectRowFill } from '../stage/project-colors.js';
import { ProjectIcon } from '../stage/ProjectIcon.jsx';
import { providerIdentity, ProfileBadge, useProfiles } from '../providers.js';
import {
  resumeCommandForProfile, railLaunchPlan, railPrimaryPlan, planForKey, RAIL_DEFAULT_WIDTH, profileStyle,
} from '../profiles.cjs';
import { ViewSwitch } from '../ViewSwitch.jsx';
import { resetBadge, resetTooltip, usageText } from './usage-reset.cjs';
import { collapseForView, planCollapseAll } from './collapse-policy.cjs';
import { railStatus } from './rail-status.cjs';
import RenameField, { PencilIcon } from '../RenameField.jsx';
import {
  SORT_MODES, SORT_LABELS, normalizeRailSort, sortHint, sortLabel, sortSidebarModel,
} from './rail-sort.cjs';
import {
  applyProjectFilter, matchProjectOptions, normalizeProjectFilter, orderProjectOptions,
  projectFilterLabel, projectFilterOptions, toggleProjectFilter,
} from './project-filter.cjs';

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
const DEFAULT_RAIL_STATE = {
  width: RAIL_DEFAULT_WIDTH, hidden: false, grouping: 'project', sort: 'newest', projectFilter: [],
};
// The Claude plan the launch button's "+" starts: the plan last picked in the
// plan picker (railPrimaryPlan in profiles.cjs).
const LAUNCH_STORE_KEY = 'harbor-rail-launch-plan';
// Bump to re-seed a stored rail width from the default above. Deliberately NOT
// bumped for the 2026-08-25 sort/project-filter fields: they read through their
// own normalizers, so an older stored rail state upgrades in place, and bumping
// would throw away a rail width Pat had dragged to where he wants it.
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

function restoreRailState() {
  const measuredDefault = RAIL_DEFAULT_WIDTH;
  try {
    const saved = JSON.parse(localStorage.getItem(RAIL_STORE_KEY) || 'null');
    const staleWidth = !saved || saved.v !== RAIL_STATE_VERSION;
    return {
      width: staleWidth ? measuredDefault : clampRailWidth(saved?.width),
      hidden: saved?.hidden === true,
      grouping: saved?.grouping === 'date' ? 'date' : 'project',
      sort: normalizeRailSort(saved?.sort),
      projectFilter: normalizeProjectFilter(saved?.projectFilter),
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

// A row can be renamed once it has a lasting id (a provisional pane or an
// unnamed live pane has none yet), never an orchestration worker's read-only
// row, and never a row from a previous machine.
function canRenameSession(session) {
  const id = String(session?.id || '');
  return Boolean(id) && !id.startsWith('pane:') && !id.startsWith('live:') && !session.isWindowsEra && !subSessionReadOnly(session);
}

const SessionRailRow = React.memo(function SessionRailRow({ session, clock, profiles, grouping, isOpen, isSelected, isArchived, attentionState, copied, onOpen, onContextMenu, archiveSession, unarchiveSession, isRenaming, onRenameStart, onRenameSave, onRenameEnd }) {
      const provider = providerIdentity(session.provider);
      const disabled = session.isWindowsEra;
      const isChild = subSessionReadOnly(session);
      const runState = runStateCue(session, undefined, undefined, clock);
      const displayTitle = isChild && session.childTitle ? session.childTitle : session.title;
      const status = railStatus({ runState, attention: attentionState, dormant: session.dormant });
      const renamable = canRenameSession(session);
      return (
        <div
          className={`sr-wrap${isArchived ? ' archived' : ''}${renamable ? ' can-rename' : ''}${isRenaming ? ' renaming' : ''}`}
          onContextMenu={(event) => onContextMenu(event, session)}
        >
          <button
            type="button"
            className={`sr${session.isLive ? ' live' : ''}${isOpen ? ' open' : ''}${isSelected ? ' sel' : ''}${disabled ? ' disabled' : ''}${isChild ? ' child' : ''}`}
            data-session-id={session.id}
            onClick={() => { if (!disabled) { onOpen(session); } }}
            title={disabled
              ? 'Session from a previous machine: its folder does not exist on this one'
              : isChild
                ? 'Orchestration worker. Click to open read-only. Right-click for options.'
                : `${displayTitle || 'Session'}\nClick to open. Right-click for options.`}
            disabled={disabled}
          >
            {/* The row's ONE status light (rail-status.cjs): run state, an
                answer owed, an unseen finish, asleep, or not running. */}
            <span className={`sr-d ${status.kind}`} data-status={status.kind} title={status.detail ? `${status.label}\n${status.detail}` : status.label} aria-label={status.label} />
            <img className="sr-provider" src={provider.logo} alt="" aria-hidden="true" />
            <span className="sr-copy">
              <span className="sr-t">
                {copied ? 'Resume command copied' : displayTitle}
              </span>
              {session.model && session.model !== 'default' ? <span className="sr-project">{session.model}</span> : null}
              {grouping === 'date' ? <span className="sr-project">{homeLabel(session.project)}</span> : null}
            </span>
            <span className="sr-tm">{formatRelative(session.lastActive, new Date(Math.floor(clock / 60000) * 60000))}</span>
            <AccountBadge home={session.home} profiles={profiles} />
            {/* The tag names the ERA the label carries ('win:' or 'linux:'),
                not a hardcoded 'win:': a linux-era row wearing a win: tag
                would misstate which machine it came from. */}
            {session.isWindowsEra ? (
              <span className="sidebar-win-tag">
                {String(session.project).trim().toLowerCase().startsWith('linux:') ? 'linux:' : 'win:'}
              </span>
            ) : null}
          </button>
          {/* Rename in place (RenameField): the editor covers the title while
              it is open, and the pencil sits beside the archive button. */}
          {isRenaming ? (
            <RenameField
              className="sr-rename"
              initial={displayTitle}
              onSave={(title) => onRenameSave(session.id, title)}
              onDone={() => onRenameEnd(session.id)}
            />
          ) : null}
          {renamable && !isRenaming ? (
            <button
              type="button"
              className="sr-rn"
              data-session-id={session.id}
              title="Rename"
              aria-label="Rename session"
              onClick={(event) => { event.stopPropagation(); onRenameStart(session.id); }}
            >
              <PencilIcon />
            </button>
          ) : null}
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
    });

function AccountBadge({ home, profiles }) {
  return <ProfileBadge profileId={normalizeHome(home, profiles)} profiles={profiles} className="sr-b" />;
}

// `short` marks the 5-hour group: it is the one that gives up its inline reset
// badge first when the rail is dragged narrow, because a 5-hour window resets
// again within the day while the weekly one is the planning number.
// `stale` (usage.js, 2026-11-23): the reading is old enough to be only a
// floor, so the number carries a "+" and the meter dims; the tooltip says how
// old and why. Before this, a two-day-old 20% drew exactly like a live one.
function MeterBar({ pct, reset, title, short = false, stale = false }) {
  const has = typeof pct === 'number' && Number.isFinite(pct);
  const fill = has ? Math.max(0, Math.min(100, pct)) : 0;
  const level = !has ? '' : pct >= 100 ? ' max' : pct >= 75 ? ' hi' : '';
  return (
    <span className={`rm-g${short ? ' rm-g-5h' : ''}${level}${has && stale ? ' stale' : ''}`} title={title}>
      <b>{usageText(pct, { stale })}</b>
      {reset ? <em>{reset}</em> : null}
      <i aria-hidden="true"><s style={{ width: `${fill}%` }} /></i>
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
// The machine's commit meter lives in the TITLE BAR (renderer/MemoryChip.jsx)
// since 2026-09-05; it sat here for one evening and Pat moved it up.
// Claude profiles only (2026-09-28): these donuts read the Claude statusline
// and OAuth usage, which a codex home does not have, so a codex profile's row
// could only ever read "--". Codex and cursor plans live in the title-bar menu.
// No heading (2026-11-09, Pat: "users know which is which and what they are
// for"): the "Plans" title and the "5 hours" / "This week" column labels are
// gone, so the first plan's row is the top of the pane. The left meter is the
// 5-hour window and the right one the week; each tooltip still says which.
// Every Claude plan's usage, read once for the rail: the meters below and the
// plan picker in the rail head show the same numbers from the same read.
function usePlanUsage() {
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
  return usage;
}

function RailMeters({ profiles: allProfiles, usage = {} }) {
  const profiles = allProfiles.filter((profile) => (profile.provider || 'claude') === 'claude');

  if (!profiles.length) return null;

  return (
    <div className="rail-meters" aria-label="Plan usage" data-profile-count={profiles.length}>
      {profiles.map((profile) => {
        const account = profile.id;
        const data = usage[account];
        const tooltip = [
          `${profile.label}${data?.email ? `: ${data.email}` : ''}`,
          typeof data?.cost === 'number' ? `last session $${data.cost.toFixed(2)}` : null,
          data?.updatedAt ? `${data?.stale ? 'last read' : 'updated'} ${formatRelative(data.updatedAt)}` : null,
          data?.stale ? (data?.staleReason || 'no newer reading yet') : null,
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
            <MeterBar
              pct={data?.fiveHourPct}
              title={resetTooltip({
                window: 'fiveHour',
                pct: data?.fiveHourPct,
                resetsAt: data?.fiveHourResetsAt,
                rolled: data?.fiveHourRolled,
                stale: data?.stale, updatedAt: data?.updatedAt, staleReason: data?.staleReason, nextReadAt: data?.nextReadAt,
              })}
              reset={fiveHourBadge ? `↻${fiveHourBadge}` : ''}
              short
              stale={data?.stale}
            />
            <MeterBar
              pct={data?.weeklyPct}
              title={resetTooltip({
                window: 'weekly',
                pct: data?.weeklyPct,
                resetsAt: data?.weeklyResetsAt,
                rolled: data?.weeklyRolled,
                stale: data?.stale, updatedAt: data?.updatedAt, staleReason: data?.staleReason, nextReadAt: data?.nextReadAt,
              })}
              reset={weeklyBadge ? `↻${weeklyBadge}` : ''}
              stale={data?.stale}
            />
          </div>
        );
      })}
    </div>
  );
}

// Stroked SVG rather than glyphs, for the reason the send button was redrawn
// on 2026-07-27: a bare unicode arrow inherits neither the weight nor the
// colour of the control it sits in, and reads as tacky next to real icons.
function RailGlyph({ paths, title, size = 12 }) {
  return (
    <svg
      className="rail-opt-glyph"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

const SORT_PATHS = ['M2.6 4h10.8', 'M2.6 8h7', 'M2.6 12h3.6'];
const FUNNEL_PATHS = ['M2.4 3.4h11.2L9.3 8.4v4.1l-2.6 1.3V8.4z'];
// A fold line with the chevrons moving TOWARD it (collapse) or AWAY from it
// (expand). The line is load-bearing, not decoration: drawn as two bare
// chevrons the pair merged into a diamond at 12px, which reads as neither
// action. Checked by eye at 4x against the real render, not assumed.
const FOLD_LINE = 'M2.5 8h11';
const COLLAPSE_PATHS = [FOLD_LINE, 'M5.4 3.1 8 5.7l2.6-2.6', 'M5.4 12.9 8 10.3l2.6 2.6'];
const EXPAND_PATHS = [FOLD_LINE, 'M5.4 5.7 8 3.1l2.6 2.6', 'M5.4 10.3 8 12.9l2.6-2.6'];
const CHEVRON_PATHS = ['M4.6 6.4 8 9.8l3.4-3.4'];

// Every rail popover portals to document.body. A `backdrop-filter` ancestor
// becomes the containing block for a fixed-position descendant, which has
// trapped three menus in this app already; the rail is one such surface.
// Placement is measured from the trigger at OPEN time and re-measured on
// resize, and the menu carries its own max-height so a 60-project list scrolls
// inside itself instead of running off the bottom of the screen.
// `align="end"` lines the menu's right edge up with the trigger's, for a
// trigger at the rail's right edge (the plan picker), so the menu opens over
// the rail instead of running out across the stage. `flip` lets a menu open
// UPWARD when it would not fit below its trigger and there is more room above
// (the plan picker from a project row low in the rail).
function RailMenu({
  anchorRef, open, onClose, className = '', label, width = 236, maxHeight = 460, align = 'start', flip = false, children,
}) {
  const [pos, setPos] = useState(null);
  const menuRef = useRef(null);
  // Layout, not effect: the menu must be placed before the browser paints, or
  // an autofocused field inside it would be focused while still parked
  // off-screen.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined; }
    const place = () => {
      const rect = anchorRef?.current?.getBoundingClientRect();
      if (!rect) return;
      const start = align === 'end' ? rect.right - width : rect.left;
      const left = Math.max(8, Math.min(start, window.innerWidth - width - 8));
      if (flip) {
        // The menu's full height: first placed off-screen with no cap, so its
        // own height; after that, its height plus what its list hides.
        const node = menuRef.current;
        const list = node?.querySelector('.rail-menu-list');
        const natural = node ? node.offsetHeight + (list ? list.scrollHeight - list.clientHeight : 0) : 0;
        const below = window.innerHeight - rect.bottom - 20;
        const above = rect.top - 20;
        const room = window.innerHeight - 24;
        const tall = Math.min(natural, maxHeight);
        if (tall > below) {
          if (above >= tall || (tall > room && above > below)) {
            // Fits above (or fits nowhere and above is the bigger side): open upward.
            setPos({ bottom: window.innerHeight - rect.top + 6, left, maxHeight: Math.min(maxHeight, Math.max(140, above)) });
            return;
          }
          if (tall <= room) {
            // Fits neither side but fits the window: slide up until all of it
            // is on screen, over its own trigger, as a native dropdown does.
            setPos({ top: Math.max(12, window.innerHeight - 12 - tall), left, maxHeight: Math.min(maxHeight, room) });
            return;
          }
        }
      }
      setPos({
        top: rect.bottom + 6,
        left,
        // Capped as well as fitted: on a 1600px screen the room below the
        // trigger is ~1300px, and a menu that tall is a wall, not a list.
        maxHeight: Math.min(maxHeight, Math.max(140, window.innerHeight - rect.bottom - 20)),
      });
    };
    place();
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchorRef, onClose, width, maxHeight, align, flip]);

  if (!open) return null;
  return createPortal(
    <>
      <button
        type="button"
        tabIndex={-1}
        className="menu-backdrop"
        aria-label={`Close ${label}`}
        onClick={onClose}
      />
      <div
        ref={menuRef}
        className={`rail-menu ${className}`.trim()}
        role="menu"
        aria-label={label}
        // Off-screen until measured, so the menu never flashes at 0,0.
        style={pos ? { ...pos, width } : { top: -9999, left: -9999, width }}
      >
        {children}
      </div>
    </>,
    document.body,
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
export function Sidebar({ onOpenSession, onCloseSession, onNewSession, openSessionIds, selectedSessionId, attention, searchRef, view, onViewChange, orchEnabled = true, taskAlert = 0 }) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const { profiles, loaded: profilesLoaded } = useProfiles();
  const [railState, setRailState] = useState(restoreRailState);
  const sharedState = useSidebarState();
  const [testModel, setTestModel] = useState(null);
  const model = testModel || sharedState.model;
  const indexerSessionCount = sharedState.indexerSessionCount || 0;
  const railSessionCount = sharedState.historyCount || 0;
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
  // The row whose name is being edited (RenameField). Ending an edit names
  // the row it was for, so a save that finishes late never closes the editor
  // a click on another row's pencil has just opened.
  const [renamingId, setRenamingId] = useState(null);
  const renameSession = useCallback((sessionId, title) => window.harbor.session.rename({ sessionId, title }), []);
  const endRename = useCallback((sessionId) => setRenamingId((current) => (current === sessionId ? null : current)), []);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectMenuQuery, setProjectMenuQuery] = useState('');
  // The selection AS THE MENU OPENED, so ticking a row cannot reorder the list
  // under the pointer. See orderProjectOptions.
  const [pinnedProjects, setPinnedProjects] = useState([]);
  const inputRef = useRef(null);
  const pendingFocusRef = useRef(false);
  const dragRef = useRef(null);
  const sortButtonRef = useRef(null);
  const projectButtonRef = useRef(null);
  // The plan picker (the launch button's chevron): which launch it is for, the
  // rail head's or a project row's, and the button it opened from.
  const [planPicker, setPlanPicker] = useState(null); // { where, folder, sessionId, immediate, title }
  const planPickerAnchorRef = useRef(null);
  const [lastPlanId, setLastPlanId] = useState(() => {
    try { return localStorage.getItem(LAUNCH_STORE_KEY) || null; } catch { return null; }
  });
  const usage = usePlanUsage();
  const {
    width, hidden, grouping, sort, projectFilter,
  } = railState;

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

  useEffect(() => {
    window.__harborSidebarStats = { indexerSessionCount };
  }, [indexerSessionCount]);
  useEffect(() => {
    if (window.harbor?.e2e) window.__setRailModelForTest = setTestModel;
    return () => { delete window.__setRailModelForTest; };
  }, []);

  const launchPlan = railLaunchPlan(profiles);
  const primaryPlan = railPrimaryPlan(launchPlan.direct, lastPlanId);

  useEffect(() => {
    window.harbor.accounts.readEmails().then(setAccountEmails).catch(() => {});
  }, []);

  useEffect(() => {
    if (initializedCollapse || !model.projects.length) return;
    const collapsed = new Set(
      model.projects
        .filter((project) => project.isOrchestration
          || (!project.hasLive && !model.liveProjects.includes(project.label)))
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
      grouping: null,
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

  // The rail narrows in three passes and then orders. They are separate on
  // purpose: the project menu's own options are read from the pass BEFORE the
  // project filter, so choosing one project never empties the menu you chose
  // it from.
  const timeFiltered = useMemo(
    () => filterProjects(groupedModel, {
      filter: filter.kind === 'since' && !customSince ? { kind: 'all' } : filter,
      query,
    }),
    [groupedModel, filter, query, customSince],
  );
  const projectOptions = useMemo(
    () => projectFilterOptions(timeFiltered, { selected: projectFilter }),
    [timeFiltered, projectFilter],
  );
  const filtered = useMemo(
    // homeLabel is what the row actually draws, so an A-Z sort is A-Z in the
    // column being read rather than in the raw label behind it.
    () => sortSidebarModel(applyProjectFilter(timeFiltered, projectFilter), { sort, displayName: homeLabel }),
    [timeFiltered, projectFilter, sort],
  );

  const searching = Boolean(query.trim());
  const timeFilterActive = filter.kind !== 'all' && !(filter.kind === 'since' && !customSince);
  const projectFilterActive = projectFilter.length > 0;
  // Drives the rail head's "shown / total" count, so a project filter reads as
  // a narrowing rather than as sessions having gone missing.
  const narrowing = searching || timeFilterActive || projectFilterActive;
  const filteredSessionIds = useMemo(() => filtered.projects
    .flatMap((project) => project.sessions || [])
    // Match the rail's orchestration-worker rule: workers only participate in
    // a bulk archive when search has explicitly surfaced them.
    .filter((session) => searching || (!session.isChildTask && (!session.delegatedBy || session.isLive)))
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
  const { rows } = useMemo(
    () => flattenSidebarRows(filtered, {
      // A collapsed project stays collapsed. Only an active SEARCH flattens it,
      // because a hit inside a collapsed project reads as no hit at all; the
      // time chips do NOT, which is what made the caret dead in the default
      // 48h view. The whole rule, and why, is in collapse-policy.cjs.
      collapsedProjects: collapseForView({ collapsedProjects, searching }),
      expandedOlder,
      // Orchestration workers are excluded from the browser by default; an active
      // search re-includes matching ones so a specific worker can still be found.
      includeChildren: searching,
    }),
    [filtered, collapsedProjects, expandedOlder, searching],
  );

  const toggleProject = (label) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  // One button, offering whichever of the two the tree is not already in.
  // The whole rule (including why it goes dead during a search rather than
  // pretending) is in collapse-policy.cjs.
  const collapseAll = useMemo(
    () => planCollapseAll({ projects: filtered.projects, collapsedProjects, searching }),
    [filtered, collapsedProjects, searching],
  );

  const visibleProjectOptions = useMemo(
    () => matchProjectOptions(orderProjectOptions(projectOptions, pinnedProjects), projectMenuQuery),
    [projectOptions, pinnedProjects, projectMenuQuery],
  );
  const closeProjectMenu = useCallback(() => {
    setProjectMenuOpen(false);
    setProjectMenuQuery('');
  }, []);
  // Toggling deliberately leaves the menu OPEN: picking several projects is the
  // whole point, and a menu that closed on every tick would cost a reopen per
  // choice.
  const toggleProjectChoice = useCallback((label) => {
    updateRailState((previous) => ({
      ...previous,
      projectFilter: toggleProjectFilter(previous.projectFilter, label),
    }));
  }, [updateRailState]);
  const clearProjectFilter = useCallback(() => {
    updateRailState((previous) => ({ ...previous, projectFilter: [] }));
  }, [updateRailState]);

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

  // One launch for every entry point: a project row passes its folder; the rail
  // head asks for one first.
  const startLaunch = useCallback(async (request, { folder, sessionId } = {}) => {
    let resolvedFolder = folder;
    if (!resolvedFolder) {
      resolvedFolder = await window.harbor.session.pickFolder();
      if (!resolvedFolder) return;
    }
    onNewSession({ ...request, folder: resolvedFolder, sessionId: sessionId || undefined });
  }, [onNewSession]);
  // Never immediate: the point of Other is choosing the provider and plan in
  // the Session configuration window.
  const otherRequest = launchPlan.otherProvider ? { provider: launchPlan.otherProvider } : {};

  // The rail head and a hovered project row carry ONE launch control since
  // 2026-11-19 (railLaunchPlan in profiles.cjs): "+<letter>" starts the plan
  // picked last, and the chevron opens the plan picker below. Until then they
  // drew one button per Claude plan plus "+O", squeezed in five CSS tiers until
  // eleven buttons left no room on the line the "Sessions" label shares.
  const renderLaunchSplit = (where, { folder = null, sessionId = null, immediate = false, title = 'New session' } = {}) => {
    const mainClass = where === 'head' ? 'sidebar-global-new' : 'sidebar-proj-new';
    const inFolder = folder ? ` in ${folder}` : '';
    if (!primaryPlan) {
      // No Claude plan configured: the one button opens the Session configuration window.
      return (
        <button type="button" className={`${mainClass} launch-other`} title={`New session${inFolder}`} onClick={() => startLaunch(otherRequest, { folder, sessionId })}>
          + New
        </button>
      );
    }
    const open = Boolean(planPicker && planPicker.where === where && planPicker.folder === folder);
    const email = accountEmails[primaryPlan.id] || usage[primaryPlan.id]?.email;
    return (
      <div className={`launch-split ${where}`} style={profileStyle(primaryPlan)} data-plan={primaryPlan.id}>
        <button
          type="button"
          className={`${mainClass} launch-main ${primaryPlan.id}`}
          title={`New ${primaryPlan.label} session${inFolder}${email ? `: ${email}` : ''}`}
          onClick={() => startLaunch({ account: primaryPlan.id, provider: primaryPlan.provider || 'claude', immediate }, { folder, sessionId })}
        >
          {`+${primaryPlan.letter}`}
        </button>
        <button
          type="button"
          className="launch-more"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Choose a plan"
          title={`Choose a plan for a new session${inFolder}`}
          onClick={(event) => {
            planPickerAnchorRef.current = event.currentTarget.closest('.launch-split');
            setPlanPicker(open ? null : { where, folder, sessionId, immediate, title });
          }}
        >
          <RailGlyph paths={CHEVRON_PATHS} size={11} />
        </button>
      </div>
    );
  };

  const closePlanPicker = useCallback(() => setPlanPicker(null), []);
  const pickPlan = useCallback((profile) => {
    const request = planPicker;
    setPlanPicker(null);
    if (!request) return;
    setLastPlanId(profile.id);
    try { localStorage.setItem(LAUNCH_STORE_KEY, profile.id); } catch { /* remembered for this run only */ }
    startLaunch({ account: profile.id, provider: profile.provider || 'claude', immediate: request.immediate }, request);
  }, [planPicker, startLaunch]);
  const pickOther = useCallback(() => {
    const request = planPicker;
    setPlanPicker(null);
    if (request) startLaunch(otherRequest, request);
  }, [planPicker, startLaunch, otherRequest]);
  // Keys in the open picker: a plan's letter starts it, arrows move between
  // rows, Enter starts the focused row (a native button click), Escape closes
  // (RailMenu).
  const onPlanPickerKey = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const rows = [...event.currentTarget.querySelectorAll('.plan-pick')];
    const at = rows.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) {
      event.preventDefault();
      const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length;
      rows[next]?.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      rows[event.key === 'Home' ? 0 : rows.length - 1]?.focus();
      return;
    }
    const hit = planForKey(launchPlan.direct, event.key, Boolean(launchPlan.otherProvider));
    if (!hit) return;
    event.preventDefault();
    if (hit.other) pickOther(); else pickPlan(hit.profile);
  };
  // Opening the picker puts the keyboard on the plan "+" would start, so Enter
  // alone repeats the last choice and the arrows go from there.
  useEffect(() => {
    if (!planPicker) return undefined;
    const frame = requestAnimationFrame(() => {
      const menu = document.querySelector('.plan-picker');
      (menu?.querySelector('.plan-pick.current') || menu?.querySelector('.plan-pick'))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [planPicker]);

  const handleSessionContextMenu = useCallback((event, session) => {
    // Right-click opens a small options menu (copy resume command, archive,
    // delete). Rendered through a portal to document.body because a
    // backdrop-filter ancestor traps fixed-position descendants.
    event.preventDefault();
    setMenu({ session, x: event.clientX, y: event.clientY });
  }, []);
  const openRailSession = useCallback((session) => { setQuery(''); onOpenSession(session); }, [onOpenSession]);

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
      //
      // Picked by the MOST RECENT qualifying session rather than by array
      // position: since 2026-08-25 the rail can be sorted A-Z or by size, and a
      // positional `find` would silently hand the launcher a different anchor
      // in each of those views. This reads identically under the default sort.
      const newSessionId = (project.sessions || []).reduce((best, s) => {
        if (s.isWindowsEra || s.isLive || String(s.id).startsWith('live:')) return best;
        return !best || (s.lastActiveMs || 0) > (best.lastActiveMs || 0) ? s : best;
      }, null)?.id || null;
      const newSessionFolder = project.newSessionCwd || null;
      // No per-project Orch chip since 2026-10-29 (Pat trimmed the row to the
      // Claude plans and "+O"); the Orch view's own project picker opens it.
      const liveCount = project.sessions.filter((s) => s.isLive && !subSessionReadOnly(s)).length;
      const projectAttention = project.sessions.reduce((totals, s) => {
        const state = attention?.get?.(s.id);
        if (state === 'blocked') return { ...totals, blocked: totals.blocked + 1, total: totals.total + 1 };
        if (state === 'finished') return { ...totals, total: totals.total + 1 };
        return totals;
      }, { blocked: 0, total: 0 });
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
            {/* A COLLAPSED project renders none of its session rows, so without
                this the marker on a row inside it does not exist in the DOM at
                all and the project reads as quiet. Found by driving it: the
                attention map was correct and the rail still showed nothing,
                because every group was collapsed. */}
            {projectAttention.total > 0 ? (
              <span
                className={`pg-attn${projectAttention.blocked > 0 ? ' blocked' : ''}`}
                title={projectAttention.blocked > 0
                  ? `${projectAttention.total} waiting for you, ${projectAttention.blocked} needing an answer`
                  : `${projectAttention.total} finished since you last looked`}
              >
                {projectAttention.total}
              </span>
            ) : null}
            {/* The group's own clock, not `sessions[0]`'s: the two agree only
                while the rail is sorted by recency, and since 2026-08-25 it
                need not be. `lastActiveMs` is a fact about the SET, carried
                through the sort untouched. */}
            <span className="pg-meta">
              {project.isDateGroup
                ? `${project.sessionCount}`
                : liveCount > 0 ? `${liveCount} live`
                  : project.lastActiveMs ? formatRelative(new Date(project.lastActiveMs)) : ''}
            </span>
          </button>
          {!project.isDateGroup && !project.isWindowsEra && newSessionFolder && profiles.length > 0 ? (
            <div className="sidebar-project-actions" data-picker-open={planPicker?.where === 'project' && planPicker.folder === newSessionFolder ? 'true' : undefined}>
              {renderLaunchSplit('project', {
                folder: newSessionFolder,
                sessionId: newSessionId,
                immediate: true,
                title: `New in ${homeLabel(project.label)}`,
              })}
            </div>
          ) : null}
        </div>
      );
    }

    if (row.kind === 'session') return <SessionRailRow session={row.session} clock={clock} profiles={profiles} grouping={grouping}
      isOpen={openSessionIds?.has(row.session.id)} isSelected={selectedSessionId === row.session.id}
      isArchived={archived.has(row.session.id)} attentionState={attention?.get?.(row.session.id) || null}
      copied={copiedSessionId === row.session.id} onOpen={openRailSession} onContextMenu={handleSessionContextMenu}
      archiveSession={archiveSession} unarchiveSession={unarchiveSession}
      isRenaming={renamingId === row.session.id} onRenameStart={setRenamingId} onRenameSave={renameSession} onRenameEnd={endRename} />;

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
      <div className="rail-main">
      {onViewChange ? (
        <div className="rail-view-switch">
          <ViewSwitch view={view} onViewChange={onViewChange} orchEnabled={orchEnabled} taskAlert={taskAlert} />
        </div>
      ) : null}
      <div className="rail-head">
        <span className="rail-eyebrow">Sessions</span>
        {/* Sessions MATCHING the filters, not rows currently rendered. The
            two agreed until collapse-all shipped (2026-08-25) and folding the
            whole rail in one click made the head read "0 / 1105", which says
            nothing matched when in fact everything did. filteredSessionIds is
            the same set the Archive pill counts, so the two cannot disagree. */}
        <span className="rail-count">
          {narrowing || filteredSessionIds.length > 0
            ? `${filteredSessionIds.length}/${railSessionCount}`
            : railSessionCount}
        </span>
        <div className="rail-head-actions">
          {profiles.length > 0 ? (
            renderLaunchSplit('head')
          ) : profilesLoaded ? (
            <span className="rail-setup-hint" title="Add a Claude profile in Harbor settings">Set up a profile</span>
          ) : null}
        </div>
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
        {/* Sort, project filter, collapse-all. Three asks from Pat on
            2026-08-25, kept on one row of their own: the grouping row below has
            already been overflowed onto a wasted line once (2026-07-27), and
            these three are the "what shape is this list" controls while that
            row's Archive pills are actions. */}
        <div className="rail-list-controls">
          <button
            ref={sortButtonRef}
            type="button"
            className={`rail-opt-chip${sort !== 'newest' ? ' active' : ''}${sortMenuOpen ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
            title={`Sort: ${sortHint(sort)}`}
            onClick={() => { setProjectMenuOpen(false); setSortMenuOpen((open) => !open); }}
          >
            <RailGlyph paths={SORT_PATHS} />
            <span className="rail-opt-value">{sortLabel(sort)}</span>
            <span className="rail-opt-caret" aria-hidden="true">▾</span>
          </button>
          <button
            ref={projectButtonRef}
            type="button"
            className={`rail-opt-chip${projectFilterActive ? ' active' : ''}${projectMenuOpen ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={projectMenuOpen}
            disabled={projectOptions.length === 0}
            title={projectFilterActive
              ? `Showing only: ${projectFilter.join(', ')}`
              : 'Show only chosen projects'}
            onClick={() => {
              setSortMenuOpen(false);
              setProjectMenuQuery('');
              setPinnedProjects(projectFilter);
              setProjectMenuOpen((open) => !open);
            }}
          >
            <RailGlyph paths={FUNNEL_PATHS} />
            <span className="rail-opt-value">{projectFilterLabel(projectFilter)}</span>
            <span className="rail-opt-caret" aria-hidden="true">▾</span>
          </button>
          <button
            type="button"
            className="rail-collapse-all"
            disabled={collapseAll.disabled}
            aria-label={collapseAll.action === 'collapse' ? 'Collapse all projects' : 'Expand all projects'}
            title={collapseAll.reason
              || (collapseAll.action === 'collapse'
                ? `Collapse all ${collapseAll.projectCount} projects`
                : `Expand all ${collapseAll.projectCount} projects`)}
            onClick={() => setCollapsedProjects(collapseAll.next)}
          >
            {/* Larger than the chips' glyphs: this button has no label to
                share the weight with. */}
            <RailGlyph paths={collapseAll.action === 'collapse' ? COLLAPSE_PATHS : EXPAND_PATHS} size={14} />
          </button>
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

      <RailMenu
        anchorRef={sortButtonRef}
        open={sortMenuOpen}
        onClose={() => setSortMenuOpen(false)}
        className="rail-sort-menu"
        label="Sort sessions"
        width={214}
      >
        <div className="rail-menu-title">Sort by</div>
        {SORT_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="menuitemradio"
            aria-checked={sort === mode}
            className={`rail-menu-item${sort === mode ? ' checked' : ''}`}
            title={sortHint(mode)}
            onClick={() => {
              updateRailState((previous) => ({ ...previous, sort: mode }));
              setSortMenuOpen(false);
            }}
          >
            <span className="rail-menu-mark" aria-hidden="true">{sort === mode ? '✓' : ''}</span>
            <span className="rail-menu-label">{SORT_LABELS[mode]}</span>
          </button>
        ))}
        <p className="rail-menu-foot">{sortHint(sort)}</p>
      </RailMenu>

      <RailMenu
        anchorRef={projectButtonRef}
        open={projectMenuOpen}
        onClose={closeProjectMenu}
        className="rail-project-menu"
        label="Filter by project"
        width={264}
      >
        <div className="rail-menu-head">
          <span className="rail-menu-title">Show projects</span>
          {projectFilterActive ? (
            <button type="button" className="rail-menu-clear" onClick={clearProjectFilter}>
              {`Clear ${projectFilter.length}`}
            </button>
          ) : null}
        </div>
        {projectOptions.length > 8 ? (
          <input
            className="rail-menu-search"
            type="search"
            placeholder="Find a project…"
            aria-label="Find a project"
            value={projectMenuQuery}
            /* eslint-disable-next-line jsx-a11y/no-autofocus */
            autoFocus
            onChange={(event) => setProjectMenuQuery(event.target.value)}
          />
        ) : null}
        <div className="rail-menu-list">
          {visibleProjectOptions.length === 0 ? (
            <p className="rail-menu-empty">No project matches that.</p>
          ) : visibleProjectOptions.map((option) => {
            const checked = projectFilter.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className={`rail-menu-item${checked ? ' checked' : ''}`}
                title={`${option.label} · ${option.count} in view`}
                onClick={() => toggleProjectChoice(option.label)}
              >
                <span className="rail-menu-mark" aria-hidden="true">{checked ? '✓' : ''}</span>
                <ProjectIcon label={option.label} iconClass="rail-menu-icon" dotClass="rail-menu-dot" />
                <span className="rail-menu-label">{homeLabel(option.label)}</span>
                <span className="rail-menu-count">{option.count}</span>
              </button>
            );
          })}
        </div>
        <p className="rail-menu-foot">
          {projectFilterActive
            ? `Showing ${projectFilter.length} of ${projectOptions.length} projects`
            : 'Every project is shown. Pick one or more to narrow the rail.'}
        </p>
      </RailMenu>

      {/* The plan picker: one row per Claude plan (its letter, name, then the
          5-hour and weekly usage the meters below show), then Other. The row
          "+" would start is checked; a plan's letter starts it. */}
      <RailMenu
        anchorRef={planPickerAnchorRef}
        open={Boolean(planPicker)}
        onClose={closePlanPicker}
        className="plan-picker"
        label="Choose a plan for the new session"
        width={256}
        maxHeight={560}
        align="end"
        flip
      >
        <div className="rail-menu-head plan-pick-head">
          <span className="rail-menu-title plan-pick-title" title={planPicker?.folder || undefined}>{planPicker?.title || 'New session'}</span>
          <span className="plan-pick-cols" aria-hidden="true"><span>5h</span><span>week</span></span>
        </div>
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div className="rail-menu-list" onKeyDown={onPlanPickerKey}>
          {launchPlan.direct.map((profile) => {
            const data = usage[profile.id];
            const current = profile.id === primaryPlan?.id;
            const email = accountEmails[profile.id] || data?.email;
            const level = (pct) => (typeof pct !== 'number' ? '' : pct >= 100 ? ' max' : pct >= 75 ? ' hi' : '');
            const shown = (pct) => usageText(pct, { stale: data?.stale });
            const dim = (pct) => (data?.stale && typeof pct === 'number' && Number.isFinite(pct) ? ' stale' : '');
            return (
              <button
                key={profile.id}
                type="button"
                role="menuitem"
                data-plan={profile.id}
                className={`rail-menu-item plan-pick${current ? ' current' : ''}`}
                style={profileStyle(profile)}
                title={[
                  `New ${profile.label} session${planPicker?.folder ? ` in ${planPicker.folder}` : ''} (${profile.letter})`,
                  email || null,
                  resetTooltip({ window: 'fiveHour', pct: data?.fiveHourPct, resetsAt: data?.fiveHourResetsAt, rolled: data?.fiveHourRolled, stale: data?.stale, updatedAt: data?.updatedAt, staleReason: data?.staleReason, nextReadAt: data?.nextReadAt, }),
                  resetTooltip({ window: 'weekly', pct: data?.weeklyPct, resetsAt: data?.weeklyResetsAt, rolled: data?.weeklyRolled, stale: data?.stale, updatedAt: data?.updatedAt, staleReason: data?.staleReason, nextReadAt: data?.nextReadAt, }),
                ].filter(Boolean).join('\n')}
                onClick={() => pickPlan(profile)}
              >
                <span className="rail-menu-mark" aria-hidden="true">{current ? '✓' : ''}</span>
                <span className="profile-badge plan-pick-badge" aria-hidden="true">{profile.letter}</span>
                <span className="rail-menu-label">{profile.label}</span>
                <span className={`plan-pick-use${level(data?.fiveHourPct)}${dim(data?.fiveHourPct)}`}>{shown(data?.fiveHourPct)}</span>
                <span className={`plan-pick-use${level(data?.weeklyPct)}${dim(data?.weeklyPct)}`}>{shown(data?.weeklyPct)}</span>
              </button>
            );
          })}
          {launchPlan.otherProvider ? (
            <>
              <div className="plan-pick-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                data-plan="other"
                className="rail-menu-item plan-pick plan-pick-other"
                title={`New session on another plan${planPicker?.folder ? ` in ${planPicker.folder}` : ''}: choose Codex, Cursor or any plan`}
                onClick={pickOther}
              >
                <span className="rail-menu-mark" aria-hidden="true" />
                {/* A drawn "more" mark, not a letter: a Claude plan can own O
                    (Ocean does since 2026-11-19), and two O badges read as one plan. */}
                <span className="plan-pick-badge" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
                    <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.4" fill="currentColor" />
                    <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
                  </svg>
                </span>
                <span className="rail-menu-label">Other: Codex, Cursor…</span>
              </button>
            </>
          ) : null}
        </div>
        <p className="rail-menu-foot plan-pick-foot">Press a letter to start that plan. ✓ is the + plan.</p>
      </RailMenu>

      <VirtualList rows={rows} renderRow={renderRow} />
      </div>

      <RailMeters profiles={profiles} usage={usage} />
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
          // Kept inside the window: opened near the bottom or right edge, the menu
          // used to run off-screen and hide its lower items (Rename among them).
          ref={(node) => {
            if (!node) return;
            const box = node.getBoundingClientRect();
            const left = Math.max(8, Math.min(menu.x, window.innerWidth - box.width - 8));
            const top = Math.max(8, Math.min(menu.y, window.innerHeight - box.height - 8));
            if (left !== menu.x) node.style.left = `${left}px`;
            if (top !== menu.y) node.style.top = `${top}px`;
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <span className="sr-menu-title">{menu.session.childTitle || menu.session.title || 'Session'}</span>
          {!menu.session.isWindowsEra ? (
            <button type="button" role="menuitem" className="sr-menu-item" onClick={() => copyResumeCommand(menu.session)}>
              Copy resume command
            </button>
          ) : null}
          {canRenameSession(menu.session) ? (
            <button type="button" role="menuitem" className="sr-menu-item" onClick={() => { setMenu(null); setRenamingId(menu.session.id); }}>
              Rename
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
