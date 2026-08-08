'use strict';

// Wedged-daemon recovery tests (live-caught 2026-07-21): a herdr daemon whose
// main thread died while worker threads keep the listening socket ACCEPTS
// connections but never answers, so untimed clients hang forever. These tests
// prove, against a stub herdr and a real accept-but-never-answer unix socket:
//   1. bin/herdr-server-clean leaves a healthy daemon alone,
//   2. moves a wedged socket (and session.json) aside and starts fresh,
//   3. cold-starts without inventing .dead files,
//   4. bin/ai fails fast and honestly instead of hanging on a wedged daemon,
//   5. a wedge whose `herdr status` still answers "running" is STILL recovered.
// Everything runs in temp dirs with HARBOR_HERDR_* overrides; the user's real
// daemon at ~/.config/herdr is never touched.
//
// Case 5 is the shape that got past cases 1-4 (live-caught 2026-07-26; Harbor
// sat unusable behind "Reconnecting..." for eight minutes while the watchdog
// looped every 60s and never recovered). These tests originally modelled a
// wedge as `herdr status` HANGING, which the timed probe cut through. The real
// wedge does the opposite: status answers "status: running" in milliseconds
// (that reply needs no main thread) while every real request hangs, so
// herdr-server-clean's "already running, leave it" gate short-circuited every
// recovery. A timeout guards a probe that HANGS; it does nothing about a probe
// that LIES. Health is therefore `herdr api snapshot` (see bin/herdr-health.sh).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../../..');
const SERVER_CLEAN = path.join(ROOT, 'bin', 'herdr-server-clean');
const AI_BIN = path.join(ROOT, 'bin', 'ai');

// Stub herdr: status reports running once <dir>/daemon-started exists, hangs
// while <dir>/hang exists, else fails fast. `api snapshot` is the real
// main-thread probe: it hangs while <dir>/hang-api exists, answers once the
// daemon is started, else fails fast (the no-daemon case). `server` marks
// daemon-started and parks, clearing the hang markers because a FRESH daemon
// answers for real. workspace subcommands hang while <dir>/hang-ws exists.
const STUB = `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
case "$1" in
  status)
    if [ -f "$DIR/daemon-started" ]; then printf 'server:\\n  status: running\\n'; exit 0; fi
    if [ -f "$DIR/hang" ]; then sleep 30; fi
    exit 1 ;;
  api)
    if [ -f "$DIR/hang-api" ]; then sleep 30; fi
    if [ -f "$DIR/daemon-started" ]; then echo '{"result":{"snapshot":{}}}'; exit 0; fi
    exit 1 ;;
  server)
    echo $$ > "$DIR/server.pid"
    rm -f "$DIR/hang" "$DIR/hang-api"
    touch "$DIR/daemon-started"
    exec sleep 60 ;;
  workspace|tab|pane)
    if [ -f "$DIR/hang-ws" ]; then sleep 30; fi
    echo '{"result":{"workspaces":[]}}' ;;
esac
`;

// Stub systemd: this suite must never reach the REAL user manager. Both stubs
// record their argv so a spec can assert which unit (if any) was touched.
// systemd-run also runs the command after `--`, so the launched-by-manager
// path still produces a live stub daemon for the readiness poll.
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
printf 'systemctl %s\\n' "$*" >> "$DIR/systemd-argv.log"
exit 0
`;

const SYSTEMD_RUN_STUB = `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
printf 'systemd-run %s\\n' "$*" >> "$DIR/systemd-argv.log"
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  shift
done
[ $# -gt 0 ] || exit 0
setsid "$@" >/dev/null 2>&1 &
exit 0
`;

function makeStubDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-test-'));
  const stub = path.join(dir, 'herdr');
  fs.writeFileSync(stub, STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'systemctl'), SYSTEMCTL_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'systemd-run'), SYSTEMD_RUN_STUB, { mode: 0o755 });
  return { dir, stub };
}

function systemdArgv(dir) {
  try { return fs.readFileSync(path.join(dir, 'systemd-argv.log'), 'utf8'); } catch { return ''; }
}

function cleanup(dir) {
  const pidFile = path.join(dir, 'server.pid');
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (pid > 1) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// A real unix socket that accepts connections and never answers: the exact
// shape of the live wedge.
function listenNeverAnswer(sockPath) {
  return new Promise((resolve) => {
    const srv = net.createServer(() => { /* accept, say nothing */ });
    srv.listen(sockPath, () => resolve(srv));
  });
}

function runServerClean(stubDir, herdrDir, extraEnv = {}) {
  return spawnSync('bash', [SERVER_CLEAN], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      // Drives the herdr CLI through a stub, so it declares the herdr backend
      // rather than inheriting a default that is now sessiond.
      HARBOR_SESSION_BACKEND: 'herdr',
      PATH: `${stubDir}:${process.env.PATH}`,
      HARBOR_HERDR_BIN: path.join(stubDir, 'herdr'),
      HARBOR_HERDR_DIR: herdrDir,
      HARBOR_HERDR_DAEMON_LOG: path.join(herdrDir, 'daemon.log'),
      HARBOR_HERDR_STATUS_TIMEOUT: '1',
      HARBOR_HERDR_SNAPSHOT_TIMEOUT: '1',
      ...extraEnv,
    },
  });
}

test('herdr-server-clean leaves a healthy daemon alone', () => {
  const { dir } = makeStubDir();
  try {
    fs.writeFileSync(path.join(dir, 'daemon-started'), '');
    const res = runServerClean(dir, dir);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /already running/);
    assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes('.dead-')).length, 0);
  } finally { cleanup(dir); }
});

test('herdr-server-clean moves a wedged socket and session.json aside, then starts fresh', async () => {
  const { dir } = makeStubDir();
  const herdrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-cfg-'));
  const wedge = await listenNeverAnswer(path.join(herdrDir, 'herdr.sock'));
  const wedgeClient = await listenNeverAnswer(path.join(herdrDir, 'herdr-client.sock'));
  try {
    fs.writeFileSync(path.join(dir, 'hang'), ''); // status hangs like a real wedge
    fs.writeFileSync(path.join(herdrDir, 'session.json'), '{"workspaces":[]}');

    const started = Date.now();
    const res = runServerClean(dir, herdrDir);
    const elapsed = Date.now() - started;

    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /wedged or stale/);
    assert.match(res.stdout, /started clean/);
    // The timed probes must have cut through the hanging status calls.
    assert.ok(elapsed < 20000, `recovery took ${elapsed}ms; timed probes not applied?`);

    const entries = fs.readdirSync(herdrDir);
    assert.ok(!entries.includes('herdr.sock'), 'wedged socket must be moved aside');
    assert.ok(entries.some((f) => f.startsWith('herdr.sock.dead-')), 'moved socket keeps forensic .dead name');
    assert.ok(entries.some((f) => f.startsWith('herdr-client.sock.dead-')), 'client socket moved aside too');
    assert.ok(!entries.includes('session.json'), 'session.json must move aside (auto-resume herd guard)');
    assert.ok(entries.some((f) => f.startsWith('session.json.wedged-')), 'session.json kept as backup');
    assert.ok(fs.existsSync(path.join(dir, 'daemon-started')), 'fresh daemon must actually start');
    assert.match(fs.readFileSync(path.join(herdrDir, 'daemon.log'), 'utf8'), /herdr server start/);
  } finally {
    wedge.close();
    wedgeClient.close();
    cleanup(dir);
    fs.rmSync(herdrDir, { recursive: true, force: true });
  }
});

test('herdr-server-clean cold start invents no .dead files', () => {
  const { dir } = makeStubDir();
  const herdrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-cfg-'));
  try {
    const res = runServerClean(dir, herdrDir);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /started clean/);
    assert.strictEqual(fs.readdirSync(herdrDir).filter((f) => f.includes('.dead-')).length, 0);
  } finally { cleanup(dir); fs.rmSync(herdrDir, { recursive: true, force: true }); }
});

test('bin/ai fails fast and honestly against a wedged daemon instead of hanging', () => {
  const { dir } = makeStubDir();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-proj-'));
  // bin/ai routes an unhealthy daemon through herdr-server-clean, which MOVES
  // SOCKETS ASIDE. Without its own HARBOR_HERDR_DIR this test would recover
  // (and rename the sockets of) the real ~/.config/herdr daemon: the same
  // escape shape as the 2026-07-25 self-kill and the 2026-07-26 file chooser.
  const herdrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'daemon-started'), ''); // status: running
    fs.writeFileSync(path.join(dir, 'hang-api'), ''); // real requests wedge
    fs.writeFileSync(path.join(dir, 'hang-ws'), ''); // and stay wedged after recovery

    const started = Date.now();
    const res = spawnSync('bash', [AI_BIN], {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        // A wedged HERDR daemon is the subject here, so the backend is named
        // rather than inherited: under the sessiond default this drive reached
        // for the real ~/.local/state/harbor/sessiond socket instead.
        HARBOR_SESSION_BACKEND: 'herdr',
        HARBOR_HERDR_BIN: path.join(dir, 'herdr'),
        HARBOR_HERDR_DIR: herdrDir,
        HARBOR_HERDR_DAEMON_LOG: path.join(herdrDir, 'daemon.log'),
        HARBOR_HERDR_CALL_TIMEOUT: '1',
        HARBOR_HERDR_STATUS_TIMEOUT: '1',
        HARBOR_HERDR_SNAPSHOT_TIMEOUT: '1',
        HERDR_PANE_ID: '',
        HERDR_ACTIVE_PANE_ID: '',
        HERDR_PLUGIN_CONTEXT_JSON: '',
      },
    });
    const elapsed = Date.now() - started;

    assert.notStrictEqual(res.status, 0, 'ai must fail, not pretend');
    assert.match(res.stderr, /not responding/, `stderr: ${res.stderr}`);
    assert.ok(elapsed < 15000, `ai took ${elapsed}ms against a wedge; the eternal Working... is back`);
  } finally {
    cleanup(dir);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(herdrDir, { recursive: true, force: true });
  }
});

// The 2026-07-26 incident, byte for byte: `herdr status` answers "status:
// running" while session.snapshot times out. The old gate believed status,
// exited 0 claiming success, and Harbor's watchdog re-ran it every 60s
// forever. Recovery must happen anyway.
test('herdr-server-clean recovers a wedge whose status still reports running', async () => {
  const { dir } = makeStubDir();
  const herdrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-cfg-'));
  const wedge = await listenNeverAnswer(path.join(herdrDir, 'herdr.sock'));
  const wedgeClient = await listenNeverAnswer(path.join(herdrDir, 'herdr-client.sock'));
  try {
    fs.writeFileSync(path.join(dir, 'daemon-started'), ''); // status LIES: running
    fs.writeFileSync(path.join(dir, 'hang-api'), ''); // every real request hangs
    fs.writeFileSync(path.join(herdrDir, 'session.json'), '{"workspaces":[]}');

    const started = Date.now();
    const res = runServerClean(dir, herdrDir);
    const elapsed = Date.now() - started;

    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.doesNotMatch(
      res.stderr,
      /already running/,
      'a daemon that cannot answer a real request is NOT "already running"; that gate is the 8-minute outage',
    );
    assert.match(res.stderr, /wedged or stale/);
    assert.match(res.stdout, /started clean/);
    assert.ok(elapsed < 20000, `recovery took ${elapsed}ms; timed probes not applied?`);

    const entries = fs.readdirSync(herdrDir);
    assert.ok(!entries.includes('herdr.sock'), 'wedged socket must be moved aside');
    assert.ok(entries.some((f) => f.startsWith('herdr.sock.dead-')), 'moved socket keeps forensic .dead name');
    assert.ok(entries.some((f) => f.startsWith('herdr-client.sock.dead-')), 'client socket moved aside too');
    assert.ok(!entries.includes('session.json'), 'session.json must move aside (auto-resume herd guard)');
    assert.ok(entries.some((f) => f.startsWith('session.json.wedged-')), 'session.json kept as backup');
    assert.match(fs.readFileSync(path.join(herdrDir, 'daemon.log'), 'utf8'), /herdr server start/);
  } finally {
    wedge.close();
    wedgeClient.close();
    cleanup(dir);
    fs.rmSync(herdrDir, { recursive: true, force: true });
  }
});

// The other half of the same coin: "answers a real request" must still be the
// bar for LEAVING a daemon alone, or every launcher would bounce a perfectly
// healthy daemon out from under Pat's live panes.
test('herdr-server-clean leaves a daemon that answers a real request alone', () => {
  const { dir } = makeStubDir();
  const herdrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'daemon-started'), ''); // healthy: status AND api answer
    fs.writeFileSync(path.join(herdrDir, 'session.json'), '{"workspaces":[]}');
    const res = runServerClean(dir, herdrDir);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stderr, /already running/);
    const entries = fs.readdirSync(herdrDir);
    assert.strictEqual(entries.filter((f) => f.includes('.dead-')).length, 0);
    assert.ok(entries.includes('session.json'), 'a healthy daemon keeps its session.json');
  } finally { cleanup(dir); fs.rmSync(herdrDir, { recursive: true, force: true }); }
});

// Cgroup placement (2026-07-28). `setsid nohup` detaches from the process TREE
// but not from the CGROUP, so the daemon, every pane it forked and every claude
// in them inherited app-gnome-harbor-<pid>.scope: the scope gnome-shell made
// for whichever window happened to start it. Measured that morning at 584 tasks
// in one scope, with the daemon inside it. One OOM there took the lot (twice),
// and a second Harbor launch grew a SECOND daemon in a second scope, one of
// which was still holding 172 processes from three days earlier.
// This test drives the unit path under its OWN unit name. It used to assert
// `--unit=herdr-daemon` from a relocated harness, which is the bug of
// 2026-07-29 written down as a requirement: the production default is proven
// by resolveUnitPolicy below, where it costs nothing and kills nothing.
test('the daemon is started in its own named systemd unit, not the caller cgroup', () => {
  const { dir: stubDir } = makeStubDir();
  const herdrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-cfg-'));
  try {
    const res = runServerClean(stubDir, herdrDir, { HARBOR_HERDR_UNIT: 'harbor-wedge-test-unit' });
    assert.match(res.stdout, /started clean/);
    const argv = systemdArgv(stubDir);
    assert.match(argv, /--user/);
    assert.match(argv, /--unit=harbor-wedge-test-unit/, 'one stable name, so a second daemon cannot hide');
    assert.match(argv, /--collect/);
    assert.doesNotMatch(argv, /herdr-daemon/, 'and never the real unit');
    // Owning a unit is only half the protection. systemd's default is
    // KillMode=control-group, so `systemctl stop` signals EVERY process in the
    // cgroup, and the daemon forks every pane: measured at 399 tasks, every
    // live claude session among them. That is what dropped Pat's sessions
    // repeatedly on 2026-08-03 and made him press Resume all day. KillMode
    // =process stops the daemon and leaves the panes, which is the state this
    // project already supports via adopt-on-send.
    assert.match(argv, /--property=KillMode=process/,
      'stopping the daemon must not signal the panes, or every session dies with it');
    // The clean-env allowlist is the whole point of this script and has to
    // survive the move: a daemon started with a session's environment leaks that
    // session's ids into every pane it spawns.
    assert.match(argv, /--setenv=HOME=/);
    assert.match(argv, /--setenv=PATH=/);
    assert.match(argv, /--setenv=XDG_RUNTIME_DIR=/);
    assert.ok(!/--setenv=(CLAUDE|ANTHROPIC|HERDR_PANE)/.test(argv), 'and nothing from the caller leaks in');
  } finally { cleanup(stubDir); fs.rmSync(herdrDir, { recursive: true, force: true }); }
});

// The outage this suite CAUSED (2026-07-29). runServerClean isolated the herdr
// binary, the config dir, the log and the timeouts, but not the unit NAME, so
// `startClean` resolved the default `herdr-daemon` and ran
// `systemctl --user stop herdr-daemon` against Pat's live unit. Stopping that
// unit kills its whole cgroup: the daemon, every pane and every claude in them.
// Harbor's watchdog then recovered, which is the yellow banner he was watching,
// once per test run, eight times in twenty-two minutes.
test('a relocated harness never stops or claims the real herdr-daemon unit', () => {
  const { dir } = makeStubDir();
  const herdrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-cfg-'));
  try {
    const res = runServerClean(dir, herdrDir);
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /started clean/, 'and the harness still gets its daemon');
    assert.strictEqual(systemdArgv(dir), '', `a relocated harness reached systemd: ${systemdArgv(dir)}`);
  } finally { cleanup(dir); fs.rmSync(herdrDir, { recursive: true, force: true }); }
});

// The policy itself, both sides, with nothing running: a refusal alone would
// pass just as well if the systemd path were simply dead everywhere.
test('resolveUnitPolicy: the real installation owns herdr-daemon, a relocated one owns nothing', (t) => {
  if (process.platform !== 'linux') return t.skip('systemd unit path is linux-only');
  const { resolveUnitPolicy } = require(path.join(ROOT, 'bin', 'harbor-bin.cjs'));

  // resolveUnitPolicy treats a $HOME that disagrees with the passwd entry as a
  // relocation (see its comment: that mismatch is the exact signature a
  // throwaway-HOME test harness leaves behind), so "the real installation"
  // case has to be asserted with $HOME PINNED to the passwd home rather than
  // trusting whatever this test process happened to inherit: a
  // machine-independence run of this suite deliberately sets HOME to a mktemp
  // dir, which is indistinguishable from a real relocation unless this spec
  // resets it first, the same way the sibling spec below already does.
  const passwdHome = os.userInfo().homedir;
  const priorHome = process.env.HOME;
  let real;
  try {
    process.env.HOME = passwdHome;
    real = resolveUnitPolicy({});
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  }
  assert.strictEqual(real.unit, 'herdr-daemon', 'the production default name is unchanged');
  assert.strictEqual(real.mayManage, true, 'and the real installation still manages it');

  for (const relocation of [{ HARBOR_HERDR_BIN: '/tmp/stub/herdr' }, { HARBOR_HERDR_DIR: '/tmp/cfg' }]) {
    const moved = resolveUnitPolicy(relocation);
    assert.strictEqual(moved.mayManage, false, `relocated by ${Object.keys(relocation)[0]} must not manage`);
    assert.match(moved.reason, /relocated/);
  }

  const named = resolveUnitPolicy({ HARBOR_HERDR_BIN: '/tmp/stub/herdr', HARBOR_HERDR_UNIT: 'harbor-test-x' });
  assert.strictEqual(named.mayManage, true, 'a harness that names its own unit is allowed to manage it');
  assert.strictEqual(named.unit, 'harbor-test-x');

  assert.strictEqual(resolveUnitPolicy({ HERDR_NO_SYSTEMD_UNIT: '1' }).mayManage, false);
});

// The same bug wearing a different hat, found while building the batch-13
// cold-start drive. That drive points the app at a throwaway HOME, and the
// herdr dir is derived from os.homedir(), so the sockets and session.json move
// while the unit NAME still names Pat's live daemon. Nothing in the env says
// HARBOR_HERDR_*, so the first guard would have waved it straight through and
// the hand-off simulation would have killed the machine it was simulating on.
test('resolveUnitPolicy: an overridden HOME may not manage the default unit either', (t) => {
  if (process.platform !== 'linux') return t.skip('systemd unit path is linux-only');
  const { resolveUnitPolicy } = require(path.join(ROOT, 'bin', 'harbor-bin.cjs'));
  const real = os.userInfo().homedir;
  const prior = process.env.HOME;
  try {
    process.env.HOME = path.join(os.tmpdir(), 'harbor-coldstart-home');
    const moved = resolveUnitPolicy({});
    assert.strictEqual(moved.mayManage, false, 'a throwaway HOME is a relocation');
    assert.match(moved.reason, /HOME/);

    process.env.HOME = real;
    assert.strictEqual(resolveUnitPolicy({}).mayManage, true, 'and the real HOME still manages it');
  } finally {
    if (prior === undefined) delete process.env.HOME; else process.env.HOME = prior;
  }
});

test('no systemd-run, or an explicit opt-out, still brings a daemon up', () => {
  const { dir: stubDir } = makeStubDir();
  const herdrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-wedge-cfg-'));
  // No systemd-run stub at all in this one; PATH still has the real system
  // one, so the opt-out is what proves the fallback rather than the absence.
  const res = runServerClean(stubDir, herdrDir, { HERDR_NO_SYSTEMD_UNIT: '1' });
  assert.match(res.stdout, /started clean/, 'the fallback is exactly the old behaviour');
  assert.ok(fs.existsSync(path.join(stubDir, 'server.pid')), 'and the daemon really started');
});
