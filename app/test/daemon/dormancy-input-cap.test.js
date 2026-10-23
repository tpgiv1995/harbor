'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// DORMANCY ON macOS, IDLE FROM THE USER, AND A LIVE-SESSION CAP (2026-10-19).
//
// The measurement that forced this: a Mac with 97 live Claude sessions, 84 of
// them with no user message for 3+ days, and not one `dormant` line in the
// daemon log, ever. The cpu signal was a cgroup read that answers null on
// darwin (there is no /proc), evaluate() honestly read null as busy, and the
// boot line still said "dormancy on". Separately, the idle clock ran from pty
// OUTPUT, which a CLI redrawing on reattach moves for every session at once.
//
// Two-sided throughout, as in dormancy.test.js: every "this sleeps" sits next
// to the "this must not" that shares its conditions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dormancy = require('../../src/daemon/dormancy.js');
const { resolveDormancyPolicy, evaluate, sweepDormancy } = dormancy;
const { SessionClient } = require('../../src/daemon/client.js');

const DAEMON = path.resolve(__dirname, '../../src/daemon/daemon.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

// Real `ps -A -o pid=,ppid=,pgid=,time=` shape on macOS: right-aligned columns,
// unbounded minutes with centiseconds. The keeper (100) parents the CLI (200),
// which parents two MCP children; 400 reparented to launchd but stayed in the
// CLI's process group; 999 is a stranger.
const darwinPs = (mcpTime = '0:00.50') => [
  '    1     0     1 121:07.01',
  '  100     1   100   0:01.00',
  '  200   100   200   0:03.00',
  `  300   200   200   ${mcpTime}`,
  '  301   200   200   0:00.50',
  '  400     1   200   0:00.25',
  '  999     1   999 900:00.00',
  '',
].join('\n');

test('m1. the ps cpu time parser reads macOS and procps formats, and refuses anything else', () => {
  const { parsePsCpuTime } = dormancy;
  assert.equal(typeof parsePsCpuTime, 'function', 'dormancy.js must export a ps cpu-time parser');
  assert.equal(parsePsCpuTime('0:01.23'), 1_230_000);
  assert.equal(parsePsCpuTime('121:07.01'), (121 * 60 + 7.01) * 1_000_000, 'macOS minutes are unbounded');
  assert.equal(parsePsCpuTime('01:02:03'), 3723 * 1_000_000, 'procps hh:mm:ss');
  assert.equal(parsePsCpuTime('2-01:00:00'), (2 * 86400 + 3600) * 1_000_000, 'procps dd-hh:mm:ss');
  for (const bad of ['', '-', 'abc', '1:2:3:4', null]) assert.equal(parsePsCpuTime(bad), null, `refuses ${JSON.stringify(bad)}`);
});

test('m2. the darwin process table sums the keeper tree plus its process group, never a stranger, and refuses an unknown root', () => {
  const { parsePosixProcessTable, posixProcessTreeCpuUsec } = dormancy;
  const table = parsePosixProcessTable(darwinPs());
  assert.ok(table instanceof Map && table.size === 7);
  assert.equal(posixProcessTreeCpuUsec(table, 100, { groupPid: 200 }), 5_250_000,
    'keeper 1s + cli 3s + two MCP children 0.5s each + the reparented group member 0.25s');
  assert.equal(posixProcessTreeCpuUsec(table, 100), 5_000_000, 'without a group the reparented child is not reachable');
  assert.equal(posixProcessTreeCpuUsec(table, 4242, { groupPid: 200 }), null, 'an unknown keeper is not an idle keeper');
  assert.equal(posixProcessTreeCpuUsec(null, 100), null, 'a failed snapshot answers null, never zero');
  assert.equal(parsePosixProcessTable(''), null);
  assert.equal(parsePosixProcessTable('garbage line\n'), null);
  const cyclic = parsePosixProcessTable('10 20 10 0:01.00\n20 10 10 0:01.00\n');
  assert.equal(posixProcessTreeCpuUsec(cyclic, 10, { groupPid: 10 }), 2_000_000, 'a cycle is counted once');
});

test('m3. the ps snapshot survives a broken probe, and reads this very process on a real posix box', {
  skip: process.platform === 'win32' && 'posix ps',
}, async () => {
  const { posixCpuSnapshot, posixProcessTreeCpuUsec } = dormancy;
  const failed = await posixCpuSnapshot({ execFileImpl: (c, a, o, cb) => cb(new Error('ps missing')) });
  assert.equal(failed, null, 'a probe failure is null (busy), never a throw that kills the sweep');
  const started = Date.now();
  const real = await posixCpuSnapshot();
  const elapsed = Date.now() - started;
  assert.ok(real instanceof Map && real.has(process.pid), 'the real ps table must contain this test process');
  assert.ok(posixProcessTreeCpuUsec(real, process.pid) >= 0);
  assert.ok(elapsed < 5000, `one ps per sweep must be cheap; took ${elapsed}ms`);
});

test('m4. on darwin numbers, evaluate() decides: a quiet tree sleeps, an MCP child burning cpu keeps its session', () => {
  const { parsePosixProcessTable, posixProcessTreeCpuUsec } = dormancy;
  const policy = resolveDormancyPolicy({});
  const now = Date.now();
  const state = { id: 's', last_activity_at: iso(now - 2 * HOUR), keeper_pid: 100, pid: 200, exit: null };
  const read = (ps) => posixProcessTreeCpuUsec(parsePosixProcessTable(ps), 100, { groupPid: 200 });
  const previous = { cpuUsec: read(darwinPs('0:00.50')), at: now - MIN, idleChecks: 1 };
  const quiet = evaluate(state, { now, policy, previous, cpuUsec: read(darwinPs('0:00.60')) });
  assert.equal(quiet.sleep, true, `a quiet darwin tree must sleep: ${quiet.reason}`);
  const busy = evaluate(state, { now, policy, previous, cpuUsec: read(darwinPs('0:30.50')) });
  assert.equal(busy.sleep, false, 'an MCP child burning half a core must keep the session alive');
  assert.match(busy.reason, /burning cpu/);
});

test('m5. idle runs from the last INPUT, and recent output still vetoes', () => {
  const policy = resolveDormancyPolicy({});
  const now = Date.now();
  const previous = { cpuUsec: 1000, at: now - MIN, idleChecks: 1 };
  const at = (inputAgo, outputAgo) => ({
    id: 's', keeper_pid: 1, exit: null,
    last_activity_at: iso(now - outputAgo),
    ...(inputAgo === null ? {} : { last_input_at: iso(now - inputAgo) }),
  });

  // THE REDRAW SHAPE: nobody typed for three days; the app reattached 20
  // minutes ago and the CLI redrew its screen.
  const redraw = evaluate(at(72 * HOUR, 20 * MIN), { now, policy, previous, cpuUsec: 1000 });
  assert.equal(redraw.sleep, true, `three days without input must sleep despite a 20m-old redraw: ${redraw.reason}`);
  assert.match(redraw.reason, /idle for 4320m/, 'the idle figure is measured from the input');

  const drawing = evaluate(at(72 * HOUR, 30 * 1000), { now, policy, previous, cpuUsec: 1000 });
  assert.equal(drawing.sleep, false, 'output in the last few minutes (a spinner) must keep the session');
  assert.match(drawing.reason, /output/);

  const typed = evaluate(at(5 * MIN, 2 * HOUR), { now, policy, previous, cpuUsec: 1000 });
  assert.equal(typed.sleep, false, 'a person typed five minutes ago: active, however long the pty has been quiet');

  const oldKeeper = evaluate(at(null, 2 * HOUR), { now, policy, previous, cpuUsec: 1000 });
  assert.equal(oldKeeper.sleep, true, 'a keeper without last_input_at keeps the pty-silence rule');
  const oldKeeperRedraw = evaluate(at(null, 20 * MIN), { now, policy, previous, cpuUsec: 1000 });
  assert.equal(oldKeeperRedraw.sleep, false, 'and without an input stamp a recent redraw still reads as active');
});

test('m6. terminal replies are not a person typing', () => {
  const { isTerminalReply } = require('../../src/daemon/input-intent.js');
  for (const reply of ['\x1b[I', '\x1b[O', '\x1b[O\x1b[I', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c',
    '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1bP>|xterm.js(5.5.0)\x1b\\', '\x1b[<0;10;5M', '\x1b[?2026;2$y', '\x1b[8;24;80t']) {
    assert.equal(isTerminalReply(reply), true, `${JSON.stringify(reply)} is a terminal reply`);
  }
  for (const input of ['a', '\r', '\x03', '\x1b', '\x1b[A', '\x1b[3~', '\x1b[200~pasted\x1b[201~', '\x1b[Ihello', '']) {
    assert.equal(isTerminalReply(input), false, `${JSON.stringify(input)} is input`);
  }
});

function capStates(now) {
  const s = (id, touchedAgo, extra = {}) => ({
    id, keeper_pid: 1, exit: null, created_at: iso(now - 10 * HOUR),
    last_activity_at: iso(now - touchedAgo), last_input_at: iso(now - touchedAgo), ...extra,
  });
  return [
    s('r1', 40 * MIN), s('r2', 50 * MIN), // the two most recent: protected by the cap of 2
    s('a', 3 * HOUR),
    s('b', 4 * HOUR),                     // burning cpu
    s('c', 5 * HOUR, { created_at: iso(now - 5 * HOUR) }), // younger than the age floor
    s('d', 6 * HOUR),                     // showing a permission prompt
    s('e', 7 * HOUR),                     // transcript still being written
    s('f', 8 * HOUR),
    s('g', 9 * HOUR),
  ];
}

async function runCapSweeps(policy, passes = 3) {
  let clock = Date.now();
  const states = capStates(clock);
  const cpu = Object.fromEntries(states.map((st) => [st.id, 1_000_000]));
  const watch = new Map();
  const ended = [];
  const logs = [];
  for (let i = 0; i < passes; i += 1) {
    await sweepDormancy({
      states: states.filter((st) => !ended.some(([id]) => id === st.id)),
      now: clock, policy, watch,
      readCpu: (st) => cpu[st.id],
      readScreen: async (st) => (st.id === 'd'
        ? 'Do you want to run SECRET-PROMPT-TEXT?\n ❯ 1. Yes\n   2. No\n Esc to cancel'
        : 'done\n────────\n❯ '),
      workFresh: async (st) => st.id === 'e',
      terminate: async (st, verdict) => { ended.push([st.id, verdict.reason]); },
      log: (m) => logs.push(m),
    });
    clock += MIN;
    cpu.b += 30_000_000;
  }
  return { ended, logs, watch };
}

test('m7. the live cap evicts the longest-idle sessions first, and never a protected, busy, new, blocked or working one', async () => {
  const policy = resolveDormancyPolicy({
    HARBOR_SESSIOND_DORMANT_AFTER_MS: String(24 * HOUR), // the idle sweep alone would end nothing here
    HARBOR_SESSIOND_MAX_LIVE_SESSIONS: '2',
    HARBOR_SESSIOND_CAP_MIN_AGE_MS: String(6 * HOUR),
  });
  assert.equal(policy.maxLive, 2, 'HARBOR_SESSIOND_MAX_LIVE_SESSIONS sets the cap');
  const { ended, logs } = await runCapSweeps(policy);
  assert.deepEqual(ended.map(([id]) => id), ['g', 'f', 'a'],
    'oldest-by-input first; b (busy), c (too new), d (needs an answer), e (fresh work), r1/r2 (most recent) all survive');
  for (const [, reason] of ended) {
    assert.match(reason, /over the live-session cap/);
    assert.match(reason, /Resume it from the rail/, 'the same dormant reason contract the rail shows');
  }
  const summary = logs.filter((l) => l.startsWith('dormancy sweep:'));
  assert.ok(summary.some((l) => /cap=2/.test(l) && /still_over=4/.test(l)), `the sweep line carries the cap verdict: ${summary.join(' | ')}`);
  assert.ok(logs.every((l) => !/SECRET-PROMPT-TEXT/.test(l)), 'no screen or prompt text is ever logged');
});

test('m8. cap off (the default) changes nothing: the same sessions, the same passes, nothing ended', async () => {
  const policy = resolveDormancyPolicy({ HARBOR_SESSIOND_DORMANT_AFTER_MS: String(24 * HOUR) });
  assert.equal(resolveDormancyPolicy({}).maxLive, 0, 'the cap is off unless configured');
  assert.equal(resolveDormancyPolicy({}).afterMs, HOUR, 'the idle threshold default is unchanged');
  const { ended, watch } = await runCapSweeps(policy);
  assert.deepEqual(ended, [], 'without a cap no session under the idle threshold is ever ended');
  for (const sample of watch.values()) assert.equal(sample.capChecks, undefined, 'no cap state is kept when the cap is off');
});

test('m9. the cap never evicts below its idle floor, even beyond the most recent N', async () => {
  const policy = resolveDormancyPolicy({ HARBOR_SESSIOND_DORMANT_AFTER_MS: String(24 * HOUR), HARBOR_SESSIOND_MAX_LIVE_SESSIONS: '1' });
  let clock = Date.now();
  const mk = (id, ago) => ({ id, keeper_pid: 1, exit: null, created_at: iso(clock - 10 * HOUR), last_activity_at: iso(clock - ago), last_input_at: iso(clock - ago) });
  const states = [mk('x', 5 * MIN), mk('y', 10 * MIN)];
  const watch = new Map();
  const ended = [];
  for (let i = 0; i < 3; i += 1) {
    await sweepDormancy({ states, now: clock, policy, watch, readCpu: () => 1, terminate: async (st) => { ended.push(st.id); }, log: () => {} });
    clock += MIN;
  }
  assert.deepEqual(ended, [], 'a session touched ten minutes ago is in use, cap or no cap');
});

test('m10. config.json `sessiond` sets the knobs, the environment outranks it, and null never means off', () => {
  const fromConfig = resolveDormancyPolicy({}, { dormantAfterMinutes: 240, maxLiveSessions: 32 });
  assert.equal(fromConfig.afterMs, 4 * HOUR, 'dormantAfterMinutes: 240 is a four-hour threshold');
  assert.equal(fromConfig.maxLive, 32);
  const envWins = resolveDormancyPolicy({ HARBOR_SESSIOND_DORMANT_AFTER_MS: String(HOUR), HARBOR_SESSIOND_MAX_LIVE_SESSIONS: '5' },
    { dormantAfterMinutes: 240, maxLiveSessions: 32 });
  assert.equal(envWins.afterMs, HOUR);
  assert.equal(envWins.maxLive, 5);
  const nulls = resolveDormancyPolicy({}, { dormantAfterMinutes: null, maxLiveSessions: null });
  assert.equal(nulls.enabled, true, 'a null threshold is "not set", never "disabled"');
  assert.equal(nulls.afterMs, HOUR);
  assert.equal(nulls.maxLive, 0);
  assert.equal(resolveDormancyPolicy({}, { dormantAfterMinutes: 0 }).enabled, false, '0 is the explicit off switch');
});

async function startDaemon(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dorm-cap-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_SESSIOND_RECONCILE_INTERVAL_MS: '400',
      HARBOR_SESSIOND_ACTIVITY_PERSIST_MS: '100',
      HARBOR_NO_DAEMON_START: '1',
      ...extraEnv,
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
  return { dir, client, stderr: () => stderr, log: () => { try { return fs.readFileSync(path.join(dir, 'sessiond.log'), 'utf8'); } catch { return ''; } } };
}

test('m11. end to end on posix with the REAL cpu gate: a silent idle session sleeps, a silent session burning cpu survives', {
  skip: process.platform === 'win32' && 'posix pty harness',
  timeout: 90_000,
}, async (t) => {
  // Spec 7's sibling with the cpu gate LIVE. On macOS at pat/main the idle half
  // fails (every cpu read is null, so nothing ever sleeps); the busy half is
  // the proof that the ps tree reads real cpu, since both ptys are silent.
  const { client, stderr, log } = await startDaemon(t, { HARBOR_SESSIOND_DORMANT_AFTER_MS: '1500', HARBOR_SESSIOND_DORMANT_REQUIRE_SCOPE: '0' });
  const idle = await client.request('spawn', { argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'sleep 600'], cwd: os.tmpdir(), env: {}, cols: 80, rows: 24 });
  const busy = await client.request('spawn', { argv: ['/bin/bash', '--noprofile', '--norc', '-c', 'while :; do :; done'], cwd: os.tmpdir(), env: {}, cols: 80, rows: 24 });
  const until = Date.now() + 40_000;
  let idleRow = null;
  while (Date.now() < until) {
    const listed = await client.request('list');
    idleRow = listed.sessions.find((s) => s.id === idle.id);
    if (idleRow && idleRow.exit) break;
    await sleep(200);
  }
  assert.ok(idleRow && idleRow.exit, `the idle session must be put to sleep: ${stderr()}\n${log()}`);
  assert.equal(idleRow.exit.dormant, true);
  const busyRow = (await client.request('list')).sessions.find((s) => s.id === busy.id);
  assert.equal(busyRow && busyRow.exit, null, 'a silent session burning a core must never be put to sleep');
  if (process.platform === 'darwin') {
    assert.match(log(), /cpu signal: ps keeper process-tree cpu time/, 'the boot line names the darwin signal honestly');
  }
  assert.match(log(), /dormancy sweep: live=\d+ slept=1/, 'the sweep logs its decision compactly');
});

test('m12. the keeper stamps last_input_at on typing, and not on a terminal reply', {
  skip: process.platform === 'win32' && 'posix pty harness',
  timeout: 60_000,
}, async (t) => {
  const { dir, client } = await startDaemon(t, { HARBOR_SESSIOND_DORMANT_AFTER_MS: '0' });
  const session = await client.request('spawn', { argv: ['/bin/cat'], cwd: os.tmpdir(), env: {}, cols: 80, rows: 24 });
  const stateFile = path.join(dir, 'sessions', `${session.id}.json`);
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(Date.parse(read().last_input_at), 'a new keeper writes last_input_at from spawn');
  const spawnedInput = read().last_input_at;

  await sleep(300);
  await client.request('input', { id: session.id, text: '\x1b[I' }); // focus in
  await client.request('input', { id: session.id, text: '\x1b[12;40R' }); // a cursor report
  await sleep(400);
  await client.request('input', { id: session.id, text: '\x1b[O' }); // forces a persist past the throttle
  await sleep(300);
  assert.equal(read().last_input_at, spawnedInput, 'focus events and terminal reports are not a person typing');

  await sleep(200);
  await client.request('input', { id: session.id, text: 'hello\r' });
  const until = Date.now() + 5000;
  while (Date.now() < until && read().last_input_at === spawnedInput) await sleep(100);
  assert.ok(Date.parse(read().last_input_at) > Date.parse(spawnedInput), 'typing moves last_input_at');
});

test('m13. the daemon reads config.json `sessiond` and picks up an edit without a restart', {
  skip: process.platform === 'win32' && 'posix harness',
  timeout: 60_000,
}, async (t) => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dorm-cfg-'));
  t.after(() => fs.rmSync(cfgDir, { recursive: true, force: true }));
  const configFile = path.join(cfgDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 1, sessiond: { dormantAfterMinutes: 240, maxLiveSessions: 32 } }));
  const env = { HARBOR_CONFIG_FILE: configFile };
  const { client, log } = await startDaemon(t, env);
  let health = await client.request('health');
  assert.equal(health.dormancy.after_ms, 4 * HOUR, 'dormantAfterMinutes reaches the daemon');
  assert.equal(health.dormancy.max_live, 32, 'maxLiveSessions reaches the daemon');

  fs.writeFileSync(configFile, JSON.stringify({ version: 1, sessiond: { dormantAfterMinutes: 120, maxLiveSessions: 8 } }));
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    health = await client.request('health');
    if (health.dormancy.max_live === 8) break;
    await sleep(200);
  }
  assert.equal(health.dormancy.max_live, 8, 'an edited config takes effect at the next sweep');
  assert.equal(health.dormancy.after_ms, 2 * HOUR);
  assert.match(log(), /dormancy policy changed: idle after 240m, live cap 32 -> idle after 120m, live cap 8/);
});
