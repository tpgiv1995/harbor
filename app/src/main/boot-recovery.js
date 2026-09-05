'use strict';

// WHAT HARBOR DOES WHEN ITS RENDERER NEVER ARRIVES.
//
// Live-caught 2026-08-29, reported as "cant even open harbor, just a black
// screen... in the past i think ive just restarted my computer". Pat launched
// Harbor at 23:15:35 while an agent session's `npm run build` was replacing
// dist/. Vite renames every hashed asset and rewrites index.html, so a launch
// that lands mid-build can read an index.html whose chunks no longer exist:
// the page "loads" (did-finish-load fires), the module graph dies on the
// missing chunk, React never mounts, and the window sits on the body
// background (#0b0c0f) looking exactly like a dead app. The build was whole
// again at 23:19:53; the window was still black at 23:26, and would have been
// black at midnight, because every existing recovery assumed a LIVE renderer:
// the dist-watcher's update ribbon needs a mounted React tree to render the
// click target, and render-process-gone never fires (the renderer process is
// fine; it is the page that is empty). Rebooting "fixed" it only because any
// relaunch after the build settled would have.
//
// So: the main process owns boot health. A load that FAILS (index.html itself
// missing, mid-wipe) or a load that finishes but never MOUNTS (chunks missing,
// tonight's shape) is retried on a slow steady cadence forever, and
// immediately when the dist watcher reports a settled new build. Forever is
// deliberate: the broken state means "a build is in flight or hasn't
// happened", and both end with dist becoming whole, at which point the next
// retry heals the window with no human in the loop. Once the app has mounted
// ONCE, recovery disarms: a healthy window is never reloaded out from under
// the user (drafts, scroll, open views), and later builds go back to being
// the renderer's own click-to-update ribbon.
//
// Everything is injected so the plan is provable without a window: the wiring
// in index.js supplies loadFile + an executeJavaScript mount probe.

function createBootRecovery({
  attemptLoad,
  probeMount,
  // The last probe is deliberately generous: on this machine a cold module
  // graph can crawl behind Defender scanning freshly built files, and
  // reloading a mount that was genuinely in flight restarts the slow part.
  probeDelaysMs = [1200, 3500, 8000, 15_000],
  retryDelaysMs = [2000, 4000, 8000],
  steadyRetryMs = 10_000,
  // A probe that never settles must count as a miss, not wedge the state
  // machine (the same rule createSessionOwnerProbe carries: a probe that
  // hangs is a probe that lies by omission). executeJavaScript can hang
  // forever against a deadlocked renderer.
  probeTimeoutMs = 5000,
  log = (line) => console.warn(line),
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = clearTimeout,
} = {}) {
  let state = 'pending'; // pending | probing | waiting-retry | healthy | closed
  let probeTimers = [];
  let probeGeneration = 0;
  let retryTimer = null;
  let retries = 0;

  const clearProbes = () => {
    for (const t of probeTimers) clearTimer(t);
    probeTimers = [];
    probeGeneration += 1;
  };

  const markHealthy = () => {
    if (state === 'closed' || state === 'healthy') return;
    state = 'healthy';
    clearProbes();
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
  };

  const retryNow = (why) => {
    if (state === 'closed' || state === 'healthy') return;
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    clearProbes();
    retries += 1;
    state = 'pending';
    log(`harbor: window never became ready (${why}); retrying the load (attempt ${retries})`);
    attemptLoad();
  };

  const scheduleRetry = (why) => {
    if (state === 'closed' || state === 'healthy' || retryTimer) return;
    state = 'waiting-retry';
    // Escalate through the early delays, then settle on the steady cadence:
    // the wait is for a BUILD, and builds take as long as they take.
    const ms = retries < retryDelaysMs.length ? retryDelaysMs[retries] : steadyRetryMs;
    retryTimer = setTimer(() => {
      retryTimer = null;
      retryNow(why);
    }, ms);
  };

  return {
    // A navigation completed. That is not health: tonight's page finished
    // loading and was empty. Probe the mount a few times (a cold start on a
    // slow disk takes a beat) and only call it broken after the last miss.
    loadFinished() {
      if (state === 'closed' || state === 'healthy') return;
      clearProbes();
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
      state = 'probing';
      const gen = probeGeneration;
      probeDelaysMs.forEach((delayMs, index) => {
        const isLast = index === probeDelaysMs.length - 1;
        probeTimers.push(setTimer(async () => {
          if (state === 'closed' || state === 'healthy' || gen !== probeGeneration) return;
          let mounted = false;
          try {
            mounted = Boolean(await new Promise((resolve) => {
              let settled = false;
              const deadline = setTimer(() => { if (!settled) { settled = true; resolve(false); } }, probeTimeoutMs);
              Promise.resolve()
                .then(() => probeMount())
                .then(
                  (value) => { if (!settled) { settled = true; clearTimer(deadline); resolve(value); } },
                  () => { if (!settled) { settled = true; clearTimer(deadline); resolve(false); } },
                );
            }));
          } catch { mounted = false; }
          if (state === 'closed' || gen !== probeGeneration) return;
          if (mounted) { markHealthy(); return; }
          if (isLast) scheduleRetry('the app never mounted after the page loaded');
        }, delayMs));
      });
    },

    // The navigation itself failed (index.html gone mid-wipe). ERR_ABORTED is
    // our own superseding retry, never a verdict.
    loadFailed({ errorCode, errorDescription } = {}) {
      if (errorCode === -3) return;
      if (state === 'closed' || state === 'healthy') return;
      clearProbes();
      scheduleRetry(`the load failed (${errorCode ?? '?'} ${errorDescription ?? ''})`.trim());
    },

    // The dist watcher saw a settled, fingerprint-different build. If the
    // window still has not come up, that build is exactly what it is waiting
    // for: retry immediately rather than riding out the timer.
    distChanged() {
      if (state === 'closed' || state === 'healthy') return;
      retryNow('a new build landed');
    },

    // The crash-recovery reload (render-process-gone -> window.reload()) can
    // land on a mid-wipe dist exactly like a launch can, and a disarmed
    // recovery would let that window go black for good (adversarial review,
    // 2026-08-30). There is no user state left to protect after a renderer
    // death, so health is forfeit and the boot watch starts over.
    rearm() {
      if (state === 'closed') return;
      clearProbes();
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
      retries = 0;
      state = 'pending';
    },

    close() {
      state = 'closed';
      clearProbes();
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    },

    get healthy() { return state === 'healthy'; },
    get retries() { return retries; },
  };
}

module.exports = { createBootRecovery };
