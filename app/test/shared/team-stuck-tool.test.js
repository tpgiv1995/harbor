'use strict';

// "Possibly stuck" means past the time the tool itself asked for (2026-11-24). A lane that runs
// `timeout 3500 bash run_rest.sh` with a one-hour Bash timeout, or a four-hour model run, drew a warning badge ten
// minutes in; on Pat's Team chart every Dispatcher lane carried one. The fold now records a Bash call's own timeout
// and the model warns once a tool is open past it (plus a minute for the harness to write the result), never before
// the old ten-minute floor. Names and ids are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveTeam } = require('../../src/shared/team-model.cjs');
const { createFold, applyLine, foldSnapshot } = require('../../src/main/providers/team-fold.js');

const NOW = Date.parse('2026-11-24T04:30:00Z');
const min = (n) => n * 60 * 1000;
const LEAD = '11111111-1111-4111-8111-111111111111';

test('the fold keeps a Bash call\'s own timeout on its open tool', () => {
  const fold = createFold();
  applyLine(fold, JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - min(30)).toISOString(), message: { model: 'claude-opus-5-5', content: [
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'timeout 3500 bash run_rest.sh', timeout: 3_600_000 } },
  ] } }));
  const open = foldSnapshot(fold).openTools;
  assert.equal(open.length, 1);
  assert.equal(open[0].timeoutMs, 3_600_000);
});

function teamWith(openTools) {
  return deriveTeam({
    homes: [], projectLabel: (cwd) => String(cwd).split(/[\\/]/).filter(Boolean).at(-1), panesKnown: true,
    panes: [{ paneId: 'p1', sessionId: LEAD, provider: 'claude', pid: 100, cwd: 'C:\\dev\\lighthouse', createdMs: NOW - min(90), argv: ['claude'] }],
    sessions: { [LEAD]: { title: 'Lighthouse lead', cwd: 'C:\\dev\\lighthouse', provider: 'claude' } },
    facts: { [LEAD]: { model: 'claude-opus-5-5', working: true, lastInTurnMs: NOW - 5000, lastEventMs: NOW - 5000, openTools, actions: [] } },
    launches: [],
  }, NOW);
}
const stuck = (team) => team.warnings.filter((w) => w.kind === 'tool-stuck').length;

test('a tool inside its own timeout is not called stuck; past it, or with no timeout past ten minutes, it is', () => {
  assert.equal(stuck(teamWith([{ id: 'a', name: 'Bash', startedMs: NOW - min(30), timeoutMs: 3_600_000 }])), 0, '30 minutes into a one-hour job');
  assert.equal(stuck(teamWith([{ id: 'b', name: 'Bash', startedMs: NOW - min(62), timeoutMs: 3_600_000 }])), 1, 'past its own hour and the minute after');
  assert.equal(stuck(teamWith([{ id: 'c', name: 'Bash', startedMs: NOW - min(12) }])), 1, 'no declared timeout: the ten-minute floor');
  assert.equal(stuck(teamWith([{ id: 'd', name: 'Bash', startedMs: NOW - min(12), timeoutMs: 120_000 }])), 1, 'a short timeout never lowers the floor below ten minutes');
  assert.equal(stuck(teamWith([{ id: 'e', name: 'Bash', startedMs: NOW - min(8), timeoutMs: 120_000 }])), 0);
});
