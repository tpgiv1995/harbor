'use strict';

// The Team chart reads workers from the machine's process table, which no HOME
// relocation isolates, so an isolated Harbor (the README capture) charted the
// real workers running beside it. HARBOR_TEAM_NO_PROCESS_SCAN=1 turns the scan
// off. Two-sided: the same fake table yields a worker without the switch and
// none with it. Every pid, path and prompt here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTeamProvider } = require('../../src/main/providers/team.js');

function fakeBridge() {
  return {
    emitter: new EventEmitter(),
    getLivePanes: () => [],
    daemonRequest: async (verb, args) => {
      if (verb === 'proc-find' && args.needle === 'claude-worker.mjs') {
        return { processes: [{ pid: 4100, ppid: 1, name: 'node.exe', cmdline: 'node C:\\tools\\claude-worker\\claude-worker.mjs --prompt "Count the lamps"', created: 0 }] };
      }
      if (verb === 'proc-info') return { alive: false };
      return { processes: [] };
    },
  };
}

async function scannedProcesses(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-scan-'));
  const provider = createTeamProvider({
    bridge: fakeBridge(), platform: 'win32', env, cacheDir: tmp, launchesFile: path.join(tmp, 'launches.jsonl'),
  });
  try {
    await provider.discover();
    return provider._state().processes;
  } finally {
    provider.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('the Team chart finds a worker in the process table by default', async () => {
  const processes = await scannedProcesses({});
  assert.equal(processes.length, 1);
  assert.equal(processes[0].launcher, 'claude-worker');
  assert.equal(processes[0].title, 'Count the lamps');
});

test('HARBOR_TEAM_NO_PROCESS_SCAN=1 leaves the process table unread', async () => {
  assert.deepEqual(await scannedProcesses({ HARBOR_TEAM_NO_PROCESS_SCAN: '1' }), []);
});

test('HARBOR_TEAM_PROCESS_FIXTURE replaces the process table and supplies live launch records', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-fixture-'));
  const fixture = path.join(tmp, 'team.json');
  fs.writeFileSync(fixture, JSON.stringify({
    processes: [{ pid: 9001, launcher: 'cursor-worker', provider: 'cursor', title: 'Fix the nav' }],
    launches: [{ launch: 'l1', launcher: 'claude-worker', pid: 9100, childPid: 9101, child: { session: '11111111-1111-4111-8111-111111111111', provider: 'claude', title: 'Lead' }, startedMs: Date.now() }],
  }));
  const provider = createTeamProvider({
    bridge: fakeBridge(), platform: 'win32', env: { HARBOR_TEAM_PROCESS_FIXTURE: fixture }, cacheDir: tmp, launchesFile: path.join(tmp, 'launches.jsonl'),
  });
  try {
    await provider.discover();
    const state = provider._state();
    // The machine's table (the fake bridge's claude-worker) is never read.
    assert.deepEqual(state.processes.map((p) => p.title), ['Fix the nav']);
    await provider.recompute();
    assert.ok(JSON.stringify(provider.get()).includes('11111111-1111-4111-8111-111111111111'), 'the fixture launch is on the chart');
  } finally {
    provider.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
