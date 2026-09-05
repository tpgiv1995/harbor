'use strict';

// Per-client resource ownership.
//
// Everything under src/main/ was written for Electron main, where there is
// exactly ONE client (the renderer) and it dies with the process. The mobile
// server hands those same providers to MANY clients, any of which can vanish
// mid-flight and come back. Nothing in the provider layer has ever had a
// concept of a caller: `clientId` was computed by the transport, passed into
// router.call, and read by nobody. So a resource acquired on behalf of a client
// could not be attributed to it, and therefore could not be released when it
// went away.
//
// Measured on 2026-08-03 against real transcripts, six sessions viewed by
// clients that then vanished the way a phone does: rss 73MB -> 342MB, six
// permanently armed fs watchers and 5s pollers, and NOTHING released six
// seconds after every client was gone. Each stranded entry keeps re-reading its
// transcript forever, which is the other half of the same incident: a
// harbor-server run that burned 18 minutes of CPU in 20 minutes of wall clock
// and peaked at 6.4G, silently, with no log line of its own.
//
// This is deliberately a REGISTRY and not a repair inside transcript.js.
// `transcript:open` is merely the first method that acquires per-client state;
// the next one to be added would have exactly the same hole. A method that
// acquires registers a releaser here and gets teardown for free.
//
// It also closes a second hole in the same shape: releases are checked against
// what the CALLER holds, so one client can no longer close a transcript another
// client opened (which decremented the owner's refcount and stranded it).
//
// Part of Harbor (see README.md).

function createClientResources({ releasers = {}, logger = console } = {}) {
  // clientId -> kind -> key -> count. A count, not a flag: a client may open
  // the same session twice (two windows on one session is ordinary), and it
  // must be released exactly as many times as it was acquired.
  const byClient = new Map();

  const bucket = (clientId, kind) => {
    let kinds = byClient.get(clientId);
    if (!kinds) { kinds = new Map(); byClient.set(clientId, kinds); }
    let keys = kinds.get(kind);
    if (!keys) { keys = new Map(); kinds.set(kind, keys); }
    return keys;
  };

  return {
    // Record that `clientId` now holds one more of (kind, key).
    acquire(clientId, kind, key) {
      if (!clientId || key == null) return false;
      const keys = bucket(clientId, kind);
      keys.set(key, (keys.get(key) || 0) + 1);
      return true;
    },

    // Give one back. Returns false when this client does not hold it, which the
    // caller should treat as "do not release the underlying resource": the
    // holder is someone else, or it was already released.
    release(clientId, kind, key) {
      if (!clientId || key == null) return false;
      const keys = byClient.get(clientId)?.get(kind);
      const count = keys?.get(key) || 0;
      if (count <= 0) return false;
      if (count === 1) keys.delete(key); else keys.set(key, count - 1);
      return true;
    },

    // The client is gone. Release everything it still held, exactly as many
    // times as it acquired it, and forget it. A releaser that throws must never
    // strand the rest, so each one is isolated.
    releaseAll(clientId) {
      const kinds = byClient.get(clientId);
      byClient.delete(clientId);
      const released = [];
      if (!kinds) return released;
      for (const [kind, keys] of kinds) {
        const releaser = releasers[kind];
        for (const [key, count] of keys) {
          released.push({ kind, key, count });
          if (!releaser) continue;
          for (let i = 0; i < count; i += 1) {
            try { releaser(key); }
            catch (error) {
              logger.warn?.(`harbor-server: releasing ${kind} ${key} for a departed client failed: ${error?.message || error}`);
            }
          }
        }
      }
      return released;
    },

    // Test/diagnostic view: what this client currently holds.
    held(clientId) {
      const kinds = byClient.get(clientId);
      if (!kinds) return [];
      const out = [];
      for (const [kind, keys] of kinds) for (const [key, count] of keys) out.push({ kind, key, count });
      return out;
    },

    clientCount() { return byClient.size; },
  };
}

module.exports = { createClientResources };
