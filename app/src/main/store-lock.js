'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const LOCK_WAIT_MS = 4000;
const LOCK_STALE_MS = 15000;
const LOCK_MAX_AGE_MS = 60000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ownerGone(dir) {
  let owner;
  try { owner = await fs.readFile(path.join(dir, 'owner'), 'utf8'); }
  catch { return true; }
  const pid = Number(owner);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  // Signal zero sends no signal. Uncertain liveness delays recovery only
  // until the ceiling; PID reuse or EPERM must not lock the store forever.
  try { process.kill(pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

async function acquireStoreLock(dir, { waitMs = LOCK_WAIT_MS } = {}) {
  // A store's injected clock dates documents; it must not freeze lock retries.
  const deadline = performance.now() + waitMs;
  try { await fs.mkdir(path.dirname(dir), { recursive: true }); }
  catch { return false; }
  let firstAttempt = true;
  while (firstAttempt || performance.now() < deadline) {
    firstAttempt = false;
    try {
      await fs.mkdir(dir);
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      if (waitMs === 0) return false;
      let stat;
      try { stat = await fs.stat(dir); }
      catch (statError) { if (statError?.code === 'ENOENT') continue; return false; }
      const age = Date.now() - stat.mtimeMs;
      if (age > LOCK_MAX_AGE_MS || (age > LOCK_STALE_MS && await ownerGone(dir))) {
        try { await fs.rm(dir, { recursive: true, force: true }); }
        catch { return false; }
      } else await sleep(25);
      continue;
    }
    try {
      await fs.writeFile(path.join(dir, 'owner'), String(process.pid), 'utf8');
      return true;
    } catch {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return false;
    }
  }
  return false;
}

module.exports = { acquireStoreLock };
