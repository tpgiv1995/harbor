#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
// node-pty is a NATIVE module and it is declared in this directory's own
// package.json, not the app's, because the keeper runs under the system Node
// rather than Electron. A fresh clone that ran only `npm install` at the app
// level therefore used to reach this line and die with a bare MODULE_NOT_FOUND
// in the daemon log, which reads as "sessions just do not start" and names
// nothing a user could act on. `postinstall` now installs it, so this branch
// should be unreachable; it says what to run when it is not.
let pty;
try {
  pty = require('node-pty');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    throw new Error(
      'node-pty is not installed, so this session cannot open a pty. '
      + 'Run `npm install` from the app directory (its postinstall installs the '
      + "daemon's own dependencies), or `npm run pack:daemon-deps` to install just "
      + 'those. Original error: ' + err.message,
    );
  }
  throw err;
}
const { ScreenModel } = require('./screen.js');
const { writeStateResilient } = require('./persist-state.js');
const { readRecords, writeRecord } = require('./ndjson.js');
const { ObserverWriter } = require('./observer-writer.js');
const { listenAddress } = require('./paths.js');
const { currentBootId } = require('./boot-id.js');
const { resolveJobPolicy, openSessionJob, terminateJob, closeJob, armKillOnClose } = require('./win-job.js');

// Read once: this keeper cannot outlive the boot it started in, so the value it
// stamps must be the boot it started in even if /proc is unreadable later.
const bootId = currentBootId();

const configPath = process.argv[2];
if (!configPath) throw new Error('keeper requires a config path');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
try { fs.unlinkSync(configPath); } catch {}
// Hold the named job for the keeper's whole life. This is the handover seam:
// the name remains openable after the creating daemon dies, and kill-on-close
// reaps the tree only after daemon AND keeper have both released their handles.
// THE KEEPER ARMS KILL-ON-CLOSE, NEVER THE DAEMON (f8 finding M1): the daemon
// creates the job unarmed, so a daemon that dies while it is the SOLE holder
// (a crash in the spawn window, a keeper whose open failed) closes its handle
// without killing the live session, exactly the pre-job behavior. Only once
// this keeper holds a handle of its own does the flag arm, and from then on
// the trap is the designed one: both holders gone means the tree is orphaned
// and the kernel reaps it.
const sessionJobPolicy = resolveJobPolicy();
let sessionJob = null;
if (sessionJobPolicy.enabled) {
  try {
    sessionJob = openSessionJob(config.id, sessionJobPolicy);
    if (sessionJob) armKillOnClose(sessionJob);
  } catch (error) { try { process.stderr.write(`session job open failed (continuing): ${error.message}\n`); } catch {} }
}

// The session's ending, after its record is safe. Terminating the job kills
// this keeper too, which is fine exactly because persist() already ran; the
// job takes MCP grandchildren the pty teardown cannot reach. No job, or a
// terminate failure, falls back to the plain shutdown this file always had.
function finishExit() {
  if (sessionJob) {
    try { terminateJob(sessionJob); return; }
    catch (error) { try { process.stderr.write(`session job terminate failed (continuing): ${error.message}\n`); } catch {} }
  }
  shutdown();
}
const statePath = config.state_path;
const socketPath = config.keeper_socket;
const observers = new Map();
let exit = null;

// THE KEEPER IS THE ONLY HONEST WITNESS TO ACTIVITY (2026-08-09, dormancy).
// It sees every byte in both directions, so it is the one place that can say
// when a session last did anything without guessing. Transcript mtime cannot:
// it moves only when a turn produces a message, so a session parked on a
// permission prompt for two hours is indistinguishable there from one that is
// working. Why this matters at all is in the header of dormancy.js.
//
// PERSISTED ON A THROTTLE, because a working turn emits a spinner frame many
// times a second and persist() rewrites the whole state file. The stamp on disk
// is therefore up to ACTIVITY_PERSIST_MS stale, which is bounded, one-directional
// (it can only make a session look MORE idle than it is) and irrelevant against
// an hour-scale threshold. It is called out here so nobody later reads the
// stamp as exact and builds a short-timescale decision on it.
let lastActivityAt = Date.now();
let lastActivityPersistedAt = Date.now();
const ACTIVITY_PERSIST_MS = Number(process.env.HARBOR_SESSIOND_ACTIVITY_PERSIST_MS || 30000);

// Set by a `terminate` that is deliberate rather than a death, so the exit
// record can say WHY. Stamped by the keeper rather than written by the daemon
// afterwards because persist() rebuilds state from `config` every time and
// would drop any field the daemon added behind its back; annotating through
// terminate is the only race-free way to get it into the record.
let exitAnnotation = null;

const PROVIDER_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function annotateProviderIdentity(params) {
  const allowed = new Set(['id', 'agent', 'agent_session']);
  const foreign = Object.keys(params).filter((key) => !allowed.has(key));
  if (foreign.length) throw new Error(`annotate accepts only agent and agent_session; refused: ${foreign.join(', ')}`);
  if (!['codex', 'cursor'].includes(params.agent)) throw new Error('annotate agent must be codex or cursor');
  if (config.agent !== params.agent) {
    throw new Error(`annotate agent ${params.agent} conflicts with keeper agent ${config.agent ?? 'null'}`);
  }
  if (typeof params.agent_session !== 'string' || !PROVIDER_SESSION_ID_RE.test(params.agent_session)) {
    throw new Error('annotate agent_session must be a UUID');
  }
  const previous = config.agent_session ?? null;
  config.agent = params.agent;
  config.agent_session = params.agent_session;
  persist();
  if (previous && previous !== params.agent_session) {
    try { process.stderr.write(`provider identity rebound ${previous} -> ${params.agent_session}\n`); } catch {}
  }
  return { agent: config.agent, agent_session: config.agent_session };
}

function noteActivity() {
  lastActivityAt = Date.now();
  if (lastActivityAt - lastActivityPersistedAt >= ACTIVITY_PERSIST_MS) {
    lastActivityPersistedAt = lastActivityAt;
    persist();
  }
}

function persist(extra = {}) {
  const state = {
    id: config.id,
    argv: config.argv,
    cwd: config.cwd,
    agent: config.agent ?? null,
    agent_session: config.agent_session ?? null,
    cols: screen.terminal.cols,
    rows: screen.terminal.rows,
    pid: terminal.pid,
    keeper_pid: process.pid,
    keeper_socket: socketPath,
    created_at: config.created_at,
    // The only field that survives a reboot with its meaning intact. `exit`
    // cannot: a SIGKILLed keeper never reaches onExit to write one.
    boot_id: bootId,
    last_activity_at: new Date(lastActivityAt).toISOString(),
    exit,
    ...extra,
  };
  // Resilient on purpose: a transient EPERM on this rename used to walk up
  // to uncaughtException and kill the keeper AND its live session (see
  // persist-state.js for the incident). A skipped persist is stale
  // bookkeeping; a dead keeper is destroyed work.
  writeStateResilient(statePath, `${JSON.stringify(state)}\n`, {
    log: (message) => { try { process.stderr.write(`${message}\n`); } catch {} },
  });
}

function event(payload) {
  const value = { id: config.id, ...payload };
  for (const writer of observers.values()) {
    if (payload.type === 'frame') writer.send(value);
    else writeRecord(writer.socket, { type: 'event', event: value });
  }
}

const screen = new ScreenModel({ cols: config.cols, rows: config.rows });
// ASSIGNED INSIDE THE LISTEN CALLBACK, NOT AT MODULE LOAD (2026-08-09, review).
// The pty used to be spawned here, well before the socket bound and the state
// file existed, so a keeper killed in that gap (the spawn-deadline reap, an
// OOM) left an ALREADY-FORKED pty child that no state file would ever
// describe: invisible, unsignalled, holding a live claude. Spawning after the
// bind makes the ordering a contract: a state file implies the pty exists, and
// no state file implies there is (almost) nothing to leak. Almost: a SIGKILL
// can still land between the spawn instruction and the persist a few lines
// later, and node-pty's child is setsid'd, so no group kill from outside can
// reach it; the pty master teardown HUPs it, which most children obey. That
// microsecond residual is irreducible without kernel help, and kernel help is
// exactly what SCOPED mode is: the scope stop kills by cgroup, persist or no
// persist. It is one of the reasons scopes are the production mode and the
// unscoped path is a fallback. The listen callback itself runs as one
// synchronous block, so no client request can observe the in-between.
let terminal = null;

function startSession() {
  const [file, ...args] = config.argv;
  terminal = pty.spawn(file, args, {
    name: 'xterm-256color',
    cwd: config.cwd,
    env: { ...config.env, TERM: config.env.TERM || 'xterm-256color' },
    cols: config.cols,
    rows: config.rows,
  });

  // THE KEEPER LOSES OOM CONTESTS LAST (2026-08-09). A session's scope has a
  // MemoryMax now, and when the kernel enforces it, it kills ONE task in the
  // cgroup: in the live containment proof it chose the KEEPER, so the pty died
  // with it and the session collapsed with no exit recorded. Raising the pty
  // child's badness (inherited on fork, so a runaway grep carries it too) makes
  // the kernel prefer the session's own processes; the keeper survives to record
  // an honest exit and keep answering for the session. An unprivileged write may
  // only RAISE the value, which is exactly the direction needed.
  if (process.platform === 'linux') {
    try { fs.writeFileSync(`/proc/${terminal.pid}/oom_score_adj`, '500'); } catch { /* best effort */ }
  }

  // node-pty rethrows exotic pty stream errors unless the terminal carries at
  // least TWO error listeners (vendored unixTerminal.js: `if
  // (listeners('error').length < 2) { throw err; }` after filtering
  // EAGAIN/EIO), and an uncaught throw here is the keeper dying OUTSIDE
  // onExit, with no exit record: the same crash class as the client-socket
  // guard below, arriving through the pty. Two deliberate listeners, per the
  // vendored source.
  const ptyError = (error) => { try { process.stderr.write(`pty error (continuing): ${error.message}\n`); } catch {} };
  terminal.on('error', ptyError);
  terminal.on('error', () => {});

  terminal.onData((data) => {
    noteActivity();
    screen.write(data);
    event({ type: 'frame', text: data, bytes: Buffer.from(data).toString('base64') });
  });
  // The test seam exists because the failure it reproduces cannot be forced:
  // ConPTY sometimes never delivers onExit for a child that dies instantly
  // (measured at ~1 in 3 for `cmd /c exit 7` on the gate machine,
  // 2026-08-20), and a spec that only wins a race two runs in three is not a
  // proof. Dropping the registration IS the lost event, deterministically.
  if (process.env.HARBOR_SESSIOND_TEST_DROP_PTY_EXIT !== '1') {
    terminal.onExit(({ exitCode, signal }) => {
      // The verified-gone synthesis below can land first when ConPTY delivers
      // this event late; the first honest record wins and shutdown runs once.
      if (exit) return;
      // CONPTY OFTEN DELIVERS undefined HERE (2026-08-30). A win32
      // terminal.kill() — dormancy's path — frequently fires onExit with
      // exitCode/signal both undefined. Writing those through made JSON drop
      // the keys and sessiond.log print `code=undefined signal=undefined` for
      // every dormant exit. Null is the honest "nobody gave us a value" the
      // synthesis paths already use; a real number or signal string/number is
      // kept.
      exit = {
        code: typeof exitCode === 'number' ? exitCode : null,
        signal: (typeof signal === 'number' || typeof signal === 'string') ? signal : null,
        at: new Date().toISOString(),
        ...(exitAnnotation || {}),
      };
      persist();
      event({ type: 'exit', exit });
      const delay = Number(process.env.HARBOR_SESSIOND_KEEPER_EXIT_DELAY_MS || 1000);
      setTimeout(finishExit, Number.isFinite(delay) && delay >= 0 ? delay : 1000).unref();
    });
  }

  // A LOST EXIT EVENT MUST NOT LEAVE A FOREVER-LIVE SESSION (2026-08-20).
  // The terminate path has synthesized an exit for a verified-gone child
  // since the exit-honesty work, but an UN-terminated child whose onExit
  // ConPTY simply lost had nothing: the keeper sat healthy, answered every
  // probe, and reported a session that no longer existed as live, forever.
  // Found by the exit-log spec failing 2 runs in 6 on exactly this. The
  // watch asks the only question that matters (is the child pid alive) on a
  // slow clock, demands TWO consecutive "gone" sightings (a recycled pid
  // answers "alive" and merely delays detection, which is the safe
  // direction), and records the same honest verified-gone shape the
  // terminate path writes: null code, null signal, and a reason, because
  // nobody watched this die.
  const watchMs = (() => {
    const n = Number(process.env.HARBOR_SESSIOND_CHILD_WATCH_MS);
    return Number.isFinite(n) && n >= 100 ? n : 5000;
  })();
  let childGoneOnce = false;
  const childWatch = setInterval(() => {
    if (exit) { clearInterval(childWatch); return; }
    let childAlive = true;
    try { process.kill(terminal.pid, 0); } catch { childAlive = false; }
    if (childAlive) { childGoneOnce = false; return; }
    if (!childGoneOnce) { childGoneOnce = true; return; }
    clearInterval(childWatch);
    exit = {
      code: null, signal: null, at: new Date().toISOString(),
      reason: 'pty exit event never fired; child found dead by the keeper watch',
      ...(exitAnnotation || {}),
    };
    persist();
    event({ type: 'exit', exit });
    const delay = Number(process.env.HARBOR_SESSIOND_KEEPER_EXIT_DELAY_MS || 1000);
    setTimeout(finishExit, Number.isFinite(delay) && delay >= 0 ? delay : 1000).unref();
  }, watchMs);
  childWatch.unref();

  // THE KEEPER DIES WITH ITS HARNESS TOO (2026-09-03). The daemon watches the
  // harness pid and reaps its sessions when it dies (harness-watch.js), but a
  // real harness is the daemon's own spawner, and on Windows libuv's job
  // object kills a non-detached daemon the instant its spawner exits: gone in
  // under a second, nothing logged, its watch never fires, while this keeper,
  // spawned detached, survives with the session. Three crashed probe scripts
  // left three keepers and three claude trees alive for an hour that evening.
  // So the daemon writes the pid into this session's config and the keeper
  // watches it itself. Two sightings, like the child watch, so a stalled
  // probe cannot end a session. The default store never carries a harness pid
  // (harness-watch.js), so production keepers never do this.
  const harnessPid = Number.isInteger(config.harness_pid) && config.harness_pid > 1 ? config.harness_pid : null;
  if (harnessPid) {
    const harnessPollMs = (() => {
      const n = Number(process.env.HARBOR_SESSIOND_PARENT_POLL_MS);
      return Number.isFinite(n) && n >= 50 ? n : 2000;
    })();
    let harnessGoneOnce = false;
    const harnessWatch = setInterval(() => {
      if (exit) { clearInterval(harnessWatch); return; }
      try { process.kill(harnessPid, 0); harnessGoneOnce = false; return; } catch { /* harness is gone */ }
      if (!harnessGoneOnce) { harnessGoneOnce = true; return; }
      clearInterval(harnessWatch);
      try { process.stderr.write(`harness pid ${harnessPid} is gone; ending this session\n`); } catch {}
      exit = {
        code: null,
        signal: 'SIGKILL',
        at: new Date().toISOString(),
        reason: 'harness died; session reaped by its keeper',
        ...(exitAnnotation || {}),
      };
      persist();
      event({ type: 'exit', exit });
      if (process.platform === 'win32') {
        try { terminal.kill(); } catch { /* already gone */ }
      } else {
        try { process.kill(-terminal.pid, 'SIGKILL'); } catch { try { process.kill(terminal.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
      // The record is on disk; the job (when there is one) takes the whole
      // tree, exactly as a deliberate terminate ends.
      setTimeout(finishExit, 500).unref();
    }, harnessPollMs);
    harnessWatch.unref();
  }
}

try { fs.unlinkSync(socketPath); } catch {}
const server = net.createServer((socket) => {
  // A client vanishing rudely emits 'error' on ITS socket, and an 'error' with
  // no listener is an uncaught exception that takes the whole KEEPER down with
  // the live session inside it. The daemon grew this exact guard on 2026-08-06
  // (`read ECONNRESET` killed it mid-evening); this file was the missed
  // sibling, and on 2026-08-09 at 02:40, during a machine-wide memory stall,
  // three keepers each caught an ECONNRESET from a stalled client's teardown
  // and died mid-session, taking three live claudes with them. A peer
  // disconnecting rudely is ordinary, not fatal.
  socket.on('error', () => observers.delete(socket));
  readRecords(socket, async (record) => {
    const requestId = record.request_id;
    try {
      let result;
      const params = record.params || {};
      if (record.verb === 'observe') {
        observers.set(socket, new ObserverWriter(socket));
        result = { observing: true };
      } else if (record.verb === 'input') {
        if (exit) throw new Error(`session ${config.id} has exited`);
        if (typeof params.text !== 'string' && typeof params.bytes !== 'string') throw new Error('input requires text or base64 bytes');
        noteActivity();
        terminal.write(typeof params.text === 'string' ? params.text : Buffer.from(params.bytes, 'base64').toString('utf8'));
        result = { accepted: true };
      } else if (record.verb === 'resize') {
        if (!Number.isInteger(params.cols) || params.cols < 1) throw new Error('cols must be a positive integer');
        if (!Number.isInteger(params.rows) || params.rows < 1) throw new Error('rows must be a positive integer');
        terminal.resize(params.cols, params.rows);
        screen.resize(params.cols, params.rows);
        persist();
        result = { cols: params.cols, rows: params.rows };
      } else if (record.verb === 'annotate') {
        if (exit) throw new Error(`session ${config.id} has exited`);
        result = annotateProviderIdentity(params);
      } else if (record.verb === 'screen') {
        result = await screen.read(params.scrollback || 0);
      } else if (record.verb === 'process') {
        result = { pid: terminal.pid, running: exit === null, exit };
      } else if (record.verb === 'terminate') {
        if (!exit) {
          // A DELIBERATE ENDING SAYS SO IN THE RECORD. Without this a session
          // put to sleep for being idle is byte-identical on disk to one that
          // crashed, and the difference is the whole question a user asks when
          // a window is gone. Only the two annotation fields are accepted, so a
          // caller cannot use terminate to write arbitrary keys into an exit.
          if (params.reason || params.dormant) {
            exitAnnotation = {
              ...(params.dormant ? { dormant: true } : {}),
              ...(typeof params.reason === 'string' && params.reason ? { reason: params.reason } : {}),
            };
          }
          const signal = params.signal || 'SIGTERM';
          // WINDOWS HAS NO SIGNALS (2026-08-06, caught closing a real session
          // on real hardware). `process.kill(-pid, ...)` needs POSIX process
          // groups, and node-pty's own kill REFUSES a signal argument there,
          // throwing "Signals not supported on windows" out of the fallback the
          // POSIX path relies on. So terminate ends the session with no signal,
          // which is what node-pty offers, and there is no grace escalation to
          // schedule because the first call is already the forceful one.
          if (process.platform === 'win32') {
            try { terminal.kill(); } catch { /* already gone */ }
            // The job kill happens in finishExit, AFTER the exit record
            // persists: the first shape of this code terminated the job on the
            // next tick, which killed this very keeper before onExit or the
            // verified-gone poll could write the record, so with jobs on every
            // deliberate ending (dormancy included) read as a crash and sat
            // exit:null until reconcile synthesized one (f8 finding H2).
            // CONPTY'S EXIT EVENT IS NOT A CONTRACT (2026-08-14). Under load a
            // pseudoconsole can tear down without node-pty ever firing onExit:
            // the child is dead, no exit is recorded, and the session stays
            // listed as live forever, which is exactly the record closePane's
            // caller waits on. So a win32 terminate VERIFIES: poll the child,
            // and once it is provably gone give onExit one more beat, then
            // record the exit here with the reason named, the same honesty as
            // the crash-path synthesis below. A landed onExit always wins; the
            // pid-reuse window fails open to the old behaviour (no synthesis),
            // never to a false exit.
            const childPid = terminal.pid;
            // A child that SURVIVES the pty teardown (a GUI-subsystem process
            // ignores console death; ConPTY only guarantees the console) gets
            // the job as the forceful escalation, but ONLY after its honest
            // exit record is written: record first, then kill (f8 finding H2
            // applies to this lane too). The grace mirrors the POSIX branch's
            // grace_ms. Without a job, the old fail-open behavior stands: no
            // synthesis, the dead-pty reap and reconcile own the stragglers.
            const jobGraceMs = Number.isInteger(params.grace_ms) ? Math.min(Math.max(0, params.grace_ms), 15000) : 1500;
            const jobEscalateAt = Date.now() + jobGraceMs;
            const pollUntil = Date.now() + 15000;
            const recordAndFinish = (reason) => {
              if (exit) return;
              exit = {
                code: null,
                signal: null,
                at: new Date().toISOString(),
                reason,
                ...(exitAnnotation || {}),
              };
              persist();
              event({ type: 'exit', exit });
              const delay = Number(process.env.HARBOR_SESSIOND_KEEPER_EXIT_DELAY_MS || 1000);
              setTimeout(finishExit, Number.isFinite(delay) && delay >= 0 ? delay : 1000).unref();
            };
            const poll = setInterval(() => {
              if (exit || Date.now() > pollUntil) { clearInterval(poll); return; }
              let alive = true;
              try { process.kill(childPid, 0); } catch { alive = false; }
              if (!alive) {
                clearInterval(poll);
                setTimeout(() => recordAndFinish('pty exit event never fired; child verified gone after terminate'), 500).unref();
                return;
              }
              if (sessionJob && Date.now() >= jobEscalateAt) {
                clearInterval(poll);
                recordAndFinish('child survived pty teardown; session job terminated');
              }
            }, 250);
            poll.unref();
          } else {
            try { process.kill(-terminal.pid, signal); }
            catch { terminal.kill(signal); }
            if (signal !== 'SIGKILL') {
              const graceMs = Number.isInteger(params.grace_ms) ? Math.max(0, params.grace_ms) : 1500;
              setTimeout(() => {
                if (!exit) {
                  try { process.kill(-terminal.pid, 'SIGKILL'); }
                  catch { terminal.kill('SIGKILL'); }
                }
              }, graceMs).unref();
            }
          }
        }
        result = { signaled: !exit, signal: params.signal || 'SIGTERM' };
      } else throw new Error(`unsupported keeper verb: ${record.verb}`);
      writeRecord(socket, { type: 'response', request_id: requestId, ok: true, result });
    } catch (error) {
      writeRecord(socket, { type: 'response', request_id: requestId, ok: false, error: error.message });
    }
  }, (error) => writeRecord(socket, { type: 'error', error: error.message }));
  socket.on('close', () => observers.delete(socket));
});
// The server itself can error (a bind failure, or an EMFILE-class accept
// failure under fd pressure): unguarded, either is an uncaught exception dying
// outside the exit-recording path (2026-08-09, review; the daemon's server has
// carried this guard since 2026-08-06). Before the socket is bound the keeper
// is useless, so it exits and the daemon's spawn watch reports the death;
// after, an accept hiccup is logged and survived.
let bound = false;
server.on('error', (error) => {
  try { process.stderr.write(`keeper server error: ${error.stack || error.message}\n`); } catch {}
  if (!bound) process.exit(1);
});
// Windows binds a named pipe, which is not a file: nothing to chmod.
server.listen(listenAddress(socketPath), () => {
  bound = true;
  if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
  // A pty that cannot spawn must die SPEAKING: stderr (the keeper log the
  // daemon's spawn error quotes) plus exit(1), so the daemon reports the real
  // reason instantly ("keeper exited during startup ... Cannot create process,
  // error code: 2") instead of timing out against silence. Before this catch,
  // the throw left the listen callback uncaught, and a keeper running under
  // full Electron answered an uncaught exception with a MODAL ERROR DIALOG and
  // no exit at all (live-caught 2026-08-12: a nonexistent cwd bricked every
  // new-session attempt behind "keeper never came up within 7000ms" and a
  // dialog over Pat's desktop).
  try {
    startSession();
  } catch (error) {
    try { process.stderr.write(`session process could not be started: ${error.stack || error.message}\n`); } catch {}
    process.exit(1);
  }
  persist();
});

// The same rule for everything else: a keeper must NEVER die silent, and must
// never sit behind Electron's uncaught-exception dialog (the default when a
// keeper is accidentally run without ELECTRON_RUN_AS_NODE). Late crashes still
// try to leave an honest exit record so the session is not resurrected as live.
process.on('uncaughtException', (error) => {
  try { process.stderr.write(`keeper uncaught exception: ${error.stack || error.message}\n`); } catch {}
  if (!exit && terminal) {
    exit = { code: null, signal: null, at: new Date().toISOString(), reason: `keeper crashed: ${error.message}` };
    try { persist(); } catch {}
  }
  process.exit(1);
});

function shutdown() {
  for (const socket of observers.keys()) socket.destroy();
  server.close(() => {
    try { fs.unlinkSync(socketPath); } catch {}
    closeJob(sessionJob);
    sessionJob = null;
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
