#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { readRecords, writeRecord } = require('./ndjson.js');
const { resolvePaths, socketFits, listenAddress, SUN_PATH_MAX } = require('./paths.js');
const { appendLog, readLogTail, readLogHead } = require('./log-file.js');
const { currentBootId, bootRelation, bootInstant } = require('./boot-id.js');
const { resolveHarnessWatchPid } = require('./harness-watch.js');

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

function allStates() {
  const states = readAllStateFiles().filter(survivedItsBoot);
  const now = Date.now();
  const exited = states.filter((state) => state.exit).sort((a, b) => Date.parse(b.exit.at) - Date.parse(a.exit.at));
  const reaped = new Set();
  exited.forEach((state, index) => {
    const expired = now - Date.parse(state.exit.at) > exitRetentionMs;
    const beyondLimit = index >= maxRecentExits;
    if (expired || beyondLimit) {
      removeSessionFiles(state.id);
      reaped.add(state.id);
    }
  });
  return states.filter((state) => !reaped.has(state.id));
}

function keeperRequest(id, verb, params, onEvent) {
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
      finishError(new Error(`keeper ${verb} request timed out after ${keeperRequestTimeoutMs}ms`));
    }, keeperRequestTimeoutMs);
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
  };
  fs.writeFileSync(configPath(id), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  // A keeper is detached and long-lived, so its stderr cannot be a pipe this
  // process reads: if the daemon dies first, a keeper writing into a full pipe
  // with no reader blocks forever. It gets its own append-only file instead,
  // which survives the daemon, needs no reader, and is what turns "spawn timed
  // out after 10000ms" back into the actual stack trace.
  const keeperLog = fs.openSync(keeperLogPath(id), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, 'keeper.js'), configPath(id)], {
      detached: true, stdio: ['ignore', keeperLog, keeperLog], env: process.env,
    });
  } finally {
    try { fs.closeSync(keeperLog); } catch {}
  }
  // Watch for death before unref. A keeper that dies during startup is the
  // whole failure mode here, and waiting out a deadline to discover it is what
  // made a one line ENOENT take an hour to find.
  let died = null;
  child.once('error', (error) => { died = `keeper process could not be started: ${error.message}`; });
  child.once('exit', (code, signal) => { died = `keeper exited during startup (${signal ? `signal ${signal}` : `code ${code}`})`; });
  child.unref();
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
  log(`spawn ${id} failed: ${summary}${reason ? `: ${reason.split('\n').join(' | ')}` : ''}`);
  throw new Error(reason
    ? `${summary} for session ${id}: ${reason}`
    : `${summary} for session ${id} (no output in ${keeperLogPath(id)})`);
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
  if (record.verb === 'health') return { ok: true, request: randomUUID(), sessions: allStates().length };
  if (record.verb === 'list') return { sessions: allStates().map(({ keeper_socket, keeper_pid, ...state }) => state) };
  if (record.verb === 'logs') {
    const lines = Number.isInteger(params.lines) ? Math.max(1, Math.min(1000, params.lines)) : 100;
    return { log: paths.log, text: readLogTail(paths.log, lines) };
  }
  if (record.verb === 'spawn') return spawnSession(params);
  if (!['observe', 'input', 'resize', 'screen', 'process', 'terminate'].includes(record.verb)) throw new Error(`unsupported verb: ${record.verb}`);
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
// to clear. Same rule as `herdr_daemon_healthy`, for the same reason.
function probeLiveOwner(socketPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    // A NAMED PIPE IS NOT A FILE, the same trap `keeperIsUp` documents above:
    // on Windows the address is `\\.\pipe\...` and nothing exists at the socket
    // PATH, so this short-circuit would answer "dead" about every live owner.
    // The connection attempt is the real question anyway; the stat is only an
    // optimisation, so it is skipped where it cannot be right.
    if (process.platform !== 'win32' && !fs.existsSync(socketPath)) { resolve(false); return; }
    const sock = net.createConnection({ path: listenAddress(socketPath) });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(result);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

// Only the daemon that actually BOUND this path may remove it on the way out.
// Declared here, above `start()`, so the listen callback can never touch it in a
// temporal dead zone.
let bound = false;
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
    if (record.type !== 'request' || !record.request_id) {
      writeRecord(socket, { type: 'error', error: 'expected request record' });
      return;
    }
    try {
      const result = await dispatch(socket, record);
      writeRecord(socket, { type: 'response', request_id: record.request_id, ok: true, result });
    } catch (error) {
      writeRecord(socket, { type: 'response', request_id: record.request_id, ok: false, error: error.message });
    }
  }, (error) => writeRecord(socket, { type: 'error', error: error.message }));
});

// The bind race the probe cannot close: two daemons can both probe a dead socket
// before either binds. The loser must die rather than unlink and retry, because
// retrying is the stampede with extra steps.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log(`another daemon bound ${paths.socket} first; exiting`);
    process.exit(3);
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
async function reconcileStaleSessions() {
  const stale = [];
  for (const state of readAllStateFiles()) {
    if (state.exit) continue;
    const relation = bootRelation(state.boot_id, bootId);
    if (relation === 'foreign') { stale.push([state, 'the boot it was spawned in has ended']); continue; }
    if (await probeLiveOwner(state.keeper_socket)) continue;
    stale.push([state, 'its keeper is not answering its socket']);
  }
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

async function start() {
  if (await probeLiveOwner(paths.socket)) {
    log(`daemon already listening on ${paths.socket}; refusing to start a second one`);
    process.stderr.write(`harbor sessiond: already running on ${paths.socket}\n`);
    process.exit(3);
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
  server.listen(listenAddress(paths.socket), () => {
    bound = true;
    if (process.platform !== 'win32') fs.chmodSync(paths.socket, 0o600);
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
  for (const socket of clients) socket.destroy();
  server.close(() => {
    if (bound) { try { fs.unlinkSync(paths.socket); } catch {} }
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
