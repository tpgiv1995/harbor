'use strict';

// Decides whether a session with NO Harbor pane is being driven by a live
// writer in an outside terminal (adopt-on-send) or is dead (resume-then-send).
//
// The beacon's processAlive is exact: the main process checks the teed pid
// against /proc at emit time, with a pid-reuse guard requiring the cmdline to
// still be a claude. It therefore OUTRANKS the transcript's working flag: a
// session killed mid-turn freezes its transcript in a working state, and
// trusting that stale signal routed a send into a takeover of a process that
// no longer existed (live-caught 2026-07-24, the OOM kill).
//
// Twin rule: this CommonJS file and session-liveness.js must stay identical.
const EXTERNAL_LIVE_RECENCY_MS = 3 * 60 * 1000;

function externalLiveFromHeader(header, nowMs) {
  if (!header) return false;
  if (header.processAlive === false) return false;
  if (header.working) return true;
  if (header.processAlive === true) return true;
  // No beacon ever written: fall back to short transcript recency.
  return Boolean(header.lastWriteMs && nowMs - header.lastWriteMs < EXTERNAL_LIVE_RECENCY_MS);
}

module.exports = { externalLiveFromHeader };
