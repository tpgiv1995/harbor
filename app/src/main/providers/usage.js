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
const STALE_AFTER_MS = 3 * 60 * 1000;
const REMOTE_COOLDOWN_MS = 60 * 1000; // per-account floor between endpoint hits

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

// THE PLAN A HOME IS SIGNED IN TO, and the Keychain item that matches it. The
// home's .claude.json names its account's plan (`oauthAccount.organizationType`:
// claude_team, claude_max, ...) and each Keychain item names the plan of the
// login it holds (`claudeAiOauth.subscriptionType`: team, max, ...). The two
// can disagree: the default home has two items (bare for a plain `claude`,
// hashed for sessions launched with CLAUDE_CONFIG_DIR) that may hold two
// different logins, and a login made in one home can end up in another's
// item. Null when the plan is not one of the known names.
const KNOWN_PLANS = new Set(['pro', 'max', 'team', 'enterprise']);
async function homePlan(home, readFile, homedir = require('node:os').homedir()) {
  // The default home's .claude.json may live beside it (~/.claude.json).
  const isDefaultHome = path.resolve(home) === path.resolve(homedir, '.claude');
  const files = [path.join(home, '.claude.json'), ...(isDefaultHome ? [path.join(homedir, '.claude.json')] : [])];
  for (const file of files) {
    try {
      const type = JSON.parse(await readFile(file, 'utf8'))?.oauthAccount?.organizationType;
      const plan = typeof type === 'string' ? type.replace(/^claude_/, '') : null;
      return KNOWN_PLANS.has(plan) ? plan : null;
    } catch { /* not this file */ }
  }
  return null;
}

// Which of a home's Keychain items to use (`readItem(service)` returns the
// item's JSON text). The first item holding a token on the home's plan wins,
// or on an unknown plan. An item without a token is the answer only when no
// item has one. When exactly one item holds a token, every item was read and
// its plan differs from the home's, that login is still the only one the home
// has (a plan can change before the CLI rewrites .claude.json), so it is used
// and marked `planMismatch: { keychain, home }`; the usage provider refuses it
// when another configured home is signed in to that plan, and otherwise shows
// the mismatch on the account's row. Two or more tokened items with none on
// the home's plan is an error rather than a guess.
async function pickKeychainCredentials(services, readItem, { plan = null } = {}) {
  let lastError = null;
  let tokenless = null;
  let readAll = true;
  const otherPlans = [];
  for (const service of services) {
    let creds;
    try {
      creds = JSON.parse(await readItem(service));
    } catch (error) {
      lastError = error;
      // 44 = no such item: try the next name. Anything else (a denied or
      // timed-out prompt) is an answer, not a reason to keep asking.
      if (error?.code === 44) continue;
      readAll = false;
      break;
    }
    if (creds?.claudeAiOauth?.accessToken) {
      const type = creds.claudeAiOauth.subscriptionType;
      if (!plan || !KNOWN_PLANS.has(type) || type === plan) return creds;
      otherPlans.push({ creds, type });
    } else {
      tokenless ??= creds;
    }
  }
  if (readAll && otherPlans.length === 1) {
    const [{ creds, type }] = otherPlans;
    return { ...creds, planMismatch: { keychain: type, home: plan } };
  }
  if (readAll && otherPlans.length > 1) {
    return { keychainError: `no Keychain login is on this home's ${plan} plan (found ${otherPlans.map((o) => o.type).join(', ')}); sign in again in this home` };
  }
  if (tokenless) return tokenless;
  // Say WHY instead of reading as "not signed in": a denied or timed-out
  // Keychain prompt is a different fix from a missing login.
  const why = lastError?.killed ? 'the Keychain prompt timed out' : lastError?.code === 44 ? 'no Claude Code entry in the Keychain' : `security exited ${lastError?.code ?? 'abnormally'}`;
  return { keychainError: why };
}

function planMismatchNote(mismatch) {
  if (!mismatch?.keychain || !mismatch?.home) return null;
  return `Plan mismatch: the Keychain login is on the ${mismatch.keychain} plan but this home's .claude.json says ${mismatch.home}`;
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
  const plan = await homePlan(home, readFile);
  return pickKeychainCredentials(keychainServicesFor(home), async (service) => {
    const { stdout } = await execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return stdout;
  }, { plan });
}

async function fetchOauthUsage(home, { readFile = fs.promises.readFile, readCredentials, reportUnavailable = false, now = () => new Date(), fetchImpl = fetch } = {}) {
  let creds;
  try {
    creds = await (readCredentials ? readCredentials(home) : readClaudeCredentials(home, readFile));
  } catch {
    return null;
  }
  if (creds?.keychainError) return reportUnavailable ? { unavailable: true, reason: `Could not read Claude credentials from the macOS Keychain: ${creds.keychainError}` } : null;
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
  if (!res.ok) return failed(`Claude usage request failed: HTTP ${res.status}${res.status === 429 ? ' (rate limited; retrying shortly)' : ''}`);
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
  const fetched = { payload: { rate_limits: rateLimits }, updatedAt: now().toISOString() };
  if (creds.planMismatch) fetched.planMismatch = creds.planMismatch;
  return fetched;
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

  const stampMs = (sample) => {
    const parsed = sample?.updatedAt ? Date.parse(sample.updatedAt) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };

  // A Keychain login on another plan than its home's (planMismatch) whose
  // plan another configured Claude home is signed in to is most likely THAT
  // account's login, so its numbers are not shown under this one's name.
  const labelOf = (account) => (options.profiles || []).find((p) => p?.id === account)?.label || account;
  async function otherHomeOnPlan(account, plan) {
    for (const [other, home] of Object.entries(homes)) {
      if (other === account || notClaude.has(other) || !home) continue;
      if (await homePlan(home, readFile) === plan) return labelOf(other);
    }
    return null;
  }

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
        chosen = { payload: remote.payload, updatedAt: remote.updatedAt, email, remote };
      }

      const age = chosen ? nowMs - stampMs(chosen) : Infinity;
      if (age > staleAfterMs && typeof fetchRemoteUsage === 'function'
        && nowMs - (lastRemoteAttempt.get(account) || 0) >= remoteCooldownMs) {
        lastRemoteAttempt.set(account, nowMs);
        let fetched = await Promise.resolve(fetchRemoteUsage(homes[account])).catch(() => null);
        const owner = fetched?.payload && fetched.planMismatch ? await otherHomeOnPlan(account, fetched.planMismatch.keychain) : null;
        if (owner) {
          remoteSamples.delete(account);
          fetched = {
            unavailable: true,
            reason: `This home's Keychain login is on the ${fetched.planMismatch.keychain} plan, which ${owner} is signed in to, so its usage would be that account's. Sign in again in this home.`,
          };
        }
        if (fetched?.unavailable) remoteUnavailable.set(account, fetched);
        if (fetched?.payload) {
          remoteUnavailable.delete(account);
          remoteSamples.set(account, fetched);
          chosen = { payload: fetched.payload, updatedAt: fetched.updatedAt, email, remote: fetched };
        }
      }

      if (!chosen) return { ...(remoteUnavailable.get(account) || { unavailable: true, reason: NO_SAMPLE_REASON }), email };
      const result = usageFromStatuslinePayload(chosen.payload, {
        email: chosen.email || email,
        updatedAt: chosen.updatedAt,
        nowMs,
      });
      // Shown numbers that came from a Keychain login on another plan say so.
      // A statusline sample is the CLI's own and never carries the flag.
      if (chosen.remote?.planMismatch) {
        result.planMismatch = chosen.remote.planMismatch;
        result.planMismatchNote = planMismatchNote(chosen.remote.planMismatch);
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
  REMOTE_COOLDOWN_MS,
  createUsageProvider,
  fetchOauthUsage,
  keychainServicesFor,
  pickKeychainCredentials,
  planMismatchNote,
  homePlan,
  usageFromStatuslinePayload,
};
