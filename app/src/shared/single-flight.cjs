'use strict';

// Wraps an async producer so overlapping calls coalesce: a call that arrives
// while a run is in flight does not start another; it waits for ONE trailing
// run that starts when the current one settles, and receives that run's
// result. Sequential calls each run. A rejection reaches its own waiters and
// releases the flight for the next call.
//
// Born 2026-09-09 ("harbor is CRAWLING today"): the Orch summaries broadcast
// was registered on one queue watcher per open workspace, each with its own
// poll and debounce, so ten workspaces fired the same broadcast about once a
// second and the broadcasts overlapped, each fanning out one history-worker
// `meta` per candidate session. Coalescing bounds that to one build at a time.
function createSingleFlight(producer) {
  let inFlight = null;
  let trailing = null;
  const run = () => {
    // The producer starts synchronously, exactly as a direct call would; only
    // the settle bookkeeping is deferred.
    let result;
    try { result = Promise.resolve(producer()); } catch (error) { result = Promise.reject(error); }
    inFlight = result.finally(() => {
      inFlight = null;
      if (trailing) {
        const next = trailing;
        trailing = null;
        const promise = run();
        promise.then(next.resolve, next.reject);
      }
    });
    return inFlight;
  };
  return () => {
    if (!inFlight) return run();
    if (!trailing) {
      let resolve; let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      trailing = { promise, resolve, reject };
    }
    return trailing.promise;
  };
}

module.exports = { createSingleFlight };
