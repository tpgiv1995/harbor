'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// A SESSION'S DEATH LEAVES A LINE IN sessiond.log (2026-08-20). On the day a
// dozen CLI processes died of commit exhaustion, each death's only record was
// its state file, which the exit-retention reap deletes five minutes later
// together with the keeper log. The daemon's log for that whole day held 125
// spawn lines and ZERO exits: there was no way to say when a session died,
// let alone with what code. The daemon's own death gets a line (daemon-watch);
// its sessions get one too now, written when the exit is first observed and
// exactly once, so a day of crashes reads as a day of crashes.

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SessionClient } = require('../../src/daemon/client.js');

const ROOT = path.resolve(__dirname, '../..');
const DAEMON = path.join(ROOT, 'src/daemon/daemon.js');
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

test('a session exit is logged once, with its real code, before the reap can erase the evidence', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-exitlog-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const daemon = spawn(guiNodeExec, [DAEMON], {
    windowsHide: true,
    env: {
      ...process.env,
      HARBOR_SESSIOND_DIR: dir,
      HARBOR_SESSIOND_SOCKET: socketPath,
      // Under harness churn an instant-exit child can take three distinct
      // shapes, each owned by a different mechanism: onExit lost (the
      // keeper's child watch), the keeper blind to a recycled pid (the
      // daemon's table-verified reap), or the KEEPER ITSELF dead of a native
      // ConPTY abort with nothing recorded (periodic reconciliation). All
      // three run at test cadence so whichever shape this run draws resolves
      // inside the window; the assertion below accepts any honest record.
      HARBOR_SESSIOND_ORPHAN_INTERVAL_MS: '1000',
      HARBOR_SESSIOND_RECONCILE_INTERVAL_MS: '2000',
      HARBOR_NO_DAEMON_START: '1',
    },
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

  // A real pty child that dies immediately with a distinctive code, the shape
  // of a CLI crashing at turn start.
  const argv = process.platform === 'win32'
    ? [process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'exit 7']
    : ['/bin/sh', '-c', 'exit 7'];
  const childEnv = {};
  for (const key of ['SystemRoot', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (process.env[key]) childEnv[key] = process.env[key];
  }
  const spawned = await client.request('spawn', { argv, cwd: dir, env: childEnv, cols: 80, rows: 24 });

  // The exit is observed through list (the same path the RSS heartbeat drives
  // every minute unattended), so driving list IS the production trigger.
  const logPath = path.join(dir, 'sessiond.log');
  const exitLines = () => {
    let text = '';
    try { text = fs.readFileSync(logPath, 'utf8'); } catch {}
    return text.split('\n').filter((line) => line.includes(`exit ${spawned.id}`));
  };
  const until = Date.now() + 50_000; // youth guard + churn-slowed snapshots + two sightings + terminate, with margin
  while (Date.now() < until) {
    await client.request('list');
    if (exitLines().length > 0) break;
    await sleep(200);
  }
  const lines = exitLines();
  // A bare "0 !== 1" cost an hour of blind theorizing tonight; a failure
  // message that carries the state file and the daemon's log answers WHERE
  // the exit got stuck (never recorded by the keeper, or recorded and never
  // observed) on the first reading.
  const forensics = () => {
    let state = '(unreadable)';
    let logTail = '(unreadable)';
    try { state = fs.readFileSync(path.join(dir, 'sessions', `${spawned.id}.json`), 'utf8').trim(); } catch {}
    try { logTail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-15).join('\n'); } catch {}
    return `STATE: ${state}\nLOG TAIL:\n${logTail}\nSTDERR: ${stderr}`;
  };
  assert.equal(lines.length, 1, `the exit must be logged, and logged once: ${JSON.stringify(lines)}\n${forensics()}`);
  // ConPTY delivers the real code on most runs; when it loses the event, the
  // honest synthesized exit (null code WITH a stated reason) is equally
  // correct. What is never acceptable is no line, a fabricated code, or a
  // null code with no explanation.
  assert.match(lines[0], /code=7|code=null.*reason=/,
    'the line carries the real exit code, or an honestly synthesized null with its reason');
  assert.match(lines[0], /pid=\d+/);

  // Asking again must not log it again.
  await client.request('list');
  await client.request('list');
  assert.equal(exitLines().length, 1, 'an exit already logged is never logged twice');
});
