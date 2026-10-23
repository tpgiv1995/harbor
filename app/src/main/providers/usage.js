'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { profilesToHomes } = require('./accounts.js');
const { deriveDefaults } = require('../config/defaults.js');

const MISSING_FIELDS_REASON = 'Claude statusline payload did not include 5-hour usage, weekly usage, and cost';
const NO_SAMPLE_REASON = 'Claude usage is unavailable. Check Claude CLI sign-in or its statusline usage feed.';
const NOT_CLAUDE_REASON = 'Not a Claude account: its plan usage reports in the title-bar usage menu';

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
//
// How old a sample may get before the endpoint is asked depends on what the
// user can see. A Mac reads each home's login from the Keychain, so with no
// statusline tee every account was read from the endpoint about every four
// minutes, 24/7, with the window hidden and nothing running on it. Now the
// window visible with a live session on that account keeps STALE_AFTER_MS;
// visible with nothing running on it waits IDLE_STALE_AFTER_MS; a hidden or
// minimised window waits HIDDEN_STALE_AFTER_MS. The desktop app reports this
// through setActivity(); without it (the phone server, tests) every account
// counts as visible and live, as before.
const STALE_AFTER_MS = 3 * 60 * 1000;
const IDLE_STALE_AFTER_MS = 15 * 60 * 1000;
const HIDDEN_STALE_AFTER_MS = 30 * 60 * 1000;
const REMOTE_COOLDOWN_MS = 60 * 1000; // per-account floor between endpoint hits
// A failed read (429, network, a bad answer, a refused Keychain prompt) used to
// retry on the 60 s cooldown, so a failing account was asked four times as
// often as a healthy one. Each consecutive failure now doubles the wait from
// FAILURE_BACKOFF_BASE_MS up to FAILURE_BACKOFF_MAX_MS, a Retry-After header
// waits at least as long as it says (bounded by RETRY_AFTER_MAX_MS so a bogus
// header cannot freeze the meter for days), and a success resets it.
const FAILURE_BACKOFF_BASE_MS = 60 * 1000;
const FAILURE_BACKOFF_MAX_MS = 30 * 60 * 1000;
const RETRY_AFTER_MAX_MS = 60 * 60 * 1000;
// While the endpoint is failing, a sample older than this is not shown as
// current: its windows have long since rolled to 0%, which read as "0% used"
// with the real reason (a 429, a refused prompt) hidden in a tooltip.
const FAILING_SAMPLE_MAX_AGE_MS = 60 * 60 * 1000;
const KEYCHAIN_STICKY_HINT = 'Harbor will not ask the Keychain again until you refresh the title-bar Plan usage menu.';

// Direct read of the same endpoint the CLI's own rate_limits derive from.
// Read-only: the CLI owns token refresh, so an expired access token means
// skip, never a call that would 401. Any failure returns null and the caller
// keeps serving the stale statusline sample honestly.
// WHICH KEYCHAIN ITEM HOLDS A CONFIG HOME'S LOGIN. Claude Code names it per
// home (read from the installed CLI, 2026-10-05): the bare
// `Claude Code-credentials` when CLAUDE_CONFIG_DIR is unset, otherwise
// `Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>`, where
// the hashed string is the variable exactly as given, NFC-normalized and not
// path-resolved. Harbor exports a profile's configHome verbatim as
// CLAUDE_CONFIG_DIR, so hashing that same string names the item its sessions
// signed in to. Reading only the bare item for `~/.claude` is what made a
// second account (`~/.claude-max`) read "not signed in" while it was. The
// default home tries the bare item first (a plain `claude` login), then its
// hashed twin (a login made with CLAUDE_CONFIG_DIR pointed at ~/.claude).
// Never another home's item: that would show one account's usage under
// another account's name.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
function keychainServicesFor(home, homedir = require('node:os').homedir()) {
  const hashed = `${KEYCHAIN_SERVICE}-${require('node:crypto').createHash('sha256').update(String(home).normalize('NFC')).digest('hex').slice(0, 8)}`;
  return path.resolve(home) === path.resolve(homedir, '.claude') ? [KEYCHAIN_SERVICE, hashed] : [hashed];
}

async function readClaudeCredentials(home, readFile) {
  try { return JSON.parse(await readFile(path.join(home, '.credentials.json'), 'utf8')); } catch {}
  // Claude Code itself owns these macOS Keychain entries. Never read them for
  // an injected test reader, and never for a folder that is not a real config
  // home: a custom home must hold its own `.claude.json` (the definition in
  // config/homes.js), so a test's made-up home or a stray path never reaches
  // the Keychain at all. The default home is exempt because its `.claude.json`
  // lives beside it (~/.claude.json), not inside it.
  if (process.platform !== 'darwin' || readFile !== fs.promises.readFile) return null;
  const isDefaultHome = path.resolve(home) === path.resolve(require('node:os').homedir(), '.claude');
  if (!isDefaultHome && !fs.existsSync(path.join(home, '.claude.json'))) return null;
  const execFile = require('node:util').promisify(require('node:child_process').execFile);
  let lastError = null;
  for (const service of keychainServicesFor(home)) {
    try {
      const { stdout } = await execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000, maxBuffer: 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
      // 44 = no such item: try the next name. Anything else (a denied or
      // timed-out prompt) is an answer, not a reason to keep asking.
      if (error?.code !== 44) break;
    }
  }
  return keychainFailure(lastError);
}

// Say WHY instead of reading as "not signed in": a denied or timed-out
// Keychain prompt is a different fix from a missing login. An answer from a
// refused or unanswered prompt (Deny, Cancel, a timeout) also carries
// `keychainPrompt: true`: the usage provider does not ask again until the user
// refreshes by hand, because reading again on a timer re-prompts every minute.
// A missing item (44) or an unreadable one is not a prompt and only backs off.
function keychainFailure(lastError) {
  const why = lastError?.killed ? 'the Keychain prompt timed out' : lastError?.code === 44 ? 'no Claude Code entry in the Keychain' : lastError instanceof SyntaxError ? 'the Claude Code Keychain entry is not readable JSON' : `security exited ${lastError?.code ?? 'abnormally'}`;
  const prompted = Boolean(lastError) && lastError.code !== 44 && !(lastError instanceof SyntaxError);
  return prompted ? { keychainError: why, keychainPrompt: true } : { keychainError: why };
}

// Retry-After is either delay-seconds or an HTTP-date (RFC 9110 10.2.3).
// Returns milliseconds from nowMs, or null when absent or unreadable.
function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

async function fetchOauthUsage(home, { readFile = fs.promises.readFile, readCredentials, reportUnavailable = false, now = () => new Date(), fetchImpl = fetch } = {}) {
  let creds;
  try {
    creds = await (readCredentials ? readCredentials(home) : readClaudeCredentials(home, readFile));
  } catch {
    return null;
  }
  if (creds?.keychainError) return reportUnavailable ? { unavailable: true, reason: `Could not read Claude credentials from the macOS Keychain: ${creds.keychainError}`, ...(creds.keychainPrompt ? { sticky: true } : {}) } : null;
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) return reportUnavailable ? { unavailable: true, reason: 'Claude is not signed in for usage access. Sign in with the Claude CLI, then refresh Harbor.' } : null;
  if (finiteNumber(oauth.expiresAt) && oauth.expiresAt <= now().getTime()) return reportUnavailable ? { unavailable: true, reason: 'Claude credentials have expired. Open the Claude CLI to renew the session, then refresh Harbor.' } : null;
  // Each failure below used to collapse to `null`, which the panel rendered as
  // the generic "usage is unavailable" line: a network error, a 401/429 and a
  // body with no numbers all looked identical (2026-10-05, a live account
  // whose endpoint answered 200 from a shell read "unavailable" in the app).
  // When the caller asks for reasons, say which one it was.
  const failed = (reason) => (reportUnavailable ? { unavailable: true, reason } : null);
  let res;
  try {
    res = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return failed(`Claude usage request failed: ${error?.name === 'TimeoutError' ? 'timed out after 10s' : (error?.cause?.code || error?.message || 'network error')}`);
  }
  if (!res.ok) {
    const out = failed(`Claude usage request failed: HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
    // The provider's failure backoff waits at least this long.
    const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'), now().getTime());
    if (out && retryAfterMs !== null) out.retryAfterMs = retryAfterMs;
    return out;
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return failed('Claude usage response was not JSON');
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
    && !finiteNumber(rateLimits.seven_day?.used_percentage)) return failed('Claude usage response carried no 5-hour or weekly numbers');
  return { payload: { rate_limits: rateLimits }, updatedAt: now().toISOString() };
}

function createUsageProvider(options = {}) {
  const homes = options.homes || profilesToHomes(options.profiles);
  // Claude usage exists only for Claude homes. A codex profile is a real account
  // with a real home (Pat's config gained three on 2026-09-28), but that home has
  // no .claude.json, no statusline and no Claude OAuth token, so every read here
  // was a guaranteed miss that also spent the remote-fallback budget. Its usage
  // comes from plan-usage.js, which the title-bar menu already renders.
  const notClaude = new Set((options.profiles || [])
    .filter((profile) => profile?.provider && profile.provider !== 'claude')
    .map((profile) => profile.id));
  const readFile = options.readFile || fs.promises.readFile;
  const now = options.now || (() => new Date());
  const teeDir = options.teeDir || options.cacheDir || deriveDefaults().paths.cacheDir;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const remoteCooldownMs = options.remoteCooldownMs ?? REMOTE_COOLDOWN_MS;
  // Pass fetchRemoteUsage: null to disable the direct endpoint fallback
  // (tests, E2E; real accounts must never be hit from a harness).
  const fetchRemoteUsage = options.fetchRemoteUsage === undefined
    ? (home) => fetchOauthUsage(home, { readFile, now, reportUnavailable: true })
    : options.fetchRemoteUsage;
  const samples = new Map();
  const remoteSamples = new Map();
  const lastRemoteAttempt = new Map();
  const remoteUnavailable = new Map();
  // The read in flight per account. Concurrent readers AWAIT it: the rail
  // asks for every account at once on mount, on focus and on each update, so
  // two reads routinely overlap, and the second used to see the cooldown, find
  // no sample yet and answer "unavailable" while the first was still fetching.
  // Whichever answer the renderer applied last won, so a launch could show the
  // generic line until the next focus refresh.
  const remotePending = new Map();
  // Per-account failure state, absent while the endpoint is healthy:
  // { failures, backoffUntil, retryAfterUntil, sticky, failedAt }.
  const remoteHealth = new Map();
  let activity = typeof options.activity === 'function' ? options.activity : null;

  // { visible, live } for this account; anything unknown counts as visible
  // and live, the behaviour before the cadence existed.
  function activityFor(account) {
    let state = null;
    try { state = activity ? activity(account) : null; } catch { state = null; }
    return { visible: state?.visible !== false, live: state?.live !== false };
  }
  function staleAfterFor(state) {
    if (!state.visible) return Math.max(staleAfterMs, HIDDEN_STALE_AFTER_MS);
    return state.live ? staleAfterMs : Math.max(staleAfterMs, IDLE_STALE_AFTER_MS);
  }

  // May the endpoint be asked for this account now? A manual refresh clears
  // the backoff and a refused prompt's stop before asking; nothing clears
  // Retry-After or the per-account cooldown.
  function remoteAllowed(account, nowMs) {
    if (typeof fetchRemoteUsage !== 'function') return false;
    const health = remoteHealth.get(account);
    if (health?.sticky) return false;
    if (health && Math.max(health.backoffUntil, health.retryAfterUntil) > nowMs) return false;
    return nowMs - (lastRemoteAttempt.get(account) || 0) >= remoteCooldownMs;
  }

  function startRemote(account, nowMs) {
    lastRemoteAttempt.set(account, nowMs);
    const inflight = (async () => {
      const fetched = await Promise.resolve().then(() => fetchRemoteUsage(homes[account])).catch(() => null);
      const doneMs = now().getTime();
      if (fetched?.payload) {
        remoteHealth.delete(account);
        remoteUnavailable.delete(account);
        remoteSamples.set(account, fetched);
        return fetched;
      }
      const failures = (remoteHealth.get(account)?.failures || 0) + 1;
      const backoffMs = Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** (failures - 1));
      const retryAfterMs = finiteNumber(fetched?.retryAfterMs) ? Math.min(RETRY_AFTER_MAX_MS, Math.max(0, fetched.retryAfterMs)) : 0;
      const sticky = Boolean(fetched?.sticky);
      remoteHealth.set(account, {
        failures,
        backoffUntil: doneMs + Math.max(backoffMs, retryAfterMs),
        retryAfterUntil: doneMs + retryAfterMs,
        sticky,
        failedAt: doneMs,
      });
      if (fetched?.unavailable) {
        const reason = sticky && fetched.reason ? `${fetched.reason}. ${KEYCHAIN_STICKY_HINT}` : fetched.reason;
        remoteUnavailable.set(account, { unavailable: true, reason });
      }
      return fetched;
    })().finally(() => remotePending.delete(account));
    remotePending.set(account, inflight);
    return inflight;
  }

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

    // The desktop app tells the provider what the user can see (see
    // IDLE_STALE_AFTER_MS): fn(account) answers { visible, live }.
    setActivity(fn) {
      activity = typeof fn === 'function' ? fn : null;
    },

    // `manual: true` is a refresh the user asked for (opening the title-bar
    // Plan usage menu or pressing its Refresh). It clears the failure backoff
    // and a refused Keychain prompt's stop, never Retry-After or the cooldown.
    // Timer, focus and mount reads leave it off.
    async getUsage(account, { manual = false } = {}) {
      assertAccount(account);
      // A codex profile stays in the not-Claude lane on purpose (2026-10-06). A
      // per-profile `codex app-server` reader was offered for the rail, but it
      // spawns one CLI process per codex profile per minute, and on Windows a
      // kill reaches only the shim, so codex.exe and the MCP servers it starts
      // can outlive it. Codex plan usage already reaches the title-bar menu
      // through plan-usage.js, which reads rollouts and the usage endpoint
      // without starting the CLI.
      if (notClaude.has(account)) return { unavailable: true, notClaude: true, reason: NOT_CLAUDE_REASON, email: null };
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
      const failing = remoteHealth.has(account);
      if (manual && failing) remoteHealth.set(account, { ...remoteHealth.get(account), sticky: false, backoffUntil: 0 });
      const staleAfter = manual ? staleAfterMs : staleAfterFor(activityFor(account));
      let inflight = remotePending.get(account);
      if (!inflight && (age > staleAfter || (manual && failing)) && remoteAllowed(account, nowMs)) {
        inflight = startRemote(account, nowMs);
      }
      if (inflight) {
        const fetched = await inflight;
        if (fetched?.payload && (!chosen || stampMs(fetched) > stampMs(chosen))) {
          chosen = { payload: fetched.payload, updatedAt: fetched.updatedAt, email };
        }
      }

      const failure = remoteUnavailable.get(account);
      const failedAt = remoteHealth.get(account)?.failedAt;
      const failedSince = Boolean(chosen && failure && finiteNumber(failedAt) && failedAt >= stampMs(chosen));
      if (failedSince && nowMs - stampMs(chosen) > FAILING_SAMPLE_MAX_AGE_MS) chosen = null;

      if (!chosen) return { ...(failure || { unavailable: true, reason: NO_SAMPLE_REASON }), email };
      const result = usageFromStatuslinePayload(chosen.payload, {
        email: chosen.email || email,
        updatedAt: chosen.updatedAt,
        nowMs,
      });
      // The numbers shown have gone stale and the endpoint failed after them:
      // say why they are not refreshing.
      if (!result.unavailable && failedSince && failure.reason && nowMs - stampMs(chosen) > staleAfter) {
        result.notice = failure.reason;
      }
      return result;
    },
  };
}

module.exports = {
  MISSING_FIELDS_REASON,
  NO_SAMPLE_REASON,
  NOT_CLAUDE_REASON,
  STALE_AFTER_MS,
  IDLE_STALE_AFTER_MS,
  HIDDEN_STALE_AFTER_MS,
  REMOTE_COOLDOWN_MS,
  FAILURE_BACKOFF_BASE_MS,
  FAILURE_BACKOFF_MAX_MS,
  RETRY_AFTER_MAX_MS,
  FAILING_SAMPLE_MAX_AGE_MS,
  createUsageProvider,
  fetchOauthUsage,
  keychainFailure,
  keychainServicesFor,
  parseRetryAfter,
  usageFromStatuslinePayload,
};
