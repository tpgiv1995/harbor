'use strict';

// ONE SESSION IS ONE CGROUP (2026-08-09).
//
// Every keeper used to be a plain forked child of the daemon, and a fork
// inherits its parent's CGROUP. So all of them lived in
// harbor-sessiond.service, one cgroup, no ceiling. On 2026-08-09 at 00:28 that
// cgroup reached 45.7G across 20 live sessions; systemd-oomd picked it as the
// worst candidate under user@1000 and killed ALL 497 PROCESSES IN IT at once,
// and the global reclaim that ran up to that moment had already paged GNOME
// Shell (214M) and RuneLite (694M) out to swap, so the desktop stopped
// responding before anything was killed. Pat's report: the machine was bricked
// and RuneLite had "crashed"; RuneLite had not crashed, it was on disk.
//
// This is the SAME shape as the 2026-07-28 daemon fix one level up (`setsid`
// detaches from the process tree but not from the cgroup, so a daemon
// and every pane inherited `app-gnome-harbor-<pid>.scope` and one oomd kill
// took the lot). That fix gave the daemon its own unit. This one gives each
// SESSION its own scope, in a slice with a hard ceiling, so:
//
//   * oomd's candidate is ONE session, not the whole daemon;
//   * a runaway session is contained by the KERNEL at its own MemoryMax,
//     which does not depend on oomd's candidate-selection heuristics at all;
//   * Harbor physically cannot take the memory the desktop needs, so Harbor
//     can never again be the reason GNOME Shell gets reclaimed.
//
// Raising the oomd pressure limit is NOT a fix and must not be attempted again
// (it was already raised from 50% to 80% on 2026-07-01): a bigger threshold
// moves the kill later, it does not bound what Harbor takes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');

const DEFAULT_SLICE = 'harbor-sessions.slice';
const GIB = 1024 * 1024 * 1024;

// A RELOCATED STORE IS NOT THE REAL INSTALLATION. Same rule, and the same
// reason, as `resolveUnitPolicy` in bin/harbor-bin.cjs: a harness that pointed
// HARBOR_SESSIOND_DIR at a throwaway directory has no business writing unit
// files into the user's systemd config or filing its sessions under the name
// the real daemon uses. Naming a slice explicitly is the escape, and the
// harness picks the name.
function resolveScopePolicy(env = process.env, platform = process.platform) {
  if (platform !== 'linux') return { enabled: false, reason: 'not linux' };
  if (env.HARBOR_SESSIOND_NO_SCOPE === '1') return { enabled: false, reason: 'opted out (HARBOR_SESSIOND_NO_SCOPE=1)' };
  const relocated = Boolean(env.HARBOR_SESSIOND_DIR || env.HARBOR_SESSIOND_SOCKET);
  const named = env.HARBOR_SESSIOND_SLICE;
  if (relocated && !named) {
    return { enabled: false, reason: 'relocated store did not name its own slice (HARBOR_SESSIOND_SLICE)' };
  }
  return {
    enabled: true,
    slice: named || DEFAULT_SLICE,
    // A session may GROW past MemoryHigh; it is throttled and reclaimed there,
    // not killed. MemoryMax is the wall. Measured baseline for one real session
    // with a full six-server MCP stack (browser automation, docs, several
    // stdio servers) is 3.0G, so 8G/12G is generous headroom and still small
    // enough that four runaway sessions cannot fill the pool.
    memoryHigh: env.HARBOR_SESSIOND_SESSION_MEMORY_HIGH || '8G',
    memoryMax: env.HARBOR_SESSIOND_SESSION_MEMORY_MAX || '12G',
    // The slice's swap allowance (6G) is POOLED, and tonight's single runaway
    // took 4.9G of it alone: without a per-session cap one misbehaving session
    // starves every sibling of swap and pushes them toward reclaim kills for
    // something they did not do (review round 1).
    memorySwapMax: env.HARBOR_SESSIOND_SESSION_MEMORY_SWAP_MAX || '2G',
    // ONE SESSION MUST NOT BE ABLE TO TAKE THE MACHINE (2026-08-09, reported
    // after the pool cap alone did not answer it: one web-design session should
    // not be able to throttle a 24-core workstation). Bounding the POOL at two thirds
    // of the cores still let a single session have all of it, and one did:
    // a headless-Chrome render sweep sat at 9.6 sustained cores. A session gets
    // half the pool, so two heavy sessions fit inside the pool ceiling and one
    // heavy session leaves the other half of the machine alone. Derived from
    // the core count, never pinned to this box, same rule as the memory sizes.
    cpuQuota: env.HARBOR_SESSIOND_SESSION_CPU_QUOTA || `${sessionCpuPercent()}%`,
    // Equal weight between sessions (the systemd default), which matters only
    // when they contend; the SLICE carries the weight that puts the desktop
    // ahead of all of them.
    cpuWeight: env.HARBOR_SESSIOND_SESSION_CPU_WEIGHT || '100',
    // Only the real installation owns the default slice's unit file.
    manageUnit: !relocated && !named,
  };
}

// The pool ceiling is DERIVED from the machine, not pinned to Pat's 62GiB box,
// because a hardcoded 38G is wrong on every other machine and silently wrong
// after a RAM upgrade. A third of RAM (at least 16GiB) is reserved for
// everything that is not Harbor; the measured non-Harbor baseline on the box
// this was written for is ~11G (GNOME Shell, RuneLite, Outlook, Edge, Chrome,
// Nemo, Dropbox, Meeting Assistant), so a third is comfortable rather than tight.
function poolLimits(totalBytes = os.totalmem()) {
  const reserve = Math.max(16 * GIB, Math.floor(totalBytes / 3));
  const max = Math.max(4 * GIB, totalBytes - reserve);
  const high = Math.floor(max * 0.85);
  return { max, high, reserve };
}

function gib(bytes) { return `${Math.max(1, Math.round(bytes / GIB))}G`; }

// MEMORY WAS BOUNDED AND CPU NEVER WAS (2026-08-09, second half of the same
// lesson). Pat: "randomly due to claude processes i'll have my laptop kick on
// the afterburners ... doesnt pass the sniff test". Traced live to a session
// running a headless-Chrome render sweep at 9.5 sustained cores, with the whole
// pool at 10.7 of 24 and `CPUQuotaPerSecUSec=infinity`, `CPUWeight` unset on
// both the slice and every scope. So one session could take the machine, pin
// the package at its 105C ceiling and hold the fans at maximum, and nothing
// anywhere said no. The memory containment added earlier that day has an exact
// CPU-shaped hole in it.
//
// TWO CONTROLS, doing different jobs:
//  - CPUWeight is RELATIVE and costs nothing when the machine is not contended.
//    Below the default 100, so when Harbor and the desktop both want the CPU
//    the compositor wins. This is what stops a build making the mouse stutter.
//  - CPUQuota is ABSOLUTE and is the actual ceiling on heat. A third of the
//    cores are reserved, mirroring the memory reserve above, so a runaway fleet
//    cannot take the whole package.
//
// Neither replaces the thermal fix: RAPL PL1 on this machine reads 200 W and
// the Dell EC ignores writes to it, as does the ACPI platform_profile (both
// measured). CPU energy-performance-preference was the lever that worked
// (117 W -> 88 W on an identical 4-core load), and it lives in
// /etc/systemd/system/cpu-epp-balance-power.service, outside this repo.
function cpuLimits(cores = os.cpus().length) {
  const usable = Math.max(1, cores - Math.max(1, Math.floor(cores / 3)));
  return { quotaPercent: usable * 100, weight: 60, usable };
}

// Half the pool, so two heavy sessions still fit under the pool ceiling and one
// heavy session cannot reach it alone. On 24 cores: pool 16, session 8.
function sessionCpuPercent(cores = os.cpus().length) {
  return Math.max(1, Math.floor(cpuLimits(cores).usable / 2)) * 100;
}

function sliceUnitText(totalBytes = os.totalmem(), cores = os.cpus().length) {
  const { max, high, reserve } = poolLimits(totalBytes);
  const { quotaPercent, weight, usable } = cpuLimits(cores);
  return `[Unit]
Description=Harbor Claude sessions (memory- and cpu-bounded pool)
# GENERATED by app/src/daemon/session-scope.js. Edit that file, not this one.
#
# Sized for ${gib(totalBytes)} of RAM: ${gib(reserve)} is reserved for everything that is
# not Harbor, so the desktop can never be reclaimed to make room for sessions.
# Sized for ${cores} cores: sessions may use ${usable} of them together, so a render
# sweep or a build fleet cannot pin the package at its thermal ceiling and hold
# the fans at maximum. CPUWeight keeps the desktop ahead of Harbor when both
# want the CPU at once.
# See the header of session-scope.js for the incidents these prevent.

[Slice]
MemoryHigh=${gib(high)}
MemoryMax=${gib(max)}
MemorySwapMax=6G
CPUWeight=${weight}
CPUQuota=${quotaPercent}%
`;
}

function userUnitDir(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user');
}

// Self-installing ON PURPOSE. This guard has to survive a fresh clone, a new
// machine and anything that resets ~/.config, because the failure it prevents
// has now cost Pat the whole desktop more than once and a guard that silently
// stops existing is not a guard. Writing is idempotent: identical content is
// left alone, so no daemon-reload happens on the common path.
function ensureSliceUnit(policy, {
  env = process.env,
  totalBytes = os.totalmem(),
  log = () => {},
  // Injectable so a harness exercising the WRITE never reloads the real user
  // manager as a side effect (review round 1; "tests never touch the real
  // daemon" applies to the manager too).
  reload = () => spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', timeout: 10000 }),
} = {}) {
  if (!policy.enabled || !policy.manageUnit) return { written: false, reason: 'not managed' };
  const dir = userUnitDir(env);
  const file = path.join(dir, DEFAULT_SLICE);
  const wanted = sliceUnitText(totalBytes);
  try {
    if (fs.readFileSync(file, 'utf8') === wanted) return { written: false, reason: 'current', file };
  } catch {}
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, wanted, { mode: 0o644 });
    reload();
    log(`installed ${file}`);
    return { written: true, file };
  } catch (error) {
    // A slice we could not write is not a reason to refuse to run sessions.
    log(`could not install ${file}: ${error.message}`);
    return { written: false, reason: error.message, file };
  }
}

// CAN WE ACTUALLY DO THIS? Asked with a REAL scope, never by testing that the
// binary exists: systemd-run can be present while the user manager is not
// reachable, and the slice can be missing. The probe carries the SAME memory
// properties the real launch will (review round 1: a malformed operator
// override like "8GB" must fail here, loudly and once, not on every spawn),
// so its answer is the same answer the real spawn would get. Never throws:
// a probe that dies of resource exhaustion is a "no", not a daemon crash.
// Async ON PURPOSE (review round 2): the retry path runs inside a live spawn
// request, and a synchronous 10s systemd round-trip there blocks every other
// session's traffic through the daemon's one event loop.
function probeScopeSupport(policy, { run = null } = {}) {
  if (!policy.enabled) return Promise.resolve(false);
  const args = [
    '--user', '--scope', '--quiet', '--collect',
    `--slice=${policy.slice}`,
    `--property=MemoryHigh=${policy.memoryHigh}`,
    `--property=MemoryMax=${policy.memoryMax}`,
    `--property=MemorySwapMax=${policy.memorySwapMax}`,
    `--property=CPUQuota=${policy.cpuQuota}`,
    `--property=CPUWeight=${policy.cpuWeight}`,
    '--', 'true',
  ];
  if (run) {
    try {
      const result = run('systemd-run', args, { encoding: 'utf8', timeout: 10000 });
      return Promise.resolve(Boolean(result && result.status === 0));
    } catch { return Promise.resolve(false); }
  }
  return new Promise((resolve) => {
    try {
      execFile('systemd-run', args, { encoding: 'utf8', timeout: 10000 }, (error) => resolve(!error));
    } catch { resolve(false); }
  });
}

// The argv that puts `command` in its own scope. `systemd-run --scope` EXECS
// the command in place (verified: /proc/<pid>/comm is the command, not
// systemd-run), which is what lets daemon.js keep watching the returned child
// for an exit and still learn that a keeper died during startup.
function scopeCommand(id, policy, command, args) {
  return {
    command: 'systemd-run',
    args: [
      '--user', '--scope', '--quiet', '--collect',
      `--unit=harbor-session-${id}.scope`,
      `--slice=${policy.slice}`,
      `--description=Harbor session ${id}`,
      `--property=MemoryHigh=${policy.memoryHigh}`,
      `--property=MemoryMax=${policy.memoryMax}`,
      `--property=MemorySwapMax=${policy.memorySwapMax}`,
      `--property=CPUQuota=${policy.cpuQuota}`,
      `--property=CPUWeight=${policy.cpuWeight}`,
      '--', command, ...args,
    ],
  };
}

module.exports = {
  DEFAULT_SLICE,
  resolveScopePolicy,
  poolLimits,
  cpuLimits,
  sessionCpuPercent,
  sliceUnitText,
  userUnitDir,
  ensureSliceUnit,
  probeScopeSupport,
  scopeCommand,
};
