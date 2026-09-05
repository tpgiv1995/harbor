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

// Off is a real, supported answer and it is spelled `0`, matching
// HARBOR_SESSIOND_RECONCILE_INTERVAL_MS one file over. A machine with enough
// RAM, or a run that must not lose a long-idle session, turns it off wholesale
// rather than editing a threshold to something absurd.
function resolveDormancyPolicy(env = process.env) {
  const afterMs = number(env.HARBOR_SESSIOND_DORMANT_AFTER_MS, HOUR_MS);
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

// Pure, so the whole decision is testable without a cgroup, a keeper or a
// clock. Everything impure (reading /proc, reading the state file) is resolved
// by the caller and handed in.
//
// Returns { sleep, reason, idleMs, idleChecks }. `idleChecks` is what the
// caller must store for the next pass: it is returned rather than mutated so
// this function stays pure and the caller owns all the state, which is what
// makes the whole decision testable with a plain object and a fake clock.
function evaluate(state, { now, policy, previous, cpuUsec }) {
  if (!policy.enabled) return { sleep: false, reason: 'dormancy disabled', idleMs: 0, idleChecks: 0 };
  if (state.exit) return { sleep: false, reason: 'already exited', idleMs: 0, idleChecks: 0 };

  // A state file written before this feature existed has no activity stamp, and
  // a session running under an OLD keeper never grows one. Falling back to
  // created_at would put every one of those to sleep an hour after the daemon
  // came up, no matter how busy, which is the single worst thing this file
  // could do on the day it ships. No stamp means no opinion.
  const stampedAt = Date.parse(state.last_activity_at || '');
  if (!Number.isFinite(stampedAt)) {
    return { sleep: false, reason: 'no activity stamp (pre-dormancy keeper)', idleMs: 0, idleChecks: 0 };
  }

  const idleMs = now - stampedAt;
  if (idleMs < policy.afterMs) return { sleep: false, reason: 'active', idleMs, idleChecks: 0 };

  // Unreadable cgroup = treated as busy. See the header: a wrong sleep costs
  // work, a missed sleep costs memory, and those are not the same price.
  if (cpuUsec === null || cpuUsec === undefined) {
    return { sleep: false, reason: 'cpu usage unreadable; treating as busy', idleMs, idleChecks: 0 };
  }

  const priorCpu = previous?.cpuUsec;
  const priorAt = previous?.at;
  if (priorCpu === null || priorCpu === undefined || !Number.isFinite(priorAt)) {
    return { sleep: false, reason: 'first idle observation; measuring cpu over the next interval', idleMs, idleChecks: 0 };
  }
  // A cgroup that was recreated (or a counter that went backwards, which should
  // be impossible and therefore must be handled) restarts the observation
  // rather than reading a negative delta as deep idleness.
  const deltaUsec = cpuUsec - priorCpu;
  if (deltaUsec < 0) return { sleep: false, reason: 'cpu counter reset; restarting observation', idleMs, idleChecks: 0 };
  // A zero or backwards wall interval (two sweeps in the same millisecond, a
  // clock adjustment) can prove nothing about a RATE, so it measures again
  // instead of dividing by zero and calling the answer idle.
  const wallUsec = (now - priorAt) * 1000;
  if (wallUsec <= 0) return { sleep: false, reason: 'no elapsed time to measure cpu over; restarting observation', idleMs, idleChecks: 0 };
  const busyUsec = Math.max(policy.cpuBusyFloorUsec, wallUsec * policy.cpuBusyFraction);
  if (deltaUsec > busyUsec) {
    return {
      sleep: false,
      idleMs,
      // Busy resets the counter to zero rather than merely not incrementing it.
      // A session that alternates quiet and busy intervals must never creep to
      // the threshold one stray quiet pass at a time.
      idleChecks: 0,
      reason: `burning cpu in the background (${Math.round(deltaUsec / 1000)}ms of cpu in ${Math.round(wallUsec / 1000)}ms)`,
    };
  }

  const checks = (previous?.idleChecks || 0) + 1;
  if (checks < policy.minChecks) {
    return { sleep: false, reason: `idle observation ${checks}/${policy.minChecks}`, idleMs, idleChecks: checks };
  }

  return {
    sleep: true,
    idleMs,
    idleChecks: checks,
    reason: `idle for ${Math.round(idleMs / 60000)}m with no cpu; put to sleep to free memory. Resume it from the rail.`,
  };
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
async function sweepDormancy({ states, now, policy, watch, readCpu, readScreen, terminate, log, workFresh = null }) {
  if (!policy.enabled) return 0;
  const seen = new Set();
  let slept = 0;
  for (const state of states) {
    if (state.exit) continue;
    seen.add(state.id);
    const cpuUsec = readCpu(state);
    const verdict = evaluate(state, { now, policy, previous: watch.get(state.id), cpuUsec });
    // `at` is stored with the sample because the busy test is a RATE: without
    // the timestamp of the previous reading there is no interval to divide by.
    watch.set(state.id, { cpuUsec, at: now, idleChecks: verdict.idleChecks });
    if (!verdict.sleep) continue;

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
        fresh = await workFresh(state);
      } catch (error) {
        log(`could not read ${state.id}'s transcript freshness; leaving it alone: ${error.message}`);
        watch.set(state.id, { cpuUsec, at: now, idleChecks: 0 });
        continue;
      }
      if (fresh) {
        log(`${state.id} is pty-idle but its transcript or subagents are fresh; leaving it alone`);
        watch.set(state.id, { cpuUsec, at: now, idleChecks: 0 });
        continue;
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
        log(`could not read ${state.id}'s screen; leaving it alone: ${error.message}`);
        watch.set(state.id, { cpuUsec, at: now, idleChecks: 0 });
        continue;
      }
      if (awaitingAnswer(screen, state.agent)) {
        log(`${state.id} is idle but showing something that needs an answer; leaving it alone`);
        watch.set(state.id, { cpuUsec, at: now, idleChecks: 0 });
        continue;
      }
    }

    try {
      await terminate(state, verdict);
      watch.delete(state.id);
      slept += 1;
      log(`dormant ${state.id}: ${verdict.reason}`);
    } catch (error) {
      log(`could not put ${state.id} to sleep (leaving it to reconciliation): ${error.message}`);
    }
  }
  for (const id of [...watch.keys()]) if (!seen.has(id)) watch.delete(id);
  return slept;
}

module.exports = {
  resolveDormancyPolicy, evaluate, cgroupCpuUsec, awaitingAnswer, sweepDormancy, HOUR_MS,
  parseWinProcessTable, winProcessTreeCpuUsec, winCpuSnapshot,
  findProviderTranscript, newestCompleteRecord, codexTranscriptFresh, cursorTranscriptFresh,
  providerTranscriptFresh, PROVIDER_ANSWER_MARKERS,
};
