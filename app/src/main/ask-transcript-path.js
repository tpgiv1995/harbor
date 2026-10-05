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

function createAskTranscriptResolver({ getSessionMeta, findTranscript, cache = new Map() } = {}) {
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
      try {
        transcriptPath = await findTranscript?.({
          provider: meta?.provider || 'claude',
          sessionId: id,
          cwd: meta?.cwd || null,
        });
      } catch { transcriptPath = null; }
    }

    if (transcriptPath) cache.set(id, transcriptPath);
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

module.exports = { createAskTranscriptResolver };
