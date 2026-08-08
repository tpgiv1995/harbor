'use strict';

// Which provisional windows can adopt a real session id, and what the stage
// looks like afterwards.
//
// A new session opens as a `pane:<paneId>` window Pat can type into at once,
// and its id upgrades to the real session id once that session exists. The
// upgrade used to be emitted only by the launch flow, which watches for a fresh
// transcript for 45 seconds and then gives up. Live-caught 2026-07-28, and it
// looked exactly like lost work: he composed for twenty minutes, and by the
// time he pressed Enter nobody was watching any more. The send landed and a
// real session went to work on it, but the window kept the provisional id, and
// provisional ids are excluded from transcript subscriptions, so it sat on
// "Fresh session. Type below to start it." while his message ran out of sight.
//
// The sidebar model carries the daemon's own pane-to-session pairing and
// arrives continuously, so deciding from it has no timeout to outlive and no
// startup race to lose. The decision lives here rather than inside the effect
// so the tests and the stage cannot drift.

// Two window keys carry a pane id instead of a session id, and both must
// upgrade. `pane:<paneId>` is a window Harbor launched before the session
// existed. `live:<paneId>` is a pane the rail listed before any evidence named
// its session (a codex/cursor window opened from the rail). The live: case was
// missed until 2026-08-08: when the provider linker names the pane, the live:
// row BECOMES the real-id row, so a live: window that cannot upgrade stops
// resolving a session at all and Stage drops it mid-look.
const PROVISIONAL_PREFIXES = ['pane:', 'live:'];

const provisionalPaneId = (key) => {
  for (const prefix of PROVISIONAL_PREFIXES) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return null;
};

const isReal = (id) => {
  const s = String(id || '');
  return Boolean(s) && provisionalPaneId(s) === null;
};

// sessions: iterable of rail rows ({ id, paneId }). Returns null when nothing
// changes, so a caller can bail without touching state.
function planProvisionalUpgrades({ tiles = [], selectedId = null, focusedId = null, sessions = [] } = {}) {
  const paneToSession = new Map();
  for (const session of sessions) {
    if (!session?.paneId || !isReal(session.id)) continue;
    if (!paneToSession.has(session.paneId)) paneToSession.set(session.paneId, String(session.id));
  }
  if (!paneToSession.size) return null;

  const upgrades = new Map(); // provisional key -> real id
  for (const tile of tiles) {
    const key = String(tile?.sessionId || '');
    const paneId = provisionalPaneId(key);
    if (paneId === null) continue;
    const real = paneToSession.get(paneId);
    if (real) upgrades.set(key, real);
  }
  if (!upgrades.size) return null;

  const claimed = new Set(upgrades.values());
  const next = tiles
    // An older window may already hold the real id (he reopened the session
    // from the rail while its launch was still provisional). The upgraded one
    // wins, because that is the window he has been typing into, and two windows
    // on one session means two transcripts of one file and two drafts.
    .filter((t) => !(claimed.has(String(t.sessionId)) && !upgrades.has(String(t.sessionId))))
    .map((t) => (upgrades.has(String(t.sessionId))
      ? { ...t, sessionId: upgrades.get(String(t.sessionId)) }
      : t));

  return {
    tiles: next,
    selectedId: upgrades.get(String(selectedId)) || selectedId,
    focusedId: upgrades.get(String(focusedId)) || focusedId,
    // The draft moves WITH the window, or the composer reads the new id, finds
    // nothing, and blanks itself mid-sentence (2026-07-27).
    renames: [...upgrades.entries()],
  };
}

module.exports = { planProvisionalUpgrades };
