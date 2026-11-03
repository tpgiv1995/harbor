'use strict';

// The team chart's pure model (shared/team-model.cjs). Every name, folder and
// id here is invented; Harbor is published publicly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveTeam, canonicalProjectCwd, modelLabel, memberStatus, cleanTitle } = require('../../src/shared/team-model.cjs');

const NOW = Date.parse('2026-11-02T12:00:00Z');
const min = (n) => n * 60 * 1000;
const LEAD = '11111111-1111-4111-8111-111111111111';
const WORKER_A = '22222222-2222-4222-8222-222222222222';
const WORKER_B = '33333333-3333-4333-8333-333333333333';
const REVIEWER = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const homes = [
  { id: 'north', label: 'North', letter: 'N', configHome: 'C:\\Users\\sam\\.claude-north', provider: 'claude' },
  { id: 'south', label: 'South', letter: 'S', configHome: 'C:\\Users\\sam\\.claude-south', provider: 'claude' },
];
const label = (cwd) => String(cwd).split(/[\\/]/).filter(Boolean).at(-1);

function baseInputs(extra = {}) {
  return {
    homes,
    projectLabel: label,
    panes: [{ paneId: 'p1', sessionId: LEAD, provider: 'claude', pid: 100, cwd: 'C:\\dev\\lighthouse', createdMs: NOW - min(90), argv: ['claude', '--model', 'opus', '--effort', 'xhigh'] }],
    sessions: {
      [LEAD]: { title: 'Lighthouse release lead', cwd: 'C:\\dev\\lighthouse', provider: 'claude', home: 'north' },
      [WORKER_A]: { title: '# A1: harbor lights (from the lead)', cwd: 'C:\\dev\\.orch\\lighthouse\\rebuild-A1', provider: 'claude' },
    },
    facts: {
      [LEAD]: { model: 'claude-opus-5-5', working: false, turnEndedMs: NOW - min(5), lastEventMs: NOW - min(5), openTools: [], actions: [] },
      [WORKER_A]: { model: 'claude-sonnet-5-5', working: true, lastInTurnMs: NOW - 20_000, lastEventMs: NOW - 20_000, turnStartedMs: NOW - min(12), openTools: [], actions: [] },
    },
    launches: [{
      launch: 'L1', launcher: 'claude-worker', pid: 200, childPid: 201, alive: true, startedMs: NOW - min(12),
      parent: { provider: 'claude', session: LEAD },
      child: { provider: 'claude', session: WORKER_A, home: 'C:\\Users\\sam\\.claude-south', model: 'sonnet', effort: 'high', cwd: 'C:\\dev\\.orch\\lighthouse\\rebuild-A1', title: '# A1: harbor lights' },
    }],
    ...extra,
  };
}

test('worktrees and pool slots belong to the project they were cut from', () => {
  assert.equal(canonicalProjectCwd('C:\\dev\\.orch\\lighthouse\\rebuild-A1'), 'C:\\dev\\lighthouse');
  assert.equal(canonicalProjectCwd('C:\\dev\\.orch\\pool\\lighthouse\\slot-03'), 'C:\\dev\\lighthouse');
  assert.equal(canonicalProjectCwd('/home/sam/dev/.orch/lighthouse/x'), '/home/sam/dev/lighthouse');
  assert.equal(canonicalProjectCwd('C:\\dev\\lighthouse'), 'C:\\dev\\lighthouse');
});

test('model ids read the way a person says them', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-sonnet-5-5-20261001'), 'Sonnet 5.5');
  assert.equal(modelLabel('opus'), 'Opus');
  assert.equal(modelLabel('gpt-6-astra'), 'GPT-6 Astra');
  assert.equal(modelLabel('some-new-model'), 'some-new-model');
  assert.equal(modelLabel(null), null);
});

test('a worker title drops the markdown heading and the batch prefix', () => {
  assert.equal(cleanTitle('# A1: harbor lights'), 'A1: harbor lights');
  assert.equal(cleanTitle('BATCH TITLE: Paint the hull\nmore'), 'Paint the hull');
});

test('a launch record draws the reporting line and carries the worker facts', () => {
  const team = deriveTeam(baseInputs(), NOW);
  const worker = team.members[WORKER_A];
  assert.equal(worker.parent, LEAD);
  assert.equal(worker.parentSource, 'launch');
  assert.equal(worker.runMode, 'worker');
  assert.equal(worker.launcher, 'claude-worker');
  assert.equal(worker.home, 'south', 'home comes from the launch record when the index has none');
  assert.equal(worker.modelLabel, 'Sonnet 5.5', 'the transcript model outranks the launch alias');
  assert.equal(worker.effort, 'high');
  assert.equal(worker.project, 'lighthouse');
  assert.equal(worker.status.kind, 'working');
  assert.deepEqual(team.edges.map((e) => `${e.from}>${e.to}:${e.kind}`), [`${LEAD}>${WORKER_A}:directs`]);
  assert.equal(team.projects.length, 1);
  assert.deepEqual(team.projects[0].roots, [LEAD]);
  const lead = team.members[LEAD];
  assert.equal(lead.effort, 'xhigh', 'pane argv gives effort as launched');
  assert.deepEqual(lead.children, [WORKER_A]);
});

test('a worker found only in the process table hangs under the pane that runs it, and the pane says who depends on it', () => {
  const inputs = baseInputs({ launches: [], processes: [{ pid: 301, launcherPid: 300, launcher: 'claude-worker', provider: 'claude', sessionId: WORKER_B, model: 'opus', effort: 'high', cwd: 'C:\\dev\\.orch\\lighthouse\\B2', paneId: 'p1', startedMs: NOW - min(3) }] });
  const team = deriveTeam(inputs, NOW);
  const worker = team.members[WORKER_B];
  assert.equal(worker.parent, LEAD);
  assert.equal(worker.parentSource, 'process');
  assert.equal(worker.processParent, LEAD);
  const warning = team.warnings.find((w) => w.kind === 'process-parent');
  assert.ok(warning, 'the pane carries the dependents warning');
  assert.deepEqual(warning.dependents, [WORKER_B]);
});

test('a launch parent that differs from the process parent keeps both lines: directs and keeps alive', () => {
  const inputs = baseInputs();
  inputs.panes.push({ paneId: 'p2', sessionId: OTHER, provider: 'claude', pid: 150, cwd: 'C:\\dev\\lighthouse', createdMs: NOW - min(200) });
  inputs.sessions[OTHER] = { title: 'Former lead', cwd: 'C:\\dev\\lighthouse', provider: 'claude', home: 'north' };
  inputs.processes = [{ pid: 201, launcherPid: 200, launcher: 'claude-worker', provider: 'claude', sessionId: WORKER_A, paneId: 'p2' }];
  const team = deriveTeam(inputs, NOW);
  const worker = team.members[WORKER_A];
  assert.equal(worker.parent, LEAD, 'the launch record outranks the process tree');
  assert.equal(worker.processParent, OTHER);
  const kinds = team.edges.filter((e) => e.to === WORKER_A).map((e) => `${e.from}:${e.kind}`).sort();
  assert.deepEqual(kinds, [`${LEAD}:directs`, `${OTHER}:keeps-alive`].sort());
});

test('an ended launch leaves the chart; the ended strip keeps six hours only', () => {
  const inputs = baseInputs();
  inputs.launches[0].alive = false;
  inputs.launches[0].endedMs = NOW - min(1);
  inputs.ended = [
    { id: WORKER_A, name: 'A1', endedMs: NOW - min(1), outcome: 'finished' },
    { id: 'old', name: 'Old', endedMs: NOW - min(7 * 60), outcome: 'finished' },
  ];
  const team = deriveTeam(inputs, NOW);
  assert.equal(team.members[WORKER_A], undefined);
  assert.deepEqual(team.ended.map((e) => e.id), [WORKER_A]);
});

test('plan near its weekly limit names the plan and the agents on it', () => {
  const inputs = baseInputs({ usage: { south: { weeklyPct: 94, weeklyResetsAt: 1_800_000_000, updatedAtMs: NOW - min(5) } } });
  const team = deriveTeam(inputs, NOW);
  const warning = team.warnings.find((w) => w.kind === 'plan-near-limit');
  assert.equal(warning.home, 'south');
  assert.deepEqual(warning.memberIds, [WORKER_A]);
  assert.ok(team.members[WORKER_A].warnings.includes(warning.id));
  // A days-old sample is never shown as current, so it raises nothing.
  const stale = deriveTeam(baseInputs({ usage: { south: { weeklyPct: 94, updatedAtMs: NOW - min(60 * 24) } } }), NOW);
  assert.equal(stale.warnings.some((w) => w.kind === 'plan-near-limit'), false);
  assert.equal(stale.members[WORKER_A].usage.stale, true);
});

test('two writers: one session in two panes, and two members in one worktree', () => {
  const inputs = baseInputs();
  inputs.panes.push({ paneId: 'p9', sessionId: LEAD, provider: 'claude', pid: 109, cwd: 'C:\\dev\\lighthouse' });
  inputs.processes = [{ pid: 401, launcherPid: 400, launcher: 'claude-worker', sessionId: WORKER_B, cwd: 'C:\\dev\\.orch\\lighthouse\\rebuild-A1', paneId: 'p1' }];
  const team = deriveTeam(inputs, NOW);
  assert.ok(team.warnings.find((w) => w.kind === 'two-writers-session' && w.panes.length === 2));
  const folder = team.warnings.find((w) => w.kind === 'two-writers-folder');
  assert.deepEqual(folder.memberIds.sort(), [WORKER_A, WORKER_B].sort());
});

test('an open tool older than ten minutes is possibly stuck, with the tool name', () => {
  const inputs = baseInputs();
  inputs.facts[WORKER_A].openTools = [{ id: 't1', name: 'Bash', startedMs: NOW - min(14), summary: 'npm test' }];
  const team = deriveTeam(inputs, NOW);
  assert.equal(team.members[WORKER_A].status.kind, 'tool');
  assert.equal(team.members[WORKER_A].status.tool, 'Bash');
  const warning = team.warnings.find((w) => w.kind === 'tool-stuck');
  assert.equal(warning.tool, 'Bash');
});

test('a long-idle leaf folds into the idle row; a parent with live children never does', () => {
  const inputs = baseInputs();
  inputs.panes.push({ paneId: 'p3', sessionId: OTHER, provider: 'claude', pid: 160, cwd: 'C:\\dev\\lighthouse', createdMs: NOW - min(300) });
  inputs.sessions[OTHER] = { title: 'Quiet notes', cwd: 'C:\\dev\\lighthouse', provider: 'claude', home: 'north' };
  inputs.facts[OTHER] = { working: false, turnEndedMs: NOW - min(45), lastEventMs: NOW - min(45), openTools: [], actions: [] };
  inputs.facts[LEAD].turnEndedMs = NOW - min(50);
  inputs.facts[LEAD].lastEventMs = NOW - min(50);
  const team = deriveTeam(inputs, NOW);
  assert.deepEqual(team.projects[0].idle, [OTHER]);
  assert.deepEqual(team.projects[0].roots, [LEAD]);
});

test('TEAM.json adds names, roles and a reviews line, and is optional', () => {
  const inputs = baseInputs();
  inputs.panes.push({ paneId: 'p4', sessionId: REVIEWER, provider: 'codex', pid: 170, cwd: 'C:\\dev\\lighthouse' });
  inputs.sessions[REVIEWER] = { title: 'review', cwd: 'C:\\dev\\lighthouse', provider: 'codex' };
  inputs.declarations = [{ file: 'C:\\dev\\lighthouse\\docs\\orchestration\\x\\TEAM.json', root: 'C:\\dev\\lighthouse', title: 'Release team', members: [
    { name: 'lead', role: 'Technical owner', session: LEAD },
    { name: 'a1', role: 'Lights lane', match: { cwd: 'rebuild-A1' }, reports_to: 'lead', reviewed_by: ['reviewer'] },
    { name: 'reviewer', role: 'Reviewer', session: REVIEWER },
    { name: 'ghost', role: 'Absent lane', match: { cwd: 'nowhere' } },
  ] }];
  const team = deriveTeam(inputs, NOW);
  assert.equal(team.members[LEAD].role, 'Technical owner');
  assert.equal(team.members[WORKER_A].name, 'a1');
  assert.ok(team.edges.some((e) => e.kind === 'reviews' && e.from === REVIEWER && e.to === WORKER_A));
  assert.ok(team.warnings.some((w) => w.kind === 'declared-absent' && w.name === 'ghost'));
  // Without a declaration the chart is complete and raises nothing about roles.
  const plain = deriveTeam(baseInputs(), NOW);
  assert.equal(plain.warnings.some((w) => ['declared-absent', 'undeclared'].includes(w.kind)), false);
  assert.equal(plain.members[LEAD].role, null);
});

test('a delegated codex agent hangs under its parent while it runs', () => {
  const inputs = baseInputs({ delegations: [{ parentId: LEAD, agents: [{ sessionId: REVIEWER, provider: 'codex', state: 'running', model: 'gpt-6-astra', description: 'Review the lights', rounds: [{ startedMs: NOW - min(4) }] }] }] });
  inputs.sessions[REVIEWER] = { cwd: 'C:\\dev\\lighthouse', provider: 'codex', title: 'review' };
  const team = deriveTeam(inputs, NOW);
  assert.equal(team.members[REVIEWER].parent, LEAD);
  assert.equal(team.members[REVIEWER].parentSource, 'delegation');
  assert.equal(team.members[REVIEWER].modelLabel, 'GPT-6 Astra');
  const done = deriveTeam(baseInputs({ delegations: [{ parentId: LEAD, agents: [{ sessionId: REVIEWER, provider: 'codex', state: 'done' }] }] }), NOW);
  assert.equal(done.members[REVIEWER], undefined, 'a finished delegation is not on the chart');
});

test('status reads working, tool open, starting, quiet and idle from the evidence', () => {
  assert.equal(memberStatus({ alive: false, facts: null, endedMs: 5 }, NOW).kind, 'ended');
  assert.equal(memberStatus({ alive: true, facts: { openTools: [{ name: 'Read', startedMs: NOW - 1000 }] } }, NOW).kind, 'tool');
  assert.equal(memberStatus({ alive: true, facts: { working: true, lastInTurnMs: NOW - 1000 } }, NOW).kind, 'working');
  assert.equal(memberStatus({ alive: true, facts: null, createdMs: NOW - 1000 }, NOW).kind, 'starting');
  assert.equal(memberStatus({ alive: true, facts: { working: true, lastInTurnMs: NOW - min(8), lastEventMs: NOW - min(8) } }, NOW).kind, 'quiet');
  assert.equal(memberStatus({ alive: true, facts: { working: false, turnEndedMs: NOW - min(2), lastEventMs: NOW - min(2) } }, NOW).kind, 'idle');
  assert.equal(memberStatus({ alive: true, facts: { working: false }, pane: { agentStatus: 'working' } }, NOW).kind, 'working');
});

test('a reporting cycle is cut rather than looping', () => {
  const inputs = baseInputs();
  inputs.launches.push({ launch: 'L2', launcher: 'claude-worker', pid: 500, alive: true, startedMs: NOW, parent: { session: WORKER_A }, child: { session: LEAD } });
  const team = deriveTeam(inputs, NOW);
  assert.ok(team.projects.length >= 1);
  const roots = team.projects.flatMap((p) => p.roots);
  assert.ok(roots.length >= 1, 'something is a root, so the chart draws');
});

test('a worker launched from a Codex shell inside a Claude session reports to the Codex thread', () => {
  const inputs = baseInputs();
  inputs.sessions[REVIEWER] = { cwd: 'C:\\dev\\lighthouse', provider: 'codex', title: 'Astra lead', delegatedBy: LEAD };
  inputs.panes.push({ paneId: 'p5', sessionId: REVIEWER, provider: 'codex', pid: 180, cwd: 'C:\\dev\\lighthouse' });
  inputs.launches[0].parent = { provider: 'claude', session: LEAD };
  inputs.launches[0].parents = { claude: LEAD, codex: REVIEWER };
  const team = deriveTeam(inputs, NOW);
  assert.equal(team.members[WORKER_A].parent, REVIEWER);
});

test('test runs count per owner and name the agent whose process runs them', () => {
  const inputs = baseInputs({ processes: [
    { pid: 201, launcherPid: 200, launcher: 'claude-worker', sessionId: WORKER_A, paneId: null },
    ...[1, 2, 3, 4].map((n) => ({ kind: 'test', pid: 900 + n, label: 'pytest', ownerPid: 201 })),
    { kind: 'test', pid: 990, label: 'vitest', paneId: null, ownerPid: null },
  ] });
  const team = deriveTeam(inputs, NOW);
  const warning = team.warnings.find((w) => w.kind === 'many-test-runs');
  assert.deepEqual(warning.memberIds, [WORKER_A]);
  assert.equal(warning.count, 4);
  assert.equal(team.warnings.filter((w) => w.kind === 'many-test-runs').length, 1, 'one loose run is not a crowd');
});

// A lead-and-reviewer team where authority is not who launched whom (the shape
// Pat expected on 2026-11-02: reviewer -> lead -> everyone else). The lead
// launches the reviewer's thread to ask for rulings, and another pane
// delegated it once; the team file says who answers to whom.
test('a declared top and everyone_else_reports_to give the team its own shape over launch evidence', () => {
  const annex = '66666666-6666-4666-8666-666666666666';
  const inputs = baseInputs();
  inputs.panes.push(
    { paneId: 'p2', sessionId: REVIEWER, provider: 'codex', pid: 170, cwd: 'C:\\dev\\lighthouse' },
    { paneId: 'p3', sessionId: OTHER, provider: 'claude', pid: 180, cwd: 'C:\\dev\\lighthouse' },
    { paneId: 'p4', sessionId: annex, provider: 'claude', pid: 190, cwd: 'C:\\dev\\lighthouse-annex' },
  );
  inputs.sessions[REVIEWER] = { title: 'Chief review thread', cwd: 'C:\\dev\\lighthouse', provider: 'codex' };
  inputs.sessions[OTHER] = { title: 'Side audit', cwd: 'C:\\dev\\lighthouse', provider: 'claude' };
  inputs.sessions[annex] = { title: 'Annex work', cwd: 'C:\\dev\\lighthouse-annex', provider: 'claude' };
  // The lead resumed the reviewer's thread (a launch record), and the side pane delegated it once.
  inputs.launches.push({ launch: 'L2', launcher: 'astra-run', pid: 210, childPid: 211, alive: true, startedMs: NOW - min(6), parent: { provider: 'claude', session: LEAD }, child: { provider: 'codex', session: REVIEWER, resume: true } });
  inputs.delegations = [{ parentId: OTHER, agents: [{ sessionId: REVIEWER, provider: 'codex', state: 'running' }] }];
  // A lane started before launches were recorded: only the process table knows it.
  inputs.processes = [{ pid: 401, launcherPid: 400, launcher: 'claude-worker', provider: 'claude', sessionId: WORKER_B, cwd: 'C:\\dev\\.orch\\lighthouse\\rebuild-B1' }];
  inputs.declarations = [{ file: 'C:\\dev\\lighthouse\\docs\\orchestration\\x\\TEAM.json', root: 'C:\\dev\\lighthouse', title: 'Release team', everyoneElse: 'lead', members: [
    { name: 'chief', role: 'Technical owner', session: REVIEWER, top: true },
    { name: 'lead', role: 'Runs the lanes', session: LEAD, reports_to: 'chief' },
  ] }];
  const team = deriveTeam(inputs, NOW);
  const parentOf = (id) => team.members[id]?.parent || null;
  assert.equal(parentOf(REVIEWER), null, 'the declared top has no line above it, whoever launched its thread');
  assert.equal(parentOf(LEAD), REVIEWER, 'the lead reports to the chief');
  assert.equal(team.members[LEAD].parentSource, 'declared');
  assert.equal(parentOf(WORKER_A), LEAD, 'a lane the lead launched keeps its launch line');
  assert.equal(team.members[WORKER_A].parentSource, 'launch');
  assert.equal(parentOf(WORKER_B), LEAD, 'a lane with no record goes under the lead');
  assert.equal(parentOf(OTHER), LEAD, 'so does any other agent of the project');
  assert.equal(parentOf(annex), null, 'a sibling folder that only shares the prefix is another project');
  assert.equal(team.warnings.some((w) => w.kind === 'undeclared'), false, 'everyone_else covers everyone: nothing to nag about');
  assert.equal(team.members[REVIEWER].name, 'chief');
  // Without the file, the same evidence draws the launch shape, as before.
  const plain = { ...inputs, declarations: [] };
  assert.equal(deriveTeam(plain, NOW).members[REVIEWER].parent, LEAD);
});

test('a worker with no title yet is named by its worktree folder, not "Untitled session"', () => {
  const inputs = baseInputs({ launches: [], processes: [{ pid: 501, launcherPid: 500, launcher: 'claude-worker', provider: 'claude', cwd: 'C:\\dev\\.orch\\lighthouse\\rebuild-C3\\' }] });
  const team = deriveTeam(inputs, NOW);
  const worker = Object.values(team.members).find((m) => m.runMode === 'worker' && /rebuild-C3/.test(m.cwd || ''));
  assert.equal(worker.name, 'rebuild-C3');
});

test('a declared member is not called absent before the pane list arrives, and is called absent once per file', () => {
  const declaration = { file: 'C:\\dev\\lighthouse\\docs\\orchestration\\x\\TEAM.json', root: 'C:\\dev\\lighthouse', members: [{ name: 'ghost', session: '99999999-9999-4999-8999-999999999999' }] };
  const booting = deriveTeam({ ...baseInputs(), panes: [], panesKnown: false, declarations: [declaration] }, NOW);
  assert.equal(booting.warnings.some((w) => w.kind === 'declared-absent'), false, 'nothing is absent while Harbor is still starting');
  // The same file read under two spellings of one root.
  const twice = deriveTeam({ ...baseInputs(), panesKnown: true, declarations: [declaration, { ...declaration, root: 'C:/dev/lighthouse' }] }, NOW);
  assert.equal(twice.warnings.filter((w) => w.kind === 'declared-absent').length, 1);
});

// SUB-WORKERS ON THE CHART (2026-11-03). Every name and id below is invented.
const SUB_A = '66666666-6666-4666-8666-666666666666';
const SUB_B = '77777777-7777-4777-8777-777777777777';
const SUB_C = '88888888-8888-4888-8888-888888888888';
const SUB_D = '99999999-9999-4999-8999-999999999999';
const sub = (id, extra = {}) => ({ id, provider: 'claude', kind: 'headless Claude', title: null, firstPrompt: null, nickname: null, agentPath: null,
  cwd: null, project: null, parentId: null, startedMs: NOW - min(4), lastEventMs: NOW - min(1), ...extra });

test('a Codex sub-agent hangs in its parent card\'s tray by name, and one it spawned hangs there too, said as such', () => {
  const team = deriveTeam(baseInputs({ subSessions: [
    sub(SUB_A, { provider: 'codex', kind: 'sub-agent', nickname: 'Gull', agentPath: '/root/tide_tables', parentId: LEAD }),
    sub(SUB_B, { provider: 'codex', kind: 'sub-agent', nickname: 'Tern', parentId: SUB_A, lastEventMs: NOW - min(20) }),
  ] }), NOW);
  const tray = team.members[LEAD].subWorkers.filter((entry) => entry.sessionId);
  assert.deepEqual(tray.map((entry) => [entry.name, entry.source, entry.via || null]), [['Gull', 'spawned', null], ['Tern', 'spawned-via', 'Gull']]);
  assert.equal(tray[0].detail, '/root/tide_tables');
  assert.equal(tray[0].kindText, 'Sub-agent');
});

test('a headless run in a lane folder joins the one agent working there that started before it; in a shared folder it stays loose', () => {
  const lane = 'C:\\dev\\.orch\\lighthouse\\rebuild-A1';
  const one = deriveTeam(baseInputs({ subSessions: [sub(SUB_A, { cwd: lane, firstPrompt: 'Use the SendMessage tool exactly once, to the session named lighthouse-7 [ab12cd], with the message below verbatim.' })] }), NOW);
  const entry = one.members[WORKER_A].subWorkers.find((item) => item.sessionId === SUB_A);
  assert.equal(entry.source, 'folder');
  assert.equal(entry.name, 'Message to lighthouse-7 [ab12cd]');
  // A run older than the only agent in its folder is not its child.
  const before = deriveTeam(baseInputs({ subSessions: [sub(SUB_A, { cwd: lane, startedMs: NOW - min(30) })] }), NOW);
  assert.equal(before.members[WORKER_A].subWorkers.length, 0);
  // Two agents in the lead's folder: no guess.
  const shared = deriveTeam(baseInputs({
    panes: [...baseInputs().panes, { paneId: 'p2', sessionId: OTHER, provider: 'claude', pid: 300, cwd: 'C:\\dev\\lighthouse', createdMs: NOW - min(60) }],
    subSessions: [sub(SUB_B, { cwd: 'C:\\dev\\lighthouse', title: 'Count the lamps' })],
  }), NOW);
  assert.equal(shared.members[LEAD].subWorkers.length, 0);
  assert.equal(shared.members[OTHER].subWorkers.length, 0);
  assert.deepEqual(shared.projects.find((p) => p.project === 'lighthouse').loose.map((item) => item.name), ['Count the lamps']);
});

test('a courier run is named for the session it delivers to, however its brief words it', () => {
  const { subWorkerName } = require('../../src/shared/team-model.cjs');
  const name = (firstPrompt) => subWorkerName({ kind: 'headless Claude', firstPrompt });
  assert.equal(name('Use the SendMessage tool exactly once, to the session named lighthouse-7 [ab12cd], with the message below verbatim.'), 'Message to lighthouse-7 [ab12cd]');
  assert.equal(name('First use the ListAgents tool once. If no session named rebuild-a1 is listed, stop. Otherwise SendMessage it the text below.'), 'Message to rebuild-a1');
  assert.equal(name('First use the ListAgents tool once. If no session named exactly rebuild-a1 is listed, reply NOT-FOUND and stop.'), 'Message to rebuild-a1');
  assert.equal(name('Use the SendMessage tool once, to the session named "rebuild-c3", with the message below.'), 'Message to rebuild-c3');
  assert.equal(name('Use ListAgents to find the session whose name starts with rebuild-b2 and SendMessage it the text between the lines.'), 'Message to rebuild-b2');
  assert.equal(name('Count the lamps in the north tower and report back.'), 'Count the lamps in the north tower and report back.');
  assert.equal(subWorkerName({ kind: 'sub-agent', nickname: 'Gull', firstPrompt: 'Use the SendMessage tool to the session named x' }), 'Gull');
});

test('a run whose named parent is not on the chart is never guessed by folder, and a session that is a card is not also a sub-worker', () => {
  const lane = 'C:\\dev\\.orch\\lighthouse\\rebuild-A1';
  const team = deriveTeam(baseInputs({ subSessions: [
    sub(SUB_A, { cwd: lane, parentId: REVIEWER, title: 'Orphan check' }),
    sub(WORKER_A, { cwd: lane, title: 'The lane itself' }),
  ] }), NOW);
  assert.equal(team.members[WORKER_A].subWorkers.length, 0);
  assert.deepEqual(team.projects.find((p) => p.project === 'lighthouse').loose.map((item) => item.name), ['Orphan check']);
});

test('a launch record names an ended run\'s parent; runs older than six hours drop off', () => {
  const inputs = baseInputs({
    launches: [...baseInputs().launches, { launch: 'L2', launcher: 'claude-worker', pid: 210, childPid: 211, alive: false, endedMs: NOW - min(9), startedMs: NOW - min(40),
      parent: { provider: 'claude', session: LEAD }, child: { provider: 'claude', session: SUB_C, cwd: 'C:\\dev\\.orch\\lighthouse\\rebuild-B2' } }],
    subSessions: [
      sub(SUB_C, { kind: 'batch worker', cwd: 'C:\\dev\\.orch\\lighthouse\\rebuild-B2', title: 'BATCH TITLE: B2 fog horn', lastEventMs: NOW - min(9) }),
      sub(SUB_D, { parentId: LEAD, lastEventMs: NOW - min(7 * 60), title: 'Too old' }),
    ],
  });
  const team = deriveTeam(inputs, NOW);
  assert.deepEqual(team.members[LEAD].subWorkers.map((entry) => [entry.name, entry.source]), [['B2 fog horn', 'launch']]);
});

test('Task helpers join the tray; running sub-workers sort first; a long-idle parent with a recent sub-worker keeps its card', () => {
  const inputs = baseInputs({
    facts: { ...baseInputs().facts, [LEAD]: { ...baseInputs().facts[LEAD], turnEndedMs: NOW - min(50), lastEventMs: NOW - min(50) } },
    helpers: { [LEAD]: [{ id: 'h1', description: 'Read the tide charts', agentType: 'Explore', finished: true, lastEventMs: NOW - min(12), startedMs: NOW - min(14) }] },
    subSessions: [sub(SUB_A, { provider: 'codex', kind: 'sub-agent', nickname: 'Gull', parentId: LEAD, lastEventMs: NOW - min(1) })],
  });
  // The lead's own worker ended, so only the sub-workers can keep it a card.
  inputs.launches = [];
  inputs.facts = { [LEAD]: inputs.facts[LEAD] };
  const team = deriveTeam(inputs, NOW);
  assert.deepEqual(team.members[LEAD].subWorkers.map((entry) => [entry.name, entry.kind]), [['Gull', 'sub-agent'], ['Read the tide charts', 'helper']]);
  assert.equal(team.members[LEAD].subWorkers[1].kindText, 'Explore sub-agent (Task)');
  const project = team.projects.find((p) => p.project === 'lighthouse');
  assert.deepEqual(project.roots, [LEAD]);
  assert.deepEqual(project.idle, []);
});

test('a project with only unlinked sub-workers gets a frame while one was active in the last 30 minutes', () => {
  const fresh = deriveTeam(baseInputs({ subSessions: [sub(SUB_A, { cwd: 'C:\\dev\\driftwood', title: 'Sort the driftwood', lastEventMs: NOW - min(10) })] }), NOW);
  const frame = fresh.projects.find((p) => p.project === 'driftwood');
  assert.ok(frame);
  assert.equal(frame.counts.total, 0);
  assert.deepEqual(frame.loose.map((entry) => entry.name), ['Sort the driftwood']);
  const stale = deriveTeam(baseInputs({ subSessions: [sub(SUB_A, { cwd: 'C:\\dev\\driftwood', lastEventMs: NOW - min(45) })] }), NOW);
  assert.equal(stale.projects.find((p) => p.project === 'driftwood'), undefined);
});

// Astra's adversarial review, 2026-11-03: each case below failed before its fix.
test('folder inference never overrides a recorded parent, needs ONE agent in the folder, and needs both start times', () => {
  const lane = 'C:\\dev\\.orch\\lighthouse\\rebuild-A1';
  // A launch record names a parent that has ended: the run is loose, not the neighbour's.
  const ended = deriveTeam(baseInputs({
    launches: [...baseInputs().launches, { launch: 'L9', launcher: 'claude-worker', pid: 290, childPid: 291, alive: false, endedMs: NOW - min(3), startedMs: NOW - min(8),
      parent: { provider: 'claude', session: OTHER }, child: { provider: 'claude', session: SUB_A, cwd: lane } }],
    subSessions: [sub(SUB_A, { cwd: lane, title: 'Orphaned by an ended lead' })],
  }), NOW);
  assert.equal(ended.members[WORKER_A].subWorkers.length, 0);
  // Two agents in the folder, the second started after the run: still no guess.
  const two = deriveTeam(baseInputs({
    panes: [...baseInputs().panes, { paneId: 'p3', sessionId: OTHER, provider: 'claude', pid: 310, cwd: lane, createdMs: NOW - min(1) }],
    subSessions: [sub(SUB_B, { cwd: lane, startedMs: NOW - min(4) })],
  }), NOW);
  assert.equal(two.members[WORKER_A].subWorkers.length, 0);
  assert.equal(two.members[OTHER].subWorkers.length, 0);
  // An unknown start time: no guess.
  const unknown = deriveTeam(baseInputs({ subSessions: [sub(SUB_C, { cwd: lane, startedMs: null })] }), NOW);
  assert.equal(unknown.members[WORKER_A].subWorkers.length, 0);
});

test('a finished run launched from a Codex shell inside a Claude session sits under the Codex thread, as its live card did', () => {
  const CODEX = '77777777-7777-4777-8777-aaaaaaaaaaaa';
  const team = deriveTeam(baseInputs({
    panes: [...baseInputs().panes, { paneId: 'p4', sessionId: CODEX, provider: 'codex', pid: 400, cwd: 'C:\\dev\\lighthouse', createdMs: NOW - min(80) }],
    sessions: { ...baseInputs().sessions, [CODEX]: { title: 'Codex crew', provider: 'codex', delegatedBy: LEAD, cwd: 'C:\\dev\\lighthouse' } },
    launches: [...baseInputs().launches, { launch: 'L7', launcher: 'claude-worker', pid: 270, childPid: 271, alive: false, endedMs: NOW - min(2), startedMs: NOW - min(6),
      parent: { provider: 'claude', session: LEAD }, parents: { claude: LEAD, codex: CODEX }, child: { provider: 'claude', session: SUB_D, cwd: 'C:\\dev\\.orch\\lighthouse\\rebuild-C3' } }],
    subSessions: [sub(SUB_D, { cwd: 'C:\\dev\\.orch\\lighthouse\\rebuild-C3', title: 'C3 lamp test' })],
  }), NOW);
  assert.deepEqual(team.members[CODEX].subWorkers.map((entry) => [entry.name, entry.source]), [['C3 lamp test', 'launch']]);
  assert.equal(team.members[LEAD].subWorkers.length, 0);
});

test('resolved ancestry from the provider links a leaf through a sub-agent the window no longer lists', () => {
  const team = deriveTeam(baseInputs({ subSessions: [sub(SUB_A, { provider: 'codex', kind: 'sub-agent', nickname: 'Puffin', parentId: SUB_B,
    ancestors: [{ id: SUB_B, name: 'Heron' }, { id: LEAD, name: null }] })] }), NOW);
  assert.deepEqual(team.members[LEAD].subWorkers.map((entry) => [entry.name, entry.source, entry.via]), [['Puffin', 'spawned-via', 'Heron']]);
});

test('a helper interrupted mid-turn is not "running" forever: only fresh writes or a recent open tool count', () => {
  const { subWorkerActive } = require('../../src/shared/team-model.cjs');
  assert.equal(subWorkerActive({ working: true, lastEventMs: NOW - min(60) }, NOW), false);
  assert.equal(subWorkerActive({ working: true, lastEventMs: NOW - min(1) }, NOW), true);
  assert.equal(subWorkerActive({ openTool: 'Bash', lastEventMs: NOW - min(20) }, NOW), true);
  assert.equal(subWorkerActive({ openTool: 'Bash', lastEventMs: NOW - min(45) }, NOW), false);
  assert.equal(subWorkerActive({ finished: true, lastEventMs: NOW - 1000 }, NOW), false);
});

test('folder inference needs the agent to have started first, with no slack: an agent three seconds younger than the run adopts nothing', () => {
  const lane = 'C:\\dev\\.orch\\lighthouse\\rebuild-A1';
  const inputs = baseInputs({ subSessions: [sub(SUB_A, { cwd: lane, startedMs: NOW - min(12) - 3000 })] });
  assert.equal(deriveTeam(inputs, NOW).members[WORKER_A].subWorkers.length, 0);
  const same = baseInputs({ subSessions: [sub(SUB_A, { cwd: lane, startedMs: NOW - min(12) })] });
  assert.equal(deriveTeam(same, NOW).members[WORKER_A].subWorkers[0].source, 'folder');
});
