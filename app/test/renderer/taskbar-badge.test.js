'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planTaskbarBadge } = require('../../src/renderer/stage/taskbar-badge.cjs');

test('blocked sessions produce amber and outrank finished sessions', () => {
  assert.deepEqual(planTaskbarBadge({ blocked: 1, finished: 2 }), {
    kind: 'amber',
    count: 1,
    label: '1',
    description: '1 session waiting for your answer; 2 sessions finished',
  });
});

test('finished sessions produce accent only when no session is blocked', () => {
  assert.deepEqual(planTaskbarBadge({ blocked: 0, finished: 2 }), {
    kind: 'accent',
    count: 2,
    label: '2',
    description: '0 sessions waiting for your answer; 2 sessions finished',
  });
});

test('zero attention produces a clear instruction while describing both counts', () => {
  assert.deepEqual(planTaskbarBadge({ blocked: 0, finished: 0 }), {
    kind: 'clear',
    count: 0,
    label: '',
    description: '0 sessions waiting for your answer; 0 sessions finished',
  });
});

test('labels cap at 9+ while descriptions retain the full counts', () => {
  const blocked = planTaskbarBadge({ blocked: 10, finished: 12 });
  assert.equal(blocked.label, '9+');
  assert.equal(blocked.description, '10 sessions waiting for your answer; 12 sessions finished');

  const finished = planTaskbarBadge({ blocked: 0, finished: 27 });
  assert.equal(finished.label, '9+');
  assert.equal(finished.description, '0 sessions waiting for your answer; 27 sessions finished');
});

test('counts are normalized so malformed inputs cannot create a false badge', () => {
  assert.equal(planTaskbarBadge({ blocked: -2, finished: Number.NaN }).kind, 'clear');
  assert.equal(planTaskbarBadge({ blocked: 0, finished: 1.9 }).label, '1');
});
