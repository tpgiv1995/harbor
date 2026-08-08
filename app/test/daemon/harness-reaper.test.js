'use strict';

// A daemon spawned by a test harness outlives an ABORTED run forever: nothing
// exits it, and 28 of them were found orphaned on 2026-08-08, three interrupted
// `npm test` runs deep (the second time this shape has happened; the first was
// the 28-daemon pile of 2026-08-06 that daemon.js's shutdown comment records).
// Every suite's own teardown was correct, and none of it runs when the runner
// dies. The floor is therefore in the daemon, same philosophy as
// resolveUnitPolicy: a relocated store is by definition not the real
// installation, so its daemon defaults to dying with whoever spawned it.
// Production (the default store, or the CLI's deliberate detached start) never
// watches anything, and that side is proven here too, because a reaper that
// fires for the real daemon would be worse than the leak.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { resolveHarnessWatchPid } = require('../../src/daemon/harness-watch.js');
const { SessionClient } = require('../../src/daemon/client.js');

const DAEMON = path.resolve(__dirname, '../../src/daemon/daemon.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  return !alive(pid);
};

test('the watch pid resolves from the env: explicit wins, relocation defaults, production never watches', () => {
  // Explicit pid is obeyed whatever the store.
  assert.equal(resolveHarnessWatchPid({ HARBOR_SESSIOND_PARENT_PID: '4242' }, 99), 4242);
  // '0' is the CLI's deliberate opt-out: a detached start on a relocated store
  // is intentional, and its spawner exiting is the plan, not an abort.
  assert.equal(resolveHarnessWatchPid({ HARBOR_SESSIOND_PARENT_PID: '0', HARBOR_SESSIOND_DIR: '/tmp/x' }, 99), null);
  // A relocated store with no explicit answer is a harness: watch the spawner.
  assert.equal(resolveHarnessWatchPid({ HARBOR_SESSIOND_DIR: '/tmp/x' }, 99), 99);
  assert.equal(resolveHarnessWatchPid({ HARBOR_SESSIOND_SOCKET: '/tmp/x/d.sock' }, 99), 99);
  // The default store is the real installation. NEVER watched, whatever ppid is.
  assert.equal(resolveHarnessWatchPid({}, 99), null);
  // Garbage never turns into a watch on some innocent pid.
  assert.equal(resolveHarnessWatchPid({ HARBOR_SESSIOND_PARENT_PID: 'nonsense', HARBOR_SESSIOND_DIR: '/tmp/x' }, 99), null);
});

test('a harness daemon dies with its harness, and takes its sessions along', { timeout: 30000 }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr-reaper-'));
  const socket = path.join(store, 'd.sock');
  // The stand-in harness: alive until killed, like a test runner.
  const harness = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  const daemon = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socket,
      HARBOR_SESSIOND_PARENT_PID: String(harness.pid),
      HARBOR_SESSIOND_PARENT_POLL_MS: '150',
    },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(socket); i += 1) await sleep(50);
    assert.ok(fs.existsSync(socket), 'daemon should come up');

    const client = new SessionClient({ socketPath: socket, requestTimeoutMs: 10000 });
    let ptyPid = null;
    try {
      const spawned = await client.request('spawn', {
        argv: [process.platform === 'win32' ? 'cmd.exe' : '/bin/sleep', ...(process.platform === 'win32' ? [] : ['300'])],
        cwd: os.tmpdir(),
        env: { PATH: process.env.PATH },
        cols: 80,
        rows: 24,
      });
      const state = JSON.parse(fs.readFileSync(path.join(store, 'sessions', `${spawned.id}.json`), 'utf8'));
      ptyPid = state.pid;
      assert.ok(alive(ptyPid), 'the session process should be running');
    } finally {
      client.close();
    }

    // The abort: the harness dies without any teardown.
    harness.kill('SIGKILL');
    assert.ok(await waitGone(daemon.pid, 15000), 'daemon should exit once its harness is gone');
    assert.ok(await waitGone(ptyPid, 5000), 'the harness daemon\'s session should die with it');
  } finally {
    try { harness.kill('SIGKILL'); } catch {}
    try { daemon.kill('SIGKILL'); } catch {}
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('a relocated daemon with no explicit answer watches its spawner (the suites need no edits)', { timeout: 30000 }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr-reaper-'));
  const socket = path.join(store, 'd.sock');
  // The intermediate spawns the daemon exactly the way a suite does (direct
  // child, relocated store, nothing else) and then dies like an aborted run.
  const intermediate = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(DAEMON)}], {
      env: { ...process.env,
        HARBOR_SESSIOND_DIR: ${JSON.stringify(store)},
        HARBOR_SESSIOND_SOCKET: ${JSON.stringify(socket)},
        HARBOR_SESSIOND_PARENT_POLL_MS: '150',
      },
      stdio: 'ignore', detached: true,
    });
    child.unref();
    console.log(child.pid);
    setTimeout(() => process.exit(0), 1500);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  let daemonPid = null;
  intermediate.stdout.on('data', (chunk) => { daemonPid = daemonPid || Number(String(chunk).trim()); });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(socket); i += 1) await sleep(50);
    assert.ok(fs.existsSync(socket), 'daemon should come up');
    assert.ok(daemonPid, 'intermediate should report the daemon pid');
    // The intermediate exits on its own; the daemon must follow.
    assert.ok(await waitGone(daemonPid, 15000), 'orphaned daemon should reap itself');
  } finally {
    try { intermediate.kill('SIGKILL'); } catch {}
    if (daemonPid) { try { process.kill(daemonPid, 'SIGKILL'); } catch {} }
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('the CLI opt-out survives its spawner: a deliberate detached start is not an abort', { timeout: 30000 }, async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr-reaper-'));
  const socket = path.join(store, 'd.sock');
  const harness = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  const daemon = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: store,
      HARBOR_SESSIOND_SOCKET: socket,
      HARBOR_SESSIOND_PARENT_PID: '0',
      HARBOR_SESSIOND_PARENT_POLL_MS: '150',
    },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(socket); i += 1) await sleep(50);
    assert.ok(fs.existsSync(socket), 'daemon should come up');
    harness.kill('SIGKILL');
    await sleep(1500);
    assert.ok(alive(daemon.pid), 'an opted-out daemon must outlive its spawner');
  } finally {
    try { harness.kill('SIGKILL'); } catch {}
    try { daemon.kill('SIGKILL'); } catch {}
    fs.rmSync(store, { recursive: true, force: true });
  }
});
