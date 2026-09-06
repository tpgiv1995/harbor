'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A SPAWN THAT MISSES ITS DEADLINE IS KILLED, NEVER ABANDONED (2026-08-09).
//
// During the 02:33 memory stall (one runaway grep at 36G, swap full, PSI ~86%)
// three consecutive spawns timed out at the 7s deadline, the daemon told each
// caller "keeper never came up", and then FORGOT the child it had spawned. All
// three keepers finished booting seconds later, bound their sockets, and sat
// holding live claudes nobody could reach: two freshly minted session ids, and
// one `--resume` of the very session Pat was about to retry, which is a
// double-writer waiting to happen. "Failed" must be TRUE: whatever the spawn
// started is put down, a state file that appeared late is marked exited, and
// the files are cleaned up.
//
// The stall is reproduced the way it actually presented: the keeper process is
// SLOW TO BOOT (a --require hook that blocks before keeper.js runs), not
// broken. The two-sided proof is the time axis itself: at T+deadline the spawn
// has failed, and at T+slow (after the keeper would have finished booting) the
// old daemon hosted a live ghost while the fixed daemon hosts nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');

const DAEMON = path.resolve(__dirname, '../../src/daemon/daemon.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const haveSystemdUser = process.platform === 'linux'
  && spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).stdout !== '';

// Everything a spawn leaves running carries the store directory in its argv
// (keeper.js <dir>/sessions/<id>.config.json), and the directory is a fresh
// mkdtemp, so this is an exact roll call of the harness's own processes. The
// daemon itself does not match: its argv carries only daemon.js.
function processesOfStore(dir) {
  try {
    return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' })
      .split('\n').map((line) => Number(line)).filter((pid) => pid && pid !== process.pid);
  } catch { return []; } // pgrep exits 1 on no match
}

async function harness(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-reap-test-'));
  const socketPath = path.join(dir, 'daemon.sock');
  // Blocks only KEEPER processes, before keeper.js executes a single line:
  // exactly what a machine-wide stall does to a freshly forked keeper.
  const slowPath = path.join(dir, 'slow-boot.js');
  fs.writeFileSync(slowPath, `'use strict';
if ((process.argv[1] || '').endsWith('keeper.js')) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
}
`);
  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: dir,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_SESSIOND_SPAWN_TIMEOUT_MS: '250',
    NODE_OPTIONS: `--require ${slowPath}`,
    HARBOR_NO_DAEMON_START: '1',
    ...extraEnv,
  };
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((r) => daemon.once('exit', r)); }
    // The red side of this suite (pre-fix) leaves a live ghost; a test must
    // never leak one into the machine whatever the verdict was.
    for (const pid of processesOfStore(dir)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { client, dir };
}

function liveStates(dir) {
  const sessions = path.join(dir, 'sessions');
  let names = [];
  try { names = fs.readdirSync(sessions); } catch { return []; }
  return names
    .filter((name) => name.endsWith('.json') && !name.endsWith('.config.json'))
    .map((name) => { try { return JSON.parse(fs.readFileSync(path.join(sessions, name), 'utf8')); } catch { return null; } })
    .filter((state) => state && !state.exit);
}

async function failedSpawn(client, dir) {
  const started = Date.now();
  let error = null;
  try {
    // The pty argv carries the store dir ON PURPOSE (review round 1): the
    // post-mortem roll call is `pgrep -f <dir>`, and a pty child whose argv
    // never mentioned the dir would be invisible to it, so "and anything it
    // started" in spec 1's assertion would be unfalsifiable.
    await client.request('spawn', { argv: ['/bin/bash', '-c', `sleep 300 # pty-of ${dir}`], cwd: dir, env: {}, cols: 80, rows: 24 });
  } catch (caught) { error = caught; }
  assert.ok(error, 'a spawn whose keeper cannot boot inside the deadline must fail');
  assert.match(error.message, /keeper never came up/);
  const id = (error.message.match(/for session ([0-9a-f-]{36})/) || [])[1];
  assert.ok(id, `the failure names its session id: ${error.message}`);
  return { id, started };
}

test('1. a keeper that misses the spawn deadline is reaped, not left as a ghost', { skip: process.platform !== 'linux' && 'posix-only harness' }, async (t) => {
  const { client, dir } = await harness(t);
  const { started } = await failedSpawn(client, dir);

  // Give the abandoned keeper every chance the 02:33 ghosts had: wait past the
  // end of its slow boot, plus margin to bind and persist.
  await sleep(Math.max(0, started + 2500 - Date.now()));

  assert.deepEqual(processesOfStore(dir), [],
    'the spawned keeper (and anything it started) must be dead after a failed spawn');
  assert.deepEqual(liveStates(dir), [],
    'a state file from a late-binding keeper must not claim the session is running');
  const leftoverConfigs = fs.readdirSync(path.join(dir, 'sessions')).filter((n) => n.endsWith('.config.json'));
  assert.deepEqual(leftoverConfigs, [], 'a failed spawn must not leave its config behind');
  const listed = await client.request('list');
  assert.deepEqual(listed.sessions.filter((s) => !s.exit), [],
    'the daemon must not serve a session it reported as failed');
});

test('2. a scoped spawn that misses the deadline takes its scope down with it', { skip: !haveSystemdUser && 'no user systemd manager' }, async (t) => {
  // Flat name, nothing called "harbor": a dash is a slice HIERARCHY and the
  // harness must never share a parent with the production pool (2026-07-29).
  const slice = `hbreaptest${process.pid}.slice`;
  t.after(() => { spawnSync('systemctl', ['--user', 'stop', slice], { encoding: 'utf8' }); });
  const { client, dir } = await harness(t, { HARBOR_SESSIOND_SLICE: slice });
  const { id, started } = await failedSpawn(client, dir);

  await sleep(Math.max(0, started + 2500 - Date.now()));

  assert.deepEqual(processesOfStore(dir), [], 'the scoped keeper must be dead');
  const unit = `harbor-session-${id}.scope`;
  const state = spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).stdout.trim();
  assert.notEqual(state, 'active', `${unit} must not survive a failed spawn`);
  assert.deepEqual(liveStates(dir), [], 'no live state after a reaped scoped spawn');
});
