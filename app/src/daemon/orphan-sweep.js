'use strict';

// ORPHANED MANAGED PROCESSES ARE SWEPT, AND ONLY MANAGED ONES (2026-08-20).
//
// Zombie processes are this machine's oldest recurring wound: 28 orphaned
// daemons (2026-08-06), harness daemons outliving killed test runners
// (2026-08-08), half-killed workers whose `claude --resume` survived the pane
// (worker-close), and ~190 MCP node children at the commit-exhaustion peak.
// Each got its own guard, but one vector stayed open: a process WE manage
// whose parent dies too hard to run any teardown. A SIGKILLed lazy shim
// cannot stop its backend; a crashed claude cannot stop its MCP servers, and
// each of those backends can hold its own children (a chrome-devtools
// backend holds real Chrome processes).
//
// The audit that shaped this found the trap before the code did: a naive
// parent-is-dead test flagged the daemon's OWN keepers (their parent
// legitimately restarted) and half of Windows (csrss, wininit, launchers
// that exit by design). Parent-dead is NOT a kill signature. Three fences
// make this sweep unable to repeat that mistake:
//
// 1. PATTERN SCOPE. Only a process whose command line matches a managed
//    family (the MCP server install, the *-mcp dev repos, the lazy shim) is
//    ever a candidate. Keepers, daemons, apps, and everything else on the
//    machine are structurally outside the kill set, whatever their parent
//    looks like.
// 2. PID-REUSE-AWARE ORPHAN TEST. A parent pid that exists but was CREATED
//    AFTER its child is a recycled pid, not a parent. A missing creation
//    time on either side refuses (not-orphan), because an unreadable fact
//    is not evidence.
// 3. HYSTERESIS. A candidate must be observed orphaned on TWO consecutive
//    sweeps before it is killed; one observation is never evidence (the same
//    rule dormancy and the mute-keeper suspects follow). This absorbs
//    snapshot races and any teardown that is merely in progress.
//
// The kill is `taskkill /T /F`, so a swept backend takes ITS children
// (browsers included) with it. win32 only: on POSIX orphans reparent to
// init and this machine's whole incident history is a Windows one.

const { execFile, spawnSync } = require('node:child_process');

const DEFAULT_PATTERNS = [
  /[\\/]\.local[\\/]lib[\\/]mcp-servers[\\/]/i,
  /[\\/]dev[\\/][^\\/"]*-mcp[\\/]/i,
  /mcp-lazy-shim[\\/]shim\.mjs/i,
];

function resolveOrphanPolicy(env = process.env) {
  const interval = Number(env.HARBOR_SESSIOND_ORPHAN_INTERVAL_MS);
  const intervalMs = Number.isFinite(interval) && interval >= 0 ? interval : 300000;
  let patterns = DEFAULT_PATTERNS;
  if (typeof env.HARBOR_SESSIOND_ORPHAN_PATTERNS === 'string' && env.HARBOR_SESSIOND_ORPHAN_PATTERNS) {
    patterns = env.HARBOR_SESSIOND_ORPHAN_PATTERNS.split(';').filter(Boolean).map((p) => new RegExp(p, 'i'));
  }
  return { enabled: intervalMs > 0 && process.platform === 'win32', intervalMs, patterns };
}

// One process-table snapshot: pid, ppid, command line, creation time as a
// comparable number (FileTime). Null on any failure; a failed probe sweeps
// nothing.
const WIN_TABLE_ARGS = [
  '-NoProfile', '-NonInteractive', '-Command',
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,' +
  '@{n=\'Created\';e={if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }}} | ConvertTo-Json -Compress',
];

function snapshotProcessTable({ execFileImpl = execFile, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFileImpl('powershell.exe', WIN_TABLE_ARGS, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) { resolve(null); return; }
      resolve(parseProcessTable(String(stdout)));
    });
  });
}

function parseProcessTable(json) {
  let rows;
  try { rows = JSON.parse(json); } catch { return null; }
  if (rows && typeof rows === 'object' && !Array.isArray(rows)) rows = [rows];
  if (!Array.isArray(rows)) return null;
  const table = new Map();
  for (const row of rows) {
    const pid = Number(row?.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      ppid: Number(row.ParentProcessId) || 0,
      command: typeof row.CommandLine === 'string' ? row.CommandLine : '',
      created: Number(row.Created) || 0,
    });
  }
  return table.size ? table : null;
}

// Pure: which processes are pattern-matched orphans in this snapshot.
function findManagedOrphans(table, patterns) {
  if (!(table instanceof Map)) return [];
  const orphans = [];
  for (const [pid, row] of table) {
    if (pid <= 4 || pid === process.pid) continue;
    if (!row.command || !patterns.some((re) => re.test(row.command))) continue;
    if (!row.created) continue; // an unreadable birth time is not evidence
    const parent = table.get(row.ppid);
    let orphaned;
    if (!parent) orphaned = true;                       // parent gone entirely
    else if (parent.created === 0) orphaned = false;    // unreadable parent age: refuse, it may be live
    else orphaned = parent.created > row.created;       // a pid recycled after the child's birth is not a parent
    if (!orphaned) continue;
    orphans.push({ pid, created: row.created, command: row.command });
  }
  return orphans;
}

// Two consecutive observations of the same pid+created before a kill.
// `suspects` is caller-owned state: Map<"pid:created", sweepCount>.
function decideKills(orphans, suspects) {
  const seen = new Set();
  const kills = [];
  for (const orphan of orphans) {
    const key = `${orphan.pid}:${orphan.created}`;
    seen.add(key);
    const count = (suspects.get(key) || 0) + 1;
    suspects.set(key, count);
    if (count >= 2) kills.push(orphan);
  }
  for (const key of [...suspects.keys()]) if (!seen.has(key)) suspects.delete(key);
  return kills;
}

// A SESSION WHOSE PTY CHILD IS GONE IS DEAD, WHATEVER ITS KEEPER BELIEVES
// (2026-08-20, found by the exit-log spec flaking under harness churn).
// ConPTY loses onExit for instant-exit children, and the keeper's own
// child-watch (`kill(pid, 0)`) goes blind when the freed pid is recycled:
// a recycled pid answers "alive" about a stranger, forever. The process
// table CAN tell them apart, because it carries creation times: a child pid
// absent from the table is dead, and one whose creation postdates the
// session's own start is a stranger wearing the pid. Windows FileTime ->
// epoch ms; the 60s tolerance absorbs clock formats disagreeing, and a
// session younger than 10s is never judged (its own spawn may still be
// settling).
const FILETIME_EPOCH_MS = 11644473600000;

function findDeadPtySessions(table, sessions, now = Date.now()) {
  if (!(table instanceof Map)) return [];
  const dead = [];
  for (const session of sessions) {
    if (session.exit || !Number.isInteger(session.pid) || session.pid <= 0) continue;
    const startedMs = Date.parse(session.created_at || '');
    if (!Number.isFinite(startedMs) || now - startedMs < 10_000) continue;
    const row = table.get(session.pid);
    if (!row) { dead.push({ id: session.id, pid: session.pid, why: 'pty child absent from the process table' }); continue; }
    if (row.created > 0) {
      const bornMs = row.created / 10000 - FILETIME_EPOCH_MS;
      if (bornMs > startedMs + 60_000) {
        dead.push({ id: session.id, pid: session.pid, why: 'pty child pid recycled by a younger process' });
      }
    }
  }
  return dead;
}

function killTree(pid, { spawnImpl = spawnSync } = {}) {
  const result = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
  return result.status === 0;
}

// `sessions` and `terminateSession` are optional: when the caller provides
// them (the daemon does), sessions whose pty child is verifiably gone are
// terminated through the KEEPER's own terminate verb, whose verified-gone
// path already records the honest null-code exit. Same two-sighting
// hysteresis, in the same suspects map under a distinct key namespace.
async function sweepOrphans({
  policy, suspects, log, snapshot = snapshotProcessTable, kill = killTree,
  sessions = null, terminateSession = null,
}) {
  if (!policy.enabled) return 0;
  const table = await snapshot();
  if (!table) return 0;
  const orphans = findManagedOrphans(table, policy.patterns);
  const dead = (Array.isArray(sessions) && typeof terminateSession === 'function')
    ? findDeadPtySessions(table, sessions)
      .map((d) => ({ pid: `sess:${d.id}`, created: d.pid, command: d.why, id: d.id, why: d.why }))
    : [];
  // ONE decideKills call for both families. Two calls against the shared
  // suspects map wiped each other's sightings (each call forgets every key
  // the other saw), so a dead session reset to one sighting every sweep and
  // was never killed: live-caught by spec 5b before this ever shipped.
  const kills = decideKills([...orphans, ...dead], suspects);
  let killed = 0;
  for (const target of kills) {
    if (target.id !== undefined) {
      try {
        await terminateSession(target.id, target.why);
        log(`dead-pty-reap session=${target.id} pid=${target.created} (${target.why})`);
        killed += 1;
      } catch (error) {
        log(`dead-pty-reap failed for ${target.id} (left to reconciliation): ${error.message}`);
      }
      continue;
    }
    const ok = kill(target.pid);
    // Either way the suspect entry stays; a survivor is re-verified next
    // sweep rather than silently forgotten.
    log(`orphan-kill pid=${target.pid} ok=${ok} cmd=${JSON.stringify(target.command.slice(0, 160))}`);
    if (ok) killed += 1;
  }
  return killed;
}

module.exports = {
  resolveOrphanPolicy, parseProcessTable, findManagedOrphans, findDeadPtySessions, decideKills, killTree,
  sweepOrphans, snapshotProcessTable, DEFAULT_PATTERNS,
};
