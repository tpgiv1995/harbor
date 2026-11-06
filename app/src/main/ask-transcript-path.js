'use strict';

// Which file the question card reads its question OUT OF.
//
// This is one decision and it lives in one place because getting it wrong is
// invisible in exactly the worst way: the card still renders, still lists the
// options the pty can see, and silently loses the question heading and every
// option description, because those two only ever come from the transcript.
// That is what Pat reported on 2026-07-29 as "I cannot even see the question I
// am supposed to be answering", for the second time.
//
// The two rules, both learned the hard way:
//
//  1. THE INDEX IS A CACHE, NOT THE SOURCE OF TRUTH. Resolving only through the
//     harbor index means a session younger than the index has no path at all.
//     The conversation view had this identical bug and fixed it on 2026-07-28
//     by deriving the path and, failing that, scanning the project dirs for
//     `<session id>.jsonl`, which is unique across the store. The question card
//     was left behind on the old behaviour.
//
//  2. NEVER CACHE A MISS. The old code cached whatever the index returned,
//     including `null`, so the FIRST poll against a brand-new session poisoned
//     every later poll for the life of the app process. A brand-new session
//     writes its transcript on its first message and the next poll is 700ms
//     away, so "not yet" must stay retryable.

//  3. A MISS RETRIES CHEAPLY (2026-11-06, Astra review). The derived-path and
//     cwd-ancestor checks run on every poll, but the whole-store scan (every
//     project folder, 4,486 on Pat's machine) runs at most once per
//     STORE_SCAN_INTERVAL_MS per session: three polls of one missing session
//     made 13,458 access attempts, sixteen of them about 72,000 per round.
//     Same rule and interval as the conversation view (transcript.js).
const STORE_SCAN_INTERVAL_MS = 30_000;

function createAskTranscriptResolver({ getSessionMeta, findTranscript, cache = new Map(), now = Date.now } = {}) {
  const scannedAt = new Map(); // session id -> when its last whole-store scan ran
  const resolve = async (sessionId) => {
    // A provisional id names a pane, not a session, and has no transcript.
    if (!sessionId) return null;
    const id = String(sessionId);
    if (id.startsWith('pane:') || id.startsWith('live:')) return null;

    const remembered = cache.get(id);
    if (remembered) return remembered;

    let meta = null;
    try { meta = await getSessionMeta?.(id); } catch { meta = null; }

    let transcriptPath = meta?.path || null;
    if (!transcriptPath) {
      const last = scannedAt.get(id);
      const scanStore = last == null || now() - last >= STORE_SCAN_INTERVAL_MS;
      if (scanStore) {
        if (scannedAt.size > 2000) scannedAt.clear();
        scannedAt.set(id, now());
      }
      try {
        transcriptPath = await findTranscript?.({
          provider: meta?.provider || 'claude',
          sessionId: id,
          cwd: meta?.cwd || null,
          scanStore,
        });
      } catch { transcriptPath = null; }
    }

    if (transcriptPath) { cache.set(id, transcriptPath); scannedAt.delete(id); }
    return transcriptPath || null;
  };

  return {
    resolve,
    set: (sessionId, transcriptPath) => {
      if (transcriptPath) cache.set(String(sessionId), transcriptPath);
      else cache.delete(String(sessionId));
    },
    forget: (sessionId) => cache.delete(String(sessionId)),
  };
}

module.exports = { createAskTranscriptResolver, STORE_SCAN_INTERVAL_MS };
