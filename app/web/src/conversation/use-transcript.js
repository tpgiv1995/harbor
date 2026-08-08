import { useEffect, useState } from 'react';

// Opens a session's transcript over the RPC client and keeps it in sync with
// the server's `transcript:update` pushes (replace/append/changed), the same
// three payload shapes the desktop's transcript provider emits. Ref-counted
// open/close lives server-side (main/providers/transcript.js); this hook only
// has to open on mount, close on unmount or session change, and apply
// whichever payload shape arrives.
export function useTranscript(client, sessionId) {
  const [state, setState] = useState({ blocks: [], header: null, missing: false, loading: true });

  useEffect(() => {
    if (!client || !sessionId) {
      setState({ blocks: [], header: null, missing: false, loading: false });
      return undefined;
    }
    let cancelled = false;
    setState({ blocks: [], header: null, missing: false, loading: true });

    // A MISS IS NEVER PERMANENT. A brand-new session writes its transcript on its
    // first message, so "not found" means "not yet". The desktop learned this
    // three separate times (see the index-is-a-cache note in CLAUDE.md): a
    // consumer that caches the miss shows "No transcript yet." forever on a
    // session that is plainly on disk moments later. So retry on a slow tick,
    // and never let a late failure overwrite blocks that already arrived.
    let retry = null;
    // The retry ticker is started on demand and stopped on success, so a
    // re-open that fails after a reconnect gets the same patience the first
    // open got. Without this, the only thing that ever restarted a failed
    // re-open was the NEXT reconnect, which on a healthy link never comes.
    const armRetry = () => { if (!retry) retry = setInterval(attempt, 4000); };
    const disarmRetry = () => { if (retry) { clearInterval(retry); retry = null; } };
    const missOrKeep = () => {
      armRetry();
      setState((prev) => (prev.blocks.length
        ? { ...prev, loading: false }
        : { ...prev, loading: false, missing: true }));
    };
    const attempt = () => {
      // Unwindowed (desktop default): every push replaces the FULL block
      // list. A session this bridge has forked dozens of times tonight while
      // inheriting its whole prior history each time is now 5MB+, and a
      // single full-snapshot push for it overflows the mobile client's
      // per-connection queue outright (live-caught 2026-08-07: connect,
      // overflow, close, reconnect, every ~4s, unusable). `window` is an
      // EXISTING hint transcript.js already honors (MOBILE-3) to cap a
      // `replace` payload to the most recent N blocks; the desktop renderer
      // passes it, the mobile web client never did. `header`'s context math
      // is untouched by this (transcript.js prices it off the full live
      // parser state, never off the trimmed list), so this loses only
      // scrollback the mobile view never showed anyway, not accuracy.
      client.call('transcript:open', { sessionId, window: { blocks: 60 } }).then((result) => {
        if (cancelled) return;
        if (result?.ok) { disarmRetry(); return; }
        missOrKeep();
      }).catch(() => {
        if (cancelled) return;
        missOrKeep();
      });
    };
    attempt();
    armRetry();

    // A RECONNECT LOSES THE OPEN. The server refcounts `transcript:open` per
    // clientId and releases everything a client held when its socket closes,
    // so a new connection is watching nothing until it asks again. Nothing did
    // ask: `attempt` stops its retry on the first success, which is correct for
    // "not written yet" and wrong for "the socket died". The conversation then
    // sat frozen at whatever had arrived before the drop, with no error and
    // nothing on screen to say so, which is exactly how a live session reads as
    // a dead one (2026-08-08, alongside the queue-overflow flapping that made
    // drops routine rather than rare).
    const reconnected = client.onConnection?.((state) => {
      if (state === 'connected' && !cancelled) attempt();
    });

    const unsubscribe = client.onChannel('transcript:update', (payload) => {
      if (!payload || payload.sessionId !== sessionId) return;
      setState((prev) => {
        if (Array.isArray(payload.replace)) {
          return { blocks: payload.replace, header: payload.header || null, missing: false, loading: false };
        }
        let blocks = prev.blocks;
        if (payload.changed?.length) {
          const byKey = new Map(payload.changed.map((b) => [b.key, b]));
          blocks = blocks.map((b) => byKey.get(b.key) || b);
        }
        if (payload.append?.length) blocks = [...blocks, ...payload.append];
        return { blocks, header: payload.header || prev.header, missing: false, loading: false };
      });
    });

    return () => {
      cancelled = true;
      disarmRetry();
      unsubscribe();
      reconnected?.();
      client.call('transcript:close', { sessionId }).catch(() => {});
    };
  }, [client, sessionId]);

  return state;
}
