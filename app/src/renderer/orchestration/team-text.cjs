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
  const projects = (team.projects || [])
    .filter((p) => !filters.project || filters.project === 'all' || p.project === filters.project)
    .map((p) => ({ ...p, roots: p.roots.filter((id) => visible.has(id)), idle: p.idle.filter((id) => visible.has(id)) }));
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

module.exports = { EFFORT_STEPS, STATE_FILTERS, ago, statusText, effortStep, runModeText, warningText, edgeTitle, filterTeam, countsText, clockText, resetText, homeLabel };
