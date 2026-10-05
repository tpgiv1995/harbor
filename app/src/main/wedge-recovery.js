'use strict';

// The watchdog's onWedge policy: heal the daemon IN PLACE, never relaunch the
// app for a daemon wedge (2026-08-30). The old body ran app.relaunch() after
// recovery because a WEDGED daemon's established connections never emit
// 'close', so the bridges sat silently dead against the old socket. Every
// recovery lane now ends with the wedged process dead (the daemon-watch
// supervisor kills its own child; `harbor-sessiond recover` kills a verified
// owner), so the bridges' close-triggered reconnect always fires and rebuilds
// observers through the normal attach+backfill path. The banner returns to ok
// via the bridges' existing 'connection-restored'; reconnectNow only cuts the
// reconnect backoff tail. On failure the error banner stays and `daemon:retry`
// remains the manual path (whose relaunch is the designed last resort).
//
// Part of Harbor (see README.md). Extracted from index.js so the policy is
// unit-testable without Electron (test/main/wedge-recovery.test.js).

function createWedgeRecovery({ connectDaemon, setBanner, reconnectNow = () => {}, log = () => {} } = {}) {
  if (typeof connectDaemon !== 'function' || typeof setBanner !== 'function') {
    throw new TypeError('createWedgeRecovery requires connectDaemon and setBanner functions');
  }
  return async function onWedge() {
    log('daemon watchdog: session daemon unresponsive; recovering it in place (no app relaunch)');
    setBanner({ error: 'recovering: the session daemon went unresponsive; restarting it cleanly...' });
    const ok = await connectDaemon({ recover: true });
    if (ok) {
      log('daemon watchdog: daemon recovered; bridges reconnect in place');
      try { reconnectNow(); } catch { /* a poke, never a dependency */ }
    } else {
      log('daemon watchdog: recovery failed; leaving the error banner for the manual retry path');
    }
    return ok;
  };
}

module.exports = { createWedgeRecovery };
