'use strict';

// Words for the team chart (2026-11-02). Pure, so the card, the drawer and the
// tests say the same thing. Ages are computed from timestamps at render time
// with the chart's one clock; nothing here reads the time on its own.

const EFFORT_STEPS = ['low', 'medium', 'high', 'xhigh', 'max'];

function ago(ms, now) {
  if (!Number.isFinite(ms) || !ms) return null;
  const minutes = Math.max(0, Math.floor((now - ms) / 60000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d`;
}

// "Working 4m", "Idle 12m", "Bash open 4m", "Quiet 8m", "Starting", "Ended".
function statusText(status, now) {
  const age = ago(status?.sinceMs, now);
  switch (status?.kind) {
    case 'working': return age ? `Working ${age}` : 'Working';
    case 'tool': return `${status.tool || 'Tool'} open${age ? ` ${age}` : ''}`;
    case 'quiet': return `Quiet ${age || ''}`.trim();
    case 'starting': return 'Starting';
    case 'ended': return 'Ended';
    default: return age ? `Idle ${age}` : 'Idle';
  }
}

// A sub-worker's state in words, with the chart's clock: "Working",
// "Bash open", "Finished 5m ago", "Idle 12m" (the cards' own word; the
// longer "Last active 1h 22m ago" did not fit a mini card). Only fresh evidence
// counts, the same rule as team-model.cjs `subWorkerActive`: a write in the
// last three minutes, or an open tool within 30 minutes of its last activity.
// A fold's `working` flag alone is not (an interrupted helper keeps it).
const SUB_FRESH_MS = 3 * 60 * 1000;
const SUB_TOOL_MS = 30 * 60 * 1000;
const SUB_WINDOW_MS = 6 * 60 * 60 * 1000;
const SUB_LOOSE_FRAME_MS = 30 * 60 * 1000;
const IDLE_ROW_MS = 30 * 60 * 1000;
function subStatus(entry, now) {
  const since = ago(entry?.lastEventMs, now);
  const age = entry?.lastEventMs ? now - entry.lastEventMs : Infinity;
  if (entry?.finished) return { kind: 'ended', live: false, text: since ? `Finished ${since} ago` : 'Finished' };
  if (entry?.openTool && age < SUB_TOOL_MS) return { kind: 'tool', live: true, text: `${entry.openTool} open` };
  if (age < SUB_FRESH_MS) return { kind: 'working', live: true, text: 'Working' };
  return { kind: 'idle', live: false, text: since ? `Idle ${since}` : 'Idle' };
}

// A member's sub-workers. A pin saved before 2026-11-03 has only `helpers`;
// they become tray entries here so an old pin still shows them.
function subWorkersOf(member) {
  if (Array.isArray(member?.subWorkers)) return member.subWorkers;
  return (member?.helpers || []).map((helper) => ({
    key: `helper:${member.id}:${helper.id}`, kind: 'helper',
    kindText: helper.agentType ? `${helper.agentType} sub-agent (Task)` : 'Sub-agent (Task)',
    provider: 'claude', name: helper.description || helper.agentType || 'Sub-agent', sessionId: null, modelLabel: helper.modelLabel || null,
    startedMs: helper.startedMs || null, lastEventMs: helper.lastEventMs || null, finished: Boolean(helper.finished), working: Boolean(helper.working),
    openTool: helper.openTool?.name || null, source: 'transcript',
  }));
}

// The chart's time limits applied with ITS clock (a live chart: now; a pin:
// the moment it was pinned), because main recomputes only on events and a
// quiet machine sends none: sub-workers older than 6 hours leave their tray,
// and a frame that holds nothing but loose sub-workers leaves once none of
// them was active in the last 30 minutes (Astra review, 2026-11-03).
function expireSubWorkers(team, at) {
  if (!team) return team;
  const keep = (list) => (list || []).filter((entry) => !entry.lastEventMs || at - entry.lastEventMs <= SUB_WINDOW_MS);
  const members = {};
  for (const [id, member] of Object.entries(team.members || {})) members[id] = { ...member, subWorkers: keep(subWorkersOf(member)) };
  // The idle-row rule of team-model.cjs, re-read on this clock: a card kept
  // open only by recent sub-workers folds once they have been quiet for 30
  // minutes, with no event from main needed. Cards are only ever folded
  // here, never unfolded: a card main folded stays folded until main says.
  const folds = (id) => {
    const member = members[id];
    const status = member?.status;
    if (!member || !['idle', 'quiet'].includes(status?.kind) || !status.sinceMs || at - status.sinceMs < IDLE_ROW_MS) return false;
    if ((member.children || []).some((kid) => members[kid]) || (member.warnings || []).length) return false;
    return !member.subWorkers.some((entry) => subStatus(entry, at).live || (entry.lastEventMs && at - entry.lastEventMs < IDLE_ROW_MS));
  };
  const projects = (team.projects || []).map((project) => {
    const folded = (project.roots || []).filter(folds);
    return {
      ...project,
      loose: keep(project.loose),
      roots: folded.length ? project.roots.filter((id) => !folded.includes(id)) : (project.roots || []),
      idle: folded.length ? [...(project.idle || []), ...folded] : (project.idle || []),
    };
  }).filter((project) => (project.memberIds || []).length || (project.roots || []).length || (project.idle || []).length
    || project.loose.some((entry) => entry.lastEventMs && at - entry.lastEventMs <= SUB_LOOSE_FRAME_MS));
  return { ...team, members, projects };
}

function subCountText(list, now) {
  const total = (list || []).length;
  const running = (list || []).filter((entry) => subStatus(entry, now).live).length;
  return `${total} sub-worker${total === 1 ? '' : 's'}${running ? `, ${running} running` : ''}`;
}

const SUB_SOURCE_WORDS = {
  transcript: 'a Task sub-agent inside this agent\'s session',
  spawned: 'started by this agent',
  launch: 'launched by this agent (launch record)',
  folder: 'ran in this agent\'s folder after it started; who started it is not on record',
};

function subSourceText(entry) {
  if (entry?.source === 'spawned-via') return `started by ${entry.via || 'a sub-worker'}, which this agent started`;
  return SUB_SOURCE_WORDS[entry?.source] || 'the agent that started it is not on the chart';
}

function effortStep(effort) {
  const index = EFFORT_STEPS.indexOf(String(effort || '').toLowerCase());
  return index < 0 ? null : index + 1;
}

const LAUNCHER_WORDS = {
  'claude-worker': 'Headless worker',
  'astra-run': 'Astra run',
  'cursor-worker': 'Cursor worker',
  'cursor-run': 'Cursor run',
};

function runModeText(member) {
  if (member.runMode === 'pane') return 'Harbor pane';
  if (member.launcher && LAUNCHER_WORDS[member.launcher]) return LAUNCHER_WORDS[member.launcher];
  if (member.provider === 'codex') return 'Codex run';
  if (member.provider === 'cursor') return 'Cursor worker';
  return 'Headless worker';
}

const SOURCE_WORDS = {
  launch: 'launched it',
  declared: 'is its lead (TEAM.json)',
  delegation: 'started it from a command',
  process: 'runs it inside its pane',
};

function names(ids, members, max = 3) {
  const list = ids.map((id) => members[id]?.name || 'an agent');
  if (list.length <= max) return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || '';
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

function resetText(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return null;
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function homeLabel(homeId, profiles) {
  const profile = (profiles || []).find((p) => p.id === homeId);
  return profile?.label || homeId || 'unknown plan';
}

// Each warning names what depends on what, or the agent that acts. Never a
// fix phrased as Pat closing or keeping a pane (Pat, section 8 item 2).
function warningText(warning, members, profiles, now) {
  const count = (warning.memberIds || []).length;
  switch (warning.kind) {
    case 'plan-near-limit': {
      const reset = resetText(warning.resetsAt);
      return `${homeLabel(warning.home, profiles)} is at ${Math.round(warning.pct)}% of its weekly limit${reset ? ` (resets ${reset})` : ''}. ${count} agent${count === 1 ? '' : 's'} on it: ${names(warning.memberIds, members)}.`;
    }
    case 'process-parent': {
      const n = warning.dependents.length;
      return `${n} worker${n === 1 ? '' : 's'} depend${n === 1 ? 's' : ''} on this pane: ${names(warning.dependents, members)}.`;
    }
    case 'two-writers-session':
      return `${warning.panes.length} panes hold this one session; both can write to it.`;
    case 'two-writers-folder':
      return `${names(warning.memberIds, members)} both write in ${warning.cwd}.`;
    case 'duplicate-name':
      return `${count} live sessions are named "${warning.name}".`;
    case 'tool-stuck':
      return `${warning.tool} has been open ${ago(warning.sinceMs, now) || 'a while'} in ${members[warning.memberIds[0]]?.name || 'this agent'}: possibly stuck.`;
    case 'quiet-parent':
      return `No transcript activity for ${ago(warning.sinceMs, now)} while its helpers or workers run.`;
    case 'many-test-runs':
      return `${warning.count} test runs at once${count ? ` under ${names(warning.memberIds, members)}` : ' on this machine'}.`;
    case 'declared-absent':
      return `TEAM.json lists ${warning.name}, and no live agent matches it.`;
    case 'undeclared':
      return `${members[warning.memberIds[0]]?.name || 'This agent'} is live in the project and not in its TEAM.json.`;
    default:
      return warning.kind;
  }
}

function edgeTitle(edge, members) {
  const from = members[edge.from]?.name || 'An agent';
  const to = members[edge.to]?.name || 'this agent';
  if (edge.kind === 'reviews') return `${from} reviews ${to}`;
  if (edge.kind === 'keeps-alive') return `${to} runs inside ${from}'s pane, so it depends on that pane`;
  return `${from} ${SOURCE_WORDS[edge.source] || 'directs it'}: ${to}`;
}

const STATE_FILTERS = [
  ['all', 'Any state'],
  ['working', 'Working'],
  ['tool', 'Tool open'],
  ['quiet', 'Quiet'],
  ['idle', 'Idle'],
  ['starting', 'Starting'],
];

// The filtered view of one derived team. A member is shown when it passes
// every filter; its ancestors stay visible (dimmed by the caller) so a match
// deep in a tree keeps its reporting line.
function filterTeam(team, filters = {}) {
  if (!team) return { projects: [], visible: new Set(), matched: new Set() };
  const members = team.members || {};
  const warned = new Set((team.warnings || []).flatMap((w) => w.memberIds || []));
  const passes = (member) => (
    (!filters.project || filters.project === 'all' || member.teamProject === filters.project)
    && (!filters.home || filters.home === 'all' || member.home === filters.home)
    && (!filters.provider || filters.provider === 'all' || member.provider === filters.provider)
    && (!filters.state || filters.state === 'all' || member.status?.kind === filters.state)
    && (!filters.warningsOnly || warned.has(member.id))
  );
  const matched = new Set(Object.values(members).filter(passes).map((m) => m.id));
  const visible = new Set(matched);
  for (const id of matched) {
    let cursor = members[id];
    const seen = new Set();
    while (cursor?.parent && !seen.has(cursor.parent)) { seen.add(cursor.parent); visible.add(cursor.parent); cursor = members[cursor.parent]; }
  }
  // A project's loose sub-workers belong to no card, so a plan, provider,
  // state or warnings filter has nothing to match them on: they hide.
  const memberFilter = (filters.home && filters.home !== 'all') || (filters.provider && filters.provider !== 'all')
    || (filters.state && filters.state !== 'all') || filters.warningsOnly;
  const projects = (team.projects || [])
    .filter((p) => !filters.project || filters.project === 'all' || p.project === filters.project)
    .map((p) => ({ ...p, roots: p.roots.filter((id) => visible.has(id)), idle: p.idle.filter((id) => visible.has(id)), loose: memberFilter ? [] : (p.loose || []) }));
  return { projects, visible, matched };
}

function countsText(counts) {
  if (!counts) return '';
  const parts = [];
  if (counts.working) parts.push(`${counts.working} working`);
  if (counts.tool) parts.push(`${counts.tool} in a tool`);
  if (counts.starting) parts.push(`${counts.starting} starting`);
  if (counts.quiet) parts.push(`${counts.quiet} quiet`);
  if (counts.idle) parts.push(`${counts.idle} idle`);
  return parts.join(', ') || 'none running';
}

function clockText(ms) {
  if (!Number.isFinite(ms) || !ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

module.exports = { EFFORT_STEPS, STATE_FILTERS, ago, statusText, subStatus, subCountText, subSourceText, subWorkersOf, expireSubWorkers, effortStep, runModeText, warningText, edgeTitle, filterTeam, countsText, clockText, resetText, homeLabel };
