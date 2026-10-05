'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SORT_MODES,
  DEFAULT_SORT,
  normalizeRailSort,
  sortLabel,
  sortSidebarModel,
} = require('../../src/renderer/sidebar/rail-sort.cjs');
const { SORT_MODES: FILES_SORT_MODES } = require('../../src/renderer/artifacts/artifacts-view-model.cjs');

function session(id, { title = id, ms = 0, isChildTask = false, childTitle = null } = {}) {
  return { id, title, lastActiveMs: ms, lastActive: null, isChildTask, childTitle };
}

function project(label, sessions, extra = {}) {
  return {
    label,
    sessions,
    sessionCount: sessions.length,
    lastActiveMs: sessions.reduce((max, s) => Math.max(max, s.lastActiveMs), 0),
    hasLive: false,
    isDateGroup: false,
    ...extra,
  };
}

// zulu is alphabetically last and most recent; alpha is first and oldest.
function corpus() {
  return {
    projects: [
      project('zulu', [session('z2', { title: 'nine', ms: 900 }), session('z1', { title: 'apple', ms: 800 })]),
      project('mid', [
        session('m3', { title: 'cat', ms: 500 }),
        session('m2', { title: 'bat', ms: 400 }),
        session('m1', { title: 'ant', ms: 300 }),
      ]),
      project('alpha', [session('a1', { title: 'zebra', ms: 100 })]),
    ],
    liveProjects: [],
  };
}

// stage/project-colors.js is ESM and cannot be required from a CommonJS test,
// so the one-line rule is restated and then PINNED to the real source below.
const homeLabel = (label) => {
  const key = String(label || '').trim();
  return !key || key === '~' ? 'home' : key;
};

const labelsOf = (model) => model.projects.map((p) => p.label);
const sessionsOf = (model, label) => model.projects.find((p) => p.label === label).sessions.map((s) => s.id);

test('every mode is a known mode and the default is recency', () => {
  assert.deepEqual(SORT_MODES, ['newest', 'oldest', 'name', 'busiest']);
  assert.equal(DEFAULT_SORT, 'newest');
  assert.equal(normalizeRailSort('nonsense'), 'newest');
  assert.equal(normalizeRailSort(undefined), 'newest');
  for (const mode of SORT_MODES) assert.equal(normalizeRailSort(mode), mode);
  assert.equal(sortLabel('busiest'), 'Busiest');
});

// One app, one vocabulary: the Files view named these three first (2026-08-22)
// and the rail must not invent a second word for the same idea.
test('the shared mode words agree with the Files view', () => {
  for (const shared of ['newest', 'oldest', 'name']) {
    assert.ok(FILES_SORT_MODES.includes(shared), `Files view still knows ${shared}`);
    assert.ok(SORT_MODES.includes(shared), `rail still knows ${shared}`);
  }
});

test('the default mode is an identity, so the resting rail is untouched', () => {
  const model = corpus();
  assert.equal(sortSidebarModel(model, { sort: 'newest' }), model, 'same object, so the memo stays cheap');
  assert.equal(sortSidebarModel(model, {}), model);
});

test('name sorts BOTH levels, projects A-Z and their sessions A-Z', () => {
  const sorted = sortSidebarModel(corpus(), { sort: 'name' });
  assert.deepEqual(labelsOf(sorted), ['alpha', 'mid', 'zulu']);
  assert.deepEqual(sessionsOf(sorted, 'mid'), ['m1', 'm2', 'm3'], 'ant, bat, cat');
  assert.deepEqual(sessionsOf(sorted, 'zulu'), ['z1', 'z2'], 'apple before nine');
});

// Live-caught while driving the real rail: the rail DRAWS homeLabel(label), so
// the '~' project renders as 'home'. Sorting the raw labels collated it with
// the symbols and put 'home' second in a list whose next entry was 'Assets'.
test('A-Z follows the name the row actually draws, not the raw label', () => {
  const model = {
    projects: [
      project('zulu', [session('z')]),
      project('~', [session('h')]),
      project('Assets', [session('a')]),
    ],
  };
  const raw = labelsOf(sortSidebarModel(model, { sort: 'name' }));
  const drawn = labelsOf(sortSidebarModel(model, { sort: 'name', displayName: homeLabel }));
  assert.deepEqual(drawn, ['Assets', '~', 'zulu'], "'home' sorts under H, between Assets and zulu");
  assert.notDeepEqual(raw, drawn, 'and the raw-label order is the wrong one this guards against');
});

test('oldest reverses both levels', () => {
  const sorted = sortSidebarModel(corpus(), { sort: 'oldest' });
  assert.deepEqual(labelsOf(sorted), ['alpha', 'mid', 'zulu']);
  assert.deepEqual(sessionsOf(sorted, 'mid'), ['m1', 'm2', 'm3'], 'oldest session first');
});

test('busiest ranks projects by session count and leaves sessions on recency', () => {
  const sorted = sortSidebarModel(corpus(), { sort: 'busiest' });
  assert.deepEqual(labelsOf(sorted), ['mid', 'zulu', 'alpha']);
  assert.deepEqual(sessionsOf(sorted, 'mid'), ['m3', 'm2', 'm1'], 'still newest-first inside');
});

test('an A-Z sort reads the title the rail actually DRAWS for a worker', () => {
  const model = {
    projects: [project('p', [
      session('w1', { title: 'BATCH TITLE: zzz', ms: 10, isChildTask: true, childTitle: 'apply the fix' }),
      session('w2', { title: 'brew coffee', ms: 20 }),
    ])],
  };
  // Sorting on the raw title would put 'BATCH TITLE: zzz' first; the rail shows
  // 'apply the fix', and the sort has to agree with the column being read.
  assert.deepEqual(sortSidebarModel(model, { sort: 'name' }).projects[0].sessions.map((s) => s.id), ['w1', 'w2']);
});

// A date group's label is a date. Sorting 'Today' against 'Aug 12' as text is
// nonsense, so name falls back to chronological for them.
test('date groups never sort alphabetically', () => {
  const model = {
    projects: [
      project('Aug 12', [session('d1', { ms: 100 })], { isDateGroup: true, displayDayMs: 100 }),
      project('Today', [session('d2', { ms: 900 })], { isDateGroup: true, displayDayMs: 900 }),
      project('Yesterday', [session('d3', { ms: 500 })], { isDateGroup: true, displayDayMs: 500 }),
    ],
  };
  assert.deepEqual(
    labelsOf(sortSidebarModel(model, { sort: 'name' })),
    ['Today', 'Yesterday', 'Aug 12'],
    'chronological, not A-Z',
  );
  assert.deepEqual(
    labelsOf(sortSidebarModel(model, { sort: 'oldest' })),
    ['Aug 12', 'Yesterday', 'Today'],
    'direction still applies to date groups',
  );
});

// The group header renders project.lastActiveMs and the launch anchor reads
// sessionCount; a sort that recomputed them from a re-ordered sessions[0]
// would make an A-Z rail report the alphabetically-first session's clock as
// the project's last activity.
test('sorting never rewrites the facts about the set', () => {
  const before = corpus();
  const after = sortSidebarModel(before, { sort: 'name' });
  for (const label of ['alpha', 'mid', 'zulu']) {
    const b = before.projects.find((p) => p.label === label);
    const a = after.projects.find((p) => p.label === label);
    assert.equal(a.lastActiveMs, b.lastActiveMs, `${label} keeps its last-activity clock`);
    assert.equal(a.sessionCount, b.sessionCount);
    assert.equal(a.hasLive, b.hasLive);
  }
});

test('the input model is never mutated', () => {
  const model = corpus();
  const originalOrder = labelsOf(model);
  const originalSessions = sessionsOf(model, 'mid');
  sortSidebarModel(model, { sort: 'name' });
  assert.deepEqual(labelsOf(model), originalOrder);
  assert.deepEqual(sessionsOf(model, 'mid'), originalSessions);
});

test('ties resolve deterministically so virtualized rows do not remount', () => {
  const tied = {
    projects: [
      project('beta', [session('s2', { title: 'same', ms: 5 }), session('s1', { title: 'same', ms: 5 })]),
      project('alpha', [session('s3', { title: 'same', ms: 5 })]),
    ],
  };
  const once = sortSidebarModel(tied, { sort: 'name' });
  const twice = sortSidebarModel(tied, { sort: 'name' });
  assert.deepEqual(labelsOf(once), labelsOf(twice));
  assert.deepEqual(sessionsOf(once, 'beta'), ['s1', 's2'], 'equal titles fall back to id');
});

test('an empty or malformed model is survivable', () => {
  assert.deepEqual(sortSidebarModel({ projects: [] }, { sort: 'name' }).projects, []);
  assert.deepEqual(sortSidebarModel({}, { sort: 'name' }).projects, []);
  assert.deepEqual(sortSidebarModel(undefined, { sort: 'name' }).projects, []);
});

// The pin the helper above promises: if project-colors.js ever renames or
// re-rules the label the rail draws, this suite must fail rather than go on
// asserting A-Z against a rule the app no longer uses.
test('the local homeLabel stand-in still matches the rail\u2019s real rule', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/renderer/stage/project-colors.js'),
    'utf8',
  );
  const body = /export function homeLabel\(label\) \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(body, 'project-colors.js still exports homeLabel');
  assert.match(body[1], /key === '~' \? 'home'/, "'~' still renders as 'home'");
  assert.match(body[1], /!key \|\| /, 'an empty label still renders as home');
  assert.equal(homeLabel('~'), 'home');
  assert.equal(homeLabel(''), 'home');
  assert.equal(homeLabel('harbor'), 'harbor');
});
