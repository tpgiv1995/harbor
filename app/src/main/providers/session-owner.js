'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listHomeDirs } = require('../config/homes.js');
const { resolveContextDir } = require('../isolation.js');

// Shared by open transcripts and the delegation worker. Every profile counts;
// a missed beacon can offer Resume on an owned session and create two writers.
let homesCache = { at: 0, dirs: [] };
function beaconHomes(now = Date.now()) {
  const pinned = process.env.HARBOR_BEACON_HOMES;
  if (pinned) return pinned.split(path.delimiter).filter(Boolean);
  if (now - homesCache.at < 60_000) return homesCache.dirs;
  const found = listHomeDirs(os.homedir(), fs.readdirSync);
  const dirs = found.length ? found : [path.join(os.homedir(), '.claude')];
  homesCache = { at: now, dirs };
  return dirs;
}
async function readSessionBeacon(sessionId, homes = beaconHomes()) {
  let beaconMs = null;
  for (const home of homes) {
    try {
      const stat = await fsp.stat(path.join(home, 'statusline-state', `${sessionId}.json`));
      beaconMs = Math.max(beaconMs || 0, stat.mtimeMs);
    } catch { /* no beacon in this home */ }
  }
  return beaconMs;
}
function readOwnerProcessAlive(ownerPid, readProcessCmdline) {
  // /proc cannot answer on Windows. Do not turn a failed /proc read into a
  // dead owner there, and never substitute a process-table query or CIM call.
  if (!ownerPid || !readProcessCmdline && process.platform === 'win32') return null;
  const read = readProcessCmdline || ((pid) => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  try { const cmd = read(ownerPid); return /(^|\0|\/)claude(\0|$)/.test(cmd) || cmd.includes('claude'); }
  catch { return false; }
}
async function readSessionOwner(sessionId, { homes, contextCacheDir = resolveContextDir() } = {}) {
  const beaconMs = await readSessionBeacon(sessionId, homes);
  let processAlive = null;
  if (process.platform !== 'win32') {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(contextCacheDir, `${sessionId}.json`), 'utf8'));
      processAlive = readOwnerProcessAlive(Number.isInteger(raw?.pid) && raw.pid > 1 ? raw.pid : null);
    } catch { /* no exact owner evidence */ }
  }
  return { beaconMs, processAlive };
}
module.exports = { readSessionBeacon, readOwnerProcessAlive, readSessionOwner };
