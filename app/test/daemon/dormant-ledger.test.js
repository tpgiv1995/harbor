'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// THE SLEEP LEDGER (2026-10-06). The exit record that says a session was put
// to sleep is reaped five minutes after the exit, so the daemon keeps one
// lasting fact per provider session id: when it last put that session to
// sleep. The rail uses it to tell "Harbor put this to sleep" from "not
// running". Pure rules first, then the real daemon end to end, two-sided: a
// dormancy sleep must be recorded, and a later ordinary close must clear it.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { readLedger, noteExit, MAX_ENTRIES } = require('../../src/daemon/dormant-ledger.js');
const { SessionClient } = require('../../src/daemon/client.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dormant-'));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'dormant.json');
}

const exitState = (agentSession, at, extra = {}) => ({
  id: 'daemon-id', agent: 'claude', agent_session: agentSession, exit: { code: null, signal: null, at, ...extra },
});

test('a dormancy sleep is recorded and a newer ordinary exit clears it', () => {
  const file = tempLedger();
  assert.deepEqual(readLedger(file), {}, 'a missing ledger reads as empty');
  assert.equal(noteExit(file, exitState('s1', '2026-10-06T10:00:00.000Z', { dormant: true, reason: 'idle for 61m' })), true);
  assert.deepEqual(readLedger(file).s1, { at: '2026-10-06T10:00:00.000Z', agent: 'claude', reason: 'idle for 61m' });
  // An ordinary exit OLDER than the sleep (observed out of order) changes nothing.
  assert.equal(noteExit(file, exitState('s1', '2026-10-06T09:00:00.000Z')), false);
  assert.ok(readLedger(file).s1);
  // A newer ordinary exit (resumed, then closed) is the newest ending: cleared.
  assert.equal(noteExit(file, exitState('s1', '2026-10-06T11:00:00.000Z')), true);
  assert.equal(readLedger(file).s1, undefined);
});

test('exits without a provider session id or a time never touch the ledger', () => {
  const file = tempLedger();
  assert.equal(noteExit(file, { id: 'x', exit: { at: '2026-10-06T10:00:00.000Z', dormant: true } }), false);
  assert.equal(noteExit(file, exitState('s1', 'not a time', { dormant: true })), false);
  assert.equal(fs.existsSync(file), false);
});

test('the ledger stays bounded: old entries age out and the newest are kept', () => {
  const file = tempLedger();
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  noteExit(file, exitState('ancient', '2026-08-01T00:00:00.000Z', { dormant: true }), now);
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
    noteExit(file, exitState(`s${i}`, new Date(now - (MAX_ENTRIES + 5 - i) * 1000).toISOString(), { dormant: true }), now);
  }
  const sessions = readLedger(file);
  assert.equal(Object.keys(sessions).length, MAX_ENTRIES);
  assert.equal(sessions.ancient, undefined, 'older than 30 days is dropped');
  assert.ok(sessions[`s${MAX_ENTRIES + 4}`], 'the newest entry is kept');
  assert.equal(sessions.s0, undefined, 'the oldest past the cap is dropped');
});

test('the real daemon records a sleep and forgets it after an ordinary close', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-dormant-daemon-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: { ...process.env, HARBOR_SESSIOND_DIR: dir, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_NO_DAEMON_START: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new SessionClient({ socketPath });
  cleanups.push(async () => {
    try {
      const listed = await client.request('list');
      for (const s of listed.sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {});
    } catch {}
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((r) => daemon.once('exit', r)); }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  });
  const deadline = Date.now() + 10_000;
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

  // A child that stays up until it is ended, standing in for an idle CLI.
  const argv = process.platform === 'win32'
    ? [process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe', '/d', '/k']
    : ['/bin/sh', '-c', 'sleep 600'];
  const childEnv = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const startSession = () => client.request('spawn', {
    argv, cwd: dir, env: childEnv, cols: 80, rows: 24, agent: 'claude', agent_session: 'provider-session-1',
  });
  // Exits are observed through list, the path the daemon's own heartbeat
  // drives every minute, so driving list IS the production trigger.
  const untilExited = async (id) => {
    const until = Date.now() + 40_000;
    while (Date.now() < until) {
      const listed = await client.request('list');
      if (listed.sessions.find((s) => s.id === id)?.exit) return;
      await sleep(200);
    }
    throw new Error(`session ${id} never exited: ${stderr}`);
  };

  const first = await startSession();
  await sleep(1500);
  // The same verb dormancy itself sends (daemon.js sweepDormancy's terminate).
  await client.request('terminate', { id: first.id, signal: 'SIGTERM', grace_ms: 2000, dormant: true, reason: 'idle for 61m with no cpu' });
  await untilExited(first.id);
  const slept = (await client.request('dormant')).sessions['provider-session-1'];
  assert.ok(slept, 'a session ended by dormancy is in the ledger');
  assert.equal(slept.agent, 'claude');
  assert.match(slept.reason, /idle for 61m/);
  assert.ok(fs.existsSync(path.join(dir, 'dormant.json')), 'the ledger lives in the store, past the exit reap');

  // Resumed, then closed by hand: no longer asleep.
  const second = await startSession();
  await sleep(1500);
  await client.request('terminate', { id: second.id, signal: 'SIGTERM', grace_ms: 2000 });
  await untilExited(second.id);
  assert.equal((await client.request('dormant')).sessions['provider-session-1'], undefined,
    'an ordinary close after the sleep clears it');
});
