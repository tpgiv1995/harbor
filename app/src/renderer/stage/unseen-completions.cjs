'use strict';

// "Which of these finished while I was away?" (Pat, 2026-08-14: with 12-14
// windows open and 4-5 actually running, he closes Harbor, does something
// else, and comes back unable to tell which sessions are ready for him.)
//
// The rule is DURABLE ON PURPOSE: a session is waiting for you when its
// transcript has advanced past the last time you looked at it. Harbor observes
// nothing at all while it is closed, so a marker built on watching live
// work->idle transitions (which is what notify.js does, in memory, for toasts)
// could never answer the question he actually asked. Comparing two timestamps
// can, because both survive the app being gone.
//
// The store is a WATERMARK plus per-session checks:
//   { version, seededAtMs, seen: { [sessionId]: ms } }
// The watermark is stamped once, on first run, and is what a session with no
// entry of its own falls back to. That single value does two jobs: it stops
// 719 existing rail sessions from all lighting up the moment this ships, and
// it still lets a session STARTED later announce itself, because its activity
// necessarily lands after the watermark. Storing a timestamp per session
// rather than a boolean is what lets a session finish, be checked, run again
// and mark itself a second time.

// Version 2 (2026-08-22): a deliberate ONE-TIME reset on Pat's explicit order
// ("maybe wipe clean once and see if it works from there"), after the first
// week's counts pinned at 9+ because the map also counted orchestration
// workers and scratch sessions. Loading a v1 store returns empty, and seeding
// stamps a fresh watermark, which is exactly the wipe. The no-re-seed doctrine
// below still stands for anything SILENT; an owner-ordered reset expressed as
// a version bump is the one sanctioned path.
const SEEN_STORE_VERSION = 2;
// Only sessions actually looked at get an entry, so this is generous. It exists
// because localStorage is not a database and an unbounded map is a slow leak.
const MAX_SEEN_ENTRIES = 400;

function emptyStore() {
  return { version: SEEN_STORE_VERSION, seededAtMs: null, seen: {} };
}

function loadSeenStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
  if (raw.version !== SEEN_STORE_VERSION) return emptyStore();
  const seen = {};
  const source = raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen) ? raw.seen : {};
  for (const [id, ms] of Object.entries(source)) {
    if (typeof id === 'string' && id && Number.isFinite(ms)) seen[id] = ms;
  }
  return {
    version: SEEN_STORE_VERSION,
    seededAtMs: Number.isFinite(raw.seededAtMs) ? raw.seededAtMs : null,
    seen,
  };
}

// Stamped ONCE. Re-seeding would silently mark every waiting session as read,
// which is the one failure this feature must never have.
function seedSeenStore(store, nowMs) {
  if (store.seededAtMs !== null) return store;
  if (!Number.isFinite(nowMs)) return store;
  return { ...store, seededAtMs: nowMs };
}

function seenMsFor(store, sessionId) {
  const own = store.seen[sessionId];
  return Number.isFinite(own) ? own : store.seededAtMs;
}

function markSeen(store, sessionId, nowMs) {
  if (!sessionId || !Number.isFinite(nowMs)) return store;
  const current = store.seen[sessionId];
  // Never backwards: an out-of-order update must not un-check a session.
  if (Number.isFinite(current) && current >= nowMs) return store;
  const seen = { ...store.seen, [sessionId]: nowMs };
  const ids = Object.keys(seen);
  if (ids.length > MAX_SEEN_ENTRIES) {
    // Drop the least recently checked; the newest checks are the ones whose
    // absence would show as a wrong badge.
    ids.sort((a, b) => seen[a] - seen[b]);
    for (const id of ids.slice(0, ids.length - MAX_SEEN_ENTRIES)) delete seen[id];
  }
  return { ...store, seen };
}

// 'blocked' | 'finished' | null.
//
// `activeMs` is the session's TRANSCRIPT activity time. It must never be the
// rail's live heartbeat: sidebar-model stamps `lastActiveMs = now` on every
// refresh for a pane with no history row, and a clock that always reads "now"
// would re-mark a session the instant it was checked, forever.
//
// `working`/`blocked` come from the open transcript's header where there is
// one, and from the daemon's agent status otherwise: the transcript is
// preferred for the same reason the voice settle-watcher prefers it, that
// agent detection lags 60-150s and this is a promptness feature.
function attentionFor(session, store) {
  if (!session || !store) return null;
  // Orchestration workers and scratch sessions are not waiting FOR PAT: a
  // fleet of batch workers finishing all day pinned the finished count at 9+
  // permanently, which told him nothing (2026-08-22).
  if (session.excluded) return null;
  // You are looking at it; by definition it is checked.
  if (session.isSelected) return null;
  // Something needing an answer outranks something merely done: they ask
  // different things of you, and a blocked session reported as "finished"
  // would be a lie you act on.
  if (session.blocked) return 'blocked';
  if (session.working) return null;
  // No transcript row means no turn has completed and no honest clock.
  if (!session.isHistorical) return null;
  const activeMs = session.activeMs;
  if (!Number.isFinite(activeMs) || activeMs <= 0) return null;
  const seenMs = seenMsFor(store, session.id);
  // An unseeded store marks nothing, so the first paint cannot flash badges
  // before seeding has run.
  if (!Number.isFinite(seenMs)) return null;
  return activeMs > seenMs ? 'finished' : null;
}

function countAttention(sessions, store) {
  let finished = 0;
  let blocked = 0;
  for (const session of sessions || []) {
    const state = attentionFor(session, store);
    if (state === 'finished') finished += 1;
    else if (state === 'blocked') blocked += 1;
  }
  return { finished, blocked, total: finished + blocked };
}

// The TASKBAR's counts. Finished keeps the seen/selection gating of the rail
// pips, but blocked is a LIVE state: an unanswered question needs Pat whether
// or not its window is selected, because the badge exists precisely for when
// he is alt-tabbed away from Harbor (live-caught 2026-08-22: a session asked
// a question in its selected window and the taskbar never went amber, because
// selection suppressed it the way it rightly suppresses the rail pip). The
// amber clears the moment the question is answered, since answering unblocks
// the session; no seen-store bookkeeping is involved.
//
// And the badge speaks ONLY for sessions OPEN AS WINDOWS (open: true). The
// rail lists every transcript under ~/.claude/projects, and any of them that
// advanced after the watermark counted here forever, because terminal and
// agent-fleet sessions are never selected in Harbor and so never marked seen:
// that is what pinned the taskbar at 9+ around the clock even after the
// 2026-08-22 v2 wipe (Pat, 2026-08-30: two sessions open, badge stuck at 9+,
// "i dont think this has ever worked properly"). Open tiles persist across
// relaunches, so the original question ("which of my windows finished while
// I was away?") still gets its durable answer; the rail pips keep the wider
// per-row semantics for anyone scanning history.
function badgeCounts(sessions, store) {
  let finished = 0;
  let blocked = 0;
  for (const session of sessions || []) {
    if (!session || session.excluded || !session.open) continue;
    if (session.blocked) {
      blocked += 1;
      continue;
    }
    if (attentionFor(session, store) === 'finished') finished += 1;
  }
  return { finished, blocked, total: finished + blocked };
}

module.exports = {
  SEEN_STORE_VERSION,
  MAX_SEEN_ENTRIES,
  emptyStore,
  loadSeenStore,
  seedSeenStore,
  markSeen,
  seenMsFor,
  attentionFor,
  countAttention,
  badgeCounts,
};
