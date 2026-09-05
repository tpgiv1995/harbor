'use strict';

// Mid-session wedge detection. A daemon can keep established connections open
// while it stops answering requests, so the reliable signal is an active probe.
// Recovery is the caller's job; this module owns only the detection policy.
//
// Part of Harbor (see README.md).

function createDaemonWatchdog({
  ping, // () => Promise; must reject on its own timeout
  onWedge, // async () => void; called once per trip, never concurrently
  intervalMs = 30_000,
  failuresToTrip = 2,
  log = () => {},
} = {}) {
  if (typeof ping !== 'function' || typeof onWedge !== 'function') {
    throw new TypeError('createDaemonWatchdog requires ping and onWedge functions');
  }

  let timer = null;
  let failures = 0;
  let busy = false; // a tick in flight; a slow ping must not stack ticks
  let recovering = false; // onWedge in flight; no probing or re-tripping under it

  async function tick() {
    if (busy || recovering) return;
    busy = true;
    try {
      await ping();
      failures = 0;
    } catch (e) {
      failures += 1;
      log(`daemon watchdog: ping failed (${failures}/${failuresToTrip}): ${e.message}`);
      if (failures >= failuresToTrip) {
        failures = 0; // a fresh wedge after recovery must earn its own trip
        recovering = true;
        try {
          await onWedge();
        } finally {
          recovering = false;
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick, // exposed for tests; production runs it only from the interval
    get failures() {
      return failures;
    },
  };
}

module.exports = { createDaemonWatchdog };
