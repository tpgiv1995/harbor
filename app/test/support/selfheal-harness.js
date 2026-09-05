'use strict';

// Shared plumbing for the self-heal / handover suites (2026-08-30). The rules
// this file encodes are the daemon family's porting doctrine, not style:
//   - every child spawns through gui-node.js (no visible console windows);
//   - liveness is a real CONNECTION or a real REQUEST, never a file existing;
//   - cleanup registers BEFORE any readiness wait (a leaked child keeps
//     node --test alive forever);
//   - HARBOR_SESSIOND_PARENT_PID names the runner, so every daemon in a chain
//     dies with an aborted run (the harness-reaper floor), and the CLI start
//     path forwards it to successor daemons it spawns;
//   - a pty session is terminated THROUGH the daemon before its store dir is
//     deleted (an orphan ConPTY cmd.exe holds the dir as cwd and rmSync
//     EPERMs forever).

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { execPath: guiNodeExec } = require('./gui-node.js');
const { realTmpDir } = require('./real-tmpdir.js');
const { listenAddress } = require('../../src/daemon/paths.js');
const { SessionClient } = require('../../src/daemon/client.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const WATCHER = path.join(ROOT, 'src/daemon/daemon-watch.js');
const CLI = path.resolve(ROOT, '../bin/harbor-sessiond');
const SHELL_ARGV = process.platform === 'win32'
  ? [process.env.ComSpec || 'cmd.exe', '/Q']
  : ['/bin/bash', '--noprofile', '--norc'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitUntil(fn, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${message} (after ${timeoutMs}ms)`);
    await sleep(50);
  }
}

async function waitGone(pid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

function canConnect(socketPath) {
  return new Promise((resolve) => {
    const probe = net.connect(listenAddress(socketPath));
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

// One-shot health probe: resolves the daemon pid on answer, null otherwise.
async function healthPid(socketPath, timeoutMs = 2000) {
  const client = new SessionClient({ socketPath, requestTimeoutMs: timeoutMs });
  try { return (await client.request('health')).pid ?? null; }
  catch { return null; }
  finally { try { client.close(); } catch {} }
}

function freshStore(prefix) {
  const store = fs.mkdtempSync(path.join(realTmpDir(), prefix));
  return { store, socket: path.join(store, 'daemon.sock'), log: path.join(store, 'sessiond.log') };
}

const readLog = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

// Log lines are eventually consistent with the events they record (the
// watcher's successor confirmation lands on its NEXT probe tick, up to one
// watch interval after the successor binds), so a log assertion waits.
async function waitForLog(fixture, pattern, timeoutMs = 10000) {
  await waitUntil(() => pattern.test(readLog(fixture.log)), `log never matched ${pattern}`, timeoutMs);
  return readLog(fixture.log);
}

// Fast supervisor knobs: wedge trip in ~2s instead of ~60s. TEST_WEDGE is set
// so the deterministic wedge seam is available; cleanDaemonEnv never forwards
// it, so CLI-spawned successors stay unwedgeable, which is also what the
// deliberate-handover spec wants.
function chainEnv(fixture, extra = {}) {
  return {
    ...process.env,
    HARBOR_SESSIOND_DIR: fixture.store,
    HARBOR_SESSIOND_SOCKET: fixture.socket,
    // A relocated store only gets Windows job objects when it names its own
    // namespace (the i1 policy); naming one here makes the handover specs
    // actually exercise the successor's reacquire-by-name path.
    HARBOR_SESSIOND_JOB_NAMESPACE: `hbrtest-${path.basename(fixture.store)}`,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_PARENT_PID: String(process.pid),
    HARBOR_SESSIOND_PARENT_POLL_MS: '200',
    HARBOR_SESSIOND_TEST_WEDGE: '1',
    HARBOR_SESSIOND_WATCH_INTERVAL_MS: '250',
    // 1500, not lower: a loaded gate machine can honestly take >600ms to
    // answer health twice in a row, and a false trip mid-spec kills a healthy
    // daemon under the test's feet (seen live). The trip still lands in ~4s.
    HARBOR_SESSIOND_WATCH_TIMEOUT_MS: '1500',
    HARBOR_SESSIOND_WATCH_FAILURES: '2',
    HARBOR_SESSIOND_PIPE_RELEASE_TIMEOUT_MS: '5000',
    HARBOR_SESSIOND_YIELD_DRAIN_MS: '1000',
    HARBOR_SESSIOND_RSS_INTERVAL_MS: '0',
    ...extra,
  };
}

// Spawn the supervised chain (daemon-watch -> daemon). Cleanup is registered
// on `cleanups` BEFORE the readiness wait. Returns { watcher, daemonPid }.
async function startChain(fixture, env, cleanups, { daemonPath = DAEMON } = {}) {
  const watcher = spawn(guiNodeExec, [WATCHER, daemonPath], { windowsHide: true, env, stdio: 'ignore' });
  cleanups.push(async () => {
    // Best effort, order matters: sessions die through the daemon (registered
    // separately by spawnShellSession), then the chain, then the store.
    const pid = await healthPid(fixture.socket, 500);
    try { watcher.kill('SIGKILL'); } catch {}
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(fixture.store, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const daemonPid = await waitUntil(() => healthPid(fixture.socket), 'daemon never became healthy', 20000);
  return { watcher, daemonPid };
}

// Spawn a real pty shell session through the daemon; returns identity from the
// state file: { id, pid, keeperPid }. Registers terminate-through-the-daemon
// cleanup BEFORE returning (and before any caller readiness wait).
async function spawnShellSession(fixture, cleanups, cwd) {
  const client = new SessionClient({ socketPath: fixture.socket, requestTimeoutMs: 20000 });
  let spawned;
  try {
    spawned = await client.request('spawn', {
      argv: SHELL_ARGV, cwd, env: {}, cols: 100, rows: 30,
    });
  } finally {
    client.close();
  }
  cleanups.push(async () => {
    const client = new SessionClient({ socketPath: fixture.socket, requestTimeoutMs: 8000 });
    try {
      await client.request('terminate', { id: spawned.id, signal: 'SIGKILL' });
      await waitUntil(async () => {
        try { return !(await client.request('process', { id: spawned.id })).running; }
        catch { return true; }
      }, 'session never terminated', 8000);
    } catch { /* daemon already gone; state-file fallback below */ }
    finally { client.close(); }
    try {
      const state = JSON.parse(fs.readFileSync(path.join(fixture.store, 'sessions', `${spawned.id}.json`), 'utf8'));
      if (!state.exit) {
        try { process.kill(state.keeper_pid, 'SIGKILL'); } catch {}
        try { process.kill(state.pid, 'SIGKILL'); } catch {}
      }
    } catch { /* already reaped */ }
  });
  const state = JSON.parse(fs.readFileSync(path.join(fixture.store, 'sessions', `${spawned.id}.json`), 'utf8'));
  return { id: spawned.id, pid: state.pid, keeperPid: state.keeper_pid };
}

// Input -> screen round trip: the drivability proof. Echo a marker through the
// pty and wait for the terminal screen to carry it back. Tolerant of a daemon
// swap mid-drive (these suites kill daemons on purpose): each attempt uses a
// fresh client, and an input whose acknowledgement was lost to a dying daemon
// is re-sent, which is harmless (the same echo twice still contains the marker).
async function driveMarker(fixture, id, marker, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const text = process.platform === 'win32' ? `echo ${marker}\r` : `printf '${marker}\\n'\n`;
  let lastError = null;
  while (Date.now() < deadline) {
    const client = new SessionClient({ socketPath: fixture.socket, requestTimeoutMs: 5000 });
    try {
      await client.request('input', { id, text });
      const settle = Date.now() + 3000;
      while (Date.now() < settle && Date.now() < deadline) {
        const screen = await client.request('screen', { id, scrollback: 200 });
        if ((screen.text || '').includes(marker)) return;
        await sleep(100);
      }
      lastError = new Error('input accepted but the marker is not on the screen yet');
    } catch (error) {
      lastError = error;
      await sleep(250);
    } finally {
      client.close();
    }
  }
  throw new Error(`marker ${marker} never reached the screen (after ${timeoutMs}ms): ${lastError ? lastError.message : 'no attempt completed'}`);
}

async function requestVerb(fixture, verb, params = {}, timeoutMs = 5000) {
  const client = new SessionClient({ socketPath: fixture.socket, requestTimeoutMs: timeoutMs });
  try { return await client.request(verb, params); }
  finally { client.close(); }
}

module.exports = {
  ROOT, DAEMON, WATCHER, CLI, SHELL_ARGV, guiNodeExec,
  sleep, alive, waitUntil, waitGone, canConnect, healthPid,
  freshStore, readLog, waitForLog, chainEnv, startChain, spawnShellSession, driveMarker, requestVerb,
};
