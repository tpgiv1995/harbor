'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// TWO REFINEMENTS FROM THE 2026-08-09 CONTAINMENT PROOF, one file because they
// are two halves of the same promise: a session that dies inside this boot is
// REPORTED dead, promptly and honestly.
//
// 1. The kernel must prefer the session's processes over the keeper. The live
//    memcg-kill proof (harbor-session-bf290647...) showed the OOM killer
//    choosing the KEEPER: the pty died with it, so the session collapsed with
//    exit:null and nothing left to answer for it. The keeper raises its pty
//    child's oom_score_adj (children inherit it on fork, so a runaway grep
//    carries it too); the keeper outlives the kill and records the exit.
//
// 2. Within-boot deaths must surface WITHOUT a daemon restart. Three keepers
//    crashed at 02:40 and the daemon served them as "live" for 25 minutes,
//    because reconciliation ran only at startup. It runs on an interval now.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');

const DAEMON = path.resolve(__dirname, '../../src/daemon/daemon.js');
const KEEPER = path.resolve(__dirname, '../../src/daemon/keeper.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('1. the pty child carries a higher oom badness than its keeper', { skip: process.platform !== 'linux' && 'oom_score_adj is linux-only' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-oom-pref-'));
  const socketPath = path.join(dir, 'keeper.sock');
  const statePath = path.join(dir, 'state.json');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    id: 'oom-pref-test', argv: ['/bin/bash', '--noprofile', '--norc'], cwd: dir,
    env: { PATH: process.env.PATH }, cols: 80, rows: 24, agent: null, agent_session: null,
    created_at: new Date().toISOString(), state_path: statePath, keeper_socket: socketPath,
  }));
  const keeper = spawn(guiNodeExec, [KEEPER, configPath], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.pid) { try { process.kill(-state.pid, 'SIGKILL'); } catch { try { process.kill(state.pid, 'SIGKILL'); } catch {} } }
    } catch {}
    if (keeper.exitCode === null) { keeper.kill('SIGKILL'); await new Promise((r) => keeper.once('exit', r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ready = Date.now() + 5000;
  while (!fs.existsSync(statePath) && Date.now() < ready) await sleep(25);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const childAdj = Number(fs.readFileSync(`/proc/${state.pid}/oom_score_adj`, 'utf8').trim());
  const keeperAdj = Number(fs.readFileSync(`/proc/${keeper.pid}/oom_score_adj`, 'utf8').trim());

  // A HARNESS THAT CANNOT TELL PASS FROM FAIL REPORTS VOID, NEVER PASS
  // (2026-08-09). oom_score_adj is INHERITED ON FORK and an unprivileged
  // process may only ever RAISE it. Run this suite from inside a Harbor
  // session and the runner is itself a keeper's pty child sitting at 500: the
  // keeper spawned here inherits 500, `500 > 500` fails on correct behaviour,
  // and, far worse, the child is ALREADY 500 by inheritance, so even
  // `childAdj === 500` passes with keeper.js's oom write commented out. That
  // was measured, not reasoned about: the weakened assertion was run against a
  // deliberately broken keeper and reported ok. Nothing here can be proven
  // from such a runner and the honest verdict is a skip. Same family as the
  // session-scope spec 6 fix landed the same day, and as the 2026-07-29
  // unit-name lesson: a harness must not assume it is outside the thing it is
  // testing.
  if (keeperAdj >= 500) {
    t.skip(`runner is itself at oom_score_adj ${keeperAdj} (a Harbor session is a keeper's pty child), so the spawned keeper inherits it and neither half of this spec can distinguish a working guard from a broken one. Run from a plain terminal.`);
    return;
  }

  assert.equal(childAdj, 500, 'the pty child must be raised to 500');
  assert.ok(childAdj > keeperAdj,
    `the session process (adj ${childAdj}) must outrank its keeper (adj ${keeperAdj}) for the OOM killer`);
});

test('2. a keeper killed within this boot surfaces as exited without a daemon restart', { skip: process.platform === 'win32' && 'posix signal harness' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-reconcile-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_SESSIOND_RECONCILE_INTERVAL_MS: '300',
      HARBOR_NO_DAEMON_START: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const probe = new SessionClient({ socketPath });
      const result = await probe.request('health');
      probe.close();
      if (result.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`daemon never answered: ${stderr}`);
    await sleep(50);
  }
  const client = new SessionClient({ socketPath });
  t.after(async () => {
    try {
      const listed = await client.request('list');
      for (const s of listed.sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {});
    } catch {}
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((r) => daemon.once('exit', r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const spawned = await client.request('spawn', { argv: ['/bin/bash', '--noprofile', '--norc'], cwd: dir, env: {}, cols: 80, rows: 24 });
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${spawned.id}.json`), 'utf8'));
  const before = await client.request('list');
  assert.equal(before.sessions.find((s) => s.id === spawned.id).exit, null, 'sanity: live before the kill');

  // The 02:40 shape and the memcg shape are the same from outside: the keeper
  // dies without running a line of its own teardown.
  process.kill(state.keeper_pid, 'SIGKILL');
  try { process.kill(-state.pid, 'SIGKILL'); } catch { try { process.kill(state.pid, 'SIGKILL'); } catch {} }

  const until = Date.now() + 5000;
  let row = null;
  while (Date.now() < until) {
    const listed = await client.request('list');
    row = listed.sessions.find((s) => s.id === spawned.id);
    if (row && row.exit) break;
    await sleep(100);
  }
  assert.ok(row && row.exit, 'the dead session must surface as exited within the reconcile interval');
  assert.match(row.exit.reason || '', /not answering/, 'the exit says what was actually known');
});

test('3. a keeper that accepts but never answers is put down before it is written off, and a healthy neighbour is untouched', { skip: process.platform !== 'linux' && 'SIGSTOP harness' }, async (t) => {
  // The kernel completes an AF_UNIX connect out of the listen backlog, so a
  // SIGSTOPped keeper still LOOKS alive to a bare connect: this is the lying
  // gate, reproduced deterministically. The reconciler must (a) not trust the
  // connect, (b) not mark a merely-busy keeper on one strike, and (c) never
  // write "exited" while the wedged keeper still runs, or the first resume
  // becomes a double-writer. Put down first, then record.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-mute-keeper-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_SESSIOND_RECONCILE_INTERVAL_MS: '250',
      HARBOR_SESSIOND_PROBE_TIMEOUT_MS: '300',
      HARBOR_NO_DAEMON_START: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const probe = new SessionClient({ socketPath });
      const result = await probe.request('health');
      probe.close();
      if (result.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`daemon never answered: ${stderr}`);
    await sleep(50);
  }
  const client = new SessionClient({ socketPath });
  t.after(async () => {
    try {
      const listed = await client.request('list');
      for (const s of listed.sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {});
    } catch {}
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((r) => daemon.once('exit', r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const victim = await client.request('spawn', { argv: ['/bin/bash', '--noprofile', '--norc'], cwd: dir, env: {}, cols: 80, rows: 24 });
  const control = await client.request('spawn', { argv: ['/bin/bash', '--noprofile', '--norc'], cwd: dir, env: {}, cols: 80, rows: 24 });
  const victimState = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${victim.id}.json`), 'utf8'));

  process.kill(victimState.keeper_pid, 'SIGSTOP');

  const until = Date.now() + 15000;
  let row = null;
  while (Date.now() < until) {
    const listed = await client.request('list');
    row = listed.sessions.find((s) => s.id === victim.id);
    if (row && row.exit) break;
    await sleep(150);
  }
  assert.ok(row && row.exit, 'a mute keeper must eventually surface as exited');
  assert.match(row.exit.reason || '', /put down/, 'the exit says the keeper was put down, not merely lost');
  assert.throws(() => process.kill(victimState.keeper_pid, 0),
    'the wedged keeper must actually be dead before the store calls it exited');

  const listed = await client.request('list');
  const controlRow = listed.sessions.find((s) => s.id === control.id);
  assert.equal(controlRow.exit, null, 'hysteresis must never take a healthy neighbour');
});
