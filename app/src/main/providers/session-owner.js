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
// ONE LISTING PER HOME PER PASS (2026-11-01). The delegation scan asks for the
// beacon of every Claude session active in the last 48 hours on every rail
// refresh and every agent status change, and each ask statted the beacon path
// in all six config homes: a session lives in one home, so five of six stats
// failed, hundreds of sessions times six, every pass, in the desktop and the
// phone server (a failed stat costs an Error object and a filter-driver trip
// on Windows). A pass now lists each home's statusline-state folder once and
// stats only beacons that exist. Single lookups (takeover, transcript) still
// stat the six paths directly.
async function buildBeaconIndex(homes = beaconHomes()) {
  const index = new Map(); // session id -> [beacon paths]
  for (const home of homes) {
    const dir = path.join(home, 'statusline-state');
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; /* no beacons in this home */ }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const file = path.join(dir, name);
      const list = index.get(id);
      if (list) list.push(file); else index.set(id, [file]);
    }
  }
  return index;
}

async function readSessionBeacon(sessionId, homes = beaconHomes(), beaconIndex = null) {
  let beaconMs = null;
  const files = beaconIndex
    ? beaconIndex.get(sessionId) || []
    : homes.map((home) => path.join(home, 'statusline-state', `${sessionId}.json`));
  for (const file of files) {
    try {
      const stat = await fsp.stat(file);
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
async function readSessionOwner(sessionId, { homes, contextCacheDir = resolveContextDir(), beaconIndex = null } = {}) {
  const beaconMs = await readSessionBeacon(sessionId, homes, beaconIndex);
  let processAlive = null;
  if (process.platform !== 'win32') {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(contextCacheDir, `${sessionId}.json`), 'utf8'));
      processAlive = readOwnerProcessAlive(Number.isInteger(raw?.pid) && raw.pid > 1 ? raw.pid : null);
    } catch { /* no exact owner evidence */ }
  }
  return { beaconMs, processAlive };
}
module.exports = { buildBeaconIndex, readSessionBeacon, readOwnerProcessAlive, readSessionOwner };
