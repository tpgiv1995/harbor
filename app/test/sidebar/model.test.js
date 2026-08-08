'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeSidebarModel,
  regroupSidebarModel,
  filterProjects,
  flattenSidebarRows,
  isWindowsEra,
  isChildTask,
  childTaskTitle,
  isScratchProject,
  isScratchSession,
  projectRootSessionId,
} = require('../../src/shared/sidebar-model.cjs');
const { cutoffForFilter } = require('../../src/shared/date-roll.cjs');
const { parseEmitTsv } = require('../../src/main/providers/history.js');
const fs = require('node:fs');
const path = require('node:path');

const sidebarSource = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/sidebar/Sidebar.jsx'),
  'utf8',
);

const emitRows = (...rows) => parseEmitTsv(rows.join('\n'));

test('project launch actions render one button per configured profile', () => {
  assert.match(sidebarSource, /renderProfileLaunchButtons/);
  assert.match(sidebarSource, /profiles\.map\(\(profile\)/);
});

const history = [
  { id: 'a', lastActive: '2026-07-17 08:00', project: 'alpha', title: 'Alpha one', home: 'team' },
  { id: 'b', lastActive: '2026-07-16 22:00', project: 'alpha', title: 'Alpha two', home: 'personal' },
  { id: 'c', lastActive: '2026-07-10 12:00', project: 'beta', title: 'Beta task', home: null },
  { id: 'd', lastActive: '2026-06-01 09:00', project: 'win: old', title: 'Windows session', home: null },
];

test('merge joins live panes by agent session id and workspace label', () => {
  const model = mergeSidebarModel({
    historySessions: history,
    homes: { a: 'team', b: 'personal' },
    workspaces: [{ workspace_id: 'w1', label: 'alpha' }],
    livePanes: [{
      pane_id: 'p1',
      workspace_id: 'w1',
      agent_session: { kind: 'id', value: 'a', agent: 'claude', source: 'test' },
      terminal_title: 'Live alpha',
    }],
  });
  const alpha = model.projects.find((p) => p.label === 'alpha');
  assert.equal(alpha.sessions.find((s) => s.id === 'a').isLive, true);
  assert.equal(alpha.sessions.find((s) => s.id === 'a').paneId, 'p1');
  assert.ok(model.liveProjects.includes('alpha'));
});

test('merge dedupes by session id and sorts projects and sessions by last-active desc', () => {
  const model = mergeSidebarModel({ historySessions: history });
  assert.deepEqual(model.projects.map((p) => p.label), ['alpha', 'beta', 'win: old']);
  assert.deepEqual(model.projects[0].sessions.map((s) => s.id), ['a', 'b']);
});

test('merge defaults session providers to claude and preserves explicit providers', () => {
  const model = mergeSidebarModel({
    historySessions: [
      { id: 'claude-history', lastActive: '2026-07-17 08:00', project: 'alpha', title: 'Claude history' },
      { id: 'openai-history', lastActive: '2026-07-17 09:00', project: 'alpha', title: 'OpenAI history', provider: 'openai' },
    ],
    workspaces: [{ workspace_id: 'w1', label: 'beta' }],
    livePanes: [
      { pane_id: 'p1', workspace_id: 'w1', terminal_title: 'Unmatched live pane', agent_session: { kind: 'id', value: 'claude-live' } },
      { pane_id: 'p2', workspace_id: 'w1', terminal_title: 'Cursor live pane', provider: 'cursor', agent_session: { kind: 'id', value: 'cursor-live' } },
    ],
  });
  const sessions = model.projects.flatMap((project) => project.sessions);
  assert.equal(sessions.find((session) => session.id === 'claude-history').provider, 'claude');
  assert.equal(sessions.find((session) => session.id === 'openai-history').provider, 'openai');
  assert.equal(sessions.find((session) => session.id === 'claude-live').provider, 'claude');
  assert.equal(sessions.find((session) => session.id === 'cursor-live').provider, 'cursor');
});

test('merge keeps project grouping as the default', () => {
  const model = mergeSidebarModel({ historySessions: history });
  assert.equal(model.grouping, 'project');
  assert.deepEqual(model.projects.map((p) => p.label), ['alpha', 'beta', 'win: old']);
});

test('date grouping uses the 06:00 display day and orders days and sessions newest first', () => {
  const now = new Date(2026, 6, 18, 10, 0, 0);
  const model = mergeSidebarModel({
    grouping: 'date',
    now,
    historySessions: [
      { id: 'old', lastActive: '2026-07-16 20:00', project: 'beta', title: 'Old' },
      { id: 'y-late', lastActive: '2026-07-18 05:59', project: 'alpha', title: 'Before roll' },
      { id: 'today-old', lastActive: '2026-07-18 06:00', project: 'beta', title: 'At roll' },
      { id: 'today-new', lastActive: '2026-07-18 09:00', project: 'alpha', title: 'Newest' },
      { id: 'y-early', lastActive: '2026-07-17 07:00', project: 'gamma', title: 'Yesterday' },
    ],
  });
  assert.equal(model.grouping, 'date');
  assert.deepEqual(model.projects.map((p) => p.label), ['Today', 'Yesterday', 'Jul 16']);
  assert.deepEqual(model.projects[0].sessions.map((s) => s.id), ['today-new', 'today-old']);
  assert.deepEqual(model.projects[1].sessions.map((s) => s.id), ['y-late', 'y-early']);
  assert.equal(model.projects[0].isDateGroup, true);
});

test('date grouping search matches the session project and keeps child exclusion semantics', () => {
  const model = mergeSidebarModel({
    grouping: 'date',
    now: new Date(2026, 6, 18, 10, 0, 0),
    historySessions: [
      { id: 'normal', lastActive: '2026-07-18 08:00', project: 'harbor', title: 'Normal task' },
      { id: 'worker', lastActive: '2026-07-18 07:00', project: 'harbor', title: 'BATCH TITLE: Hidden worker' },
    ],
  });
  const filtered = filterProjects(model, { query: 'harbor' });
  assert.deepEqual(filtered.projects.flatMap((p) => p.sessions.map((s) => s.id)), ['normal', 'worker']);
  const hidden = flattenSidebarRows(filtered, {});
  assert.deepEqual(hidden.rows.filter((r) => r.kind === 'session').map((r) => r.session.id), ['normal']);
  const searching = flattenSidebarRows(filtered, { includeChildren: true });
  assert.deepEqual(searching.rows.filter((r) => r.kind === 'session').map((r) => r.session.id), ['normal', 'worker']);
});

test('regrouping a merged model preserves live metadata while switching modes', () => {
  const projectModel = mergeSidebarModel({
    now: new Date(2026, 6, 18, 10, 0, 0),
    historySessions: [{ id: 'live', lastActive: '2026-07-18 08:00', project: 'alpha', title: 'Running' }],
    workspaces: [{ workspace_id: 'workspace', label: 'alpha' }],
    livePanes: [{ pane_id: 'pane', workspace_id: 'workspace', agent_session: { kind: 'id', value: 'live' } }],
  });
  const dateModel = regroupSidebarModel(projectModel, { grouping: 'date', now: new Date(2026, 6, 18, 10, 0, 0) });
  assert.equal(dateModel.projects[0].label, 'Today');
  assert.equal(dateModel.projects[0].sessions[0].paneId, 'pane');
  assert.equal(dateModel.projects[0].sessions[0].isLive, true);
  assert.equal(dateModel.liveProjects[0], 'alpha');
});

test('owned sessions carry the daemon pane agent status', () => {
  const model = mergeSidebarModel({
    now: new Date(2026, 6, 18, 10, 0, 0),
    historySessions: [{ id: 'live', lastActive: '2026-07-18 08:00', project: 'alpha', title: 'Running' }],
    workspaces: [{ workspace_id: 'workspace', label: 'alpha' }],
    livePanes: [{
      pane_id: 'pane',
      workspace_id: 'workspace',
      agent_session: { kind: 'id', value: 'live' },
      agent_status: 'working',
    }],
  });
  assert.equal(model.projects[0].sessions[0].agentStatus, 'working');
});

test('date groups retain the 12-session older expander independently per day', () => {
  const historySessions = Array.from({ length: 14 }, (_, i) => ({
    id: `today-${i}`,
    lastActive: `2026-07-18 ${String(19 - i).padStart(2, '0')}:00`,
    project: i % 2 ? 'alpha' : 'beta',
    title: `Today ${i}`,
  })).concat({ id: 'yesterday', lastActive: '2026-07-17 12:00', project: 'alpha', title: 'Yesterday' });
  const model = mergeSidebarModel({ grouping: 'date', now: new Date(2026, 6, 18, 20, 0, 0), historySessions });
  const flattened = flattenSidebarRows(model);
  assert.equal(flattened.rows.filter((r) => r.kind === 'session' && r.project.label === 'Today').length, 12);
  assert.ok(flattened.rows.some((r) => r.kind === 'older' && r.project.label === 'Today' && r.hiddenCount === 2));
  assert.equal(flattened.rows.filter((r) => r.kind === 'session' && r.project.label === 'Yesterday').length, 1);
});

test('ESM and CommonJS sidebar model twins have identical logic bodies', () => {
  const shared = path.resolve(__dirname, '../../src/shared');
  const esm = fs.readFileSync(path.join(shared, 'sidebar-model.js'), 'utf8')
    .replace(/import \{([\s\S]*?)\} from '\.\/date-roll\.js';/, "const {$1} = require('./date-roll.cjs');")
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ')
    .trim();
  const cjs = fs.readFileSync(path.join(shared, 'sidebar-model.cjs'), 'utf8')
    .replace(/^'use strict';\n\n/, '')
    .replace(/\n\nmodule\.exports = \{[\s\S]*?\n\};\s*$/, '')
    .trim();
  assert.equal(cjs, esm);
});

test('filter applies 7d rolling window and search across project and title', () => {
  const model = mergeSidebarModel({ historySessions: history });
  // Pin "now" so this stays deterministic: the fixtures are fixed dates and a
  // real clock would drift beta out of the 7-day window over time.
  const now = new Date(2026, 6, 17, 0, 0, 0);
  const filtered = filterProjects(model, {
    filter: { kind: 'rolling', days: 7 },
    query: 'beta',
    now,
  });
  assert.equal(filtered.projects.length, 1);
  assert.equal(filtered.projects[0].label, 'beta');
});

test('rolling filter keeps stale live sessions and sorts retained sessions by recency', () => {
  const model = {
    projects: [{
      label: 'alpha',
      sessions: [
        { id: 'stale-live', project: 'alpha', title: 'Still running', lastActive: '2026-07-10 08:00', lastActiveMs: Date.parse('2026-07-10T08:00:00'), isLive: true },
        { id: 'recent', project: 'alpha', title: 'Recent', lastActive: '2026-07-18 09:00', lastActiveMs: Date.parse('2026-07-18T09:00:00'), isLive: false },
        { id: 'newest', project: 'alpha', title: 'Newest', lastActive: '2026-07-19 09:00', lastActiveMs: Date.parse('2026-07-19T09:00:00'), isLive: false },
        { id: 'stale-dead', project: 'alpha', title: 'Inactive', lastActive: '2026-07-16 07:59', lastActiveMs: Date.parse('2026-07-16T07:59:00'), isLive: false },
      ],
    }],
  };

  const filtered = filterProjects(model, {
    filter: { kind: 'rolling', days: 2 },
    now: new Date(2026, 6, 19, 8, 0, 0),
  });

  assert.deepEqual(filtered.projects[0].sessions.map((session) => session.id), [
    'newest',
    'recent',
    'stale-live',
  ]);
  assert.equal(filtered.projects[0].hasLive, true);
});

test('project with only live sessions in the filtered view retains its historical cwd anchor', () => {
  const model = mergeSidebarModel({
    now: new Date(2026, 6, 20, 12, 0, 0),
    historySessions: emitRows(
      'historical\t2026-07-01 08:00\tdev\tOld transcript\t\t/home/you/dev',
    ),
    workspaces: [{ workspace_id: 'workspace', label: 'dev', cwd: '/home/you/dev' }],
    livePanes: [{
      pane_id: 'pane', workspace_id: 'workspace', terminal_title: 'Live only',
      agent_session: { kind: 'id', value: 'unindexed-live' },
    }],
  });

  const filtered = filterProjects(model, {
    filter: { kind: 'rolling', days: 2 },
    now: new Date(2026, 6, 20, 12, 0, 0),
  });

  assert.deepEqual(filtered.projects[0].sessions.map((session) => session.id), ['unindexed-live']);
  assert.equal(filtered.projects[0].newSessionCwd, '/home/you/dev');
});

test('project whose historical sessions are filtered out retains its full-corpus cwd anchor', () => {
  const model = mergeSidebarModel({
    historySessions: emitRows(
      'recent\t2026-07-20 10:00\twiki\tRecent\t\t',
      'old\t2026-06-01 10:00\twiki\tOld\t\t/home/you/Documents/Notes/Wiki',
    ),
  });

  const filtered = filterProjects(model, {
    filter: { kind: 'rolling', days: 2 },
    now: new Date(2026, 6, 20, 12, 0, 0),
  });

  assert.deepEqual(filtered.projects[0].sessions.map((session) => session.id), ['recent']);
  assert.equal(filtered.projects[0].newSessionCwd, '/home/you/Documents/Notes/Wiki');
});

test('all-live project falls back to resolvable workspace cwd and never invents one', () => {
  const model = mergeSidebarModel({
    workspaces: [
      { workspace_id: 'resolved', label: 'resolved-live', cwd: '/home/you/dev/resolved-live' },
      { workspace_id: 'unresolved', label: 'unresolved-live' },
    ],
    livePanes: [
      { pane_id: 'resolved-pane', workspace_id: 'resolved', agent_session: { kind: 'id', value: 'resolved-agent' } },
      { pane_id: 'unresolved-pane', workspace_id: 'unresolved', agent_session: { kind: 'id', value: 'unresolved-agent' } },
    ],
  });

  assert.equal(model.projects.find((project) => project.label === 'resolved-live').newSessionCwd, '/home/you/dev/resolved-live');
  assert.equal(model.projects.find((project) => project.label === 'unresolved-live').newSessionCwd, null);
});

test('date groups remain without project-scoped new-session cwd anchors', () => {
  const model = mergeSidebarModel({
    grouping: 'date',
    now: new Date(2026, 6, 20, 12, 0, 0),
    historySessions: emitRows(
      'dated\t2026-07-20 10:00\tdev\tDated\t\t/home/you/dev',
    ),
  });

  assert.equal(model.projects[0].isDateGroup, true);
  assert.equal(model.projects[0].newSessionCwd, null);
});

test('search matches the raw first prompt even when the title is generated', () => {
  const model = mergeSidebarModel({
    historySessions: [
      {
        id: 'g',
        lastActive: '2026-07-17 09:00',
        project: 'gamma',
        title: 'Fix sidebar tab focus bug',
        firstPrompt: 'the herdr pane focuses the wrong tab when I dblclick',
        home: 'team',
      },
    ],
  });
  const byTitle = filterProjects(model, { query: 'tab focus' });
  assert.equal(byTitle.projects.length, 1);
  const byPrompt = filterProjects(model, { query: 'dblclick' });
  assert.equal(byPrompt.projects.length, 1, 'first-prompt text still searchable');
  const miss = filterProjects(model, { query: 'nonexistent-needle' });
  assert.equal(miss.projects.length, 0);
});

test('today filter respects 06:00 display day at 05:30', () => {
  const model = mergeSidebarModel({ historySessions: history });
  const now = new Date(2026, 6, 17, 5, 30, 0);
  const cutoff = cutoffForFilter({ kind: 'today' }, now);
  const filtered = filterProjects(model, { filter: { kind: 'today' }, now });
  const keptIds = filtered.projects.flatMap((p) => p.sessions.map((s) => s.id));
  assert.ok(keptIds.includes('b'));
  assert.ok(!keptIds.includes('c'));
  assert.ok(cutoff.getDate() === 16);
});

test('search matches project label without matching title', () => {
  const model = mergeSidebarModel({ historySessions: history });
  const filtered = filterProjects(model, { query: 'win:' });
  assert.equal(filtered.projects.length, 1);
  assert.equal(filtered.projects[0].label, 'win: old');
});

test('flatten emits older expander after default visible cap', () => {
  const sessions = Array.from({ length: 14 }, (_, i) => ({
    id: `s${i}`,
    project: 'alpha',
    title: `Title ${i}`,
    lastActive: `2026-07-${String(17 - i).padStart(2, '0')} 10:00`,
    lastActiveMs: Date.parse(`2026-07-${String(17 - i).padStart(2, '0')}T10:00:00`),
    isLive: false,
    isWindowsEra: false,
  }));
  const model = {
    projects: [{
      label: 'alpha',
      sessions,
      sessionCount: sessions.length,
      lastActiveMs: sessions[0].lastActiveMs,
      hasLive: false,
      isWindowsEra: false,
    }],
  };
  const collapsed = flattenSidebarRows(model, {
    collapsedProjects: new Set(),
    expandedOlder: new Set(),
    liveProjects: [],
  });
  assert.ok(collapsed.rows.some((row) => row.kind === 'older'));
  assert.equal(collapsed.sessionRowCount, 12);
  const expanded = flattenSidebarRows(model, {
    collapsedProjects: new Set(),
    expandedOlder: new Set(['alpha']),
    liveProjects: [],
  });
  assert.equal(expanded.sessionRowCount, 14);
  assert.ok(!expanded.rows.some((row) => row.kind === 'older'));
});

test('windows-era sessions are flagged', () => {
  assert.equal(isWindowsEra('win: example-app'), true);
  assert.equal(isWindowsEra('example-app'), false);
});

test('child-task detection keys on the BATCH TITLE prefix', () => {
  assert.equal(isChildTask('BATCH TITLE: Do a thing FINDING IDS: X'), true);
  assert.equal(isChildTask('  BATCH TITLE: leading space'), true);
  assert.equal(isChildTask('Just a normal session'), false);
  assert.equal(isChildTask(''), false);
  assert.equal(isChildTask(null), false);
});

test('child-task title strips the prefix and trailing batch metadata', () => {
  assert.equal(
    childTaskTitle('BATCH TITLE: Notes census isolation (P1) FINDING IDS: C-2 PRIORITY: P1 GOAL: stop it'),
    'Notes census isolation (P1)',
  );
  assert.equal(childTaskTitle('BATCH TITLE: No markers here'), 'No markers here');
  // Non-child titles pass through untouched.
  assert.equal(childTaskTitle('regular title'), 'regular title');
});

test('merge tags child-task sessions from their title', () => {
  const model = mergeSidebarModel({
    historySessions: [
      { id: 'w1', lastActive: '2026-07-17 06:00', project: 'example-app', title: 'BATCH TITLE: Do X FINDING IDS: A', home: 'team' },
      { id: 'n1', lastActive: '2026-07-17 07:00', project: 'example-app', title: 'Pat started this', home: 'team' },
    ],
  });
  const proj = model.projects.find((p) => p.label === 'example-app');
  const w1 = proj.sessions.find((s) => s.id === 'w1');
  const n1 = proj.sessions.find((s) => s.id === 'n1');
  assert.equal(w1.isChildTask, true);
  assert.equal(w1.childTitle, 'Do X');
  assert.equal(n1.isChildTask, false);
  assert.equal(n1.childTitle, null);
});

function projectWithChildren() {
  const sessions = [
    { id: 'n1', project: 'p', title: 'Normal one', lastActiveMs: 100, isLive: false, isWindowsEra: false, isChildTask: false },
    { id: 'w1', project: 'p', title: 'BATCH TITLE: A', childTitle: 'A', lastActiveMs: 90, isLive: false, isWindowsEra: false, isChildTask: true },
    { id: 'w2', project: 'p', title: 'BATCH TITLE: B', childTitle: 'B', lastActiveMs: 80, isLive: false, isWindowsEra: false, isChildTask: true },
  ];
  return { projects: [{ label: 'p', sessions, sessionCount: sessions.length, lastActiveMs: 100, hasLive: false, isWindowsEra: false }] };
}

test('flatten excludes orchestration child tasks from the browser by default', () => {
  const { rows, sessionRowCount } = flattenSidebarRows(projectWithChildren(), {});
  assert.ok(!rows.some((r) => r.kind === 'child-group'), 'no child-group node');
  assert.ok(!rows.some((r) => r.kind === 'session' && r.session.isChildTask), 'no BATCH session rows inline');
  assert.equal(sessionRowCount, 1); // only the one non-child session
  assert.equal(rows.find((r) => r.kind === 'project').hasChildren, true, 'project flags it has workers');
});

test('flatten includes child tasks when includeChildren (search) is set', () => {
  const { rows, sessionRowCount } = flattenSidebarRows(projectWithChildren(), { includeChildren: true });
  const childRows = rows.filter((r) => r.kind === 'session' && r.session.isChildTask);
  assert.equal(childRows.length, 2);
  assert.equal(sessionRowCount, 3);
  assert.deepEqual(childRows.map((r) => r.session.id), ['w1', 'w2']);
});

test('a live child task is also excluded from the browser by default', () => {
  const model = projectWithChildren();
  model.projects[0].sessions[1].isLive = true; // w1 is now running
  const { rows } = flattenSidebarRows(model, {});
  assert.ok(!rows.some((r) => r.kind === 'session' && r.session.isChildTask), 'no BATCH row, live or not');
});

test('the visible cap counts regular sessions only; children never appear by default', () => {
  const sessions = [];
  for (let i = 0; i < 14; i += 1) {
    sessions.push({ id: `n${i}`, project: 'p', title: `N${i}`, lastActiveMs: 1000 - i, isLive: false, isWindowsEra: false, isChildTask: false });
  }
  for (let i = 0; i < 5; i += 1) {
    sessions.push({ id: `w${i}`, project: 'p', title: `BATCH TITLE: W${i}`, childTitle: `W${i}`, lastActiveMs: 500 - i, isLive: false, isWindowsEra: false, isChildTask: true });
  }
  const model = { projects: [{ label: 'p', sessions, sessionCount: sessions.length, lastActiveMs: 1000, hasLive: false, isWindowsEra: false }] };
  const { rows, sessionRowCount } = flattenSidebarRows(model, {});
  assert.equal(sessionRowCount, 12); // 12 of the 14 regulars; children excluded
  assert.ok(rows.some((r) => r.kind === 'older' && r.hiddenCount === 2));
  assert.ok(!rows.some((r) => r.kind === 'child-group'), 'no child-group');
  assert.ok(!rows.some((r) => r.kind === 'session' && r.session.isChildTask), 'no child rows');
});

test('a project with a live session can still be manually collapsed (regression)', () => {
  const model = {
    projects: [{
      label: 'live-proj',
      sessions: [{ id: 's1', title: 'running', isLive: true, home: 'team', isWindowsEra: false, isChildTask: false }],
      sessionCount: 1,
      lastActiveMs: 1000,
      hasLive: true,
      isWindowsEra: false,
    }],
    liveProjects: ['live-proj'],
  };
  // Default (not collapsed) shows the session.
  const expanded = flattenSidebarRows(model, { collapsedProjects: new Set(), liveProjects: ['live-proj'] });
  assert.ok(expanded.rows.some((r) => r.kind === 'session'), 'expanded live project shows its session');
  // The user explicitly collapsing it MUST win, even though it has a live session
  // (previously the caret was a dead button on any running project).
  const collapsed = flattenSidebarRows(model, { collapsedProjects: new Set(['live-proj']), liveProjects: ['live-proj'] });
  assert.equal(collapsed.rows.find((r) => r.kind === 'project').collapsed, true, 'live project collapses on user toggle');
  assert.ok(!collapsed.rows.some((r) => r.kind === 'session'), 'no session rows while collapsed');
});

test('live pane provider comes from the herdr-detected agent, never defaults codex/cursor to claude', () => {
  const { paneProvider } = require('../../src/shared/sidebar-model.cjs');
  assert.equal(paneProvider({ agent: 'claude' }), 'claude');
  assert.equal(paneProvider({ agent: 'codex' }), 'codex');
  assert.equal(paneProvider({ agent: 'cursor' }), 'cursor');
  assert.equal(paneProvider({ agent: 'cursor-agent' }), 'cursor');
  assert.equal(paneProvider({ agent: 'CODEX' }), 'codex', 'case-insensitive');
  assert.equal(paneProvider({}), 'claude', 'no agent facts: claude default stands');
  assert.equal(paneProvider({ provider: 'codex', agent: 'claude' }), 'codex', 'explicit provider wins');

  const model = mergeSidebarModel({
    historySessions: [],
    livePanes: [{
      pane_id: 'w9:p1',
      workspace_id: 'w9',
      agent: 'codex',
      agent_session: null,
      agent_status: 'idle',
      terminal_title: 'Wiki',
    }],
    workspaces: [{ workspace_id: 'w9', label: 'wiki', cwd: '/home/user/wiki' }],
    homes: {},
  });
  const session = model.projects.flatMap((p) => p.sessions)[0];
  assert.equal(session.provider, 'codex', 'live codex pane rows carry provider codex');
});

test('provider history rows merge like claude rows and keep their provider', () => {
  const model = mergeSidebarModel({
    historySessions: [
      { id: 'aaaa', lastActive: '2026-07-24 10:00', project: 'widget', title: 'Fix tests', firstPrompt: 'Fix', cwd: '/w', provider: 'codex' },
      { id: 'bbbb', lastActive: '2026-07-24 11:00', project: 'widget', title: 'Review auth', firstPrompt: 'Review', cwd: '/w', provider: 'cursor' },
    ],
    livePanes: [],
    workspaces: [],
    homes: {},
  });
  const sessions = model.projects.flatMap((p) => p.sessions);
  assert.deepEqual(sessions.map((s) => s.provider).sort(), ['codex', 'cursor']);
  assert.ok(sessions.every((s) => s.isHistorical), 'provider rows are reopenable history');
});

// The rail's Orch chip used to be gated on the P/T/S launch anchor, which
// requires a DEAD session because it carries the home a new session inherits.
// Orchestration only needs a project root, so that gate hid the chip from every
// project whose sessions were all live (live-caught 2026-07-25: Pat's
// NOTES/WIKI group had one session and it was running).
test('a project root resolves from a LIVE session, so an all-live project still gets Orch', () => {
  const allLive = { sessions: [
    { id: 'live:w4:p1', isLive: true },
    { id: 'aaaa-1111', isLive: true },
  ] };
  assert.equal(projectRootSessionId(allLive), 'aaaa-1111');
});

test('a project root never resolves to a live: pane row, which holds no session id', () => {
  assert.equal(projectRootSessionId({ sessions: [{ id: 'live:w4:p1', isLive: true }] }), null);
  assert.equal(projectRootSessionId({ sessions: [{ id: 'bbbb-2222', isWindowsEra: true }] }), null);
  assert.equal(projectRootSessionId({ sessions: [] }), null);
  assert.equal(projectRootSessionId(undefined), null);
});

test('the rail gates Orch on the project root, not on the dead-session launch anchor', () => {
  const orchLine = sidebarSource.split('\n').find((line) => line.includes('const canOrch'));
  assert.ok(orchLine, 'canOrch still exists');
  assert.ok(
    /projectRootSessionId/.test(sidebarSource.slice(sidebarSource.indexOf('const canOrch'), sidebarSource.indexOf('const canOrch') + 260)),
    'canOrch resolves the root itself',
  );
  assert.ok(
    !/const canOrch[\s\S]{0,200}newSessionId/.test(sidebarSource),
    'canOrch no longer depends on the dead-session anchor',
  );
});

// Throwaway working directories are not projects. The batch-1..13 port
// orchestration put about a dozen dead lane worktrees in Pat's rail as top-level
// projects; these are the rules that keep them out without making any session
// unreachable.

test('a delegate lane worktree is not a project in the rail', () => {
  const model = mergeSidebarModel({
    now: new Date(2026, 6, 29, 10, 0, 0),
    historySessions: [
      { id: 'real', lastActive: '2026-07-29 09:00', project: 'harbor', title: 'Real work' },
      {
        id: 'lane',
        lastActive: '2026-07-29 08:00',
        project: 'claude-delegate-lanes-wza1m_a9/lane-batch-11',
        cwd: '/tmp/claude-delegate-lanes-wza1m_a9/lane-batch-11',
        title: 'Cross-platform bin/',
      },
    ],
  });
  const filtered = filterProjects(model, {});
  assert.deepEqual(filtered.projects.map((p) => p.label), ['harbor']);
});

test('searching re-includes a lane, so nothing becomes unreachable', () => {
  const model = mergeSidebarModel({
    now: new Date(2026, 6, 29, 10, 0, 0),
    historySessions: [{
      id: 'lane',
      lastActive: '2026-07-29 08:00',
      project: 'claude-delegate-lanes-wza1m_a9/lane-batch-11',
      cwd: '/tmp/claude-delegate-lanes-wza1m_a9/lane-batch-11',
      title: 'Cross-platform bin/',
    }],
  });
  assert.deepEqual(filterProjects(model, { query: 'lane-batch' }).projects.map((p) => p.label),
    ['claude-delegate-lanes-wza1m_a9/lane-batch-11']);
  assert.deepEqual(filterProjects(model, { query: 'cross-platform' }).projects.map((p) => p.label),
    ['claude-delegate-lanes-wza1m_a9/lane-batch-11']);
});

test('a cursor lane row is recognized from its munged label, having no cwd at all', () => {
  // cursor never records a cwd, so when the temp dir is gone the munged project
  // dir name is the only evidence left. These rows cannot even be resumed.
  assert.equal(isScratchProject({ label: 'tmp-claude-delegate-lanes-wm4md8e0-lane-batch-8', cwd: null }), true);
  assert.equal(isScratchProject({ label: 'TMP-CLAUDE-DELEGATE-LANES-X', cwd: null }), true);
});

test('probe directories and application state directories are not projects', () => {
  assert.equal(isScratchProject({ label: 'tmp/cardprobe', cwd: '/tmp/cardprobe' }), true);
  assert.equal(isScratchProject({ label: 'tmp/dlgprobe' }), true);
  assert.equal(isScratchProject({ label: '.gameclient', cwd: '/home/someone/.gameclient' }), true);
  assert.equal(isScratchProject({ label: 'scratchpad', cwd: '/tmp/claude-1000/x/scratchpad' }), true);
  assert.equal(isScratchProject({ label: 'x', cwd: '/var/tmp/x' }), true);
  assert.equal(isScratchProject({ label: 'x', cwd: 'C:\\Users\\pat\\AppData\\Local\\Temp\\x' }), true);
});

test('real projects are never mistaken for scratch, including near-miss names', () => {
  for (const project of [
    { label: 'harbor', cwd: '/home/someone/dev/harbor' },
    { label: 'Report-Builder', cwd: '/home/someone/dev/Report-Builder' },
    { label: 'Notes/Wiki', cwd: '/home/someone/Documents/Notes/Wiki' },
    { label: '~', cwd: '/home/someone' },
    { label: 'example-chatbot/example-chatbot' },
    // Anchored patterns: a real project may legitimately start with 'tmp' or
    // carry 'temp' inside a segment.
    { label: 'tmpl-engine', cwd: '/home/someone/dev/tmpl-engine' },
    { label: 'template-lab', cwd: '/home/someone/dev/template-lab' },
    { label: 'dev/contemplate', cwd: '/home/someone/dev/contemplate' },
  ]) {
    assert.equal(isScratchProject(project), false, `${project.label} must stay a project`);
  }
  assert.equal(isScratchProject({}), false);
  assert.equal(isScratchProject(), false);
});

test('a LIVE session in a temp directory is never hidden', () => {
  // An invisible running agent is a dead end: the rail is the only browser, so
  // liveness outranks the tidiness rule no matter where the agent runs.
  const model = {
    projects: [{
      label: 'tmp/cardprobe',
      sessions: [{
        id: 'live-probe',
        project: 'tmp/cardprobe',
        cwd: '/tmp/cardprobe',
        title: 'Running right now',
        isLive: true,
        lastActive: '2026-07-29 09:00',
        lastActiveMs: new Date(2026, 6, 29, 9, 0, 0).getTime(),
      }],
    }],
  };
  const filtered = filterProjects(model, {});
  assert.deepEqual(filtered.projects.map((p) => p.label), ['tmp/cardprobe']);
  assert.equal(isScratchSession(model.projects[0].sessions[0]), false);
});

test('under date grouping the rule hides the scratch session, not the whole day', () => {
  const model = mergeSidebarModel({
    grouping: 'date',
    now: new Date(2026, 6, 29, 10, 0, 0),
    historySessions: [
      { id: 'real', lastActive: '2026-07-29 09:00', project: 'harbor', title: 'Real work' },
      {
        id: 'lane',
        lastActive: '2026-07-29 08:30',
        project: 'claude-delegate-lanes-x/lane-batch-1',
        cwd: '/tmp/claude-delegate-lanes-x/lane-batch-1',
        title: 'Worker',
      },
    ],
  });
  const filtered = filterProjects(model, {});
  assert.equal(filtered.projects.length, 1, 'the day group survives');
  assert.deepEqual(filtered.projects[0].sessions.map((s) => s.id), ['real']);
});
