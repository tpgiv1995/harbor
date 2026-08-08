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
  createOrchestrationActions,
} = require('../../src/main/actions/orchestration.js');
const { createDelegateProvider, queuePath } = require('../../src/main/providers/delegate.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  platform: { herdrBin: 'herdr' },
  orchestration: { launcher: LAUNCHER, researchCommand: RESEARCH_COMMAND, executionCommand: EXECUTION_COMMAND },
  profiles: [
    { id: 'personal', label: 'Personal', letter: 'P', color: '#6FA8D8', provider: 'claude', configHome: `${TEST_HOME}/.claude`, email: null, isDefault: false },
    { id: 'team', label: 'Team', letter: 'T', color: '#D68A5A', provider: 'claude', configHome: ORCH_HOME, email: null, isDefault: true },
  ],
};

function makeExecFake(responseMap = {}) {
  const calls = [];
  const execFile = (bin, argv, optionsOrCb, maybeCb) => {
    const cb = maybeCb || (typeof optionsOrCb === 'function' ? optionsOrCb : null);
    calls.push({ bin, argv });
    const key = argv.slice(0, 2).join('.');
    const response = responseMap[key] || responseMap[argv.join(' ')] || {};
    const stdout = JSON.stringify(response);
    if (cb) cb(null, stdout, '');
  };
  return { execFile, calls };
}

// ---------------------------------------------------------------------------
// buildResearchCommand
// ---------------------------------------------------------------------------

test('buildResearchCommand: produces correct command string', () => {
  const cmd = buildResearchCommand(LAUNCHER, ORCH_HOME, RESEARCH_COMMAND, 'Build the widget');
  assert.equal(
    cmd,
    `${LAUNCHER} --here --home '${ORCH_HOME}' '/orchestrate-research Build the widget'`,
  );
});

test('buildResearchCommand: escapes single quotes in goal', () => {
  const cmd = buildResearchCommand(LAUNCHER, ORCH_HOME, RESEARCH_COMMAND, "the author's goal");
  assert.ok(cmd.includes("the author'\\''s goal"), `Expected escaped single quote, got: ${cmd}`);
});

test('buildExecuteCommand: produces correct command string', () => {
  const cmd = buildExecuteCommand(LAUNCHER, ORCH_HOME, EXECUTION_COMMAND);
  assert.equal(cmd, `${LAUNCHER} --here --home '${ORCH_HOME}' '/orchestrate-execution'`);
});

// ---------------------------------------------------------------------------
// checkExecuteMutex
// ---------------------------------------------------------------------------

test('checkExecuteMutex: blocked when orchestrate-execution tab exists in project workspace', () => {
  const terminalState = {
    workspaces: [{ workspace_id: 'w1', label: 'myproject' }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'orchestrate-execution' }],
  };
  const result = checkExecuteMutex({ projectLabel: 'myproject', terminalState, queue: { batches: [] } });
  assert.equal(result.blocked, true);
  assert.ok(result.reason.includes('orchestrate-execution'));
});

test('checkExecuteMutex: blocked when queue has active batch', () => {
  const terminalState = { workspaces: [], tabs: [] };
  const queue = { batches: [{ id: 'b1', status: 'active' }, { id: 'b2', status: 'done' }] };
  const result = checkExecuteMutex({ projectLabel: 'myproject', terminalState, queue });
  assert.equal(result.blocked, true);
  assert.ok(result.reason.includes('active'));
});

test('checkExecuteMutex: not blocked when no execution tab and no active batches', () => {
  const terminalState = {
    workspaces: [{ workspace_id: 'w1', label: 'myproject' }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'orchestrate-research' }],
  };
  const queue = { batches: [{ id: 'b1', status: 'pending' }, { id: 'b2', status: 'done' }] };
  const result = checkExecuteMutex({ projectLabel: 'myproject', terminalState, queue });
  assert.equal(result.blocked, false);
  assert.equal(result.reason, null);
});

test('checkExecuteMutex: not blocked when workspace exists but has no orch-execute tab', () => {
  const terminalState = {
    workspaces: [{ workspace_id: 'w1', label: 'myproject' }],
    tabs: [],
  };
  const result = checkExecuteMutex({ projectLabel: 'myproject', terminalState, queue: { batches: [] } });
  assert.equal(result.blocked, false);
});

test('checkExecuteMutex: tab in a different workspace does not block', () => {
  const terminalState = {
    workspaces: [
      { workspace_id: 'w1', label: 'myproject' },
      { workspace_id: 'w2', label: 'other' },
    ],
    tabs: [{ tab_id: 't1', workspace_id: 'w2', label: 'orchestrate-execution' }],
  };
  const result = checkExecuteMutex({ projectLabel: 'myproject', terminalState, queue: { batches: [] } });
  assert.equal(result.blocked, false);
});

// ---------------------------------------------------------------------------
// kickoffResearch: exact argv / cwd / tab-name assertions
// ---------------------------------------------------------------------------

const FAKE_WS_RESPONSE = {
  result: { workspaces: [{ workspace_id: 'ws-test', label: 'myproject' }] },
};
const FAKE_TAB_RESPONSE = {
  result: { tab: { tab_id: 'tab-test' }, root_pane: { pane_id: 'pane-test' } },
};

test('kickoffResearch: exact argv, cwd, tab name, and command string', async () => {
  const projectRoot = '/home/testuser/dev/myproject';
  const projectLabel = 'myproject';
  const goal = 'Build the widget';

  const { execFile, calls } = makeExecFake({
    'workspace.list': FAKE_WS_RESPONSE,
    'tab.create': FAKE_TAB_RESPONSE,
  });
  const actions = createOrchestrationActions({ execFile, config: ORCH_CONFIG });

  const result = await actions.kickoffResearch({ projectRoot, projectLabel, goal });

  // Assert: no real herdr or claude launched
  assert.equal(calls.every((c) => c.bin === actions.HERDR_BIN), true, 'All calls must use configured herdrBin');

  // Tab create argv
  const tabCall = calls.find((c) => c.argv[0] === 'tab' && c.argv[1] === 'create');
  assert.ok(tabCall, 'tab.create call expected');
  assert.deepEqual(tabCall.argv, [
    'tab', 'create',
    '--workspace', 'ws-test',
    '--cwd', projectRoot,
    '--label', 'orchestrate-research',
    '--focus',
  ]);

  // Pane run argv: exact command string
  const paneRunCall = calls.find((c) => c.argv[0] === 'pane' && c.argv[1] === 'run');
  assert.ok(paneRunCall, 'pane.run call expected');
  assert.equal(paneRunCall.argv[2], 'pane-test');
  const expectedCmd = `${LAUNCHER} --here --home '${ORCH_HOME}' '/orchestrate-research ${goal}'`;
  assert.equal(paneRunCall.argv[3], expectedCmd);

  // Return shape
  assert.equal(result.cwd, projectRoot);
  assert.equal(result.tabLabel, 'orchestrate-research');
  assert.equal(result.account, 'team');
  assert.equal(result.tab_id, 'tab-test');
  assert.equal(result.pane_id, 'pane-test');
});

test('kickoffExecute: exact argv, cwd, tab name, and command string', async () => {
  const projectRoot = '/home/testuser/dev/myproject';
  const projectLabel = 'myproject';

  const { execFile, calls } = makeExecFake({
    'workspace.list': FAKE_WS_RESPONSE,
    'tab.create': FAKE_TAB_RESPONSE,
  });
  const actions = createOrchestrationActions({ execFile, config: ORCH_CONFIG });

  const result = await actions.kickoffExecute({ projectRoot, projectLabel });

  const tabCall = calls.find((c) => c.argv[0] === 'tab' && c.argv[1] === 'create');
  assert.ok(tabCall, 'tab.create call expected');
  assert.deepEqual(tabCall.argv, [
    'tab', 'create',
    '--workspace', 'ws-test',
    '--cwd', projectRoot,
    '--label', 'orchestrate-execution',
    '--focus',
  ]);

  const paneRunCall = calls.find((c) => c.argv[0] === 'pane' && c.argv[1] === 'run');
  assert.ok(paneRunCall, 'pane.run call expected');
  assert.equal(paneRunCall.argv[2], 'pane-test');
  const expectedCmd = `${LAUNCHER} --here --home '${ORCH_HOME}' '/orchestrate-execution'`;
  assert.equal(paneRunCall.argv[3], expectedCmd);

  assert.equal(result.tabLabel, 'orchestrate-execution');
  assert.equal(result.account, 'team');
  assert.equal(result.cwd, projectRoot);
});

test('kickoffResearch uses getTerminalState to skip herdr workspace list when state available', async () => {
  const { execFile, calls } = makeExecFake({ 'tab.create': FAKE_TAB_RESPONSE });
  const actions = createOrchestrationActions({
    execFile,
    getTerminalState: () => ({
      workspaces: [{ workspace_id: 'ws-from-state', label: 'myproject' }],
      tabs: [],
    }),
  });

  await actions.kickoffResearch({
    projectRoot: '/test/myproject',
    projectLabel: 'myproject',
    goal: 'test',
  });

  const listCall = calls.find((c) => c.argv[0] === 'workspace' && c.argv[1] === 'list');
  assert.equal(listCall, undefined, 'workspace.list should not be called when terminal state has the workspace');

  const tabCall = calls.find((c) => c.argv[0] === 'tab' && c.argv[1] === 'create');
  assert.equal(tabCall.argv[3], 'ws-from-state');
});

test('kickoffResearch rejects on missing goal', async () => {
  const { execFile } = makeExecFake({});
  const actions = createOrchestrationActions({ execFile, config: ORCH_CONFIG });
  await assert.rejects(
    () => actions.kickoffResearch({ projectRoot: '/test', projectLabel: 'x', goal: '' }),
    /goal/,
  );
});

test('kickoffExecute rejects on missing projectRoot', async () => {
  const { execFile } = makeExecFake({});
  const actions = createOrchestrationActions({ execFile, config: ORCH_CONFIG });
  await assert.rejects(
    () => actions.kickoffExecute({ projectLabel: 'x' }),
    /projectRoot/,
  );
});

// ---------------------------------------------------------------------------
// Mutex integration: second Execute refused (using checkExecuteMutex directly)
// ---------------------------------------------------------------------------

test('mutex: second Execute is refused when first execution tab is alive', () => {
  // Simulate: first kickoff completed, leaving an orchestrate-execution tab
  const stateAfterFirstKickoff = {
    workspaces: [{ workspace_id: 'w1', label: 'myproject' }],
    tabs: [{ tab_id: 't-exec', workspace_id: 'w1', label: 'orchestrate-execution' }],
  };
  const queue = { batches: [] };

  const firstCheck = checkExecuteMutex({ projectLabel: 'myproject', terminalState: { workspaces: [], tabs: [] }, queue });
  assert.equal(firstCheck.blocked, false, 'first kickoff should not be blocked');

  const secondCheck = checkExecuteMutex({ projectLabel: 'myproject', terminalState: stateAfterFirstKickoff, queue });
  assert.equal(secondCheck.blocked, true, 'second kickoff must be refused');
  assert.ok(secondCheck.reason, 'must provide a reason');
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
// whichever backend is selected and leaves that pane empty. But a launcher the
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
    `${ours} --here --home '${ORCH_HOME}' '/orchestrate-execution'`,
  );
  assert.equal(
    buildExecuteCommand(theirs, ORCH_HOME, EXECUTION_COMMAND),
    `${theirs} --home '${ORCH_HOME}' '/orchestrate-execution'`,
  );
});
