'use strict';

// WHICH SESSIONS HARBOR PUT TO SLEEP, KEPT PAST THE FIVE-MINUTE REAP (2026-10-06).
// Pat: "we should definitely have a different indication for something not
// running vs something dormant". The keeper writes `dormant: true` into the
// exit record of a session dormancy ended (keeper.js terminate), but the
// daemon deletes that record with the state file five minutes after the exit
// (allStates' retention reap). After that, a session Harbor ended for sitting
// idle and one Pat closed himself looked identical everywhere, and the rail
// could only say "not running" for both.
//
// This ledger keeps ONE fact per provider session id (the `agent_session` the
// rail's history rows are keyed by): when Harbor last put it to sleep. It is
// written where every exit is already observed exactly once (daemon.js
// noteExitObserved), so it needs no new lifecycle state and no new timer. An
// exit that was NOT a dormancy sleep and is newer than the entry removes it,
// because the newest ending is the one the rail describes. Bounded: entries
// older than 30 days drop out and at most 500 are kept, newest first.
//
// It is a record of what the daemon did, never liveness: the rail still asks
// whether a session is running from the live panes, and only consults this
// for a session that is not.

const fs = require('node:fs');

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

function readLedger(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sessions = data?.sessions;
    return sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {};
  } catch {
    return {};
  }
}

function pruned(sessions, nowMs) {
  return Object.fromEntries(Object.entries(sessions)
    .filter(([, entry]) => {
      const at = Date.parse(entry?.at);
      return Number.isFinite(at) && nowMs - at < MAX_AGE_MS;
    })
    .sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, MAX_ENTRIES));
}

function writeLedger(file, sessions) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ v: 1, sessions })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// One observed exit. Returns true when the ledger changed.
function noteExit(file, state, nowMs = Date.now()) {
  const key = typeof state?.agent_session === 'string' && state.agent_session ? state.agent_session : null;
  const at = Date.parse(state?.exit?.at);
  if (!key || !Number.isFinite(at)) return false;
  const sessions = readLedger(file);
  const previous = sessions[key];
  if (state.exit.dormant) {
    if (previous && Date.parse(previous.at) >= at) return false;
    sessions[key] = {
      at: state.exit.at,
      agent: state.agent || null,
      ...(typeof state.exit.reason === 'string' && state.exit.reason ? { reason: state.exit.reason } : {}),
    };
  } else if (previous && at >= Date.parse(previous.at)) {
    delete sessions[key];
  } else {
    return false;
  }
  writeLedger(file, pruned(sessions, nowMs));
  return true;
}

module.exports = { readLedger, noteExit, MAX_AGE_MS, MAX_ENTRIES };
