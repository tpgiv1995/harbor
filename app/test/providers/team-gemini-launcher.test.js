'use strict';

// Carrier Bridge starts Gemini workers through gemini-worker.mjs (outside this repo); the Team chart finds them in the
// process table like the Cursor workers, with agy as the child (2026-11-23). Every pid, path and prompt is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTeamProvider } = require('../../src/main/providers/team.js');

const CONV = '32fe68ca-b177-4dba-86f4-6272f59c04b9';

function bridge({ child }) {
  return {
    emitter: new EventEmitter(),
    getLivePanes: () => [],
    daemonRequest: async (verb, args) => {
      if (verb === 'proc-find' && args.needle === 'gemini-worker.mjs') {
        return { processes: [{ pid: 5100, ppid: 1, name: 'node.exe', created: 0,
          cmdline: 'node C:\\tools\\gemini-worker\\gemini-worker.mjs --trial --cd C:\\work\\demo --model gemini-4-hydrogen --effort low --prompt "Count the lamps"' }] };
      }
      if (verb === 'proc-tree') return { processes: [{ pid: 5100, name: 'node.exe', cmdline: 'node gemini-worker.mjs' }, ...(child ? [child] : [])] };
      if (verb === 'proc-info') return { alive: false };
      return { processes: [] };
    },
  };
}

async function scan(opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-gemini-'));
  const provider = createTeamProvider({ bridge: bridge(opts), platform: 'win32', env: {}, cacheDir: tmp, launchesFile: path.join(tmp, 'launches.jsonl') });
  try {
    await provider.discover();
    return provider._state().processes;
  } finally {
    provider.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('a gemini-worker run is a Gemini card, with the worker\'s own words for folder, model, effort and brief', async () => {
  const [row, ...rest] = await scan({ child: { pid: 5101, name: 'agy.exe', cmdline: 'C:\\tools\\antigravity\\1.5.14\\agy.exe -p --model gemini-4-hydrogen --effort low' } });
  assert.equal(rest.length, 0);
  assert.equal(row.launcher, 'gemini-worker');
  assert.equal(row.provider, 'gemini', 'it was a Claude card before the launcher was known');
  assert.equal(row.pid, 5101, 'the card follows the agy child, not the launcher');
  assert.equal(row.launcherPid, 5100);
  assert.equal(row.cwd, 'C:\\work\\demo');
  assert.equal(row.model, 'gemini-4-hydrogen');
  assert.equal(row.effort, 'low');
  assert.equal(row.title, 'Count the lamps');
});

test('the worker is not mistaken for its own child, and a worker with no agy child yet still gets its card', async () => {
  const [row] = await scan({ child: null });
  assert.equal(row.provider, 'gemini');
  assert.equal(row.pid, 5100, 'no child yet: the launcher stands in');
});

test('a resume names its conversation with --conversation', async () => {
  const [row] = await scan({ child: { pid: 5101, name: 'agy.exe', cmdline: `C:\\tools\\agy.exe --conversation ${CONV} -p` } });
  assert.equal(row.sessionId, CONV);
});

test('"agy" only counts as a program name, never as a fragment of another word', async () => {
  const [row] = await scan({ child: { pid: 5101, name: 'node.exe', cmdline: 'node C:\\tools\\legacy-tool\\run.js --legacy' } });
  assert.equal(row.pid, 5100, 'a legacy process is not an agy child');
});
