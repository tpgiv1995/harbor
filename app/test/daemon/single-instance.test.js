'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A SECOND DAEMON MUST NOT STEAL A LIVE STORE (2026-08-06).
//
// Live-caught on Pat's machine at 28 daemons deep, 27 of them orphaned and every
// one still LISTENing on the same socket path. Two defects composed:
//
//   1. `daemon.js` opened with a blind `fs.unlinkSync(paths.socket)`, so any new
//      daemon deleted the socket a RUNNING daemon was serving on and rebound it.
//      The original kept running, still holding every session it had spawned,
//      behind an inode nothing could reach.
//   2. `harbor-sessiond start` had no already-running gate, and a `systemd-run`
//      failure (which is exactly what a unit name that is already taken produces)
//      fell through to a detached spawn. So the recovery path manufactured
//      daemons OUTSIDE the one stable unit name that exists to stop this.
//
// These specs are two-sided ON PURPOSE. A refusal alone passes just as well if
// the guard has wedged the daemon shut: a STALE socket (the unclean-exit
// leftover) must still be replaceable, or the fix is worse than the bug.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { listenAddress } = require('../../src/daemon/paths.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

const ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(ROOT, 'bin/harbor-sessiond');
const DAEMON = path.join(ROOT, 'app/src/daemon/daemon.js');

const dirs = [];
const pids = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A relocated store is not the real installation, so it must never reach the
// shared systemd unit name. Blanking HARBOR_SESSIOND_UNIT keeps `startDaemon` on
// its detached path, which is what the pre-existing suites already rely on.
function isolatedEnv(dir) {
  return {
    ...process.env,
    HARBOR_SESSIOND_DIR: dir,
    HARBOR_SESSIOND_SOCKET: path.join(dir, 'daemon.sock'),
    HARBOR_SESSIOND_UNIT: '',
    HARBOR_NO_DAEMON_START: '1',
    HERDR_SOCKET_PATH: path.join(dir, 'not-user.sock'),
    // These specs pin the GATE (stale sockets, refusal, unlink discipline),
    // and the stale-socket spec SIGKILLs a daemon and asserts the socket goes
    // quiet. The supervisor's respawn lane (2026-08-30) would resurrect it in
    // ~300ms and leak an untracked successor, so it is opted out here; the
    // respawn lanes are pinned by test/daemon/self-heal.test.js.
    HARBOR_SESSIOND_RESPAWN_MAX: '0',
  };
}

function makeStore() {
  // Short prefix on purpose: sun_path is 108 bytes and a keeper socket carries a
  // full uuid. See socket-path.test.js.
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'hbr-si-'));
  dirs.push(dir);
  return dir;
}

function cli(dir, args) {
  return new Promise((resolve) => {
    execFile(guiNodeExec, [CLI, ...args], { windowsHide: true, env: isolatedEnv(dir) }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function healthy(socketPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: listenAddress(socketPath) });
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; sock.destroy(); resolve(value); } };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

async function waitHealthy(socketPath, deadlineMs = 10000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (await healthy(socketPath)) return true;
    if (Date.now() >= until) return false;
    await sleep(50);
  }
}

function socketOf(dir) { return path.join(dir, 'daemon.sock'); }

async function startViaCli(dir) {
  const result = await cli(dir, ['start', '--json']);
  const payload = JSON.parse(result.stdout.trim() || '{}');
  if (payload.pid) pids.push(payload.pid);
  return payload;
}

function liveListenerPid(socketPath) {
  // Which process currently holds the LISTEN socket. Used to prove the ORIGINAL
  // daemon is the one still serving, not a replacement wearing the same path.
  const { execFileSync } = require('node:child_process');
  try {
    const out = execFileSync('ss', ['-xlp'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.includes(socketPath));
    const match = line && line.match(/pid=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  await sleep(50);
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('a second daemon refuses a live store and leaves the first one serving', async () => {
  const dir = makeStore();
  const first = await startViaCli(dir);
  assert.equal(first.started, true, 'first start should succeed');
  assert.equal(first.healthy, true, 'first daemon should answer a real request');

  const ownerBefore = liveListenerPid(socketOf(dir));

  // The raw daemon, bypassing the CLI gate entirely. This is the structural
  // guard: it must hold no matter who calls start.
  const second = await new Promise((resolve) => {
    const child = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env: isolatedEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stderr }));
  });

  assert.equal(second.code, 3, 'a second daemon must exit 3, not bind');
  assert.match(second.stderr, /already running/i);

  // The point of the whole thing: the ORIGINAL is untouched.
  assert.equal(await healthy(socketOf(dir)), true, 'original daemon must still serve');
  const ownerAfter = liveListenerPid(socketOf(dir));
  if (ownerBefore && ownerAfter) {
    assert.equal(ownerAfter, ownerBefore, 'the original process must still own the socket');
  }
});

test('the CLI reports alreadyRunning instead of starting a second daemon', async () => {
  const dir = makeStore();
  const first = await startViaCli(dir);
  assert.equal(first.started, true);

  const second = await startViaCli(dir);
  assert.equal(second.started, false, 'a second start must not claim to have started anything');
  assert.equal(second.alreadyRunning, true);
  assert.equal(await healthy(socketOf(dir)), true);
});

test('a STALE socket left by an unclean exit is still replaceable', async () => {
  // The other side. A guard that refuses everything would pass the specs above
  // and leave Pat with a daemon that can never restart after a crash.
  const dir = makeStore();
  const first = await startViaCli(dir);
  assert.equal(first.healthy, true);

  const owner = liveListenerPid(socketOf(dir)) || first.pid;
  process.kill(owner, 'SIGKILL'); // no shutdown handler runs, so the file survives
  await sleep(200);
  if (process.platform !== 'win32') {
    assert.equal(fs.existsSync(socketOf(dir)), true, 'the stale socket file should still be on disk');
  } else {
    assert.equal(fs.existsSync(socketOf(dir)), false, 'a named pipe must not masquerade as a socket file');
  }
  assert.equal(await healthy(socketOf(dir)), false, 'but nothing should answer on it');

  const restart = await startViaCli(dir);
  assert.equal(restart.started, true, 'a proven-dead socket must be replaceable');
  assert.equal(restart.healthy, true);
  assert.equal(await waitHealthy(socketOf(dir), 5000), true);
});

test('a refused daemon does not delete the live daemon\'s socket when it exits', async () => {
  // Live-caught 2026-08-06 while reaping the 28 orphans: `shutdown()` unlinked
  // the socket path unconditionally, so a daemon that never bound it still
  // removed it on SIGTERM. The survivor kept running and serving, and nothing
  // could reach it: Pat's app went to `connect ENOENT` with six live sessions
  // behind a socket file that a corpse had taken with it.
  const dir = makeStore();
  const first = await startViaCli(dir);
  assert.equal(first.healthy, true);

  const refused = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env: isolatedEnv(dir), stdio: 'ignore' });
  const code = await new Promise((resolve) => refused.on('exit', resolve));
  assert.equal(code, 3, 'the second daemon should refuse');

  // The refused process exits on its own; SIGTERM a fresh one mid-life too, so
  // both exit paths are covered.
  const refusedTwo = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env: isolatedEnv(dir), stdio: 'ignore' });
  await sleep(150);
  try { refusedTwo.kill('SIGTERM'); } catch {}
  await sleep(400);

  if (process.platform !== 'win32') {
    assert.equal(fs.existsSync(socketOf(dir)), true, 'the live socket file must still exist');
  } else {
    assert.equal(fs.existsSync(socketOf(dir)), false, 'the live named pipe leaves no filesystem entry');
  }
  assert.equal(await healthy(socketOf(dir)), true, 'the live daemon must still be reachable');
});

test('a client vanishing mid-request does not kill the daemon', async () => {
  // Live-caught 2026-08-06 06:19:48Z: `read ECONNRESET` reached an 'error' event
  // with no listener on a connection socket, which is an uncaught exception, and
  // it took the daemon down with every session it owned.
  const dir = makeStore();
  const started = await startViaCli(dir);
  assert.equal(started.healthy, true);
  const owner = liveListenerPid(socketOf(dir)) || started.pid;

  const socketPath = socketOf(dir);
  await new Promise((resolve) => {
    let opened = 0;
    for (let i = 0; i < 25; i += 1) {
      const sock = net.createConnection(socketPath, () => {
        // Ask for something that produces a reply, then vanish before reading it.
        sock.write(`${JSON.stringify({ type: 'request', request_id: `r${i}`, verb: 'health' })}\n`);
        setImmediate(() => sock.destroy());
        if (++opened === 25) setTimeout(resolve, 400);
      });
      sock.on('error', () => {});
    }
    setTimeout(resolve, 3000);
  });

  assert.doesNotThrow(() => process.kill(owner, 0), 'daemon must still be alive');
  assert.equal(await healthy(socketPath), true, 'daemon must still be serving');
});
