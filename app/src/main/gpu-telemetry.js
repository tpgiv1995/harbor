'use strict';

// "Am I hardware accelerated right now?" must be answerable from inside the app.
//
// On 2026-07-28 Harbor's GPU process died twice (`abnormal-exit`, exitCode 512)
// and each death was followed within 29 to 57 ms by a 16 to 17 second
// main-process stall, one of them trailed 504 ms later by a 37 second renderer
// freeze while Pat was typing with 13 windows open. X11 input dispatch rides
// through the main process, so that is half a minute of queued keystrokes: the
// exact shape of the composer freeze in docs/BACKLOG.md.
//
// The only record of any of it was a single `child-process-gone` line, and
// nobody read it for two days. Worse, answering "is Harbor accelerated NOW"
// afterwards meant enumerating /proc for a `--type=gpu-process`, because the app
// recorded nothing about its own rendering mode. That is absurd for a program
// that can just ask Chromium.
//
// So: log the feature status at boot, log it again after every GPU death (which
// is the only way to see whether Chromium respawned the process or gave up and
// fell back to software), and count the deaths, because Chromium disables the
// GPU for the rest of the session after repeated crashes and never says so.
//
// This module NEVER throws. It sits on the same contract as appendPerfLine:
// logging must never break the app.

// Chromium's feature-status vocabulary. Anything not in here is software,
// disabled, or unavailable, and the point of this module is to say which.
const ACCELERATED_VALUES = new Set([
  'enabled',
  'enabled_on',
  'enabled_force',
  'enabled_force_on',
  'enabled_readback', // accelerated, but reading back through the CPU
]);

// The one feature that decides whether the window is drawn by the GPU at all.
// Everything else can degrade without the app feeling different; this one is
// the difference between compositing on the GPU and compositing on the CPU.
const COMPOSITING_KEY = 'gpu_compositing';

// Chromium stops retrying the GPU process after this many crashes in a session
// and runs software for the rest of it, silently. Once we are at or past it,
// a restart is the only way back, so the log needs to say so out loud.
const CHROMIUM_GPU_CRASH_LIMIT = 3;

// Poll costs, measured under xvfb on 2026-07-30 (pessimistic: software stack):
// getGPUFeatureStatus 3.9us median, getAppMetrics 127us, getGPUInfo 1.5ms.
// So the tick may call the first two and must NEVER call the third; a minute
// between ticks makes the whole watcher a rounding error, and the events that
// actually matter (crash, suspend, resume) have their own hooks anyway.
const DEFAULT_POLL_MS = 60_000;
// Change-only logging cannot distinguish "healthy and unchanged" from "the
// watcher died". A slow heartbeat costs ~48 lines a day against a 2 MB rotating
// log and makes the watcher's own liveness visible.
const DEFAULT_HEARTBEAT_MS = 30 * 60_000;

function isAccelerated(value) {
  return typeof value === 'string' && ACCELERATED_VALUES.has(value);
}

// Chromium's own process table. This is the first-party answer to "is there a
// GPU process right now", which the 2026-07-28 forensics had to get by
// enumerating /proc for a --type=gpu-process, and which is the ONE signal a
// feature-status read can miss: GpuDataManager caches, so a process torn down
// without a crash (the suspend hypothesis) can leave the status reading
// 'enabled' with nothing actually there.
function gpuProcessPresent(metrics) {
  if (!Array.isArray(metrics)) return null;
  return metrics.some((m) => m?.type === 'GPU');
}

// Reduce Chromium's ~10-key status map to the question actually being asked,
// plus the specific keys that are NOT accelerated so a capture names them.
function summarizeFeatureStatus(status) {
  if (!status || typeof status !== 'object') {
    return { accelerated: null, compositing: null, degraded: [], features: {} };
  }
  const degraded = [];
  for (const [feature, value] of Object.entries(status)) {
    if (!isAccelerated(value)) degraded.push(`${feature}=${value}`);
  }
  const compositing = status[COMPOSITING_KEY] ?? null;
  return {
    // null, not false, when Chromium did not report the key at all: an absent
    // answer is not a negative one, and inventing a boolean here would be the
    // same class of mistake as the context gauge guessing a denominator.
    accelerated: compositing === null ? null : isAccelerated(compositing),
    compositing,
    degraded: degraded.sort(),
    features: status,
  };
}

// getGPUInfo('basic') resolves to a large object; keep only what identifies the
// adapter, because this line goes in a log Pat may share and the rest is noise.
function summarizeGpuInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const devices = Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  const aux = info.auxAttributes || {};
  return {
    devices: devices.map((d) => ({
      vendorId: d?.vendorId,
      deviceId: d?.deviceId,
      active: d?.active,
      driverVendor: d?.driverVendor || undefined,
      driverVersion: d?.driverVersion || undefined,
    })),
    glRenderer: aux.glRenderer || undefined,
    glVendor: aux.glVendor || undefined,
    glVersion: aux.glVersion || undefined,
  };
}

function createGpuTelemetry(options = {}) {
  const {
    // Injected so the tests never need Electron, matching config/store.js and
    // providers/tasks.js, which already take `app` this way.
    getFeatureStatus,
    getGpuInfo,
    getAppMetrics,
    log,
    onChildProcessGone,
    setTimeoutFn = setTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    pollMs: pollMsOpt,
    heartbeatMs: heartbeatMsOpt,
    nowFn = () => Date.now(),
    // Chromium can respawn the GPU process; read again after a beat so the log
    // records whether it came back or Harbor is now software for good.
    recheckDelayMs = 4000,
  } = options;

  if (typeof log !== 'function') throw new TypeError('createGpuTelemetry requires log');

  // `?? default` rather than a parameter default, so an explicit undefined from
  // an unset env override still lands on the real interval.
  const pollMs = pollMsOpt ?? DEFAULT_POLL_MS;
  const heartbeatMs = heartbeatMsOpt ?? DEFAULT_HEARTBEAT_MS;

  let gpuCrashes = 0;
  let lastSignature = null;
  let lastHeartbeatAt = 0;
  let pollTimer = null;

  async function readStatus(phase, extra = {}) {
    // Every branch is guarded: a telemetry read must never be the reason the
    // app fails to boot.
    let summary = { accelerated: null, compositing: null, degraded: [], features: {} };
    try {
      summary = summarizeFeatureStatus(typeof getFeatureStatus === 'function' ? getFeatureStatus() : null);
    } catch { /* Chromium not ready, or no GPU stack at all */ }

    let gpuProcess = null;
    try {
      if (typeof getAppMetrics === 'function') gpuProcess = gpuProcessPresent(getAppMetrics());
    } catch { /* metrics unavailable */ }

    // 1.5 ms and async, so it is deliberately NOT on the poll path. A heartbeat
    // repeats an adapter nobody needs repeated; a change is exactly when a
    // hybrid machine might have switched adapters, which is worth the cost.
    let adapter = null;
    if (extra.withAdapter !== false) {
      try {
        if (typeof getGpuInfo === 'function') adapter = summarizeGpuInfo(await getGpuInfo('basic'));
      } catch { /* getGPUInfo rejects on a headless/software stack */ }
    }
    const { withAdapter: _wa, ...rest } = extra;

    try {
      log({
        at: new Date().toISOString(),
        kind: 'gpu-status',
        phase,
        accelerated: summary.accelerated,
        compositing: summary.compositing,
        // The status can read 'enabled' from a cache while no process exists.
        // Both numbers, or the log answers the wrong question.
        gpuProcess,
        degraded: summary.degraded,
        adapter,
        gpuCrashes,
        // Past the limit Chromium will not try again this session. Say so here
        // rather than leaving a future reader to infer it from a crash count.
        chromiumGaveUp: gpuCrashes >= CHROMIUM_GPU_CRASH_LIMIT,
        ...rest,
      });
    } catch { /* logging must never break the app */ }

    return { ...summary, gpuProcess, adapter, gpuCrashes };
  }

  // What counts as "the rendering situation changed". Deliberately includes the
  // process presence and the degraded set, not just the accelerated boolean,
  // because a silent fallback shows up in those first.
  function signatureOf(summary) {
    return [
      summary.accelerated,
      summary.compositing,
      summary.gpuProcess,
      (summary.degraded || []).join(','),
    ].join('|');
  }

  async function sample(phase) {
    let summary = { accelerated: null, compositing: null, degraded: [] };
    let gpuProcess = null;
    try {
      summary = summarizeFeatureStatus(typeof getFeatureStatus === 'function' ? getFeatureStatus() : null);
    } catch { /* never throw out of a tick */ }
    try {
      if (typeof getAppMetrics === 'function') gpuProcess = gpuProcessPresent(getAppMetrics());
    } catch { /* never throw out of a tick */ }

    const signature = signatureOf({ ...summary, gpuProcess });
    const changed = lastSignature !== null && signature !== lastSignature;
    const first = lastSignature === null;
    lastSignature = signature;

    const now = nowFn();
    const dueHeartbeat = now - lastHeartbeatAt >= heartbeatMs;
    if (changed) {
      await readStatus(phase || 'changed', { previous: undefined });
      lastHeartbeatAt = now;
    } else if (dueHeartbeat && !first) {
      // Heartbeat proves the watcher is alive; it does not need the adapter.
      await readStatus('heartbeat', { withAdapter: false });
      lastHeartbeatAt = now;
    }
    return { changed, signature };
  }

  function handleChildProcessGone(details) {
    if (details?.type !== 'GPU') return false;
    gpuCrashes += 1;
    try {
      log({
        at: new Date().toISOString(),
        kind: 'gpu-process-gone',
        reason: details?.reason,
        exitCode: details?.exitCode,
        gpuCrashes,
        chromiumGaveUp: gpuCrashes >= CHROMIUM_GPU_CRASH_LIMIT,
      });
    } catch { /* never break the app */ }
    // Re-read AFTER Chromium has had a chance to respawn. This is the line that
    // answers the question the 2026-07-28 evidence could not: did it recover,
    // or has this session been software-rendering ever since?
    const timer = setTimeoutFn(() => { readStatus('after-gpu-crash'); }, recheckDelayMs);
    timer?.unref?.();
    return true;
  }

  // Suspend and resume are logged as a PAIR on purpose. The open hypothesis in
  // docs/BACKLOG.md is that the GPU process does not survive a suspend, and the
  // instance that had no GPU process was the one that slept 19:55 to 21:31 on
  // 2026-07-30. One reading either side of the sleep is the whole experiment,
  // and neither reading is worth much without the other.
  async function handleSuspend() { await readStatus('before-suspend'); }

  async function handleResume() {
    // Straight away, then again after a beat: Chromium may re-establish the GPU
    // process on its own, and "gone at once, back a moment later" is a
    // materially different answer from "gone for the rest of the session".
    await readStatus('after-resume');
    const timer = setTimeoutFn(() => { readStatus('after-resume-settled'); }, recheckDelayMs);
    timer?.unref?.();
  }

  function start() {
    if (pollTimer) return () => stop();
    lastHeartbeatAt = nowFn();
    pollTimer = setIntervalFn(() => { sample(); }, pollMs);
    pollTimer?.unref?.();
    return () => stop();
  }

  function stop() {
    if (!pollTimer) return;
    try { clearIntervalFn(pollTimer); } catch { /* nothing to clear */ }
    pollTimer = null;
  }

  if (typeof onChildProcessGone === 'function') onChildProcessGone(handleChildProcessGone);

  return {
    readStatus,
    sample,
    start,
    stop,
    handleChildProcessGone,
    handleSuspend,
    handleResume,
    get gpuCrashes() { return gpuCrashes; },
  };
}

module.exports = {
  createGpuTelemetry,
  summarizeFeatureStatus,
  summarizeGpuInfo,
  gpuProcessPresent,
  isAccelerated,
  ACCELERATED_VALUES,
  COMPOSITING_KEY,
  CHROMIUM_GPU_CRASH_LIMIT,
  DEFAULT_POLL_MS,
  DEFAULT_HEARTBEAT_MS,
};
