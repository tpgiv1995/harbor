'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A CLAUDE THE DAEMON SPAWNS HAS A KNOWN SESSION ID. A pane spawned as
// `claude --model ... "<prompt>"` with no --session-id let the CLI pick its own
// id; the daemon recorded agent_session null and the pane sat in the rail as an
// untitled "Live session" linked to no transcript. The daemon now names the id
// itself for an interactive start with no session flag. Resume/continue/print,
// a caller-named session and a subcommand (`claude update`, `claude mcp ...`)
// keep their argv exactly as given, and `--session-id=X` is read as X.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

const DAEMON = path.resolve(__dirname, '../../src/daemon/daemon.js');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(probe, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(message);
    await sleep(100);
  }
}

function sessionState(dir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${id}.json`), 'utf8')); }
  catch { return null; }
}

// The stand-in is a shell script, so the posix keeper is the one exercised.
test('an interactive claude spawn gets a --session-id; resume, named, subcommand and = form spawns do not', { skip: process.platform === 'win32', timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-claude-sid-'));
  const socketPath = path.join(dir, 'daemon.sock');
  // Named `claude` so derivedIdentity calls it one; it only waits.
  const claude = path.join(dir, 'claude');
  fs.writeFileSync(claude, '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath });
  await waitUntil(async () => {
    try { return (await client.request('health')).ok; } catch { return false; }
  }, `isolated sessiond never answered health, stderr=${stderr}`);
  const ids = [];
  t.after(async () => {
    for (const id of ids) { try { await client.request('terminate', { id, signal: 'SIGKILL' }); } catch {} }
    client.close();
    if (daemon.exitCode === null) { daemon.kill(); await new Promise((resolve) => daemon.once('exit', resolve)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const spawnState = async (params) => {
    const { id } = await client.request('spawn', { cwd: dir, env: {}, cols: 80, rows: 24, ...params });
    ids.push(id);
    return waitUntil(() => sessionState(dir, id), `no state file for ${id}`);
  };

  const flagged = await spawnState({ argv: [claude, '--model', 'opus', 'review the work'] });
  assert.equal(flagged.argv[1], '--session-id');
  assert.match(flagged.argv[2], UUID_RE);
  assert.deepEqual(flagged.argv.slice(3), ['--model', 'opus', 'review the work']);
  assert.equal(flagged.agent, 'claude');
  assert.equal(flagged.agent_session, flagged.argv[2]);

  const bare = await spawnState({ argv: [claude] });
  assert.equal(bare.argv.length, 3);
  assert.equal(bare.agent_session, bare.argv[2]);

  const resumed = await spawnState({ argv: [claude, '--resume', 'abc'] });
  assert.deepEqual(resumed.argv, [claude, '--resume', 'abc']);
  assert.equal(resumed.agent_session, null);

  const named = await spawnState({ argv: [claude, '--model', 'opus'], agent_session: 'given' });
  assert.deepEqual(named.argv, [claude, '--model', 'opus']);
  assert.equal(named.agent_session, 'given');

  for (const sub of [['update'], ['mcp', 'list'], ['doctor']]) {
    const state = await spawnState({ argv: [claude, ...sub] });
    assert.deepEqual(state.argv, [claude, ...sub], `subcommand ${sub[0]} must not be prefixed`);
    assert.equal(state.agent_session, null);
  }

  const joined = await spawnState({ argv: [claude, '--session-id=0b5f6d1e-1111-4222-8333-944445555666'] });
  assert.deepEqual(joined.argv, [claude, '--session-id=0b5f6d1e-1111-4222-8333-944445555666']);
  assert.equal(joined.agent_session, '0b5f6d1e-1111-4222-8333-944445555666');
});
