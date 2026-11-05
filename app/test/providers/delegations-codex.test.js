'use strict';
// Codex parity for the Orch delegation groups: Codex as a PARENT (its shell
// dispatches and its own subagents), honest turn ends (failed / stopped), the
// Codex 0.160 dispatch grammar, the child's result, and compressed children.
// Every record below is SYNTHETIC, shaped after the 0.160.0 rollout layout;
// no real rollout is copied.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const codexFiles = require('../../src/main/providers/codex-rollout-files.js');
const { createScanner, scanRows, commandText, startedThreadId } = require('../../src/main/providers/delegations-worker.js');
const { dispatchFor, linkDispatches, agentState, buildDelegationGroups } = require('../../src/main/providers/delegations.js');

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const PARENT = '20000000-0000-4000-8000-000000000001';
const CHILD = '20000000-0000-4000-8000-000000000002';
const SUB = '20000000-0000-4000-8000-000000000003';
const GUARD = '20000000-0000-4000-8000-000000000004';
const DONE = '30000000-0000-4000-8000-000000000002';
const FAILED = '30000000-0000-4000-8000-000000000003';
const CUT = '30000000-0000-4000-8000-000000000004';
const PLAIN = '30000000-0000-4000-8000-000000000005';
const noZstd = typeof zlib.zstdCompressSync !== 'function' && 'runtime has no zstd';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-codex-deleg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
function write(file, records, mtimeMs) {
  fs.writeFileSync(file, jsonl(records));
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}
function writeZst(file, records) {
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(jsonl(records))));
  fs.utimesSync(file, new Date(T0 + 60_000), new Date(T0 + 60_000));
  return file;
}
const ev = (ms, payload) => ({ timestamp: iso(ms), type: 'event_msg', payload });
function commandItem(ms, script, extra = {}) {
  return ev(ms, { type: 'item_completed', item: { type: 'CommandExecution', id: `item-${ms}`, command: ['/bin/zsh', '-lc', script],
    cwd: '/work/project', duration: { secs: 4, nanos: 500000000 }, exit_code: 0, aggregated_output: '', process_id: '4242',
    source: 'unified_exec_startup', status: 'completed', ...extra } });
}

test('a codex turn that ends in task_complete.error is failed, turn_aborted is stopped, and the result is kept', async (t) => {
  const file = path.join(tmp(t), 'rollout.jsonl'); const scan = createScanner();
  write(file, [
    ev(T0, { type: 'task_started' }),
    ev(T0 + 1000, { type: 'task_complete', last_agent_message: 'All four checks pass.', turn_id: 't1' }),
  ]);
  let signal = (await scan(file, 'codex')).signal;
  assert.equal(signal.outcome, 'done'); assert.equal(signal.result, 'All four checks pass.'); assert.equal(signal.error, null);
  fs.appendFileSync(file, [ev(T0 + 2000, { type: 'task_started' }),
    ev(T0 + 3000, { type: 'task_complete', last_agent_message: null, error: { message: 'stream disconnected', codex_error_info: {} } })]
    .map((r) => JSON.stringify(r)).join('\n') + '\n');
  signal = (await scan(file, 'codex')).signal;
  assert.equal(signal.outcome, 'failed', 'a failed turn is never "done"');
  assert.equal(signal.error, 'stream disconnected');
  assert.equal(signal.result, null, 'a new turn clears the previous turn result');
  fs.appendFileSync(file, [ev(T0 + 4000, { type: 'task_started' }), ev(T0 + 5000, { type: 'turn_aborted', reason: 'interrupted' })]
    .map((r) => JSON.stringify(r)).join('\n') + '\n');
  signal = (await scan(file, 'codex')).signal;
  assert.equal(signal.outcome, 'stopped'); assert.equal(signal.working, false);
});

test('the command can exit 0 around a failed child turn; the child outcome wins', () => {
  const task = { status: 'completed', startedMs: T0 };
  assert.equal(agentState(task, { signal: { endedMs: T0 + 10, working: false, outcome: 'failed' } }), 'failed');
  assert.equal(agentState(task, { signal: { endedMs: T0 + 10, working: false, outcome: 'stopped' } }), 'stopped');
  assert.equal(agentState(task, { signal: { endedMs: T0 + 10, working: false, outcome: 'done' } }), 'done');
  assert.equal(agentState({ status: 'failed', startedMs: T0 }, { signal: { endedMs: T0 + 10, outcome: 'done' } }), 'failed');
  assert.equal(agentState({ startedMs: T0 }, { signal: { endedMs: T0 + 10, working: false, outcome: 'failed' } }), 'failed');
});

test('codex shell dispatches are captured from CommandExecution items, with the --json thread id', async (t) => {
  const file = path.join(tmp(t), 'parent.jsonl'); const scan = createScanner();
  write(file, [
    commandItem(T0 + 5000, 'ls -la'),
    commandItem(T0 + 9000, `codex exec --json -s workspace-write "Review the parser" > out.jsonl`, {
      aggregated_output: `{"type":"thread.started","thread_id":"${CHILD}"}\n{"type":"turn.started"}\n` }),
    commandItem(T0 + 12000, 'claude -p "Summarise"', { exit_code: 1, status: 'failed' }),
  ]);
  const { commands } = (await scan(file, 'codex')).signal;
  assert.equal(commands.length, 2, 'only commands that can launch an agent are inventory');
  assert.equal(commands[0].threadId, CHILD);
  assert.equal(commands[0].startedMs, T0 + 9000 - 4500, 'start = completion minus duration');
  assert.equal(commands[0].endedMs, T0 + 9000); assert.equal(commands[0].status, 'completed');
  assert.equal(commands[1].status, 'failed'); assert.equal(commands[1].exitCode, 1);
  assert.equal(commandText(['/usr/bin/env', 'codex', 'exec', 'two words']), "/usr/bin/env codex exec 'two words'");
  assert.equal(startedThreadId('{"type":"turn.started"}'), null);
});

test('Codex 0.160 value flags never become the prompt; -i is multi-valued like clap', () => {
  const task = (command) => ({ id: 'c', command, startedMs: T0 });
  const flags = 'codex exec -p work --profile=x -m gpt-x --add-dir /extra --output-schema s.json --color never --thread-source user'
    + ' --local-provider ollama --enable fast --disable slow -a never -c k=v -s read-only -C /work/project "Review it"';
  const d = dispatchFor(task(flags), '/elsewhere');
  assert.equal(d.provider, 'codex'); assert.equal(d.prompt, 'Review it'); assert.equal(d.model, 'gpt-x'); assert.equal(d.cwd, '/work/project');
  // Measured with codex 0.160.0: `exec -i a.png "hello"` reads "hello" as a second image and asks stdin for a prompt.
  assert.equal(dispatchFor(task('codex exec -i a.png "Review it"'), '/w').prompt, '');
  assert.equal(dispatchFor(task('codex exec "Review it" -i a.png b.png'), '/w').prompt, 'Review it');
  // Claude's and Cursor's -p is --print and takes no value.
  assert.equal(dispatchFor(task('claude -p "Review it"'), '/w').prompt, 'Review it');
  assert.equal(dispatchFor(task('cursor-agent -p "Review it"'), '/w').prompt, 'Review it');
  // zsh -lc wrappers unwrap like bash -c.
  assert.equal(dispatchFor(task(`zsh -lc 'codex exec "Inner"'`), '/w').prompt, 'Inner');
  const fork = dispatchFor(task(`codex exec fork ${PARENT} "Try again"`), '/w');
  assert.equal(fork.forkOf, PARENT); assert.equal(fork.prompt, 'Try again'); assert.equal(fork.resumeId, null);
  const out = dispatchFor(task('codex exec --ephemeral --worktree -o last.txt "Go"'), '/w');
  assert.deepEqual([out.ephemeral, out.worktree, out.outputFile, out.prompt], [true, true, 'last.txt', 'Go']);
});

function codexParent(command, extra = {}) {
  return { id: 'claude-parent', isLive: true, cwd: '/work/project', title: 'Parent', background: { tasks: [
    { id: 'task', command, cwd: '/work/project', startedMs: T0, endedMs: T0 + 20000, lastSignalMs: T0 + 20000, status: 'completed', description: 'Dispatch', kind: 'command', ...extra }] } };
}
const execRoot = (id, startedMs, lineage = {}) => ({ id, provider: 'codex', cwd: '/work/project', title: id, lineage: { kind: 'exec', startedMs, parentThreadId: null, forkedFromId: null, ...lineage }, signal: {} });

test('ephemeral and worktree children are marked unlinkable instead of guessed; fork links to its exact source', () => {
  const roots = [execRoot(CHILD, T0 + 2000)];
  const ephemeral = linkDispatches([codexParent('codex exec --ephemeral "Go"')], roots).dispatches[0];
  assert.equal(ephemeral.childId, undefined); assert.equal(ephemeral.unlinkable, 'ephemeral');
  const worktree = linkDispatches([codexParent('codex exec --worktree "Go"')], roots).dispatches[0];
  assert.equal(worktree.childId, undefined, 'a same-cwd root is not proof for a managed worktree child'); assert.equal(worktree.unlinkable, 'worktree');
  const group = buildDelegationGroups([codexParent('codex exec --ephemeral "Go"')], roots, T0 + 30000).groups[0];
  assert.equal(group.tasks[0].note, 'no transcript (--ephemeral)');
  const forkCmd = `codex exec fork ${PARENT} "Again"`;
  assert.equal(linkDispatches([codexParent(forkCmd)], [execRoot(CHILD, T0 + 2000, { forkedFromId: 'someone-else' })]).dispatches[0].childId, undefined);
  assert.equal(linkDispatches([codexParent(forkCmd)], [execRoot(CHILD, T0 + 2000, { forkedFromId: PARENT })]).dispatches[0].childId, CHILD);
});

test('a codex parent gets an Orch group: shell dispatches, its subagents, a reviewer count, results and failures', async (t) => {
  const dir = tmp(t);
  const now = T0 + 60_000;
  const parentFile = write(path.join(dir, 'parent.jsonl'), [
    { timestamp: iso(T0), type: 'session_meta', payload: { id: PARENT, cwd: '/work/project', source: 'cli' } },
    ev(T0 + 100, { type: 'task_started' }),
    commandItem(T0 + 9000, 'codex exec --json "Review the parser"', { aggregated_output: `{"type":"thread.started","thread_id":"${CHILD}"}\n` }),
    commandItem(T0 + 9500, 'codex exec --ephemeral -o last.txt "Quick look"'),
    ev(T0 + 30000, { type: 'task_complete', last_agent_message: 'Dispatched.' }),
  ], now - 1000);
  const childFile = write(path.join(dir, 'child.jsonl'), [
    ev(T0 + 5000, { type: 'task_started' }),
    ev(T0 + 8000, { type: 'task_complete', last_agent_message: null, error: { message: 'usage limit reached' } }),
  ], now - 2000);
  const subFile = write(path.join(dir, 'sub.jsonl'), [
    ev(T0 + 6000, { type: 'task_started' }), ev(T0 + 7000, { type: 'task_complete', last_agent_message: 'Found two bugs.' }),
  ], now - 3000);
  const guardFile = write(path.join(dir, 'guard.jsonl'), [ev(T0 + 6500, { type: 'task_complete' })], now - 3000);
  // The -o file was written during the ephemeral run: its bytes are the result.
  const outFile = path.join(dir, 'last.txt'); fs.writeFileSync(outFile, 'Looks fine.\n'); fs.utimesSync(outFile, new Date(T0 + 9000), new Date(T0 + 9000));
  const raw = fs.readFileSync(parentFile, 'utf8').replace(/"\/work\/project"/g, JSON.stringify(dir));
  fs.writeFileSync(parentFile, raw); fs.utimesSync(parentFile, new Date(now - 1000), new Date(now - 1000));
  const rows = [
    { id: PARENT, provider: 'codex', path: parentFile, cwd: dir, title: 'Codex orchestrator', project: 'project', lastWriteMs: now - 1000, lineage: { kind: 'cli', parentThreadId: null, startedMs: T0 } },
    { id: CHILD, provider: 'codex', path: childFile, cwd: dir, title: 'Review the parser', lastWriteMs: now - 2000, lineage: { kind: 'exec', parentThreadId: null, startedMs: T0 + 5000 } },
    { id: SUB, provider: 'codex', path: subFile, cwd: dir, title: 'Ohm (/root/check)', firstPrompt: 'Check the parser', lastWriteMs: now - 3000, lineage: { kind: 'subagent', parentThreadId: PARENT, startedMs: T0 + 6000 } },
    { id: GUARD, provider: 'codex', path: guardFile, cwd: dir, title: 'approval review', lastWriteMs: now - 3000, lineage: { kind: 'guardian', parentThreadId: PARENT, startedMs: T0 + 6500 } },
  ];
  const result = await scanRows(rows, [PARENT], now, { homes: [], contextCacheDir: dir });
  const group = result.built.groups.find((g) => g.parentId === PARENT);
  assert.ok(group, 'a codex session with dispatches and subagents is a parent');
  assert.equal(group.provider, 'codex');
  assert.equal(result.built.groups.length, 1, 'children are never parents of their own group');
  assert.equal(result.built.delegatedBy[CHILD], PARENT, 'the --json thread id is an exact link');
  const dispatched = group.agents.find((a) => a.id === CHILD);
  assert.equal(dispatched.state, 'failed'); assert.equal(dispatched.error, 'usage limit reached');
  assert.equal(dispatched.prompt, 'Review the parser');
  const sub = group.agents.find((a) => a.id === SUB);
  assert.equal(sub.state, 'done'); assert.equal(sub.result, 'Found two bugs.'); assert.equal(sub.sessionId, SUB);
  assert.equal(group.reviews, 1, 'guardians stay a plain approval-review count');
  const quick = group.tasks.find((task) => task.description.includes('Quick look'));
  assert.equal(quick.note, 'no transcript (--ephemeral)'); assert.equal(quick.result, 'Looks fine.');
});

test('a codex exec root dispatched by a claude parent is not also drawn as a codex parent', async (t) => {
  const dir = tmp(t); const now = T0 + 60_000;
  const parentFile = write(path.join(dir, 'claude.jsonl'), [
    { type: 'assistant', timestamp: iso(T0), cwd: dir, message: { content: [{ type: 'tool_use', id: 'd', name: 'Bash', input: { command: `codex exec resume ${CHILD} "Round 2"` } }] } },
    { type: 'user', timestamp: iso(T0 + 1), message: { content: [{ type: 'tool_result', tool_use_id: 'd', content: 'Command running in background with ID: d1.' }] } },
  ], now - 1000);
  const childFile = write(path.join(dir, 'child.jsonl'), [
    ev(T0 + 2000, { type: 'task_started' }), commandItem(T0 + 3000, 'claude -p "nested"'),
  ], now - 500);
  const rows = [
    { id: 'claude-parent', path: parentFile, lastActive: iso(now - 1000), cwd: dir },
    { id: CHILD, provider: 'codex', path: childFile, cwd: dir, lastWriteMs: now - 500, lineage: { kind: 'exec', parentThreadId: null, startedMs: T0 + 2000 } },
  ];
  const result = await scanRows(rows, ['claude-parent'], now, { homes: [], contextCacheDir: dir });
  assert.deepEqual(result.built.groups.map((g) => g.parentId), ['claude-parent']);
});

test('only real dispatches enter the capped command inventory; lookalikes cannot evict them', async (t) => {
  const file = path.join(tmp(t), 'parent.jsonl'); const scan = createScanner();
  const lookalikes = ['sed -n 1,80p src/codex-screen.js', 'cat ~/.claude/settings.json', 'rg claude src', 'codex --help',
    'claude --version', 'ls ~/.codex/sessions', 'git log --grep codex'];
  const records = [ev(T0, { type: 'task_started' }), commandItem(T0 + 1000, 'codex exec --json "BATCH TITLE: A"')];
  for (let i = 0; i < 70; i++) records.push(commandItem(T0 + 2000 + i * 10, lookalikes[i % lookalikes.length]));
  records.push(commandItem(T0 + 5000, 'cd /w/lane1 && claude -p "BATCH TITLE: B"'));
  write(file, records);
  const { commands } = (await scan(file, 'codex')).signal;
  assert.deepEqual(commands.map((c) => c.command), ['codex exec --json "BATCH TITLE: A"', 'cd /w/lane1 && claude -p "BATCH TITLE: B"'],
    'the first dispatch survives seventy lookalike commands');
});

const childRecords = (id, end) => [
  { timestamp: iso(T0), type: 'session_meta', payload: { id, source: { subagent: { thread_spawn: { parent_thread_id: PARENT } } } } },
  { timestamp: iso(T0 + 10), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
  ev(T0 + 100, { type: 'task_started' }),
  ...end,
];
const row = (id, file, extra = {}) => ({
  id, path: file, provider: 'codex', title: id.slice(-1), lastActive: iso(T0), lastWriteMs: T0 + 60_000,
  lineage: { kind: 'subagent', parentThreadId: PARENT, startedMs: T0 }, delegatedBy: PARENT, ...extra,
});

test('a compressed child that ended reports done with its result, failed with its error, and a cut one reads ended', { skip: noZstd }, async (t) => {
  const dir = tmp(t);
  const doneFile = writeZst(path.join(dir, `rollout-${DONE}.jsonl.zst`), childRecords(DONE, [
    ev(T0 + 2000, { type: 'task_complete', last_agent_message: 'Audit finished: 3 issues.' }),
  ]));
  const failedFile = writeZst(path.join(dir, `rollout-${FAILED}.jsonl.zst`), childRecords(FAILED, [
    ev(T0 + 2000, { type: 'task_complete', last_agent_message: null, error: { message: 'stream disconnected' } }),
  ]));
  // Closed inside a turn (the process died, codex compressed it later).
  const cutFile = writeZst(path.join(dir, `rollout-${CUT}.jsonl.zst`), childRecords(CUT, [
    ev(T0 + 2000, { type: 'item_completed', item: { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'text', text: 'Working.' }] } }),
  ]));
  // A PLAIN child mid-turn is still a live candidate: running.
  const plainFile = path.join(dir, `rollout-${PLAIN}.jsonl`);
  fs.writeFileSync(plainFile, jsonl(childRecords(PLAIN, [])));
  fs.utimesSync(plainFile, new Date(T0 + 60_000), new Date(T0 + 60_000));
  const parentFile = path.join(dir, `rollout-${PARENT}.jsonl`);
  fs.writeFileSync(parentFile, jsonl([ev(T0, { type: 'task_started' }), ev(T0 + 60_000, { type: 'task_complete', last_agent_message: 'ok' })]));
  fs.utimesSync(parentFile, new Date(T0 + 60_000), new Date(T0 + 60_000));

  const rows = [
    { id: PARENT, path: parentFile, provider: 'codex', title: 'Parent', lastActive: iso(T0), lastWriteMs: T0 + 60_000, lineage: null, delegatedBy: null },
    row(DONE, doneFile, { compressed: true }), row(FAILED, failedFile, { compressed: true }),
    row(CUT, cutFile, { compressed: true }), row(PLAIN, plainFile),
  ];
  const now = T0 + 120_000;
  const out = await scanRows(rows, [PARENT], now, {});
  const group = out.built.groups.find((g) => g.parentId === PARENT);
  assert.ok(group, 'the parent draws a group');
  const agent = (id) => group.agents.find((a) => a.sessionId === id);
  assert.equal(agent(DONE).state, 'done');
  assert.equal(agent(DONE).result, 'Audit finished: 3 issues.');
  assert.equal(agent(DONE).model, 'gpt-5.6-sol');
  assert.equal(agent(FAILED).state, 'failed');
  assert.equal(agent(FAILED).error, 'stream disconnected');
  assert.equal(agent(CUT).state, 'ended', 'a closed rollout cannot still be running');
  assert.equal(agent(PLAIN).state, 'running', 'a plain mid-turn child is still running');
});

test('a compressed child is decompressed once while its size and mtime hold', { skip: noZstd }, async (t) => {
  const dir = tmp(t);
  const file = writeZst(path.join(dir, `rollout-${DONE}.jsonl.zst`), childRecords(DONE, [
    ev(T0 + 2000, { type: 'task_complete', last_agent_message: 'Done.' }),
  ]));
  let opens = 0;
  const original = codexFiles.createRolloutReadStream;
  codexFiles.createRolloutReadStream = (...args) => { opens += 1; return original(...args); };
  t.after(() => { codexFiles.createRolloutReadStream = original; });
  // The worker requires the helper at load; reload it so the spy is the one it holds.
  delete require.cache[require.resolve('../../src/main/providers/delegations-worker.js')];
  const { createScanner: freshScanner } = require('../../src/main/providers/delegations-worker.js');
  const scan = freshScanner();
  const first = await scan(file, 'codex');
  const second = await scan(file, 'codex');
  assert.equal(opens, 1, 'the second scan is a cache hit');
  assert.equal(second, first);
  assert.equal(first.signal.outcome, 'done');
  // A changed file is read again.
  writeZst(file, childRecords(DONE, [ev(T0 + 3000, { type: 'turn_aborted' })]));
  fs.utimesSync(file, new Date(T0 + 90_000), new Date(T0 + 90_000));
  assert.equal((await scan(file, 'codex')).signal.outcome, 'stopped');
  assert.equal(opens, 2);
  assert.equal(typeof createScanner, 'function');
});

test('a fold cache saved under an older compatible format refolds its codex entries and keeps the rest', async (t) => {
  const dir = tmp(t); const cacheFile = path.join(dir, 'fold.json');
  const file = write(path.join(dir, 'child.jsonl'), [ev(T0, { type: 'task_started' }), ev(T0 + 1000, { type: 'task_complete', error: { message: 'quota' } })]);
  const first = createScanner(); await first(file, 'codex'); await first.save(cacheFile);
  // What the previous release's fold left: a codex signal with no failed outcome.
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  saved.format = 'da8a47743f347015';
  saved.files[file].signal = { lastSignalMs: T0 + 1000, working: false, outcome: 'done', endedMs: T0 + 1000 };
  fs.writeFileSync(cacheFile, JSON.stringify(saved));
  const second = createScanner(); second.load(cacheFile);
  assert.equal((await second(file, 'codex')).signal.outcome, 'failed', 'the old codex fold is not trusted');
});
