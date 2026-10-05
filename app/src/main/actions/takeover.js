'use strict';

const path = require('node:path');

// Read by a human in the status bar, so it says what to DO, not only what
// failed: the common shape is a session running somewhere Harbor cannot see a
// statusline tee for (the Claude desktop app, a machine before the tee
// existed), and "cannot identify the owning process" alone told Pat nothing
// (2026-08-12). Tests match on the leading clause; keep it stable.
const OWNER_UNKNOWN = 'cannot identify the owning process'
  + ' — this session has no statusline tee, so Harbor will not kill or double-write it;'
  + ' reply where it is running, or wait for it to go idle';

function isGoneError(error) {
  return error?.code === 'ESRCH' || error?.code === 'ENOENT';
}

function createSessionOperationGate() {
  const inFlight = new Map();
  return {
    run(sessionId, operation) {
      const existing = inFlight.get(sessionId);
      if (existing) return existing;
      const pending = Promise.resolve().then(operation);
      inFlight.set(sessionId, pending);
      pending.finally(() => {
        if (inFlight.get(sessionId) === pending) inFlight.delete(sessionId);
      }).catch(() => {});
      return pending;
    },
  };
}

function startResumeFollowup({ sessionId, run, emitStatus }) {
  return Promise.resolve()
    .then(run)
    .catch((error) => {
      emitStatus({
        sessionId,
        phase: 'error',
        detail: String(error?.message || error),
      });
    });
}

// Decides whether the process the statusline tee names still holds this
// session. Deliberately SEPARATE from the kill below, and deliberately
// non-signalling, because two callers need the same answer:
//
//   - adopt-on-send, which may not signal a pid it has not verified;
//   - resume-then-send, which must decide whether bin/claude-sessions'
//     transcript-mtime live guard is telling the truth (see launch.js).
//
// One decision, two consumers. A resume refused by a guard the send has
// already disproved is the same dead end arriving from the other side, which
// is the lesson classifyBlocked cost us on 2026-08-02.
function createSessionOwnerProbe(options = {}) {
  const {
    contextDir,
    readFile,
    statFile,
    readProcCmdline,
    processKill,
    scanForSessionOwner,
    platform,
  } = options;
  if (!contextDir || typeof readFile !== 'function'
    || (!platform && (typeof readProcCmdline !== 'function' || typeof processKill !== 'function'))
    || typeof scanForSessionOwner !== 'function') {
    throw new TypeError('createSessionOwnerProbe requires injectable filesystem, proc, and scan dependencies');
  }

  // The process table is not a source that always answers: on 2026-08-03 a
  // kernel wedge left 2,376 processes whose /proc cmdline reads block in
  // D-state, the owner scan walked into one, and every send into an outside
  // session HUNG instead of refusing (and the hung reads pinned libuv
  // threadpool slots, starving the app's other fs work). Both process
  // questions therefore carry a deadline, and blowing it is an ordinary
  // honest refusal: the caller already treats every throw as "not proven",
  // so the guard stands and the send fails retryably instead of never
  // coming back.
  //
  // The deadline is the PLATFORM's to size when no caller overrides it,
  // because 3000ms is a /proc number: a /proc read answers in microseconds
  // and only blows it wedged, while win32's same question is a
  // powershell.exe spawn plus a CIM query measured at ~3.2s single-pid and
  // ~4.8s full-table on the real machine, so the /proc default refused EVERY
  // win32 probe (2026-08-21: three takeover attempts each dead at exactly
  // +3.0s, adopt-on-send structurally unusable on Windows).
  const procDeadlineMs = options.procDeadlineMs
    ?? options.platform?.processQuestionDeadlineMs
    ?? 3000;
  const withDeadline = (work, what) => {
    let timer;
    return Promise.race([
      Promise.resolve(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `${what} did not answer within ${procDeadlineMs}ms (the process table may be wedged); refusing to guess, retry shortly`,
        )), procDeadlineMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  const pidAlive = (pid) => {
    try {
      processKill(pid, 0);
      return true;
    } catch (error) {
      if (isGoneError(error)) return false;
      throw error;
    }
  };

  const inspectProcess = platform?.processInfo
    ? platform.processInfo.bind(platform)
    : async (pid) => {
      let cmdline = '';
      try {
        cmdline = String(await readProcCmdline(pid));
      } catch (error) {
        if (!isGoneError(error)) throw error;
        return { alive: false, cmdline: '', isAgent: false };
      }
      const isAgent = /claude/i.test(cmdline);
      return { alive: Boolean(cmdline) && isAgent ? pidAlive(pid) : Boolean(cmdline), cmdline, isAgent };
    };

  return async function probeSessionOwner(sessionId) {
    if (!sessionId || path.basename(String(sessionId)) !== String(sessionId)) {
      throw new Error(OWNER_UNKNOWN);
    }
    const teePath = path.join(contextDir, `${sessionId}.json`);
    let tee;
    try {
      tee = JSON.parse(await readFile(teePath, 'utf8'));
    } catch {
      throw new Error(OWNER_UNKNOWN);
    }
    if (tee?.session_id !== sessionId) {
      throw new Error('context belongs to a different session');
    }
    const pid = Number(tee.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(OWNER_UNKNOWN);

    // The recorded owner counts as GONE when its /proc entry vanished, its
    // pid was recycled by another process, or it is a zombie. A gone owner
    // must not dead-end the send (live-caught 2026-07-24: the OOM kill left
    // a working-tailed transcript and a dead pid, and the first Enter
    // refused with OWNER_UNKNOWN); after a scan confirms no other live
    // process carries this session id, the handler falls through to
    // resume-then-send. Kills stay strictly tee-verified: a scan hit refuses,
    // it never redirects the signal to a pid the tee did not name.
    //
    // A claude-looking argv alone must not authorize the signal (HB-004: a
    // pid recycled by an UNRELATED Claude session would be killed), but a
    // FRESH `claude` carries no session id in its argv at all, only resumed
    // sessions do, so demanding the id there turns the most common adopt
    // shape into owner-gone and resumes a second writer onto a transcript
    // whose first writer is still alive (shipped 2026-07-28, caught by the
    // isolated-signal gate spec). The ladder that serves both:
    //   a. argv carries this exact session id: the owner (every resume);
    //   b. argv RESUMES a different id: provably another session, gone;
    //   c. otherwise identity comes from TIME: the tee's writer had to
    //      exist when the tee was last written, and two processes cannot
    //      share a pid at one instant, so a claude whose start time is at
    //      or before the tee mtime IS the writer the tee names, while a
    //      recycled pid started strictly after the original died, which is
    //      at or after its last tee write;
    //   d. none of that establishable (no start time source): REFUSE,
    //      retryably. Guessing either way is worse: signaling risks killing
    //      a stranger, falling through risks the double-writer.
    const info = await withDeadline(inspectProcess(pid), `pid ${pid} inspection`);
    const argv = String(info.cmdline || '').split(/[\0\s]+/).filter(Boolean);
    let ownerGone = !info.alive || !info.isAgent;
    if (!ownerGone && !argv.includes(sessionId)) {
      const resumeIx = argv.findIndex((token) => token === '--resume' || token === '-r');
      const resumesOther = resumeIx !== -1 && Boolean(argv[resumeIx + 1]) && argv[resumeIx + 1] !== sessionId;
      if (resumesOther) {
        ownerGone = true;
      } else {
        const startedAt = Number(info.startedAt);
        let teeMtimeMs = null;
        if (typeof statFile === 'function') {
          try { teeMtimeMs = (await statFile(teePath)).mtimeMs; } catch { /* raced away; refuse below */ }
        }
        if (Number.isFinite(startedAt) && Number.isFinite(teeMtimeMs)) {
          ownerGone = startedAt > teeMtimeMs;
        } else {
          throw new Error(`cannot verify pid ${pid} as this session's owner (a claude process whose start time could not be read); refusing to signal it, retry shortly`);
        }
      }
    }
    if (ownerGone) {
      const other = await withDeadline(scanForSessionOwner(sessionId), 'the session-owner scan');
      if (other) {
        throw new Error(`another live process (pid ${other}) appears to hold this session; retry after it exits`);
      }
      return { pid, ownerGone: true };
    }
    return { pid, ownerGone: false };
  };
}

function createTakeoverOwner(options = {}) {
  const {
    processKill,
    sleep,
    platform,
    // Refuses the kill outright for an instance that must not touch real
    // processes (see main/isolation.js). It runs at SIGNAL time, not at read
    // time, so a missing tee still answers OWNER_UNKNOWN and the owner-gone
    // fall-through still resumes: only the signal itself is withheld.
    assertSignalsAllowed = () => {},
    pollAttempts = 40,
    killAttempt = 20,
    // The probe the composition root already built for the resume path, so
    // both consumers provably share one ladder rather than two copies of it.
    ownerProbe,
  } = options;
  if (typeof sleep !== 'function') {
    throw new TypeError('createTakeoverOwner requires injectable filesystem, proc, signal, scan, and timer dependencies');
  }
  const probeSessionOwner = ownerProbe || createSessionOwnerProbe(options);

  const pidAlive = (pid) => {
    try {
      processKill(pid, 0);
      return true;
    } catch (error) {
      if (isGoneError(error)) return false;
      throw error;
    }
  };

  return async function takeoverOwner(sessionId) {
    const { pid, ownerGone } = await probeSessionOwner(sessionId);
    if (ownerGone) return { pid, ownerGone: true };

    assertSignalsAllowed(pid);
    if (platform?.killProcess) {
      const result = await platform.killProcess(pid, 'SIGTERM');
      if (!result?.died) throw new Error('owning process survived graceful and forceful termination');
      return { pid, ownerGone: false };
    }
    try {
      processKill(pid, 'SIGTERM');
    } catch (error) {
      if (!isGoneError(error)) throw new Error(`SIGTERM failed: ${error.message}`);
    }
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      if (!pidAlive(pid)) return { pid, ownerGone: false };
      if (attempt === killAttempt) {
        try {
          processKill(pid, 'SIGKILL');
        } catch (error) {
          if (!isGoneError(error)) throw new Error(`SIGKILL failed: ${error.message}`);
        }
      }
      if (attempt + 1 < pollAttempts) await sleep();
    }
    throw new Error('owning process survived SIGTERM and SIGKILL');
  };
}

function createTakeoverHandler(options = {}) {
  const {
    takeoverOwner,
    paneIdSet,
    getSessionMeta,
    resumeSession,
    findFreshPane,
    setPaneLink,
    requestFocusPane,
    waitForResumedClaudeReady,
    emitStatus,
    emitLaunched,
    operationGate = createSessionOperationGate(),
  } = options;

  return function handleTakeover({ sessionId }) {
    if (!sessionId) throw new TypeError('session:takeover requires sessionId');
    return operationGate.run(sessionId, async () => {
      const status = (phase, detail) => emitStatus({ sessionId, phase, detail });
      try {
        status('taking-over', 'ending the terminal process…');
        const [preIds, meta] = await Promise.all([
          paneIdSet(),
          getSessionMeta(sessionId).catch(() => null),
        ]);
        const owner = await takeoverOwner(sessionId);
        status('taking-over', owner?.ownerGone
          ? 'owner already exited; resuming session…'
          : 'adopting session…');
        const result = await resumeSession({
          id: sessionId,
          detectedHome: meta?.home,
          liveOk: true,
        });
        const fresh = await findFreshPane({ preIds, cwd: meta?.cwd || null });
        if (!fresh) throw new Error('session launched but Harbor could not identify its pane');
        setPaneLink(sessionId, fresh);
        await requestFocusPane({ paneId: fresh.paneId, workspaceId: fresh.workspaceId }).catch(() => {});
        const ready = await waitForResumedClaudeReady(fresh.paneId, fresh.workspaceId);
        if (!ready) throw new Error('session adopted, but Claude never became ready');
        emitLaunched({
          sessionId,
          paneId: fresh.paneId,
          cwd: meta?.cwd || null,
          resumed: true,
        });
        status('sent', 'session adopted');
        return result;
      } catch (error) {
        status('error', String(error?.message || error));
        throw error;
      }
    });
  };
}

module.exports = {
  OWNER_UNKNOWN,
  createSessionOperationGate,
  startResumeFollowup,
  createSessionOwnerProbe,
  createTakeoverOwner,
  createTakeoverHandler,
};
