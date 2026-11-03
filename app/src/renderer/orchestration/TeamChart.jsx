import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useProfiles, providerIdentity } from '../providers.js';
import { CopySessionId } from '../stage/CopySessionId.jsx';
import { AgentCard, AgentChip } from './AgentCard.jsx';
import { AgentDrawer } from './AgentDrawer.jsx';
import { SubTray, SUB_TRAY_CAP } from './SubWorkers.jsx';
import { WarnIcon, PinIcon, StatusIcon, CloseIcon, MinusIcon, PlusIcon, FitIcon } from './TeamIcons.jsx';
import { STATE_FILTERS, filterTeam, countsText, warningText, edgeTitle, clockText, ago, homeLabel, expireSubWorkers } from './team-text.cjs';
import { connectorPaths } from './team-layout.cjs';
import { etaText, groupBatches, runCounts, waitingText } from './orch-text.cjs';

// THE ORCH VIEW'S TEAM CHART (2026-11-02, Pat; SCOPE.md in
// docs/orchestration/2026-11-02-org-chart-panel-scope). Who launched or
// directs whom, as connected cards, from the launches themselves. Read-only:
// the only controls are the drawer, the filters, Copy session id, pins, and
// the run links into the existing Research / Execute panel.
//
// Data arrives by push (orchestration:team-update) whenever something changed
// in main; the ONE timer here redraws the "3m ago" text.

const FILTER_KEY = 'harbor-team-filters';
const CLOCK_MS = 30_000;
const PROJECT_WARNINGS = new Set(['plan-near-limit', 'many-test-runs', 'duplicate-name', 'declared-absent']);

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function readFilters() {
  try { return { project: 'all', home: 'all', provider: 'all', state: 'all', warningsOnly: false, ...JSON.parse(localStorage.getItem(FILTER_KEY) || '{}') }; } catch { return { project: 'all', home: 'all', provider: 'all', state: 'all', warningsOnly: false }; }
}

function countMatched(section, matched, members) {
  const counts = { working: 0, tool: 0, idle: 0, quiet: 0, starting: 0, total: 0 };
  for (const id of section.memberIds) {
    if (!matched.has(id)) continue;
    counts.total += 1;
    const kind = members[id]?.status?.kind;
    if (Object.hasOwn(counts, kind)) counts[kind] += 1;
  }
  return counts;
}

function Lines({ paths, team, uid }) {
  return (
    <svg className="tc-lines" aria-hidden="true">
      <defs>
        <marker id={`tc-arrow-${uid}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 1 9 5 0 9z" className="tc-arrowhead" />
        </marker>
      </defs>
      {paths.map((p) => {
        const title = p.kind === 'bus' ? null : edgeTitle({ from: p.from, to: p.to, kind: p.kind === 'directs' ? 'directs' : p.kind, source: team.members[p.to]?.parentSource }, team.members);
        return (
          <g key={p.key} className={`tc-edge ${p.kind}`}>
            <path className="tc-line" d={p.d} markerEnd={p.arrow ? `url(#tc-arrow-${uid})` : undefined} />
            {title ? <path className="tc-hit" d={p.d}><title>{title}</title></path> : null}
          </g>
        );
      })}
    </svg>
  );
}

function TreeNode({ id, ctx }) {
  const member = ctx.team.members[id];
  if (!member || !ctx.visible.has(id)) return null;
  const kids = (member.children || []).filter((kid) => ctx.visible.has(kid) && ctx.team.members[kid]);
  const dim = ctx.filtering && !ctx.matched.has(id);
  // The card and its sub-worker tray are one unit on the board: lines arrive
  // at the card's top and leave from under the tray.
  return (
    <div className="tc-node">
      <div className="tc-unit" data-unit-id={id}>
        <AgentCard member={member} now={ctx.now} profiles={ctx.profiles} selected={ctx.selected === id} dim={dim} onSelect={ctx.onSelect} />
        <SubTray entries={member.subWorkers} now={ctx.now} dim={dim} expanded={ctx.openTrays.has(id)} onToggle={() => ctx.toggleTray(id)} onOpen={(entry) => ctx.openSub(entry, id)} />
      </div>
      {kids.length ? <div className={`tc-kids${kids.length > 1 ? ' many' : ''}`}>{kids.map((kid) => <TreeNode key={kid} id={kid} ctx={ctx} />)}</div> : null}
    </div>
  );
}

// THE BOARD (Pat, 2026-11-02: "that view looks a bit too zoomed in? i was
// picturing the cards looking more like whats in miro"). A canvas with each
// project as a frame, zoomed with CSS zoom, which REFLOWS: zooming out fits
// more cards per row, so the whole team can be on screen at once. Fit (the
// default) picks the largest zoom at which everything fits the board's
// height, and re-fits only when the set of cards changes or the window
// resizes, never on a status tick, so cards do not jump while Pat reads.
//
// The lines are ONE svg over the whole board, outside the zoomed world, so
// the measured card boxes (getBoundingClientRect, visual px) and the path
// coordinates are in the same space at every zoom.
const ZOOM_KEY = 'harbor-team-zoom';
const ZOOM_STEPS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5];
const FIT_STEPS = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65];
const KIDS_GAP = 44;

function readZoom() {
  try {
    const saved = JSON.parse(localStorage.getItem(ZOOM_KEY) || '{}');
    if (saved.mode === 'manual' && Number.isFinite(saved.zoom)) return { mode: 'manual', zoom: Math.min(1.5, Math.max(0.4, saved.zoom)) };
  } catch { /* private storage */ }
  return { mode: 'fit', zoom: FIT_STEPS[0] };
}

function Board({ ctx, layoutKey, children }) {
  const board = useRef(null);
  const inner = useRef(null);
  const world = useRef(null);
  const [zoomState, setZoomState] = useState(readZoom);
  const [paths, setPaths] = useState([]);
  const [panning, setPanning] = useState(false);
  const lastMeasure = useRef('');
  const [size, setSize] = useState(0);
  const { zoom, mode } = zoomState;
  const setZoom = (next) => {
    setZoomState(next);
    try { localStorage.setItem(ZOOM_KEY, JSON.stringify(next)); } catch { /* private storage */ }
  };
  const stepZoom = (direction) => {
    const target = direction > 0
      ? ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? ZOOM_STEPS.at(-1)
      : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? ZOOM_STEPS[0];
    setZoom({ mode: 'manual', zoom: target });
  };

  // Fit: try zooms from largest to smallest until the world fits the board's
  // height. Each try is one synchronous layout; the last value is written
  // back so the DOM and React agree even when the pick equals the old zoom.
  useLayoutEffect(() => {
    if (mode !== 'fit') return;
    const el = board.current;
    const w = world.current;
    if (!el || !w) return;
    let pick = FIT_STEPS.at(-1);
    for (const z of FIT_STEPS) {
      w.style.zoom = String(z);
      if (el.scrollHeight <= el.clientHeight + 1) { pick = z; break; }
    }
    w.style.zoom = String(pick);
    if (Math.abs(pick - zoom) > 0.001) setZoomState({ mode: 'fit', zoom: pick });
  }, [mode, layoutKey, size]);

  useEffect(() => {
    const el = board.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let last = '';
    const observer = new ResizeObserver(() => {
      const next = `${el.clientWidth}x${el.clientHeight}`;
      if (next !== last) { last = next; setSize((n) => n + 1); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Ctrl+wheel (and a trackpad pinch, which arrives as one) zooms; a plain
  // wheel scrolls the board. Non-passive so the page does not zoom instead.
  useEffect(() => {
    const el = board.current;
    if (!el) return undefined;
    const onWheel = (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoomState((current) => {
        const next = { mode: 'manual', zoom: Math.min(1.5, Math.max(0.4, Math.round(current.zoom * Math.exp(-event.deltaY * 0.0015) * 100) / 100)) };
        try { localStorage.setItem(ZOOM_KEY, JSON.stringify(next)); } catch { /* private storage */ }
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const measure = useCallback(() => {
    const el = inner.current;
    if (!el) return;
    const base = el.getBoundingClientRect();
    const rects = {};
    for (const card of el.querySelectorAll('.tc-card[data-member-id]')) {
      // A card's unit includes its sub-worker tray; cross lines still meet
      // the card itself, at its middle (portY).
      const r = (card.closest('.tc-unit') || card).getBoundingClientRect();
      const own = card.getBoundingClientRect();
      const n = card.closest('.tc-node')?.getBoundingClientRect() || r;
      rects[card.dataset.memberId] = {
        left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top,
        portY: (own.top + own.bottom) / 2 - base.top,
        node: { left: n.left - base.left, top: n.top - base.top, right: n.right - base.left, bottom: n.bottom - base.top },
      };
    }
    const tree = [];
    for (const id of Object.keys(rects)) {
      const member = ctx.team.members[id];
      const kids = (member?.children || []).filter((kid) => rects[kid]);
      if (kids.length) tree.push({ parent: id, children: kids.map((kid) => ({ id: kid, kind: 'directs' })) });
    }
    const cross = (ctx.team.edges || []).filter((edge) => edge.kind !== 'directs' && rects[edge.from] && rects[edge.to]);
    const z = Number(world.current?.style.zoom) || zoom;
    // Routing the cross lines is a small search; skip it when nothing moved.
    const key = JSON.stringify([rects, tree, cross, z]);
    if (key === lastMeasure.current) return;
    lastMeasure.current = key;
    const next = connectorPaths(rects, tree, cross, { gap: KIDS_GAP * z, trunkInset: 13 * z, crossMargin: 8 * z, crossBend: 30 * z });
    setPaths((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
  }, [ctx.team, ctx.visible, zoom]);
  useLayoutEffect(() => { measure(); });
  useEffect(() => {
    const el = inner.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // Drag the empty canvas to pan, as on a Miro board. Cards, chips and every
  // control keep their own clicks.
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('.tc-card, .tc-chip, button, a, summary, select, input, label, li, .tc-run')) return;
    const el = board.current;
    const start = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture?.(event.pointerId);
    setPanning(true);
    const move = (e) => { el.scrollLeft = start.left - (e.clientX - start.x); el.scrollTop = start.top - (e.clientY - start.y); };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setPanning(false);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div className="tc-board-wrap">
      <div className={`tc-board${panning ? ' panning' : ''}`} ref={board} onPointerDown={onPointerDown}>
        <div className="tc-board-inner" ref={inner} style={{ '--z': zoom }}>
          <Lines paths={paths} team={ctx.team} uid="board" />
          <div className="tc-world" ref={world} style={{ zoom }}>{children}</div>
        </div>
      </div>
      <div className="tc-zoom" role="group" aria-label="Zoom">
        <button type="button" className="tc-zoom-btn" onClick={() => stepZoom(-1)} disabled={zoom <= ZOOM_STEPS[0] + 0.001} aria-label="Zoom out" title="Zoom out (Ctrl+wheel)"><MinusIcon /></button>
        <button type="button" className="tc-zoom-pct" onClick={() => setZoom({ mode: 'manual', zoom: 1 })} title="Actual size">{Math.round(zoom * 100)}%</button>
        <button type="button" className="tc-zoom-btn" onClick={() => stepZoom(1)} disabled={zoom >= ZOOM_STEPS.at(-1) - 0.001} aria-label="Zoom in" title="Zoom in (Ctrl+wheel)"><PlusIcon /></button>
        <button type="button" className={`tc-zoom-fit${mode === 'fit' ? ' on' : ''}`} onClick={() => setZoom({ mode: 'fit', zoom })} aria-pressed={mode === 'fit'} title="Fit the whole team on screen"><FitIcon />Fit</button>
      </div>
    </div>
  );
}

function RunSummary({ run, onPick }) {
  const groups = groupBatches(run.batches.map((b) => ({ ...b, status: b.status })));
  const counts = run.summary ? runCounts(run.summary) : '';
  const eta = run.summary ? etaText(run.summary) : '';
  return (
    <div className="tc-run">
      <div className="tc-run-line">
        <span className="tc-run-goal">{run.goal || 'Orchestration run'}</span>
        <span className="tc-run-meta">{[run.total != null ? `${run.done} of ${run.total} batches done` : null, counts, eta].filter(Boolean).join(' · ')}</span>
        {onPick ? <button type="button" className="tc-run-open" onClick={() => onPick({ label: run.workspace.split(/[\\/]/).filter(Boolean).at(-1) || run.workspace, workspace: run.workspace, queueId: run.queueId, sessions: [] })}>Open run</button> : null}
      </div>
      {run.batches.length ? (
        <details className="tc-run-batches">
          <summary>{run.batches.length} batch{run.batches.length === 1 ? '' : 'es'}</summary>
          <ul>
            {groups.flatMap((group) => group.batches.map((batch) => (
              <li key={batch.id}>
                <span className="tc-batch-state">{group.label}</span>
                <span className="tc-batch-title">{batch.title}</span>
                <span className="tc-batch-note">{batch.workerState === 'waiting' ? waitingText(batch.waitingOn) : batch.workerState === 'ready' ? 'ready, not started' : batch.workerState || ''}</span>
              </li>
            )))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Legend() {
  return (
    <div className="tc-legend" aria-label="Line styles">
      <span><svg width="28" height="8" aria-hidden="true"><path d="M1 4H27" className="tc-legend-line directs" /></svg>launched or directs</span>
      <span><svg width="28" height="8" aria-hidden="true"><path d="M1 4H27" className="tc-legend-line keeps-alive" /></svg>runs inside its pane</span>
      <span><svg width="28" height="8" aria-hidden="true"><path d="M1 4H27" className="tc-legend-line reviews" /></svg>reviews (TEAM.json)</span>
    </div>
  );
}

function Pins({ pinView, setPinView, onError }) {
  const [pins, setPins] = useState(null);
  const [note, setNote] = useState(null);
  const load = () => window.harbor.orchestration.teamPins?.().then(setPins).catch(() => setPins([]));
  useEffect(() => { load(); }, []);
  const pin = async () => {
    const result = await window.harbor.orchestration.pinTeam?.();
    if (!result?.ok) { onError(result?.reason || 'Could not pin this moment.'); return; }
    setNote(`Pinned until ${new Date(result.expiresMs).toLocaleDateString([], { month: 'short', day: 'numeric' })}${result.removed ? '; the oldest pin was removed to keep five' : ''}.`);
    load();
  };
  const open = async (id) => {
    const found = await window.harbor.orchestration.teamPin?.(id);
    if (found?.team) setPinView(found);
  };
  const remove = async (id) => {
    await window.harbor.orchestration.unpinTeam?.(id);
    if (pinView?.id === id) setPinView(null);
    load();
  };
  return (
    <div className="tc-pins">
      <button type="button" className="tc-tool" onClick={pin} disabled={Boolean(pinView)}><PinIcon />Pin this moment</button>
      {pins?.length ? (
        <details className="tc-pin-list">
          <summary>{pins.length} pin{pins.length === 1 ? '' : 's'}</summary>
          <ul>
            {pins.map((p) => (
              <li key={p.id}>
                <button type="button" className="tc-link" onClick={() => open(p.id)}>{new Date(p.pinnedMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</button>
                <span className="tcd-muted">{p.agents} agent{p.agents === 1 ? '' : 's'} · expires {new Date(p.expiresMs).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                <button type="button" className="tc-icon-btn" aria-label="Delete this pin" title="Delete this pin" onClick={() => remove(p.id)}><CloseIcon /></button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {note ? <span className="tc-note" role="status">{note}</span> : null}
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="tc-filter">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
    </label>
  );
}

export function TeamChart({ onPick, onOpenSession, focusId }) {
  const { profiles } = useProfiles();
  const liveNow = useNow();
  const [live, setLive] = useState(null);
  const [pinView, setPinView] = useState(null);
  // ONE display clock (Astra review, 2026-11-03): a pinned moment is read at
  // the moment it was pinned, everywhere (expiry, statuses, counts, drawer),
  // never half at its own time and half at today's.
  const now = pinView ? pinView.pinnedMs : liveNow;
  const [error, setError] = useState(null);
  const [filters, setFiltersState] = useState(readFilters);
  const [selected, setSelected] = useState(null);
  const [openTrays, setOpenTrays] = useState(() => new Set());
  const setFilters = (patch) => setFiltersState((previous) => {
    const next = { ...previous, ...patch };
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(next)); } catch { /* private storage */ }
    return next;
  });

  // Test-only: under HARBOR_E2E (window.harbor.e2e exists) the drive can show
  // an invented team in the real window, to prove the lines on trees deeper
  // and wider than anything running at the time. Inert in a normal Harbor.
  const fixture = useRef(false);
  useEffect(() => {
    if (!window.harbor.e2e) return undefined;
    const onFixture = () => {
      fixture.current = Boolean(window.__harborTeamFixture);
      setLive(window.__harborTeamFixture || null);
      if (!fixture.current) window.harbor.orchestration.team?.().then((first) => first && setLive(first)).catch(() => {});
    };
    window.addEventListener('harbor-team-fixture', onFixture);
    return () => window.removeEventListener('harbor-team-fixture', onFixture);
  }, []);

  useEffect(() => {
    let active = true;
    const api = window.harbor.orchestration;
    // A renderer rebuilt while Harbor's main process is still the older one
    // (the window reloads on a new build; main only on a restart) has no team
    // channel at all. Say so rather than "Loading the team..." forever.
    if (typeof api.team !== 'function' || typeof api.onTeamUpdate !== 'function') {
      setError('The team chart arrived in an update this Harbor window has not loaded yet. Restart Harbor to see it.');
      setLive({ members: {}, edges: [], projects: [], warnings: [], runs: [], ended: [] });
      return () => { active = false; };
    }
    const off = api.onTeamUpdate?.((next) => { if (active && next && !fixture.current) setLive(next); });
    api.watchTeam?.().then((result) => { if (active && result?.ok === false) setError(result.reason); }).catch((reason) => active && setError(reason.message));
    api.team?.().then((first) => { if (active && first && !fixture.current) setLive((previous) => previous || first); }).catch(() => {});
    return () => { active = false; off?.(); api.unwatchTeam?.(); };
  }, []);

  // Sub-worker time limits run on this chart's clock (a pin: its own moment).
  const team = useMemo(() => expireSubWorkers(pinView?.team || live, now), [pinView, live, now]);
  const view = useMemo(() => filterTeam(team, filters), [team, filters]);
  const filtering = filters.project !== 'all' || filters.home !== 'all' || filters.provider !== 'all' || filters.state !== 'all' || filters.warningsOnly;
  const members = team?.members || {};
  const memberList = Object.values(members);
  const selectedMember = selected ? members[selected] : null;
  useEffect(() => { if (selected && team && !members[selected]) setSelected(null); }, [team, selected]);
  // A window header's agents chip lands here with its session: open its card.
  useEffect(() => {
    if (!focusId || !members[focusId]) return;
    setSelected(focusId);
    document.querySelector(`[data-member-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusId, Boolean(members[focusId])]);

  const runsByProject = useMemo(() => {
    const map = new Map();
    for (const run of team?.runs || []) {
      const key = run.project || 'No project';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(run);
    }
    return map;
  }, [team]);
  const projectNames = useMemo(() => {
    const names = new Set((team?.projects || []).map((p) => p.project));
    for (const key of runsByProject.keys()) names.add(key);
    return [...names];
  }, [team, runsByProject]);
  const sections = useMemo(() => {
    const byName = new Map(view.projects.map((p) => [p.project, p]));
    const list = [...view.projects];
    for (const [name] of runsByProject) {
      if (byName.has(name)) continue;
      if (filters.project !== 'all' && filters.project !== name) continue;
      if (filtering && filters.project === 'all') continue;
      list.push({ project: name, counts: null, roots: [], idle: [], memberIds: [], warningIds: [] });
    }
    return list.filter((p) => p.roots.length || p.idle.length || p.loose?.length || runsByProject.has(p.project));
  }, [view, runsByProject, filters, filtering]);

  const homes = [...new Set(memberList.map((m) => m.home).filter(Boolean))];
  const providers = [...new Set(memberList.map((m) => m.provider).filter(Boolean))];
  // What decides the board's size: which frames, which cards, which idle
  // rows. A status or description change does not, so Fit never re-runs on
  // a tick (cards are one fixed size).
  // A tray's height is its number of shown rows, so its size counts too.
  const trayRows = (list, key) => (list?.length ? `${openTrays.has(key) ? list.length : Math.min(list.length, SUB_TRAY_CAP)}${list.length > SUB_TRAY_CAP ? '+' : ''}` : '0');
  const layoutKey = sections.map((s) => `${s.project}:${s.roots.join(',')}:${s.idle.length}:${(runsByProject.get(s.project) || []).length}:${trayRows(s.loose, `loose:${s.project}`)}`).join('|')
    + `#${[...(view.visible || [])].sort().map((id) => `${id}/${trayRows(members[id]?.subWorkers, id)}`).join(',')}`;
  const toggleTray = (key) => setOpenTrays((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  // A sub-worker with a session opens its conversation; a Task helper has
  // none of its own, so it opens its parent's drawer, which lists it.
  const openSub = (entry, ownerId) => {
    if (entry.sessionId && onOpenSession) onOpenSession(entry.sessionId);
    else if (ownerId) setSelected(ownerId);
  };
  const ctx = { team: team || { members: {}, edges: [] }, now, profiles, selected, onSelect: (id) => setSelected((current) => (current === id ? null : id)), visible: view.visible, matched: view.matched, filtering, openTrays, toggleTray, openSub };

  return (
    <div className="team-chart">
      <div className="tc-toolbar">
        <h2 className="tc-title">Team</h2>
        <div className="tc-filters">
          <Select label="Project" value={filters.project} onChange={(project) => setFilters({ project })} options={[['all', 'All projects'], ...projectNames.sort((a, b) => a.localeCompare(b)).map((name) => [name, name])]} />
          <Select label="Plan" value={filters.home} onChange={(home) => setFilters({ home })} options={[['all', 'Any plan'], ...homes.map((id) => [id, homeLabel(id, profiles)])]} />
          <Select label="Provider" value={filters.provider} onChange={(provider) => setFilters({ provider })} options={[['all', 'Any provider'], ...providers.map((id) => [id, providerIdentity(id).label])]} />
          <Select label="State" value={filters.state} onChange={(state) => setFilters({ state })} options={STATE_FILTERS} />
          <label className="tc-toggle"><input type="checkbox" checked={filters.warningsOnly} onChange={(event) => setFilters({ warningsOnly: event.target.checked })} />Warnings only</label>
          {filtering ? <button type="button" className="tc-link" onClick={() => setFilters({ project: 'all', home: 'all', provider: 'all', state: 'all', warningsOnly: false })}>Clear filters</button> : null}
        </div>
        <Pins pinView={pinView} setPinView={setPinView} onError={setError} />
      </div>
      <Legend />
      {pinView ? (
        <div className="tc-pinned" role="status">
          <PinIcon /><span>{`Pinned moment from ${new Date(pinView.pinnedMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. It expires ${new Date(pinView.expiresMs).toLocaleDateString([], { month: 'short', day: 'numeric' })}.`}</span>
          <button type="button" className="tc-link" onClick={() => { setPinView(null); setSelected(null); }}>Back to live</button>
        </div>
      ) : null}
      {error ? <div className="orch-error-banner">{error}</div> : null}
      {!team ? <p className="tc-empty">Loading the team...</p> : null}
      {team && !error && !memberList.length && !sections.length ? <p className="tc-empty">No agents running.</p> : null}
      {team && memberList.length && filtering && !view.matched.size ? (
        <p className="tc-empty">No agents match these filters. <button type="button" className="tc-link" onClick={() => setFilters({ project: 'all', home: 'all', provider: 'all', state: 'all', warningsOnly: false })}>Clear filters</button></p>
      ) : null}

      {(() => {
        // Warnings tied to no project on the chart (test runs outside any
        // pane, a TEAM.json member nobody matches) still get said.
        const placed = new Set(sections.flatMap((section) => section.warningIds));
        const loose = (team?.warnings || []).filter((w) => !placed.has(w.id) && PROJECT_WARNINGS.has(w.kind) && !(w.memberIds || []).length);
        return loose.length && !pinView ? (
          <ul className="tc-project-warnings tc-machine-warnings">
            {loose.map((w) => <li key={w.id}><WarnIcon /><span>{warningText(w, members, profiles, now)}</span></li>)}
          </ul>
        ) : null;
      })()}
      {team && sections.length ? (
        <Board ctx={ctx} layoutKey={layoutKey}>
          {sections.map((section) => {
            const projectWarnings = (team.warnings || []).filter((w) => PROJECT_WARNINGS.has(w.kind) && section.warningIds.includes(w.id));
            return (
              <section className="tc-frame tc-project" key={section.project} aria-label={`${section.project} agents`}>
                <header className="tc-project-head">
                  <h3>{section.project}</h3>
                  {section.counts?.total ? <span className="tc-counts">{countsText(filtering ? countMatched(section, view.matched, members) : section.counts)}{filtering ? ' match' : ''}</span> : <span className="tc-counts">No agents running</span>}
                </header>
                {projectWarnings.length ? (
                  <ul className="tc-project-warnings">
                    {projectWarnings.map((w) => <li key={w.id}><WarnIcon /><span>{warningText(w, members, profiles, now)}</span></li>)}
                  </ul>
                ) : null}
                {(runsByProject.get(section.project) || []).map((run) => <RunSummary key={run.queueId || run.workspace} run={run} onPick={pinView ? null : onPick} />)}
                {section.roots.length ? <div className="tc-forest">{section.roots.map((id) => <TreeNode key={id} id={id} ctx={ctx} />)}</div> : null}
                <SubTray loose entries={section.loose} now={now} expanded={openTrays.has(`loose:${section.project}`)} onToggle={() => toggleTray(`loose:${section.project}`)} onOpen={(entry) => ctx.openSub(entry, null)} />
                {section.idle.length ? (
                  <details className="tc-idle">
                    <summary>{`Idle over 30 minutes (${section.idle.length})`}</summary>
                    <div className="tc-chips">{section.idle.map((id) => members[id] ? <AgentChip key={id} member={members[id]} now={now} selected={selected === id} onSelect={ctx.onSelect} /> : null)}</div>
                  </details>
                ) : null}
              </section>
            );
          })}
        </Board>
      ) : null}

      {team?.ended?.length && !filtering ? (
        <details className="tc-ended">
          <summary>{`Ended in the last 6 hours (${team.ended.length})`}</summary>
          <ul>
            {team.ended.map((entry) => (
              <li key={`${entry.id}-${entry.endedMs}`}>
                <img src={providerIdentity(entry.provider).logo} alt={providerIdentity(entry.provider).label} />
                {entry.sessionId && onOpenSession ? <button type="button" className="tc-link tc-ended-name" onClick={() => onOpenSession(entry.sessionId)} title={entry.description || entry.name}>{entry.name}</button> : <span className="tc-ended-name" title={entry.description || entry.name}>{entry.name}</span>}
                <span className="tcd-muted">{[entry.modelLabel, entry.project, entry.outcome].filter(Boolean).join(' · ')}</span>
                <span className="tc-ended-time"><StatusIcon kind="ended" />{clockText(entry.endedMs)} ({ago(entry.endedMs, now)} ago)</span>
                <CopySessionId sessionId={entry.sessionId} className="tc-copy" />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {selectedMember ? (
        <AgentDrawer member={selectedMember} team={team} now={now} profiles={profiles} onClose={() => setSelected(null)} onSelect={setSelected} onOpenSession={onOpenSession} onOpenSub={(entry) => openSub(entry, null)} returnFocusTo={selected} />
      ) : null}
    </div>
  );
}
