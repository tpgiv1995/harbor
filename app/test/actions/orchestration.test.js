'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const {
  LAUNCHER,
  buildResearchCommand,
  buildExecuteCommand,
  launcherFlags,
  checkExecuteMutex,
  createExecuteReservations,
  createLruCache,
  ORCH_LIVENESS_CACHE_MAX,
  createOrchestrationActions,
  SHIPPED_COMMANDS,
  shippedCommandsDir,
} = require('../../src/main/actions/orchestration.js');
const { createDelegateProvider, queuePath } = require('../../src/main/providers/delegate.js');
const { snapshotFromSessions } = require('../../src/main/session-daemon/client.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The pane runs these as shell strings with an empty env, so under Electron the
// shipped launcher must be named through the Electron binary as node — the
// packaged-mac 127 fix's missing lane. Two-sided: a user-supplied launcher and
// a plain-node caller keep the exact string they always got.
test('under Electron the shipped launcher is run through the Electron binary as node', () => {
  const cmd = buildResearchCommand(LAUNCHER, '/home/u/.claude', '/orchestrate-research', 'goal', {
    electron: true, execPath: '/Harbor.app/Contents/MacOS/Harbor', platform: 'darwin',
  });
  assert.ok(cmd.startsWith(`HARBOR_ORCH_ROLE=research ELECTRON_RUN_AS_NODE=1 '/Harbor.app/Contents/MacOS/Harbor' '${LAUNCHER}' --here `),
    `interpreter head missing: ${cmd}`);
});

test('outside Electron, and for a foreign launcher, the command string is unchanged', () => {
  const plain = buildResearchCommand(LAUNCHER, '/home/u/.claude', '/orchestrate-research', 'goal', {
    electron: false, execPath: '/usr/bin/node', platform: 'darwin',
  });
  assert.ok(plain.startsWith(`HARBOR_ORCH_ROLE=research ${LAUNCHER} --here `), plain);
  const foreign = buildExecuteCommand('/home/u/bin/my-ai', '/home/u/.claude', '/orchestrate-execution', {
    electron: true, execPath: '/Harbor.app/Contents/MacOS/Harbor', platform: 'darwin',
  });
  assert.ok(foreign.startsWith('HARBOR_ORCH_ROLE=execution /home/u/bin/my-ai '), 'a launcher that is not ours is not reinterpreted');
  assert.ok(!foreign.includes('ELECTRON_RUN_AS_NODE'), foreign);
});

const SANDBOX_ROOT = path.resolve(__dirname, '../fixtures/orch-sandbox');
const SANDBOX_STATE_DIR = path.resolve(__dirname, '../fixtures/orch-state');
const SANDBOX_QUEUE_PATH = queuePath(SANDBOX_ROOT, SANDBOX_STATE_DIR);
// Orchestration runs under the user's DEFAULT profile, so the test supplies one
// rather than letting `legacyConfig()` read whichever `.claude*` directories
// exist on the machine running the suite. That default made this file green for
// the author and red for everyone else.
const TEST_HOME = '/home/testuser';
const ORCH_HOME = `${TEST_HOME}/.claude-team`;
const RESEARCH_COMMAND = '/orchestrate-research';
const EXECUTION_COMMAND = '/orchestrate-execution';
const ORCH_CONFIG = {
  orchestration: { launcher: LAUNCHER, researchCommand: RESEARCH_COMMAND, executionCommand: EXECUTION_COMMAND },
  profiles: [
    { id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', configHome: `${TEST_HOME}/.claude`, email: null, isDefault: false },
    { id: 'team', label: 'Team', letter: 'T', color: '#D68A5A', provider: 'claude', configHome: ORCH_HOME, email: null, isDefault: true },
  ],
};

function makeClientFake(result = { id: 'pane-test', workspace_id: 'pane-test', tab_id: 'pane-test', pane_id: 'pane-test' }) {
  const calls = [];
  const controlClient = {
    async createWorkspace(params) {
      calls.push(params);
      return result;
    },
  };
  return { controlClient, calls };
}

// ---------------------------------------------------------------------------
// buildResearchCommand
// ---------------------------------------------------------------------------

test('buildResearchCommand: produces correct command string', () => {
  const cmd = buildResearchCommand(LAUNCHER, ORCH_HOME, RESEARCH_COMMAND, 'Build the widget');
  assert.equal(
    cmd,
    `HARBOR_ORCH_ROLE=research ${LAUNCHER} --here --home '${ORCH_HOME}' '/orchestrate-research Build the widget'`,
  );
});

test('buildResearchCommand: escapes single quotes in goal', () => {
  const cmd = buildResearchCommand(LAUNCHER, ORCH_HOME, RESEARCH_COMMAND, "the author's goal");
  assert.ok(cmd.includes("the author'\\''s goal"), `Expected escaped single quote, got: ${cmd}`);
});

test('buildExecuteCommand: produces correct command string', () => {
  const cmd = buildExecuteCommand(LAUNCHER, ORCH_HOME, EXECUTION_COMMAND);
  assert.equal(cmd, `HARBOR_ORCH_ROLE=execution ${LAUNCHER} --here --home '${ORCH_HOME}' '/orchestrate-execution'`);
});

// ---------------------------------------------------------------------------
// checkExecuteMutex
// ---------------------------------------------------------------------------

// The terminal state is built by the REAL sessiond labelling
// (snapshotFromSessions): a tab's label is its joined argv, `$SHELL -lc
// <command>`, never a friendly name. Fixtures that labelled a tab
// 'orchestrate-execution' described a pane no real session ever is, so the
// mutex passed its tests and never fired in the app.
const PROJECT_ROOT = `${TEST_HOME}/dev/myproject`;
function paneState(...sessions) {
  return snapshotFromSessions(sessions.map(([id, cwd, command]) => ({ id, cwd, argv: ['/bin/zsh', '-lc', command] })), TEST_HOME);
}
const executeCmd = () => buildExecuteCommand(LAUNCHER, ORCH_HOME, EXECUTION_COMMAND);
const researchCmd = (goal) => buildResearchCommand(LAUNCHER, ORCH_HOME, RESEARCH_COMMAND, goal);

test('checkExecuteMutex: a live execution pane blocks, found by its real sessiond label', () => {
  const terminalState = paneState(['s1', PROJECT_ROOT, executeCmd()]);
  assert.match(terminalState.tabs[0].label, /^\/bin\/zsh -lc HARBOR_ORCH_ROLE=execution /);
  const result = checkExecuteMutex({ projectLabel: 'myproject', projectRoot: PROJECT_ROOT, terminalState, queue: { batches: [] } });
  assert.equal(result.blocked, true);
  assert.ok(result.reason.includes('orchestrate-execution'));
});

test('checkExecuteMutex: every workspace of the project is checked, not only the first', () => {
  // sessiond makes one workspace per session; the execution pane is rarely first.
  const terminalState = paneState(
    ['s1', PROJECT_ROOT, '/usr/local/bin/claude'],
    ['s2', PROJECT_ROOT, researchCmd('Build the widget')],
    ['s3', PROJECT_ROOT, executeCmd()],
  );
  assert.equal(checkExecuteMutex({ projectLabel: 'myproject', terminalState, queue: { batches: [] } }).blocked, true);
  // A caller whose label differs still finds it by the project root.
  assert.equal(checkExecuteMutex({ projectLabel: 'renamed', projectRoot: PROJECT_ROOT, terminalState, queue: { batches: [] } }).blocked, true);
});

test('checkExecuteMutex: a pane started before the role marker still blocks by its command word', () => {
  const legacy = `${LAUNCHER} --here --home '${ORCH_HOME}' '/orchestrate-execution'`;
  const terminalState = paneState(['s1', PROJECT_ROOT, legacy]);
  assert.equal(checkExecuteMutex({ projectLabel: 'myproject', terminalState, queue: { batches: [] } }).blocked, true);
});

test('checkExecuteMutex: blocked when queue has active batch', () => {
  const terminalState = { workspaces: [], tabs: [] };
  const queue = { batches: [{ id: 'b1', status: 'active' }, { id: 'b2', status: 'done' }] };
  const result = checkExecuteMutex({ projectLabel: 'myproject', terminalState, queue });
  assert.equal(result.blocked, true);
  assert.ok(result.reason.includes('active'));
});

test('checkExecuteMutex: research panes never block, even a goal that names the execution command', () => {
  // A goal is one quoted shell word, so it can be neither the role word nor
  // the bare command word, whatever it says.
  const terminalState = paneState(
    ['s1', PROJECT_ROOT, researchCmd("then run '/orchestrate-execution' HARBOR_ORCH_ROLE=execution")],
    ['s2', PROJECT_ROOT, '/usr/local/bin/claude'],
  );
  const queue = { batches: [{ id: 'b1', status: 'pending' }, { id: 'b2', status: 'done' }] };
  const result = checkExecuteMutex({ projectLabel: 'myproject', projectRoot: PROJECT_ROOT, terminalState, queue });
  assert.equal(result.blocked, false);
  assert.equal(result.reason, null);
});

test('checkExecuteMutex: not blocked when the project has panes but none is an execution pane', () => {
  const terminalState = paneState(['s1', PROJECT_ROOT, '/usr/local/bin/claude']);
  assert.equal(checkExecuteMutex({ projectLabel: 'myproject', projectRoot: PROJECT_ROOT, terminalState, queue: { batches: [] } }).blocked, false);
});

test('checkExecuteMutex: an execution pane in a different project does not block', () => {
  const terminalState = paneState(
    ['s1', PROJECT_ROOT, '/usr/local/bin/claude'],
    ['s2', `${TEST_HOME}/dev/other`, executeCmd()],
  );
  const result = checkExecuteMutex({ projectLabel: 'myproject', projectRoot: PROJECT_ROOT, terminalState, queue: { batches: [] } });
  assert.equal(result.blocked, false);
});

// ---------------------------------------------------------------------------
// kickoffResearch: exact argv / cwd / tab-name assertions
// ---------------------------------------------------------------------------

test('kickoffResearch: exact sessiond spawn, cwd, tab name, and command string', async () => {
  const projectRoot = '/home/testuser/dev/myproject';
  const projectLabel = 'myproject';
  const goal = 'Build the widget';

  const { controlClient, calls } = makeClientFake();
  const actions = createOrchestrationActions({ controlClient, config: ORCH_CONFIG });

  const result = await actions.kickoffResearch({ projectRoot, projectLabel, goal });

  const expectedCmd = `HARBOR_ORCH_ROLE=research ${LAUNCHER} --here --home '${ORCH_HOME}' '/orchestrate-research ${goal}'`;
  assert.deepEqual(calls, [{ cwd: projectRoot, command: expectedCmd }]);

  // Return shape
  assert.equal(result.cwd, projectRoot);
  assert.equal(result.tabLabel, 'orchestrate-research');
  assert.equal(result.account, 'team');
  assert.equal(result.tab_id, 'pane-test');
  assert.equal(result.pane_id, 'pane-test');
});

test('kickoffExecute: exact sessiond spawn, cwd, tab name, and command string', async () => {
  const projectRoot = '/home/testuser/dev/myproject';
  const projectLabel = 'myproject';

  const { controlClient, calls } = makeClientFake();
  const actions = createOrchestrationActions({ controlClient, config: ORCH_CONFIG });

  const result = await actions.kickoffExecute({ projectRoot, projectLabel });

  const expectedCmd = `HARBOR_ORCH_ROLE=execution ${LAUNCHER} --here --home '${ORCH_HOME}' '/orchestrate-execution'`;
  assert.deepEqual(calls, [{ cwd: projectRoot, command: expectedCmd }]);

  assert.equal(result.tabLabel, 'orchestrate-execution');
  assert.equal(result.account, 'team');
  assert.equal(result.cwd, projectRoot);
});

test('kickoffResearch rejects on missing goal', async () => {
  const { controlClient } = makeClientFake();
  const actions = createOrchestrationActions({ controlClient, config: ORCH_CONFIG });
  await assert.rejects(
    () => actions.kickoffResearch({ projectRoot: '/test', projectLabel: 'x', goal: '' }),
    /goal/,
  );
});

test('kickoffExecute rejects on missing projectRoot', async () => {
  const { controlClient } = makeClientFake();
  const actions = createOrchestrationActions({ controlClient, config: ORCH_CONFIG });
  await assert.rejects(
    () => actions.kickoffExecute({ projectLabel: 'x' }),
    /projectRoot/,
  );
});

// ---------------------------------------------------------------------------
// Mutex integration: second Execute refused (using checkExecuteMutex directly)
// ---------------------------------------------------------------------------

test('mutex: second Execute is refused once the first kickoff pane exists', async () => {
  // Drive the real kickoff, then label its spawn exactly as sessiond would.
  const { controlClient, calls } = makeClientFake();
  const actions = createOrchestrationActions({ controlClient, config: ORCH_CONFIG });
  const queue = { batches: [] };

  const firstCheck = checkExecuteMutex({ projectLabel: 'myproject', projectRoot: PROJECT_ROOT, terminalState: paneState(), queue });
  assert.equal(firstCheck.blocked, false, 'first kickoff should not be blocked');
  await actions.kickoffExecute({ projectRoot: PROJECT_ROOT, projectLabel: 'myproject' });
  const stateAfterFirstKickoff = paneState(['other', PROJECT_ROOT, '/usr/local/bin/claude'], ['exec', calls[0].cwd, calls[0].command]);

  const secondCheck = checkExecuteMutex({ projectLabel: 'myproject', projectRoot: PROJECT_ROOT, terminalState: stateAfterFirstKickoff, queue });
  assert.equal(secondCheck.blocked, true, 'second kickoff must be refused');
  assert.ok(secondCheck.reason, 'must provide a reason');
});

// The pane kickoffExecute starts reaches terminalBridge.getState() only on the
// bridge's next poll, so for about a second the mutex read an empty project.
test('an execute reservation blocks a second kickoff until the bridge shows the pane, or it times out', () => {
  let clock = 1_000;
  const reservations = createExecuteReservations({ ttlMs: 15_000, now: () => clock });
  const root = '/tmp/harbor-orch-fixture';
  const empty = { workspaces: [], tabs: [], layouts: {} };
  assert.equal(reservations.blockedReason(root, empty), null, 'nothing reserved yet');
  reservations.reserve(root, { tab_id: 't-1', pane_id: 'p-1' });
  // The gap the bug lived in: the mutex sees nothing, the reservation does.
  assert.equal(checkExecuteMutex({ projectLabel: 'proj', projectRoot: root, terminalState: empty, queue: { batches: [] } }).blocked, false);
  assert.match(reservations.blockedReason(root, empty), /just started/);
  assert.match(reservations.blockedReason(`${root}/`, empty), /just started/, 'keyed by canonical root');
  assert.equal(reservations.blockedReason('/tmp/other-project', empty), null, 'other projects are not blocked');
  // The bridge reports the pane: the reservation hands over to the mutex.
  const shown = { workspaces: [], tabs: [], layouts: { 't-1': { tab_id: 't-1', panes: [{ pane_id: 'p-1' }] } } };
  assert.equal(reservations.blockedReason(root, shown), null);
  assert.equal(reservations.size(), 0);
  // A pane that never shows up does not lock Execute forever.
  reservations.reserve(root, { tab_id: 't-2', pane_id: 'p-2' });
  clock += 14_999;
  assert.match(reservations.blockedReason(root, empty), /just started/);
  clock += 1;
  assert.equal(reservations.blockedReason(root, empty), null);
  // Shown by tab id alone also clears it.
  reservations.reserve(root, { tab_id: 't-3', pane_id: 'p-3' });
  assert.equal(reservations.blockedReason(root, { tabs: [{ tab_id: 't-3' }] }), null);
});

test('the execute IPC handler consults the reservation and reserves after a successful kickoff', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('orchestration:kickoff-execute'");
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf('ipcMain.handle(', start + 10));
  const mutex = body.indexOf('checkExecuteMutex(');
  const check = body.indexOf('executeReservations.blockedReason(projectRoot');
  const kickoff = body.indexOf('orchActions.kickoffExecute(');
  const reserve = body.indexOf('executeReservations.reserve(projectRoot, launched)');
  assert.ok(mutex > 0 && check > mutex && kickoff > check && reserve > kickoff, 'mutex, reservation, kickoff, then reserve');
});

test('the orch liveness cache is a bounded LRU', () => {
  assert.equal(ORCH_LIVENESS_CACHE_MAX, 200);
  const cache = createLruCache(3);
  cache.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(cache.get('a'), 1, 'touching a makes b the oldest');
  cache.set('d', 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.has('b'), false, 'least recently used is evicted');
  assert.deepEqual(['a', 'c', 'd'].map((k) => cache.get(k)), [1, 3, 4]);
  assert.equal(cache.get('missing'), undefined);
  const big = createLruCache();
  for (let i = 0; i < 1_000; i += 1) big.set(`/t/${i}.jsonl`, { size: i, mtimeMs: i, finished: false });
  assert.equal(big.size, 200);
  const source = require('node:fs').readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
  assert.match(source, /const orchLivenessCache = createLruCache\(\);/);
});

// ---------------------------------------------------------------------------
// Sandbox toy queue (reads from real state dir, cleans up in teardown)
// ---------------------------------------------------------------------------

const TOY_QUEUE = {
  queue_id: 'sandbox-test',
  workspace: SANDBOX_ROOT,
  source_label: 'orchestrate-research',
  batches: [
    {
      id: 'batch-toy-1',
      title: 'Toy batch A',
      status: 'pending',
      sprint: 1,
      priority: 'P1',
      dispatch_count: 0,
      worker: '/codex-worker test',
      last_error: null,
      last_result_excerpt: null,
      last_session_id: null,
    },
    {
      id: 'batch-toy-2',
      title: 'Toy batch B',
      status: 'pending',
      sprint: 1,
      priority: 'P2',
      dispatch_count: 0,
      worker: '/claude-worker test',
      last_error: null,
      last_result_excerpt: null,
      last_session_id: null,
    },
  ],
  sprint_plan: {
    1: { label: 'Test sprint', orchestrator_effort: 'low' },
  },
};

test('sandbox toy queue: delegate provider reads 2-batch fixture and cleans up', async () => {
  // Ensure queues directory exists
  const queuesDir = path.dirname(SANDBOX_QUEUE_PATH);
  await fs.mkdir(queuesDir, { recursive: true });

  try {
    // Write the toy queue
    await fs.writeFile(SANDBOX_QUEUE_PATH, JSON.stringify(TOY_QUEUE), 'utf8');

    // Read it back via the provider
    const provider = createDelegateProvider({ stateDir: SANDBOX_STATE_DIR });
    const queue = await provider.getQueue(SANDBOX_ROOT);

    assert.equal(queue.batches.length, 2, 'should read 2 batches');
    assert.equal(queue.batches[0].id, 'batch-toy-1');
    assert.equal(queue.batches[1].id, 'batch-toy-2');
    assert.equal(queue.batches[0].status, 'pending');
    assert.equal(queue.batches[1].status, 'pending');
    assert.ok(queue.sprint_plan, 'sprint_plan should be present');
    assert.equal(queue.sprint_plan['1'].label, 'Test sprint');

    // Verify the queue path is keyed to the sandbox root (not any real project)
    const expectedHash = crypto
      .createHash('sha1')
      .update(path.resolve(SANDBOX_ROOT))
      .digest('hex')
      .slice(0, 12);
    assert.ok(SANDBOX_QUEUE_PATH.endsWith(`${expectedHash}.json`), 'queue path must use sandbox hash');
  } finally {
    // Always clean up
    await fs.unlink(SANDBOX_QUEUE_PATH).catch(() => {});
  }
});

test('sandbox toy queue: file is absent after teardown', async () => {
  const exists = await fs.access(SANDBOX_QUEUE_PATH).then(() => true).catch(() => false);
  assert.equal(exists, false, 'sandbox queue file must not exist after teardown');
});

// TWO-SIDED ON PURPOSE. `--here` keeps Harbor's own launcher in the pane the
// kickoff just created; without it `bin/ai` starts a whole new session in
// sessiond and leaves that pane empty. But a launcher the
// USER supplied has never heard of the flag, and passing it would make their
// wrapper die on an unknown option, so a refusal to emit it is just as
// load-bearing as emitting it. Asserting only one side passes for the wrong
// reason if the flag were dropped everywhere.
test('the --here flag is emitted for Harbor own launcher and withheld from a user supplied one', () => {
  // The shipped launcher is identified by IDENTITY, not by name. An earlier
  // version matched any `ai` inside a directory called `bin`, which is exactly
  // where a user's own unrelated `ai` dispatcher lives, and this field invites
  // customising ("change it only if you use a different wrapper").
  const ours = path.resolve(__dirname, '../../../bin/ai');
  const theirs = '/home/testuser/.local/bin/my-claude-wrapper';
  assert.deepEqual(launcherFlags(ours), ['--here']);
  assert.deepEqual(launcherFlags(theirs), []);
  assert.deepEqual(launcherFlags(`${ours}.cmd`), ['--here'], 'a Windows wrapper on the same path is the same launcher');
  assert.deepEqual(launcherFlags(ours.toUpperCase()), ['--here'], 'and that filesystem is case-insensitive');
  for (const impostor of ['/home/someone/.local/bin/ai', '/usr/local/bin/ai', '/home/someone/bin/ai.cmd']) {
    assert.deepEqual(launcherFlags(impostor), [], `${impostor} is somebody else's tool`);
  }

  assert.equal(
    buildExecuteCommand(ours, ORCH_HOME, EXECUTION_COMMAND),
    `HARBOR_ORCH_ROLE=execution ${ours} --here --home '${ORCH_HOME}' '/orchestrate-execution'`,
  );
  assert.equal(
    buildExecuteCommand(theirs, ORCH_HOME, EXECUTION_COMMAND),
    `HARBOR_ORCH_ROLE=execution ${theirs} --home '${ORCH_HOME}' '/orchestrate-execution'`,
  );
});

// ---------------------------------------------------------------------------
// Codex as the orchestrator
// ---------------------------------------------------------------------------

const CODEX_HOME = `${TEST_HOME}/.codex-work`;
const CODEX_CONFIG = {
  ...ORCH_CONFIG,
  profiles: [
    ...ORCH_CONFIG.profiles,
    { id: 'codex-work', label: 'Codex', letter: 'C', color: '#888888', provider: 'codex', configHome: CODEX_HOME, email: null, isDefault: true },
  ],
};

test('a codex execute kickoff runs bin/ai --provider codex under the codex home and names the agent', async () => {
  const { controlClient, calls } = makeClientFake();
  const actions = createOrchestrationActions({ controlClient, config: CODEX_CONFIG });
  const result = await actions.kickoffExecute({ projectRoot: '/nonexistent/project', projectLabel: 'project', provider: 'codex' });
  const [call] = calls;
  // The pane is `$SHELL -lc`, so the daemon reads a shell off argv[0]; the
  // kickoff says which CLI it started so the codex linker's annotate is accepted.
  assert.equal(call.agent, 'codex');
  assert.ok(call.command.startsWith(`HARBOR_ORCH_ROLE=execution ${LAUNCHER} --here --provider codex --home '${CODEX_HOME}' '`), call.command);
  assert.ok(!call.command.includes(ORCH_HOME), 'a claude config home is never handed to codex');
  // No project or claude-home copy exists here, so the SHIPPED command is used.
  const shipped = await fs.readFile(path.join(SHIPPED_COMMANDS, 'orchestrate-execution.md'), 'utf8');
  assert.ok(shipped.includes('allowed-tools:'));
  assert.ok(call.command.includes('Execute the already-loaded orchestration queue'), 'the workflow body travels as the prompt');
  assert.ok(!call.command.includes('allowed-tools:'), 'frontmatter is dropped');
  assert.equal(result.provider, 'codex');
  assert.equal(result.account, 'codex-work');
  // And the pane it makes is what the mutex recognises.
  const state = snapshotFromSessions([{ id: 'x', cwd: '/nonexistent/project', argv: ['/bin/zsh', '-lc', call.command] }], TEST_HOME);
  assert.equal(checkExecuteMutex({ projectLabel: 'project', projectRoot: '/nonexistent/project', terminalState: state, queue: { batches: [] } }).blocked, true);
});

test('a codex research prompt takes the project command first and substitutes the goal', async () => {
  const reads = [];
  const readFile = async (file) => {
    reads.push(file);
    if (file === path.join('/repo', '.claude', 'commands', 'orchestrate-research.md')) {
      return '---\ndescription: x\nargument-hint: <goal>\n---\n\nResearch this: $ARGUMENTS\nThen stop.\n';
    }
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const { controlClient, calls } = makeClientFake();
  const actions = createOrchestrationActions({ controlClient, config: CODEX_CONFIG, readFile });
  await actions.kickoffResearch({ projectRoot: '/repo', projectLabel: 'repo', goal: "the author's\nwidget costs $` dollars", provider: 'codex' });
  assert.equal(reads[0], path.join('/repo', '.claude', 'commands', 'orchestrate-research.md'));
  const words = require('../../src/main/providers/delegations.js').shellWords(calls[0].command.replace(/^HARBOR_ORCH_ROLE=research /, ''));
  const prompt = words.at(-1);
  assert.match(prompt, /^Run Harbor's \/orchestrate-research workflow/);
  assert.ok(prompt.includes("Research this: the author's widget costs $` dollars"), prompt);
  assert.ok(!prompt.includes('argument-hint'), prompt);
});

test('codex kickoffs refuse honestly: no codex plan, a launcher that is not bin/ai, or an unknown provider', async () => {
  const { controlClient } = makeClientFake();
  const noCodex = createOrchestrationActions({ controlClient, config: ORCH_CONFIG });
  await assert.rejects(() => noCodex.kickoffExecute({ projectRoot: '/p', projectLabel: 'p', provider: 'codex' }), /No codex plan/);
  const foreign = createOrchestrationActions({ controlClient, config: { ...CODEX_CONFIG, orchestration: { ...CODEX_CONFIG.orchestration, launcher: '/home/u/bin/my-ai' } } });
  await assert.rejects(() => foreign.kickoffExecute({ projectRoot: '/p', projectLabel: 'p', provider: 'codex' }), /bin\/ai/);
  await assert.rejects(() => noCodex.kickoffExecute({ projectRoot: '/p', projectLabel: 'p', provider: 'cursor' }), /cannot run on provider cursor/);
});

test('a claude kickoff keeps the claude home even when a codex plan is the default', async () => {
  const { controlClient, calls } = makeClientFake();
  const actions = createOrchestrationActions({ controlClient, config: CODEX_CONFIG });
  await actions.kickoffExecute({ projectRoot: '/p', projectLabel: 'p' });
  assert.equal(calls[0].command, `HARBOR_ORCH_ROLE=execution ${LAUNCHER} --here --home '${ORCH_HOME}' '/orchestrate-execution'`);
  assert.equal('agent' in calls[0], false, 'a claude kickoff spawns exactly as before');
});

test('the kickoff IPC handlers pass the provider through and return a refusal as an error', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
  for (const [channel, call] of [['orchestration:kickoff-research', 'orchActions.kickoffResearch('], ['orchestration:kickoff-execute', 'orchActions.kickoffExecute(']]) {
    const start = source.indexOf(`ipcMain.handle('${channel}'`);
    const body = source.slice(start, source.indexOf('ipcMain.handle(', start + 10));
    assert.match(body, /provider = 'claude'/, channel);
    assert.ok(body.slice(body.indexOf(call)).match(/^[^)]*provider/), `${channel} forwards provider`);
    assert.match(body, /catch \(error\) \{\s*return \{ error: error\.message \};/, `${channel} surfaces the refusal`);
  }
});

// ---------------------------------------------------------------------------
// Shipped workflow commands reach the PACKAGED app
// ---------------------------------------------------------------------------

// A Codex Orch kickoff in a project without its own command files falls back
// to Harbor's shipped copy. From the source tree that is <repo>/.claude/commands;
// in a packaged app it is <Resources>/.claude/commands, which exists only if
// build.extraResources copies the folder there. Without it every Codex kickoff
// outside the Harbor repo threw in the installed app while tests, running from
// the source tree, stayed green.
const APP_DIR = path.resolve(__dirname, '../..');
const WORKFLOW_FILES = ['orchestrate-execution.md', 'orchestrate-research.md'];

test('the shipped commands directory resolves to the repo copy in the source tree', async () => {
  assert.equal(SHIPPED_COMMANDS, path.resolve(APP_DIR, '..', '.claude', 'commands'));
  for (const name of WORKFLOW_FILES) {
    const text = await fs.readFile(path.join(SHIPPED_COMMANDS, name), 'utf8');
    assert.ok(text.length > 0, `${name} is empty`);
  }
});

test('every platform build copies the workflow commands to where the packaged app looks for them', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(APP_DIR, 'package.json'), 'utf8'));
  const build = pkg.build;
  // electron-builder places the app at <Resources>/app (asar is off) and
  // resolves each extraResources `to` against <Resources>, `from` against the
  // app dir. The root list and the platform list are BOTH applied
  // (app-builder-lib getFileMatchers: config[name], then the platform's).
  assert.equal(build.asar, false, 'the packaged-path math below assumes an unpacked app dir');
  const resources = path.resolve('/packaged/Resources');
  const packagedLookup = shippedCommandsDir(path.join(resources, 'app', 'src', 'main', 'actions'));
  for (const platform of ['mac', 'win', 'linux']) {
    const entries = [...(build.extraResources || []), ...((build[platform] || {}).extraResources || [])]
      .filter((entry) => entry && typeof entry === 'object');
    const match = entries.find((entry) => path.resolve(resources, entry.to || '') === packagedLookup);
    assert.ok(match, `${platform}: no extraResources entry copies to ${path.relative(resources, packagedLookup)}`);
    const from = path.resolve(APP_DIR, match.from);
    assert.equal(from, SHIPPED_COMMANDS, `${platform}: extraResources copies from ${from}`);
    for (const name of WORKFLOW_FILES) {
      await fs.access(path.join(from, name));
      if (match.filter) {
        const filters = [].concat(match.filter);
        assert.ok(filters.some((filter) => filter === '**/*' || filter === '*.md' || filter === '**/*.md'), `${platform}: filter ${filters} drops ${name}`);
      }
    }
  }
});
