'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { profilesToHomes } = require('./accounts.js');
const { deriveDefaults } = require('../config/defaults.js');

const MISSING_FIELDS_REASON = 'Claude statusline payload did not include 5-hour usage, weekly usage, and cost';
const NO_SAMPLE_REASON = 'No live Claude statusline payload has been observed for this account; Claude Code supplies usage only on statusline stdin';

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// A statusline sample only lands while that account is actively running, so a
// quiet account's numbers go stale. But a window whose resets_at has PASSED
// has definitionally reset: usage is 0% until something runs again. Roll it
// instead of showing 12-hour-old percentages (live-caught on a profile at 103%
// half a day after its window reset).
function rollExpiredWindows(result, nowMs) {
  const nowSec = nowMs / 1000;
  if (finiteNumber(result.fiveHourResetsAt) && nowSec > result.fiveHourResetsAt) {
    result.fiveHourPct = 0;
    result.fiveHourRolled = true;
    delete result.fiveHourResetsAt; // no active window until next use
  }
  if (finiteNumber(result.weeklyResetsAt) && nowSec > result.weeklyResetsAt) {
    result.weeklyPct = 0;
    result.weeklyRolled = true;
    delete result.weeklyResetsAt;
  }
  return result;
}

function usageFromStatuslinePayload(payload, { email, updatedAt, nowMs = Date.now() } = {}) {
  const fiveHourPct = payload?.rate_limits?.five_hour?.used_percentage;
  const weeklyPct = payload?.rate_limits?.seven_day?.used_percentage;
  const cost = payload?.cost?.total_cost_usd;
  if (![fiveHourPct, weeklyPct, cost].some(finiteNumber)) {
    // Nothing usable at all: honest unavailable, but keep the freshness stamp.
    return { unavailable: true, reason: MISSING_FIELDS_REASON, email, updatedAt };
  }
  if (![fiveHourPct, weeklyPct, cost].every(finiteNumber)) {
    // Render what exists; missing fields stay undefined and the tile shows
    // them as pending rather than hiding the account.
    const partial = { email, updatedAt, partial: true };
    if (finiteNumber(fiveHourPct)) partial.fiveHourPct = fiveHourPct;
    if (finiteNumber(weeklyPct)) partial.weeklyPct = weeklyPct;
    if (finiteNumber(cost)) partial.cost = cost;
    const fiveHourResetsAtP = payload?.rate_limits?.five_hour?.resets_at;
    const weeklyResetsAtP = payload?.rate_limits?.seven_day?.resets_at;
    if (finiteNumber(fiveHourResetsAtP)) partial.fiveHourResetsAt = fiveHourResetsAtP;
    if (finiteNumber(weeklyResetsAtP)) partial.weeklyResetsAt = weeklyResetsAtP;
    return rollExpiredWindows(partial, nowMs);
  }
  const result = { fiveHourPct, weeklyPct, cost, email, updatedAt };
  const fiveHourResetsAt = payload?.rate_limits?.five_hour?.resets_at;
  const weeklyResetsAt = payload?.rate_limits?.seven_day?.resets_at;
  if (finiteNumber(fiveHourResetsAt)) result.fiveHourResetsAt = fiveHourResetsAt;
  if (finiteNumber(weeklyResetsAt)) result.weeklyResetsAt = weeklyResetsAt;
  return rollExpiredWindows(result, nowMs);
}

async function readEmail(home, readFile) {
  try {
    const config = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
    return config?.oauthAccount?.emailAddress || null;
  } catch {
    return null;
  }
}

// The statusline tee (installed 2026-07-17 in ~/.claude/statusline-command.sh)
// persists the freshest payload per account here on every statusline render.

// The statusline repaints only on interactive activity, so a session driving
// a background workflow fleet burns tokens for an hour without producing a
// single new sample (live-caught 2026-07-24: a meter sat frozen at the
// boot render, 1 percent, while her real 5-hour window was at 68 percent).
// When the freshest sample is older than this, Harbor asks the OAuth usage
// endpoint directly with that home's own token.
const STALE_AFTER_MS = 3 * 60 * 1000;
const REMOTE_COOLDOWN_MS = 60 * 1000; // per-account floor between endpoint hits

// Direct read of the same endpoint the CLI's own rate_limits derive from.
// Read-only: the CLI owns token refresh, so an expired access token means
// skip, never a call that would 401. Any failure returns null and the caller
// keeps serving the stale statusline sample honestly.
async function fetchOauthUsage(home, { readFile = fs.promises.readFile, now = () => new Date(), fetchImpl = fetch } = {}) {
  let creds;
  try {
    creds = JSON.parse(await readFile(path.join(home, '.credentials.json'), 'utf8'));
  } catch {
    return null;
  }
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  if (finiteNumber(oauth.expiresAt) && oauth.expiresAt <= now().getTime()) return null;
  let res;
  try {
    res = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const mapWindow = (w) => {
    const out = {};
    if (finiteNumber(w?.utilization)) out.used_percentage = w.utilization;
    const resetsMs = w?.resets_at ? Date.parse(w.resets_at) : NaN;
    if (Number.isFinite(resetsMs)) out.resets_at = resetsMs / 1000;
    return out;
  };
  const rateLimits = {};
  if (body?.five_hour) rateLimits.five_hour = mapWindow(body.five_hour);
  if (body?.seven_day) rateLimits.seven_day = mapWindow(body.seven_day);
  if (!finiteNumber(rateLimits.five_hour?.used_percentage)
    && !finiteNumber(rateLimits.seven_day?.used_percentage)) return null;
  return { payload: { rate_limits: rateLimits }, updatedAt: now().toISOString() };
}

function createUsageProvider(options = {}) {
  const homes = options.homes || profilesToHomes(options.profiles);
  const readFile = options.readFile || fs.promises.readFile;
  const now = options.now || (() => new Date());
  const teeDir = options.teeDir || options.cacheDir || deriveDefaults().paths.cacheDir;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const remoteCooldownMs = options.remoteCooldownMs ?? REMOTE_COOLDOWN_MS;
  // Pass fetchRemoteUsage: null to disable the direct endpoint fallback
  // (tests, E2E; real accounts must never be hit from a harness).
  const fetchRemoteUsage = options.fetchRemoteUsage === undefined
    ? (home) => fetchOauthUsage(home, { readFile, now })
    : options.fetchRemoteUsage;
  const samples = new Map();
  const remoteSamples = new Map();
  const lastRemoteAttempt = new Map();

  const stampMs = (sample) => {
    const parsed = sample?.updatedAt ? Date.parse(sample.updatedAt) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };

  function assertAccount(account) {
    if (!Object.hasOwn(homes, account)) throw new Error(`unknown account: ${account}`);
  }

  async function readTeeSample(account) {
    try {
      const raw = await readFile(path.join(teeDir, `usage-${account}.json`), 'utf8');
      const tee = JSON.parse(raw);
      if (!tee || typeof tee !== 'object') return null;
      return { payload: tee, updatedAt: tee.updated_at || null, email: tee.account_email || null };
    } catch {
      return null;
    }
  }

  return {
    recordStatuslinePayload(account, payload) {
      assertAccount(account);
      samples.set(account, { payload, updatedAt: now().toISOString() });
    },

    async getUsage(account) {
      assertAccount(account);
      const email = await readEmail(homes[account], readFile);
      const nowMs = now().getTime();

      // Local sample precedence is unchanged (live statusline push, then the
      // tee file); a cached direct-endpoint sample beats either only when it
      // is strictly fresher.
      const mem = samples.get(account) || null;
      const tee = mem ? null : await readTeeSample(account);
      let chosen = mem
        ? { payload: mem.payload, updatedAt: mem.updatedAt, email }
        : tee
          ? { payload: tee.payload, updatedAt: tee.updatedAt, email: email || tee.email }
          : null;
      const remote = remoteSamples.get(account);
      if (remote && (!chosen || stampMs(remote) > stampMs(chosen))) {
        chosen = { payload: remote.payload, updatedAt: remote.updatedAt, email };
      }

      const age = chosen ? nowMs - stampMs(chosen) : Infinity;
      if (age > staleAfterMs && typeof fetchRemoteUsage === 'function'
        && nowMs - (lastRemoteAttempt.get(account) || 0) >= remoteCooldownMs) {
        lastRemoteAttempt.set(account, nowMs);
        const fetched = await Promise.resolve(fetchRemoteUsage(homes[account])).catch(() => null);
        if (fetched?.payload) {
          remoteSamples.set(account, fetched);
          chosen = { payload: fetched.payload, updatedAt: fetched.updatedAt, email };
        }
      }

      if (!chosen) return { unavailable: true, reason: NO_SAMPLE_REASON, email };
      return usageFromStatuslinePayload(chosen.payload, {
        email: chosen.email || email,
        updatedAt: chosen.updatedAt,
        nowMs,
      });
    },
  };
}

module.exports = {
  MISSING_FIELDS_REASON,
  NO_SAMPLE_REASON,
  STALE_AFTER_MS,
  REMOTE_COOLDOWN_MS,
  createUsageProvider,
  fetchOauthUsage,
  usageFromStatuslinePayload,
};
