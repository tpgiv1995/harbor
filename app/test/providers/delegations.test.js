'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const bg = require('../../src/main/providers/background-tasks.js');
const { createScanner } = require('../../src/main/providers/delegations-worker.js');
const { codexLineage, readCodexRolloutMeta } = require('../../src/main/providers/provider-session-link.js');
const { dispatchFor, linkDispatches, buildDelegationGroups, createDelegationIndex } = require('../../src/main/providers/delegations.js');
const { runStateCue } = require('../../src/shared/session-run-state.cjs');
const { attentionFor, badgeCounts } = require('../../src/renderer/stage/unseen-completions.cjs');
const { createNotifier } = require('../../src/main/notify.js');
const { runClaudeTitle } = require('../../src/main/providers/titles.js');
const stamp = (n) => new Date(100000 + n * 1000).toISOString();
function tool(s, name, input, result, id = name, n = 0, asParts = false) {
  bg.applyBackgroundLine(s, { type: 'assistant', timestamp: stamp(n), message: { content: [{ type: 'tool_use', name, id, input }] } });
  bg.applyBackgroundLine(s, { type: 'user', timestamp: stamp(n + 1), message: { content: [{ type: 'tool_result', tool_use_id: id, content: asParts ? [{ type: 'text', text: result }] : result }] } });
}
const note = (id, status = 'completed') => `<task-notification><task-id>${id}</task-id>${status ? `<status>${status}</status>` : '<event>progress</event>'}<summary>status changed</summary></task-notification>`;
function notification(s, id, status, type = 'queue-operation', n = 2) {
  const text = note(id, status);
  bg.applyBackgroundLine(s, { type, timestamp: stamp(n), operation: 'enqueue', content: text, attachment: { type: 'queued_command', prompt: text }, message: { content: text } });
}
const launches = [
  ['Bash', { run_in_background: true }, 'Command running in background with ID: b1. Output is being written to: out', 'b1', 'command'],
  ['PowerShell', {}, 'Command running in background with ID: b1.', 'b1', 'command'],
  ['Bash', {}, 'Command did not complete within its 120s timeout and was moved to the background (ID: b2).', 'b2', 'command'],
  ['mcp__chrome__resize', {}, 'MCP tool "chrome/browser_resize" is still running after 120s. It was moved to the background as task k1 and keeps running', 'k1', 'mcp'],
  ['Agent', { run_in_background: 'true' }, 'Async agent launched successfully. agentId: a1 (internal ID)', 'a1', 'agent'],
  ['Task', {}, 'Async agent launched successfully. agentId: a2 (internal ID)', 'a2', 'agent'],
  ['Workflow', {}, 'Workflow launched in background. Task ID: w1', 'w1', 'workflow'],
  ['Monitor', { description: 'Watch build' }, 'Monitor started (task b3, expires in 5m unless the source ends first;', 'b3', 'monitor'],
];
for (const [name, input, result, id, kind] of launches) for (const asParts of [false, true]) test(`tracker accepts ${name} ${id} ${asParts ? 'parts' : 'text'}`, () => {
  const state = bg.createBackgroundState(); tool(state, name, input, result, name, 0, asParts);
  assert.equal(state.tasks[id].kind, kind); assert.equal(bg.backgroundSnapshot(state).outstanding.length, 1);
});
for (const type of ['queue-operation', 'attachment', 'user']) for (const status of ['completed', 'failed', 'killed', 'stopped']) test(`notification ${type} ${status} is terminal and deduped`, () => {
  const s = bg.createBackgroundState(); tool(s, ...launches[0].slice(0, 3));
  notification(s, 'b1', status, type); notification(s, 'b1', status, 'attachment', 3);
  assert.equal(s.tasks.b1.status, status); assert.equal(s.tasks.b1.endedMs, 102000); assert.equal(bg.backgroundSnapshot(s).outstanding.length, 0);
});
test('monitor progress, sidechains, successful and refused stops, and reactivation', () => {
  const s = bg.createBackgroundState(); tool(s, ...launches[7].slice(0, 3)); notification(s, 'b3', '');
  assert.equal(s.tasks.b3.status, 'running');
  bg.applyBackgroundLine(s, { type: 'queue-operation', isSidechain: true, operation: 'enqueue', content: note('b3') });
  assert.equal(s.tasks.b3.status, 'running');
  tool(s, 'TaskStop', { task_id: 'b3' }, 'No such task'); assert.equal(s.tasks.b3.status, 'running');
  tool(s, 'TaskStop', { task_id: 'b3' }, '{"message":"Successfully stopped task: b3"}'); assert.equal(s.tasks.b3.status, 'stopped');
  tool(s, ...launches[4].slice(0, 3)); notification(s, 'a1', 'completed');
  tool(s, 'SendMessage', { to: 'a1' }, 'sent', 'send', 10); assert.equal(s.tasks.a1.status, 'running');
  notification(s, 'a1', 'completed', 'attachment', 11); assert.equal(s.tasks.a1.status, 'running');
  notification(s, 'a1', 'completed', 'queue-operation', 12); assert.equal(s.tasks.a1.status, 'completed');
  tool(s, ...launches[0].slice(0, 3)); tool(s, 'KillShell', { shell_id: 'b1' }, 'Successfully stopped task: b1'); assert.equal(s.tasks.b1.status, 'stopped');
});
test('wakeup cancellation, supersession and firing; cron never blocks ready', () => {
  const s = bg.createBackgroundState();
  tool(s, 'ScheduleWakeup', {}, 'Next wakeup scheduled for 15:47:00 (in 60s).', 'wake1');
  tool(s, 'ScheduleWakeup', {}, 'Next wakeup scheduled for 15:48:00 (in 120s).', 'wake2');
  assert.equal(s.tasks['wakeup:wake1'].status, 'stopped');
  tool(s, 'ScheduleWakeup', { stop: true }, 'Wakeup cancelled', 'cancel');
  assert.equal(bg.backgroundSnapshot(s).outstanding.length, 0);
  tool(s, 'ScheduleWakeup', {}, 'Next wakeup scheduled for 15:48:00 (in 10s).', 'wake3');
  bg.applyBackgroundLine(s, { type: 'user', timestamp: stamp(20), message: { content: 'Wake up' } });
  assert.equal(s.tasks['wakeup:wake3'].status, 'completed');
  tool(s, 'CronCreate', {}, 'Scheduled recurring job 92eedefc (Every 3 hours at :51).');
  assert.equal(bg.backgroundSnapshot(s).outstanding.length, 0);
});
test('synthetic transcript retains only the final pending task', () => {
  const file = path.join(__dirname, '../fixtures/delegations/parent.jsonl');
  const s = bg.createBackgroundState();
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    if (!bg.interestingLine(line)) continue;
    const row = JSON.parse(line);
    bg.applyBackgroundLine(s, row);
  }
  assert.deepEqual(bg.backgroundSnapshot(s).outstanding.map((task) => task.id), ['pending']);
  assert.ok(Object.values(s.tasks).filter((task) => task.id !== 'pending').every((task) => bg.TERMINAL.has(task.status)));
  assert.equal(s.tasks['early-task'].status, 'completed');
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-delegations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('lineage parses all 13 synthetic metadata payloads and reads beyond a fixed head', async (t) => {
  const metas = fs.readFileSync(path.join(__dirname, '../fixtures/delegations/family.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const kinds = metas.map((r) => codexLineage(r.payload));
  assert.equal(kinds.filter((r) => r.kind === 'exec').length, 1);
  assert.equal(kinds.filter((r) => r.kind === 'subagent').length, 3);
  assert.equal(kinds.filter((r) => r.kind === 'guardian').length, 9);
  assert.equal(new Set(kinds.map((r) => r.rootId)).size, 1);
  assert.equal(kinds.filter((r) => r.kind !== 'exec').every((r) => r.parentThreadId), true);
  assert.equal(kinds[1].nickname, 'Worker 2'); assert.equal(kinds[1].agentPath, '/root/check2');
  assert.equal(kinds[1].role, 'reviewer'); assert.equal(kinds[1].originator, 'sample_cli');
  assert.equal(metas[4].payload.forked_from_id, metas[1].payload.id);
  const file = path.join(fixture(t), 'rollout.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { base_instructions: 'x'.repeat(350000), ...metas[0].payload } }) + '\n');
  assert.deepEqual((await readCodexRolloutMeta(file)).lineage, kinds[0]);
  assert.equal(codexLineage({ source: { subagent: { other: 'custom' } } }).kind, 'subagent.custom');
});
const rootId = '00000000-0000-4000-8000-000000000001';
function parent(command, id = 'task', startedMs = 1000) { return { id: 'parent', isLive: true, cwd: 'C:\\dev\\project', title: 'Parent', background: { tasks: [{ id, command, startedMs, lastSignalMs: startedMs, status: 'running', description: 'Review code', kind: 'command', blocking: true }] } }; }
function root(id = rootId, startedMs = 3697) { return { id, provider: 'codex', cwd: 'c:/DEV/project', lineage: { kind: 'exec', startedMs }, signal: { working: true, lastSignalMs: 5000 } }; }
test('dispatch grammar handles launch aliases, wrappers, prefixes and exact resume', () => {
  for (const command of ['codex exec "Review"', 'codex e "Review"', 'CODEX_HOME="C:\\home" codex exec -C "C:\\dev\\project" "Review"', 'cd /c/dev/project; X=1; codex exec "Review"', 'bash -c \'codex exec "Review"\'', 'node C:/tools/astra-run/astra-run.mjs --cd C:/dev/project "Review"', 'astra-run --cd C:/dev/project "Review"']) {
    const p = parent(command); const d = dispatchFor(p.background.tasks[0], p.cwd); assert.equal(d.provider, 'codex', command); assert.equal(d.prompt, 'Review');
  }
  assert.equal(dispatchFor(parent('echo "codex exec review"').background.tasks[0], ''), null);
  const p = parent(`codex exec resume ${rootId} "Round 2"`);
  assert.equal(linkDispatches([p], []).dispatches[0].childId, rootId);
  for (const [command, provider] of [['claude -p "Review"', 'claude'], ['cursor-agent --print "Review"', 'cursor']]) assert.equal(linkDispatches([parent(command)], [root()]).dispatches[0].provider, provider);
});
test('fresh dispatch uses cwd plus bounded time, refuses ambiguity, and claims each root once', () => {
  const p = parent('codex exec "Review"');
  assert.equal(linkDispatches([p], [root()]).dispatches[0].childId, rootId);
  assert.equal(linkDispatches([p], [root(rootId, 32000)]).dispatches[0].childId, undefined);
  assert.equal(linkDispatches([p], [{ ...root(), cwd: 'C:/elsewhere' }]).dispatches[0].childId, undefined);
  assert.equal(linkDispatches([p], [root(), root('another', 3697)]).dispatches[0].childId, undefined);
  p.background.tasks.push({ ...p.background.tasks[0], id: 'second', startedMs: 2000 });
  assert.equal(linkDispatches([p], [root()]).dispatches.filter((d) => d.childId).length, 1);
});
test('groups retain resume rounds, child lineage, terminal outcomes, quiet ages and recent visibility', () => {
  const p = parent('codex exec "Review"'); p.background.tasks[0].status = 'completed'; p.background.tasks[0].endedMs = 6000;
  p.background.tasks.push({ ...p.background.tasks[0], id: 'resume', command: `codex exec resume ${rootId} "Round two"`, startedMs: 7000, endedMs: null, status: 'running' });
  const providers = [root(), { ...root('child'), title: 'Ohm (/root/test)', lineage: { kind: 'subagent', parentThreadId: rootId } }, { ...root('guard'), lineage: { kind: 'guardian', parentThreadId: 'child' } }];
  const group = buildDelegationGroups([p], providers, 700000).groups[0];
  assert.equal(group.agents.length, 1); assert.equal(group.agents[0].rounds.length, 2); assert.equal(group.agents[0].state, 'quiet');
  assert.equal(group.agents[0].children[0].children[0].kind, 'guardian'); assert.equal(group.visible, true);
  p.background.tasks[1].status = 'failed';
  assert.equal(buildDelegationGroups([p], providers, 800000).groups[0].visible, false);
});
test('incremental scanner preserves prefix work, split UTF-8 and truncation; worker agrees', async (t) => {
  const dir = fixture(t); const file = path.join(dir, 'parent.jsonl'); const scan = createScanner();
  const rows = [
    { type: 'assistant', timestamp: stamp(0), message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { description: 'Résumé', command: 'codex exec review' } }] } },
    { type: 'user', timestamp: stamp(1), message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Command running in background with ID: old.' }] } },
  ];
  const full = Buffer.from(rows.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(file, full.subarray(0, 120)); await scan(file);
  fs.appendFileSync(file, full.subarray(120));
  fs.appendFileSync(file, JSON.stringify({ padding: 'x'.repeat(1200000) }) + '\n');
  assert.equal(bg.backgroundSnapshot((await scan(file)).state).outstanding[0].description, 'Résumé');
  const index = createDelegationIndex(); t.after(() => index.close());
  const result = await index.scan([{ id: 'parent', path: file, lastActive: new Date().toISOString() }]);
  assert.equal(result.parents[0].background.outstanding[0].id, 'old');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'new' } }) + '\n');
  assert.equal(bg.backgroundSnapshot((await scan(file)).state).outstanding.length, 0);
});
test('run states and attention agree on blocked, working, background, ready and dead', () => {
  const session = { isLive: true, background: { outstanding: [{ kind: 'agent', description: 'Review', startedMs: 1000 }] } };
  assert.equal(runStateCue(session, null, { blocked: true }).kind, 'blocked');
  assert.equal(runStateCue(session, null, { working: true }).kind, 'running');
  assert.equal(runStateCue(session, null, { working: false }).label, 'waiting on 1 agent');
  assert.equal(runStateCue({ ...session, isLive: false }, null, { processAlive: false, working: true }), null);
  assert.equal(runStateCue({ isLive: true }, null, {}).kind, 'ready');
  const descriptor = { id: 'a', background: true, activeMs: 200, isHistorical: true, open: true };
  const store = { seededAtMs: 100, seen: {} };
  assert.equal(attentionFor(descriptor, store), null); assert.equal(badgeCounts([descriptor], store).total, 0);
  assert.equal(attentionFor({ ...descriptor, background: false }, store), 'finished');
});
test('notifier defers the idle event until background and the final turn end', () => {
  let state = { background: true }; const toasts = [];
  const notifier = createNotifier({ getPaneState: () => state, notify: (...args) => toasts.push(args) });
  notifier.seedFromSnapshot({ panes: [{ pane_id: 'p', agent_status: 'working' }] });
  notifier.onAgentStatusChanged({ data: { pane_id: 'p', agent_status: 'idle' } }); notifier._flushNow(); assert.equal(toasts.length, 0);
  state = { working: true }; notifier.onBackgroundChanged(); notifier._flushNow(); assert.equal(toasts.length, 0);
  state = {}; notifier.onBackgroundChanged(); notifier._flushNow(); assert.equal(toasts.length, 1); notifier.destroy();
});
test('titler pins inexpensive argv, empty cwd, OAuth key stripping and transcript disposal', async (t) => {
  const root = fixture(t); const home = path.join(root, 'home'); let invocation;
  const result = await runClaudeTitle({ claudeBin: 'fixture', mcpConfig: path.join(root, 'empty.json'), cacheDir: root, prompt: 'You name terminal coding sessions. Review agents.',
    env: { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'not-forwarded', ANTHROPIC_AUTH_TOKEN: 'not-forwarded' },
    spawnImpl(bin, args, options) {
      invocation = { bin, args, options };
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { write() {}, end() {} };
      const id = args[args.indexOf('--session-id') + 1]; const dir = path.join(home, 'projects', options.cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{}\n');
      queueMicrotask(() => { child.stdout.emit('data', 'Review Delegated Agents'); child.emit('close', 0); }); return child;
    },
  });
  assert.equal(result.text, 'Review Delegated Agents');
  for (const flag of ['--tools', '--setting-sources']) assert.equal(invocation.args[invocation.args.indexOf(flag) + 1], '');
  assert.ok(invocation.args.includes('--disable-slash-commands')); assert.ok(invocation.args.includes('--system-prompt')); assert.ok(!invocation.args.includes('--bare'));
  assert.equal(invocation.options.cwd, path.join(root, 'titler-empty')); assert.deepEqual(fs.readdirSync(invocation.options.cwd), []);
  assert.equal(invocation.options.env.ANTHROPIC_API_KEY, undefined); assert.equal(invocation.options.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(invocation.options.env.MAX_THINKING_TOKENS, '0');
  assert.equal(fs.readdirSync(path.join(home, 'projects'), { recursive: true }).filter((p) => p.endsWith('.jsonl')).length, 0);
});

test('quoted launch output and a refused SendMessage cannot create outstanding work', () => {
  const s = bg.createBackgroundState();
  tool(s, 'Bash', { command: 'cat captured.log' }, 'Old captured result: Command running in background with ID: phantom.');
  assert.equal(bg.backgroundSnapshot(s).outstanding.length, 0);
  tool(s, ...launches[4].slice(0, 3)); notification(s, 'a1', 'completed');
  bg.applyBackgroundLine(s, { type: 'assistant', timestamp: stamp(10), message: { content: [{ type: 'tool_use', name: 'SendMessage', id: 'bad', input: { to: 'a1' } }] } });
  bg.applyBackgroundLine(s, { type: 'user', timestamp: stamp(11), message: { content: [{ type: 'tool_result', tool_use_id: 'bad', is_error: true, content: 'No such agent' }] } });
  assert.equal(s.tasks.a1.status, 'completed');
});

test('exact resume evidence outranks another parents earlier heuristic claim', () => {
  const a = parent('codex exec "A"'); a.id = 'A';
  const b = parent('codex exec "B"', 'fresh-b', 2000); b.id = 'B';
  b.background.tasks.push({ ...b.background.tasks[0], id: 'resume-b', command: `codex exec resume ${rootId} "Again"`, startedMs: 5000 });
  const result = linkDispatches([a, b], [root()]);
  assert.equal(result.delegatedBy[rootId], 'B');
  assert.equal(result.dispatches[0].childId, undefined);
  assert.equal(result.dispatches.filter((d) => d.childId === rootId).length, 2);
  a.background.tasks[0].command = `codex exec resume ${rootId} "Conflict"`;
  assert.equal(linkDispatches([a, b], [root()]).delegatedBy[rootId], undefined);
});

test('final working and idle events yield exactly one finish after background clears', () => {
  let state = { background: true }; const toasts = [];
  const n = createNotifier({ getPaneState: () => state, notify: (...args) => toasts.push(args) });
  const event = (status) => n.onAgentStatusChanged({ data: { pane_id: 'p', agent_status: status, title: 'Parent' } });
  event('working'); event('idle'); event('working'); state = {}; n.onBackgroundChanged(); event('idle'); n._flushNow(); n.onBackgroundChanged(); n._flushNow();
  assert.deepEqual(toasts, [['Harbor', 'Parent finished']]); n.destroy();
});

test('sidebar twins hide delegated history, retain live panes and expose search results', () => {
  const vm = require('node:vm'); const esbuild = require('esbuild');
  const mod = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared/sidebar-model.js'), 'utf8');
  vm.runInNewContext(esbuild.transformSync(source, { format: 'cjs' }).code, { module: mod, exports: mod.exports, require: () => require('../../src/shared/date-roll.cjs') });
  for (const impl of [require('../../src/shared/sidebar-model.cjs'), mod.exports]) {
    const sessions = [{ id: 'parent' }, { id: 'child', delegatedBy: 'parent' }, { id: 'live-child', delegatedBy: 'parent', isLive: true }, { id: 'unlinked' }, { id: 'batch', isChildTask: true, isLive: true }];
    const model = { projects: [{ label: 'project', sessions }] };
    const ids = (children) => Array.from(impl.flattenSidebarRows(model, { includeChildren: children }).rows.filter((r) => r.kind === 'session'), (r) => r.session.id);
    assert.deepEqual(ids(false), ['parent', 'live-child', 'unlinked']);
    assert.equal(ids(true).length, 5);
  }
});

test('bridge expires orphan groups from memory and retains linked identity past 48h and restart', async (t) => {
  const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');
  const p = parent(`codex exec resume ${rootId} "Review"`); p.background.tasks[0].lastSignalMs = Date.now();
  const provider = root(); provider.signal.lastSignalMs = Date.now();
  const store = path.join(fixture(t), 'links.json');
  let evidence = { parents: [p], providers: [provider] };
  const history = new EventEmitter(); history.listSessions = async () => structuredClone([p, provider]); history.sessionHomes = async () => ({});
  let scannedRows;
  const options = { history, providerHistory: null, providerSessionLinker: null, delegationLinksFile: store, delegationIndex: { scan: async (rows) => { scannedRows = rows; return evidence; }, close() {} } };
  const bridge = createSidebarBridge(options); t.after(() => bridge.close());
  await bridge.refreshHistory(); assert.equal(bridge.isDelegated(rootId), true); assert.equal(bridge.listDelegations()[0].agents[0].state, 'running');
  const realNow = Date.now; Date.now = () => realNow() + 700000;
  try { assert.equal(bridge.listDelegations()[0].agents[0].state, 'ended'); assert.equal(bridge.listDelegations()[0].active, false); } finally { Date.now = realNow; }
  evidence = { parents: [], providers: [provider] }; await bridge.refreshDelegations(); assert.equal(bridge.isDelegated(rootId), true);
  const restarted = createSidebarBridge(options); t.after(() => restarted.close()); await restarted.refreshHistory(); assert.equal(restarted.isDelegated(rootId), true);
  assert.equal(scannedRows.find(row => row.id === rootId).delegatedBy, p.id, 'the first scan receives the persisted exact link');
});

test('fresh rollout writes keep a running turn active between task events', () => {
  const p = parent(`codex exec resume ${rootId} "Review"`);
  const r = { ...root(), lastWriteMs: 900000 };
  const group = buildDelegationGroups([p], [r], 900000).groups[0];
  assert.equal(group.agents[0].state, 'running'); assert.equal(group.agents[0].lastSignalMs, 900000);
});

test('desktop and phone cache updates preserve each others delegation identities', async (t) => {
  const { mergeDelegationLinks } = require('../../src/main/providers/delegations.js');
  const file = path.join(fixture(t), 'links.json');
  await Promise.all([mergeDelegationLinks(file, { a: 'parent-a' }), mergeDelegationLinks(file, { b: 'parent-b' })]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).links, { a: 'parent-a', b: 'parent-b' });
  assert.deepEqual(await mergeDelegationLinks(file, { a: null }), { b: 'parent-b' });
});

test('phone browser consumes the same working and background precedence during daemon lag', () => {
  const vm = require('node:vm'); const esbuild = require('esbuild'); const mod = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../../web/src/browse/rows.js'), 'utf8');
  vm.runInNewContext(esbuild.transformSync(source, { format: 'cjs' }).code, { module: mod, exports: mod.exports,
    require: (id) => id.includes('session-run-state') ? require('../../src/shared/session-run-state.cjs') : require('../../src/shared/sidebar-model.cjs') });
  const session = { isLive: true, agentStatus: 'idle', background: { working: true, lastInTurnMs: Date.now(), outstanding: [{ id: 'task', kind: 'agent' }] } };
  assert.equal(mod.exports.sessionState(session), 'working');
  session.background.working = false; assert.equal(mod.exports.sessionState(session), 'background');
  session.agentStatus = 'blocked'; assert.equal(mod.exports.sessionState(session), 'needs-answer');
  session.isLive = false; assert.equal(mod.exports.sessionState(session), 'idle');
});

test('a fast task completion arriving before its launch result is retained', () => {
  const s = bg.createBackgroundState();
  bg.applyBackgroundLine(s, { type: 'assistant', timestamp: stamp(0), message: { content: [{ type: 'tool_use', name: 'Bash', id: 'fast', input: { command: 'echo done' } }] } });
  notification(s, 'fast-task', 'completed', 'queue-operation', 1);
  bg.applyBackgroundLine(s, { type: 'user', timestamp: stamp(2), message: { content: [{ type: 'tool_result', tool_use_id: 'fast', content: 'Command running in background with ID: fast-task.' }] } });
  assert.equal(s.tasks['fast-task'].status, 'completed'); assert.equal(bg.backgroundSnapshot(s).outstanding.length, 0);
});

const turnEndings = [
  ...['end_turn', 'stop_sequence', 'refusal', 'max_tokens'].map((stop_reason) => ({ type: 'assistant', message: { stop_reason, content: [] } })),
  { type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [] } },
  { type: 'system', subtype: 'api_error' },
  ...['[Request interrupted by user]', '[Request interrupted by user for tool use]', '<local-command-stdout>Model set</local-command-stdout>', 'This session is being continued from a previous conversation.'].map((text) => ({ type: 'user', message: { content: text } })),
  { type: 'user', isCompactSummary: true, message: { content: 'Summary' } },
];
for (const [index, ending] of turnEndings.entries()) test(`fold and transcript agree on turn ending ${index}`, () => {
  const { TranscriptParser } = require('../../src/main/providers/transcript.js');
  for (const asParts of [false, true]) {
    const s = bg.createBackgroundState(); const parser = new TranscriptParser();
    const start = { type: 'user', timestamp: stamp(0), message: { content: 'Work' } };
    bg.applyBackgroundLine(s, start); parser.applyLine(start);
    const row = { ...structuredClone(ending), timestamp: stamp(1) };
    if (asParts && typeof row.message?.content === 'string') row.message.content = [{ type: 'text', text: row.message.content }];
    assert.equal(bg.interestingLine(JSON.stringify(row)), true);
    bg.applyBackgroundLine(s, row); parser.applyLine(row);
    assert.equal(bg.backgroundSnapshot(s, 102000).working, false);
    assert.equal(parser.workingState(101000, 102000, true).working, false);
  }
});
test('meta and sidechain rows cannot open or end the parent turn', () => {
  for (const flag of ['isMeta', 'isSidechain']) for (const working of [false, true]) {
    const s = bg.createBackgroundState(); s.working = working; s.lastInTurnMs = 100000;
    bg.applyBackgroundLine(s, { type: 'user', [flag]: true, timestamp: stamp(1), message: { content: 'Hidden instructions' } });
    assert.equal(s.working, working); assert.equal(s.lastInTurnMs, 100000);
  }
});
test('fold working expires on every consumer without a new transcript write', () => {
  const { ageDelegationGroups } = require('../../src/main/providers/delegations.js');
  const s = bg.createBackgroundState(); bg.applyBackgroundLine(s, { type: 'user', timestamp: stamp(0), message: { content: 'Work' } });
  const fresh = bg.backgroundSnapshot(s, 101000);
  assert.equal(fresh.working, true); assert.equal(bg.backgroundSnapshot(s, 700000).working, false);
  const p = parent('codex exec "Review"'); Object.assign(p.background, fresh, { tasks: p.background.tasks });
  assert.equal(runStateCue({ isLive: true, background: fresh }, null, {}, 101000).kind, 'running');
  assert.equal(runStateCue({ isLive: true, background: fresh }, null, {}, 700000).kind, 'ready');
  const group = buildDelegationGroups([p], [root()], 101000).groups[0]; assert.equal(group.state, 'working');
  assert.equal(ageDelegationGroups([group], 700000)[0].state, 'background');
  notification(s, 'unknown', 'completed', 'queue-operation', 500);
  assert.equal(bg.backgroundSnapshot(s, 601000).working, false);
});
test('bash double-quote escapes and literal single quotes link Windows cwd', () => {
  const { shellWords, canonicalCwd } = require('../../src/main/providers/delegations.js');
  const command = String.raw`node C:/tools/astra-run/astra-run.mjs --cd "C:\\dev\\project" "Review"`;
  assert.equal(linkDispatches([parent(command)], [root()]).dispatches[0].childId, rootId);
  assert.deepEqual(shellWords('"a\\\\b\\"c\\$d\\`e\\q"'), ['a\\b"c$d`e\\q']);
  assert.deepEqual(shellWords("'a\\'b"), ['a\\b']);
  assert.deepEqual(shellWords('"a\\\nb"'), ['ab']);
  assert.equal(canonicalCwd('C:\\\\dev////project/'), canonicalCwd('c:/dev/project'));
});
test('finished unlinked launch remains a command outcome, never a claimed agent', () => {
  const p = parent('astra-run "Review"'); Object.assign(p.background.tasks[0], { status: 'failed', endedMs: 2000 });
  const group = buildDelegationGroups([p], [root()], 5000).groups[0];
  assert.equal(group.agents.length, 0); assert.equal(group.tasks[0].status, 'failed');
  p.background.tasks.push({ ...p.background.tasks[0], id: 'retry', startedMs: 3000, endedMs: 8000, status: 'completed' });
  const retried = buildDelegationGroups([p], [root()], 9000).groups[0];
  assert.equal(retried.agents[0].rounds[0].id, 'retry'); assert.equal(retried.tasks[0].id, 'task');
});
test('descendant and reviewer signals keep each ancestor active, unrelated families do not', () => {
  const p = parent(`codex exec resume ${rootId} "Review"`);
  const providers = [root(), { ...root('child'), lineage: { kind: 'subagent', parentThreadId: rootId } },
    { ...root('review'), lastWriteMs: 899000, lineage: { kind: 'guardian', parentThreadId: 'child' } },
    { ...root('unrelated'), lastWriteMs: 900000 }];
  const agent = buildDelegationGroups([p], providers, 900000).groups[0].agents[0];
  assert.equal(agent.state, 'running'); assert.equal(agent.lastSignalMs, 899000);
  assert.equal(agent.children[0].state, 'running'); assert.equal(agent.children[0].lastSignalMs, 899000);
  providers[2].lastWriteMs = 0;
  assert.equal(buildDelegationGroups([p], providers, 900000).groups[0].agents[0].state, 'quiet');
  providers[2].lineage.parentThreadId = 'review';
  assert.equal(buildDelegationGroups([p], providers, 900000).groups[0].agents[0].children.length, 1);
});
test('synthetic rollout events preserve completed and aborted rounds', async (t) => {
  const file = path.join(fixture(t), 'rollout.jsonl'); const scan = createScanner();
  const events = fs.readFileSync(path.join(__dirname, '../fixtures/delegations/events.jsonl'), 'utf8').trim().split('\n');
  fs.writeFileSync(file, events.slice(0, 5).join('\n') + '\n');
  assert.equal((await scan(file, 'codex')).signal.outcome, 'done');
  fs.appendFileSync(file, events.slice(5).join('\n') + '\n');
  assert.equal((await scan(file, 'codex')).signal.outcome, 'stopped');
});
test('legacy and paginated inherited history cannot become a delegated title', async (t) => {
  const { createProviderHistory } = require('../../src/main/providers/provider-history.js');
  const dir = fixture(t); const codexRoot = path.join(dir, 'sessions'); const day = path.join(codexRoot, '2026', '01', '01'); fs.mkdirSync(day, { recursive: true });
  const metas = fs.readFileSync(path.join(__dirname, '../fixtures/delegations/family.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const events = fs.readFileSync(path.join(__dirname, '../fixtures/delegations/events.jsonl'), 'utf8').trim().split('\n');
  for (const n of [1, 4]) fs.writeFileSync(path.join(day, `rollout-${metas[n].payload.id}.jsonl`), [JSON.stringify(metas[n]), events[n === 1 ? 2 : 3]].join('\n') + '\n');
  const history = createProviderHistory({ codexRoot, cursorRoot: path.join(dir, 'cursor'), metadataFile: path.join(dir, 'metadata.json') }); t.after(() => history.close());
  const rows = await history.listSessions();
  assert.equal(rows.find((r) => r.id === metas[1].payload.id).title, 'Worker 2 (/root/check2)');
  assert.equal(rows.find((r) => r.id === metas[4].payload.id).title, 'approval review');
});
test('tooltip ages below one minute are explicit', () => {
  assert.match(runStateCue({ isLive: true, background: { outstanding: [{ description: 'Build', kind: 'command', startedMs: 100000 }] } }, null, {}, 101000).tooltip, /<1m/);
});

test('bridge id map follows replacement and removal and expires toast holds', async (t) => {
  const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');
  const now = Date.now();
  let rows = [{ id: 'child', lineage: { parentThreadId: 'parent' } }];
  let evidence = { parents: [{ id: 'child', background: { working: true, lastInTurnMs: now, tasks: [] } }], providers: [] };
  const history = new EventEmitter(); history.listSessions = async () => structuredClone(rows); history.sessionHomes = async () => ({});
  const subscription = new EventEmitter(); subscription.close = () => {};
  const bridge = createSidebarBridge({ history, providerHistory: null, providerSessionLinker: null,
    delegationLinksFile: path.join(fixture(t), 'links.json'), delegationIndex: { scan: async () => evidence, close() {} },
    createControlClient: () => ({ bootstrap: async () => ({ subscription, snapshot: { panes: [{ pane_id: 'pane', agent: 'claude', agent_status: 'idle', agent_session: { value: 'child' } }] } }) }),
  });
  t.after(() => bridge.close()); await bridge.start();
  assert.equal(bridge.isDelegated('child'), true); assert.equal(bridge.isDelegatedPane('pane'), true);
  rows = [{ id: 'child' }]; await bridge.refreshHistory();
  assert.equal(bridge.isDelegated('child'), false); assert.equal(bridge.isDelegatedPane('pane'), false);
  const toasts = []; const notifier = createNotifier({ getPaneState: () => bridge.notificationState('pane'), notify: (...args) => toasts.push(args) });
  t.after(() => notifier.destroy());
  notifier.seedFromSnapshot({ panes: [{ pane_id: 'pane', agent_status: 'working' }] });
  notifier.onAgentStatusChanged({ data: { pane_id: 'pane', agent_status: 'idle' } }); notifier._flushNow();
  assert.equal(toasts.length, 0);
  const realNow = Date.now; Date.now = () => now + 700000;
  try { assert.equal(bridge.notificationState('pane').working, false); notifier.onBackgroundChanged(); notifier._flushNow(); assert.equal(toasts.length, 1); } finally { Date.now = realNow; }
  evidence = { parents: [], providers: [] }; rows = [];
  await bridge.refreshHistory(); assert.equal(bridge.isDelegated('child'), false); assert.equal(bridge.notificationState('pane').working, false);
});

function orphanParent() {
  return { id: 'orphan-parent', isLive: false, ownerEvidence: { lastWriteMs: 100000 }, background: {
    working: false, lastSignalMs: 100000, tasks: ['monitor', 'command'].map((kind) => ({ id: kind, kind, description: `Sample ${kind}`, status: 'running', blocking: true, startedMs: 90000, lastSignalMs: 100000 })),
  } };
}
test('dead parent tasks end with their owner and expire from the overview', () => {
  const p = orphanParent(); const group = buildDelegationGroups([p], [], 900000).groups[0];
  assert.equal(group.parentAlive, false); assert.equal(group.active, false); assert.equal(group.visible, false);
  assert.equal(group.state, 'done'); assert.deepEqual(group.tasks.map((t) => t.status), ['ended with session', 'ended with session']);
  assert.equal(p.background.tasks[0].status, 'running', 'the transcript fold stays factual');
  p.isLive = true;
  const live = buildDelegationGroups([p], [], 900000).groups[0];
  assert.equal(live.active, true); assert.equal(live.visible, true); assert.equal(live.tasks[0].status, 'running');
});
test('cached groups recheck pane ownership and both transcript and beacon clocks', () => {
  const { ageDelegationGroups } = require('../../src/main/providers/delegations.js');
  const { sessionLiveOwned } = require('../../src/shared/session-run-state.cjs');
  const p = orphanParent();
  const fresh = buildDelegationGroups([p], [], 110000).groups;
  assert.equal(fresh[0].active, true);
  assert.equal(ageDelegationGroups(fresh, 900000)[0].visible, false);
  p.isLive = true;
  const owned = buildDelegationGroups([p], [], 900000).groups;
  assert.equal(ageDelegationGroups(owned, 900000, [p.id])[0].active, true);
  assert.equal(ageDelegationGroups(owned, 900000, [])[0].active, false);
  assert.equal(ageDelegationGroups(fresh, 900000, [p.id])[0].active, true);
  p.isLive = false;
  for (const evidence of [{ lastWriteMs: 850000 }, { lastWriteMs: 100000, beaconMs: 850000 }, { lastWriteMs: 700000, beaconMs: 100000 }, { lastWriteMs: 850000, processAlive: false }, { lastWriteMs: 100000, processAlive: true }]) {
    p.ownerEvidence = evidence;
    assert.equal(buildDelegationGroups([p], [], 900000).groups[0].parentAlive, sessionLiveOwned(p, null, evidence, 900000));
  }
});
test('orphaned linked agent keeps fresh and terminal evidence but expires silence', () => {
  const p = parent(`codex exec resume ${rootId} "Review"`); p.isLive = false; p.ownerEvidence = { lastWriteMs: 100000 };
  // A parent completion from an earlier round cannot veto an independently
  // writing child after that parent exits.
  Object.assign(p.background.tasks[0], { status: 'completed', endedMs: 200000 });
  const r = { ...root(), lastWriteMs: 899000 };
  let group = buildDelegationGroups([p], [r], 900000).groups[0];
  assert.equal(group.agents[0].state, 'running'); assert.equal(group.active, true); assert.equal(group.visible, true);
  r.lastWriteMs = 100000;
  group = buildDelegationGroups([p], [r], 900000).groups[0];
  assert.equal(group.agents[0].state, 'ended'); assert.equal(group.active, false);
  r.signal = { working: false, endedMs: 100000, lastSignalMs: 100000, outcome: 'done' };
  group = buildDelegationGroups([p], [r], 900000).groups[0];
  assert.equal(group.agents[0].state, 'done'); assert.equal(group.active, false); assert.equal(group.visible, false);
});
test('unlinked dispatch under a dead parent is ended, never an independent agent', () => {
  const p = parent('codex exec "Review"'); p.isLive = false; p.ownerEvidence = { lastWriteMs: 100000 };
  const group = buildDelegationGroups([p], [], 900000).groups[0];
  assert.equal(group.agents[0].state, 'ended with session'); assert.equal(group.active, false); assert.equal(group.visible, false);
});
test('worker uses transcript mtime, beacons and live ids without an open window', async (t) => {
  const { scanRows } = require('../../src/main/providers/delegations-worker.js');
  const dir = fixture(t); const p = orphanParent(); const file = path.join(dir, 'parent.jsonl');
  fs.writeFileSync(file, [
    { type: 'assistant', timestamp: stamp(0), message: { content: [{ type: 'tool_use', id: 'monitor-tool', name: 'Monitor', input: { description: 'Watch sample' } }] } },
    { type: 'user', timestamp: stamp(1), message: { content: [{ type: 'tool_result', tool_use_id: 'monitor-tool', content: 'Monitor started (task sample-watch, expires in 5m unless the source ends first;' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  fs.utimesSync(file, new Date(100000), new Date(100000));
  const row = { id: p.id, path: file, lastActive: new Date(100000).toISOString() };
  const ownerOptions = { homes: [dir], contextCacheDir: path.join(dir, 'context') };
  assert.equal((await scanRows([row], [], 900000, ownerOptions)).built.groups[0].active, false);
  assert.equal((await scanRows([row], [p.id], 900000, ownerOptions)).built.groups[0].active, true);
  fs.mkdirSync(path.join(dir, 'statusline-state'));
  const beacon = path.join(dir, 'statusline-state', `${p.id}.json`); fs.writeFileSync(beacon, '{}'); fs.utimesSync(beacon, new Date(899000), new Date(899000));
  const result = await scanRows([row], [], 900000, ownerOptions);
  assert.equal(result.built.groups[0].parentAlive, true);
  assert.equal(result.parents[0].ownerEvidence.beaconMs, 899000);
});
test('opaque shell dispatch scripts are not inferred from arguments or heredoc prompts', () => {
  const command = 'cat >> brief.md <<\'EOF\'\nReview the sample with codex exec\nEOF\nbash C:/temp/dispatch.sh r1 astra work xhigh';
  assert.equal(dispatchFor({ command }, 'C:/dev/sample'), null);
});
// 2026-10-07, Pat: "why does it say agents 0 running / 1 up top?" The header chip
// showed for every group on record, so one finished review kept a session saying
// "0 running / 1" for as long as the 48h window held it, while the overview the
// chip opens had dropped that group after ten minutes. The chip now follows the
// overview's visibility, aged at read time.
test('the header agents chip follows the overview: running or recently done, then gone without a rescan', () => {
  const { delegationSummaries } = require('../../src/main/providers/delegations.js');
  const quietRoot = { ...root(), signal: { working: false, lastSignalMs: 5000 } };
  const done = parent('codex exec "Review"'); done.background.tasks[0].status = 'completed'; done.background.tasks[0].endedMs = 6000;
  const groups = buildDelegationGroups([done], [quietRoot], 7000).groups;
  assert.deepEqual(delegationSummaries(groups, 7000, ['parent']).get('parent'), { total: 1, running: 0 }, 'just finished: shown');
  assert.deepEqual(delegationSummaries(groups, 300000, ['parent']).get('parent'), { total: 1, running: 0 }, 'inside ten minutes: shown');
  assert.equal(delegationSummaries(groups, 700000, ['parent']).has('parent'), false, 'past ten minutes: gone, from aging alone');
  // A busy parent makes its group active, but the chip is about the agents.
  const busy = parent('codex exec "Review"'); busy.background.tasks[0].status = 'completed'; busy.background.tasks[0].endedMs = 6000;
  busy.background.working = true; busy.background.lastInTurnMs = 699000;
  const busyGroups = buildDelegationGroups([busy], [quietRoot], 700000).groups;
  assert.equal(busyGroups[0].active, true, 'fixture: the parent turn keeps the group active');
  assert.equal(delegationSummaries(busyGroups, 700000, ['parent']).has('parent'), false, 'a mid-turn parent does not revive a finished agent');
  const working = parent('codex exec "Review"');
  const live = buildDelegationGroups([working], [{ ...root(), signal: { working: true, lastSignalMs: 5000 } }], 7000).groups;
  assert.deepEqual(delegationSummaries(live, 7000, ['parent']).get('parent'), { total: 1, running: 1 }, 'a running agent is counted');
});
