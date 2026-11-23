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

// A READING OLDER THAN THIS IS MARKED STALE WHERE IT IS SHOWN (2026-11-23).
// Pat started a session on Claude C because the rail said its week was at about
// 20%; it was at 99%. The rail had been drawing a statusline sample from Nov 21
// (the plan's last interactive prompt, two hours into its new week) for two
// days, in full colour, while headless workers and lanes, which never draw a
// statusline, burned the week to 100%. The direct read below was failing with
// HTTP 429 the whole time, and a Harbor restart that morning had emptied the
// only good reading it held. Within a window usage only goes up, so an old
// number is a floor, never the answer; the rail now says so (`stale`, with
// `staleReason`) instead of presenting it as current. 15 minutes: a healthy
// endpoint re-reads every idle plan each minute, and an active plan's
// statusline lands every few seconds, so only a reading Harbor truly cannot
// refresh gets this old.
const SHOWN_STALE_MS = 15 * 60 * 1000;
// The wait to keep after an HTTP 429 that names none. The endpoint has answered
// 429 with Retry-After 817 s and 3600 s (2026-11-23); C:\tools\claude-usage
// keeps 900 s when the header is missing, and one rule across both readers of
// the same endpoint is the point.
const DEFAULT_RETRY_AFTER_MS = 15 * 60 * 1000;
// AND NO WAIT IS KEPT LONGER THAN THAT. A Retry-After is the provider's upper
// bound, not when it will answer: Work's plan was given 3600 s at 19:10Z and
// answered 200 at 19:52Z, both with and without the CLI headers, while the
// rail sat on "94%+" (it was 96%) for the whole hour (Pat: "you sure its
// fixed? work plan is still showing the + shit"). Fifteen minutes still
// gives a refusing account its quiet (four calls an hour, not sixty, the
// hammering that kept a plan at 429 for four hours) without leaving the rail
// stale for an hour after the refusals stop.
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

// Retry-After is either delta seconds or an HTTP date (RFC 9110 10.2.3).
function parseRetryAfter(value, nowMs) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

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
  // Say WHY instead of reading as "not signed in": a denied or timed-out
  // Keychain prompt is a different fix from a missing login.
  const why = lastError?.killed ? 'the Keychain prompt timed out' : lastError?.code === 44 ? 'no Claude Code entry in the Keychain' : `security exited ${lastError?.code ?? 'abnormally'}`;
  return { keychainError: why };
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
  // An expired ACCESS token is not a sign-out: it lives about 8 hours and is
  // renewed from the refresh token beside it (the login itself runs for weeks;
  // `claude auth status` showed one valid to Dec 11 while its access token had
  // lapsed). `tokenLapsed` lets the provider ask the Claude CLI to renew it
  // (renewTokenWithCli below) instead of serving an old number.
  if (finiteNumber(oauth.expiresAt) && oauth.expiresAt <= now().getTime()) return reportUnavailable ? { unavailable: true, tokenLapsed: true, reason: 'This plan has been idle, so its short-lived access token lapsed (its login is fine); Harbor renews it through the Claude CLI before reading' } : null;
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
  // A 429 carries the provider's own wait, and every reader must honour it:
  // calling again inside it is what kept accounts at 429 for hours
  // (2026-11-23), because each early call is another refusal.
  if (res.status === 429) {
    const retryAfterMs = Math.min(parseRetryAfter(res.headers?.get?.('retry-after'), now().getTime()) ?? DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS);
    return reportUnavailable
      ? { unavailable: true, status: 429, retryAfterMs, reason: 'Claude usage request failed: HTTP 429 (rate limited; Claude asked for a pause before the next read)' }
      : null;
  }
  if (!res.ok) return failed(`Claude usage request failed: HTTP ${res.status}`);
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

// RENEW AN IDLE PLAN'S ACCESS TOKEN THROUGH THE CLAUDE CLI ITSELF (2026-11-23).
// Harbor never refreshes a token or writes an auth file: the CLI owns that
// (with its own lock), and a second refresher racing it could rotate the
// refresh token out from under a live session. So an idle plan, whose access
// token lapses about 8 hours after its last session, could never be read, and
// the rail showed its last statusline number for days: nine of fifteen plans
// that day, e.g. Ocean "82%" at 94% and Patchy "76%" at 100%. Pat: "this
// happens when we havent used one of them in a few days but the credentials
// are good". `claude -p /usage` is a LOCAL command in print mode (measured on
// 2.1.321: num_turns 0, total_cost_usd 0, no model call), and to answer it the
// CLI renews the token the way any session would. Guards: the API key is
// stripped (a key would bill the console and skip the plan's login), no
// transcript is kept, no MCP servers, hooks or settings load, the cwd is an
// empty folder, and a cheap model plus one turn bound the cost if a future CLI
// ever sent "/usage" to the model; a run that reports a turn or a cost
// returns `modelCall` and the provider stops renewing for good. Success is
// judged by the credentials file, never by the CLI's words: the token must now
// be unexpired.
const RENEW_TIMEOUT_MS = 120 * 1000;
function renewTokenWithCli(home, {
  resolveBin = async (env) => (await require('./model-catalog.js').resolveClaudeBinary(env))?.path || null,
  spawnImpl = require('node:child_process').spawn,
  env = process.env,
  cwdRoot,
  homedir = require('node:os').homedir(),
  readCredentials = async (dir) => JSON.parse(await fs.promises.readFile(path.join(dir, '.credentials.json'), 'utf8')),
  now = () => Date.now(),
  timeoutMs = RENEW_TIMEOUT_MS,
} = {}) {
  return (async () => {
    const bin = await resolveBin(env);
    if (!bin) return { ok: false, reason: 'the Claude CLI was not found' };
    const childEnv = { ...env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    delete childEnv.CLAUDE_CONFIG_DIR;
    // The default home is the CLI's own default (its .claude.json sits beside
    // it, not in it); every other home is named the way Harbor launches it.
    if (path.resolve(home) !== path.resolve(homedir, '.claude')) childEnv.CLAUDE_CONFIG_DIR = home;
    const cwd = path.join(cwdRoot || path.join(homedir, '.cache', 'harbor'), 'usage-renew-empty');
    await fs.promises.mkdir(cwd, { recursive: true });
    const args = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence',
      '--strict-mcp-config', '--setting-sources', '', '--tools', '', '--max-turns', '1', '--model', 'haiku'];
    const run = await new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(bin, args, { cwd, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { resolve({ error: error.message }); return; }
      let out = '';
      let err = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ error: `timed out after ${Math.round(timeoutMs / 1000)}s` }); }, timeoutMs);
      child.stdout.on('data', (chunk) => { if (out.length < 1 << 20) out += chunk; });
      child.stderr.on('data', (chunk) => { if (err.length < 1 << 16) err += chunk; });
      child.on('error', (error) => { clearTimeout(timer); resolve({ error: error.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
    if (run.error) return { ok: false, reason: run.error };
    let result = null;
    try { result = JSON.parse(run.out); } catch { /* judged below */ }
    if (result && ((result.num_turns || 0) > 0 || (result.total_cost_usd || 0) > 0)) {
      return { ok: false, modelCall: true, reason: 'the Claude CLI sent /usage to the model instead of answering it locally' };
    }
    let creds = null;
    try { creds = await readCredentials(home); } catch { /* judged below */ }
    const expiresAt = creds?.claudeAiOauth?.expiresAt;
    if (finiteNumber(expiresAt) && expiresAt > now()) return { ok: true };
    const said = String(result?.result || run.err || '').trim().split('\n')[0].slice(0, 160);
    return { ok: false, reason: `the Claude CLI exited ${run.code} without renewing it${said ? `: ${said}` : ''}` };
  })().catch((error) => ({ ok: false, reason: error.message }));
}

const RENEW_COOLDOWN_MS = 30 * 60 * 1000; // per plan, success or failure
const RENEW_CONCURRENCY = 3;

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
  const remoteWaitUntil = new Map();
  // THE LAST GOOD DIRECT READ, AND ANY 429 WAIT, ARE KEPT ON DISK (2026-11-23).
  // They lived only in this process's memory, so a Harbor restart dropped the
  // rail back to whatever the statusline file last held (two days old for
  // Claude C), and the phone server, a second process with its own provider,
  // neither saw the desktop's reads nor knew to wait. One small JSON per plan
  // under `<cacheDir>/usage-remote/`, read on every getUsage like the tee, is
  // shared by both processes and survives restarts. Opt-in by `cacheDir` (both
  // composition roots pass it) or `remoteDir`; a provider built with only a
  // `teeDir` (the unit fixtures) keeps nothing on disk.
  const remoteDir = options.remoteDir !== undefined
    ? options.remoteDir
    : options.cacheDir ? path.join(options.cacheDir, 'usage-remote') : null;
  const writeFileAtomic = options.writeFileAtomic || defaultWriteFileAtomic;
  // Renewing an idle plan's lapsed access token (renewTokenWithCli). On by
  // default only for a provider reading the real machine: the real endpoint,
  // real files, and a `cacheDir`, which only the two composition roots pass
  // (main/index.js, server/compose.js). Every fixture that injects a reader or
  // a fetcher, or names only a `teeDir`, gets none unless it passes
  // `renewLapsedToken` itself; E2E and HARBOR_NO_USAGE_FETCH pass
  // fetchRemoteUsage: null.
  const renewToken = options.renewLapsedToken !== undefined
    ? options.renewLapsedToken
    : (options.fetchRemoteUsage === undefined && !options.readFile && options.cacheDir)
      ? (home) => renewTokenWithCli(home, { cwdRoot: options.cacheDir || teeDir })
      : null;
  const renewCooldownMs = options.renewCooldownMs ?? RENEW_COOLDOWN_MS;
  const renewAttemptAt = new Map();
  const renewing = new Set();
  const renewResult = new Map();
  const renewQueue = [];
  let renewActive = 0;
  let renewDisabled = null;

  const stampMs = (sample) => {
    const parsed = sample?.updatedAt ? Date.parse(sample.updatedAt) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };

  async function readRemoteRecord(account) {
    if (!remoteDir) return null;
    try {
      const record = JSON.parse(await readFile(path.join(remoteDir, `${account}.json`), 'utf8'));
      return record && typeof record === 'object' ? record : null;
    } catch {
      return null;
    }
  }

  // Merge, never overwrite blindly: the other process may have written a
  // fresher reading or a longer wait since this one last looked.
  async function writeRemoteRecord(account, change) {
    if (!remoteDir) return;
    const current = (await readRemoteRecord(account)) || {};
    const next = { version: 1 };
    const keepCurrent = current.payload && (!change.payload || stampMs(current) > stampMs(change));
    if (keepCurrent) { next.payload = current.payload; next.updatedAt = current.updatedAt; }
    else if (change.payload) { next.payload = change.payload; next.updatedAt = change.updatedAt; }
    const waits = [current.waitUntil, change.waitUntil].filter(finiteNumber);
    // A successful read ends any wait it outlived; a newer wait always wins.
    const waitUntil = change.payload && !keepCurrent && !finiteNumber(change.waitUntil)
      ? null
      : waits.length ? Math.max(...waits) : null;
    if (waitUntil) next.waitUntil = waitUntil;
    const renewAt = [current.renewAttemptAt, change.renewAttemptAt].filter(finiteNumber);
    if (renewAt.length) next.renewAttemptAt = Math.max(...renewAt);
    try {
      await writeFileAtomic(path.join(remoteDir, `${account}.json`), JSON.stringify(next));
    } catch {
      // A failed write costs only the sharing; this process keeps its memory.
    }
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

  // One renewal per plan per cooldown, shared with the other process through
  // the store, at most RENEW_CONCURRENCY CLI runs at once. Never awaited by
  // getUsage: a run takes 5 to 35 s, and the rail's read waits on every plan.
  async function scheduleRenew(account, nowMs, stored) {
    if (typeof renewToken !== 'function' || renewDisabled || renewing.has(account)) return;
    const last = Math.max(renewAttemptAt.get(account) || 0, finiteNumber(stored?.renewAttemptAt) ? stored.renewAttemptAt : 0);
    if (nowMs - last < renewCooldownMs) return;
    renewAttemptAt.set(account, nowMs);
    renewing.add(account);
    await writeRemoteRecord(account, { renewAttemptAt: nowMs });
    renewQueue.push(account);
    pumpRenewals();
  }
  function pumpRenewals() {
    while (renewActive < RENEW_CONCURRENCY && renewQueue.length) {
      const account = renewQueue.shift();
      renewActive += 1;
      Promise.resolve(renewToken(homes[account]))
        .catch((error) => ({ ok: false, reason: error?.message || 'renewal failed' }))
        .then((result) => {
          renewResult.set(account, result || { ok: false, reason: 'renewal failed' });
          if (result?.modelCall) renewDisabled = result.reason;
          // A renewed token is read on the very next getUsage, not after the
          // endpoint cooldown the lapsed attempt started.
          if (result?.ok) { lastRemoteAttempt.delete(account); remoteUnavailable.delete(account); }
        })
        .finally(() => { renewing.delete(account); renewActive -= 1; pumpRenewals(); });
    }
  }

  return {
    // Settles once every queued renewal has finished (tests and probes).
    async settleRenewals() {
      while (renewing.size) await new Promise((resolve) => setTimeout(resolve, 5));
    },

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
      const stored = await readRemoteRecord(account);
      let remote = remoteSamples.get(account);
      if (stored?.payload && (!remote || stampMs(stored) > stampMs(remote))) {
        remote = { payload: stored.payload, updatedAt: stored.updatedAt };
        remoteSamples.set(account, remote);
      }
      if (remote && (!chosen || stampMs(remote) > stampMs(chosen))) {
        chosen = { payload: remote.payload, updatedAt: remote.updatedAt, email };
      }
      const waitUntil = Math.max(remoteWaitUntil.get(account) || 0, finiteNumber(stored?.waitUntil) ? stored.waitUntil : 0);

      const age = chosen ? nowMs - stampMs(chosen) : Infinity;
      if (age > staleAfterMs && typeof fetchRemoteUsage === 'function'
        && nowMs >= waitUntil
        && nowMs - (lastRemoteAttempt.get(account) || 0) >= remoteCooldownMs) {
        lastRemoteAttempt.set(account, nowMs);
        const fetched = await Promise.resolve(fetchRemoteUsage(homes[account])).catch(() => null);
        if (fetched?.unavailable) remoteUnavailable.set(account, fetched);
        if (fetched?.tokenLapsed) await scheduleRenew(account, nowMs, stored);
        if (finiteNumber(fetched?.retryAfterMs)) {
          const until = nowMs + fetched.retryAfterMs;
          remoteWaitUntil.set(account, until);
          await writeRemoteRecord(account, { waitUntil: until });
        }
        if (fetched?.payload) {
          remoteUnavailable.delete(account);
          remoteWaitUntil.delete(account);
          remoteSamples.set(account, fetched);
          chosen = { payload: fetched.payload, updatedAt: fetched.updatedAt, email };
          await writeRemoteRecord(account, { payload: fetched.payload, updatedAt: fetched.updatedAt });
        }
      }

      if (!chosen) return { ...(remoteUnavailable.get(account) || { unavailable: true, reason: NO_SAMPLE_REASON }), email };
      const result = usageFromStatuslinePayload(chosen.payload, {
        email: chosen.email || email,
        updatedAt: chosen.updatedAt,
        nowMs,
      });
      if (result.unavailable || nowMs - stampMs(chosen) <= SHOWN_STALE_MS) return result;
      // Old enough that the number is only a floor: say so, and say why no
      // newer reading exists, so the meter never passes for current.
      const activeWait = Math.max(remoteWaitUntil.get(account) || 0, waitUntil);
      result.stale = true;
      if (renewing.has(account)) {
        result.staleReason = 'Harbor is renewing this idle plan\'s sign-in through the Claude CLI (no usage cost); the live reading follows within a minute';
      } else if (activeWait > nowMs) {
        result.staleReason = 'Claude\'s usage service asked Harbor to pause reads for this plan (HTTP 429)';
        result.nextReadAt = new Date(activeWait).toISOString();
      } else if (typeof fetchRemoteUsage !== 'function') {
        result.staleReason = 'This Harbor does not read Claude\'s usage service';
      } else if (renewResult.get(account) && !renewResult.get(account).ok) {
        result.staleReason = `Harbor could not renew this idle plan's sign-in through the Claude CLI: ${renewResult.get(account).reason}`;
      } else if (remoteUnavailable.get(account)?.reason) {
        result.staleReason = remoteUnavailable.get(account).reason;
      }
      return result;
    },
  };
}

// tmp + rename, so a reader in the other process never sees half a file; the
// tmp is removed when the rename fails, so a failed write leaves nothing
// behind (the statusline tee's leftover `.tmp-*` files are that lesson).
async function defaultWriteFileAtomic(file, text) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  MISSING_FIELDS_REASON,
  NO_SAMPLE_REASON,
  NOT_CLAUDE_REASON,
  STALE_AFTER_MS,
  REMOTE_COOLDOWN_MS,
  SHOWN_STALE_MS,
  DEFAULT_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  createUsageProvider,
  fetchOauthUsage,
  keychainServicesFor,
  parseRetryAfter,
  renewTokenWithCli,
  RENEW_COOLDOWN_MS,
  usageFromStatuslinePayload,
};
