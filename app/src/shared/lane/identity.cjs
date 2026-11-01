'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { currentBootId, bootRelation } = require('../../daemon/boot-id.js');
const { fail, insist } = require('./errors.cjs');
const SELF_BOOT = currentBootId();
const SELF_START = Math.round(Date.now() - process.uptime() * 1000);
const SELF_START_EARLY_MS = 120000;
const SELF_START_LATE_MS = 1000;

function powershell(script, timeoutMs = 15000) {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: Math.max(1, Math.floor(timeoutMs)),
  });
  if (result.error || result.status !== 0) fail('IDENTITY_UNKNOWN', 'Cannot establish OS identity', { reason: result.error?.message || result.stderr.trim() });
  return result.stdout.trim();
}
function validPid(pid) { insist(Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647, 'INVALID_ARGUMENT', 'owner-pid must be a positive process id'); }
function queryPids(pids, timeoutMs) {
  if (!pids.length) return new Map();
  pids.forEach(validPid);
  if (process.platform === 'win32') {
    const ids = [...new Set(pids)].join(',');
    const script = `$ids=@(${ids}); $issues=@(); $found=@(Get-Process -Id $ids -ErrorAction SilentlyContinue -ErrorVariable issues); if (@($issues | Where-Object { $_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId*' }).Count) { exit 9 }; $rows=@{}; foreach($p in $found) { try { $rows[$p.Id]=@{pid=$p.Id;created=([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();state='live'} } catch { $rows[$p.Id]=@{pid=$p.Id;state='unknown'} } }; $out=@(foreach($n in $ids) { if($rows.ContainsKey($n)) { $rows[$n] } else { @{pid=$n;state='gone'} } }); ConvertTo-Json -InputObject $out -Compress`;
    return new Map(JSON.parse(powershell(script, timeoutMs)).map(row => [row.pid, row]));
  }
  if (process.platform !== 'linux') fail('UNSUPPORTED_PLATFORM', 'External process identity supports Windows and Linux');
  const bootSeconds = Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1]);
  return new Map(pids.map(pid => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      return [pid, { state: 'live', created: bootSeconds * 1000 + ticks * 10 }];
    } catch (error) { return [pid, { state: error.code === 'ENOENT' ? 'gone' : 'unknown' }]; }
  }));
}
function identity(pid = process.pid) {
  validPid(pid);
  if (pid === process.pid) return { bootId: SELF_BOOT, pid, created: SELF_START, source: 'self' };
  const row = queryPids([pid]).get(pid);
  insist(row?.state === 'live' && Number.isFinite(row.created), row?.state === 'gone' ? 'OWNER_GONE' : 'IDENTITY_UNKNOWN', 'Cannot establish the requested owner identity');
  return { bootId: SELF_BOOT, pid, created: row.created, source: 'os' };
}
function creationState(owner, observed) {
  if (owner.source === 'os') return observed === owner.created ? 'live' : 'gone';
  if (owner.source !== 'self') return 'unknown';
  // Node uptime begins after OS creation and startup work. An earlier OS birth
  // is expected; only a later birth proves reuse. Very old births are uncertain.
  const difference = observed - owner.created;
  if (difference > SELF_START_LATE_MS) return 'gone';
  if (difference < -SELF_START_EARLY_MS) return 'unknown';
  return 'live';
}
function ownerStates(owners, { quick = false, timeoutMs } = {}) {
  const current = currentBootId(); const pending = [];
  const states = owners.map((owner, index) => {
    if (!owner || !Number.isSafeInteger(owner.pid) || !Number.isFinite(owner.created)) return 'unknown';
    const relation = bootRelation(owner.bootId, current);
    if (relation === 'foreign') return 'gone';
    if (relation === 'unknown') return 'unknown';
    // Only our exact self stamp is known without an OS observation. Do not
    // compare an OS-sourced owner against Node's later uptime-derived bound.
    if (owner.pid === process.pid && owner.source === 'self' && owner.created === SELF_START) return 'live';
    if (quick) {
      // Signal zero never sends a signal. Existence cannot prove PID identity.
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') return 'gone'; }
      return 'unknown';
    }
    pending.push({ owner, index }); return 'unknown';
  });
  try {
    const rows = queryPids(pending.map(p => p.owner.pid), timeoutMs);
    for (const { owner, index } of pending) {
      const row = rows.get(owner.pid);
      states[index] = row?.state === 'gone' ? 'gone' : row?.state === 'live' && Number.isFinite(row.created)
        ? creationState(owner, row.created) : 'unknown';
    }
  } catch { /* Failed observations never become evidence of owner loss. */ }
  return states;
}
function ownerState(owner, options) { return ownerStates([owner], options)[0]; }
function volumeStamp(root) {
  const stat = fs.statSync(root, { bigint: true });
  return { root: fs.realpathSync.native(root), dev: String(stat.dev), ino: String(stat.ino) };
}
function volumeIdentity(root) {
  const result = volumeStamp(root);
  if (process.platform === 'win32') {
    const drive = /^[A-Za-z]:/.exec(result.root)?.[0];
    if (!drive) fail('VOLUME_MISSING', 'v1 requires a local drive');
    const disk = JSON.parse(powershell(`Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" -ErrorAction Stop | Select-Object VolumeSerialNumber,FileSystem | ConvertTo-Json -Compress`));
    insist(disk?.FileSystem === 'NTFS' && disk.VolumeSerialNumber, 'VOLUME_MISSING', 'v1 requires an identified NTFS volume');
    insist(BigInt('0x' + disk.VolumeSerialNumber) === BigInt(result.dev), 'VOLUME_MISSING', 'Node and OS volume identities disagree');
    result.serial = disk.VolumeSerialNumber; result.fileSystem = disk.FileSystem;
  }
  return result;
}
module.exports = { identity, ownerState, ownerStates, volumeIdentity, volumeStamp, SELF_START_EARLY_MS, SELF_START_LATE_MS };
