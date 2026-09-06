'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// AN IDLE SESSION IS ENDED; A BUSY ONE IS NEVER TOUCHED (2026-08-09).
//
// The measurement that forced this: 15 live sessions, 4 of them active, the
// other 11 holding 15.9G, three of which had never run a turn at all. The
// daemon log for that day carries 20 `spawn` lines and zero closes, because
// nothing has ever ended a session for being finished.
//
// EVERY SPEC HERE IS TWO-SIDED, and for this feature that is not a style rule.
// A dormancy sweep that never fires passes any test that only asserts "the busy
// session survived", and a sweep that kills everything passes any test that only
// asserts "the idle session slept". Both halves are required together, in the
// same conditions, or the proof is worthless. The safety half matters more:
// putting a session to sleep destroys whatever it was doing, and the background
// -busy case (a `run_in_background` Bash child burning a core while the pty says
// nothing at all) is exactly the 02:15 runaway-grep shape from the same
// incident, so it is asserted against the real sweep with a real clock rather
// than reasoned about.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  resolveDormancyPolicy, evaluate, cgroupCpuUsec, awaitingAnswer, sweepDormancy,
  parseWinProcessTable, winProcessTreeCpuUsec, winCpuSnapshot,
} = require('../../src/daemon/dormancy.js');
const { SessionClient } = require('../../src/daemon/client.js');

const DAEMON = path.resolve(__dirname, '../../src/daemon/daemon.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HOUR = 60 * 60 * 1000;
const policy = resolveDormancyPolicy({});
const stateAt = (agoMs, extra = {}) => ({
  id: 'sess-1',
  last_activity_at: new Date(Date.now() - agoMs).toISOString(),
  keeper_pid: 1234,
  exit: null,
  ...extra,
});

test('1. the decision: idle and quiet sleeps, and every other shape does not', () => {
  const now = Date.now();
  // A sample from 60s ago, the production sweep interval. The busy threshold is
  // a RATE, so the previous sample's timestamp is part of the evidence.
  const quiet = { cpuUsec: 1_000_000, at: now - 60_000, idleChecks: 1 };

  // THE ONE CASE THAT SLEEPS.
  const sleeps = evaluate(stateAt(2 * HOUR), { now, policy, previous: quiet, cpuUsec: 1_000_100 });
  assert.equal(sleeps.sleep, true, 'two hours idle with a flat cpu counter must sleep');
  assert.match(sleeps.reason, /idle for 120m/);

  // AND THE ONES THAT MUST NOT, each for its own reason.
  assert.equal(evaluate(stateAt(5 * 60 * 1000), { now, policy, previous: quiet, cpuUsec: 1_000_100 }).sleep,
    false, 'five minutes idle is not an hour');

  assert.equal(evaluate(stateAt(2 * HOUR), { now, policy, previous: quiet, cpuUsec: null }).sleep,
    false, 'an unreadable cgroup must read as BUSY, never as idle');

  assert.equal(evaluate(stateAt(2 * HOUR), { now, policy, previous: undefined, cpuUsec: 1_000_000 }).sleep,
    false, 'the first idle observation has no delta yet and must only start measuring');

  // The runaway-grep shape: silent pty, burning cpu.
  const busy = evaluate(stateAt(2 * HOUR), { now, policy, previous: quiet, cpuUsec: 1_000_000 + 30_000_000 });
  assert.equal(busy.sleep, false, 'a session burning cpu in the background must never be put to sleep');
  assert.match(busy.reason, /burning cpu/);
  assert.equal(busy.idleChecks, 0, 'a busy interval RESETS the counter, so quiet passes cannot accumulate past a busy one');

  assert.equal(evaluate(stateAt(2 * HOUR), { now, policy, previous: { cpuUsec: 5_000_000, at: now - 60_000, idleChecks: 1 }, cpuUsec: 1_000 }).sleep,
    false, 'a cgroup that was recreated (counter went backwards) restarts the observation');

  // THE BUG THE E2E SPEC CAUGHT, pinned as a unit case so it cannot come back:
  // the same pegged core must read as busy at ANY sweep interval. With a flat
  // 2-second threshold this passed at 60s and failed at 400ms.
  for (const intervalMs of [400, 1000, 5000, 60_000]) {
    const pegged = evaluate(stateAt(2 * HOUR), {
      now,
      policy,
      previous: { cpuUsec: 0, at: now - intervalMs, idleChecks: 1 },
      cpuUsec: intervalMs * 1000, // one core, fully pegged, for the whole interval
    });
    assert.equal(pegged.sleep, false, `a pegged core must read as busy at a ${intervalMs}ms sweep interval`);
  }
  assert.equal(evaluate(stateAt(2 * HOUR), { now, policy, previous: { cpuUsec: 0, at: now, idleChecks: 1 }, cpuUsec: 0 }).sleep,
    false, 'a zero-length interval proves nothing about a rate and must not be read as idle');

  assert.equal(evaluate({ id: 'x', keeper_pid: 1, exit: null }, { now, policy, previous: quiet, cpuUsec: 1 }).sleep,
    false, 'a state with no activity stamp (an older keeper) must never be slept on a guess');

  assert.equal(evaluate(stateAt(2 * HOUR, { exit: { code: 0 } }), { now, policy, previous: quiet, cpuUsec: 1 }).sleep,
    false, 'an already-exited session is not a candidate');

  assert.equal(evaluate(stateAt(9 * HOUR), { now, policy: resolveDormancyPolicy({ HARBOR_SESSIOND_DORMANT_AFTER_MS: '0' }), previous: quiet, cpuUsec: 1 }).sleep,
    false, 'HARBOR_SESSIOND_DORMANT_AFTER_MS=0 turns the whole feature off');
});

test('2. hysteresis: one quiet observation is never enough', () => {
  const now = Date.now();
  const watchless = evaluate(stateAt(2 * HOUR), { now, policy, previous: { cpuUsec: 500, at: now - 60_000, idleChecks: 0 }, cpuUsec: 500 });
  assert.equal(watchless.sleep, false, 'the first quiet interval only counts, it does not act');
  assert.equal(watchless.idleChecks, 1);
  const second = evaluate(stateAt(2 * HOUR), { now, policy, previous: { cpuUsec: 500, at: now - 60_000, idleChecks: watchless.idleChecks }, cpuUsec: 500 });
  assert.equal(second.sleep, true, 'the second consecutive quiet interval acts');
});

test('3. a shared cgroup cannot answer a per-session question, so it is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbdormcg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const proc = path.join(dir, 'proc', '99');
  fs.mkdirSync(proc, { recursive: true });

  // A session inside its OWN scope: readable.
  const scoped = '/user.slice/user-1000.slice/user@1000.service/harbor.slice/harbor-sessions.slice/harbor-session-abc.scope';
  fs.writeFileSync(path.join(proc, 'cgroup'), `0::${scoped}\n`);
  const cgDir = path.join(dir, 'cg', scoped.replace(/^\//, ''));
  fs.mkdirSync(cgDir, { recursive: true });
  fs.writeFileSync(path.join(cgDir, 'cpu.stat'), 'usage_usec 4242\nuser_usec 1\n');
  assert.equal(
    cgroupCpuUsec(99, { root: path.join(dir, 'cg'), proc: path.join(dir, 'proc'), sessionId: 'abc' }),
    4242, 'a session in its own scope reports its own cpu');

  // The SAME reading, asked about a different session, must be refused: this is
  // the misattribution that would let one session's cpu vouch for another's.
  assert.equal(
    cgroupCpuUsec(99, { root: path.join(dir, 'cg'), proc: path.join(dir, 'proc'), sessionId: 'other' }),
    null, 'a scope belonging to another session is not this session\'s evidence');

  // Scopes off: everything shares the daemon cgroup, so there is no per-session
  // answer and the honest response is null (which evaluate() reads as busy).
  const shared = '/user.slice/user-1000.slice/user@1000.service/harbor-sessiond.service';
  fs.writeFileSync(path.join(proc, 'cgroup'), `0::${shared}\n`);
  const sharedDir = path.join(dir, 'cg', shared.replace(/^\//, ''));
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(sharedDir, 'cpu.stat'), 'usage_usec 999999\n');
  assert.equal(
    cgroupCpuUsec(99, { root: path.join(dir, 'cg'), proc: path.join(dir, 'proc'), sessionId: 'abc' }),
    null, 'a shared cgroup must be refused, not read as if it were the session\'s');
  assert.equal(
    cgroupCpuUsec(99, { root: path.join(dir, 'cg'), proc: path.join(dir, 'proc'), sessionId: 'abc', requireScope: false }),
    999999, 'the requirement is explicitly waivable, and only explicitly');
});

test('3b. a session showing something that needs an answer is never slept, and an idle composer still is', () => {
  // MEASURED, not assumed: a real claude session parked at the folder-trust
  // dialog held `last_activity_at` unchanged for 90 seconds and burned no cpu,
  // so both of the other signals call it abandoned. Driven against the SAME
  // real captured screens Harbor's own dialog parsers are tested with, so this
  // guard and those parsers cannot drift apart on what a dialog looks like.
  const fixture = (rel) => fs.readFileSync(path.resolve(__dirname, '../fixtures', rel), 'utf8');

  // MUST BE PROTECTED.
  const dialogs = [
    'askuserquestion/real-claude-120x60.txt',
    'askuserquestion/real-batch-multiselect-120x60.txt',
    'askuserquestion/two-column-tabs-w5-p1.txt',
    'clipped-menu/real-claude-23x54.txt',
    'composer-vs-dialog/rewind-dialog-pointer-row.txt',
  ];
  for (const rel of dialogs) {
    assert.equal(awaitingAnswer(fixture(rel)), true, `${rel} is waiting for a human and must never be slept`);
  }
  // The live trust dialog, captured from the session used to prove the bug.
  assert.equal(awaitingAnswer([
    'Quick safety check: Is this a project you created or one you trust?',
    ' ❯ 1. Yes, I trust this folder',
    '   2. No, exit',
    ' Enter to confirm · Esc to cancel',
  ].join('\n')), true, 'the folder-trust dialog must be protected');

  // MUST STILL BE SLEEPABLE, or the guard has simply disabled the feature.
  const idle = [
    'composer-vs-dialog/idle-composer-with-draft.txt',
    'composer-vs-dialog/idle-composer-recap-mentions-compacting.txt',
  ];
  for (const rel of idle) {
    assert.equal(awaitingAnswer(fixture(rel)), false, `${rel} is an idle composer and must remain sleepable`);
  }
  assert.equal(awaitingAnswer(''), false, 'an empty screen is not a question');
  assert.equal(awaitingAnswer(null), false, 'a missing screen is not a question');

  // An ANSWERED dialog scrolled up into the buffer must not protect the session
  // forever: only the tail counts.
  const answeredAbove = ['Enter to confirm · Esc to cancel', ...Array(40).fill('done.'), '❯ '].join('\n');
  assert.equal(awaitingAnswer(answeredAbove), false, 'a dialog far above the tail is history, not a live prompt');
});

test('3c. the sweep asks the screen before it kills, and a blocked session survives every pass', async () => {
  const now = Date.now();
  const blocked = { id: 'blocked', last_activity_at: new Date(now - 2 * HOUR).toISOString(), keeper_pid: 1, exit: null };
  const quiet = { id: 'quiet', last_activity_at: new Date(now - 2 * HOUR).toISOString(), keeper_pid: 2, exit: null };
  const watch = new Map();
  const ended = [];
  let clock = now;
  const deps = () => ({
    states: [blocked, quiet], now: clock, policy, watch,
    readCpu: () => 1_000_000,
    readScreen: async (s) => (s.id === 'blocked'
      ? 'Do you want to make this edit?\n ❯ 1. Yes\n   2. No\n Esc to cancel'
      : 'all done\n────────────\n❯ '),
    terminate: async (s) => { ended.push(s.id); },
    log: () => {},
  });
  for (let i = 0; i < 4; i += 1) { await sweepDormancy(deps()); clock += 60_000; }
  assert.deepEqual(ended, ['quiet'],
    'across four passes only the genuinely idle session may be ended; the blocked one must survive every one');
});

test('3d. a screen that cannot be read means leave it alone, never kill on a guess', async () => {
  const now = Date.now();
  const state = { id: 'mute-screen', last_activity_at: new Date(now - 2 * HOUR).toISOString(), keeper_pid: 1, exit: null };
  const watch = new Map();
  const ended = [];
  let clock = now;
  const deps = () => ({
    states: [state], now: clock, policy, watch,
    readCpu: () => 1_000_000,
    readScreen: async () => { throw new Error('keeper screen request timed out'); },
    terminate: async (s) => { ended.push(s.id); },
    log: () => {},
  });
  for (let i = 0; i < 4; i += 1) { await sweepDormancy(deps()); clock += 60_000; }
  assert.deepEqual(ended, [], 'an unreadable screen must never be treated as permission to kill');
});

test('3e. a session with fresh transcript or subagent work is never slept, and one with stale work still is', async () => {
  // THE HOLDING-FOR-REVIEWERS SHAPE (2026-08-21): a session that spawned
  // adversarial review subagents and ended its turn to wait shows a silent
  // pty and near-zero cpu while the reviewers' jsonl files grow on disk.
  // Both cheap signals call that abandoned; the transcript tree says
  // otherwise and its word is a veto. Two-sided in one harness so the veto
  // cannot pass by simply disabling the sweep.
  const now = Date.now();
  const mk = (id) => ({ id, last_activity_at: new Date(now - 2 * HOUR).toISOString(), keeper_pid: 1, exit: null });
  const holding = mk('holding');
  const abandoned = mk('abandoned');
  const watch = new Map();
  const ended = [];
  let clock = now;
  const deps = () => ({
    states: [holding, abandoned], now: clock, policy, watch,
    readCpu: () => 1_000_000,
    workFresh: async (s) => s.id === 'holding',
    terminate: async (s) => { ended.push(s.id); },
    log: () => {},
  });
  for (let i = 0; i < 4; i += 1) { await sweepDormancy(deps()); clock += 60_000; }
  assert.deepEqual(ended, ['abandoned'],
    'across four passes only the session with a stale transcript tree may be ended');

  // An unreadable answer refuses the kill, the same asymmetry as the screen.
  const wedged = mk('wedged');
  const watch2 = new Map();
  const ended2 = [];
  let clock2 = now;
  for (let i = 0; i < 4; i += 1) {
    await sweepDormancy({
      states: [wedged], now: clock2, policy, watch: watch2,
      readCpu: () => 1_000_000,
      workFresh: async () => { throw new Error('projects dir unreadable'); },
      terminate: async (s) => { ended2.push(s.id); },
      log: () => {},
    });
    clock2 += 60_000;
  }
  assert.deepEqual(ended2, [], 'an unreadable freshness answer must never be read as permission to kill');
});

test('4. the sweep ends the idle session and leaves the busy one alone, in the same pass', async () => {
  const now = Date.now();
  const idle = { id: 'idle', last_activity_at: new Date(now - 2 * HOUR).toISOString(), keeper_pid: 11, exit: null };
  const busy = { id: 'busy', last_activity_at: new Date(now - 2 * HOUR).toISOString(), keeper_pid: 22, exit: null };
  const fresh = { id: 'fresh', last_activity_at: new Date(now - 1000).toISOString(), keeper_pid: 33, exit: null };
  const cpu = { idle: 1_000_000, busy: 1_000_000, fresh: 1_000_000 };
  const watch = new Map();
  const ended = [];
  const logs = [];
  // The clock ADVANCES between passes, because the busy test is a rate and a
  // frozen clock would make every interval zero-length.
  let clock = now;
  const deps = () => ({
    states: [idle, busy, fresh],
    now: clock,
    policy,
    watch,
    readCpu: (s) => cpu[s.id],
    terminate: async (s, v) => { ended.push([s.id, v.reason]); },
    log: (m) => logs.push(m),
  });

  await sweepDormancy(deps());          // pass 1: establishes the cpu baseline
  clock += 60_000;
  cpu.busy += 30_000_000;               // 30s of cpu in 60s: half a core
  await sweepDormancy(deps());          // pass 2: measures the delta, counts one
  clock += 60_000;
  cpu.busy += 30_000_000;
  await sweepDormancy(deps());          // pass 3: idle reaches its second quiet interval

  const sleptIds = ended.map(([id]) => id);
  assert.deepEqual(sleptIds, ['idle'], `only the idle session may be ended, got ${JSON.stringify(sleptIds)}`);
  assert.match(ended[0][1], /Resume it from the rail/, 'the reason must tell the user what to do about it');
  assert.ok(logs.some((l) => l.startsWith('dormant idle:')), 'every sleep is logged with its reason');
});

test('5. a keeper that will not answer is left to reconciliation, not force-killed here', async () => {
  const now = Date.now();
  const state = { id: 'wedged', last_activity_at: new Date(now - 2 * HOUR).toISOString(), keeper_pid: 44, exit: null };
  const watch = new Map();
  const logs = [];
  let clock = now;
  const deps = () => ({
    states: [state], now: clock, policy, watch,
    readCpu: () => 7_000_000,
    terminate: async () => { throw new Error('keeper terminate request timed out after 10000ms'); },
    log: (m) => logs.push(m),
  });
  await sweepDormancy(deps());
  clock += 60_000;
  await sweepDormancy(deps());
  clock += 60_000;
  const slept = await sweepDormancy(deps());
  assert.equal(slept, 0, 'a failed terminate is not counted as a sleep');
  assert.ok(logs.some((l) => /leaving it to reconciliation/.test(l)),
    'the sweep must hand a mute keeper to the one component allowed to kill keepers');
});

test('6. the watch map does not grow forever', async () => {
  const now = Date.now();
  const watch = new Map();
  const alive = { id: 'a', last_activity_at: new Date(now).toISOString(), keeper_pid: 1, exit: null };
  const gone = { id: 'b', last_activity_at: new Date(now).toISOString(), keeper_pid: 2, exit: null };
  const base = { now, policy, watch, readCpu: () => 1, terminate: async () => {}, log: () => {} };
  await sweepDormancy({ ...base, states: [alive, gone] });
  assert.equal(watch.size, 2);
  await sweepDormancy({ ...base, states: [alive] });
  assert.equal(watch.size, 1, 'a session that no longer exists is dropped from the watch');
  assert.ok(watch.has('a'));
});

test('8. the windows process table: parsed exactly, summed as a tree, refused when it cannot answer', () => {
  // The real shape: keeper (electron-as-node) -> claude -> two MCP node
  // children, plus an unrelated process that must never be counted. Times are
  // 100ns units as Win32_Process reports them; 10_000_000 = 1 second of cpu.
  const rows = [
    { ProcessId: 100, ParentProcessId: 1, UserModeTime: 10_000_000, KernelModeTime: 0 },   // keeper: 1s
    { ProcessId: 200, ParentProcessId: 100, UserModeTime: 20_000_000, KernelModeTime: 10_000_000 }, // claude: 3s
    { ProcessId: 300, ParentProcessId: 200, UserModeTime: 5_000_000, KernelModeTime: 0 },  // mcp child: 0.5s
    { ProcessId: 301, ParentProcessId: 200, UserModeTime: 5_000_000, KernelModeTime: 0 },  // mcp child: 0.5s
    { ProcessId: 999, ParentProcessId: 1, UserModeTime: 90_000_000_000, KernelModeTime: 0 }, // a stranger
  ];
  const table = parseWinProcessTable(JSON.stringify(rows));
  assert.equal(winProcessTreeCpuUsec(table, 100), 5_000_000,
    'the tree sum is keeper + claude + both MCP children, in microseconds, and never the stranger');

  // ConvertTo-Json unwraps a single row to a bare object; that must still parse.
  const lone = parseWinProcessTable(JSON.stringify(rows[0]));
  assert.equal(winProcessTreeCpuUsec(lone, 100), 1_000_000);

  // Refusals, each of which evaluate() reads as BUSY: no table, garbage,
  // and a root the table has never heard of (the keeper died, or the pid is
  // someone else's now and the state is reconciliation's business).
  assert.equal(parseWinProcessTable('not json at all'), null);
  assert.equal(parseWinProcessTable('[]'), null);
  assert.equal(winProcessTreeCpuUsec(null, 100), null, 'a failed snapshot answers null, never zero');
  assert.equal(winProcessTreeCpuUsec(table, 4242), null, 'an unknown root is not an idle root');

  // Recycled pids can make the parent graph cyclic; the walk must terminate.
  const cyclic = parseWinProcessTable(JSON.stringify([
    { ProcessId: 10, ParentProcessId: 20, UserModeTime: 10, KernelModeTime: 0 },
    { ProcessId: 20, ParentProcessId: 10, UserModeTime: 10, KernelModeTime: 0 },
  ]));
  assert.equal(winProcessTreeCpuUsec(cyclic, 10), 2, 'a cycle is counted once, not walked forever');
});

test('8b. the snapshot survives a broken probe by answering null, and parses a working one', async () => {
  const failed = await winCpuSnapshot({
    execFileImpl: (cmd, args, opts, cb) => cb(new Error('powershell.exe missing')),
  });
  assert.equal(failed, null, 'a probe failure is null (busy), never a throw that kills the sweep');

  const ok = await winCpuSnapshot({
    execFileImpl: (cmd, args, opts, cb) => cb(null,
      JSON.stringify([{ ProcessId: 7, ParentProcessId: 1, UserModeTime: 100, KernelModeTime: 20 }])),
  });
  assert.equal(winProcessTreeCpuUsec(ok, 7), 12, 'a working probe yields a readable table');
});

test('8c. two-sided through the real policy: a quiet tree sleeps, a deep MCP child burning cpu keeps its session alive', () => {
  const now = Date.now();
  const tableAt = (mcpCpu100ns) => parseWinProcessTable(JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, UserModeTime: 10_000_000, KernelModeTime: 0 },
    { ProcessId: 200, ParentProcessId: 100, UserModeTime: 30_000_000, KernelModeTime: 0 },
    { ProcessId: 300, ParentProcessId: 200, UserModeTime: mcpCpu100ns, KernelModeTime: 0 },
  ]));
  // Sixty seconds pass between snapshots. The quiet tree gains 0.1s of cpu
  // (statusline-repaint scale); the busy one's MCP grandchild gains 30s (half
  // a core). The busy work is two levels below the keeper on purpose: the
  // whole point of the tree sum is that a background child's cpu vouches for
  // its session.
  const prevTable = tableAt(1_000_000);
  const prev = { cpuUsec: winProcessTreeCpuUsec(prevTable, 100), at: now - 60_000, idleChecks: 1 };
  const quiet = evaluate(stateAt(2 * HOUR), { now, policy, previous: prev, cpuUsec: winProcessTreeCpuUsec(tableAt(2_000_000), 100) });
  assert.equal(quiet.sleep, true, 'a genuinely quiet process tree must sleep');
  const busy = evaluate(stateAt(2 * HOUR), { now, policy, previous: prev, cpuUsec: winProcessTreeCpuUsec(tableAt(300_000_000), 100) });
  assert.equal(busy.sleep, false, 'an MCP grandchild burning half a core must keep the session alive');
  assert.match(busy.reason, /burning cpu/);
});

test('7. end to end: a real idle session is ended cleanly and says why, while a session still producing output is untouched', {
  skip: process.platform === 'win32' && 'posix pty harness',
}, async (t) => {
  // Everything real except the clock scale: a real daemon, real keepers, real
  // ptys, the real terminate path, the real exit record, a real process death.
  //
  // THE CPU GATE IS DELIBERATELY NEUTRALISED HERE (a busy fraction of 10 means
  // "never busy by cpu"), and saying so plainly matters more than the spec
  // looking thorough. A relocated harness store gets no scopes by design
  // (resolveUnitPolicy), so every session shares the daemon's cgroup, and the
  // FIRST version of this spec proved that the hard way: the idle session could
  // not sleep because it was reading its noisy neighbour's cpu. That is the
  // exact misattribution `cgroupCpuUsec` refuses in production, so reproducing
  // it here would test the harness, not the product. The cpu gate is proven
  // exhaustively against fakes in specs 1 and 4, including a pegged core at
  // four different sweep intervals; what THIS spec owns is the other signal
  // (pty activity) and the plumbing, neither of which a fake can prove.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dormancy-e2e-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_SESSIOND_RECONCILE_INTERVAL_MS: '400',
      HARBOR_SESSIOND_DORMANT_AFTER_MS: '1500',
      HARBOR_SESSIOND_DORMANT_REQUIRE_SCOPE: '0',
      HARBOR_SESSIOND_DORMANT_CPU_BUSY_FRACTION: '10',
      HARBOR_SESSIOND_ACTIVITY_PERSIST_MS: '100',
      HARBOR_NO_DAEMON_START: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const probe = new SessionClient({ socketPath });
      const result = await probe.request('health');
      probe.close();
      if (result.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`daemon never answered: ${stderr}`);
    await sleep(50);
  }
  const client = new SessionClient({ socketPath });
  t.after(async () => {
    try {
      const listed = await client.request('list');
      for (const s of listed.sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {});
    } catch {}
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((r) => daemon.once('exit', r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const idle = await client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'sleep 600'], cwd: dir, env: {}, cols: 80, rows: 24,
  });
  // Still talking: the keeper sees a byte every 200ms, so its activity stamp
  // never ages past the threshold. This is a real Claude session's spinner in
  // miniature, and it must be untouchable no matter how long it runs.
  const chatty = await client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'while :; do echo working; sleep 0.2; done'],
    cwd: dir, env: {}, cols: 80, rows: 24,
  });

  const until = Date.now() + 25000;
  let idleRow = null;
  while (Date.now() < until) {
    const listed = await client.request('list');
    idleRow = listed.sessions.find((s) => s.id === idle.id);
    if (idleRow && idleRow.exit) break;
    await sleep(200);
  }
  assert.ok(idleRow && idleRow.exit, 'the idle session must be put to sleep');
  assert.equal(idleRow.exit.dormant, true, 'the exit record must say this was deliberate, not a crash');
  assert.match(idleRow.exit.reason || '', /put to sleep to free memory/,
    'a user asking "where did my session go" must find the answer in the record');

  const after = await client.request('list');
  const chattyRow = after.sessions.find((s) => s.id === chatty.id);
  assert.ok(chattyRow, 'the working session must still be listed');
  assert.equal(chattyRow.exit, null,
    'a session still producing output must NEVER be put to sleep, however long it runs');

  // The point of the whole feature: the processes are actually gone.
  const idleState = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${idle.id}.json`), 'utf8'));
  assert.throws(() => process.kill(idleState.pid, 0),
    'a dormant session must actually release its process, or it has freed nothing');
});

test('7w. end to end on windows: a real idle session sleeps via the process-tree cpu signal, and a silent session burning cpu survives', {
  skip: process.platform !== 'win32' && 'windows conpty harness',
  timeout: 120_000,
}, async (t) => {
  // THE SPEC THAT WOULD HAVE CAUGHT 2026-08-20. Its posix sibling (spec 7) is
  // skipped on win32, so the platform Harbor actually runs on had NO end-to-end
  // dormancy proof, and the cgroup cpu read silently answered null (busy) for
  // every session: dormancy never fired once, 27 idle claude runtimes drove
  // the commit charge to the limit, and CLIs died of failed allocations the
  // moment a turn started. At HEAD-before-the-fix the idle half of this spec
  // FAILS (the session is never put to sleep); the busy half is the safety
  // proof that the new signal reads REAL process cpu, not a guess: the busy
  // session's pty is exactly as silent as the idle one's, so only the cpu
  // tree can tell them apart.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dormancy-win-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_SESSIOND_RECONCILE_INTERVAL_MS: '400',
      HARBOR_SESSIOND_DORMANT_AFTER_MS: '1500',
      HARBOR_SESSIOND_ACTIVITY_PERSIST_MS: '100',
      HARBOR_NO_DAEMON_START: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const probe = new SessionClient({ socketPath });
      const result = await probe.request('health');
      probe.close();
      if (result.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`daemon never answered: ${stderr}`);
    await sleep(50);
  }
  const client = new SessionClient({ socketPath });
  t.after(async () => {
    try {
      const listed = await client.request('list');
      for (const s of listed.sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {});
    } catch {}
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((r) => daemon.once('exit', r)); }
    // A just-killed conpty child can hold the dir (an open log, a lagging
    // process teardown) for a beat after terminate returns; retry, then leave
    // a stray tmpdir rather than fail a green spec on cleanup.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  });

  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const childEnv = {};
  for (const key of ['SystemRoot', 'windir', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  // Both ptys are SILENT after startup; only their cpu differs.
  // cwd is the TEMP root, not the store: a live child whose cwd is inside the
  // store would hold the directory against teardown's rm on windows.
  const idle = await client.request('spawn', {
    argv: [powershell, '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep 600'],
    cwd: os.tmpdir(), env: childEnv, cols: 80, rows: 24,
  });
  const busy = await client.request('spawn', {
    argv: [powershell, '-NoProfile', '-NonInteractive', '-Command', 'while($true){}'],
    cwd: os.tmpdir(), env: childEnv, cols: 80, rows: 24,
  });

  const until = Date.now() + 60_000;
  let idleRow = null;
  while (Date.now() < until) {
    const listed = await client.request('list');
    idleRow = listed.sessions.find((s) => s.id === idle.id);
    if (idleRow && idleRow.exit) break;
    await sleep(300);
  }
  assert.ok(idleRow && idleRow.exit, `the idle session must be put to sleep on windows: ${stderr}`);
  assert.equal(idleRow.exit.dormant, true, 'the exit record must say this was deliberate, not a crash');
  assert.match(idleRow.exit.reason || '', /put to sleep to free memory/);
  // The 2026-08-30 sessiond.log leak: dormant exits printed code=undefined
  // signal=undefined because ConPTY's onExit handed undefined through. Null
  // or a real number/signal are honest; the JS undefined / missing-key form
  // is not.
  assert.ok(Object.hasOwn(idleRow.exit, 'code'), 'dormant exit must carry an explicit code key');
  assert.ok(Object.hasOwn(idleRow.exit, 'signal'), 'dormant exit must carry an explicit signal key');
  assert.equal(idleRow.exit.code === null || typeof idleRow.exit.code === 'number', true,
    `dormant exit code must be null or a number, got ${String(idleRow.exit.code)}`);
  assert.equal(
    idleRow.exit.signal === null
      || typeof idleRow.exit.signal === 'number'
      || typeof idleRow.exit.signal === 'string',
    true,
    `dormant exit signal must be null or a real signal, got ${String(idleRow.exit.signal)}`,
  );

  const after = await client.request('list');
  const busyRow = after.sessions.find((s) => s.id === busy.id);
  assert.ok(busyRow, 'the busy session must still be listed');
  assert.equal(busyRow.exit, null,
    'a silent session burning a core must NEVER be put to sleep; only the cpu tree separates it from the idle one');

  const idleState = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', `${idle.id}.json`), 'utf8'));
  assert.throws(() => process.kill(idleState.pid, 0),
    'a dormant session must actually release its process, or it has freed nothing');
  const logText = fs.readFileSync(path.join(dir, 'sessiond.log'), 'utf8');
  const exitLine = logText.split('\n').find((line) => line.includes(`exit ${idle.id}`));
  assert.ok(exitLine, 'dormant exit must leave a sessiond.log line');
  assert.equal(exitLine.includes('undefined'), false,
    `dormant exit log must not print the JS undefined leak: ${exitLine}`);
});
