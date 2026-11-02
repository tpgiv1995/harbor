'use strict';

// A WINDOW THAT CANNOT SHOW ITS CONVERSATION LEAVES EVIDENCE (2026-11-01).
// A brand-new cdt-app session's window sat on "Live session" / "No transcript
// yet" until Pat restarted Harbor ("still shouldnt have to do that"); the
// transcript was on disk the whole time and nothing reproduced it afterwards.
// Either the window kept a provisional key (pane:/live:, see
// provisional-upgrade.cjs) that the rail never paired with a session, or its
// transcript open kept failing. This watch notes each window that stays in
// either state, or whose transcript open has never answered at all (a
// rejected open leaves no "missing" record), for 45 s, once, with what the
// rail knew about it; it notes "window-bound" when that same window then shows
// its conversation, and "window-left" when the window went away without that
// being seen (renamed to its session or closed: the log cannot tell which).
// Perf log kinds "window-unbound" / "window-bound" / "window-left". Ids and
// paths only, never conversation text.
const UNBOUND_REPORT_MS = 45_000;
const PROVISIONAL_RE = /^(pane|live):/;

function railFacts(row) {
  if (!row) return null;
  return { id: String(row.id), paneId: row.paneId || null, provider: row.provider || null, live: Boolean(row.live ?? row.paneId) };
}

function createUnboundWatch({ reportAfterMs = UNBOUND_REPORT_MS } = {}) {
  const since = new Map(); // window key -> { at, reported }
  return function check({ tiles = [], transcripts = new Map(), sessions = new Map(), now = Date.now() } = {}) {
    const events = [];
    const present = new Set();
    for (const tile of tiles) {
      const key = String(tile?.sessionId || '');
      if (!key) continue;
      present.add(key);
      const provisional = PROVISIONAL_RE.test(key);
      const missing = !provisional && Boolean(transcripts.get(key)?.missing);
      const opening = !provisional && !transcripts.has(key);
      const seen = since.get(key);
      if (!(provisional || missing || opening)) {
        if (seen) {
          since.delete(key);
          if (seen.reported) events.push({ kind: 'window-bound', ms: now - seen.at, context: { window: key } });
        }
        continue;
      }
      if (!seen) { since.set(key, { at: now, reported: false }); continue; }
      if (seen.reported || now - seen.at < reportAfterMs) continue;
      seen.reported = true;
      const paneId = provisional ? key.replace(PROVISIONAL_RE, '') : null;
      let row = null;
      if (paneId) {
        for (const candidate of sessions.values()) if (candidate?.paneId === paneId) { row = candidate; break; }
      } else {
        row = sessions.get(key) || null;
      }
      events.push({
        kind: 'window-unbound',
        ms: now - seen.at,
        context: { window: key, provisional, transcriptMissing: missing, neverOpened: opening, rail: railFacts(row) },
      });
    }
    // A provisional window that was renamed to its session (or closed) leaves
    // the tile set; a reported one says how long it took.
    for (const [key, seen] of [...since]) {
      if (present.has(key)) continue;
      since.delete(key);
      if (seen.reported) events.push({ kind: 'window-left', ms: now - seen.at, context: { window: key } });
    }
    return events;
  };
}

module.exports = { createUnboundWatch, UNBOUND_REPORT_MS };
