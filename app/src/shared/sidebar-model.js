import {
  parseLocalDateTime,
  cutoffForFilter,
  displayDayFor,
} from './date-roll.js';

export const DEFAULT_VISIBLE_SESSIONS = 12;
export const WIN_PREFIX = 'win:';
export const LINUX_PREFIX = 'linux:';
// claude-delegate prefixes every orchestration worker's opening prompt with this
// (see build_dispatch_prompt in ~/.local/bin/claude-delegate). It is the reliable
// marker that a session is an orchestration child task rather than something Pat
// started himself. Since 2026-07-24 codex/cursor sessions reach the sidebar too
// (provider-history rows), and their worker prompts carry the same prefix.
export const CHILD_TASK_PREFIX = 'BATCH TITLE:';
export const ORCHESTRATION_PROJECT = 'Orchestration';

// The daemon names the agent it detects in a pane ('claude', 'codex', 'cursor';
// the cursor CLI can also detect as 'cursor-agent'). That name is the
// provider fact for live panes: without this mapping every codex/cursor pane
// masqueraded as claude, so its window could never resolve a provider
// transcript and dead-ended in the raw terminal (live-caught 2026-07-24).
const AGENT_PROVIDERS = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
};

export function paneProvider(pane) {
  if (pane?.provider) return pane.provider;
  return AGENT_PROVIDERS[String(pane?.agent || '').toLowerCase()] || 'claude';
}

// An era label marks a session from a previous machine's OS: the pre-Linux
// Windows history seen from the Linux install (`win: `), and the Linux-era
// history seen now that the host is Windows again (`linux: `). Either way its
// cwd does not exist on this host, so the rail lists it but cannot open,
// resume, or launch from it. The name predates the second migration; the flag
// means "foreign era", not "Windows".
export function isWindowsEra(project) {
  const label = String(project || '').trim().toLowerCase();
  return label.startsWith(WIN_PREFIX) || label.startsWith(LINUX_PREFIX);
}

export function isChildTask(title) {
  return String(title || '').trimStart().startsWith(CHILD_TASK_PREFIX);
}

// Orchestration debris is one rail project, regardless of where the scratch
// root sits or how many batch/repository segments follow it. Keep this string
// based so Windows and POSIX transcripts classify identically on either host.
//
// The debris arrives in more spellings than the `.orch\` worktree this rule
// was first written for. Live-caught 2026-08-23, ONE DAY after it shipped:
// four ungrouped orch groups on the rail, because the 08-22 wave ran cursor
// seats (whose munge collapses runs: `\.orch\` -> `-orch-`, not Claude's
// per-character `--orch-`) and a research workspace under the app's own cache
// (`~/.cache/harbor/orch-research-<date>`, no `.orch` segment at all). So:
// - a real cwd is orchestration when any segment is `.orch`/`orch` or starts
//   with `orch-` (dotted or not); the segment START is the convention, so
//   a project honestly named with an interior `-orch-` fragment stays out.
// - a munged label (kept when a row loses its cwd) is orchestration when it
//   carries the dash-delimited token `orch`. Munging erases the segment
//   structure that would distinguish `\.orch\` from a `-orch-` name fragment,
//   and the convention wins the ambiguity: nothing real (orchestra,
//   orchestrator, pytorch) shortens to the bare token.
export function isOrchestrationCwd({ cwd, label } = {}) {
  const name = typeof label === 'string' ? label.trim() : '';
  if (isWindowsEra(name)) return false;
  const dir = typeof cwd === 'string' ? cwd.trim() : '';
  if (dir) {
    return dir.split(/[\\/]/).some((segment) => {
      const s = segment.toLowerCase();
      return s === '.orch' || s === 'orch' || s.startsWith('.orch-') || s.startsWith('orch-');
    });
  }
  return /(^|[-/])orch([-/]|$)/u.test(name.toLowerCase());
}

// A throwaway working directory is not a project. Live-caught 2026-07-29, when
// the batch-1..13 port orchestration left Pat's rail carrying about a dozen
// groups like 'claude-delegate-lanes-wza1m_a9/lane-batch-11': each codex worker
// ran in its own lane worktree under /tmp, projectLabelForCwd() names any cwd
// outside home by its last two segments, so every dead lane became its own
// project. The cursor half is worse than noise: cursor records no cwd, so those
// rows un-munge to nothing, list with `cwd: null`, and cannot even be resumed.
// The BATCH TITLE: rule never caught any of it, because codex and cursor workers
// are not launched with that prompt prefix.
//
// Hidden by DEFAULT only, exactly like orchestration workers: a search
// re-includes them, so no session ever becomes unreachable. A LIVE session is
// never hidden by this, whatever directory it runs in, because an invisible
// running agent is a dead end (the rail is the only session browser).
const TEMP_ROOT_RE = /^(?:\/tmp|\/var\/tmp|\/private\/tmp|\/private\/var\/folders)(?:\/|$)/;
const WINDOWS_TEMP_RE = /(?:^|\\)(?:Temp|tmp)(?:\\|$)/i;
// The lane worktree root claude-delegate creates per orchestration run. Matched
// on the label because that is all a cursor row has left.
const LANE_ROOT = 'claude-delegate-lanes';

export function isScratchProject({ label, cwd } = {}) {
  const dir = typeof cwd === 'string' ? cwd.trim() : '';
  if (dir && (TEMP_ROOT_RE.test(dir) || WINDOWS_TEMP_RE.test(dir))) return true;
  const name = typeof label === 'string' ? label.trim() : '';
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower.includes(LANE_ROOT)) return true;
  // 'tmp/cardprobe' (a real temp cwd), 'tmp-claude-delegate-...' (cursor's munge
  // of one). Anchored, so a project legitimately named 'tmpl-something' stays.
  if (/^tmp[-/\\]/.test(lower)) return true;
  // A hidden directory is an application's own state, not a project: '~/.gameclient'
  // labels as '.gameclient'. The home label itself is '~', never dot-prefixed.
  if (name.startsWith('.')) return true;
  return false;
}

export function isScratchSession(session) {
  if (!session || session.isLive) return false;
  return isScratchProject({ label: session.project, cwd: session.cwd });
}

// "BATCH TITLE: Notes census isolation (P1) FINDING IDS: C-2 PRIORITY: ..." ->
// "Notes census isolation (P1)". Falls back to the raw title if it is not a
// child-task prompt.
export function childTaskTitle(title) {
  const raw = String(title || '').trimStart();
  if (!raw.startsWith(CHILD_TASK_PREFIX)) return String(title || '');
  let rest = raw.slice(CHILD_TASK_PREFIX.length).trim();
  for (const marker of [' FINDING IDS:', ' PRIORITY:', ' GOAL:']) {
    const idx = rest.indexOf(marker);
    if (idx >= 0) rest = rest.slice(0, idx);
  }
  return rest.trim() || raw;
}

export function sessionAgentId(agentSession) {
  if (!agentSession || agentSession.kind !== 'id') return null;
  return agentSession.value || null;
}

export function normalizeHome(home, profiles = null) {
  if (Array.isArray(profiles) && profiles.length > 0) {
    if (home && profiles.some((profile) => profile.id === home)) return home;
    const fallback = profiles.find((profile) => profile.isDefault) || profiles[0];
    return fallback?.id || home || null;
  }
  return home || null;
}

// The session a PROJECT-level action resolves its root from. Orchestration
// needs any real session in the project, live or dead, purely to locate the
// project root; that is a different question from the P/T/S launch anchor,
// which insists on a DEAD session because it carries the home a new session
// inherits. Gating the rail's Orch chip on that launch anchor hid the chip from
// every project whose sessions were all live (live-caught 2026-07-25: Pat's
// NOTES/WIKI group had exactly one session and it was running). A `live:`
// row is an agent pane the daemon has not named yet, so it holds no session id and
// can never resolve a root.
export function projectRootSessionId(project) {
  return project?.sessions?.find(
    (session) => !session.isWindowsEra && !String(session.id).startsWith('live:'),
  )?.id || null;
}

function resolvableCwd(cwd) {
  return typeof cwd === 'string' && cwd.trim() ? cwd : null;
}

function dateGroupLabel(day, today) {
  const dayMs = day.getTime();
  const todayMs = today.getTime();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayMs === todayMs) return 'Today';
  if (dayMs === yesterday.getTime()) return 'Yesterday';
  return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function groupSessions(sessions, grouping, now) {
  const groupMode = grouping === 'date' ? 'date' : 'project';
  const today = displayDayFor(now);
  const groups = new Map();
  for (const session of sessions) {
    const displayDay = displayDayFor(new Date(session.lastActiveMs));
    const key = groupMode === 'date'
      ? String(displayDay.getTime())
      : (isOrchestrationCwd({ cwd: session.cwd, label: session.project })
        ? ORCHESTRATION_PROJECT
        : (session.project || '~'));
    if (!groups.has(key)) {
      groups.set(key, {
        label: groupMode === 'date' ? dateGroupLabel(displayDay, today) : key,
        displayDayMs: groupMode === 'date' ? displayDay.getTime() : null,
        sessions: [],
      });
    }
    groups.get(key).sessions.push(session);
  }

  const projects = [...groups.values()].map(({ label, displayDayMs, sessions: groupedSessions }) => {
    groupedSessions.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
    const lastActiveMs = groupedSessions[0]?.lastActiveMs || 0;
    const newSessionCwd = groupMode === 'project'
      ? (groupedSessions.find((session) => session.isHistorical && resolvableCwd(session.cwd))?.cwd
        || groupedSessions.find((session) => resolvableCwd(session.cwd))?.cwd
        || null)
      : null;
    return {
      label,
      sessions: groupedSessions,
      sessionCount: groupedSessions.length,
      lastActiveMs,
      hasLive: groupedSessions.some((s) => s.isLive),
      isWindowsEra: groupMode === 'project' && isWindowsEra(label),
      isOrchestration: groupMode === 'project' && label === ORCHESTRATION_PROJECT,
      isDateGroup: groupMode === 'date',
      displayDayMs,
      newSessionCwd,
    };
  });
  projects.sort((a, b) => (groupMode === 'date'
    ? b.displayDayMs - a.displayDayMs
    : b.lastActiveMs - a.lastActiveMs));
  return projects;
}

export function regroupSidebarModel(model, { grouping = 'project', now = new Date() } = {}) {
  const sessions = (model.projects || []).flatMap((project) => project.sessions || []);
  return {
    ...model,
    projects: groupSessions(sessions, grouping, new Date(now)),
    grouping: grouping === 'date' ? 'date' : 'project',
  };
}

export function mergeSidebarModel({ historySessions = [], livePanes = [], workspaces = [], homes = {}, grouping = 'project', now = new Date() } = {}) {
  const groupMode = grouping === 'date' ? 'date' : 'project';
  const currentTime = new Date(now);
  const workspaceById = new Map((workspaces || []).map((w) => [w.workspace_id, w]));
  const liveBySessionId = new Map();
  const liveProjects = new Set();

  for (const pane of livePanes || []) {
    const workspace = workspaceById.get(pane.workspace_id);
    const project = workspace?.label || null;
    const sessionId = sessionAgentId(pane.agent_session);
    const live = {
      paneId: pane.pane_id,
      workspaceId: pane.workspace_id,
      project,
      sessionId,
      provider: paneProvider(pane),
      model: pane.model || pane.metadata?.tokens?.model || null,
      agentStatus: pane.agent_status || null,
      title: pane.terminal_title || pane.label || 'Live session',
      lastActiveMs: currentTime.getTime(),
      lastActive: currentTime.toISOString(),
      cwd: resolvableCwd(workspace?.cwd)
        || resolvableCwd(pane.cwd)
        || resolvableCwd(pane.foreground_cwd),
    };
    // A pane with agent facts but no reported session id (codex/cursor
    // before their hook reports, claude during detection lag) still shows in
    // the rail under its live: key; the rail is the ONLY session browser and
    // an invisible running agent is a dead end (live-caught 2026-07-24: a
    // codex pane with agent_session null simply did not exist in Harbor).
    liveBySessionId.set(sessionId || `live:${pane.pane_id}`, live);
    if (project) liveProjects.add(project);
  }

  const byId = new Map();
  for (const row of historySessions || []) {
    if (!row?.id) continue;
    const lastDt = parseLocalDateTime(row.lastActive);
    const lastActiveMs = lastDt ? lastDt.getTime() : 0;
    const live = liveBySessionId.get(row.id);
    byId.set(row.id, {
      id: row.id,
      project: (row.project || '').trim(),
      title: row.title || '(no user messages)',
      // Titles are LLM-generated summaries when available; keep the raw first
      // prompt so search still matches what Pat actually typed.
      firstPrompt: row.firstPrompt ?? null,
      lastActive: row.lastActive,
      lastActiveMs,
      home: row.home ?? homes[row.id] ?? null,
      provider: row.provider || 'claude',
      model: row.model || live?.model || null,
      isLive: Boolean(live),
      paneId: live?.paneId ?? null,
      workspaceId: live?.workspaceId ?? null,
      agentStatus: live?.agentStatus ?? null,
      isWindowsEra: isWindowsEra(row.project),
      isChildTask: isChildTask(row.title),
      childTitle: isChildTask(row.title) ? childTaskTitle(row.title) : null,
      cwd: resolvableCwd(row.cwd),
      isHistorical: true,
    });
    if (live) liveBySessionId.delete(row.id);
  }

  for (const live of liveBySessionId.values()) {
    if (!live.project) continue;
    byId.set(`live:${live.paneId}`, {
      id: live.sessionId || `live:${live.paneId}`,
      project: live.project,
      title: live.title,
      firstPrompt: null,
      lastActive: live.lastActive,
      lastActiveMs: live.lastActiveMs,
      home: live.sessionId ? (homes[live.sessionId] ?? null) : null,
      provider: live.provider || 'claude',
      model: live.model || null,
      isLive: true,
      paneId: live.paneId,
      workspaceId: live.workspaceId,
      agentStatus: live.agentStatus,
      isWindowsEra: isWindowsEra(live.project),
      isChildTask: isChildTask(live.title),
      childTitle: isChildTask(live.title) ? childTaskTitle(live.title) : null,
      cwd: live.cwd,
      isHistorical: false,
    });
  }

  const projects = groupSessions([...byId.values()], groupMode, currentTime);

  return { projects, liveProjects: [...liveProjects], grouping: groupMode };
}

export function filterProjects(model, { filter, query, now } = {}) {
  const cutoff = cutoffForFilter(filter, now);
  const needle = query ? String(query).trim().toLowerCase() : '';
  const projects = [];

  for (const project of model.projects) {
    const projectMatches = needle && project.label.toLowerCase().includes(needle);
    let sessions = project.sessions.filter((session) => {
      if (cutoff && !session.isLive) {
        const dt = parseLocalDateTime(session.lastActive);
        if (!dt || dt < cutoff) return false;
      }
      // Throwaway directories drop out until searched for. Filtered per SESSION
      // rather than per project so it behaves the same under date grouping,
      // where a group holds several projects; a project left with no sessions is
      // already dropped below.
      if (!needle && isScratchSession(session)) return false;
      if (!needle) return true;
      if (projectMatches) return true;
      return `${session.project}\n${session.title}\n${session.firstPrompt || ''}`.toLowerCase().includes(needle);
    });
    sessions.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
    if (sessions.length === 0) continue;
    projects.push({
      ...project,
      sessions,
      sessionCount: sessions.length,
      lastActiveMs: sessions[0]?.lastActiveMs || 0,
      hasLive: sessions.some((s) => s.isLive),
    });
  }

  return { ...model, projects };
}

export function flattenSidebarRows(model, uiState = {}) {
  const {
    collapsedProjects = new Set(),
    expandedOlder = new Set(),
    // When a search is active, orchestration workers are surfaced so a specific
    // one can still be found; otherwise they are excluded from the browser.
    includeChildren = false,
  } = uiState;
  const rows = [];
  let sessionRowCount = 0;

  for (const project of model.projects) {
    // The user's explicit collapse always wins, even for a project with a live
    // session (previously a live project could never be collapsed at all).
    const collapsed = collapsedProjects.has(project.label);
    rows.push({
      kind: 'project',
      key: `project:${project.label}`,
      project,
      collapsed,
      hasChildren: project.sessions.some((session) => session.isChildTask),
    });
    if (collapsed) continue;

    // Orchestration workers (BATCH TITLE: ...) never clutter the session
    // browser: excluded by default (a search re-includes matching ones), and
    // never as inline rows or a nested group.
    const regular = includeChildren
      ? project.sessions
      : project.sessions.filter((session) => !session.isChildTask);

    const visibleCap = expandedOlder.has(project.label)
      ? regular.length
      : Math.min(DEFAULT_VISIBLE_SESSIONS, regular.length);
    const visible = regular.slice(0, visibleCap);
    const hidden = regular.length - visible.length;

    for (const session of visible) {
      sessionRowCount += 1;
      rows.push({
        kind: 'session',
        key: `session:${session.id}`,
        project,
        session,
      });
    }
    if (hidden > 0) {
      rows.push({
        kind: 'older',
        key: `older:${project.label}`,
        project,
        hiddenCount: hidden,
      });
    }
  }

  return { rows, sessionRowCount };
}
