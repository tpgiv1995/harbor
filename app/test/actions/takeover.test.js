'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTakeoverOwner,
  createTakeoverHandler,
  createSessionOperationGate,
  startResumeFollowup,
} = require('../../src/main/actions/takeover.js');

const SESSION_ID = 'session-123';

function ownerFixture(overrides = {}) {
  const signals = [];
  const scans = [];
  let aliveChecks = 0;
  const readFile = async (file) => {
    assert.equal(file, `/fake/context/${SESSION_ID}.json`);
    if (overrides.readFile) return overrides.readFile(file);
    return JSON.stringify({ session_id: SESSION_ID, pid: 4321 });
  };
  const readProcCmdline = overrides.readProcCmdline || (async (pid) => {
    assert.equal(pid, 4321);
    return Buffer.from(`/usr/bin/claude\0--resume\0${SESSION_ID}\0`);
  });
  const processKill = overrides.processKill || ((pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 0) {
      aliveChecks += 1;
      if (aliveChecks >= (overrides.goneAtCheck || 3)) {
        const error = new Error('gone');
        error.code = 'ESRCH';
        throw error;
      }
    }
  });
  const scanForSessionOwner = overrides.scanForSessionOwner || (async (sessionId) => {
    scans.push(sessionId);
    return null;
  });
  return {
    signals,
    scans,
    takeoverOwner: createTakeoverOwner({
      contextDir: '/fake/context',
      readFile,
      readProcCmdline,
      processKill,
      scanForSessionOwner,
      ...(overrides.assertSignalsAllowed ? { assertSignalsAllowed: overrides.assertSignalsAllowed } : {}),
      ...(overrides.statFile ? { statFile: overrides.statFile } : {}),
      ...(overrides.platform ? { platform: overrides.platform } : {}),
      sleep: async () => {},
      pollAttempts: overrides.pollAttempts || 6,
      killAttempt: overrides.killAttempt || 3,
    }),
  };
}

test('verified owner receives exact SIGTERM and takeover waits until it is dead', async () => {
  const { takeoverOwner, signals, scans } = ownerFixture();
  const result = await takeoverOwner(SESSION_ID);
  assert.deepEqual(result, { pid: 4321, ownerGone: false });
  assert.deepEqual(signals, [
    [4321, 0],
    [4321, 'SIGTERM'],
    [4321, 0],
    [4321, 0],
  ]);
  assert.deepEqual(scans, []);
});

// An instance that must not touch real processes (a drive on an isolated
// profile still reading the real context store) is stopped at SIGNAL time, and
// stopped completely: live-caught 2026-07-25, a config-modal drive's Apply
// adopted the very session that was running it and SIGTERMed its claude.
test('a barred instance never signals the owner and says so honestly', async () => {
  const { takeoverOwner, signals } = ownerFixture({
    assertSignalsAllowed: () => { throw new Error('refusing to signal a real process: isolated profile'); },
  });
  await assert.rejects(() => takeoverOwner(SESSION_ID), /refusing to signal a real process/);
  // Signal 0 (the liveness precheck) is fine; nothing that DELIVERS was sent.
  assert.deepEqual(signals.filter(([, signal]) => signal !== 0), []);
});

// The guard is about signalling, not about reading: an unidentifiable owner
// must still answer OWNER_UNKNOWN so the send falls through to resume, and the
// e2e adopt spec asserts exactly that string.
test('a barred instance still answers OWNER_UNKNOWN when there is no tee to read', async () => {
  const { takeoverOwner } = ownerFixture({
    assertSignalsAllowed: () => { throw new Error('refusing to signal a real process: isolated profile'); },
    readFile: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  await assert.rejects(() => takeoverOwner(SESSION_ID), /cannot identify the owning process/);
});

for (const [name, readFile] of [
  ['missing tee file', async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }],
  ['missing pid', async () => JSON.stringify({ session_id: SESSION_ID })],
  ['zero pid', async () => JSON.stringify({ session_id: SESSION_ID, pid: 0 })],
]) {
  test(`${name} refuses because the owning process cannot be identified`, async () => {
    const { takeoverOwner } = ownerFixture({ readFile });
    await assert.rejects(() => takeoverOwner(SESSION_ID), /cannot identify the owning process/);
  });
}

test('tee session id mismatch refuses without signaling', async () => {
  const { takeoverOwner, signals } = ownerFixture({
    readFile: async () => JSON.stringify({ session_id: 'some-other-session', pid: 4321 }),
  });
  await assert.rejects(() => takeoverOwner(SESSION_ID), /context belongs to a different session/);
  assert.deepEqual(signals, []);
});

// The OOM-kill shape (live-caught 2026-07-24): the recorded owner was killed,
// its /proc entry is gone, and nothing else holds the session. The send must
// fall through to resume-then-send, never dead-end on a process that no
// longer exists.
test('gone pid with a clean scan falls through as owner-gone without signaling', async () => {
  const { takeoverOwner, signals, scans } = ownerFixture({
    readProcCmdline: async () => { const error = new Error('gone'); error.code = 'ENOENT'; throw error; },
  });
  const result = await takeoverOwner(SESSION_ID);
  assert.deepEqual(result, { pid: 4321, ownerGone: true });
  assert.deepEqual(signals, []);
  assert.deepEqual(scans, [SESSION_ID]);
});

test('gone pid refuses when another live process still carries the session id', async () => {
  const { takeoverOwner, signals } = ownerFixture({
    readProcCmdline: async () => { const error = new Error('gone'); error.code = 'ENOENT'; throw error; },
    scanForSessionOwner: async () => 9999,
  });
  await assert.rejects(() => takeoverOwner(SESSION_ID), /another live process \(pid 9999\)/);
  assert.deepEqual(signals, []);
});

// A recycled pid (the dead claude's pid reused by an unrelated process) is
// owner-gone too: the cmdline guard exists so a recycled pid is NEVER
// signaled, not to dead-end the send.
test('recycled pid (non-claude cmdline) falls through as owner-gone without signaling', async () => {
  const { takeoverOwner, signals, scans } = ownerFixture({
    readProcCmdline: async () => Buffer.from('/usr/bin/bash\0'),
  });
  const result = await takeoverOwner(SESSION_ID);
  assert.deepEqual(result, { pid: 4321, ownerGone: true });
  assert.deepEqual(signals, []);
  assert.deepEqual(scans, [SESSION_ID]);
});

test('recycled pid owned by a different Claude session is never signaled', async () => {
  const { takeoverOwner, signals, scans } = ownerFixture({
    readProcCmdline: async () => Buffer.from(`/usr/bin/claude\0--resume\0${SESSION_ID}-other\0`),
  });
  const result = await takeoverOwner(SESSION_ID);
  assert.deepEqual(result, { pid: 4321, ownerGone: true });
  assert.deepEqual(signals.filter(([, signal]) => signal !== 0), []);
  assert.deepEqual(scans, [SESSION_ID]);
});

// The most common adopt shape of all: a FRESH `claude` started in a terminal
// carries NO session id in its argv (only resumed sessions do), so its
// identity is proven by TIME: it existed when the tee was last written, and
// two processes cannot share a pid at one instant. Requiring the argv id here
// (shipped 2026-07-28, batch-9) turned every fresh outside session into
// owner-gone and resumed a SECOND writer while the first was still alive.
test('fresh owner with no session id in argv is verified by start time and signaled', async () => {
  const { takeoverOwner, signals } = ownerFixture({
    platform: {
      processInfo: async () => ({ alive: true, cmdline: '/usr/bin/claude\0', isAgent: true, startedAt: 1000 }),
    },
    statFile: async () => ({ mtimeMs: 5000 }),
  });
  const result = await takeoverOwner(SESSION_ID);
  assert.deepEqual(result, { pid: 4321, ownerGone: false });
  assert.ok(signals.some(([pid, signal]) => pid === 4321 && signal === 'SIGTERM'), 'fresh owner must be SIGTERMed');
});

test('claude pid younger than the tee is a recycle: gone, scanned, never signaled', async () => {
  const { takeoverOwner, signals, scans } = ownerFixture({
    platform: {
      processInfo: async () => ({ alive: true, cmdline: '/usr/bin/claude\0', isAgent: true, startedAt: 9000 }),
    },
    statFile: async () => ({ mtimeMs: 5000 }),
  });
  const result = await takeoverOwner(SESSION_ID);
  assert.deepEqual(result, { pid: 4321, ownerGone: true });
  assert.deepEqual(signals.filter(([, signal]) => signal !== 0), []);
  assert.deepEqual(scans, [SESSION_ID]);
});

// When identity can be established NEITHER by argv NOR by start time, refuse
// retryably. Guessing either way is worse: signaling risks killing a
// stranger, and falling through to resume risks the double-writer.
test('claude pid with no id and no readable start time refuses rather than guessing', async () => {
  const { takeoverOwner, signals, scans } = ownerFixture({
    platform: {
      processInfo: async () => ({ alive: true, cmdline: '/usr/bin/claude\0', isAgent: true, startedAt: null }),
    },
    statFile: async () => { throw new Error('raced away'); },
  });
  await assert.rejects(() => takeoverOwner(SESSION_ID), /refusing to signal it, retry shortly/);
  assert.deepEqual(signals.filter(([, signal]) => signal !== 0), []);
  assert.deepEqual(scans, [], 'a refusal must not fall through to the gone-owner scan');
});

// A zombie's cmdline reads empty: a reaped-but-unwaited owner cannot write a
// transcript, so it counts as gone, not as "not Claude".
test('zombie pid (empty cmdline) falls through as owner-gone', async () => {
  const { takeoverOwner, signals } = ownerFixture({
    readProcCmdline: async () => Buffer.from(''),
  });
  const result = await takeoverOwner(SESSION_ID);
  assert.deepEqual(result, { pid: 4321, ownerGone: true });
  assert.deepEqual(signals, []);
});

test('pid dead at the aliveness precheck falls through as owner-gone', async () => {
  const { takeoverOwner, signals } = ownerFixture({
    processKill: (_pid, signal) => {
      signals.push([4321, signal]);
      const error = new Error('gone');
      error.code = 'ESRCH';
      throw error;
    },
  });
  const result = await takeoverOwner(SESSION_ID);
  assert.deepEqual(result, { pid: 4321, ownerGone: true });
  assert.deepEqual(signals, [[4321, 0]]);
});

test('owner that survives SIGKILL refuses and is never resumed', async () => {
  const { takeoverOwner, signals } = ownerFixture({
    processKill: (pid, signal) => { signals.push([pid, signal]); },
    pollAttempts: 5,
    killAttempt: 2,
  });
  await assert.rejects(() => takeoverOwner(SESSION_ID), /owning process survived SIGTERM and SIGKILL/);
  assert.deepEqual(signals.filter(([, signal]) => signal === 'SIGKILL'), [[4321, 'SIGKILL']]);
});

function handlerFixture(overrides = {}) {
  const events = [];
  const links = [];
  const resumes = [];
  const ready = [];
  const handler = createTakeoverHandler({
    takeoverOwner: overrides.takeoverOwner
      || (async (id) => { assert.equal(id, SESSION_ID); return { pid: 4321, ownerGone: false }; }),
    paneIdSet: async () => new Set(['old-pane']),
    getSessionMeta: async () => ({ cwd: '/work/project', home: 'personal' }),
    resumeSession: async (args) => { resumes.push(args); return { argv: ['--live-ok'] }; },
    findFreshPane: async ({ preIds, cwd }) => {
      assert.deepEqual([...preIds], ['old-pane']);
      assert.equal(cwd, '/work/project');
      return { paneId: 'fresh-pane', workspaceId: 'workspace-1' };
    },
    setPaneLink: (id, pane) => links.push([id, pane]),
    requestFocusPane: async (pane) => events.push(['focus', pane]),
    waitForResumedClaudeReady: async (...args) => { ready.push(args); return true; },
    emitStatus: (payload) => events.push(['status', payload]),
    emitLaunched: (payload) => events.push(['launched', payload]),
  });
  return { handler, events, links, resumes, ready };
}

test('handler reports phases, resumes live-ok, links and focuses the fresh pane', async () => {
  const { handler, events, links, resumes, ready } = handlerFixture();

  const result = await handler({ sessionId: SESSION_ID });

  assert.deepEqual(resumes, [{ id: SESSION_ID, detectedHome: 'personal', liveOk: true }]);
  assert.deepEqual(links, [[SESSION_ID, { paneId: 'fresh-pane', workspaceId: 'workspace-1' }]]);
  assert.deepEqual(ready, [['fresh-pane', 'workspace-1']]);
  assert.deepEqual(events, [
    ['status', { sessionId: SESSION_ID, phase: 'taking-over', detail: 'ending the terminal process…' }],
    ['status', { sessionId: SESSION_ID, phase: 'taking-over', detail: 'adopting session…' }],
    ['focus', { paneId: 'fresh-pane', workspaceId: 'workspace-1' }],
    ['launched', { sessionId: SESSION_ID, paneId: 'fresh-pane', cwd: '/work/project', resumed: true }],
    ['status', { sessionId: SESSION_ID, phase: 'sent', detail: 'session adopted' }],
  ]);
  assert.deepEqual(result, { argv: ['--live-ok'] });
});

test('two concurrent takeovers for one session share one adoption operation', async () => {
  let releaseOwner;
  const ownerBlocked = new Promise((resolve) => { releaseOwner = resolve; });
  let ownerCalls = 0;
  const { handler, links, resumes } = handlerFixture({
    takeoverOwner: async () => {
      ownerCalls += 1;
      await ownerBlocked;
      return { pid: 4321, ownerGone: false };
    },
  });

  const first = handler({ sessionId: SESSION_ID });
  const second = handler({ sessionId: SESSION_ID });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ownerCalls, 1, 'the owner is ended only once');

  releaseOwner();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.strictEqual(firstResult, secondResult);
  assert.equal(resumes.length, 1, 'the session is resumed only once');
  assert.equal(links.length, 1, 'only one fresh pane is linked');
});

test('session operation gate deduplicates matching ids but not different sessions', async () => {
  const gate = createSessionOperationGate();
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const operation = async () => {
    calls += 1;
    await blocked;
    return calls;
  };

  const first = gate.run(SESSION_ID, operation);
  const duplicate = gate.run(SESSION_ID, operation);
  const other = gate.run('session-other', operation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  release();
  assert.strictEqual(await duplicate, await first);
  await other;
});

test('detached resume follow-up turns a rejection into an honest status', async () => {
  const statuses = [];
  const done = startResumeFollowup({
    sessionId: SESSION_ID,
    run: async () => { throw new Error('fresh pane lookup failed'); },
    emitStatus: (payload) => statuses.push(payload),
  });

  await assert.doesNotReject(done);
  assert.deepEqual(statuses, [{
    sessionId: SESSION_ID,
    phase: 'error',
    detail: 'fresh pane lookup failed',
  }]);
});

test('handler with a gone owner still resumes and delivers, and says so honestly', async () => {
  const { handler, events, resumes } = handlerFixture({
    takeoverOwner: async () => ({ pid: 4321, ownerGone: true }),
  });

  await handler({ sessionId: SESSION_ID });

  assert.deepEqual(resumes, [{ id: SESSION_ID, detectedHome: 'personal', liveOk: true }]);
  const statusDetails = events.filter(([kind]) => kind === 'status').map(([, p]) => p.detail);
  assert.ok(statusDetails.includes('owner already exited; resuming session…'));
  assert.equal(statusDetails.at(-1), 'session adopted');
});

test('handler emits an honest error when owner verification fails', async () => {
  const statuses = [];
  const handler = createTakeoverHandler({
    takeoverOwner: async () => { throw new Error('cannot identify the owning process'); },
    paneIdSet: async () => new Set(),
    getSessionMeta: async () => null,
    resumeSession: async () => assert.fail('must not resume'),
    findFreshPane: async () => null,
    setPaneLink: () => {},
    requestFocusPane: async () => {},
    waitForResumedClaudeReady: async () => true,
    emitStatus: (payload) => statuses.push(payload),
    emitLaunched: () => {},
  });
  await assert.rejects(() => handler({ sessionId: SESSION_ID }), /cannot identify/);
  assert.deepEqual(statuses.at(-1), {
    sessionId: SESSION_ID,
    phase: 'error',
    detail: 'cannot identify the owning process',
  });
});

// ONE LADDER, TWO CONSUMERS (2026-08-03). The probe is the piece adopt-on-send
// must satisfy before it may signal AND the piece resume must satisfy before it
// may overrule bin/claude-sessions' transcript-mtime live guard. Split out so
// those two cannot answer differently, which is the shape that cost us
// classifyBlocked on 2026-08-02: a refusal the other side does not recognise is
// the same dead end arriving backwards.
test('takeover and resume ask the SAME probe, and takeover never re-derives it', async () => {
  const asked = [];
  const takeoverOwner = createTakeoverOwner({
    ownerProbe: async (sessionId) => { asked.push(sessionId); return { pid: 77, ownerGone: true }; },
    sleep: async () => {},
    processKill: () => { throw new Error('a gone owner must never be signalled'); },
    assertSignalsAllowed: () => { throw new Error('a gone owner must never reach the signal guard'); },
  });
  assert.deepEqual(await takeoverOwner(SESSION_ID), { pid: 77, ownerGone: true });
  assert.deepEqual(asked, [SESSION_ID]);
});

// The fleet-death shape, against the REAL /proc rather than a description of
// it: the herdr daemon (or oomd) takes the whole cgroup, the tee still names
// the pid that died, and the transcript is hot because dying is what wrote it.
// Harbor must call that owner gone so the resume carries --live-ok instead of
// waiting out a 90-second timer with Pat's message in the composer.
test('a really-dead tee owner reads as gone; a live process holding the id refuses', async () => {
  const { createSessionOwnerProbe } = require('../../src/main/actions/takeover.js');
  const { platform } = require('../../src/main/platform/index.js');
  if (process.platform !== 'linux') return; // /proc-shaped by construction

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync, spawn } = require('node:child_process');

  // A unique id so the /proc scan cannot match anything but what we spawn.
  const id = `probe-${process.pid}-${Date.now().toString(36)}`;
  const contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-probe-'));
  const probe = createSessionOwnerProbe({
    contextDir,
    readFile: require('node:fs/promises').readFile,
    statFile: (target) => require('node:fs/promises').stat(target),
    platform: { processInfo: (pid) => platform.processInfo(pid) },
    scanForSessionOwner: (sessionId) => platform.findSessionOwner(sessionId),
  });

  // A pid that is genuinely, verifiably dead: spawned and already reaped.
  const dead = spawnSync('/bin/true');
  fs.writeFileSync(
    path.join(contextDir, `${id}.json`),
    JSON.stringify({ session_id: id, pid: dead.pid }),
  );

  try {
    assert.deepEqual(await probe(id), { pid: dead.pid, ownerGone: true });

    // Two-sided: proof of absence must be real proof. A live process whose
    // cmdline carries this session id blocks the fall-through with an honest,
    // retryable refusal rather than a --live-ok that would double-write.
    // Two commands, deliberately: bash execs a lone simple command and would
    // replace its own cmdline with a bare `sleep 30`, taking the id with it.
    const holder = spawn('/bin/bash', ['-c', `sleep 30; true # claude --resume ${id}`], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await assert.rejects(() => probe(id), /another live process \(pid \d+\) appears to hold this session/);
    } finally {
      holder.kill('SIGKILL'); // our own child, spawned by this test
    }
  } finally {
    fs.rmSync(contextDir, { recursive: true, force: true });
  }
});

// The 2026-08-03 shape from the send side: a kernel wedge (2,376 D-state
// processes) made /proc cmdline reads block forever, the owner scan walked
// into one, and "not taking messages" was a probe that never came back. A
// /proc question that outlives its deadline is answered with an honest
// retryable refusal; the resume caller already reads any throw as "not
// proven", so the live guard stands rather than the send hanging.
test('a wedged /proc answers the probe with a refusal, not a hang', async () => {
  const { createSessionOwnerProbe } = require('../../src/main/actions/takeover.js');
  const fs = require('node:fs');
  const fsp = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const id = `wedge-${process.pid}`;
  const contextDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-probe-'));
  fs.writeFileSync(
    path.join(contextDir, `${id}.json`),
    JSON.stringify({ session_id: id, pid: 424242 }),
  );
  const probe = createSessionOwnerProbe({
    contextDir,
    readFile: fsp.readFile,
    statFile: (target) => fsp.stat(target),
    // A /proc read that never returns, which is exactly what a D-state pid's
    // cmdline does.
    platform: { processInfo: () => new Promise(() => {}) },
    scanForSessionOwner: () => new Promise(() => {}),
    procDeadlineMs: 50,
  });
  try {
    const started = Date.now();
    await assert.rejects(() => probe(id), /proc may be wedged/);
    assert.ok(Date.now() - started < 2000, 'the refusal must arrive at the deadline, not eventually');
  } finally {
    fs.rmSync(contextDir, { recursive: true, force: true });
  }
});
