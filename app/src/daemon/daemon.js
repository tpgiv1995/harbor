#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { readRecords, writeRecord } = require('./ndjson.js');
const { resolvePaths, socketFits, listenAddress, SUN_PATH_MAX } = require('./paths.js');
const { appendLog, readLogTail, readLogHead } = require('./log-file.js');
const { currentBootId, bootRelation, bootInstant } = require('./boot-id.js');
const { resolveHarnessWatchPid } = require('./harness-watch.js');
const { resolveScopePolicy, ensureSliceUnit, probeScopeSupport, scopeCommand } = require('./session-scope.js');
const {
  resolveDormancyPolicy, cgroupCpuUsec, sweepDormancy, winCpuSnapshot, winProcessTreeCpuUsec,
  providerTranscriptFresh,
} = require('./dormancy.js');
const { resolveOrphanPolicy, sweepOrphans, snapshotProcessTable } = require('./orphan-sweep.js');
const { createProcessIntel } = require('./process-intel.js');
const {
  resolveJobPolicy, createSessionJob, openSessionJob, assignPid: assignJobPid,
  queryJob, terminateJob, closeJob,
} = require('./win-job.js');

const bootId = currentBootId();

const paths = resolvePaths();
fs.mkdirSync(paths.sessions, { recursive: true, mode: 0o700 });
fs.mkdirSync(paths.sockets, { recursive: true, mode: 0o700 });
const keeperRequestTimeoutMs = positiveNumber(process.env.HARBOR_SESSIOND_KEEPER_REQUEST_TIMEOUT_MS, 10000);
// Deliberately UNDER the client's own 10s request timeout. When both were 10s
// the client always won the race, so the daemon's diagnosis of why a keeper
// failed was written to the log and then thrown into a socket nobody was still
// listening on: the caller only ever saw `spawn request timed out`.
const keeperStartTimeoutMs = positiveNumber(process.env.HARBOR_SESSIOND_SPAWN_TIMEOUT_MS, 7000);
const exitRetentionMs = nonnegativeNumber(process.env.HARBOR_SESSIOND_EXIT_RETENTION_MS, 5 * 60 * 1000);
const maxRecentExits = nonnegativeNumber(process.env.HARBOR_SESSIOND_MAX_RECENT_EXITS, 100);
const maxLogBytes = positiveNumber(process.env.HARBOR_SESSIOND_LOG_MAX_BYTES, 5 * 1024 * 1024);
const rssIntervalMs = nonnegativeNumber(process.env.HARBOR_SESSIOND_RSS_INTERVAL_MS, 60000);

// The daemon and keeper each hold the named job. KILL_ON_JOB_CLOSE therefore
// reaps the tree only when both are gone, while either holder keeps the name
// available to a successor daemon.
const jobPolicy = resolveJobPolicy();
const sessionJobs = new Map();
const processIntel = createProcessIntel({ log });

function acquireSessionJob(id, { create = false } = {}) {
  if (!jobPolicy.enabled) return null;
  const current = sessionJobs.get(id);
  if (current) return current;
  try {
    const job = create ? createSessionJob(id, jobPolicy) : openSessionJob(id, jobPolicy);
    if (job) sessionJobs.set(id, job);
    return job;
  } catch (error) {
    log(`session job unavailable for ${id}: ${error.message}; continuing without Windows job containment`);
    return null;
  }
}

function terminateSessionJob(id, context) {
  const job = acquireSessionJob(id);
  if (!job) return false;
  try { terminateJob(job); return true; }
  catch (error) { log(`session job terminate for ${id} (${context}) failed: ${error.message}; using process fallback`); return false; }
}

function dropSessionJob(id) {
  const job = sessionJobs.get(id);
  if (job) closeJob(job);
  sessionJobs.delete(id);
}

// ONE SESSION IS ONE CGROUP. The whole reason, and the 2026-08-09 incident that
// forced it, is in the header of session-scope.js. Resolved once and probed
// once: the probe creates a REAL scope, so it cannot run at module load (it
// would fire from every test that merely requires this file). start() warms it
// after the already-running gate instead, because paying ensureSliceUnit plus a
// systemd round-trip inside the FIRST spawn would spend seconds of that spawn's
// own 7s deadline, under a client budget of 10s.
const scopePolicy = resolveScopePolicy();
let scopeReady = null;
let scopeRetryAt = 0;
async function sessionScopeUsable() {
  if (scopeReady === true) return true;
  if (!scopePolicy.enabled) {
    if (scopeReady === null) {
      log(`session scopes off: ${scopePolicy.reason}; sessions share the daemon cgroup`);
      scopeReady = false;
    }
    return false;
  }
  // A PROBE FAILURE IS RETRIED; A POLICY ANSWER IS NOT (review round 1). The
  // daemon often starts in the same seconds the user manager is still settling
  // after login, and one unlucky probe must not cost containment for the
  // daemon's whole lifetime. Retrying is rate-limited so a machine genuinely
  // without a user manager pays one probe per cooldown, not per spawn.
  if (scopeReady === false && Date.now() < scopeRetryAt) return false;
  ensureSliceUnit(scopePolicy, { log });
  const usable = await probeScopeSupport(scopePolicy);
  // NOT a reason to refuse to run sessions. Losing containment is bad; losing
  // the ability to open a session is worse, and the fallback is exactly the
  // behaviour every Harbor before 2026-08-09 had.
  if (!usable) scopeRetryAt = Date.now() + positiveNumber(process.env.HARBOR_SESSIOND_SCOPE_RETRY_MS, 60000);
  if (usable !== scopeReady) {
    log(usable
      ? `session scopes on: slice=${scopePolicy.slice} MemoryHigh=${scopePolicy.memoryHigh} MemoryMax=${scopePolicy.memoryMax} MemorySwapMax=${scopePolicy.memorySwapMax}`
      : `session scopes unavailable (systemd-run could not create a scope in ${scopePolicy.slice}); sessions share the daemon cgroup until the next probe`);
  }
  scopeReady = usable;
  return usable;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonnegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function log(message) {
  appendLog(paths.log, message, { maxBytes: maxLogBytes });
}

function statePath(id) { return path.join(paths.sessions, `${id}.json`); }
function configPath(id) { return path.join(paths.sessions, `${id}.config.json`); }
function keeperSocket(id) { return path.join(paths.sockets, `${id}.sock`); }
function keeperLogPath(id) { return path.join(paths.sessions, `${id}.keeper.log`); }

function derivedIdentity(argv) {
  const executable = path.win32.basename(path.basename(argv[0] || '')).toLowerCase().replace(/\.exe$/, '');
  const providers = { claude: 'claude', codex: 'codex', 'cursor-agent': 'cursor' };
  const agent = providers[executable] || null;
  let agentSession = null;
  if (agent === 'claude') {
    const index = argv.indexOf('--session-id');
    if (index >= 0 && typeof argv[index + 1] === 'string' && argv[index + 1]) agentSession = argv[index + 1];
  }
  return { agent, agent_session: agentSession };
}

function readState(id) {
  try { return JSON.parse(fs.readFileSync(statePath(id), 'utf8')); }
  catch { throw new Error(`session not found: ${id}`); }
}

function removeSessionFiles(id) {
  for (const file of [statePath(id), configPath(id), keeperSocket(id), keeperLogPath(id)]) {
    try { fs.unlinkSync(file); } catch {}
  }
  // The exit-retention reap is the last time this id is ever seen, so the
  // daemon's job handle goes with the files: without this the handle map grew
  // by one entry per exited session for the daemon's whole life.
  dropSessionJob(id);
}

function readAllStateFiles() {
  return fs.readdirSync(paths.sessions)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.config.json'))
    .map((name) => {
      try { return JSON.parse(fs.readFileSync(path.join(paths.sessions, name), 'utf8')); }
      catch { return null; }
    }).filter(Boolean);
}

// A SESSION CANNOT OUTLIVE ITS BOOT, so one that claims to is not reported as
// live, no matter what its state file says (2026-08-07). This is deliberately a
// FILTER and not a reap: it runs on every list and health, it is the cheap exact
// half of the guard, and filtering is harmless even if the verdict were somehow
// wrong. Deleting is left to `reconcileStaleSessions`, which also asks the
// keeper before it touches anything.
function survivedItsBoot(state) {
  if (state.exit) return true;
  return bootRelation(state.boot_id, bootId) !== 'foreign';
}

// EVERY SESSION EXIT LEAVES A LINE IN sessiond.log (2026-08-20). On the day a
// dozen CLI processes died of commit exhaustion, the ONLY record of each death
// was its state file, which this very function deletes five minutes later
// along with the keeper log: an entire day of crashes left a log with 125
// spawn lines and zero exits, so there was nothing to say when a session died,
// let alone how. The daemon's own exit gets a line (daemon-watch.js); its
// sessions deserve the same. Observed here because every exit passes through
// allStates at least once before it can be reaped (the reap IS this function),
// and the RSS heartbeat drives it every minute even when no client asks.
const loggedExits = new Map(); // id -> exit.at that has already been logged
function noteExitObserved(state) {
  if (!state.exit || loggedExits.get(state.id) === state.exit.at) return;
  loggedExits.set(state.id, state.exit.at);
  const { code, signal, at, dormant, reason } = state.exit;
  const extras = [dormant ? 'dormant=true' : '', reason ? `reason=${JSON.stringify(reason)}` : '']
    .filter(Boolean).join(' ');
  // Absent code/signal (legacy records that stored JS undefined, which JSON
  // drops) must still print as null — never the word "undefined" from a
  // template string. Real 0 stays 0.
  log(`exit ${state.id} pid=${state.pid} code=${code ?? 'null'} signal=${signal ?? 'null'} at=${at}${extras ? ` ${extras}` : ''}`);
}

function allStates() {
  const states = readAllStateFiles().filter(survivedItsBoot);
  const now = Date.now();
  const exited = states.filter((state) => state.exit).sort((a, b) => Date.parse(b.exit.at) - Date.parse(a.exit.at));
  const reaped = new Set();
  exited.forEach((state, index) => {
    noteExitObserved(state);
    const expired = now - Date.parse(state.exit.at) > exitRetentionMs;
    const beyondLimit = index >= maxRecentExits;
    if (expired || beyondLimit) {
      removeSessionFiles(state.id);
      loggedExits.delete(state.id);
      reaped.add(state.id);
    }
  });
  return states.filter((state) => !reaped.has(state.id));
}

function keeperRequest(id, verb, params, onEvent, timeoutMs = keeperRequestTimeoutMs) {
  const state = readState(id);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(listenAddress(state.keeper_socket));
    const requestId = randomUUID();
    const finishError = (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      const timedOut = new Error(`keeper ${verb} request timed out after ${timeoutMs}ms`);
      timedOut.code = 'KEEPER_MUTE';
      finishError(timedOut);
    }, timeoutMs);
    socket.once('error', finishError);
    socket.once('connect', () => writeRecord(socket, { type: 'request', request_id: requestId, verb, params }));
    readRecords(socket, (record) => {
      if (record.type === 'event') {
        onEvent?.(record.event);
        return;
      }
      if (record.request_id !== requestId) return;
      if (record.ok) {
        clearTimeout(timer);
        resolve({ result: record.result, socket });
      }
      else {
        finishError(new Error(record.error));
      }
    }, finishError);
  });
}

async function spawnSession(params) {
  if (!Array.isArray(params.argv) || params.argv.length === 0 || params.argv.some((part) => typeof part !== 'string')) throw new Error('spawn argv must be a non-empty string array');
  if (!path.isAbsolute(params.cwd || '')) throw new Error('spawn cwd must be an absolute path');
  // A cwd that does not exist is refused HERE, with the path named, not five
  // seconds later as a keeper corpse. CreateProcess rejects a bad
  // lpCurrentDirectory with error code 2, node-pty throws it inside the
  // keeper's listen callback, and the daemon could only report "keeper never
  // came up within 7000ms" with an empty log (live-caught 2026-08-12: a
  // migrated Linux-era session's /home/you/... cwd was inherited by a new
  // Windows session, and every new-session attempt looked bricked). A path
  // shaped for the WRONG OS (/home/... on win32) is the same refusal with the
  // same message, because path.isAbsolute accepts it and the filesystem does not.
  let cwdStat = null;
  try { cwdStat = fs.statSync(params.cwd); } catch { /* refused below */ }
  if (!cwdStat?.isDirectory()) {
    throw new Error(`spawn cwd does not exist or is not a directory: ${params.cwd}`);
  }
  if (!Number.isInteger(params.cols) || params.cols < 1) throw new Error('spawn cols must be a positive integer');
  if (!Number.isInteger(params.rows) || params.rows < 1) throw new Error('spawn rows must be a positive integer');
  const id = randomUUID();
  assertSocketPathFits(keeperSocket(id));
  const derived = derivedIdentity(params.argv);
  const agent = Object.prototype.hasOwnProperty.call(params, 'agent') ? params.agent : derived.agent;
  const agentSession = Object.prototype.hasOwnProperty.call(params, 'agent_session')
    ? params.agent_session
    : derived.agent_session;
  const config = {
    id, argv: params.argv, cwd: params.cwd, env: params.env || {}, cols: params.cols, rows: params.rows,
    agent: agent ?? null, agent_session: agentSession ?? null,
    created_at: new Date().toISOString(), state_path: statePath(id), keeper_socket: keeperSocket(id),
    // The pid this store's life is tied to (harness-watch.js), handed to the
    // keeper so the session dies with the harness even when this daemon is
    // killed too fast to reap it (2026-09-03: libuv's Windows job object takes
    // a non-detached daemon down the instant its spawner exits, the keeper is
    // detached and survives, and the session leaked for an hour).
    harness_pid: resolveHarnessWatchPid(process.env, process.ppid),
  };
  fs.writeFileSync(configPath(id), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  // A keeper is detached and long-lived, so its stderr cannot be a pipe this
  // process reads: if the daemon dies first, a keeper writing into a full pipe
  // with no reader blocks forever. It gets its own append-only file instead,
  // which survives the daemon, needs no reader, and is what turns "spawn timed
  // out after 10000ms" back into the actual stack trace.
  const keeperLog = fs.openSync(keeperLogPath(id), 'a', 0o600);
  let child;
  const job = acquireSessionJob(id, { create: true });
  let usingScope = false;
  let died = null;
  try {
    // `systemd-run --scope` EXECS the command in place rather than supervising
    // it, so the returned child IS the keeper: the exit watch below still sees a
    // keeper that died during startup, which is the failure this whole function
    // is shaped around. Verified on a real scope (/proc/<pid>/comm is the
    // command, not systemd-run) before this was written.
    const keeperArgs = [path.join(__dirname, 'keeper.js'), configPath(id)];
    usingScope = await sessionScopeUsable();
    const launch = usingScope
      ? scopeCommand(id, scopePolicy, process.execPath, keeperArgs)
      : { command: process.execPath, args: keeperArgs };
    child = spawn(launch.command, launch.args, {
      // windowsHide keeps a detached keeper from acquiring a visible console
      // window (the daemon-start incident, 2026-08-20); closing such a window
      // would CTRL_CLOSE the keeper and its session with it.
      detached: true, stdio: ['ignore', keeperLog, keeperLog], env: process.env, windowsHide: true,
    });
    if (job) {
      try { assignJobPid(job, child.pid); }
      catch (error) {
        log(`session job assign for ${id} pid=${child.pid} failed: ${error.message}; continuing without Windows job containment`);
        dropSessionJob(id);
      }
    }
  } catch (error) {
    // A synchronous spawn failure used to escape this function entirely,
    // orphaning the config file written above forever (nothing sweeps
    // .config.json; review round 1). It is a failed spawn like any other now.
    died = `keeper process could not be started: ${error.message}`;
  } finally {
    try { fs.closeSync(keeperLog); } catch {}
  }
  // Watch for death before unref. A keeper that dies during startup is the
  // whole failure mode here, and waiting out a deadline to discover it is what
  // made a one line ENOENT take an hour to find.
  if (child) {
    child.once('error', (error) => { died = `keeper process could not be started: ${error.message}`; });
    child.once('exit', (code, signal) => { died = `keeper exited during startup (${signal ? `signal ${signal}` : `code ${code}`})`; });
    child.unref();
  }
  const deadline = Date.now() + keeperStartTimeoutMs;
  while (Date.now() < deadline && !died) {
    if (keeperIsUp(id)) {
      try { fs.unlinkSync(configPath(id)); } catch {}
      log(`spawn ${id} pid=${readState(id).pid}`);
      return { id };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const reason = readLogHead(keeperLogPath(id), 20).trim();
  const summary = died || `keeper never came up within ${keeperStartTimeoutMs}ms`;
  await reapAbandonedSpawn(id, child, usingScope, Boolean(died));
  log(`spawn ${id} failed: ${summary}${reason ? `: ${reason.split('\n').join(' | ')}` : ''}`);
  throw new Error(reason
    ? `${summary} for session ${id}: ${reason}`
    : `${summary} for session ${id} (no output in ${keeperLogPath(id)})`);
}

// systemctl WITHOUT blocking the event loop (review round 2). spawnSync here
// froze the WHOLE daemon, every session's input and observe relay, for up to
// the subprocess timeout, during exactly the stalls that make systemctl slow:
// the one-bad-actor blast radius this file exists to shrink. Never throws;
// resolves with the exit status, null when the tool failed or timed out.
function runSystemctl(args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      execFile('systemctl', args, { encoding: 'utf8', timeout: timeoutMs }, (error) => {
        resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0 });
      });
    } catch { resolve({ status: null }); }
  });
}

// A SPAWN THAT MISSES ITS DEADLINE IS KILLED, NEVER ABANDONED (2026-08-09).
// During the 02:33 memory stall three spawns in a row timed out here, and the
// old code threw and forgot the children: each keeper finished booting seconds
// later, bound its socket, and sat holding a live claude the daemon had already
// reported as a failure. Two held freshly minted session ids; one held a
// --resume of the session Pat was about to retry, a double-writer in waiting.
// The caller was told "failed", so failed has to be TRUE.
async function reapAbandonedSpawn(id, child, usingScope, childAlreadyDead) {
  try {
    if (process.platform === 'win32') terminateSessionJob(id, 'failed spawn');
    if (usingScope) {
      // The scope IS the session's cgroup, so stopping it covers every launch
      // shape systemd-run has (exec'd keeper or supervising parent) and
      // everything the keeper itself already spawned. CHECKED, never
      // fire-and-forget (review round 1): spawnSync reports failure by status,
      // not by throwing, and a stop that silently failed here would leave the
      // tree alive behind the exit record written below.
      const stop = await runSystemctl(['--user', 'stop', `harbor-session-${id}.scope`]);
      if (stop.status !== 0) {
        log(`scope stop for failed spawn ${id} did not confirm (status ${stop.status}); escalating to SIGKILL of the scope`);
        await runSystemctl(['--user', 'kill', '--signal=SIGKILL', `harbor-session-${id}.scope`]);
      }
    }
    if (!childAlreadyDead && child) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
    // Let the kill land before judging what the keeper left behind; a SIGKILLed
    // process writes nothing more, so after this window the files are ours.
    const settle = Date.now() + 1000;
    while (Date.now() < settle && !childAlreadyDead && child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (fs.existsSync(statePath(id))) {
      // The keeper bound late, so a pty child exists: put down its process
      // group too, then leave an honest exit record the way reconcile does.
      // Unconditional even when scoped (review round 1): a scope stop that
      // lied is not a cleanup, and killing an already-dead group is free.
      const state = JSON.parse(fs.readFileSync(statePath(id), 'utf8'));
      if (state.pid) {
        try { process.kill(-state.pid, 'SIGKILL'); } catch { try { process.kill(state.pid, 'SIGKILL'); } catch {} }
      }
      if (!state.exit) {
        const exit = { code: null, signal: 'SIGKILL', at: new Date().toISOString(), reason: 'keeper missed its spawn deadline and was reaped' };
        const temporary = `${statePath(id)}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify({ ...state, exit })}\n`, { mode: 0o600 });
        fs.renameSync(temporary, statePath(id));
      }
    } else {
      // Nothing ever bound: nothing owns these files, and the config would
      // otherwise sit in the store forever (only the success path unlinked it).
      removeSessionFiles(id);
    }
  } catch (error) {
    // Best-effort by design: the spawn error below is the report that matters,
    // and reconcileStaleSessions() at the next daemon start is the backstop.
    log(`reap of failed spawn ${id} incomplete: ${error.message}`);
  }
}

// HAS THE KEEPER FINISHED COMING UP? A NAMED PIPE IS NOT A FILE (2026-08-06).
//
// The keeper calls persist() from inside its own `server.listen` callback, so
// the state file appearing already means the socket is bound; checking the
// socket too is belt-and-braces on POSIX and is kept there because that path is
// proven. On Windows the keeper binds `\\.\pipe\...`, which creates NO file at
// the socket path, so `fs.existsSync(keeperSocket(id))` is false forever: the
// daemon timed out after 7000ms with "keeper never came up" and an empty keeper
// log, while the keeper was in fact running, holding a real ConPTY, and had
// already written its state. The most misleading shape a bug can take is a
// readiness check that cannot pass.
function keeperIsUp(id) {
  if (!fs.existsSync(statePath(id))) return false;
  if (process.platform === 'win32') return true;
  return fs.existsSync(keeperSocket(id));
}

// The kernel does not refuse an over-long socket path, it truncates it, so this
// has to be checked rather than caught. Refusing here names the store and the
// overflow; the alternative is a keeper that dies invisibly ten seconds later.
function assertSocketPathFits(socketPath) {
  if (socketFits(socketPath)) return;
  throw new Error(
    `session socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${SUN_PATH_MAX} byte AF_UNIX limit: ${socketPath}. `
    + 'Set HARBOR_SESSIOND_SOCKET_DIR to a shorter directory, or move HARBOR_SESSIOND_DIR out of a deep path.',
  );
}

async function dispatch(socket, record) {
  const params = record.params || {};
  if (record.verb === 'health') {
    // Containment state travels with health (review round 1): a daemon running
    // unscoped is a real condition an operator must be able to SEE, not a
    // single log line from days ago.
    const scopes = scopePolicy.enabled
      ? { enabled: scopeReady === true, slice: scopePolicy.slice }
      : { enabled: false, reason: scopePolicy.reason };
    // Same reasoning as `scopes` above: whether idle sessions are being ended
    // is a real condition an operator must be able to SEE, not infer from the
    // absence of log lines.
    const dormancy = dormancyPolicy.enabled
      ? { enabled: true, after_ms: dormancyPolicy.afterMs, watching: dormancyWatch.size }
      : { enabled: false };
    const jobs = jobPolicy.enabled
      ? { enabled: true, sessions: sessionJobs.size }
      : { enabled: false, reason: jobPolicy.reason, sessions: 0 };
    return { ok: true, pid: process.pid, request: randomUUID(), sessions: allStates().length, scopes, jobs, dormancy };
  }
  if (record.verb === 'list') return { sessions: allStates().map(({ keeper_socket, keeper_pid, ...state }) => state) };
  if (record.verb === 'proc-info') return processIntel.info(Number(params.pid));
  if (record.verb === 'proc-tree') return processIntel.tree(Number(params.pid));
  if (record.verb === 'proc-find') return processIntel.find(String(params.needle || ''));
  if (record.verb === 'logs') {
    const lines = Number.isInteger(params.lines) ? Math.max(1, Math.min(1000, params.lines)) : 100;
    return { log: paths.log, text: readLogTail(paths.log, lines) };
  }
  if (record.verb === 'shutdown') {
    setImmediate(shutdown);
    return { stopping: true };
  }
  if (record.verb === 'yield') {
    // The deliberate-handover verb: finish in-flight work, release the pipe,
    // exit clean so daemon-watch records kind=clean and NEVER respawns.
    setImmediate(beginYield);
    return { yielding: true };
  }
  if (record.verb === 'test-wedge') {
    // Harness seam, double-gated: the env must name this daemon wedgeable AND
    // the verb must be sent. From then on every incoming record is dropped on
    // the floor while connections still accept: exactly a real wedge's
    // observable shape from every prober's seat, with the event loop alive so
    // harness teardown still works. cleanDaemonEnv never forwards the env var,
    // so no CLI-started daemon can ever be wedged this way.
    if (process.env.HARBOR_SESSIOND_TEST_WEDGE !== '1') {
      throw new Error('test-wedge refused: HARBOR_SESSIOND_TEST_WEDGE=1 is not set on this daemon');
    }
    wedged = true;
    log('test-wedge engaged: accepting connections, answering nothing');
    return { wedging: true };
  }
  if (record.verb === 'spawn') return spawnSession(params);
  if (!['observe', 'input', 'resize', 'screen', 'process', 'terminate', 'annotate'].includes(record.verb)) throw new Error(`unsupported verb: ${record.verb}`);
  const id = params.id;
  if (typeof id !== 'string' || !id) throw new Error(`${record.verb} requires id`);
  try {
    const forwarded = await keeperRequest(id, record.verb, params, (event) => writeRecord(socket, { type: 'event', event }));
    if (record.verb === 'observe') {
      socket.on('close', () => forwarded.socket.destroy());
    } else forwarded.socket.destroy();
    return forwarded.result;
  } catch (error) {
    if (record.verb === 'process') {
      const state = readState(id);
      if (state.exit) return { pid: state.pid, running: false, exit: state.exit };
    }
    throw error;
  }
}

// A DAEMON MUST NOT STEAL A LIVE STORE (2026-08-06). A blind `unlinkSync` used to
// sit here, so a second daemon deleted the socket a RUNNING daemon was serving on
// and rebound it. The original kept running, still holding every session it had
// spawned, behind an inode nothing could reach any more. Measured on Pat's machine
// at 28 daemons deep with 27 orphaned, every one of them still `LISTEN`ing on the
// same path. The trigger was `harbor-sessiond start` having no already-running
// gate and falling through to a detached spawn whenever `systemd-run` refused a
// unit name that was already taken; that caller is fixed too, but the guard
// belongs HERE, because this is the only place that can make the wrong state
// impossible no matter who calls start.
//
// Liveness is decided by a real CONNECTION, never by the file existing: a socket
// file outlives an unclean exit, and that stale case is exactly the one we do want
// to clear. Same rule as the retired backend health gate, for the same reason.
//
// VERDICT SPLIT (2026-08-30): a connect alone is the lying-gate shape. A wedged
// daemon still accepts connections out of the kernel backlog while answering
// nothing, so a connect-only probe said "alive" about a daemon nothing could
// use, and `start` exited 3 claiming a healthy owner existed. The probe now
// sends a real `health` request and answers one of three verdicts:
//   'ok'   answered: a healthy owner, never fought (exit 3, unchanged).
//   'dead' nothing owns the socket (refused/absent): bind as before.
//   'mute' accepts but never answers: a wedged owner. start() exits 4 and
//          NEVER unlinks or binds; killing a mute owner needs the identity
//          verification only `harbor-sessiond recover` carries. The gate gets
//          more articulate here, never less conservative: mute-vs-merely-busy
//          only ever produces a refusal to start.
function probeStoreOwner(socketPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    // A NAMED PIPE IS NOT A FILE, the same trap `keeperIsUp` documents above:
    // on Windows the address is `\\.\pipe\...` and nothing exists at the socket
    // PATH, so this short-circuit would answer "dead" about every live owner.
    // The connection attempt is the real question anyway; the stat is only an
    // optimisation, so it is skipped where it cannot be right.
    if (process.platform !== 'win32' && !fs.existsSync(socketPath)) { resolve('dead'); return; }
    const sock = net.createConnection({ path: listenAddress(socketPath) });
    let settled = false;
    let connected = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(verdict);
    };
    const timer = setTimeout(() => finish(connected ? 'mute' : 'dead'), timeoutMs);
    sock.once('error', () => finish(connected ? 'mute' : 'dead'));
    sock.once('connect', () => {
      connected = true;
      writeRecord(sock, { type: 'request', request_id: randomUUID(), verb: 'health', params: {} });
      readRecords(sock, (record) => {
        if (record.type === 'response') finish('ok');
      }, () => finish('mute'));
    });
  });
}

// A kill-targeting record for `harbor-sessiond recover`, explicitly NOT
// liveness (liveness stays a real request; a file can say anything). Written
// only by the daemon that BOUND the socket, inside the listen callback, and
// removed on shutdown/yield. Consumers must verify pid + creation time + exec
// name against the live process table before signalling; a mismatch is a
// recycled pid and a refusal.
const ownerRecordPath = path.join(paths.root, 'owner.json');
function writeOwnerRecord() {
  try {
    fs.writeFileSync(ownerRecordPath, `${JSON.stringify({
      not_liveness: true,
      pid: process.pid,
      // Only a supervisor spawn (daemon-watch, holding the IPC channel) records
      // its parent: a harness- or serve-spawned daemon's ppid is some innocent
      // process that recover must never aim at.
      watcher_pid: typeof process.send === 'function' ? process.ppid : null,
      boot_id: bootId,
      bound_at: new Date().toISOString(),
      started_at_epoch_ms: Math.round(Date.now() - process.uptime() * 1000),
      exec: path.basename(process.execPath),
    })}\n`, { mode: 0o600 });
  } catch (error) {
    log(`owner record write failed (continuing; recover falls closed without it): ${error.message}`);
  }
}
function removeOwnerRecord() {
  try { fs.unlinkSync(ownerRecordPath); } catch {}
}

// Only the daemon that actually BOUND this path may remove it on the way out.
// Declared here, above `start()`, so the listen callback can never touch it in a
// temporal dead zone.
let bound = false;
// The test-wedge seam (see the dispatch verb): when set, every incoming record
// is dropped while connections still accept.
let wedged = false;
// In-flight dispatch count, so `yield` can drain real work before exiting.
let inFlightDispatches = 0;
const clients = new Set();
const server = net.createServer((socket) => {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  // A client vanishing mid-write emits 'error' on ITS socket, and an 'error' with
  // no listener is an uncaught exception that takes the whole daemon down with
  // every session it owns. Live-caught 2026-08-06: `read ECONNRESET` killed the
  // daemon at 06:19:48Z. A peer disconnecting rudely is ordinary, not fatal.
  socket.on('error', (error) => {
    clients.delete(socket);
    log(`client socket error (continuing): ${error.message}`);
  });
  readRecords(socket, async (record) => {
    if (wedged) return;
    if (record.type !== 'request' || !record.request_id) {
      writeRecord(socket, { type: 'error', error: 'expected request record' });
      return;
    }
    inFlightDispatches += 1;
    try {
      const result = await dispatch(socket, record);
      writeRecord(socket, { type: 'response', request_id: record.request_id, ok: true, result });
    } catch (error) {
      writeRecord(socket, { type: 'response', request_id: record.request_id, ok: false, error: error.message });
    } finally {
      inFlightDispatches -= 1;
    }
  }, (error) => writeRecord(socket, { type: 'error', error: error.message }));
});

// The deliberate lane's daemon half (2026-08-30). Close the server FIRST so the
// successor's bind window opens while this daemon drains (a named pipe with a
// live listening instance refuses a FIRST_PIPE_INSTANCE bind), finish in-flight
// dispatches up to the drain budget, flush and drop the remaining clients, then
// exit through the same clean-shutdown IPC an ordinary stop uses so the watcher
// records kind=clean and retires instead of respawning. Never sends a keeper
// request: keepers are the sessions' own and a yield must not touch them.
let yielding = false;
async function beginYield() {
  if (yielding) return;
  yielding = true;
  const yieldDrainMs = nonnegativeNumber(process.env.HARBOR_SESSIOND_YIELD_DRAIN_MS, 2000);
  log(`yield: releasing ${paths.socket} and draining in-flight requests`);
  server.close();
  processIntel.stop();
  const drainDeadline = Date.now() + yieldDrainMs;
  while (inFlightDispatches > 0 && Date.now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // end() flushes queued replies (the yield acknowledgement included) where a
  // bare destroy() would drop them; the settle gives the flush a beat to land.
  for (const socket of clients) { try { socket.end(); } catch {} }
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const socket of clients) socket.destroy();
  if (typeof process.send === 'function') {
    try { process.send({ type: 'clean-shutdown' }); } catch {}
  }
  if (bound) removeOwnerRecord();
  log(`yield complete: exiting cleanly (in-flight drained=${inFlightDispatches === 0})`);
  process.exit(0);
}

// The bind race the probe cannot close: two daemons can both probe a dead socket
// before either binds. The loser must die rather than unlink and retry, because
// retrying is the stampede with extra steps.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log(`another daemon bound ${paths.socket} first; exiting`);
    process.exit(3);
  }
  // An accept-time hiccup under fd pressure (EMFILE-class) is survivable and
  // worth surviving (review round 1): exiting here takes the control plane for
  // every session at once, the very blast radius this file exists to shrink.
  // Only a server that never bound, or an unrecognized failure, is fatal.
  if (bound && ['EMFILE', 'ENFILE', 'ECONNABORTED', 'ECONNRESET'].includes(error.code)) {
    log(`daemon server error (continuing): ${error.message}`);
    return;
  }
  log(`daemon server error: ${error.stack || error.message}`);
  process.exit(1);
});

// THE OTHER HALF: ask the keeper, once, at startup.
//
// The boot filter is exact but it only knows about state files carrying a stamp,
// and it says nothing about a keeper killed WITHIN this boot (an OOM kill, a
// SIGKILL), which leaves the identical `exit: null` wreckage. So every session
// still claiming to run is checked against the rule this file already applies to
// the daemon's own socket: liveness is a real CONNECTION, never a file existing.
//
// Only a session proven DEAD is written to, which is what makes writing safe at
// all: the state file belongs to the keeper, and a keeper that cannot answer a
// connection is not racing anyone for it.
// THE PROBE IS A REAL REQUEST, NOT A CONNECT (review round 1, both lenses).
// An AF_UNIX connect is completed by the kernel out of the listen backlog, so
// it proves a socket exists, not that the keeper's event loop can serve it:
// the same lying-gate shape the retired backend health check prevented. Verdicts:
// 'ok' (answered), 'dead' (nothing owns the socket: refused/absent, mark it in
// one pass, exactly what a SIGKILLed keeper leaves), 'mute' (accepts but never
// answers: a wedge, or a keeper merely busy, which is why mute needs TWO
// consecutive passes and a put-down before it may be marked, below).
async function probeKeeperVerdict(state, timeoutMs = positiveNumber(process.env.HARBOR_SESSIOND_PROBE_TIMEOUT_MS, 5000)) {
  try {
    const forwarded = await keeperRequest(state.id, 'process', {}, undefined, timeoutMs);
    forwarded.socket.destroy();
    return 'ok';
  } catch (error) {
    return error && error.code === 'KEEPER_MUTE' ? 'mute' : 'dead';
  }
}

// A wedged keeper is PUT DOWN before it is written off: marking a still-running
// keeper exited invites the double-writer (the rail shows it dead, Pat resumes,
// two claudes hold one transcript; and the wedged keeper's next persist() would
// quietly write the exit back to null). Returns whether the keeper is VERIFIED
// gone, and the caller may only record the exit when it is (review round 2).
// The pid-reuse guard is /proc-based and therefore Linux-only; elsewhere the
// recycled-pid window is accepted over leaving a wedged keeper alive behind a
// death certificate.
async function putDownKeeper(state) {
  let keeperGone = false;
  if (process.platform === 'win32') terminateSessionJob(state.id, 'mute keeper');
  if (process.platform === 'linux') {
    try {
      const cmdline = fs.readFileSync(`/proc/${state.keeper_pid}/cmdline`, 'utf8');
      if (!cmdline.includes('keeper.js')) keeperGone = true; // recycled pid: the keeper itself is long gone
    } catch { keeperGone = true; }
  }
  if (!keeperGone) {
    try { process.kill(state.keeper_pid, 'SIGKILL'); } catch { keeperGone = true; }
  }
  if (process.platform === 'linux') {
    await runSystemctl(['--user', 'stop', `harbor-session-${state.id}.scope`]);
  }
  if (state.pid) {
    try { process.kill(-state.pid, 'SIGKILL'); } catch { try { process.kill(state.pid, 'SIGKILL'); } catch {} }
  }
  const deadline = Date.now() + 1500;
  while (!keeperGone && Date.now() < deadline) {
    try { process.kill(state.keeper_pid, 0); await new Promise((r) => setTimeout(r, 50)); }
    catch { keeperGone = true; }
  }
  return keeperGone;
}

const muteSuspects = new Map(); // id -> consecutive mute verdicts (periodic passes only)

async function reconcileStaleSessions({ periodic = false } = {}) {
  const stale = [];
  const seen = new Set();
  for (const state of readAllStateFiles()) {
    if (state.exit) continue;
    acquireSessionJob(state.id);
    seen.add(state.id);
    const relation = bootRelation(state.boot_id, bootId);
    if (relation === 'foreign') { stale.push([state, 'the boot it was spawned in has ended']); continue; }
    const verdict = await probeKeeperVerdict(state);
    if (verdict === 'ok') { muteSuspects.delete(state.id); continue; }
    if (verdict === 'dead') {
      muteSuspects.delete(state.id);
      stale.push([state, 'its keeper is not answering its socket']);
      continue;
    }
    // 'mute'. At startup nothing is under load yet and nothing has history, so
    // a mute keeper is left alone (startup's job is the obvious wreckage); the
    // periodic sweep applies hysteresis, then acts.
    if (!periodic) continue;
    const strikes = (muteSuspects.get(state.id) || 0) + 1;
    muteSuspects.set(state.id, strikes);
    if (strikes < 2) continue;
    if (!(await putDownKeeper(state))) {
      // Not verified dead: it stays a suspect and stays LISTED, because a
      // death certificate for a process that may still be running is how a
      // double-writer starts. The next pass tries again.
      log(`mute keeper for ${state.id} could not be verified dead; keeping it suspect`);
      continue;
    }
    muteSuspects.delete(state.id);
    stale.push([state, 'its keeper stopped answering requests and was put down']);
  }
  for (const id of [...muteSuspects.keys()]) if (!seen.has(id)) muteSuspects.delete(id);
  for (const [state, reason] of stale) {
    // Honest about BOTH facts: that it is gone, and that nobody watched it go,
    // so there is no code and no signal to report. A fabricated clean exit would
    // read as an ordinary close in every consumer downstream.
    const at = bootRelation(state.boot_id, bootId) === 'foreign'
      ? bootInstant().toISOString()
      : new Date().toISOString();
    const exit = { code: null, signal: null, at, reason: `session did not survive: ${reason}` };
    try {
      const temporary = `${statePath(state.id)}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({ ...state, exit })}\n`, { mode: 0o600 });
      fs.renameSync(temporary, statePath(state.id));
    } catch (error) {
      log(`could not mark stale session ${state.id} as exited: ${error.message}`);
    }
  }
  if (stale.length) log(`reconciled ${stale.length} session(s) that did not survive: ${stale.map(([state]) => state.id).join(', ')}`);
  return stale.length;
}

// IDLE SESSIONS ARE ENDED, NOT ACCUMULATED (2026-08-09). Why, and why a
// dormant session is just a clean exit rather than a third lifecycle state, is
// in the header of dormancy.js. This function is only the plumbing: the whole
// decision is `evaluateDormancy`, which is pure.
const dormancyPolicy = resolveDormancyPolicy();
const dormancyWatch = new Map(); // id -> { cpuUsec, idleChecks }
// Tests and the unscoped fallback can opt out of requiring a per-session cgroup;
// see the comment on cgroupCpuUsec for why requiring it is the default.
const dormancyRequireScope = process.env.HARBOR_SESSIOND_DORMANT_REQUIRE_SCOPE !== '0';

// THE CPU SIGNAL IS PER-PLATFORM, AND ITS FAILURE IS LOUD (2026-08-20). The
// cgroup read below answers null for every session on win32 (/proc does not
// exist), and evaluate() correctly reads null as busy, so on Windows dormancy
// spent its whole life inert while the boot line said "dormancy on": sessions
// accumulated until 27 claude runtimes and their private MCP children drove
// the commit charge to the limit and CLIs started dying of failed allocations
// mid-turn-start. On win32 the signal is now one Win32_Process snapshot per
// sweep, summed over each session's keeper-rooted process tree (the tree is
// the per-session scope Windows actually has). The snapshot is taken only
// when at least one session is past the pty-idle threshold, so a machine with
// nothing to evaluate spawns nothing.
let winSnapshotFailedLogged = false;
async function resolveDormancyCpuReader(states) {
  if (process.platform !== 'win32') {
    return (state) => cgroupCpuUsec(state.keeper_pid, { sessionId: state.id, requireScope: dormancyRequireScope });
  }
  const now = Date.now();
  const wantsCpu = states.some((state) => {
    if (state.exit) return false;
    const stampedAt = Date.parse(state.last_activity_at || '');
    return Number.isFinite(stampedAt) && now - stampedAt >= dormancyPolicy.afterMs;
  });
  const jobReadings = new Map();
  let needsFallback = false;
  if (wantsCpu) {
    for (const state of states) {
      if (state.exit) continue;
      const job = acquireSessionJob(state.id);
      if (!job) { needsFallback = true; continue; }
      try {
        const reading = queryJob(job);
        // An EMPTY job on a session still listed live means the tree escaped
        // the job (or was never captured): a constant cpuUsec would read as
        // idle forever (f8 finding L1). The process-table fallback answers
        // honestly for exactly this shape.
        if (reading.activeProcesses === 0) { needsFallback = true; continue; }
        jobReadings.set(state.id, reading.cpuUsec);
      }
      catch (error) {
        needsFallback = true;
        log(`dormancy: job accounting unavailable for ${state.id}: ${error.message}; using process-table fallback`);
      }
    }
  }
  // CPU is a delta. Refresh at the sweep boundary so a test/override cadence
  // shorter than the resident timer cannot compare the same cumulative sample
  // twice and mistake a busy tree for idle.
  if (wantsCpu && needsFallback && processIntel.available) processIntel.refresh();
  const table = wantsCpu && needsFallback ? (processIntel.cpuTable() || await winCpuSnapshot()) : null;
  if (wantsCpu && needsFallback && !table && !winSnapshotFailedLogged) {
    winSnapshotFailedLogged = true;
    log('dormancy: process-table snapshot failed; every session reads as busy until it succeeds');
  }
  if (table) winSnapshotFailedLogged = false;
  return (state) => jobReadings.has(state.id) ? jobReadings.get(state.id) : winProcessTreeCpuUsec(table, state.keeper_pid);
}

// The dormancy sweep's third fact: is this session's transcript TREE fresh?
// A session holding for its own subagents shows a silent pty and near-zero
// cpu while the agents' jsonl files grow under
// ~/.claude/projects/<project>/<session-id>/subagents/. The project dir is
// resolved by scanning for <session-id>.jsonl (the id is unique; same
// fallback rule the app's transcript resolver uses) and cached; a session
// the scan cannot place gets no veto and behaves exactly as before.
const transcriptDirCache = new Map(); // agent_session -> project dir (or null when unresolvable)
function resolveTranscriptProject(agentSession) {
  if (transcriptDirCache.has(agentSession)) return transcriptDirCache.get(agentSession);
  let found = null;
  try {
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    for (const dir of fs.readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, dir);
      try {
        if (fs.existsSync(path.join(candidate, `${agentSession}.jsonl`))) { found = candidate; break; }
      } catch { /* unreadable project dir */ }
    }
  } catch { /* no projects root */ }
  transcriptDirCache.set(agentSession, found);
  return found;
}

// Provider transcript roots for the dormancy veto. Defaults cover the standard
// store locations; the env vars extend or replace them (path-delimited). A
// session whose rollout lives under a non-default provider home simply is not
// found, which THROWS in dormancy.js and fails closed to "leave it awake".
const providerTranscriptRoots = {
  codex: (process.env.HARBOR_CODEX_SESSION_ROOTS || path.join(os.homedir(), '.codex', 'sessions'))
    .split(path.delimiter).filter(Boolean),
  cursor: (process.env.HARBOR_CURSOR_TRANSCRIPT_ROOTS || path.join(os.homedir(), '.cursor', 'projects'))
    .split(path.delimiter).filter(Boolean),
};

function sessionWorkFresh(state) {
  const agent = state.agent === 'cursor-agent' ? 'cursor' : state.agent;
  if (agent === 'codex' || agent === 'cursor') {
    // Rejections (unresolved identity, transcript not found) propagate to the
    // sweep's catch, which leaves the session alone: fail closed, per the
    // provider-keeper design.
    return providerTranscriptFresh(state, {
      codexRoots: providerTranscriptRoots.codex,
      cursorRoots: providerTranscriptRoots.cursor,
      now: Date.now(),
      freshMs: dormancyPolicy.afterMs,
    });
  }
  const agentSession = state.agent_session;
  if (!agentSession) return false; // nothing to consult; behavior unchanged
  const project = resolveTranscriptProject(agentSession);
  if (!project) return false;
  const freshMs = dormancyPolicy.afterMs;
  const now = Date.now();
  const isFresh = (file) => {
    try { return now - fs.statSync(file).mtimeMs < freshMs; } catch { return false; }
  };
  if (isFresh(path.join(project, `${agentSession}.jsonl`))) return true;
  const subagents = path.join(project, agentSession, 'subagents');
  try {
    for (const name of fs.readdirSync(subagents)) {
      if (name.endsWith('.jsonl') && isFresh(path.join(subagents, name))) return true;
    }
  } catch { /* no subagents dir */ }
  return false;
}

async function runDormancySweep() {
  if (!dormancyPolicy.enabled) return 0;
  // A foreign-boot state file is `reconcileStaleSessions`'s business, and its
  // keeper_pid belongs to some unrelated process this boot. Reading a cgroup
  // through it would be reading a stranger's CPU.
  const states = readAllStateFiles().filter((state) => bootRelation(state.boot_id, bootId) !== 'foreign');
  return sweepDormancy({
    states,
    now: Date.now(),
    policy: dormancyPolicy,
    watch: dormancyWatch,
    readCpu: await resolveDormancyCpuReader(states),
    workFresh: sessionWorkFresh,
    // The keeper models the screen already, so this is a cheap existing verb
    // rather than a new mechanism. Asked only about a session both cheap
    // signals have already condemned; see `awaitingAnswer` for why it exists.
    readScreen: async (state) => {
      const forwarded = await keeperRequest(state.id, 'screen', {});
      forwarded.socket.destroy();
      const result = forwarded.result || {};
      return result.text || result.screen || '';
    },
    // Through the KEEPER's own terminate verb, not a signal from here. That
    // path already carries the SIGTERM-then-SIGKILL grace escalation, kills the
    // process GROUP (so the session's MCP servers go with it rather than being
    // reparented to init as the orphans this whole exercise is about), and ends
    // at the keeper's exit paths, which write the exit record FIRST and only
    // then terminate the session job in finishExit (f8 finding H2) and shut the
    // keeper down. Reimplementing any of that here would be a second, worse
    // copy of code that already exists in keeper.js.
    terminate: async (state, verdict) => {
      const forwarded = await keeperRequest(state.id, 'terminate', {
        signal: 'SIGTERM', grace_ms: 5000, dormant: true, reason: verdict.reason,
      });
      forwarded.socket.destroy();
    },
    log,
  });
}

// WITHIN-BOOT DEATHS SURFACE WITHOUT A DAEMON RESTART (2026-08-09). Startup
// reconciliation only helps the NEXT daemon: three keepers crashed at 02:40
// and this daemon served them as live for 25 minutes, and the containment
// proof's memcg kill of a keeper left the identical stale-live state. The
// probe is a real connection per still-live state file, so the idle cost is a
// handful of unix connects a minute. Guarded against overlap because two
// passes in one process would collide on the same temp-file names.
// ORPHANED MANAGED PROCESSES ARE SWEPT (2026-08-20): the header of
// orphan-sweep.js carries the incident history and the three fences
// (pattern scope, pid-reuse-aware orphan test, two-sweep hysteresis) that
// keep this from ever becoming a generic process killer.
const orphanPolicy = resolveOrphanPolicy();
const orphanSuspects = new Map();
let orphanSweeping = false;
function startOrphanSweep() {
  if (!orphanPolicy.enabled) {
    log(process.platform === 'win32'
      ? 'orphan sweep off: HARBOR_SESSIOND_ORPHAN_INTERVAL_MS=0'
      : 'orphan sweep off: not win32 (orphans reparent to init there)');
    return;
  }
  log(`orphan sweep on: managed-family orphans are killed after two sightings, every ${Math.round(orphanPolicy.intervalMs / 1000)}s`);
  const timer = setInterval(async () => {
    if (orphanSweeping) return;
    orphanSweeping = true;
    try {
      await sweepOrphans({
        policy: orphanPolicy,
        suspects: orphanSuspects,
        log,
        snapshot: async () => {
          if (processIntel.available) processIntel.refresh();
          return processIntel.orphanTable() || snapshotProcessTable();
        },
        // The dead-pty reap: sessions whose child pid the process table
        // proves gone (or recycled) are terminated through the keeper's own
        // verb, whose verified-gone path records the honest exit. This is
        // the identity-verified backstop for the keeper's kill(pid,0) child
        // watch, which a recycled pid can blind forever.
        sessions: readAllStateFiles().filter((state) => bootRelation(state.boot_id, bootId) !== 'foreign'),
        terminateSession: async (id, why) => {
          const forwarded = await keeperRequest(id, 'terminate', { signal: 'SIGTERM', grace_ms: 3000, reason: why });
          forwarded.socket.destroy();
        },
      });
    }
    catch (error) { log(`orphan sweep failed (continuing): ${error.message}`); }
    finally { orphanSweeping = false; }
  }, orphanPolicy.intervalMs);
  timer.unref();
}

let reconciling = false;
function startPeriodicReconcile() {
  const intervalMs = nonnegativeNumber(process.env.HARBOR_SESSIOND_RECONCILE_INTERVAL_MS, 60000);
  if (intervalMs === 0) return;
  const timer = setInterval(async () => {
    if (reconciling) return;
    reconciling = true;
    try { await reconcileStaleSessions({ periodic: true }); }
    catch (error) { log(`periodic reconciliation failed (continuing): ${error.message}`); }
    // AFTER reconciliation and in its own try, deliberately. Reconciliation is
    // the honesty guarantee and must never be skipped because a dormancy sweep
    // threw; and running dormancy second means it never evaluates a session
    // that this very pass has just proven dead.
    try { await runDormancySweep(); }
    catch (error) { log(`dormancy sweep failed (continuing): ${error.message}`); }
    finally { reconciling = false; }
  }, intervalMs);
  timer.unref();
}

async function start() {
  const owner = await probeStoreOwner(paths.socket);
  if (owner === 'ok') {
    log(`daemon already listening on ${paths.socket}; refusing to start a second one`);
    process.stderr.write(`harbor sessiond: already running on ${paths.socket}\n`);
    process.exit(3);
  }
  if (owner === 'mute') {
    // The mute lane never unlinks and never binds: something holds the pipe,
    // and only recover (identity-verified) may put it down. Exit 4 is a
    // DISTINCT answer so callers stop conflating healthy and wedged owners.
    log(`store owner on ${paths.socket} accepts connections but does not answer health; a wedged daemon holds this pipe. Run: harbor-sessiond recover`);
    process.stderr.write(`harbor sessiond: a mute owner holds ${paths.socket}; run: harbor-sessiond recover\n`);
    process.exit(4);
  }
  // Proven dead, so the file is a leftover and clearing it is safe.
  // On Windows the address is a named pipe, so there is no file to remove and
  // no mode to set; both calls would throw ENOENT on a path that never existed.
  if (process.platform !== 'win32') { try { fs.unlinkSync(paths.socket); } catch {} }
  // AFTER the already-running gate and BEFORE serving. After, because the gate
  // is what proves no other daemon owns these keepers, and this pass writes to
  // their state files. Before, because the first thing a client asks is `list`,
  // and answering it with sessions that died in the last reboot is the whole
  // defect this exists to close.
  try { await reconcileStaleSessions(); }
  catch (error) { log(`stale-session reconciliation failed (continuing): ${error.stack || error.message}`); }
  // Warm the scope decision HERE, not inside the first spawn: ensureSliceUnit
  // plus a real systemd-run probe can cost seconds against a cold or reloading
  // manager, and the first spawn's 7s deadline (under the client's 10s budget)
  // is not the place to pay them. Harness stores that named no slice resolve to
  // disabled without ever touching systemd.
  try { await sessionScopeUsable(); }
  catch (error) { log(`scope probe failed (continuing without scopes): ${error.message}`); }
  processIntel.start();
  log(processIntel.available ? 'process intel on: NtQuerySystemInformation snapshot-diff' : `process intel off: ${processIntel.reason}; using PowerShell CIM fallback`);
  log(jobPolicy.enabled
    ? `session jobs on: namespace=${jobPolicy.namespace || 'default-store'} memory_max=${jobPolicy.memoryMax || 'off'} cpu signal: job accounting with process-table fallback`
    : `session jobs off: ${jobPolicy.reason}; Windows sessions use process fallbacks`);
  // Stated once per daemon, because "why did my session close" is answered by
  // this line plus the `dormant <id>` line, and a setting that is never printed
  // is a setting nobody knows is on.
  // The cpu source is NAMED, because "dormancy on" was printed for a week on a
  // platform where the cgroup read could never answer and nobody could tell
  // from the log that the feature was inert (2026-08-20).
  log(dormancyPolicy.enabled
    ? `dormancy on: sessions idle for ${Math.round(dormancyPolicy.afterMs / 60000)}m with no cpu are ended cleanly and can be resumed from the rail (cpu signal: ${process.platform === 'win32' ? (jobPolicy.enabled ? `job accounting with ${processIntel.available ? 'NT process-intel' : 'CIM'} fallback` : (processIntel.available ? 'NT process-intel tree times' : 'CIM keeper process-tree times')) : 'cgroup usage_usec'})`
    : 'dormancy off: idle sessions are kept alive indefinitely');
  startOrphanSweep();
  startPeriodicReconcile();
  if (rssIntervalMs > 0) {
    const rssTimer = setInterval(() => {
      const memory = process.memoryUsage();
      log(`rss pid=${process.pid} rss_bytes=${memory.rss} heap_used_bytes=${memory.heapUsed} sessions=${allStates().length}`);
    }, rssIntervalMs);
    rssTimer.unref();
  }
  // Forensic only, never a trigger: a wedge diagnosis needs a lag trend the
  // way a memory diagnosis needs the RSS heartbeat. Detection that can act
  // lives OUTSIDE this process (daemon-watch), because a wedged event loop
  // cannot run its own recovery code.
  const lagLogMs = positiveNumber(process.env.HARBOR_SESSIOND_LAG_LOG_MS, 1000);
  let lagLastTick = Date.now();
  const lagTimer = setInterval(() => {
    const lag = Date.now() - lagLastTick - 5000;
    lagLastTick = Date.now();
    if (lag >= lagLogMs) log(`event loop lag observed: ${lag}ms`);
  }, 5000);
  lagTimer.unref();
  server.listen(listenAddress(paths.socket), () => {
    bound = true;
    if (process.platform !== 'win32') fs.chmodSync(paths.socket, 0o600);
    writeOwnerRecord();
    log(`daemon listening ${paths.socket}`);
  });
}

start().catch((error) => {
  log(`daemon failed to start: ${error.stack || error.message}`);
  process.exit(1);
});

// A harness daemon dies with its harness (see harness-watch.js for the whole
// story and the env contract). Sessions go first: they are this store's own,
// isolated by construction, and a reaped daemon leaving its sleeps and claudes
// behind would be the half-kill closePaneTab exists to prevent.
const harnessPid = resolveHarnessWatchPid(process.env, process.ppid);
if (harnessPid) {
  const pollMs = positiveNumber(process.env.HARBOR_SESSIOND_PARENT_POLL_MS, 2000);
  let reaping = false;
  const watch = setInterval(async () => {
    try { process.kill(harnessPid, 0); return; } catch { /* harness is gone */ }
    if (reaping) return;
    reaping = true;
    clearInterval(watch);
    log(`harness pid ${harnessPid} is gone; terminating this store's sessions and exiting`);
    try {
      for (const state of allStates()) {
        if (state.exit) continue;
        try {
          const forwarded = await keeperRequest(state.id, 'terminate', { signal: 'SIGKILL' });
          forwarded.socket.destroy();
        } catch { /* keeper already gone */ }
      }
    } finally {
      shutdown();
    }
  }, pollMs);
  watch.unref();
}

// The unconditional unlink that used to be here meant an ORPHANED daemon deleted
// the LIVE daemon's socket file as it exited, which is how reaping 28 orphans took
// the survivor's socket with them: the process kept running and serving, and
// nothing could reach it any more. A daemon that exited on the already-running
// guard, or lost the EADDRINUSE race, never bound and so never touches the file.
function shutdown() {
  processIntel.stop();
  if (typeof process.send === 'function') {
    try { process.send({ type: 'clean-shutdown' }); } catch {}
  }
  for (const socket of clients) socket.destroy();
  server.close(() => {
    if (bound) {
      try { fs.unlinkSync(paths.socket); } catch {}
      removeOwnerRecord();
    }
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
