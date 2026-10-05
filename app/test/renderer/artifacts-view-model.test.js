'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planArtifactsView, normalizeGroupBy, normalizeSortBy,
} = require('../../src/renderer/artifacts/artifacts-view-model.cjs');
const { displayDayFor } = require('../../src/shared/date-roll.cjs');

function entry(name, { kind = 'image', mtimeMs, bytes = 100, project = 'demo', title = null } = {}) {
  return {
    artifact: { name, kind, mtimeMs, bytes, path: `C:/x/${name}` },
    sessionTitle: title,
    projectLabel: project,
    projectKey: `C:/dev/${project}`,
    cwd: `C:/dev/${project}`,
  };
}

const NOON = new Date('2026-08-22T12:00:00').getTime();
const HOUR = 3_600_000;

test('search matches filename, project label, and session title, case-insensitive', () => {
  const entries = [
    entry('report.html', { kind: 'html', mtimeMs: NOON, project: 'sweep' }),
    entry('chart.png', { mtimeMs: NOON, project: 'harbor', title: 'Badge Work' }),
    entry('photo.png', { mtimeMs: NOON, project: 'misc' }),
  ];
  assert.deepEqual(
    planArtifactsView({ entries, search: 'REPORT', nowMs: NOON }).groups.flatMap((g) => g.items).map((e) => e.artifact.name),
    ['report.html'],
  );
  assert.deepEqual(
    planArtifactsView({ entries, search: 'harb', nowMs: NOON }).groups.flatMap((g) => g.items).map((e) => e.artifact.name),
    ['chart.png'],
  );
  assert.deepEqual(
    planArtifactsView({ entries, search: 'badge', nowMs: NOON }).groups.flatMap((g) => g.items).map((e) => e.artifact.name),
    ['chart.png'],
  );
  const { total, matched } = planArtifactsView({ entries, search: 'zzz', nowMs: NOON });
  assert.equal(total, 3);
  assert.equal(matched, 0);
});

test('sort modes order a flat view: newest, oldest, largest, name', () => {
  const entries = [
    entry('bravo.png', { mtimeMs: NOON - 2 * HOUR, bytes: 500 }),
    entry('alpha.png', { mtimeMs: NOON, bytes: 100 }),
    entry('Charlie.png', { mtimeMs: NOON - HOUR, bytes: 900 }),
  ];
  const names = (sortBy) => planArtifactsView({ entries, groupBy: 'none', sortBy, nowMs: NOON })
    .groups[0].items.map((e) => e.artifact.name);
  assert.deepEqual(names('newest'), ['alpha.png', 'Charlie.png', 'bravo.png']);
  assert.deepEqual(names('oldest'), ['bravo.png', 'Charlie.png', 'alpha.png']);
  assert.deepEqual(names('largest'), ['Charlie.png', 'bravo.png', 'alpha.png']);
  assert.deepEqual(names('name'), ['alpha.png', 'bravo.png', 'Charlie.png']);
});

test('day grouping follows the 6am roll and labels Today/Yesterday', () => {
  const oneAm = new Date('2026-08-22T01:00:00').getTime();
  const priorEvening = new Date('2026-08-21T22:00:00').getTime();
  const midday = new Date('2026-08-22T12:00:00').getTime();
  const entries = [
    entry('night-owl.png', { mtimeMs: oneAm }),
    entry('evening.png', { mtimeMs: priorEvening }),
    entry('noon.png', { mtimeMs: midday }),
  ];
  const { groups } = planArtifactsView({ entries, groupBy: 'day', nowMs: midday });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, 'Today');
  assert.deepEqual(groups[0].items.map((e) => e.artifact.name), ['noon.png']);
  // 1am work belongs to the previous display day, together with that evening.
  assert.equal(groups[1].label, 'Yesterday');
  assert.deepEqual(
    groups[1].items.map((e) => e.artifact.name).sort(),
    ['evening.png', 'night-owl.png'],
  );
  assert.equal(
    displayDayFor(new Date(oneAm)).getTime(),
    displayDayFor(new Date(priorEvening)).getTime(),
  );
});

test('group order follows the sort at both levels, and none flattens to one group', () => {
  const entries = [
    entry('old.png', { mtimeMs: NOON - 10 * HOUR, project: 'ancient' }),
    entry('new.png', { mtimeMs: NOON, project: 'fresh' }),
  ];
  const newest = planArtifactsView({ entries, groupBy: 'project', sortBy: 'newest', nowMs: NOON });
  assert.deepEqual(newest.groups.map((g) => g.label), ['fresh', 'ancient']);
  const oldest = planArtifactsView({ entries, groupBy: 'project', sortBy: 'oldest', nowMs: NOON });
  assert.deepEqual(oldest.groups.map((g) => g.label), ['ancient', 'fresh']);
  const flat = planArtifactsView({ entries, groupBy: 'none', nowMs: NOON });
  assert.equal(flat.groups.length, 1);
  assert.equal(flat.groups[0].label, null);
  assert.equal(flat.groups[0].items.length, 2);
});

test('kind filter composes with search, and unknown modes normalize to defaults', () => {
  const entries = [
    entry('a.html', { kind: 'html', mtimeMs: NOON }),
    entry('a.png', { kind: 'image', mtimeMs: NOON }),
  ];
  const plan = planArtifactsView({ entries, kind: 'html', search: 'a', nowMs: NOON });
  assert.deepEqual(plan.groups.flatMap((g) => g.items).map((e) => e.artifact.name), ['a.html']);
  assert.equal(plan.total, 1);
  assert.equal(normalizeGroupBy('bogus'), 'project');
  assert.equal(normalizeSortBy('bogus'), 'newest');
});
