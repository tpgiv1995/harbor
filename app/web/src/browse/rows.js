import {
  filterProjects,
  flattenSidebarRows,
  regroupSidebarModel,
} from '../../../src/shared/sidebar-model.js';

export const BROWSER_PREFS_KEY = 'harbor-web-browser-prefs';
export const BROWSER_COLLAPSE_KEY = 'harbor-web-browser-collapse';

export const DEFAULT_BROWSER_FILTER = { kind: 'rolling', days: 2 };
export const DEFAULT_BROWSER_GROUPING = 'project';

export const BROWSER_FILTER_OPTIONS = [
  { label: 'Today', filter: { kind: 'today' } },
  { label: '48h', filter: { kind: 'rolling', days: 2 } },
  { label: '7d', filter: { kind: 'rolling', days: 7 } },
  { label: '30d', filter: { kind: 'rolling', days: 30 } },
  { label: 'All', filter: { kind: 'all' } },
];

export function loadBrowserPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(BROWSER_PREFS_KEY) || 'null');
    const filter = saved?.filter?.kind === 'today'
      ? { kind: 'today' }
      : saved?.filter?.kind === 'all'
        ? { kind: 'all' }
        : saved?.filter?.kind === 'rolling' && saved.filter.days
          ? { kind: 'rolling', days: Number(saved.filter.days) }
          : DEFAULT_BROWSER_FILTER;
    const grouping = saved?.grouping === 'date' ? 'date' : DEFAULT_BROWSER_GROUPING;
    return { filter, grouping };
  } catch {
    return { filter: DEFAULT_BROWSER_FILTER, grouping: DEFAULT_BROWSER_GROUPING };
  }
}

export function saveBrowserPrefs(partial) {
  try {
    const current = loadBrowserPrefs();
    localStorage.setItem(BROWSER_PREFS_KEY, JSON.stringify({ ...current, ...partial }));
  } catch {
    /* storage may be unavailable */
  }
}

export function loadCollapsedProjects() {
  try {
    const saved = JSON.parse(localStorage.getItem(BROWSER_COLLAPSE_KEY) || '[]');
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedProjects(collapsed) {
  try {
    localStorage.setItem(BROWSER_COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* storage may be unavailable */
  }
}

export function filterMatches(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'rolling') return a.days === b.days;
  return true;
}

export function needsAnswer(session) {
  return session?.agentStatus === 'blocked';
}

export function sessionState(session) {
  if (needsAnswer(session)) return 'needs-answer';
  if (session?.agentStatus === 'working') return 'working';
  return 'idle';
}

// Blocked first, then working, then idle; within each band sort by lastActiveMs desc.
export function compareSessionsForBrowser(a, b) {
  const rank = (session) => {
    if (needsAnswer(session)) return 0;
    if (session?.agentStatus === 'working') return 1;
    return 2;
  };
  const delta = rank(a) - rank(b);
  if (delta !== 0) return delta;
  return (b?.lastActiveMs || 0) - (a?.lastActiveMs || 0);
}

export function prioritizeSidebarModel(model) {
  const projects = (model?.projects || []).map((project) => {
    const sessions = [...(project.sessions || [])].sort(compareSessionsForBrowser);
    const lead = sessions[0];
    const leadRank = lead
      ? (needsAnswer(lead) ? 0 : lead.agentStatus === 'working' ? 1 : 2)
      : 2;
    return {
      ...project,
      sessions,
      __browserRank: leadRank,
      __browserRecency: lead?.lastActiveMs || 0,
    };
  }).sort((a, b) => {
    if (a.__browserRank !== b.__browserRank) return a.__browserRank - b.__browserRank;
    return (b.__browserRecency || 0) - (a.__browserRecency || 0);
  }).map(({ __browserRank, __browserRecency, ...project }) => project);
  return { ...model, projects };
}

function withIcon(row, iconUrl) {
  if (row.kind === 'project') {
    return { ...row, iconUrl: iconUrl(row.project.label) };
  }
  if (row.kind === 'session') {
    const label = row.project?.label || row.session?.project;
    return { ...row, iconUrl: iconUrl(label) };
  }
  return row;
}

function collectBlockedSessions(model) {
  const pinned = [];
  for (const project of model?.projects || []) {
    for (const session of project.sessions || []) {
      if (needsAnswer(session) && !session.isChildTask) {
        pinned.push({ project, session });
      }
    }
  }
  pinned.sort((a, b) => compareSessionsForBrowser(a.session, b.session));
  return pinned;
}

function modelWithoutBlocked(model) {
  const projects = (model?.projects || [])
    .map((project) => ({
      ...project,
      sessions: (project.sessions || []).filter((session) => !needsAnswer(session)),
    }))
    .filter((project) => project.sessions.length > 0);
  return { ...model, projects };
}

export function splitBrowserRows(rows) {
  const pinned = [];
  const list = [];
  for (const row of rows) {
    if (row.kind === 'answer-section' || (row.kind === 'session' && row.pinned)) {
      pinned.push(row);
      continue;
    }
    list.push(row);
  }
  return { pinned, list };
}

export function buildBrowserRows(model, {
  iconUrl = () => null,
  filter = DEFAULT_BROWSER_FILTER,
  grouping = DEFAULT_BROWSER_GROUPING,
  query = '',
  collapsedProjects = new Set(),
  expandedOlder = new Set(),
} = {}) {
  const prioritized = prioritizeSidebarModel(model);
  const regrouped = regroupSidebarModel(prioritized, { grouping });
  const filtered = filterProjects(regrouped, { filter, query });
  const rows = [];

  const blocked = collectBlockedSessions(filtered);
  if (blocked.length > 0) {
    rows.push({
      kind: 'answer-section',
      key: 'answer-section',
      count: blocked.length,
    });
    for (const { project, session } of blocked) {
      rows.push(withIcon({
        kind: 'session',
        key: `pinned:${session.id}`,
        project,
        session,
        pinned: true,
      }, iconUrl));
    }
  }

  const grouped = modelWithoutBlocked(filtered);
  const { rows: projectRows } = flattenSidebarRows(grouped, {
    includeChildren: Boolean(String(query || '').trim()),
    collapsedProjects,
    expandedOlder,
  });
  for (const row of projectRows) {
    rows.push(withIcon(row, iconUrl));
  }
  return rows;
}

function sessionMatchesQuery(row, needle) {
  const title = row.session?.childTitle || row.session?.title || '';
  const project = row.project?.label || row.session?.project || '';
  return title.toLowerCase().includes(needle)
    || String(project).toLowerCase().includes(needle);
}

export function filterBrowserRows(rows, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return rows;

  const sessions = [];
  const seen = new Set();
  for (const row of rows) {
    if (row.kind !== 'session') continue;
    if (!sessionMatchesQuery(row, needle)) continue;
    if (seen.has(row.session.id)) continue;
    seen.add(row.session.id);
    sessions.push(row);
  }

  const projects = rows.filter(
    (row) => row.kind === 'project'
      && String(row.project?.label || '').toLowerCase().includes(needle),
  );

  const grouped = new Map();
  for (const row of sessions) {
    const label = row.project?.label || row.session?.project || 'Unknown';
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(row);
  }

  const out = [];
  for (const row of projects) {
    const label = row.project.label;
    if (grouped.has(label)) continue;
    out.push(row);
    const projectSessions = (row.project.sessions || [])
      .filter((session) => {
        const fake = {
          session,
          project: row.project,
        };
        return sessionMatchesQuery(fake, needle);
      })
      .sort(compareSessionsForBrowser);
    for (const session of projectSessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      out.push({
        kind: 'session',
        key: `session:${session.id}`,
        project: row.project,
        session,
        iconUrl: row.iconUrl,
      });
    }
  }

  for (const [label, projectSessions] of grouped) {
    out.push({
      kind: 'project',
      key: `project:${label}`,
      project: projectSessions[0].project || { label, sessions: [] },
      iconUrl: projectSessions[0].iconUrl,
    });
    for (const row of projectSessions) out.push(row);
  }

  return out;
}
