'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkflowRuns } = require('../../src/main/providers/workflow-runs.js');

function line(obj) { return `${JSON.stringify(obj)}\n`; }

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runs-'));
  const transcript = path.join(root, 'session-1.jsonl');
  const sessionDir = path.join(root, 'session-1');
  const scriptFile = path.join(root, 'sweep.workflow.js');
  fs.writeFileSync(scriptFile, [
    'export const meta = {',
    "  name: 'gold-sweep-batch',",
    "  description: 'sweep',",
    '  phases: [',
    "    { title: 'Adjudicate' },",
    "    { title: 'Verify' },",
    '  ],',
    '}',
  ].join('\n'));
  fs.writeFileSync(transcript, line({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        content: `Workflow launched in background. Task ID: t1\nSummary: Adjudicate one small batch\nTranscript dir: ${sessionDir}/subagents/workflows/wf_live-1\nScript file: ${scriptFile}\n`,
      }],
    },
  }));

  const liveDir = path.join(sessionDir, 'subagents', 'workflows', 'wf_live-1');
  fs.mkdirSync(liveDir, { recursive: true });
  fs.writeFileSync(path.join(liveDir, 'journal.jsonl'),
    line({ type: 'started', key: 'v2:k1', agentId: 'a1' })
    + line({ type: 'started', key: 'v2:k2', agentId: 'a2' })
    + line({ type: 'result', key: 'v2:k1', agentId: 'a1', result: { status: 'complete', findings: 3 } }));
  fs.writeFileSync(path.join(liveDir, 'agent-a1.jsonl'),
    line({ type: 'user', agentId: 'a1', message: { role: 'user', content: 'You are one adjudicator on the panel.' } })
    + line({ type: 'assistant', agentId: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1200, cache_read_input_tokens: 40000 } } }));
  fs.writeFileSync(path.join(liveDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', model: 'opus' }));
  fs.writeFileSync(path.join(liveDir, 'agent-a2.jsonl'),
    line({ type: 'user', agentId: 'a2', message: { role: 'user', content: 'You are verifier two, refute if you can.' } })
    + line({ type: 'assistant', agentId: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }], usage: { input_tokens: 900, cache_read_input_tokens: 30000 } } }));
  fs.writeFileSync(path.join(liveDir, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', model: 'opus' }));

  const recordsDir = path.join(sessionDir, 'workflows');
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(path.join(recordsDir, 'wf_done-1.json'), JSON.stringify({
    runId: 'wf_done-1',
    workflowName: 'wiki-home-v3',
    status: 'completed',
    summary: 'Wiki home rework',
    agentCount: 2,
    totalTokens: 135624,
    totalToolCalls: 47,
    durationMs: 380224,
    startTime: 1783034470000,
    phases: [{ title: 'Implement' }, { title: 'Test' }],
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Implement' },
      {
        type: 'workflow_agent', index: 1, label: 'implement:wiki', phaseIndex: 1, phaseTitle: 'Implement', agentId: 'ax1', model: 'claude-fable-5', state: 'done', tokens: 89758, toolCalls: 32, durationMs: 334057, lastToolName: 'Bash', promptPreview: 'You are implementing a spec', resultPreview: 'All checks pass.',
      },
      {
        type: 'workflow_agent', index: 2, label: 'test:wiki', phaseIndex: 2, phaseTitle: 'Test', agentId: 'ax2', model: 'claude-fable-5', state: 'done', tokens: 45866, toolCalls: 15, durationMs: 46000, lastToolName: 'Bash', promptPreview: 'Run the tests', resultPreview: '21 passed',
      },
    ],
  }));

  const provider = createWorkflowRuns({
    getSessionMeta: async (id) => {
      if (id !== 'session-1') throw new Error('unknown');
      return { id, cwd: '/tmp/x', path: transcript };
    },
  });
  return { root, provider, liveDir };
}

test('a live run reports running state, per-agent facts, and identity from the parent transcript', async () => {
  const { provider } = makeFixture();
  const { runs } = await provider.runsForSession('session-1');
  assert.equal(runs.length, 2);
  const live = runs.find((r) => r.runId === 'wf_live-1');
  assert.equal(live.status, 'running');
  assert.equal(live.name, 'gold-sweep-batch');
  assert.deepEqual(live.phases, [{ title: 'Adjudicate' }, { title: 'Verify' }]);
  assert.equal(live.agentsTotal, 2);
  assert.equal(live.agentsDone, 1);
  assert.equal(live.agentsRunning, 1);
  const a1 = live.agents.find((a) => a.agentId === 'a1');
  assert.equal(a1.state, 'done');
  assert.equal(a1.model, 'opus');
  assert.match(a1.promptPreview, /adjudicator/);
  assert.match(a1.resultPreview, /complete/);
  const a2 = live.agents.find((a) => a.agentId === 'a2');
  assert.equal(a2.state, 'running');
  assert.equal(a2.lastTool, 'Bash');
  assert.equal(a2.tokens, 30900);
});

test('a run with cold files and no completion record is reported killed, never running', async () => {
  const { provider, liveDir } = makeFixture();
  const past = new Date(Date.now() - 10 * 60 * 1000);
  for (const entry of fs.readdirSync(liveDir)) {
    fs.utimesSync(path.join(liveDir, entry), past, past);
  }
  const { runs } = await provider.runsForSession('session-1');
  const dead = runs.find((r) => r.runId === 'wf_live-1');
  assert.equal(dead.status, 'killed');
  assert.equal(dead.agentsRunning, 0);
  assert.equal(dead.agentsDone, 1);
});

test('a completion record is authoritative and carries the rich per-agent rows', async () => {
  const { provider } = makeFixture();
  const { runs } = await provider.runsForSession('session-1');
  const done = runs.find((r) => r.runId === 'wf_done-1');
  assert.equal(done.status, 'completed');
  assert.equal(done.name, 'wiki-home-v3');
  assert.equal(done.totalTokens, 135624);
  assert.equal(done.agentsTotal, 2);
  assert.equal(done.agents.length, 2);
  assert.deepEqual(done.agents.map((a) => a.label), ['implement:wiki', 'test:wiki']);
  assert.equal(done.agents[0].phaseTitle, 'Implement');
  assert.equal(done.agents[0].tokens, 89758);
  assert.match(done.agents[0].resultPreview, /All checks pass/);
});

test('running runs sort ahead of finished ones', async () => {
  const { provider } = makeFixture();
  const { runs } = await provider.runsForSession('session-1');
  assert.equal(runs[0].runId, 'wf_live-1');
});

test('a session without a transcript path has no runs', async () => {
  const provider = createWorkflowRuns({ getSessionMeta: async () => ({ cwd: '/x', path: null }) });
  assert.deepEqual(await provider.runsForSession('whatever'), { runs: [] });
});
