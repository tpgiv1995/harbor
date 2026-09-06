// Catch the freeze in the wild.
//
// Pat, 2026-07-25: typing froze and the character repeated, twice in half an
// hour (a stalled renderer plus X11 auto-repeat, which looks exactly like a
// stuck key). Two hypotheses were profiled and BOTH cleared: the update banner
// costs 7ms of layout and no measurable latency, and eight sessions streaming
// 80KB tool results only move p95 by tens of ms. It cannot be reproduced
// synthetically, so the real app records its own stalls and the next occurrence
// arrives with a duration, a timestamp and its neighbours.
//
// Off with HARBOR_NO_PERF_LOG=1 in the main process.

import perfWatch from './perf-watch.cjs';

const { TICK_MS, stallFromTick, classifyTick } = perfWatch;

export { stallFromTick };

// What the renderer was doing around the stall. Deliberately cheap and coarse:
// counts and ages, no payloads, nothing that could itself cost time or leak
// conversation text into a log file. Keystrokes are counted as timestamps and
// a repeat flag ONLY (never which key), so a capture can say "auto-repeat
// storm mid-typing" without recording what was typed.
export function createStallContext() {
  const state = { lastTranscriptMs: 0, transcriptUpdates: 0, lastStatusMs: 0, keydowns: [] };
  return {
    noteTranscript() { state.lastTranscriptMs = Date.now(); state.transcriptUpdates += 1; },
    noteStatus() { state.lastStatusMs = Date.now(); },
    noteKeydown(repeat) {
      const now = Date.now();
      state.keydowns.push({ at: now, repeat: Boolean(repeat) });
      while (state.keydowns.length && (now - state.keydowns[0].at > 5000 || state.keydowns.length > 200)) {
        state.keydowns.shift();
      }
    },
    snapshot() {
      const now = Date.now();
      const recent = state.keydowns.filter((k) => now - k.at <= 5000);
      // Chromium exposes the renderer's own V8 heap here (non-standard, present
      // in Electron). It is the number that decides an out-of-memory renderer
      // death: 0xE0000008 fires when the process can no longer allocate, and
      // usedHeap climbing toward heapLimit is the growth curve that names a leak
      // (2026-09-06). Coarse MB, no payloads.
      const mem = typeof performance !== 'undefined' ? performance.memory : null;
      return {
        windows: document.querySelectorAll('.win2[data-session-id]').length,
        domNodes: document.querySelectorAll('*').length,
        usedHeapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
        totalHeapMB: mem ? Math.round(mem.totalJSHeapSize / 1048576) : null,
        heapLimitMB: mem ? Math.round(mem.jsHeapSizeLimit / 1048576) : null,
        transcriptUpdates: state.transcriptUpdates,
        msSinceTranscript: state.lastTranscriptMs ? now - state.lastTranscriptMs : null,
        msSinceSendStatus: state.lastStatusMs ? now - state.lastStatusMs : null,
        banner: Boolean(document.querySelector('.update-banner')),
        typing: document.activeElement?.classList?.contains('ubar-input') || false,
        keys5s: recent.length,
        repeats5s: recent.filter((k) => k.repeat).length,
      };
    },
  };
}

export function installPerfWatch(context, { tickMs = TICK_MS } = {}) {
  const report = window.harbor?.perf?.stall;
  if (typeof report !== 'function') return () => {};
  let last = performance.now();
  let settling = false;
  let lastRafAt = performance.now();
  let lastReportedRafAt = null;
  let rafId = 0;
  const onVisibility = () => {
    settling = true;
    last = performance.now();
    // Hidden windows get no frames; coming back must not read the hidden
    // period as a compositor stall.
    lastRafAt = last;
  };
  document.addEventListener('visibilitychange', onVisibility);
  const frame = () => { lastRafAt = performance.now(); rafId = window.requestAnimationFrame(frame); };
  rafId = window.requestAnimationFrame(frame);
  // Keystroke context for captures; timestamps and the repeat flag only.
  const onKey = (event) => context?.noteKeydown?.(event.repeat);
  window.addEventListener('keydown', onKey, true);
  // Heap heartbeat: a stall line only lands when something stalls, but an
  // out-of-memory death has no stall before it, so without a steady sample the
  // heap curve that would name the leak is missing exactly when it matters
  // (2026-09-06). Emit one memory line every ~30s regardless, on the tick that
  // is already running. Cheap: two DOM counts and a memory read, no payloads.
  const memEveryTicks = Math.max(1, Math.round(30000 / tickMs));
  let ticksSinceMem = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    ticksSinceMem += 1;
    if (ticksSinceMem >= memEveryTicks) {
      ticksSinceMem = 0;
      try { report({ kind: 'renderer-memory', at: new Date().toISOString(), context: context.snapshot() }); } catch { /* never break on logging */ }
    }
    const stall = classifyTick({
      now,
      last,
      tickMs,
      settling,
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus(),
      lastRafAt,
    });
    settling = false;
    last = now;
    if (stall?.kind === 'compositor-stall') {
      // Frames stay stopped across many ticks; one line per frozen period,
      // not one per tick.
      if (lastReportedRafAt === lastRafAt) return;
      lastReportedRafAt = lastRafAt;
    }
    if (stall) {
      try { report({ ...stall, context: context.snapshot() }); } catch { /* never break on logging */ }
    }
  }, tickMs);
  return () => {
    clearInterval(timer);
    window.cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
