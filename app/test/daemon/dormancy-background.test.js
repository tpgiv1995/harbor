'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A SESSION WAITING ON ITS OWN BACKGROUND WORK IS NOT IDLE (2026-10-24).
//
// Pat: "astra takes fucking forever to run but its fine as long as the
// orchestrator ... can stay alive and just handle it once its done". A
// coordinator session launched a long codex run as a background Bash call,
// ended its turn to wait for the completion notice, and was put to sleep "idle
// for 70m with no cpu" five seconds after the run last wrote to its log: the
// kill took the run and the session's watcher with it, and nothing woke anyone.
// The pty was silent (the turn had ended) and the cpu was flat (a codex agent
// waiting on its model burns well under 5% of a core), so both cheap signals
// condemned a session that was doing exactly what it was asked to do.
//
// Every spec here is two-sided for the same reason dormancy.test.js gives: a
// veto that never fires and a veto that always fires each pass a one-sided
// test. The record shapes are the CLI's own (2.1.303), with neutral content.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  resolveDormancyPolicy, sweepDormancy,
  applyBackgroundRecord, outstandingBackgroundWork, transcriptBackgroundWork, BACKGROUND_IDLE_MARKER,
} = require('../../src/daemon/dormancy.js');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { SessionClient } = require('../../src/daemon/client.js');

const DAEMON = path.resolve(__dirname, '../../src/daemon/daemon.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HOUR = 60 * 60 * 1000;
const MAX = 9 * HOUR;
const T0 = Date.parse('2026-10-24T09:51:59.791Z');
const iso = (ms) => new Date(ms).toISOString();

// The CLI's record shapes, field for field, with neutral content.
const shellLaunch = (id, at, outputFile = `C:\\tmp\\tasks\\${id}.output`) => ({
  type: 'user', timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Command running in background with ID: ${id}. Output is being written to: ${outputFile}. You will be notified when it completes.` }] },
  toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: id },
});
const monitorLaunch = (id, at, timeoutMs = 600_000, persistent = false) => ({
  type: 'user', timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Monitor started (task ${id}, expires in ${timeoutMs / 60000}m unless the source ends first).` }] },
  toolUseResult: { taskId: id, timeoutMs, persistent },
});
const agentLaunch = (id, at) => ({
  type: 'user', timestamp: iso(at),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Async agent launched successfully.\nagentId: ${id}` }] },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId: id, description: 'research', prompt: 'read only' },
});
const notice = (ids, status, extra = '') => `<task-notification>\n${[].concat(ids).map((id) => `<task-id>${id}</task-id>`).join('\n')}\n<status>${status}</status>\n<summary>Background command "job" ${status}</summary>${extra}\n</task-notification>`;
const userNotice = (ids, status, at) => ({ type: 'user', timestamp: iso(at), message: { role: 'user', content: notice(ids, status) } });
const queuedNotice = (ids, status, at) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), content: notice(ids, status) });
const taskStop = (id, at) => ({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_stop', name: 'TaskStop', input: { task_id: id } }] } });

function fold(records) {
  const tasks = new Map();
  for (const record of records) applyBackgroundRecord(tasks, record, JSON.stringify(record));
  return tasks;
}
const pendingIds = (records, now, opts = {}) => outstandingBackgroundWork(fold(records), { since: 0, now, maxAgeMs: MAX, ...opts }).map((task) => task.id);

test('B1. every launch shape is owed an ending, and every ending shape pays it', () => {
  const now = T0 + 2 * HOUR;
  for (const [name, launch, id] of [
    ['background Bash', shellLaunch('bshell0001', T0), 'bshell0001'],
    ['background agent', agentLaunch('a0123456789abcdef', T0), 'a0123456789abcdef'],
    ['persistent Monitor', monitorLaunch('bmon00001', T0, 600_000, true), 'bmon00001'],
  ]) {
    assert.deepEqual(pendingIds([launch], now), [id], `${name}: a launch with no ending must hold its session`);
    for (const [how, ending] of [
      ['a delivered notice', userNotice(id, 'completed', T0 + 60_000)],
      ['a notice queued mid-turn', queuedNotice(id, 'killed', T0 + 60_000)],
      ['a failed notice', userNotice(id, 'failed', T0 + 60_000)],
      ['a TaskStop', taskStop(id, T0 + 60_000)],
    ]) {
      assert.deepEqual(pendingIds([launch, ending], now), [], `${name}: ${how} must end it`);
    }
  }
  // The resume-time orphan notice ends every id it lists at once.
  const orphan = { type: 'user', timestamp: iso(T0 + 60_000), message: { role: 'user', content: notice(['bshell0001', 'bshell0002', '__orphan_summary__:shell'], 'stopped') } };
  assert.deepEqual(pendingIds([shellLaunch('bshell0001', T0), shellLaunch('bshell0002', T0), orphan], now), []);
});

test('B2. only a terminal status ends work, and the model quoting a notice ends nothing', () => {
  const now = T0 + HOUR;
  const launch = monitorLaunch('bmon00002', T0, 3 * HOUR);
  // A Monitor delivers an event notice per line it sees; those carry no status.
  const event = { type: 'user', timestamp: iso(T0 + 60_000), message: { role: 'user', content: '<task-notification>\n<task-id>bmon00002</task-id>\n<summary>Monitor event: "suite"</summary>\n<event>progress bytes 53</event>\n</task-notification>' } };
  assert.deepEqual(pendingIds([launch, event], now), ['bmon00002'], 'a progress event is not an ending');
  const expired = { type: 'user', timestamp: iso(T0 + 60_000), message: { role: 'user', content: '<task-notification>\n<task-id>bmon00002</task-id>\n<summary>Monitor event: "suite"</summary>\n<event>[Monitor expired after 10m with no events delivered.]</event>\n</task-notification>' } };
  assert.deepEqual(pendingIds([launch, expired], now), [], 'a Monitor expiry is an ending');

  // THE SAFETY HALF: an assistant message that quotes a completion notice for a
  // task that is still running must not end it, or the model talking about its
  // work would hand dormancy permission to kill that work.
  const shell = shellLaunch('bshell0003', T0);
  const quoted = { type: 'assistant', timestamp: iso(T0 + 60_000), message: { role: 'assistant', content: [{ type: 'text', text: `It will look like ${notice('bshell0003', 'completed')}` }] } };
  assert.deepEqual(pendingIds([shell, quoted], now), ['bshell0003']);
});

test('B3. the bounds: this keeper\'s launches only, a maximum age, a Monitor\'s own expiry, and 0 turns it off', () => {
  const launch = shellLaunch('bshell0004', T0);
  assert.deepEqual(pendingIds([launch], T0 + HOUR, { since: T0 + 1 }), [],
    'a launch from before this keeper started died with the old process');
  assert.deepEqual(pendingIds([launch], T0 + HOUR, { since: T0 }), ['bshell0004']);
  assert.deepEqual(pendingIds([launch], T0 + MAX - 1), ['bshell0004']);
  assert.deepEqual(pendingIds([launch], T0 + MAX), [], 'a launch older than the cap no longer holds (a missed ending cannot pin a session)');
  assert.deepEqual(pendingIds([launch], T0 + HOUR, { maxAgeMs: 0 }), [], '0 turns the background veto off');
  assert.deepEqual(pendingIds([launch], T0 - 1), [], 'a launch later than the moment asked about is not owed yet');

  const monitor = monitorLaunch('bmon00003', T0, 600_000);
  assert.deepEqual(pendingIds([monitor], T0 + 14 * 60_000), ['bmon00003'], 'inside expiry plus grace the Monitor holds');
  assert.deepEqual(pendingIds([monitor], T0 + 16 * 60_000), [], 'past its declared expiry plus grace it does not');

  assert.equal(resolveDormancyPolicy({}).backgroundMaxMs, MAX);
  assert.equal(resolveDormancyPolicy({ HARBOR_SESSIOND_DORMANT_BACKGROUND_MAX_MS: '0' }).backgroundMaxMs, 0);
});

test('B4. the reader: incremental, safe across chunk and multibyte boundaries, and silent about a missing file', async () => {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-bgwork-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    // Noise the scan must skip, including multibyte text and a bookkeeping
    // record, around the launch.
    const noise = (n) => JSON.stringify({ type: 'assistant', timestamp: iso(T0), message: { role: 'assistant', content: [{ type: 'text', text: `ünïcødé ✓ line ${n} `.repeat(20) }] } });
    fs.writeFileSync(file, [noise(1), JSON.stringify(shellLaunch('bshell0005', T0)), noise(2), '{"type":"last-prompt","lastPrompt":"x"}', ''].join('\n'));
    const cache = new Map();
    const ask = (opts = {}) => transcriptBackgroundWork(file, { since: 0, now: T0 + HOUR, maxAgeMs: MAX, cache, ...opts });

    assert.deepEqual((await ask()).map((t) => t.id), ['bshell0005']);
    // Seven-byte chunks cut every multibyte character and every line; a fresh
    // cache must reach the same answer.
    assert.deepEqual((await ask({ cache: new Map(), chunkBytes: 7 })).map((t) => t.id), ['bshell0005']);

    const offsetBefore = cache.get(file).offset;
    fs.appendFileSync(file, `${JSON.stringify(userNotice('bshell0005', 'completed', T0 + 60_000))}\n`);
    assert.deepEqual(await ask(), [], 'an ending appended later is read on the next ask');
    assert.ok(cache.get(file).offset > offsetBefore, 'the second ask reads only what was appended');

    // A rewritten (shorter) file is rescanned from the start, not misread.
    fs.writeFileSync(file, `${JSON.stringify(shellLaunch('bshell0006', T0))}\n`);
    assert.deepEqual((await ask()).map((t) => t.id), ['bshell0006']);

    assert.deepEqual(await transcriptBackgroundWork(path.join(dir, 'absent.jsonl'), { now: T0, maxAgeMs: MAX }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('B7. a command launched inside a background agent holds the session after the agent itself finishes', async () => {
  // Measured live: an agent's background suite is launched in the agent's own
  // transcript, and its completion notice lands in the session's main one.
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-bgwork-agent-'));
  try {
    const main = path.join(dir, 'main.jsonl');
    const agent = path.join(dir, 'agent-a0123456789abcdef.jsonl');
    const lines = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
    fs.writeFileSync(main, lines([agentLaunch('a0123456789abcdef', T0), userNotice('a0123456789abcdef', 'completed', T0 + 60_000)]));
    fs.writeFileSync(agent, lines([{ ...shellLaunch('bsuite0001', T0 + 30_000), isSidechain: true, agentId: 'a0123456789abcdef' }]));
    const ask = (files) => transcriptBackgroundWork(files, { since: 0, now: T0 + HOUR, maxAgeMs: MAX, cache: new Map() });
    assert.deepEqual(await ask(main), [], 'the main transcript alone says the agent is done');
    assert.deepEqual((await ask([main, agent])).map((t) => t.id), ['bsuite0001'],
      'read as a tree, the suite the agent left running still holds the session');
    fs.appendFileSync(main, lines([queuedNotice('bsuite0001', 'completed', T0 + 2 * HOUR)]));
    assert.deepEqual(await ask([main, agent]), [], 'an ending in the main transcript ends a launch recorded in the agent transcript');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('B8. a waiting command can let its session go with an idle line, and takes the hold back with any newer line', async () => {
  // The session watcher's shape: it holds while it has jobs, then lingers idle
  // so its exit cannot wake the session, and relies on the sleep to end it.
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-bgwork-idle-'));
  try {
    const out = path.join(dir, 'bwatch0001.output');
    const transcript = path.join(dir, 'main.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify(shellLaunch('bwatch0001', T0, out))}\n`);
    const ask = () => transcriptBackgroundWork(transcript, { since: 0, now: T0 + HOUR, maxAgeMs: MAX, cache: new Map() });
    assert.deepEqual((await ask()).map((t) => t.id), ['bwatch0001'], 'no output file yet: the hold stands');
    fs.writeFileSync(out, 'watching 2 job(s)\n');
    assert.deepEqual((await ask()).map((t) => t.id), ['bwatch0001'], 'a working watcher holds its session');
    fs.appendFileSync(out, `${BACKGROUND_IDLE_MARKER} no jobs left; waiting only for the session's next turn\r\n\r\n`);
    assert.deepEqual(await ask(), [], 'the idle line as the newest output releases the session');
    fs.appendFileSync(out, 'watching 1 job(s)\n');
    assert.deepEqual((await ask()).map((t) => t.id), ['bwatch0001'], 'any newer line takes the hold back');
    // The marker only counts as the NEWEST line, never somewhere in the middle,
    // and a command whose output is redirected elsewhere (the Astra shape) never
    // writes one, so it always holds.
    fs.writeFileSync(out, `${BACKGROUND_IDLE_MARKER} early\nreal work continues\n`);
    assert.deepEqual((await ask()).map((t) => t.id), ['bwatch0001']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('B5. the 2026-10-24 kill, replayed through the real sweep: held while its run is out, slept once it reports', async () => {
  // The coordinator's own sequence: two background launches (the codex run and
  // the watcher), the turn ends, and 70 minutes of silence follow. The sibling
  // is the same shape with both endings recorded, so the same passes must end
  // it: a veto that holds everything would fail here.
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-bgwork-sweep-'));
  try {
    const waiting = path.join(dir, 'waiting.jsonl');
    const finished = path.join(dir, 'finished.jsonl');
    const lines = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
    const launches = [shellLaunch('bfkzrs0q5', T0), shellLaunch('bd0htp2ed', T0 + 1500)];
    fs.writeFileSync(waiting, lines(launches));
    fs.writeFileSync(finished, lines([...launches, userNotice('bfkzrs0q5', 'completed', T0 + HOUR), userNotice('bd0htp2ed', 'completed', T0 + HOUR)]));

    const policy = resolveDormancyPolicy({});
    const created = T0 - 10 * HOUR;
    const lastActivity = T0 + 2 * HOUR; // the turn ended about two hours after the launches
    const mk = (id) => ({ id, created_at: iso(created), last_activity_at: iso(lastActivity), keeper_pid: 1, exit: null });
    const files = { waiting, finished };
    const cache = new Map();
    const workFresh = async (state) => {
      const pending = await transcriptBackgroundWork(files[state.id], { since: Date.parse(state.created_at), now: clock, maxAgeMs: policy.backgroundMaxMs, cache });
      return pending.length ? `still waiting on background work it started (${pending.map((t) => `${t.kind} ${t.id}`).join(', ')})` : false;
    };
    const ended = [];
    const logged = [];
    const watch = new Map();
    let clock = lastActivity + 70 * 60_000; // the moment of the real kill
    for (let i = 0; i < 4; i += 1) {
      await sweepDormancy({
        states: [mk('waiting'), mk('finished')], now: clock, policy, watch,
        readCpu: () => 1_000_000, workFresh,
        terminate: async (s) => { ended.push(s.id); },
        log: (line) => logged.push(line),
      });
      clock += 60_000;
    }
    assert.deepEqual(ended, ['finished'], 'only the session with nothing outstanding may be slept');
    assert.ok(logged.some((line) => /waiting is pty-idle but still waiting on background work it started \(shell bfkzrs0q5, shell bd0htp2ed\)/.test(line)),
      `the hold must name what it is waiting on: ${logged.join(' | ')}`);

    // The run reports; the held session is now an ordinary idle one.
    fs.appendFileSync(waiting, lines([userNotice(['bfkzrs0q5'], 'completed', clock), userNotice(['bd0htp2ed'], 'completed', clock)]));
    for (let i = 0; i < 4 && !ended.includes('waiting'); i += 1) {
      await sweepDormancy({
        states: [mk('waiting')], now: clock, policy, watch,
        readCpu: () => 1_000_000, workFresh,
        terminate: async (s) => { ended.push(s.id); },
        log: () => {},
      });
      clock += 60_000;
    }
    assert.deepEqual(ended, ['finished', 'waiting'], 'once its work has reported, the waiting session sleeps like any other');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test('B6. end to end on windows: the real daemon keeps a session whose background work is out, and sleeps its finished twin', {
  skip: process.platform !== 'win32' && 'windows conpty harness (spec 7w is its sibling)',
  timeout: 150_000,
}, async (t) => {
  // Everything real except the clock scale and the home folder: a real daemon
  // and keepers, the real process-tree cpu signal, and the daemon's own
  // transcript lookup (sessionWorkFresh) reading fixture transcripts under a
  // temporary USERPROFILE. Three sessions with identical, silent ptys:
  //   waiting   a background launch made after its keeper started, no ending
  //   finished  the same launch with its completion notice
  //   resumed   a launch from before its keeper started (an old process life)
  // Only `waiting` may survive; then its notice lands and it must sleep too.
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-bgwork-e2e-'));
  const home = path.join(dir, 'home');
  const projectDir = path.join(home, '.claude', 'projects', 'C--work');
  fs.mkdirSync(projectDir, { recursive: true });
  const store = path.join(dir, 'store');
  fs.mkdirSync(store);
  const socketPath = path.join(store, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      HARBOR_SESSIOND_DIR: store,
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
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  });

  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const childEnv = {};
  for (const key of ['SystemRoot', 'windir', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const sessionIds = {
    waiting: '11111111-1111-4111-8111-111111111111',
    finished: '22222222-2222-4222-8222-222222222222',
    resumed: '33333333-3333-4333-8333-333333333333',
    agentwork: '44444444-4444-4444-8444-444444444444',
  };
  const spawned = {};
  for (const [name, agentSession] of Object.entries(sessionIds)) {
    spawned[name] = await client.request('spawn', {
      argv: [powershell, '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep 600'],
      cwd: os.tmpdir(), env: childEnv, cols: 80, rows: 24,
      agent: 'claude', agent_session: agentSession,
    });
  }
  const createdAt = (name) => Date.parse(JSON.parse(fs.readFileSync(path.join(store, 'sessions', `${spawned[name].id}.json`), 'utf8')).created_at);
  const write = (name, records) => fs.writeFileSync(path.join(projectDir, `${sessionIds[name]}.jsonl`), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  // Launch records sit just after (or, for `resumed`, just before) the keeper's
  // start, so they are older than the 1.5s freshness window by the time the
  // sweep asks: the hold can only come from the background veto.
  write('waiting', [shellLaunch('bwait00001', createdAt('waiting') + 1)]);
  write('finished', [shellLaunch('bdone00001', createdAt('finished') + 1), userNotice('bdone00001', 'completed', createdAt('finished') + 2)]);
  write('resumed', [shellLaunch('bold000001', createdAt('resumed') - 60_000)]);
  // agentwork: its background agent finished, but a command the agent launched
  // (recorded only in the agent's transcript) is still out.
  write('agentwork', [agentLaunch('a4444444444444444', createdAt('agentwork') + 1), userNotice('a4444444444444444', 'completed', createdAt('agentwork') + 3)]);
  const agentDir = path.join(projectDir, sessionIds.agentwork, 'subagents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'agent-a4444444444444444.jsonl'), `${JSON.stringify({ ...shellLaunch('bagent0001', createdAt('agentwork') + 2), isSidechain: true })}\n`);

  const rows = async () => Object.fromEntries((await client.request('list')).sessions.map((s) => [s.id, s]));
  const until = Date.now() + 60_000;
  let now = {};
  while (Date.now() < until) {
    now = await rows();
    if (now[spawned.finished.id]?.exit && now[spawned.resumed.id]?.exit) break;
    await sleep(300);
  }
  assert.ok(now[spawned.finished.id]?.exit?.dormant, `the session whose work reported must be put to sleep: ${stderr}`);
  assert.ok(now[spawned.resumed.id]?.exit?.dormant, 'a launch from an earlier process life must not hold the session');
  // Give the waiting session several more sweeps than its twins needed.
  await sleep(4000);
  now = await rows();
  assert.equal(now[spawned.waiting.id]?.exit, null,
    'a session whose background work is still out must NEVER be put to sleep, however quiet it is');
  assert.equal(now[spawned.agentwork.id]?.exit, null,
    'a command left running by a finished background agent must hold its session too');
  const logText = fs.readFileSync(path.join(store, 'sessiond.log'), 'utf8');
  assert.match(logText, new RegExp(`${spawned.waiting.id} is pty-idle but still waiting on background work it started \\(shell bwait00001\\)`));

  assert.match(logText, new RegExp(`${spawned.agentwork.id} is pty-idle but still waiting on background work it started \\(shell bagent0001\\)`));

  // The work reports; the held sessions must now sleep like any other.
  fs.appendFileSync(path.join(projectDir, `${sessionIds.waiting}.jsonl`), `${JSON.stringify(userNotice('bwait00001', 'completed', Date.now() - 5000))}\n`);
  fs.appendFileSync(path.join(projectDir, `${sessionIds.agentwork}.jsonl`), `${JSON.stringify(queuedNotice('bagent0001', 'completed', Date.now() - 5000))}\n`);
  const until2 = Date.now() + 60_000;
  while (Date.now() < until2) {
    now = await rows();
    if (now[spawned.waiting.id]?.exit && now[spawned.agentwork.id]?.exit) break;
    await sleep(300);
  }
  assert.ok(now[spawned.waiting.id]?.exit?.dormant, 'once its background work reports, the held session sleeps');
  assert.ok(now[spawned.agentwork.id]?.exit?.dormant, 'once the agent\'s command reports, that session sleeps too');
});
