'use strict';

const fs = require('node:fs');
const os = require('node:os');

// A REBOOT IS NOT AN EXIT, WHICH IS WHY THE STORE OUTLIVED ONE (2026-08-07).
//
// A keeper writes `exit` into its state file from `terminal.onExit`. A reboot
// SIGKILLs the keeper, so that line never runs and the state file survives with
// `exit: null` and a pid from the boot that ended. The daemon then reloaded 13
// such files and reported every one of them as a running session; Harbor drew
// "13 live", marked a window "ready", and accepted a send into a pane with no
// process behind it, which is what Pat hit at work after restarting his machine.
//
// A pid is not the discriminator: pids are reused across a reboot, so
// `kill(pid, 0)` eventually answers "alive" about an unrelated process, which is
// a worse bug than the one it fixes. The boot is the discriminator, because a
// session cannot outlive the boot it was spawned in.
//
// Linux states this exactly. Everywhere else it is derived from the boot INSTANT
// (now minus uptime), which is constant within a boot and moves by the whole
// downtime plus the previous uptime across one. The tolerance absorbs clock
// adjustment and uptime rounding without coming close to a real reboot's gap.
const DERIVED_TOLERANCE_SECONDS = 60;

function currentBootId() {
  try {
    const id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (id) return `boot:${id}`;
  } catch { /* not Linux, or /proc is not mounted */ }
  return `since:${Math.round(Date.now() / 1000 - os.uptime())}`;
}

// Three-state ON PURPOSE. "unknown" is not "foreign": a state file written
// before this stamp existed, or by a platform that names its boot differently,
// must NOT be declared dead on that basis alone, because the caller reaps on a
// dead verdict and reaping a live session orphans its keeper. Unknown falls
// through to the keeper probe, which asks the session itself.
function bootRelation(recorded, current = currentBootId()) {
  if (typeof recorded !== 'string' || !recorded) return 'unknown';
  if (recorded === current) return 'same';

  const [recordedKind, recordedValue] = splitOnce(recorded);
  const [currentKind, currentValue] = splitOnce(current);
  if (recordedKind !== currentKind) return 'unknown';
  if (recordedKind === 'boot') return 'foreign';
  if (recordedKind === 'since') {
    const a = Number(recordedValue);
    const b = Number(currentValue);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 'unknown';
    return Math.abs(a - b) > DERIVED_TOLERANCE_SECONDS ? 'foreign' : 'same';
  }
  return 'unknown';
}

function splitOnce(value) {
  const index = value.indexOf(':');
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)];
}

// When a session died with a boot, the honest answer to "when" is "no later than
// this boot began". Dating it now would park a session that died overnight at the
// top of the recently-exited list for the retention window.
function bootInstant() {
  return new Date(Date.now() - os.uptime() * 1000);
}

module.exports = { currentBootId, bootRelation, bootInstant, DERIVED_TOLERANCE_SECONDS };
