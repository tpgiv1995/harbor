'use strict';

// Two Team chart faults Pat saw on 2026-11-24 ("fix our fucking shit before we post about it"), with invented names:
// 1. A TEAM.json member that is not running drew its own warning line ("TEAM.json lists X, and no live agent matches
//    it"), thirteen lines for one project, including a headless lane that had run a minute earlier and only exits
//    between messages. Now one quiet note per file, in that project, with when each member last ran.
// 2. Workers whose brief opens with a relay header ("From the Dispatcher (…), 04:16Z Nov 24. FIRST: …") were all named
//    "From the Dispatcher", which also raised "11 live sessions are named …". Such a header names the sender, not the
//    work: the lane's folder names the worker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveTeam } = require('../../src/shared/team-model.cjs');

const NOW = Date.parse('2026-11-24T04:30:00Z');
const min = (n) => n * 60 * 1000;
const LEAD = '11111111-1111-4111-8111-111111111111';
const CHART = '22222222-2222-4222-8222-222222222222';
const SCOUT = '33333333-3333-4333-8333-333333333333';
const OLD = '44444444-4444-4444-8444-444444444444';
const label = (cwd) => String(cwd).split(/[\\/]/).filter(Boolean).at(-1);

function inputs(extra = {}) {
  return {
    homes: [],
    projectLabel: label,
    panesKnown: true,
    panes: [{ paneId: 'p1', sessionId: LEAD, provider: 'claude', pid: 100, cwd: 'C:\\dev\\lighthouse', createdMs: NOW - min(90), argv: ['claude'] }],
    sessions: { [LEAD]: { title: 'Lighthouse lead', cwd: 'C:\\dev\\lighthouse', provider: 'claude' } },
    facts: { [LEAD]: { model: 'claude-opus-5-5', working: false, lastEventMs: NOW - min(2), openTools: [], actions: [] } },
    launches: [],
    ...extra,
  };
}

const declaration = (members) => ({ file: 'C:\\dev\\lighthouse\\docs\\orchestration\\team\\TEAM.json', root: 'C:\\dev\\lighthouse', members });

test('TEAM.json members that are not running are one note for the project, newest first, never a warning each', () => {
  const team = deriveTeam(inputs({
    declarations: [declaration([
      { name: 'Lead', session: LEAD },
      { name: 'Chartkeeper', session: CHART },
      { name: 'Scout', session: SCOUT },
      { name: 'Retired lane', session: OLD },
    ])],
    declaredActivity: { [CHART]: NOW - min(1), [SCOUT]: NOW - min(60 * 26) },
  }), NOW);
  assert.equal(team.warnings.some((w) => w.kind === 'declared-absent'), false, 'no warning line per member');
  assert.equal(team.notes.length, 1);
  const note = team.notes[0];
  assert.equal(note.kind, 'declared-resting');
  assert.equal(note.project, 'lighthouse');
  assert.deepEqual(note.members.map((m) => m.name), ['Chartkeeper', 'Scout', 'Retired lane']);
  assert.equal(note.members[0].lastActiveMs, NOW - min(1));
  assert.equal(note.members[2].lastActiveMs, null, 'a member with no session on record says so, it is not dropped');
  assert.equal(team.members[LEAD].name, 'Lead', 'a running member is still matched and named');
});

test('the note waits for the pane list and is one per file however many root spellings read it', () => {
  const file = declaration([{ name: 'Scout', session: SCOUT }]);
  assert.equal(deriveTeam(inputs({ panesKnown: false, panes: [], declarations: [file] }), NOW).notes.length, 0);
  const twice = deriveTeam(inputs({ declarations: [file, { ...file, root: 'C:/dev/lighthouse' }] }), NOW);
  assert.equal(twice.notes.length, 1);
  assert.equal(twice.notes[0].members.length, 1);
});

test('a worker whose brief opens with a relay header is named by its lane folder, and two of them raise no duplicate-name', () => {
  const header = "From the Dispatcher (the project's dispatcher (dispatcher-2), session 99999999-9999-4999-8999-999999999999), 04:16:47Z Nov 24. FIRST: acknowledge with DC-1";
  const launch = (n, cwd, launcher = 'claude-worker') => ({
    launch: `L${n}`, launcher, pid: 200 + n * 2, childPid: 201 + n * 2, alive: true, startedMs: NOW - min(10),
    parent: { provider: 'claude', session: LEAD }, child: { provider: launcher === 'astra-run' ? 'codex' : 'claude', session: null, cwd, title: header },
  });
  const team = deriveTeam(inputs({ launches: [
    launch(1, 'C:\\dev\\.orch\\lighthouse\\scratch\\daily-test'),
    launch(2, 'C:\\dev\\.orch\\lighthouse\\scratch\\release-check\\start', 'astra-run'),
  ] }), NOW);
  const names = Object.values(team.members).filter((m) => m.id !== LEAD).map((m) => m.name).sort();
  assert.deepEqual(names, ['daily-test', 'release-check']);
  assert.equal(team.warnings.some((w) => w.kind === 'duplicate-name'), false);
});

test('an ordinary brief title still names its worker', () => {
  const team = deriveTeam(inputs({ launches: [{
    launch: 'L1', launcher: 'claude-worker', pid: 300, childPid: 301, alive: true, startedMs: NOW - min(5),
    parent: { provider: 'claude', session: LEAD }, child: { provider: 'claude', session: null, cwd: 'C:\\dev\\.orch\\lighthouse\\lane-7', title: '# Fix the lens rotation timing' },
  }] }), NOW);
  assert.ok(Object.values(team.members).some((m) => m.name === 'Fix the lens rotation timing'));
});

test('the note reads as one quiet line with when each member last ran', () => {
  const { restingText } = require('../../src/renderer/orchestration/team-text.cjs');
  const text = restingText({ members: [
    { name: 'Chartkeeper', lastActiveMs: NOW - 30_000 },
    { name: 'Scout', lastActiveMs: NOW - min(60 * 26) },
    { name: 'Retired lane', lastActiveMs: null },
  ] }, NOW);
  assert.equal(text, 'Named in TEAM.json, not running now: Chartkeeper (ran under a minute ago), Scout (ran 1d ago), Retired lane (no session on record).');
});
