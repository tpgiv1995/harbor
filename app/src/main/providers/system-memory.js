'use strict';

// THE NUMBER THAT ACTUALLY KILLS THIS MACHINE IS COMMIT CHARGE, AND UNTIL
// 2026-09-04 HARBOR NEVER SHOWED IT.
//
// Windows promises memory before it hands any out: every allocation a process
// makes is COMMITTED against a system-wide limit (physical RAM plus the page
// file) whether or not the process ever touches it. When the limit is reached,
// allocations fail outright, and a Claude CLI that cannot allocate at the
// start of a turn dies silently (2026-08-20: the machine sat at an 87 GB limit,
// prompts reached the transcript and no reply ever came). "Free RAM" said 30 GB
// that day and this one; the commit meter is the one that was at the wall.
// A 9 GB idle Meeting-Assistant process with a 60 MB working set is the shape
// that makes the two numbers disagree: paged out of RAM, still promised.
//
// Source: Electron's `process.getSystemMemoryInfo()`, which on Windows fills
// `swapTotal`/`swapFree` from MEMORYSTATUSEX.ullTotalPageFile/ullAvailPageFile,
// i.e. the commit limit and the commit headroom, in KB. Verified against
// Win32_OperatingSystem TotalVirtualMemorySize/FreeVirtualMemory to the tenth
// of a GB (103.3 / 18.6). No spawn, no CIM, no 3 to 5 second probe. A process
// without that API (the mobile server under plain Node) falls back to one
// hidden PowerShell read per tick, on the 20 s deadline the win32 doctrine
// gives every CIM question.
//
// The alert is HYSTERETIC: notify once when the commit percentage crosses
// `warnAt`, re-arm only after it falls back under `rearmBelow`, so a machine
// hovering at the threshold does not toast every thirty seconds.

const { execFile } = require('node:child_process');

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_WARN_AT = 85;
const DEFAULT_REARM_BELOW = 78;

function toMB(kb) {
  return Number.isFinite(kb) ? Math.round(kb / 1024) : null;
}

// KB-denominated Electron shape -> the sample the rail renders.
function sampleFromMemoryInfo(info, nowMs = Date.now()) {
  if (!info || typeof info !== 'object') return null;
  const commitLimitMB = toMB(info.swapTotal);
  const commitFreeMB = toMB(info.swapFree);
  const physTotalMB = toMB(info.total);
  const physFreeMB = toMB(info.free);
  if (!commitLimitMB || commitFreeMB === null) return null;
  const commitUsedMB = Math.max(0, commitLimitMB - commitFreeMB);
  return {
    at: nowMs,
    commitUsedMB,
    commitLimitMB,
    commitPct: Math.round((commitUsedMB / commitLimitMB) * 1000) / 10,
    physUsedMB: physTotalMB && physFreeMB !== null ? Math.max(0, physTotalMB - physFreeMB) : null,
    physTotalMB: physTotalMB || null,
  };
}

// Pure: whether this sample should notify, and the armed state after it.
function planMemoryAlert({ pct, armed = true, warnAt = DEFAULT_WARN_AT, rearmBelow = DEFAULT_REARM_BELOW } = {}) {
  if (!Number.isFinite(pct)) return { notify: false, armed };
  if (armed && pct >= warnAt) return { notify: true, armed: false };
  if (!armed && pct < rearmBelow) return { notify: false, armed: true };
  return { notify: false, armed };
}

function readFromElectron() {
  try {
    return typeof process.getSystemMemoryInfo === 'function' ? process.getSystemMemoryInfo() : null;
  } catch {
    return null;
  }
}

// Fallback for a plain Node host: the same four numbers from CIM, in KB, so
// the sample code has one shape to understand.
function readFromCim() {
  return new Promise((resolve) => {
    const script = '$o = Get-CimInstance Win32_OperatingSystem; '
      + '[pscustomobject]@{ total = $o.TotalVisibleMemorySize; free = $o.FreePhysicalMemory; '
      + 'swapTotal = $o.TotalVirtualMemorySize; swapFree = $o.FreeVirtualMemory } | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 20_000, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) return resolve(null);
      try { resolve(JSON.parse(String(stdout).trim())); } catch { resolve(null); }
    });
  });
}

function createSystemMemoryProvider(options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const now = options.now || Date.now;
  const notify = typeof options.notify === 'function' ? options.notify : null;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const warnAt = Number.isFinite(options.warnAt) ? options.warnAt : DEFAULT_WARN_AT;
  const rearmBelow = Number.isFinite(options.rearmBelow) ? options.rearmBelow : DEFAULT_REARM_BELOW;
  const read = options.read || (() => {
    const electron = readFromElectron();
    return electron ? electron : (process.platform === 'win32' ? readFromCim() : null);
  });
  const listeners = new Set();
  let current = null;
  let armed = true;
  let timer = null;
  let ticking = false;

  async function tick() {
    if (ticking) return current;
    ticking = true;
    try {
      const sample = sampleFromMemoryInfo(await read(), now());
      if (!sample) return current;
      current = sample;
      const plan = planMemoryAlert({ pct: sample.commitPct, armed, warnAt, rearmBelow });
      armed = plan.armed;
      if (plan.notify) {
        const line = `memory commit at ${Math.round(sample.commitPct)}% (${Math.round(sample.commitUsedMB / 1024)} of ${Math.round(sample.commitLimitMB / 1024)} GB)`;
        log(`system-memory: ${line}`);
        if (notify) {
          try {
            notify('Memory is running out', `${line}. Sessions can start failing silently past the limit; sleep or close what you are not using.`);
          } catch { /* a toast must never break the meter */ }
        }
      }
      for (const listener of listeners) {
        try { listener(sample); } catch { /* one listener never breaks the rest */ }
      }
      return sample;
    } catch (error) {
      log(`system-memory: read failed: ${error?.message || error}`);
      return current;
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    current: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get armed() { return armed; },
  };
}

module.exports = {
  createSystemMemoryProvider,
  sampleFromMemoryInfo,
  planMemoryAlert,
  DEFAULT_WARN_AT,
  DEFAULT_REARM_BELOW,
};
