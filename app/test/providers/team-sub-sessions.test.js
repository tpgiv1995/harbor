'use strict';

// The sub-worker feed for the team chart (providers/team.js
// recentSubSessions): the bridge's history rows, classified by the same rule
// as the Orch sub-sessions list. Every id, name and folder here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { recentSubSessions, uuidV7Ms, localStampMs } = require('../../src/main/providers/team.js');

const NOW = Date.parse('2026-11-03T07:00:00Z');
const min = (n) => n * 60 * 1000;

test('a Codex thread id carries its start time; other ids carry none', () => {
  assert.equal(new Date(uuidV7Ms('01a19fad-f868-7430-b235-d0a12c905901')).toISOString(), '2026-11-03T04:32:21.096Z');
  assert.equal(uuidV7Ms('22222222-2222-4222-8222-222222222222'), null);
  assert.equal(localStampMs('2026-11-03 01:41'), new Date(2026, 10, 3, 1, 41).getTime());
});

test('only machine-made sessions of the last six hours reach the chart, with their parent link and times', () => {
  const rows = [
    { id: 'a1', provider: 'codex', title: 'Gull (/root/tide)', lineage: { parentThreadId: 'lead', nickname: 'Gull', agentPath: '/root/tide', kind: 'subagent' }, delegatedBy: 'lead', lastWriteMs: NOW - min(3), cwd: 'C:\\dev\\lighthouse' },
    { id: 'a2', provider: 'claude', entrypoint: 'sdk-cli', title: 'Count lamps', firstPrompt: 'Count lamps', cwd: 'C:\\dev\\.orch\\lighthouse\\A1', meta: { start: '2026-11-03T06:50:00Z', mt: NOW - min(2) } },
    { id: 'a3', provider: 'claude', entrypoint: 'cli', title: 'A person\'s session', meta: { mt: NOW - min(1) } },
    { id: 'a4', provider: 'claude', entrypoint: 'sdk-cli', title: 'Too old', meta: { mt: NOW - min(7 * 60) } },
  ];
  const out = recentSubSessions(rows, NOW);
  assert.deepEqual(out.map((row) => [row.id, row.kind, row.parentId]), [['a1', 'sub-agent', 'lead'], ['a2', 'headless Claude', null]]);
  assert.equal(out[0].nickname, 'Gull');
  assert.equal(out[0].agentPath, '/root/tide');
  assert.equal(out[1].startedMs, Date.parse('2026-11-03T06:50:00Z'));
  assert.equal(out[1].lastEventMs, NOW - min(2));
});

test('ancestry is resolved over all history, so an intermediate older than six hours still links a fresh leaf to its card', () => {
  const rows = [
    { id: 'lead', provider: 'codex', title: 'Lead', lineage: { originator: 'codex_tui' }, lastWriteMs: NOW - min(2) },
    { id: 'mid', provider: 'codex', title: 'Heron', lineage: { parentThreadId: 'lead', nickname: 'Heron', kind: 'subagent' }, delegatedBy: 'lead', lastWriteMs: NOW - min(7 * 60) },
    { id: 'leaf', provider: 'codex', title: 'Puffin', lineage: { parentThreadId: 'mid', nickname: 'Puffin', kind: 'subagent' }, delegatedBy: 'mid', lastWriteMs: NOW - min(1) },
  ];
  const out = recentSubSessions(rows, NOW);
  assert.deepEqual(out.map((row) => row.id), ['leaf']);
  assert.deepEqual(out[0].ancestors, [{ id: 'mid', name: 'Heron' }, { id: 'lead', name: null }]);
});

// The provider end to end with an in-memory bridge: a delegation link that
// changes rows emits `update` without a history refresh, and the tray must
// follow at once (Astra review, 2026-11-03). Folders and ids are invented.
test('a changed parent link moves a run into its parent\'s tray on the next update, with no history refresh', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { createTeamProvider } = require('../../src/main/providers/team.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-subs-'));
  const lead = '11111111-1111-4111-8111-111111111111';
  const other = '55555555-5555-4555-8555-555555555555';
  const run = '66666666-6666-4666-8666-666666666666';
  const started = new Date(Date.now() - min(30)).toISOString();
  const rows = [{ id: run, provider: 'claude', entrypoint: 'sdk-cli', title: 'Count the lamps', firstPrompt: 'Count the lamps', cwd: 'C:\\work\\lighthouse',
    project: 'lighthouse', meta: { start: new Date(Date.now() - min(5)).toISOString(), mt: Date.now() - min(1) } }];
  const emitter = new EventEmitter();
  const bridge = {
    emitter,
    getLivePanes: () => [
      { pane_id: 'p1', agent_session: lead, agent: 'claude', pid: 0, cwd: 'C:\\work\\lighthouse', created_at: started },
      { pane_id: 'p2', agent_session: other, agent: 'claude', pid: 0, cwd: 'C:\\work\\lighthouse', created_at: started },
    ],
    getHistoryRows: () => rows,
    getHistoryRow: (id) => rows.find((row) => row.id === id) || null,
    listDelegations: () => [],
  };
  const quiet = () => ({ close() {}, on() {} });
  const provider = createTeamProvider({ bridge, WorkerClass: null, platform: 'test', watchImpl: quiet, cacheDir: tmp,
    launchesFile: path.join(tmp, 'launches.jsonl'), endedFile: path.join(tmp, 'ended.json'), pinsDir: path.join(tmp, 'pins'), projectsRoot: tmp });
  try {
    await provider.start();
    let team = provider.get();
    // Two panes share the folder: the run is loose, never guessed.
    assert.equal(team.members[lead].subWorkers.length, 0);
    assert.deepEqual(team.projects.find((p) => p.project === 'lighthouse').loose.map((entry) => entry.sessionId), [run]);
    rows[0] = { ...rows[0], delegatedBy: lead };
    emitter.emit('update');
    await new Promise((resolve) => setTimeout(resolve, 400));
    team = provider.get();
    assert.deepEqual(team.members[lead].subWorkers.map((entry) => [entry.sessionId, entry.source]), [[run, 'spawned']]);
    assert.equal(team.projects.find((p) => p.project === 'lighthouse').loose.length, 0);
  } finally {
    provider.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
