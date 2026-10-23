'use strict';

// AN IDLE SESSION IS NOT A FREE SESSION (2026-08-09).
//
// Measured on Pat's box the afternoon this was written: 15 live sessions, of
// which FOUR had written to their transcript in the last five minutes. The
// other eleven were holding 15.9G between them, three of them having never run
// a single turn since they were spawned. Harbor's daemon log for that day has
// 20 `spawn` lines and ZERO close lines, because nothing has ever ended a
// session except the user closing it or the session dying: `allStates` reaps
// state FILES for sessions that already exited, and `reconcileStaleSessions`
// reports deaths it did not cause, but no path anywhere ends a session that is
// merely finished. Sessions therefore accumulate for as long as the daemon
// lives, each holding a full Claude runtime plus its own private copy of every
// stdio MCP server, and the pile is what actually drives this machine into the
// reclaim stalls that `session-scope.js` was built to contain. Containment
// bounds the blast radius of one bad session; it does nothing about twenty
// idle good ones.
//
// WHAT DORMANT MEANS, AND WHY IT IS NOT A NEW STATE.
// A dormant session is a session that EXITED CLEANLY with its transcript
// intact. That is deliberately not a new lifecycle state, and resisting the
// urge to invent one is the whole reason this file is short. `client.js`'s
// `snapshotFromSessions` filters on `!session.exit`, so a third state with
// `exit: null` would render in the rail as a live pane with no keeper behind
// it: precisely the shape of the 2026-08-07 "13 live" incident, where thirteen
// sessions that died with a reboot came back from disk as live and accepted
// two sends into a pane with no process. Resume is likewise not invented here.
// Claude Code's own `--resume <id>` reads the transcript, and Harbor already
// resumes a not-currently-live session from the rail through
// `bin/claude-sessions --resume-id`. So dormancy adds an ENDING and reuses
// every existing mechanism for the beginning.
//
// WHY THE PTY IS THE ACTIVITY SIGNAL.
// The keeper sees every byte in both directions, which makes it the only place
// that knows, exactly and cheaply, when a session last did anything. Transcript
// mtime is a poor substitute: it moves only when a turn produces a message, so
// a session sitting at a permission prompt or an AskUserQuestion for two hours
// looks identical to one that is genuinely working, and a session whose turn
// is a single long Bash call writes nothing for the duration. Claude Code
// animates a spinner for the whole of a working turn, so pty silence for an
// hour is very strong evidence that nothing is running.
//
// "VERY STRONG" IS NOT "CERTAIN", WHICH IS WHY CPU IS THE SECOND SIGNAL.
// A backgrounded Bash tool child (`run_in_background`) can burn a core for an
// hour while the foreground pty says nothing at all, and that is exactly the
// shape of the 02:15 runaway grep in the 2026-08-09 incident. Killing that
// session would destroy real work whose only evidence is CPU time. So a
// session is only put to sleep when it is quiet AND its cgroup has burned
// essentially no CPU across a full observation interval. The CPU read is
// best-effort by design: when the cgroup cannot be read the session is treated
// as BUSY and left alone, because the cost of a wrong sleep (lost in-flight
// work) is far higher than the cost of a missed one (memory stays held).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');

const HOUR_MS = 60 * 60 * 1000;

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// A config value is honoured only when it is a real non-negative number.
// `Number(null)` is 0, and 0 means OFF here, so a hand-written
// `"dormantAfterMinutes": null` must read as "not set", never as "disable".
function configNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Off is a real, supported answer and it is spelled `0`, matching
// HARBOR_SESSIOND_RECONCILE_INTERVAL_MS one file over. A machine with enough
// RAM, or a run that must not lose a long-idle session, turns it off wholesale
// rather than editing a threshold to something absurd.
//
// TWO SOURCES, ONE ORDER (2026-10-19). The environment outranks Harbor's
// config.json `sessiond` block, which outranks the default: the same
// precedence HARBOR_TASKS_FILE has over `paths.tasksFile`. The config block
// exists because a GUI-launched daemon has no environment anyone can set: the
// CLI start path forwards an allowlist, and on macOS an app opened from the
// Dock inherits launchd's environment, not a shell's. `config` is the parsed
// `sessiond` object (or nothing); the daemon re-reads it every sweep, so an
// edit takes effect within a minute without a daemon handover.
function resolveDormancyPolicy(env = process.env, config = {}) {
  const sessiond = config && typeof config === 'object' ? config : {};
  const configAfterMinutes = configNumber(sessiond.dormantAfterMinutes);
  const afterMs = number(env.HARBOR_SESSIOND_DORMANT_AFTER_MS,
    configAfterMinutes === undefined ? HOUR_MS : configAfterMinutes * 60_000);
  const maxLive = Math.floor(number(env.HARBOR_SESSIOND_MAX_LIVE_SESSIONS,
    configNumber(sessiond.maxLiveSessions) ?? 0));
  return {
    enabled: afterMs > 0,
    afterMs,
    // A session must look idle on TWO consecutive passes before it sleeps, and
    // the CPU delta is measured BETWEEN them. One sample can only ever say
    // "quiet right now"; a delta says "quiet for the whole interval", which is
    // the question actually being asked. Same hysteresis shape as the mute
    // keeper suspects in daemon.js, for the same reason: one observation is
    // not evidence.
    minChecks: Math.max(2, Math.floor(number(env.HARBOR_SESSIOND_DORMANT_MIN_CHECKS, 2))),
    // BUSY IS A RATE, NOT A QUANTITY, and getting that wrong is a silent
    // safety hole rather than a tuning miss. The first version of this compared
    // the CPU delta against a flat 2 seconds, which is meaningless without
    // knowing how long the interval was: at the production 60s sweep a pegged
    // core burns 60s and trips it easily, but at a 400ms sweep the very same
    // pegged core burns only 400ms and reads as IDLE. The two-sided spec caught
    // it immediately by putting a `while :; do :; done` session to sleep. A
    // fraction of elapsed wall time holds at any interval.
    //
    // 5% of one core, MEASURED rather than guessed, on Pat's own 15 live
    // sessions over a 15s window: genuinely idle sessions burned 0.5% to 2.1%
    // of a core (statusline repaints and runtime timers), while sessions
    // actively working burned 12% to 28%. 5% sits in the empty gap between
    // those populations with margin on both sides.
    cpuBusyFraction: number(env.HARBOR_SESSIOND_DORMANT_CPU_BUSY_FRACTION, 0.05),
    // A floor so that a very short interval cannot make the fraction absurdly
    // sensitive (at 400ms, 5% is 20ms, which one GC pause would exceed).
    cpuBusyFloorUsec: number(env.HARBOR_SESSIOND_DORMANT_CPU_BUSY_FLOOR_USEC, 50_000),
    // IDLE IS MEASURED FROM THE USER, NOT FROM THE PTY (2026-10-19). A keeper
    // that stamps `last_input_at` lets the threshold run from the last thing a
    // person typed, because pty output is moved by things that are not work: a
    // CLI redrawing its whole screen when the app reattaches after a daemon
    // handover or a window resize stamps `last_activity_at` on every live
    // session at once. Output still VETOES: a session that drew anything in
    // this window is left alone (a spinner is a working turn). Never longer
    // than the threshold itself, so with input stamps a session can only
    // become eligible sooner, never later, than it did on output alone.
    outputQuietMs: Math.min(afterMs, number(env.HARBOR_SESSIOND_DORMANT_OUTPUT_QUIET_MS, 10 * 60_000)),
    // THE LIVE-SESSION CAP (2026-10-19). Off at 0, the default. When more than
    // `maxLive` sessions are live, the longest-idle-by-input ones beyond the
    // `maxLive` most recent are put to sleep through the same terminate path,
    // under the same vetoes, but at a shorter idle floor than the threshold:
    // a cap that waited for the threshold would only ever repeat the idle
    // sweep. Never a session younger than `capMinAgeMs`.
    maxLive,
    capMinIdleMs: Math.min(afterMs, number(env.HARBOR_SESSIOND_CAP_MIN_IDLE_MS, 30 * 60_000)),
    capMinAgeMs: number(env.HARBOR_SESSIOND_CAP_MIN_AGE_MS, HOUR_MS),
  };
}

// The scope path is READ from the keeper rather than composed, because
// composing it hardcodes the slice layout that session-scope.js owns and would
// answer confidently wrong the moment that layout changes. /proc is the only
// thing that knows where a process actually lives.
//
// A SHARED CGROUP CANNOT ANSWER A PER-SESSION QUESTION, so it is refused rather
// than misread. When `session-scope.js` falls back to the pre-2026-08-09
// behaviour (no systemd, a relocated harness store, a failed probe), every
// session lives in the DAEMON's cgroup, and its cpu.stat is then the sum of all
// of them plus the daemon. Reading it anyway would be wrong in both directions
// at once: one busy session would hold every idle sibling awake, and, far
// worse, the number would be attributed to whichever session was asked about.
// Requiring the session's own scope in the path means dormancy is active
// exactly when containment is, which is the production configuration.
// `requireScope: false` is for tests and for an operator who has decided the
// pty signal alone is enough; it is never the default.
function cgroupCpuUsec(keeperPid, {
  root = '/sys/fs/cgroup', proc = '/proc', sessionId = null, requireScope = true,
} = {}) {
  if (!Number.isInteger(keeperPid) || keeperPid <= 0) return null;
  let rel;
  try {
    const raw = fs.readFileSync(path.join(proc, String(keeperPid), 'cgroup'), 'utf8');
    // cgroup v2 is a single `0::/path` line. A v1 machine has many lines and no
    // unified cpu.stat to read, so returning null (and therefore "busy") is the
    // honest answer rather than parsing a controller path that means something
    // else.
    const line = raw.split('\n').find((l) => l.startsWith('0::'));
    if (!line) return null;
    rel = line.slice(3).trim();
  } catch { return null; }
  if (!rel || !rel.startsWith('/')) return null;
  if (requireScope && !(sessionId && rel.includes(`harbor-session-${sessionId}`))) return null;
  try {
    const stat = fs.readFileSync(path.join(root, rel.replace(/^\//, ''), 'cpu.stat'), 'utf8');
    const match = /^usage_usec\s+(\d+)/m.exec(stat);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

// THE WINDOWS ANSWER TO THE SAME QUESTION (2026-08-20). `cgroupCpuUsec` reads
// /proc, which does not exist on win32, so on Pat's actual machine every read
// answered null, evaluate() honestly called every session busy, and dormancy
// was INERT while the boot log said "dormancy on". The bill arrived all at
// once: 27 claude runtimes plus ~190 private MCP node children held ~39GB of
// an 87GB commit limit, the machine spent the day at the ceiling
// (Resource-Exhaustion-Detector events at 09:41, 14:28 and 17:59), and CLI
// processes died of failed allocations at the exact moment a turn started,
// which Pat experienced as "messages get hung": the prompt reached the
// transcript and the process was dead before the reply.
//
// The per-session scope on Windows is the process TREE under the keeper: the
// keeper is the direct parent of the CLI (verified against a live pane;
// ConPTY does not interpose a parent), and the CLI parents its MCP children.
// One `Win32_Process` snapshot per sweep covers every session, the way one
// cgroupfs covers them all on Linux. UserModeTime/KernelModeTime are
// cumulative 100ns units, so their tree sum is the same monotonic counter
// cpu.stat's usage_usec is; children exiting can make it go DOWN, which
// evaluate() already treats as "counter reset; restarting observation".
//
// A stale ParentProcessId (Windows never reparents, and pids recycle) can
// attach a stranger's subtree to a session's tree. That misreads in the safe
// direction only: extra CPU reads as busy, and a busy verdict never kills.
const WIN_PROCESS_TABLE_COMMAND = ['powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,UserModeTime,KernelModeTime | ConvertTo-Json -Compress',
]];

function parseWinProcessTable(json) {
  let rows;
  try { rows = JSON.parse(json); } catch { return null; }
  // ConvertTo-Json unwraps a single-element result to a bare object.
  if (rows && typeof rows === 'object' && !Array.isArray(rows)) rows = [rows];
  if (!Array.isArray(rows)) return null;
  const table = new Map();
  for (const row of rows) {
    const pid = Number(row?.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const ppid = Number(row.ParentProcessId);
    const user = Number(row.UserModeTime) || 0;
    const kernel = Number(row.KernelModeTime) || 0;
    table.set(pid, { ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0, cpuUsec: (user + kernel) / 10 });
  }
  return table.size ? table : null;
}

// Pure: the snapshot arrives as data. A root that is not in the table means
// the question cannot be answered about THIS session (the keeper died, or the
// snapshot failed), and null is the same honest refusal the unreadable cgroup
// makes: evaluate() reads it as busy.
function winProcessTreeCpuUsec(table, rootPid) {
  if (!(table instanceof Map)) return null;
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !table.has(rootPid)) return null;
  const children = new Map();
  for (const [pid, row] of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(pid);
  }
  let total = 0;
  const queue = [rootPid];
  const seen = new Set(); // recycled pids can make the parent graph cyclic
  while (queue.length) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += table.get(pid).cpuUsec;
    for (const child of children.get(pid) || []) queue.push(child);
  }
  return total;
}

// One process-table read per sweep, never per session. Any failure (PowerShell
// missing, timeout, unparseable output) resolves null rather than throwing,
// because the sweep must survive a broken probe and a null table makes every
// session read busy, which is the safe direction.
function winCpuSnapshot({ execFileImpl = execFile, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const [command, args] = WIN_PROCESS_TABLE_COMMAND;
    execFileImpl(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(null); return; }
      resolve(parseWinProcessTable(String(stdout)));
    });
  });
}

// THE macOS ANSWER, AND THE LINUX ONE WITHOUT A SCOPE (2026-10-19). On darwin
// there is no /proc, so `cgroupCpuUsec` answered null for every session,
// evaluate() honestly called every session busy, and dormancy was inert while
// the boot log said "dormancy on ... (cpu signal: cgroup usage_usec)": the
// win32 incident above, on the third platform. Measured on a Mac the day this
// was written: 97 live Claude sessions, 84 with no user message for 3+ days,
// and not one `dormant` line in the daemon log, ever.
//
// The per-session scope is the same as on Windows, the process tree under the
// keeper, read from ONE `ps -A` per sweep (about 34ms for ~1,800 processes on
// that Mac). The pty child is a session leader (node-pty setsid's it), so the
// session's process GROUP is also counted: a background child that reparented
// to launchd/init but stayed in the group still vouches for its session.
// `time` is cumulative user+system cpu of the process itself, so the tree sum
// is a monotonic counter that can go DOWN when a child exits, which evaluate()
// already reads as "counter reset; restarting observation". Every misread is in
// the safe direction: a stranger's subtree (a recycled pid) only adds cpu, and
// extra cpu reads as busy.
const POSIX_PROCESS_TABLE_COMMAND = ['ps', ['-A', '-o', 'pid=,ppid=,pgid=,time=']];

// `time` is `[[dd-]hh:]mm:ss[.cc]`. macOS prints unbounded minutes with
// centiseconds (`121:07.01`); procps prints `[dd-]hh:mm:ss` (whole seconds).
// Returns microseconds, or null for anything else.
function parsePsCpuTime(text) {
  const match = /^(?:(\d+)-)?(\d+(?::\d+){0,2})(?:\.(\d+))?$/.exec(String(text).trim());
  if (!match) return null;
  const parts = match[2].split(':').map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  seconds += (Number(match[1]) || 0) * 86400;
  const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
  const usec = Math.round((seconds + fraction) * 1_000_000);
  return Number.isFinite(usec) ? usec : null;
}

function parsePosixProcessTable(stdout) {
  const table = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const [pid, ppid, pgid] = fields.slice(0, 3).map(Number);
    const cpuUsec = parsePsCpuTime(fields[3]);
    if (!Number.isInteger(pid) || pid <= 0 || cpuUsec === null) continue;
    table.set(pid, {
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
      pgid: Number.isInteger(pgid) && pgid > 0 ? pgid : 0,
      cpuUsec,
    });
  }
  return table.size ? table : null;
}

// Pure. The keeper-rooted tree plus every process in the session's group (and
// THEIR descendants). A keeper the table has never heard of is the same honest
// refusal as on Windows: null, which evaluate() reads as busy.
function posixProcessTreeCpuUsec(table, rootPid, { groupPid = null } = {}) {
  if (!(table instanceof Map)) return null;
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !table.has(rootPid)) return null;
  const children = new Map();
  const queue = [rootPid];
  for (const [pid, row] of table) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(pid);
    if (Number.isInteger(groupPid) && groupPid > 1 && row.pgid === groupPid) queue.push(pid);
  }
  let total = 0;
  const seen = new Set();
  while (queue.length) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += table.get(pid).cpuUsec;
    for (const child of children.get(pid) || []) queue.push(child);
  }
  return total;
}

// One `ps` per sweep. Any failure resolves null (every session reads busy).
function posixCpuSnapshot({ execFileImpl = execFile, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const [command, args] = POSIX_PROCESS_TABLE_COMMAND;
    execFileImpl(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(null); return; }
      resolve(parsePosixProcessTable(String(stdout)));
    });
  });
}

// When did a person last touch this session? `last_input_at` when the keeper
// stamps it (keepers from 2026-10-19 on), else the pty stamp, which is all an
// older keeper has. NaN when neither exists.
function lastTouchedAt(state) {
  const input = Date.parse(state?.last_input_at || '');
  return Number.isFinite(input) ? input : Date.parse(state?.last_activity_at || '');
}

// The cpu half of the decision, shared by the idle sweep and the cap. `checks`
// is the caller's consecutive-quiet counter; the result says what to store.
function cpuQuiet({ now, policy, previous, cpuUsec, checks }) {
  // Unreadable cgroup = treated as busy. See the header: a wrong sleep costs
  // work, a missed sleep costs memory, and those are not the same price.
  if (cpuUsec === null || cpuUsec === undefined) {
    return { quiet: false, code: 'cpu-unreadable', reason: 'cpu usage unreadable; treating as busy', checks: 0 };
  }
  const priorCpu = previous?.cpuUsec;
  const priorAt = previous?.at;
  if (priorCpu === null || priorCpu === undefined || !Number.isFinite(priorAt)) {
    return { quiet: false, code: 'measuring', reason: 'first idle observation; measuring cpu over the next interval', checks: 0 };
  }
  // A cgroup that was recreated (or a counter that went backwards, which should
  // be impossible and therefore must be handled) restarts the observation
  // rather than reading a negative delta as deep idleness.
  const deltaUsec = cpuUsec - priorCpu;
  if (deltaUsec < 0) return { quiet: false, code: 'measuring', reason: 'cpu counter reset; restarting observation', checks: 0 };
  // A zero or backwards wall interval (two sweeps in the same millisecond, a
  // clock adjustment) can prove nothing about a RATE, so it measures again
  // instead of dividing by zero and calling the answer idle.
  const wallUsec = (now - priorAt) * 1000;
  if (wallUsec <= 0) return { quiet: false, code: 'measuring', reason: 'no elapsed time to measure cpu over; restarting observation', checks: 0 };
  const busyUsec = Math.max(policy.cpuBusyFloorUsec, wallUsec * policy.cpuBusyFraction);
  if (deltaUsec > busyUsec) {
    // Busy resets the counter to zero rather than merely not incrementing it.
    // A session that alternates quiet and busy intervals must never creep to
    // the threshold one stray quiet pass at a time.
    return {
      quiet: false,
      code: 'busy',
      checks: 0,
      reason: `burning cpu in the background (${Math.round(deltaUsec / 1000)}ms of cpu in ${Math.round(wallUsec / 1000)}ms)`,
    };
  }
  const next = (checks || 0) + 1;
  if (next < policy.minChecks) {
    return { quiet: false, code: 'measuring', reason: `idle observation ${next}/${policy.minChecks}`, checks: next };
  }
  return { quiet: true, code: 'quiet', reason: 'quiet', checks: next };
}

// Pure, so the whole decision is testable without a cgroup, a keeper or a
// clock. Everything impure (reading /proc, reading the state file) is resolved
// by the caller and handed in.
//
// Returns { sleep, reason, idleMs, idleChecks }. `idleChecks` is what the
// caller must store for the next pass: it is returned rather than mutated so
// this function stays pure and the caller owns all the state, which is what
// makes the whole decision testable with a plain object and a fake clock.
function evaluate(state, { now, policy, previous, cpuUsec }) {
  if (!policy.enabled) return { sleep: false, code: 'disabled', reason: 'dormancy disabled', idleMs: 0, idleChecks: 0 };
  if (state.exit) return { sleep: false, code: 'exited', reason: 'already exited', idleMs: 0, idleChecks: 0 };

  // A state file written before this feature existed has no activity stamp, and
  // a session running under an OLD keeper never grows one. Falling back to
  // created_at would put every one of those to sleep an hour after the daemon
  // came up, no matter how busy, which is the single worst thing this file
  // could do on the day it ships. No stamp means no opinion.
  const outputAt = Date.parse(state.last_activity_at || '');
  if (!Number.isFinite(outputAt)) {
    return { sleep: false, code: 'no-stamp', reason: 'no activity stamp (pre-dormancy keeper)', idleMs: 0, idleChecks: 0 };
  }

  const idleMs = now - lastTouchedAt(state);
  if (!(idleMs >= policy.afterMs)) return { sleep: false, code: 'active', reason: 'active', idleMs, idleChecks: 0 };
  // Input-idle long enough, but the pty drew something recently: a working
  // turn animates a spinner, so recent output keeps the session awake. (With no
  // input stamp, idle IS output idle and this cannot trip.)
  if (now - outputAt < policy.outputQuietMs) {
    return { sleep: false, code: 'output-recent', reason: 'pty output in the last few minutes', idleMs, idleChecks: 0 };
  }

  const cpu = cpuQuiet({ now, policy, previous, cpuUsec, checks: previous?.idleChecks });
  if (!cpu.quiet) return { sleep: false, code: cpu.code, reason: cpu.reason, idleMs, idleChecks: cpu.checks };

  return {
    sleep: true,
    code: 'idle',
    idleMs,
    idleChecks: cpu.checks,
    reason: `idle for ${Math.round(idleMs / 60000)}m with no cpu; put to sleep to free memory. Resume it from the rail.`,
  };
}

// Could the live-session cap put this session to sleep? The same evidence as
// evaluate(), at the cap's shorter idle floor, plus an age floor: a session
// opened in the last hour is never the one evicted. Pure, with its own
// consecutive-quiet counter (`capChecks`) so the two decisions never share
// hysteresis state. Whether the cap is exceeded, and which sessions are
// protected as the most recent, is the sweep's business, not this function's.
function evaluateCap(state, { now, policy, previous, cpuUsec }) {
  const no = (code, reason, idleMs = 0, capChecks = 0) => ({ eligible: false, code, reason, idleMs, capChecks });
  if (!policy.enabled || !(policy.maxLive > 0)) return no('disabled', 'live-session cap off');
  if (state.exit) return no('exited', 'already exited');
  const outputAt = Date.parse(state.last_activity_at || '');
  if (!Number.isFinite(outputAt)) return no('no-stamp', 'no activity stamp (pre-dormancy keeper)');
  const createdAt = Date.parse(state.created_at || '');
  if (!Number.isFinite(createdAt) || now - createdAt < policy.capMinAgeMs) {
    return no('too-new', 'opened too recently to be evicted by the cap');
  }
  const idleMs = now - lastTouchedAt(state);
  if (!(idleMs >= policy.capMinIdleMs)) return no('active', 'active', idleMs);
  if (now - outputAt < policy.outputQuietMs) return no('output-recent', 'pty output in the last few minutes', idleMs);
  const cpu = cpuQuiet({ now, policy, previous, cpuUsec, checks: previous?.capChecks });
  if (!cpu.quiet) return no(cpu.code, cpu.reason, idleMs, cpu.checks);
  return { eligible: true, code: 'eligible', reason: 'idle with no cpu', idleMs, capChecks: cpu.checks };
}

// A TOUCHED FILE IS NOT A WRITTEN FILE (2026-08-25).
//
// The transcript-freshness veto below is the third fact the sweep consults, and
// for its whole life it asked the question with `fs.statSync().mtimeMs`. Measured
// on Pat's box the afternoon this was written: 41 live sessions, 34 of them held
// open by an mtime reading 29 minutes old while the newest RECORD in that same
// file was up to 4,546 minutes (3.2 days) old. Something on this machine
// refreshes those mtimes in synchronized sub-second bursts across every
// transcript at once without appending a byte (caught live: mtime moved, size
// delta exactly 0). The veto believed it every time: 27,364 vetoes against 32
// successful sleeps for the life of the feature.
//
// The bill was precisely the one dormancy exists to prevent, arriving through
// dormancy's own safety valve: 41 claude runtimes plus their MCP children at
// 99.1% of a 160G commit limit with 2.8G of 63G physical free, and 5.48 BILLION
// cache-read tokens across 48 hours as forty oversized contexts stayed resident
// and re-read ~323k tokens on every call.
//
// WHAT DOES THE TOUCHING: the Claude Code CLI itself, and only for sessions
// that are still LIVE. It appends a family of TIMESTAMPLESS bookkeeping records
// to its own transcript - `bridge-session` (carrying a `bridgeSessionId` of the
// form cse_..., the session-bridge registration being refreshed against the
// server), plus `last-prompt`, `mode`, `permission-mode` and `ai-title`. One
// idle session's transcript held 87 bridge-session and 87 last-prompt records.
// Identified by elimination and then by capture: Harbor opens every transcript
// 'r' and never writes one, the config sync touches nothing, no scheduled task
// fires on that cadence, the file is modified in place (the file index never
// changes, so it is not an atomic rewrite), no process holds a transcript open
// (asked via the Restart Manager), and DORMANT and historical transcripts are
// never touched at all while live ones always are. The appended records were
// finally read straight off two sessions mid-write.
//
// So the touch is real, it is benign, and it is permanent: it is the CLI
// keeping house, not the session doing work. An inode timestamp is metadata
// about a file; the question being asked is whether WORK HAPPENED, and only a
// timestamped record answers that - which is exactly what these records lack,
// so they move the inode clock and nothing else. The backward scan therefore
// steps OVER an untimestamped record rather than reading the file as freshly
// written because one arrived. mtime keeps the job it can do honestly - it is the
// cheap NECESSARY condition, since nothing touches a file backwards, so an old
// mtime really does mean old and costs one stat - and a fresh mtime now only
// earns the bounded tail read that actually decides it. The read is paid at
// most once per sweep for a session both cheap signals have already condemned.
const FRESHNESS_TAIL_STEPS = [64 * 1024, 1024 * 1024, 8 * 1024 * 1024];

// Scans BACKWARD from the end for the newest record carrying a parseable
// timestamp, in growing bites. Records without one (`permission-mode`, and the
// other bookkeeping shapes the CLI writes) are skipped rather than trusted, and
// so is the one line every chunk boundary cuts in half. The steps grow because
// a single record can be enormous: a pasted screenshot rides the JSONL as
// base64 and a real measured opening line was 1,109,121 bytes, so a fixed small
// tail could contain no complete record at all.
function lastRecordAtMs(file, { size = null, steps = FRESHNESS_TAIL_STEPS } = {}) {
  let total = size;
  if (total === null) {
    try { total = fs.statSync(file).size; } catch { return null; }
  }
  if (!Number.isFinite(total) || total <= 0) return null;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    for (const step of steps) {
      const length = Math.min(total, step);
      const buf = Buffer.alloc(length);
      try { fs.readSync(fd, buf, 0, length, total - length); } catch { return null; }
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        const at = Date.parse(record?.timestamp || '');
        if (Number.isFinite(at)) return at;
      }
      if (length >= total) break; // the whole file has been read; no timestamp exists
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
  return null;
}

// A file that cannot be judged returns TRUE (fresh, therefore left alone). That
// is the same asymmetry that governs every other refusal in this file: a wrong
// sleep costs work, a missed sleep costs memory, and those are not the same
// price. An absent file is not evidence of work and is simply false.
function transcriptWrittenWithin(file, { freshMs, now }) {
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (now - stat.mtimeMs >= freshMs) return false;
  const at = lastRecordAtMs(file, { size: stat.size });
  if (at === null) return true;
  return now - at < freshMs;
}

// The session's own transcript, then its subagents'. Extracted here from
// daemon.js so the rule is REACHABLE BY A TEST: every existing dormancy spec
// stubs `workFresh` wholesale, which is exactly how a veto that fired 27,364
// times in a row shipped and stayed shipped.
function transcriptTreeFresh({ projectDir, agentSession, freshMs, now }) {
  if (!projectDir || !agentSession) return false;
  if (transcriptWrittenWithin(path.join(projectDir, `${agentSession}.jsonl`), { freshMs, now })) return true;
  const subagents = path.join(projectDir, agentSession, 'subagents');
  let names;
  try { names = fs.readdirSync(subagents); } catch { return false; }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    if (transcriptWrittenWithin(path.join(subagents, name), { freshMs, now })) return true;
  }
  return false;
}

// A SESSION WAITING FOR PAT IS NOT AN IDLE SESSION, AND IT LOOKS EXACTLY LIKE
// ONE (2026-08-09, adversarial review, then measured).
//
// The two signals this file is built on, pty silence and flat CPU, have a
// blind spot they share: a session parked on a permission prompt, an
// AskUserQuestion, or the folder-trust dialog draws its screen ONCE and then
// does nothing at all. Measured on a real claude session sitting at the trust
// dialog: `last_activity_at` did not move for 90 seconds, and would not have
// moved for an hour. Nothing in the two-signal test could tell that apart from
// abandonment, so the sweep would have SIGTERMed a session at the exact moment
// its user came back to answer it, losing the in-flight tool call it was
// asking permission for. That is a routine pattern (open a prompt, go to a
// meeting), not an edge case.
//
// So the screen is consulted as a THIRD signal, and it is a veto rather than a
// vote: anything that looks like it is waiting for a human keeps the session
// alive. The markers are deliberately BROAD and the failure direction is
// deliberately asymmetric. A false positive costs some memory that stays held
// for another hour; a false negative costs Pat's work. Those are not the same
// price, which is the same reasoning that makes an unreadable cgroup mean
// "busy" further up this file.
//
// This is a self-contained matcher rather than a call into Harbor's richer
// `parseMenu`/`classifyBlocked`, because `src/daemon/` is a separate
// dependency root that runs under the system node and must not reach into
// `src/main/`. It is checked against the SAME real captured screens those
// parsers are tested with, so the two cannot silently disagree about what a
// dialog looks like.
const ANSWER_MARKERS = [
  /\besc to cancel\b/i,          // permission prompts, select menus
  /\benter to (confirm|select)\b/i,
  /\btab to amend\b/i,
  /\bctrl\+e to explain\b/i,
  /↑\/↓ to navigate/i,
  /\bto toggle\b.*\benter\b/i,   // multi-select
  /^\s*❯\s*\d+\./m,              // the pointer sitting on a numbered option
  // AN INDENTED POINTER IS A DIALOG; A POINTER AT COLUMN 0 IS THE COMPOSER.
  // This is Harbor's own discriminator (see `isComposerLine` in
  // src/main/menu-parse.js and the composer-vs-dialog fixtures), and it is
  // what catches the `/rewind` dialog, whose selected row is a bare
  // `  ❯ (current)`: no number and no chrome, so every other marker here
  // misses it while it very much needs an answer. An idle composer draws
  // `❯ my draft text` hard against the left edge under a full-width divider,
  // so the indent alone separates them.
  /^[ \t]+❯/m,
  /^\s*\d+\.\s+(Yes|No)\b/m,     // the trust dialog and its kin
  /\bDo you want to\b/i,
  /Resuming the full session will consume/i,
];

// Captured from cursor-agent --force in a relocated-store, GUI-subsystem
// harness. These are provider-specific because their wording is Cursor's
// contract; broad shared dialog chrome remains above.
const PROVIDER_ANSWER_MARKERS = {
  codex: [
    /Do you trust the contents of this directory/i,
    /Yes, continue/i,
    /Press enter to continue and create a sandbox/i,
  ],
  cursor: [
    /Workspace Trust Required/i,
    /Do you trust the contents/i,
    /Trust this workspace/i,
  ],
};

function awaitingAnswer(screenText, agent = null) {
  if (typeof screenText !== 'string' || !screenText.trim()) return false;
  // Only the tail is considered: an ANSWERED dialog scrolls up and stays in the
  // buffer, and matching it there would keep a genuinely idle session alive
  // forever. The live prompt, if there is one, is at the bottom.
  const tail = screenText.split('\n').slice(-25).join('\n');
  return [...ANSWER_MARKERS, ...(PROVIDER_ANSWER_MARKERS[agent] || [])].some((re) => re.test(tail));
}

const providerTranscriptPathCache = new Map();
const cursorTranscriptObservations = new Map();

async function findProviderTranscript(sessionId, roots) {
  const suffix = `${sessionId}.jsonl`.toLowerCase();
  const cacheKey = `${(roots || []).join('\0')}\0${suffix}`;
  const cached = providerTranscriptPathCache.get(cacheKey);
  if (cached) {
    try { await fsp.access(cached); return cached; } catch { providerTranscriptPathCache.delete(cacheKey); }
  }
  const visit = async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) return file;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = await visit(path.join(dir, entry.name)).catch(() => null);
      if (found) return found;
    }
    return null;
  };
  for (const root of roots || []) {
    const found = await visit(root).catch(() => null);
    if (found) { providerTranscriptPathCache.set(cacheKey, found); return found; }
  }
  throw new Error(`provider transcript not found for ${sessionId}`);
}

// Read from the tail in the byte domain. The first line in a Codex rollout is
// unbounded, but the newest complete record is at the other end; expanding
// backwards avoids both the old fixed-head truncation and whole-file reads.
async function newestCompleteRecord(file, { chunkBytes = 64 * 1024, maxBytes = 8 * 1024 * 1024 } = {}) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    let start = stat.size;
    let tail = Buffer.alloc(0);
    while (start > 0 && tail.length < maxBytes) {
      const size = Math.min(chunkBytes, start, maxBytes - tail.length);
      start -= size;
      const chunk = Buffer.alloc(size);
      const { bytesRead } = await handle.read(chunk, 0, size, start);
      tail = Buffer.concat([chunk.subarray(0, bytesRead), tail]);
      const lines = tail.toString('utf8').split(/\r?\n/);
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].trim()) continue;
        try { return { record: JSON.parse(lines[i]), offset: start, text: lines[i] }; } catch {}
      }
    }
  } finally {
    await handle.close();
  }
  throw new Error(`provider transcript has no complete JSON record: ${file}`);
}

async function newestTimestampedRecord(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    let start = stat.size;
    let tail = Buffer.alloc(0);
    const maxBytes = 8 * 1024 * 1024;
    while (start > 0 && tail.length < maxBytes) {
      const size = Math.min(64 * 1024, start, maxBytes - tail.length);
      start -= size;
      const chunk = Buffer.alloc(size);
      const { bytesRead } = await handle.read(chunk, 0, size, start);
      tail = Buffer.concat([chunk.subarray(0, bytesRead), tail]);
      const lines = tail.toString('utf8').split(/\r?\n/);
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].trim()) continue;
        try {
          const record = JSON.parse(lines[i]);
          const timestamp = Date.parse(record?.timestamp || '');
          if (Number.isFinite(timestamp)) return { record, timestamp, text: lines[i] };
        } catch {}
      }
    }
  } finally {
    await handle.close();
  }
  throw new Error(`provider transcript has no timestamped JSON record: ${file}`);
}

async function codexTranscriptFresh({ sessionId, roots, now = Date.now(), freshMs }) {
  if (!sessionId) throw new Error('codex session identity is unresolved');
  const file = await findProviderTranscript(sessionId, roots);
  const { timestamp } = await newestTimestampedRecord(file);
  return now - timestamp < freshMs;
}

async function cursorTranscriptFresh({ sessionId, roots, now = Date.now(), freshMs, observation }) {
  if (!sessionId) throw new Error('cursor session identity is unresolved');
  if (!(observation instanceof Map)) throw new Error('cursor freshness requires an observation map');
  const file = await findProviderTranscript(sessionId, roots);
  let stamped = null;
  try { stamped = await newestTimestampedRecord(file); } catch { /* current Cursor records commonly have no timestamp */ }
  if (stamped) return now - stamped.timestamp < freshMs;
  const latest = await newestCompleteRecord(file);
  const signature = createHash('sha256').update(latest.text).digest('hex');
  const previous = observation.get(sessionId);
  if (!previous || previous.signature !== signature) {
    observation.set(sessionId, { signature, observedAt: now });
    return true;
  }
  return now - previous.observedAt < freshMs;
}

async function providerTranscriptFresh(state, options = {}) {
  const agent = state?.agent === 'cursor-agent' ? 'cursor' : state?.agent;
  if (!['codex', 'cursor'].includes(agent)) return false;
  const common = {
    sessionId: state.agent_session,
    now: options.now ?? Date.now(),
    freshMs: options.freshMs,
  };
  if (!Number.isFinite(common.freshMs) || common.freshMs < 0) throw new Error('provider freshness requires freshMs');
  return agent === 'codex'
    ? codexTranscriptFresh({ ...common, roots: options.codexRoots || options.roots || [] })
    : cursorTranscriptFresh({
      ...common,
      roots: options.cursorRoots || options.roots || [],
      observation: options.observation || cursorTranscriptObservations,
    });
}

// The sweep lives HERE rather than in daemon.js so that it can be driven with
// fakes. Every impure thing it needs (which sessions exist, what time it is,
// how to read cpu, how to end a session, where to log) arrives as a dependency,
// which is what makes the two-sided proof possible: the case that MUST NOT
// happen (a background-busy session being put to sleep) cannot be demonstrated
// against a real cgroup without a real runaway process, and a test that needs a
// runaway process to prove a safety property will not be run.
//
// `terminate` is expected to reject when the keeper will not answer. That is
// deliberately NOT escalated here: `reconcileStaleSessions` owns killing
// keepers, it has the hysteresis and the verified-dead requirement, and a
// second place that kills keepers is a second place that can kill a live one.
// The last word a sweep logged, per watch map, so an unchanged minute after
// minute does not write the same summary line 1,440 times a day.
const lastSweepSummary = new WeakMap();

function countsText(counts) {
  return Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
}

async function sweepDormancy({ states, now, policy, watch, readCpu, readScreen, terminate, log, workFresh = null }) {
  if (!policy.enabled) return 0;
  const seen = new Set();
  const slept = new Set();
  const kept = {};
  const keep = (code) => { kept[code] = (kept[code] || 0) + 1; };
  const capOn = policy.maxLive > 0;
  const capVerdicts = new Map();
  let idleSlept = 0;
  let capSlept = 0;

  // The two expensive vetoes, shared by the idle sweep and the cap. Returns a
  // code naming why the session must be left alone, or null to proceed. Both
  // fail CLOSED: an unreadable answer keeps the session.
  const vetoed = async (state, { freshMs, quiet }) => {
    // A SESSION HOLDING FOR ITS OWN BACKGROUND WORK IS NOT IDLE (2026-08-21).
    // A session that spawned subagent reviewers and ended its turn to wait
    // sits at a silent composer with near-zero local cpu while the agents'
    // transcripts grow on disk; the two cheap signals both call that
    // abandoned. The freshness of the session's own transcript tree is the
    // third fact, supplied by the caller (the daemon resolves the paths),
    // and like the screen it is a VETO, never a vote: fresh work keeps the
    // session alive, and an unreadable answer refuses the kill.
    if (workFresh) {
      let fresh = false;
      try {
        fresh = await workFresh(state, freshMs);
      } catch (error) {
        if (!quiet) log(`could not read ${state.id}'s transcript freshness; leaving it alone: ${error.message}`);
        return 'freshness-unreadable';
      }
      if (fresh) {
        if (!quiet) log(`${state.id} is pty-idle but its transcript or subagents are fresh; leaving it alone`);
        return 'transcript-fresh';
      }
    }
    // THE LAST CHECK BEFORE THE KILL, and deliberately the most expensive one:
    // it costs a round trip to the keeper, so it is paid only for a session
    // already condemned by both cheap signals, at most once per sweep.
    if (readScreen) {
      let screen = null;
      try {
        screen = await readScreen(state);
      } catch (error) {
        // A keeper that will not answer is not a session to put down on a
        // guess; reconciliation owns that case.
        if (!quiet) log(`could not read ${state.id}'s screen; leaving it alone: ${error.message}`);
        return 'screen-unreadable';
      }
      if (awaitingAnswer(screen, state.agent)) {
        if (!quiet) log(`${state.id} is idle but showing something that needs an answer; leaving it alone`);
        return 'needs-answer';
      }
    }
    return null;
  };

  const end = async (state, verdict) => {
    try {
      await terminate(state, verdict);
      watch.delete(state.id);
      slept.add(state.id);
      log(`dormant ${state.id}: ${verdict.reason}`);
      return true;
    } catch (error) {
      log(`could not put ${state.id} to sleep (leaving it to reconciliation): ${error.message}`);
      keep('terminate-failed');
      return false;
    }
  };

  for (const state of states) {
    if (state.exit) continue;
    seen.add(state.id);
    const cpuUsec = readCpu(state);
    const previous = watch.get(state.id);
    const verdict = evaluate(state, { now, policy, previous, cpuUsec });
    const cap = capOn ? evaluateCap(state, { now, policy, previous, cpuUsec }) : null;
    if (cap) capVerdicts.set(state.id, cap);
    // `at` is stored with the sample because the busy test is a RATE: without
    // the timestamp of the previous reading there is no interval to divide by.
    const sample = { cpuUsec, at: now, idleChecks: verdict.idleChecks, ...(cap ? { capChecks: cap.capChecks } : {}) };
    watch.set(state.id, sample);
    if (!verdict.sleep) { keep(verdict.code); continue; }

    const veto = await vetoed(state, { freshMs: policy.afterMs, quiet: false });
    if (veto) {
      watch.set(state.id, { ...sample, idleChecks: 0 });
      keep(veto);
      continue;
    }
    if (await end(state, verdict)) idleSlept += 1;
  }

  // THE LIVE-SESSION CAP. Ranked by when a person last touched each session;
  // the `maxLive` most recent are never candidates, and a session with no
  // stamp at all ranks as most recent (no evidence is never grounds to evict).
  // Candidates are visited oldest first and each must pass the same evidence
  // and the same vetoes as an idle sleep, at the cap's shorter floor, so the
  // cap can leave the machine OVER its limit when every surplus session is
  // genuinely in use. That is the intended outcome: a cap that ended working
  // sessions to hit a number would be the bug this file exists to avoid.
  let capLine = '';
  if (capOn) {
    const live = states.filter((s) => !s.exit && !slept.has(s.id));
    let excess = live.length - policy.maxLive;
    if (excess > 0) {
      const rank = (s) => { const at = lastTouchedAt(s); return Number.isFinite(at) ? at : Infinity; };
      const ordered = [...live].sort((a, b) => rank(b) - rank(a));
      const candidates = ordered.slice(policy.maxLive).reverse();
      const capKept = {};
      const capKeep = (code) => { capKept[code] = (capKept[code] || 0) + 1; };
      const over = excess;
      for (const state of candidates) {
        if (excess <= 0) break;
        const cap = capVerdicts.get(state.id);
        if (!cap?.eligible) { capKeep(cap?.code || 'unknown'); continue; }
        const veto = await vetoed(state, { freshMs: policy.capMinIdleMs, quiet: true });
        if (veto) {
          const sample = watch.get(state.id);
          if (sample) watch.set(state.id, { ...sample, capChecks: 0 });
          capKeep(veto);
          continue;
        }
        const reason = `over the live-session cap (${live.length} live, cap ${policy.maxLive}); idle for ${Math.round(cap.idleMs / 60000)}m with no cpu; put to sleep to free memory. Resume it from the rail.`;
        if (await end(state, { sleep: true, code: 'cap', reason, idleMs: cap.idleMs })) { capSlept += 1; excess -= 1; }
      }
      const capKeptText = countsText(capKept);
      capLine = ` cap=${policy.maxLive} over=${over} still_over=${Math.max(0, excess)}${capKeptText ? ` cap_kept: ${capKeptText}` : ''}`;
    }
  }

  for (const id of [...watch.keys()]) if (!seen.has(id)) watch.delete(id);

  // ONE COMPACT LINE PER SWEEP, counts and reason codes only (never screen or
  // prompt text), written when something slept or the picture changed. "Why
  // is nothing ever sleeping" was unanswerable from the log for the whole
  // life of the macOS bug; this line answers it (`cpu-unreadable=97`).
  const keptText = countsText(kept);
  const summary = `dormancy sweep: live=${seen.size} slept=${slept.size} (idle=${idleSlept} cap=${capSlept})${keptText ? ` kept: ${keptText}` : ''}${capLine}`;
  if (slept.size > 0 || lastSweepSummary.get(watch) !== summary) {
    lastSweepSummary.set(watch, summary);
    log(summary);
  }
  return slept.size;
}

module.exports = {
  resolveDormancyPolicy, evaluate, evaluateCap, lastTouchedAt, cgroupCpuUsec, awaitingAnswer, sweepDormancy, HOUR_MS,
  parseWinProcessTable, winProcessTreeCpuUsec, winCpuSnapshot,
  parsePsCpuTime, parsePosixProcessTable, posixProcessTreeCpuUsec, posixCpuSnapshot,
  lastRecordAtMs, transcriptWrittenWithin, transcriptTreeFresh,
  findProviderTranscript, newestCompleteRecord, codexTranscriptFresh, cursorTranscriptFresh,
  providerTranscriptFresh, PROVIDER_ANSWER_MARKERS,
};
