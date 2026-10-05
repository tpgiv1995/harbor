'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// ONE SESSION IS ONE CGROUP (2026-08-09).
//
// A fork inherits its parent's cgroup, so every keeper used to live in
// harbor-sessiond.service. At 00:28 that one cgroup held 45.7G across 20 live
// sessions, systemd-oomd chose it as the worst candidate under user@1000, and
// killed all 497 processes in it in a single act; the global reclaim leading up
// to it had already paged GNOME Shell and RuneLite to disk, so the desktop was
// unusable before anything died. Pat had hit this shape roughly thirty times.
//
// The proof that matters is spec 4, and it is deliberately TWO-SIDED: with
// scopes off, two sessions share one cgroup (the old behaviour, which is what
// made one kill take everything), and with scopes on they do not. A one-sided
// assertion here would pass just as well if scopes were silently disabled, and
// silently disabled is precisely the failure this guard exists to prevent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  DEFAULT_SLICE, resolveScopePolicy, poolLimits, cpuLimits, sessionCpuPercent, sliceUnitText,
  ensureSliceUnit, scopeCommand,
} = require('../../src/daemon/session-scope.js');
const { SessionClient } = require('../../src/daemon/client.js');

const DAEMON = path.resolve(__dirname, '../../src/daemon/daemon.js');
const GIB = 1024 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const haveSystemdUser = process.platform === 'linux'
  && spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).stdout !== '';
const systemdTest = (name, optionsOrFn, maybeFn) => {
  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  return test(name, {
    ...options,
    skip: process.platform === 'win32'
      ? 'session scopes are implemented by Linux systemd/cgroups and have no win32 analogue'
      : options.skip,
  }, fn);
};

systemdTest('1. the policy: production contains its sessions, a relocated store never touches the real slice', () => {
  // The real installation. Scopes on, default slice, and it owns the unit file.
  const real = resolveScopePolicy({}, 'linux');
  assert.equal(real.enabled, true);
  assert.equal(real.slice, DEFAULT_SLICE);
  assert.equal(real.manageUnit, true);

  // SAME RULE AS resolveUnitPolicy. A harness that pointed its store at a
  // throwaway directory is by definition not the real installation, so the
  // default slice is not its slice to file sessions under and the user's
  // systemd config is not its config to write. It gets no scopes at all.
  const relocated = resolveScopePolicy({ HARBOR_SESSIOND_DIR: '/tmp/whatever' }, 'linux');
  assert.equal(relocated.enabled, false);
  assert.match(relocated.reason, /did not name its own slice/);
  assert.equal(resolveScopePolicy({ HARBOR_SESSIOND_SOCKET: '/tmp/s.sock' }, 'linux').enabled, false);

  // Naming a slice is the escape, and the harness picks the name.
  const named = resolveScopePolicy({ HARBOR_SESSIOND_DIR: '/tmp/w', HARBOR_SESSIOND_SLICE: 'mine.slice' }, 'linux');
  assert.equal(named.enabled, true);
  assert.equal(named.slice, 'mine.slice');
  assert.equal(named.manageUnit, false, 'a harness must never rewrite the real slice unit');

  // The explicit opt-out, and every non-Linux platform, fall back to the
  // pre-2026-08-09 behaviour rather than failing to start a session.
  assert.equal(resolveScopePolicy({ HARBOR_SESSIOND_NO_SCOPE: '1' }, 'linux').enabled, false);
  assert.equal(resolveScopePolicy({}, 'win32').enabled, false);
  assert.equal(resolveScopePolicy({}, 'darwin').enabled, false);
});

systemdTest('2. the pool ceiling is DERIVED from the machine, never pinned to one box', () => {
  // A 62GiB workstation, the box the incident happened on.
  const big = poolLimits(64 * GIB);
  assert.ok(big.reserve >= 21 * GIB, 'a third of 64GiB stays out of Harbor\'s reach');
  assert.ok(big.max <= 43 * GIB && big.max > 40 * GIB);
  assert.ok(big.high < big.max, 'throttle before the wall');

  // A small laptop must reserve the FLOOR, not a third, or the desktop is
  // squeezed into nothing.
  const small = poolLimits(16 * GIB);
  assert.equal(small.reserve, 16 * GIB);
  assert.ok(small.max >= 4 * GIB, 'never propose a pool too small to hold one session');

  // The generated unit says what it enforces, and says which file to edit.
  const text = sliceUnitText(64 * GIB);
  assert.match(text, /MemoryHigh=\d+G/);
  assert.match(text, /MemoryMax=\d+G/);
  assert.match(text, /session-scope\.js/);
});

systemdTest('2b. the CPU ceiling is derived the same way, and the desktop outranks Harbor', () => {
  // The hole the memory work left: `CPUQuotaPerSecUSec=infinity` and no
  // CPUWeight, so one session's headless-Chrome render sweep took 9.5 cores,
  // pinned the package at 105C and held the fans at maximum with nothing
  // anywhere saying no. Pat reported it as the laptop "kicking on the
  // afterburners" for no reason that passed his sniff test.
  const big = cpuLimits(24);
  assert.equal(big.usable, 16, 'a third of 24 cores stays out of Harbor\'s reach');
  assert.equal(big.quotaPercent, 1600, 'systemd wants a percentage per core');
  assert.ok(big.weight < 100, 'below the default, so the compositor wins a contended CPU');

  // Derived, never pinned to this box: the same rule on other machines.
  assert.equal(cpuLimits(8).usable, 6);
  assert.equal(cpuLimits(4).usable, 3);
  assert.ok(cpuLimits(1).usable >= 1, 'a single-core machine must still be able to run a session');
  assert.ok(cpuLimits(2).usable >= 1);

  const text = sliceUnitText(64 * GIB, 24);
  assert.match(text, /CPUQuota=1600%/);
  assert.match(text, /CPUWeight=\d+/);
});

systemdTest('2c. ONE session cannot take the machine, only half the pool', () => {
  // The pool cap alone did not answer the actual complaint: bounding all
  // sessions to two thirds of the cores still let a SINGLE session have every
  // one of them, and one did (a headless-Chrome render sweep at 9.6 sustained
  // cores). One web-design session must not be able to throttle a whole
  // 24-core workstation.
  assert.equal(sessionCpuPercent(24), 800, 'half of the 16-core pool on a 24-core box');
  assert.ok(sessionCpuPercent(24) * 2 <= cpuLimits(24).quotaPercent,
    'two heavy sessions must still fit inside the pool ceiling');
  assert.ok(sessionCpuPercent(4) >= 100, 'a small machine must still run a session');

  // And it reaches the actual scope, which is the only thing the kernel reads.
  const policy = resolveScopePolicy({});
  const args = scopeCommand('abc', policy, 'node', ['x']).args;
  assert.equal(args.filter((a) => a.startsWith('--property=CPUQuota=')).length, 1,
    'exactly one CPUQuota property, not a duplicated one');
  assert.ok(args.includes(`--property=CPUQuota=${sessionCpuPercent()}%`));
  assert.ok(args.some((a) => a.startsWith('--property=CPUWeight=')));
});

systemdTest('3. ensureSliceUnit writes for the real installation and REFUSES for a harness', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-slice-unit-'));
  try {
    const env = { XDG_CONFIG_HOME: home };
    const file = path.join(home, 'systemd/user', DEFAULT_SLICE);
    // The reload is stubbed so this suite never pokes the REAL user manager,
    // even idempotently (review round 1); the stub also proves reload fires
    // exactly when a write happened and never otherwise.
    const reloads = [];
    const reload = () => { reloads.push(1); return { status: 0 }; };

    // A harness never writes into the user's systemd config, whatever else is true.
    const harnessPolicy = resolveScopePolicy({ HARBOR_SESSIOND_DIR: '/tmp/w', HARBOR_SESSIOND_SLICE: 'mine.slice' }, 'linux');
    ensureSliceUnit(harnessPolicy, { env, totalBytes: 64 * GIB, reload });
    assert.equal(fs.existsSync(file), false, 'a relocated store wrote a unit file into the real config');
    assert.equal(reloads.length, 0);

    // The real installation installs it, and is IDEMPOTENT on the second pass
    // (a daemon-reload on every daemon start would be noise, not a guard).
    const realPolicy = resolveScopePolicy({}, 'linux');
    const first = ensureSliceUnit(realPolicy, { env, totalBytes: 64 * GIB, reload });
    assert.equal(first.written, true);
    assert.match(fs.readFileSync(file, 'utf8'), /MemoryMax=/);
    assert.equal(reloads.length, 1);
    const second = ensureSliceUnit(realPolicy, { env, totalBytes: 64 * GIB, reload });
    assert.equal(second.written, false);
    assert.equal(second.reason, 'current');
    assert.equal(reloads.length, 1, 'an unchanged unit must not reload the manager');

    // A RAM change rewrites it, because a ceiling sized for the old machine is
    // the silently-wrong kind of guard.
    assert.equal(ensureSliceUnit(realPolicy, { env, totalBytes: 128 * GIB, reload }).written, true);
    assert.equal(reloads.length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

systemdTest('4. the argv puts the keeper in its own scope, under the slice, with both limits', () => {
  const policy = resolveScopePolicy({}, 'linux');
  const { command, args } = scopeCommand('abc-123', policy, '/usr/bin/node', ['/keeper.js', '/cfg.json']);
  assert.equal(command, 'systemd-run');
  assert.ok(args.includes('--scope'), '--service would supervise, not exec, and the exit watch would break');
  assert.ok(args.includes('--user'));
  assert.ok(args.includes('--collect'), 'a failed scope must not linger as a failed unit');
  assert.ok(args.includes('--unit=harbor-session-abc-123.scope'));
  assert.ok(args.includes(`--slice=${DEFAULT_SLICE}`));
  assert.ok(args.includes('--property=MemoryHigh=8G'));
  assert.ok(args.includes('--property=MemoryMax=12G'));
  assert.ok(args.includes('--property=MemorySwapMax=2G'),
    'swap is pooled at the slice; without a per-session cap one runaway starves every sibling');
  // The command must be last, after the `--`, or systemd-run eats its flags.
  assert.deepEqual(args.slice(args.indexOf('--')), ['--', '/usr/bin/node', '/keeper.js', '/cfg.json']);
});

// ---------------------------------------------------------------------------
// The real one. Two sessions, one daemon, against a live user manager.
// ---------------------------------------------------------------------------

async function harness(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-scope-test-'));
  const socketPath = path.join(dir, 'daemon.sock');
  const env = {
    ...process.env,
    HARBOR_SESSIOND_DIR: dir,
    HARBOR_SESSIOND_SOCKET: socketPath,
    HARBOR_NO_DAEMON_START: '1',
    HERDR_SOCKET_PATH: path.join(dir, 'never-real-herdr.sock'),
    ...extraEnv,
  };
  const daemon = spawn(guiNodeExec, [DAEMON], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return {
    client, dir,
    async cleanup() {
      try {
        const listed = await client.request('list');
        for (const s of listed.sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {});
      } catch {}
      client.close();
      if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await new Promise((r) => daemon.once('exit', r)); }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const cgroupOf = (pid) => {
  try { return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim(); } catch { return ''; }
};

async function twoSessionCgroups(extraEnv) {
  const h = await harness(extraEnv);
  try {
    const open = async () => {
      const s = await h.client.request('spawn', {
        argv: ['/bin/bash', '--noprofile', '--norc'], cwd: h.dir, env: {}, cols: 80, rows: 24,
      });
      const { pid } = await h.client.request('process', { id: s.id });
      return { id: s.id, pid, cgroup: cgroupOf(pid) };
    };
    return { a: await open(), b: await open(), cleanup: h.cleanup };
  } catch (error) {
    await h.cleanup();
    throw error;
  }
}

systemdTest('5. two sessions land in SEPARATE cgroups, and share one when containment is off', { skip: !haveSystemdUser && 'no user systemd manager' }, async (t) => {
  // NO DASHES, AND NOTHING CALLED "harbor". A dash in a slice name is a
  // HIERARCHY: `harbor-scopetest-N.slice` implicitly creates `harbor.slice`,
  // which is the same parent production's `harbor-sessions.slice` hangs off,
  // so a harness tidying up its own parent would stop the real session pool
  // and every session in it. That is the 2026-07-29 lesson (a unit name is a
  // shared namespace, and the suite that proved the herdr recovery stopped
  // Pat's live daemon eight times) arriving one layer down. A flat name shares
  // no parent with anything and is removed completely by stopping it.
  const slice = `hbscopetest${process.pid}.slice`;

  // THE BROKEN SIDE, kept on purpose. This is exactly what every Harbor before
  // 2026-08-09 did, and it is why one oomd decision took twenty sessions.
  // A scope is --collect'd when its process dies; an empty SLICE is not, and a
  // suite that leaves one behind per run is the same species of litter as the
  // 28 orphaned daemons of 2026-08-08. The harness names its own slice, so the
  // harness stops it.
  t.after(() => { spawnSync('systemctl', ['--user', 'stop', slice], { encoding: 'utf8' }); });

  const off = await twoSessionCgroups({ HARBOR_SESSIOND_NO_SCOPE: '1' });
  t.after(() => off.cleanup());
  assert.equal(off.a.cgroup, off.b.cgroup, 'without scopes both sessions must share the daemon cgroup');

  // THE FIXED SIDE.
  const on = await twoSessionCgroups({ HARBOR_SESSIOND_SLICE: slice });
  t.after(() => on.cleanup());
  assert.notEqual(on.a.cgroup, on.b.cgroup, 'each session must get its own cgroup');
  assert.match(on.a.cgroup, new RegExp(`${slice.replace('.', '\\.')}/harbor-session-${on.a.id}\\.scope$`));
  assert.match(on.b.cgroup, new RegExp(`${slice.replace('.', '\\.')}/harbor-session-${on.b.id}\\.scope$`));

  // And the ceiling is REAL: read it back from the kernel, not from systemctl,
  // because the whole point is what the kernel will enforce.
  const cgroupPath = `/sys/fs/cgroup${on.a.cgroup.replace(/^0::/, '')}`;
  assert.equal(fs.readFileSync(path.join(cgroupPath, 'memory.max'), 'utf8').trim(), String(12 * GIB));
  assert.equal(fs.readFileSync(path.join(cgroupPath, 'memory.high'), 'utf8').trim(), String(8 * GIB));

  // Killing one session's scope must not touch the other. This is the whole
  // fix stated as an assertion: the blast radius is one session.
  process.kill(on.a.pid, 'SIGKILL');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && cgroupOf(on.a.pid)) await sleep(50);
  assert.equal(cgroupOf(on.a.pid), '', 'the killed session did not go away');
  assert.notEqual(cgroupOf(on.b.pid), '', 'killing one session killed its neighbour');
});

systemdTest('6. a probe that fails at daemon start is retried, and health says which world you are in', { skip: !haveSystemdUser && 'no user systemd manager' }, async (t) => {
  // The daemon often starts while the user manager is still settling after
  // login. Before the retry (review round 1), one unlucky probe disabled
  // containment for the daemon's whole lifetime, silently. The shim makes
  // systemd-run fail until a marker file exists: the same daemon must run
  // unscoped, SAY so in health, and then heal itself once the manager answers.
  const slice = `hbscoperetry${process.pid}.slice`;
  t.after(() => { spawnSync('systemctl', ['--user', 'stop', slice], { encoding: 'utf8' }); });
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-scope-shim-'));
  t.after(() => fs.rmSync(shimDir, { recursive: true, force: true }));
  const marker = path.join(shimDir, 'manager-is-up');
  const realSystemdRun = spawnSync('sh', ['-c', 'command -v systemd-run'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(shimDir, 'systemd-run'), `#!/bin/sh\n[ -e "${marker}" ] || exit 1\nexec "${realSystemdRun}" "$@"\n`, { mode: 0o755 });

  const h = await harness({
    HARBOR_SESSIOND_SLICE: slice,
    HARBOR_SESSIOND_SCOPE_RETRY_MS: '100',
    PATH: `${shimDir}:${process.env.PATH}`,
  });
  t.after(() => h.cleanup());

  const first = await h.client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc'], cwd: h.dir, env: {}, cols: 80, rows: 24,
  });
  const firstPid = (await h.client.request('process', { id: first.id })).pid;
  // THE PROPERTY IS "NO SCOPE WAS CREATED FOR THIS SESSION", not "the string
  // harbor-session appears nowhere" (2026-08-09). Falling back means INHERITING
  // the daemon's cgroup, and the daemon inherits the test runner's, so the
  // moment this suite is run from inside a Harbor session (which is how Pat
  // runs it) the inherited path legitimately contains the RUNNER's
  // `harbor-session-<its id>.scope` and the bare substring assertion failed on
  // correct behaviour. Same family as the 2026-07-29 unit-name lesson: a
  // harness must not assume it is outside the thing it is testing. Keyed to
  // this session's own id, the assertion says what it means.
  assert.doesNotMatch(cgroupOf(firstPid), new RegExp(`harbor-session-${first.id}`),
    'with the manager down the session must not get a scope of its own; it falls back to the shared cgroup');
  const sick = await h.client.request('health');
  assert.equal(sick.scopes.enabled, false, 'health must not claim containment it does not have');

  fs.writeFileSync(marker, '');
  await sleep(250); // past the retry cooldown
  const second = await h.client.request('spawn', {
    argv: ['/bin/bash', '--noprofile', '--norc'], cwd: h.dir, env: {}, cols: 80, rows: 24,
  });
  const secondPid = (await h.client.request('process', { id: second.id })).pid;
  assert.match(cgroupOf(secondPid), new RegExp(`${slice.replace('.', '\\.')}/harbor-session-${second.id}\\.scope$`),
    'once the manager answers, the same daemon must contain new sessions');
  const healed = await h.client.request('health');
  assert.equal(healed.scopes.enabled, true);
  assert.equal(healed.scopes.slice, slice);
});
