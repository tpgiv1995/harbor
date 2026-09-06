'use strict';

// Pure half of the renderer stall watch (see perf-watch.js for the timer and
// the DOM context). CommonJS so the tests require it directly, the same split
// file-drop.cjs uses.
//
// Detection is a WATCHDOG TIMER, not the Long Tasks API: `longtask` is listed
// in PerformanceObserver.supportedEntryTypes in this Electron, but a real 900ms
// synchronous block in the renderer produced ZERO entries (probed 2026-07-25),
// so an observer here would sit silent through exactly the freeze it is meant
// to catch. A timer that fails to fire on time cannot be fooled that way: the
// overshoot IS the blocked interval.

const TICK_MS = 250;
// Pat's freezes are seconds long. 250ms of overshoot is far below that and
// still quiet in normal use, so the log stays empty until something real
// happens.
const STALL_MS = 250;

// gap = how late this tick was. Anything under the threshold is ordinary
// scheduling noise and must not be written.
//
// `visible` and `settling` exist because Chromium THROTTLES timers in a hidden
// window (Electron's backgroundThrottling, on by default): every minimize would
// otherwise write a fake multi-second "freeze" and poison the only evidence
// this file exists to collect. A hidden window reports nothing, and the first
// tick after it comes back is skipped, because that gap is the hidden period,
// not a stall.
function stallFromTick({ now, last, tickMs = TICK_MS, threshold = STALL_MS, visible = true, settling = false }) {
  if (!visible || settling) return null;
  if (!Number.isFinite(now) || !Number.isFinite(last)) return null;
  const overshoot = Math.round(now - last - tickMs);
  if (!Number.isFinite(overshoot) || overshoot < threshold) return null;
  return { ms: overshoot, at: new Date().toISOString(), kind: 'blocked-main-thread' };
}

// A frozen SCREEN with a healthy JS thread is a different failure than a
// blocked main thread, and the log must say which one happened: the freeze may
// not be in the renderer at all (three GetVSyncParametersIfAvailable warnings
// appeared on one launch, and the compositor is unexamined). The timer is the
// health check for JS; requestAnimationFrame is the health check for frames.
// Ticks on schedule + frames stopped = the compositor, not the code.
//
// Focus is a hard gate: on X11 there is no occlusion detection, so a COVERED
// window can also stop producing frames without anything being wrong. Typing
// (the symptom this exists for) implies focus, so unfocused silence costs
// nothing.
const RAF_STALL_MS = 1000;

function classifyTick({
  now, last, tickMs = TICK_MS, threshold = STALL_MS, visible = true, settling = false,
  focused = true, lastRafAt = null, rafStallMs = RAF_STALL_MS,
}) {
  const blocked = stallFromTick({ now, last, tickMs, threshold, visible, settling });
  if (blocked) return blocked;
  if (!visible || settling || !focused) return null;
  if (!Number.isFinite(lastRafAt) || !Number.isFinite(now)) return null;
  const rafGap = Math.round(now - lastRafAt);
  if (rafGap < rafStallMs) return null;
  return { ms: rafGap, at: new Date().toISOString(), kind: 'compositor-stall' };
}

module.exports = { TICK_MS, STALL_MS, RAF_STALL_MS, stallFromTick, classifyTick };
