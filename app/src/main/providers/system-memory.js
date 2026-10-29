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
//
// THE LIMIT TODAY IS NOT THE WALL WHEN WINDOWS MANAGES THE PAGE FILE
// (2026-10-29). The first version divided by the commit limit as it stands
// right now. A stock install lets Windows manage the page file, and
// Microsoft's documented behaviour is to keep it small and grow it once commit
// passes 90% of the current limit, up to 3 x RAM or 4 GB (whichever is
// larger), capped at the volume size / 8 ("How to determine the appropriate
// page file size for 64-bit versions of Windows", Microsoft Learn). So on a
// default 16 GB laptop commit sits at 78-90% of a ~19 GB limit in ordinary
// use, the chip was red and the toast said "Memory is running out" BEFORE
// Windows had even started to grow the file, while the real wall was ~64 GB.
// A public user saw exactly that the day after installing and was told to
// buy a second computer. The meter now divides by the ceiling a page file
// WINDOWS SIZES can still reach (`pagefileGrowthMB`), read once per ten
// minutes through one hidden CIM query. A page file someone sized by hand
// keeps the limit as it stands, even when its maximum is larger: whoever set
// it chose where the warning sits, and this machine's (64 GB initial, 192 GB
// maximum) was tuned on real sessions dying at the commit limit, so its meter
// is unchanged.

const { execFile } = require('node:child_process');

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_WARN_AT = 85;
const DEFAULT_REARM_BELOW = 78;
const GROWTH_REFRESH_MS = 10 * 60 * 1000;

function toMB(kb) {
  return Number.isFinite(kb) ? Math.round(kb / 1024) : null;
}

// KB-denominated Electron shape -> the sample the rail renders. `growthMB` is
// how far the page files can still grow on their own; the meter's limit is the
// limit today plus that room, the point where an allocation can really fail.
// `commitLimitNowMB` keeps the limit as it stands today.
function sampleFromMemoryInfo(info, nowMs = Date.now(), growthMB = 0) {
  if (!info || typeof info !== 'object') return null;
  const commitLimitNowMB = toMB(info.swapTotal);
  const commitFreeMB = toMB(info.swapFree);
  const physTotalMB = toMB(info.total);
  const physFreeMB = toMB(info.free);
  if (!commitLimitNowMB || commitFreeMB === null) return null;
  const commitUsedMB = Math.max(0, commitLimitNowMB - commitFreeMB);
  const room = Number.isFinite(growthMB) && growthMB > 0 ? Math.round(growthMB) : 0;
  const commitLimitMB = commitLimitNowMB + room;
  return {
    at: nowMs,
    commitUsedMB,
    commitLimitMB,
    commitLimitNowMB,
    commitPct: Math.round((commitUsedMB / commitLimitMB) * 1000) / 10,
    physUsedMB: physTotalMB && physFreeMB !== null ? Math.max(0, physTotalMB - physFreeMB) : null,
    physTotalMB: physTotalMB || null,
  };
}

function finiteMB(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Pure: how many MB the page files Windows sizes can still add to the commit
// limit by themselves. `files` is one entry per page file in use: allocatedMB
// (size now), maxMB (the configured maximum; 0 means Windows sizes this file),
// volumeMB and freeMB of the drive it lives on. A system-managed file can
// reach max(3 x RAM, 4 GB), capped at volume / 8, and it can never grow into
// disk space that is not free (1 GB is left for the volume itself). A file
// sized by hand adds nothing (see the header).
function pagefileGrowthMB({ ramMB, automatic, files } = {}) {
  const ram = finiteMB(ramMB);
  if (!Array.isArray(files) || ram === null) return 0;
  let total = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    const allocated = finiteMB(file.allocatedMB);
    if (allocated === null) continue;
    if (!automatic && finiteMB(file.maxMB)) continue;
    let max = Math.max(3 * ram, 4096);
    const volume = finiteMB(file.volumeMB);
    if (volume) max = Math.min(max, Math.floor(volume / 8));
    let room = Math.max(0, max - allocated);
    const free = finiteMB(file.freeMB);
    if (free !== null) room = Math.min(room, Math.max(0, free - 1024));
    total += room;
  }
  return total;
}

// One hidden CIM read for the page-file layout, in the shape
// `pagefileGrowthMB` takes. A file Windows sizes has no Win32_PageFileSetting
// row (or one with MaximumSize 0); both read as maxMB 0.
const PAGEFILE_SCRIPT = [
  '$cs = Get-CimInstance Win32_ComputerSystem',
  '$set = @(Get-CimInstance Win32_PageFileSetting)',
  '$files = @(foreach ($u in @(Get-CimInstance Win32_PageFileUsage)) { '
    + '$s = $set | Where-Object { $_.Name -eq $u.Name } | Select-Object -First 1; '
    + '$d = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $u.Name.Substring(0,2) } | Select-Object -First 1; '
    + '[pscustomobject]@{ allocatedMB = [int64]$u.AllocatedBaseSize; maxMB = $(if ($s) { [int64]$s.MaximumSize } else { 0 }); '
    + 'volumeMB = [math]::Floor([double]$d.Size / 1MB); freeMB = [math]::Floor([double]$d.FreeSpace / 1MB) } })',
  '[pscustomobject]@{ automatic = [bool]$cs.AutomaticManagedPagefile; ramMB = [math]::Floor([double]$cs.TotalPhysicalMemory / 1MB); files = $files } | ConvertTo-Json -Compress -Depth 4',
].join('; ');

function readPagefileGrowth() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PAGEFILE_SCRIPT], {
      windowsHide: true, timeout: 20_000, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const layout = JSON.parse(String(stdout).trim());
        const files = Array.isArray(layout.files) ? layout.files : (layout.files ? [layout.files] : []);
        resolve(pagefileGrowthMB({ ramMB: layout.ramMB, automatic: layout.automatic, files }));
      } catch {
        resolve(null);
      }
    });
  });
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
  // Page-file room is a property of the real machine, so it is read only
  // alongside the real memory reader; an injected reader gets none unless the
  // caller injects its own.
  const readGrowth = options.readGrowth
    || (!options.read && process.platform === 'win32' ? readPagefileGrowth : null);
  const listeners = new Set();
  let current = null;
  let armed = true;
  let timer = null;
  let ticking = false;
  let growthMB = 0;
  let growthReadAt = null;

  // Awaited before the first sample, so a stock machine never toasts on the
  // limit as it stands at boot. A failed read keeps the last known room (0 at
  // first, which is the old, stricter meter).
  async function refreshGrowth() {
    if (!readGrowth) return;
    if (growthReadAt !== null && now() - growthReadAt < GROWTH_REFRESH_MS) return;
    growthReadAt = now();
    try {
      const room = await readGrowth();
      if (Number.isFinite(room) && room >= 0) growthMB = room;
    } catch (error) {
      log(`system-memory: page file read failed: ${error?.message || error}`);
    }
  }

  async function tick() {
    if (ticking) return current;
    ticking = true;
    try {
      await refreshGrowth();
      const sample = sampleFromMemoryInfo(await read(), now(), growthMB);
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
  pagefileGrowthMB,
  readPagefileGrowth,
  GROWTH_REFRESH_MS,
  DEFAULT_WARN_AT,
  DEFAULT_REARM_BELOW,
};
