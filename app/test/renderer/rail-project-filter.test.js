'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  railProjectLabel,
  normalizeProjectFilter,
  projectFilterOptions,
  matchProjectOptions,
  toggleProjectFilter,
  applyProjectFilter,
  projectFilterLabel,
} = require('../../src/renderer/sidebar/project-filter.cjs');
const { regroupSidebarModel, ORCHESTRATION_PROJECT } = require('../../src/shared/sidebar-model.cjs');

function session(id, project, { ms = 1000, cwd = null, isLive = false } = {}) {
  return { id, title: id, project, cwd, lastActiveMs: ms, lastActive: null, isLive, isChildTask: false };
}

function modelOf(sessions) {
  const byProject = new Map();
  for (const s of sessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project).push(s);
  }
  return {
    projects: [...byProject.entries()].map(([label, group]) => ({
      label,
      sessions: group,
      sessionCount: group.length,
      lastActiveMs: group.reduce((max, s) => Math.max(max, s.lastActiveMs), 0),
      hasLive: group.some((s) => s.isLive),
      isDateGroup: false,
    })),
    liveProjects: [],
  };
}

const HARBOR = session('h1', 'harbor', { ms: 500 });
const HARBOR2 = session('h2', 'harbor', { ms: 400, isLive: true });
const NOTES = session('n1', 'notes', { ms: 300 });
// The real shape of an orchestration research workspace under the app cache,
// with a PLACEHOLDER user: the segment is what classifies it, not whose home it
// sits in, and test/repo/no-third-parties keeps real usernames out of the tree.
const ORCH = session('o1', 'orch-research-0825', { cwd: 'C:\\Users\\user\\.cache\\harbor\\orch-research-0825', ms: 200 });

test('normalize drops junk and de-duplicates', () => {
  assert.deepEqual(normalizeProjectFilter(['a', 'a', '', null, 7, 'b']), ['a', 'b']);
  assert.deepEqual(normalizeProjectFilter('harbor'), []);
  assert.deepEqual(normalizeProjectFilter(undefined), []);
});

// The rail collapses orchestration debris into one group; offering forty
// scratch worktrees the rail refuses to show as projects would be a menu of
// choices that filter to nothing.
test('an orchestration session is offered under the one name the rail shows', () => {
  assert.equal(railProjectLabel(ORCH), ORCHESTRATION_PROJECT);
  assert.equal(railProjectLabel(HARBOR), 'harbor');
  assert.equal(railProjectLabel({}), '~');
});

// The proof that matters: the option label must equal the label the rail's own
// grouping produced, or selecting it filters to an empty rail.
test('every option label is a label the rail actually groups under', () => {
  const grouped = regroupSidebarModel(modelOf([HARBOR, NOTES, ORCH]), { grouping: 'project' });
  const groupLabels = new Set(grouped.projects.map((p) => p.label));
  for (const option of projectFilterOptions(grouped)) {
    assert.ok(groupLabels.has(option.label), `${option.label} is a real rail group`);
  }
  assert.ok(groupLabels.has(ORCHESTRATION_PROJECT));
});

test('options are alphabetical and carry the count of the current window', () => {
  const options = projectFilterOptions(modelOf([HARBOR, HARBOR2, NOTES]));
  assert.deepEqual(options, [
    { label: 'harbor', count: 2 },
    { label: 'notes', count: 1 },
  ]);
});

// A selection that vanished from its own menu could never be un-selected.
test('a selected project is always listed, even at zero in this window', () => {
  const options = projectFilterOptions(modelOf([HARBOR]), { selected: ['notes'] });
  assert.deepEqual(options, [
    { label: 'harbor', count: 1 },
    { label: 'notes', count: 0 },
  ]);
});

test('the menu search matches on a substring, case-insensitively', () => {
  const options = projectFilterOptions(modelOf([HARBOR, NOTES]));
  assert.deepEqual(matchProjectOptions(options, 'HAR').map((o) => o.label), ['harbor']);
  assert.deepEqual(matchProjectOptions(options, '  ').map((o) => o.label), ['harbor', 'notes']);
  assert.deepEqual(matchProjectOptions(options, 'zzz'), []);
});

test('toggling adds then removes, without mutating the previous selection', () => {
  const first = ['harbor'];
  const second = toggleProjectFilter(first, 'notes');
  assert.deepEqual(second, ['harbor', 'notes']);
  assert.deepEqual(first, ['harbor'], 'the previous array is left alone');
  assert.deepEqual(toggleProjectFilter(second, 'harbor'), ['notes']);
});

test('an empty selection means EVERY project and returns the model untouched', () => {
  const model = modelOf([HARBOR, NOTES]);
  assert.equal(applyProjectFilter(model, []), model);
  assert.equal(applyProjectFilter(model, undefined), model);
});

test('a selection keeps only the chosen projects and drops emptied groups', () => {
  const filtered = applyProjectFilter(modelOf([HARBOR, HARBOR2, NOTES, ORCH]), ['harbor']);
  assert.deepEqual(filtered.projects.map((p) => p.label), ['harbor']);
  assert.deepEqual(filtered.projects[0].sessions.map((s) => s.id), ['h1', 'h2']);
});

test('several projects can be selected at once', () => {
  const filtered = applyProjectFilter(modelOf([HARBOR, NOTES, ORCH]), ['harbor', 'notes']);
  assert.deepEqual(filtered.projects.map((p) => p.label), ['harbor', 'notes']);
});

// Under DATE grouping one group holds several projects, so a per-group test
// would answer this wrong in half the rail's modes.
test('filtering works per session, so DATE grouping narrows correctly too', () => {
  const grouped = regroupSidebarModel(modelOf([HARBOR, NOTES]), { grouping: 'date' });
  assert.equal(grouped.projects.length, 1, 'one day group holding both projects');
  const filtered = applyProjectFilter(grouped, ['harbor']);
  assert.equal(filtered.projects.length, 1);
  assert.deepEqual(filtered.projects[0].sessions.map((s) => s.id), ['h1']);
  assert.equal(filtered.projects[0].sessionCount, 1, 'the day group re-counts what survived');
});

// The header would otherwise go on claiming a live session, or a clock, that
// the filter just removed.
test('a filtered group re-derives its own facts', () => {
  const model = modelOf([HARBOR, HARBOR2, NOTES]);
  const both = model.projects.find((p) => p.label === 'harbor');
  assert.equal(both.hasLive, true);
  const filtered = applyProjectFilter(
    { projects: [{ ...both, sessions: [HARBOR, HARBOR2, NOTES], sessionCount: 3 }] },
    ['notes'],
  );
  assert.equal(filtered.projects[0].sessionCount, 1);
  assert.equal(filtered.projects[0].hasLive, false, 'the live session is gone, so the group is not live');
  assert.equal(filtered.projects[0].lastActiveMs, 300, 'the clock follows what survived');
});

test('the trigger names one project, counts several, and is honest about none', () => {
  assert.equal(projectFilterLabel([]), 'All projects');
  assert.equal(projectFilterLabel(['harbor']), 'harbor');
  assert.equal(projectFilterLabel(['harbor', 'notes']), '2 projects');
});

// ── Selected projects float to the top when the menu opens ────────────────

const { orderProjectOptions } = require('../../src/renderer/sidebar/project-filter.cjs');

test('picked projects sort to the top, alphabetical within each half', () => {
  const options = [
    { label: 'alpha', count: 1 },
    { label: 'beta', count: 2 },
    { label: 'gamma', count: 3 },
    { label: 'delta', count: 4 },
  ];
  assert.deepEqual(
    orderProjectOptions(options, ['gamma', 'beta']).map((o) => o.label),
    ['beta', 'gamma', 'alpha', 'delta'],
    'the two picked lead, and neither half is otherwise reshuffled',
  );
});

test('nothing picked leaves the list exactly as it was', () => {
  const options = [{ label: 'alpha', count: 1 }, { label: 'beta', count: 2 }];
  assert.equal(orderProjectOptions(options, []), options, 'same array, so the menu does not re-render for nothing');
  assert.equal(orderProjectOptions(options), options);
});

// The pin is captured at OPEN and held: a label that is no longer in the list
// must not be able to blank the ordering or drop a row.
test('a pinned label that is not among the options changes nothing', () => {
  const options = [{ label: 'alpha', count: 1 }, { label: 'beta', count: 2 }];
  assert.equal(orderProjectOptions(options, ['ghost']), options);
  assert.deepEqual(
    orderProjectOptions(options, ['ghost', 'beta']).map((o) => o.label),
    ['beta', 'alpha'],
  );
});

test('ordering never mutates the options it was given', () => {
  const options = [{ label: 'alpha', count: 1 }, { label: 'beta', count: 2 }];
  orderProjectOptions(options, ['beta']);
  assert.deepEqual(options.map((o) => o.label), ['alpha', 'beta']);
});
