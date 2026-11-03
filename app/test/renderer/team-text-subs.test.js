'use strict';

// Words for the chart's sub-worker trays (renderer/orchestration/team-text.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { subStatus, subCountText, subSourceText, filterTeam } = require('../../src/renderer/orchestration/team-text.cjs');

const NOW = Date.parse('2026-11-03T07:00:00Z');
const min = (n) => n * 60 * 1000;

test('a sub-worker says working, tool open, finished or when it was last active, with the chart clock', () => {
  assert.deepEqual(subStatus({ lastEventMs: NOW - 20_000 }, NOW), { kind: 'working', live: true, text: 'Working' });
  assert.deepEqual(subStatus({ openTool: 'Bash', lastEventMs: NOW - min(9) }, NOW), { kind: 'tool', live: true, text: 'Bash open' });
  assert.deepEqual(subStatus({ finished: true, lastEventMs: NOW - min(5) }, NOW), { kind: 'ended', live: false, text: 'Finished 5m ago' });
  assert.deepEqual(subStatus({ lastEventMs: NOW - min(12) }, NOW), { kind: 'idle', live: false, text: 'Idle 12m' });
  assert.equal(subCountText([{ lastEventMs: NOW - 1000 }, { lastEventMs: NOW - min(40) }], NOW), '2 sub-workers, 1 running');
  assert.equal(subCountText([{ lastEventMs: NOW - min(40) }], NOW), '1 sub-worker');
  assert.equal(subSourceText({ source: 'spawned-via', via: 'Gull' }), 'started by Gull, which this agent started');
  assert.equal(subSourceText({ source: null }), 'the agent that started it is not on the chart');
});

test('loose sub-workers hide under a plan, provider, state or warnings filter, and stay under a project filter', () => {
  const team = { members: {}, projects: [{ project: 'lighthouse', roots: [], idle: [], loose: [{ key: 'session:x' }] }] };
  assert.equal(filterTeam(team, { project: 'lighthouse' }).projects[0].loose.length, 1);
  assert.equal(filterTeam(team, { state: 'working' }).projects[0].loose.length, 0);
  assert.equal(filterTeam(team, { provider: 'codex' }).projects[0].loose.length, 0);
});

// Astra's adversarial review, 2026-11-03.
const { expireSubWorkers, subWorkersOf } = require('../../src/renderer/orchestration/team-text.cjs');

test('time limits run on the chart clock: a loose-only frame leaves after 30 quiet minutes, a tray drops sub-workers past six hours', () => {
  const team = {
    members: { a: { id: 'a', subWorkers: [{ key: 's1', lastEventMs: NOW - min(5) }, { key: 's2', lastEventMs: NOW - min(6 * 60 + 5) }] } },
    projects: [
      { project: 'lighthouse', memberIds: ['a'], roots: ['a'], idle: [], loose: [] },
      { project: 'driftwood', memberIds: [], roots: [], idle: [], loose: [{ key: 'd1', lastEventMs: NOW - min(20) }] },
    ],
  };
  const soon = expireSubWorkers(team, NOW);
  assert.deepEqual(soon.members.a.subWorkers.map((entry) => entry.key), ['s1']);
  assert.ok(soon.projects.find((p) => p.project === 'driftwood'));
  const later = expireSubWorkers(team, NOW + min(11));
  assert.equal(later.projects.find((p) => p.project === 'driftwood'), undefined);
  assert.ok(later.projects.find((p) => p.project === 'lighthouse'));
});

test('a stale "working" flag reads as last active, and a pin from before trays still shows its helpers', () => {
  assert.equal(subStatus({ working: true, lastEventMs: NOW - min(60) }, NOW).text, 'Idle 1h');
  assert.equal(subStatus({ openTool: 'Bash', lastEventMs: NOW - min(45) }, NOW).kind, 'idle');
  const old = { id: 'a', helpers: [{ id: 'h1', description: 'Read the tide charts', agentType: 'Explore', finished: true, lastEventMs: NOW - min(9) }] };
  assert.deepEqual(subWorkersOf(old).map((entry) => [entry.name, entry.kindText, entry.finished]), [['Read the tide charts', 'Explore sub-agent (Task)', true]]);
  const pinned = expireSubWorkers({ members: { a: old }, projects: [] }, NOW);
  assert.equal(pinned.members.a.subWorkers.length, 1);
});

test('a card kept open only by recent sub-workers folds into the idle row on the chart clock once they go quiet', () => {
  const team = {
    members: { lead: { id: 'lead', status: { kind: 'idle', sinceMs: NOW - min(60) }, children: [], warnings: [], subWorkers: [{ key: 's1', lastEventMs: NOW - min(1) }] } },
    projects: [{ project: 'lighthouse', memberIds: ['lead'], roots: ['lead'], idle: [], loose: [] }],
  };
  assert.deepEqual(expireSubWorkers(team, NOW).projects[0].roots, ['lead']);
  const later = expireSubWorkers(team, NOW + min(31)).projects[0];
  assert.deepEqual([later.roots, later.idle], [[], ['lead']]);
  // A card with a warning or a live child never folds here.
  const warned = { ...team, members: { lead: { ...team.members.lead, warnings: ['w1'] } } };
  assert.deepEqual(expireSubWorkers(warned, NOW + min(31)).projects[0].roots, ['lead']);
});

test('a pinned moment read at its own time keeps the counts it was pinned with', () => {
  const pinnedMs = NOW - min(60);
  const pin = { members: { a: { id: 'a', subWorkers: [{ key: 's1', lastEventMs: pinnedMs - min(1) }, { key: 's2', lastEventMs: pinnedMs - min(20) }] } }, projects: [] };
  const shown = expireSubWorkers(pin, pinnedMs).members.a.subWorkers;
  assert.equal(subCountText(shown, pinnedMs), '2 sub-workers, 1 running');
  assert.equal(subStatus(shown[0], pinnedMs).text, 'Working');
});
