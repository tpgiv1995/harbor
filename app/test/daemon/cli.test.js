'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { SessionClient } = require('../../src/daemon/client.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

const ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(ROOT, 'bin/harbor-sessiond');
const DAEMON = path.join(ROOT, 'app/src/daemon/daemon.js');
const processes = [];
const startedPids = [];
const dirs = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(socketPath) {
  for (let count = 0; count < 100; count += 1) {
    const probe = new SessionClient({ socketPath });
    try { if ((await probe.request('health')).ok) return; } catch {} finally { probe.close(); }
    await sleep(50);
  }
  throw new Error(`timed out waiting for daemon health at ${socketPath}`);
}

function isolatedEnv(dir) {
  return {
    ...process.env,
    HARBOR_SESSIOND_DIR: dir,
    HARBOR_SESSIOND_SOCKET: path.join(dir, 'daemon.sock'),
    HARBOR_NO_DAEMON_START: '1',
    HERDR_SOCKET_PATH: path.join(dir, 'not-user.sock'),
  };
}

async function runningDaemon() {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-sessiond-cli-'));
  dirs.push(dir);
  const env = isolatedEnv(dir);
  const child = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: 'ignore' });
  processes.push(child);
  await waitFor(env.HARBOR_SESSIOND_SOCKET);
  return { dir, env };
}

function cli(args, env) {
  return execFileSync(guiNodeExec, [CLI, ...args], { windowsHide: true, env, encoding: 'utf8', timeout: 10000 });
}

// `start` exits non-zero when the daemon it launched never answered, which is the
// point: "started" has to mean it answered a real request, not that something was
// forked. A caller that wants the payload of an UNHEALTHY start (the routing
// specs, which stub systemd-run and so never get a real daemon) needs stdout
// without execFileSync throwing on the exit code.
function cliAllowingFailure(args, env) {
  const result = spawnSync(guiNodeExec, [CLI, ...args], { windowsHide: true, env, encoding: 'utf8', timeout: 10000 });
  return { stdout: String(result.stdout || ''), status: result.status };
}

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const pid of startedPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  for (const dir of dirs.splice(0)) {
    for (const state of fs.existsSync(path.join(dir, 'sessions')) ? fs.readdirSync(path.join(dir, 'sessions')).filter((name) => name.endsWith('.json') && !name.endsWith('.config.json')) : []) {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', state), 'utf8'));
        process.kill(value.keeper_pid, 'SIGKILL');
        process.kill(-value.pid, 'SIGKILL');
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repair CLI status, list, kill, and logs work without Electron', async () => {
  const h = await runningDaemon();
  const status = cli(['status', '--json'], h.env);
  assert.equal(JSON.parse(status).ok, true);

  const shell = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', '/Q', '/K'] : ['/bin/bash', '--noprofile', '--norc'];
  const spawned = JSON.parse(cli(['spawn', '--json', '--cwd', h.dir, '--cols', '120', '--rows', '60', '--', ...shell], h.env));
  const listed = JSON.parse(cli(['list', '--json'], h.env));
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].id, spawned.id);
  assert.equal(listed.sessions[0].rows, 60);

  const killed = JSON.parse(cli(['kill', spawned.id, '--json'], h.env));
  assert.equal(killed.signaled, true);
  await sleep(1800);
  const after = JSON.parse(cli(['list', '--json'], h.env));
  assert.ok(after.sessions[0].exit, 'kill must leave an honest exit record');
  if (process.platform !== 'win32') assert.equal(after.sessions[0].exit.signal > 0, true);

  const logs = cli(['logs', '--lines', '20'], h.env);
  assert.match(logs, /daemon listening/);
  assert.match(logs, new RegExp(`spawn ${spawned.id}`));
});

// These are two independent statements about ROUTING, so they get a store each.
// They used to share one, which only worked because `start` would cheerfully
// start a second daemon on a store that already had a live one. It will not any
// more (see single-instance.test.js), and it should not: sharing a store here
// would mean the second assertion was really testing the already-running gate.
function systemdStub(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harbor-sessiond-${name}-`));
  dirs.push(dir);
  const stubDir = path.join(dir, 'bin');
  fs.mkdirSync(stubDir);
  const record = path.join(dir, 'systemd-argv');
  fs.writeFileSync(path.join(stubDir, 'systemd-run'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HARBOR_TEST_SYSTEMD_RECORD"\nexit 0\n`, { mode: 0o755 });
  // `systemctl` is on the same stub PATH so the reset-failed probe cannot reach
  // the real user manager. Naming a unit is the escape; the harness picks it.
  fs.writeFileSync(path.join(stubDir, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return {
    dir,
    record,
    env: {
      ...isolatedEnv(dir),
      // The stub dir comes FIRST, which is what shadows the real systemd-run
      // and systemctl; that is the whole point of this PATH. The directory of
      // the node currently running the suite has to be on it too, because
      // bin/harbor-sessiond starts `#!/usr/bin/env node`: a PATH of just
      // /usr/bin:/bin happens to work on a machine whose node is /usr/bin/node
      // and fails everywhere else. On GitHub Actions node lives in the runner's
      // tool cache, so this spec died with "/usr/bin/env: 'node': No such file
      // or directory" while passing locally.
      PATH: `${stubDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HARBOR_TEST_SYSTEMD_RECORD: record,
      // The stub forks nothing, so nothing will ever answer. Keep the readiness
      // wait short so the routing assertion is not paying a 10s timeout.
      HARBOR_SESSIOND_READY_TIMEOUT_MS: '300',
    },
  };
}

test('a relocated start never reaches the production systemd unit', { skip: process.platform === 'win32' && 'systemd routing has no win32 analogue' }, () => {
  const { record, env } = systemdStub('relocated');
  const refused = JSON.parse(cli(['start', '--json'], env));
  startedPids.push(refused.pid);
  assert.equal(refused.mode, 'detached');
  assert.equal(refused.started, true, 'the detached fallback must actually come up');
  assert.equal(fs.existsSync(record), false, 'relocated default never reaches systemd');
});

test('an explicit unit reaches systemd with KillMode=process', { skip: process.platform === 'win32' && 'systemd unit routing is POSIX-only' }, () => {
  const { record, env } = systemdStub('explicit');
  const run = cliAllowingFailure(['start', '--json'], { ...env, HARBOR_SESSIOND_UNIT: 'harbor-sessiond-test.service' });
  const allowed = JSON.parse(run.stdout);
  assert.equal(allowed.mode, 'systemd');
  const argv = fs.readFileSync(record, 'utf8');
  assert.match(argv, /--unit=harbor-sessiond-test\.service/);
  assert.match(argv, /--property=KillMode=process/);
  // The stub forks nothing, so readiness must be reported honestly rather than
  // assumed from systemd-run's exit code, and the CLI must exit non-zero: the
  // caller's very next act is a real request, so a premature success would only
  // relocate the failure.
  assert.equal(allowed.healthy, false, 'a unit that never answered is not healthy');
  assert.notEqual(run.status, 0, 'an unhealthy start must fail loudly');
});
