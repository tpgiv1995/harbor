#!/usr/bin/env node
'use strict';

// THE SUPERVISOR (upgraded from exit capture, 2026-08-30). This process is the
// daemon's PARENT: it must be, or Windows discards the only exit code and
// signal Node can see (the 2026-08-14 silent-death incident). That parenthood
// is also what makes it the honest seat for wedge detection and recovery: it
// kills only its own child (exact pid, no reuse question), observes the death
// through the deterministic 'exit' event, and never needs to trust a pid file.
//
// Liveness is a REAL REQUEST, never a connect: a wedged daemon still accepts
// connections out of the kernel backlog (the lying-gate shape the doctrine
// warns about), so every probe here sends `health` and requires an answer.
// Machine sleep freezes prober and daemon together, so the trip condition is
// N consecutive COMPLETED-and-failed probes, never a wall-clock gap.
//
// Exit policy per observed kind:
//   clean  exit 0 or a REQUESTED stop (forwarded signal, or the daemon's
//          clean-shutdown IPC, which `shutdown` and `yield` both send).
//          The watcher logs and exits; it NEVER respawns a clean stop, which
//          is what lets a deliberate handover retire the old watcher.
//   crash  unrequested death. The watcher waits for the pipe to release and
//          respawns: a crashed daemon comes back in seconds instead of staying
//          dead until the next app boot (the 2026-08-14 class becomes a blip).
//   wedge  the watcher's own kill after consecutive failed health probes.
//          Neither clean (no stop was requested) nor crash (the watcher did
//          the killing and must say so). Same recovery as crash.
//
// The respawned successor runs the ordinary daemon start(): the gate answers
// dead, it binds, and startup reconcile reconnects every keeper with a real
// request, which is what keeps a heal zero-drop (keepers are independent pipe
// servers holding the ptys; nothing here ever signals one).
//
// HARBOR_SESSIOND_RESPAWN_MAX=0 turns respawning off (exit capture only,
// the pre-2026-08-30 contract, pinned by test/daemon/instrumentation.test.js);
// HARBOR_SESSIOND_WATCH_INTERVAL_MS=0 turns health probing (wedge detection)
// off. Both default on.

const { spawn } = require('node:child_process');
const net = require('node:net');
const { appendLog } = require('./log-file.js');
const { resolvePaths, listenAddress } = require('./paths.js');
const { SessionClient } = require('./client.js');

const daemonPath = process.argv[2];
if (!daemonPath) process.exit(2);

const paths = resolvePaths();
const maxBytes = Number(process.env.HARBOR_SESSIOND_LOG_MAX_BYTES) || 5 * 1024 * 1024;

function nonnegative(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const watchIntervalMs = nonnegative(process.env.HARBOR_SESSIOND_WATCH_INTERVAL_MS, 15000);
const watchTimeoutMs = nonnegative(process.env.HARBOR_SESSIOND_WATCH_TIMEOUT_MS, 5000) || 5000;
const watchFailures = nonnegative(process.env.HARBOR_SESSIOND_WATCH_FAILURES, 3) || 3;
const pipeReleaseTimeoutMs = nonnegative(process.env.HARBOR_SESSIOND_PIPE_RELEASE_TIMEOUT_MS, 5000) || 5000;
const respawnMax = nonnegative(process.env.HARBOR_SESSIOND_RESPAWN_MAX, 5);
const RESPAWN_WINDOW_MS = 15 * 60 * 1000;
// No trip-counting while the daemon is still starting: reconcile against a
// large store can legitimately outlast several probe intervals.
const readyGraceMs = (Number(process.env.HARBOR_SESSIOND_READY_TIMEOUT_MS) || 10000) + 5000;
const BACKOFF_MS = [1000, 2000, 5000, 10000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line) {
  appendLog(paths.log, line, { maxBytes });
}

// One-shot client per probe so a wedged request can never poison the next
// probe's connection state. Resolves true only when `health` ANSWERED.
function probeHealth(timeoutMs = watchTimeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; try { client.close(); } catch {} clearTimeout(guard); resolve(ok); } };
    const client = new SessionClient({ socketPath: paths.socket, requestTimeoutMs: timeoutMs });
    // The request carries its own timer, but only after connect resolves; the
    // outer guard bounds a connect that neither succeeds nor errors.
    const guard = setTimeout(() => finish(false), timeoutMs + 1000);
    client.request('health').then(() => finish(true), () => finish(false));
  });
}

function canConnect() {
  return new Promise((resolve) => {
    const probe = net.connect(listenAddress(paths.socket));
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

// Handle release after TerminateProcess is ASYNCHRONOUS on Windows, so the
// successor may only spawn once a bare connect fails. Past the deadline, a
// pipe that still ACCEPTS gets one honest disambiguation: answers health =
// another daemon legitimately took the store (stand down); accepts but never
// answers = a foreign process holds the pipe name, which only `recover` (with
// identity verification) may kill, so log loudly and keep waiting.
async function waitForPipeRelease() {
  const deadline = Date.now() + pipeReleaseTimeoutMs;
  let warned = false;
  for (;;) {
    if (!(await canConnect())) return 'released';
    if (Date.now() >= deadline) {
      if (await probeHealth()) return 'foreign-healthy';
      if (!warned) {
        warned = true;
        log(`pipe for ${paths.socket} still accepts connections past ${pipeReleaseTimeoutMs}ms after the daemon died, but does not answer health; a foreign process may hold it (recover owns killing it). waiting`);
      }
    }
    await sleep(100);
  }
}

let currentChild = null;
let stopRequested = false;
let forwarding = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (forwarding) return;
    forwarding = true;
    stopRequested = true;
    if (currentChild) {
      currentChild.requestedSignal = signal;
      try { currentChild.kill(signal); } catch {}
    } else {
      process.exit(0);
    }
  });
}

// Supervise one child from spawn to exit. Returns the routed verdict:
// { kind: 'clean' | 'crash' | 'wedge', code, signal, everHealthy }.
async function superviseChild(generation) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [daemonPath], {
    env: process.env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    // The daemon must never own a visible console window (see the start
    // path's detached spawn for the incident); the watcher passes the same
    // rule down so the chain cannot re-acquire one here.
    windowsHide: true,
  });
  child.requestedSignal = null;
  currentChild = child;
  child.on('message', (message) => {
    if (message && message.type === 'clean-shutdown') child.requestedSignal = 'daemon';
  });

  let exited = null;
  const exitPromise = new Promise((resolve) => {
    child.once('error', (error) => resolve({ spawnError: error, code: null, signal: null }));
    child.once('exit', (code, signal) => resolve({ spawnError: null, code, signal }));
  }).then((result) => { exited = result; return result; });

  let everHealthy = false;
  let wedgeKilled = false;
  if (watchIntervalMs > 0) {
    (async () => {
      const graceUntil = Date.now() + readyGraceMs;
      let failures = 0;
      while (!exited) {
        await sleep(watchIntervalMs);
        if (exited) return;
        const ok = await probeHealth();
        // A probe that raced the exit is not evidence about the next child.
        if (exited) return;
        if (ok) {
          if (!everHealthy) {
            everHealthy = true;
            if (generation > 0) log(`successor pid=${child.pid} healthy after ${Date.now() - startedAt}ms`);
          }
          failures = 0;
          continue;
        }
        if (!everHealthy && Date.now() < graceUntil) continue;
        failures += 1;
        log(`daemon health probe failed (${failures}/${watchFailures}) pid=${child.pid}`);
        if (failures >= watchFailures) {
          wedgeKilled = true;
          log(`wedge: daemon pid=${child.pid} failed ${failures} consecutive health probes; killing it`);
          try { child.kill('SIGKILL'); } catch {}
          return;
        }
      }
    })();
  }

  const result = await exitPromise;
  currentChild = null;
  if (result.spawnError) {
    log(`daemon exit pid=${child.pid || 'unknown'} code=spawn-error signal=none uptime_ms=${Date.now() - startedAt} kind=crash error=${JSON.stringify(result.spawnError.message)}`);
    return { kind: 'crash', code: null, signal: null, everHealthy };
  }
  const { code, signal } = result;
  // Windows reports a requested child termination as code 1 with no signal.
  // The request observed here is the only honest clean-stop discriminator.
  const clean = !wedgeKilled && ((code === 0 && !signal) || child.requestedSignal !== null);
  const kind = wedgeKilled ? 'wedge' : (clean ? 'clean' : 'crash');
  log(`daemon exit pid=${child.pid} code=${code === null ? 'null' : code} signal=${signal || 'none'} uptime_ms=${Date.now() - startedAt} kind=${kind}`);
  return { kind, code, signal, everHealthy };
}

async function main() {
  const respawns = [];
  let backoffIdx = 0;
  for (let generation = 0; ; generation += 1) {
    const outcome = await superviseChild(generation);
    if (outcome.everHealthy) backoffIdx = 0;
    if (outcome.kind === 'clean' || stopRequested) process.exit(outcome.kind === 'clean' ? 0 : 1);
    if (outcome.code === 4) {
      // The gate's mute verdict: a wedged FOREIGN daemon holds this store's
      // pipe. It is not this watcher's child, so killing it needs the identity
      // verification only `recover` carries; respawning would loop on exit 4.
      log('daemon refused to start: a mute owner holds this store\'s pipe. Run: harbor-sessiond recover');
      process.exit(1);
    }
    if (outcome.code === 3) {
      // Someone else owns the store. Healthy owner: stand down, never fight a
      // legitimate daemon. Not healthy (the yield/kill release tail): retry
      // with backoff below.
      if (await probeHealth()) {
        log(`standing down: another daemon serves ${paths.socket}`);
        process.exit(0);
      }
    } else if (await waitForPipeRelease() === 'foreign-healthy') {
      log(`standing down: another daemon serves ${paths.socket}`);
      process.exit(0);
    }
    if (respawnMax === 0) process.exit(1); // exit-capture-only contract
    const now = Date.now();
    while (respawns.length && now - respawns[0] > RESPAWN_WINDOW_MS) respawns.shift();
    if (respawns.length >= respawnMax) {
      log(`respawn give-up: ${respawnMax} respawn(s) within 15 minutes; a crash loop means bad code on disk. exiting`);
      process.exit(1);
    }
    respawns.push(now);
    if (outcome.code === 3) {
      await sleep(BACKOFF_MS[Math.min(backoffIdx, BACKOFF_MS.length - 1)]);
      backoffIdx += 1;
    }
    if (stopRequested) process.exit(1);
  }
}

main().catch((error) => {
  log(`daemon-watch failed: ${error.stack || error.message}`);
  process.exit(1);
});
