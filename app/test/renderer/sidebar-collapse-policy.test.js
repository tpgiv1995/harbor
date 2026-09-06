'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collapseForView } = require('../../src/renderer/sidebar/collapse-policy.cjs');
const { flattenSidebarRows } = require('../../src/shared/sidebar-model.cjs');

// The rail's resting state is the 48h chip, NOT "All": Sidebar.jsx seeds
// `useState({ kind: 'rolling', days: 2 })`. The old rule keyed collapse off
// `narrowing = searching || timeFilterActive`, and `timeFilterActive` is TRUE
// for every chip except All, so the default view passed an EMPTY set to
// flattenSidebarRows and the caret was dead everywhere Pat actually lives.
// Reported 2026-08-08: "projects are not collapsing in side panel".
const DEFAULT_FILTER = { kind: 'rolling', days: 2 };

function timeFilterActiveFor(filter, customSince = '') {
  // Copied verbatim from Sidebar.jsx so the fixture cannot drift from the
  // component's own reading of the chips.
  return filter.kind !== 'all' && !(filter.kind === 'since' && !customSince);
}

function modelWith(label) {
  return {
    projects: [{
      label,
      sessions: [
        { id: 's1', title: 'one', home: 'team', isLive: false, isWindowsEra: false, isChildTask: false },
        { id: 's2', title: 'two', home: 'team', isLive: false, isWindowsEra: false, isChildTask: false },
      ],
      sessionCount: 2,
      lastActiveMs: 1000,
      hasLive: false,
      isWindowsEra: false,
    }],
    liveProjects: [],
  };
}

function sessionRowsFor(collapsedProjects) {
  const { rows } = flattenSidebarRows(modelWith('alpha'), {
    collapsedProjects,
    expandedOlder: new Set(),
    liveProjects: [],
  });
  return rows.filter((row) => row.kind === 'session').length;
}

test('a collapsed project stays collapsed under the DEFAULT 48h filter', () => {
  const timeFilterActive = timeFilterActiveFor(DEFAULT_FILTER);
  assert.equal(timeFilterActive, true, 'the default chip is a time filter, which is the whole trap');

  const applied = collapseForView({
    collapsedProjects: new Set(['alpha']),
    searching: false,
    timeFilterActive,
  });

  assert.ok(applied.has('alpha'), 'the default view must carry the collapse through');
  assert.equal(sessionRowsFor(applied), 0, 'collapsing hides every session in the project');
});

test('every time chip respects collapse, not just All', () => {
  const chips = [
    { kind: 'today' },
    { kind: 'rolling', days: 2 },
    { kind: 'rolling', days: 7 },
    { kind: 'rolling', days: 30 },
    { kind: 'all' },
  ];
  for (const filter of chips) {
    const applied = collapseForView({
      collapsedProjects: new Set(['alpha']),
      searching: false,
      timeFilterActive: timeFilterActiveFor(filter),
    });
    assert.ok(applied.has('alpha'), `collapse must survive the ${filter.kind} chip`);
    assert.equal(sessionRowsFor(applied), 0, `sessions hidden under the ${filter.kind} chip`);
  }
});

// The other side of the proof. The original guard existed for a real reason and
// must survive: a search hit buried inside a collapsed project is
// indistinguishable from no hit at all, so a QUERY still flattens collapse.
// Without this half, "just delete the guard" would pass the tests above.
test('an active search still ignores collapse, so no match can hide', () => {
  const applied = collapseForView({
    collapsedProjects: new Set(['alpha']),
    searching: true,
    timeFilterActive: true,
  });

  assert.equal(applied.size, 0, 'searching flattens collapse');
  assert.equal(sessionRowsFor(applied), 2, 'every matching session stays visible while searching');
});

test('searching wins even with no time filter at all', () => {
  const applied = collapseForView({
    collapsedProjects: new Set(['alpha']),
    searching: true,
    timeFilterActive: false,
  });
  assert.equal(applied.size, 0);
});

test('the caller\'s set is never mutated', () => {
  const original = new Set(['alpha']);
  collapseForView({ collapsedProjects: original, searching: true, timeFilterActive: true });
  assert.ok(original.has('alpha'), 'flattening for a search must not clear the stored collapse');
});

// ── The one-button collapse-all / expand-all (Pat, 2026-08-25) ──────────────

const { planCollapseAll } = require('../../src/renderer/sidebar/collapse-policy.cjs');

const projectsNamed = (...labels) => labels.map((label) => ({ label }));

test('with anything expanded, the button offers to collapse', () => {
  const plan = planCollapseAll({
    projects: projectsNamed('alpha', 'beta'),
    collapsedProjects: new Set(['alpha']),
  });
  assert.equal(plan.action, 'collapse');
  assert.deepEqual([...plan.next].sort(), ['alpha', 'beta']);
});

test('with everything collapsed, the same button offers to expand', () => {
  const plan = planCollapseAll({
    projects: projectsNamed('alpha', 'beta'),
    collapsedProjects: new Set(['alpha', 'beta']),
  });
  assert.equal(plan.action, 'expand');
  assert.equal(plan.next.size, 0);
});

// Expanding what you cannot see is not what the button offered: a project
// narrowed out by a time chip or the project filter keeps its own collapse.
test('expand-all only touches the projects currently in view', () => {
  const plan = planCollapseAll({
    projects: projectsNamed('alpha'),
    collapsedProjects: new Set(['alpha', 'offscreen']),
  });
  assert.equal(plan.action, 'expand');
  assert.deepEqual([...plan.next], ['offscreen'], 'the out-of-view collapse survives');
});

test('collapse-all is additive and never expands something', () => {
  const plan = planCollapseAll({
    projects: projectsNamed('alpha'),
    collapsedProjects: new Set(['offscreen']),
  });
  assert.deepEqual([...plan.next].sort(), ['alpha', 'offscreen']);
});

// The dead-control failure this codebase already paid for once: a search
// flattens collapse for the view, so a collapse-all pressed mid-search would
// store a set that changes nothing on screen.
test('the button is disabled, with a reason, while a search is running', () => {
  const plan = planCollapseAll({
    projects: projectsNamed('alpha'),
    collapsedProjects: new Set(),
    searching: true,
  });
  assert.equal(plan.disabled, true);
  assert.match(plan.reason, /clear it/i);
  assert.equal(collapseForView({ collapsedProjects: plan.next, searching: true }).size, 0,
    'and the view would indeed ignore whatever it stored');
});

test('an empty rail disables the button rather than offering a no-op', () => {
  const plan = planCollapseAll({ projects: [], collapsedProjects: new Set() });
  assert.equal(plan.disabled, true);
  assert.equal(plan.projectCount, 0);
});

test('the caller\u2019s collapse set is never mutated', () => {
  const original = new Set(['alpha']);
  planCollapseAll({ projects: projectsNamed('alpha', 'beta'), collapsedProjects: original });
  assert.deepEqual([...original], ['alpha']);
});
