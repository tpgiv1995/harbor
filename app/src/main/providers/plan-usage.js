'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const STALE_MS = 180_000;
const COOLDOWN_MS = 60_000;
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_RESETS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CURSOR_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const TAIL_BYTES = 512 * 1024;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const stamp = (s) => Date.parse(s) || 0;
const hash = (s) => createHash('sha256').update(s).digest('hex');

function jwtClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {};
  } catch {
    return {};
  }
}

function windowsFromLimits(limits, nowMs, endpoint = false) {
  return [endpoint ? limits?.primary_window : limits?.primary, endpoint ? limits?.secondary_window : limits?.secondary]
    .filter(Boolean).map((w) => {
      const minutes = endpoint ? w.limit_window_seconds / 60 : w.window_minutes;
      const reset = w.reset_at ?? w.resets_at;
      const rolled = finite(reset) && reset < nowMs / 1000;
      let kind = 'other';
      if (minutes === 300) kind = 'fiveHour';
      else if (minutes === 10080) kind = 'weekly';
      let usedPct = finite(w.used_percent) ? w.used_percent : null;
      let resetsAt = finite(reset) ? reset : null;
      if (rolled) {
        usedPct = 0;
        resetsAt = null;
      }
      return {
        kind,
        windowMinutes: finite(minutes) ? minutes : null,
        usedPct,
        resetsAt,
        rolled,
      };
    }).filter((w) => w.usedPct !== null)
    .sort((a, b) => (a.windowMinutes || Infinity) - (b.windowMinutes || Infinity));
}

// The dropdown's name for a codex home: `.codex` is Default, `.codex-work` is
// Work. bin/harbor-lean names seats with the same function.
function codexHomeLabel(dir) {
  const name = path.basename(dir);
  const derived = name === '.codex' ? 'Default' : name.replace(/^\.codex-/, '');
  return derived.charAt(0).toUpperCase() + derived.slice(1);
}

async function discoverCodexHomes({ io, home, env, profiles, platform }) {
  const candidates = [
    path.join(home, '.codex'),
    env.CODEX_HOME,
    ...profiles.filter((p) => p.provider === 'codex').map((p) => p.configHome),
  ];
  try {
    for (const name of await io.readdir(home)) {
      if (/^\.codex(-[\w.-]+)?$/.test(name)) candidates.push(path.join(home, name));
    }
  } catch { /* configured homes still work when discovery is refused */ }
  const seen = new Set();
  const homes = [];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const resolved = await io.realpath(candidate);
      const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seen.has(key) || !(await io.stat(resolved)).isDirectory()) continue;
      const valid = await Promise.all(['auth.json', 'sessions'].map(async (name) => {
        try {
          const s = await io.stat(path.join(resolved, name));
          return name === 'sessions' ? s.isDirectory() : s.isFile();
        } catch {
          return false;
        }
      }));
      if (!valid.some(Boolean)) continue;
      seen.add(key);
      homes.push(resolved);
    } catch { /* missing configured homes are not plans */ }
  }
  return homes;
}

// Date directories only, no general recursive scan or transcript heads.
// Include resumed old rollouts by sorting their modification times.
async function newestRollouts(home, io) {
  const files = [];
  async function visit(dir, depth) {
    let entries;
    try {
      entries = await io.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (depth < 3 && entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        await visit(file, depth + 1);
      } else if (depth === 3 && entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try {
          files.push({ file, mtime: (await io.stat(file)).mtimeMs });
        } catch { /* disappeared */ }
      }
    }
  }
  await visit(path.join(home, 'sessions'), 0);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, 8);
}

async function readRolloutSample(home, io, nowMs) {
  let newest = null;
  for (const { file } of await newestRollouts(home, io)) {
    let handle;
    try {
      handle = await io.open(file, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const bytes = Buffer.alloc(Math.min(size, TAIL_BYTES));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      let tail = bytes.subarray(0, bytesRead).toString('utf8');
      if (start) tail = tail.slice(tail.indexOf('\n') + 1);
      for (const line of tail.split('\n')) {
        if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
        try {
          const e = JSON.parse(line);
          const limits = e.payload?.rate_limits;
          if (e.type !== 'event_msg' || e.payload?.type !== 'token_count' || !limits
            || (limits.limit_id && limits.limit_id !== 'codex')) continue;
          const windows = windowsFromLimits(limits, nowMs);
          if (!windows.length || !stamp(e.timestamp) || (newest && stamp(newest.updatedAt) >= stamp(e.timestamp))) continue;
          newest = {
            windows,
            planType: typeof limits.plan_type === 'string' ? limits.plan_type : null,
            source: 'rollout',
            updatedAt: e.timestamp,
          };
        } catch { /* truncated or malformed event */ }
      }
    } catch { /* a live rollout can disappear between list and read */ }
    finally {
      try {
        await handle?.close();
      } catch { /* a close failure must not hide the other plans */ }
    }
  }
  return newest;
}

function resetCredits(body, nowMs) {
  if (!Number.isSafeInteger(body?.available_count) || body.available_count < 0) return null;
  const expiries = (Array.isArray(body.credits) ? body.credits : [])
    .filter((c) => c?.status === 'available').map((c) => stamp(c.expires_at) / 1000)
    .filter((s) => s > nowMs / 1000);
  return {
    available: body.available_count,
    nextExpiresAt: body.available_count && expiries.length ? Math.min(...expiries) : null,
  };
}

function cursorWindow(body) {
  const p = body?.planUsage;
  if (!p) return null;
  let pct = null;
  if (finite(p.totalPercentUsed)) pct = p.totalPercentUsed;
  else if (finite(p.includedSpend) && finite(p.limit) && p.limit > 0) pct = p.includedSpend / p.limit * 100;
  if (pct === null) return null;
  const endMs = Number(body.billingCycleEnd);
  return {
    kind: 'monthly',
    usedPct: pct,
    includedPct: pct,
    autoPct: finite(p.autoPercentUsed) ? p.autoPercentUsed : null,
    apiPct: finite(p.apiPercentUsed) ? p.apiPercentUsed : null,
    resetsAt: endMs > 0 && Number.isFinite(endMs) ? endMs / 1000 : null,
    windowMinutes: null,
    used: finite(p.includedSpend) ? p.includedSpend / 100 : null,
    limit: finite(p.limit) ? p.limit / 100 : null,
    unit: 'USD',
  };
}

function cursorAuthFile(home, env, platform) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
  if (platform === 'darwin') return path.join(home, '.cursor', 'auth.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cursor', 'auth.json');
}

// Cache the promise before starting work so overlapping callers share the
// pending read as well as its answer. No caller can observe an empty result.
function createRequestCache(now) {
  const entries = new Map();
  return async function cachedRequest(key, identity, request) {
    const prior = entries.get(key);
    if (prior && now() - prior.at < COOLDOWN_MS) {
      if (prior.identity !== identity) {
        return { value: null, reason: 'CLI sign-in changed; retry after the one-minute cooldown.' };
      }
      return prior.result;
    }
    const result = Promise.resolve().then(request);
    entries.set(key, { at: now(), identity, result });
    return result;
  };
}

function createPlanUsageProvider({
  usageProvider,
  profiles = [],
  io = fs.promises,
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let flight;
  const cachedRequest = createRequestCache(now);
  const offline = env.HARBOR_E2E === '1' || env.HARBOR_NO_USAGE_FETCH === '1';

  async function readJson(file) {
    try {
      return JSON.parse(await io.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function tokenReason(token, provider) {
    if (offline) return 'Online usage checks are disabled.';
    if (typeof token !== 'string' || !token) return 'No CLI access token is available.';
    const exp = jwtClaims(token).exp;
    if (finite(exp) && exp * 1000 <= now()) return `Login token expired; it refreshes the next time ${provider} runs.`;
    return null;
  }

  // Credentials go only to fixed provider routes. Refuse redirects so neither
  // the bearer token nor the account header can travel to another host.
  async function request(url, token, accountId, normalize) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimer(() => {
        controller.abort();
        resolve({ value: null, reason: 'Usage endpoint timed out after 10 seconds.' });
      }, 10_000);
    });
    const operation = (async () => {
      try {
        const headers = { authorization: `Bearer ${token}` };
        const options = { method: 'GET', headers, signal: controller.signal, redirect: 'error' };
        if (url === CURSOR_USAGE_URL) {
          options.method = 'POST';
          options.body = '{}';
          headers['content-type'] = 'application/json';
          headers['connect-protocol-version'] = '1';
          headers['x-cursor-client-type'] = 'cli';
        } else {
          headers['user-agent'] = 'codex-cli';
          if (accountId) headers['ChatGPT-Account-Id'] = accountId;
        }
        const response = await fetchImpl(url, options);
        if (!response.ok) {
          const status = Number.isInteger(response.status) ? ` (HTTP ${response.status})` : '';
          return { value: null, reason: `Usage endpoint refused the read${status}.` };
        }
        const value = normalize(await response.json(), now());
        return { value, reason: value ? null : 'Usage endpoint returned no readable plan data.' };
      } catch {
        // Response text and exception messages can contain credentials.
        return { value: null, reason: 'Usage endpoint could not be read.' };
      }
    })();
    try {
      return await Promise.race([deadline, operation]);
    } finally {
      clearTimer(timer);
    }
  }

  async function remote(key, url, token, accountId, normalize) {
    const reason = tokenReason(token, url === CURSOR_USAGE_URL ? 'cursor' : 'codex');
    if (reason) return { value: null, reason };
    const identity = hash(`${token}\0${accountId || ''}`);
    return cachedRequest(key, identity, () => request(url, token, accountId, normalize));
  }

  function endpointSample(body, time) {
    const windows = windowsFromLimits(body?.rate_limit, time, true);
    if (!windows.length) return null;
    return {
      windows,
      planType: typeof body.plan_type === 'string' ? body.plan_type : null,
      source: 'endpoint',
      updatedAt: new Date(time).toISOString(),
    };
  }

  async function codexPlan(dir, time, sharedStore = false) {
    const auth = await readJson(path.join(dir, 'auth.json'));
    const claims = jwtClaims(auth?.tokens?.id_token);
    const token = auth?.tokens?.access_token;
    const accountId = typeof auth?.tokens?.account_id === 'string' ? auth.tokens.account_id : null;
    // A sessions store shared by two Codex homes (one account's `sessions` linked to
    // another's, so the rail shows every account's history) holds rollouts from BOTH
    // logins, and a rollout's rate_limits name no account. Sampling it would show
    // whichever account ran last under every plan, so a shared store is never sampled:
    // each plan asks the usage endpoint with its own token instead.
    let sample = sharedStore ? null : await readRolloutSample(dir, io, time);
    const needsUsage = !sample || time - stamp(sample.updatedAt) > STALE_MS;
    const [usage, credits] = await Promise.all([
      needsUsage ? remote(`${dir}:usage`, CODEX_USAGE_URL, token, accountId, endpointSample) : null,
      remote(`${dir}:resets`, CODEX_RESETS_URL, token, accountId, resetCredits),
    ]);
    if (usage?.value && (!sample || stamp(usage.value.updatedAt) >= stamp(sample.updatedAt))) sample = usage.value;
    let resets = credits.value;
    let resetsReason = credits.reason;
    // The cached count is authoritative only until its first known expiry.
    // A minimum expiry alone cannot tell us how many credits have expired.
    if (resets?.nextExpiresAt && resets.nextExpiresAt <= now() / 1000) {
      resets = null;
      resetsReason = 'Cached reset credits have expired; refresh after the one-minute cooldown.';
    }
    const stale = !!sample && now() - stamp(sample.updatedAt) > STALE_MS;
    // Cached windows can expire during the cooldown too.
    const windows = (sample?.windows || []).map((window) => {
      if (finite(window.resetsAt) && window.resetsAt < now() / 1000) {
        return { ...window, usedPct: 0, resetsAt: null, rolled: true };
      }
      return window;
    });
    let reason = usage?.reason || null;
    if (!sample && !reason) reason = 'No readable Codex usage sample.';
    if (stale && !reason) reason = 'Usage sample is older than three minutes.';
    return {
      provider: 'codex',
      id: `codex:${hash(dir).slice(0, 16)}`,
      label: codexHomeLabel(dir),
      email: typeof claims.email === 'string' ? claims.email : null,
      planType: sample?.planType || null,
      windows,
      resets,
      resetsReason,
      source: sample?.source || null,
      updatedAt: sample?.updatedAt || null,
      stale,
      unavailable: !sample,
      reason,
    };
  }

  async function cursorPlan() {
    const file = cursorAuthFile(home, env, platform);
    const auth = await readJson(file);
    const token = auth?.accessToken;
    const claims = jwtClaims(token);
    const result = await remote(`cursor:${file}`, CURSOR_USAGE_URL, token, null, (body, time) => {
      const window = cursorWindow(body);
      if (!window) return null;
      return {
        windows: [window],
        email: typeof body.email === 'string' ? body.email : null,
        updatedAt: new Date(time).toISOString(),
      };
    });
    const sample = result.value;
    const email = sample?.email || (typeof claims.email === 'string' ? claims.email : null);
    return {
      provider: 'cursor',
      id: 'cursor:default',
      label: 'Cursor',
      email,
      planType: null,
      windows: sample?.windows || [],
      resets: null,
      source: sample ? 'endpoint' : null,
      updatedAt: sample?.updatedAt || null,
      unavailable: !sample,
      reason: result.reason,
    };
  }
  async function collect() {
    if (env.HARBOR_PLAN_USAGE_FIXTURE) {
      const fixture = await readJson(env.HARBOR_PLAN_USAGE_FIXTURE);
      if (!Array.isArray(fixture?.plans) || !fixture.plans.every((p) => p && ['claude', 'codex', 'cursor'].includes(p.provider)
        && typeof p.id === 'string' && typeof p.label === 'string' && Array.isArray(p.windows)
        && p.windows.every((w) => w && typeof w.kind === 'string' && (w.usedPct == null || finite(w.usedPct))))) {
        throw new Error('Plan usage fixture is unreadable or invalid.');
      }
      return fixture;
    }
    const time = now();
    // Share the existing provider's independent per-account timeout budget.
    const plans = Promise.all(profiles.filter((p) => !p.provider || p.provider === 'claude').map(async (p) => {
      let sample;
      try {
        sample = await usageProvider.getUsage(p.id);
      } catch {
        sample = { unavailable: true, reason: 'Claude usage could not be read.' };
      }
      const windows = [['fiveHour', 300], ['weekly', 10080]]
        .filter(([kind]) => finite(sample?.[`${kind}Pct`]))
        .map(([kind, windowMinutes]) => ({
          kind,
          windowMinutes,
          usedPct: sample[`${kind}Pct`],
          resetsAt: sample[`${kind}ResetsAt`] || null,
          rolled: !!sample[`${kind}Rolled`],
        }));
      let reason = sample?.reason || null;
      if (!reason) {
        if (!windows.length) reason = 'No Claude plan windows reported.';
        else if (!stamp(sample.updatedAt)) reason = 'Usage sample has no timestamp.';
        else if (time - stamp(sample.updatedAt) > STALE_MS) reason = 'Usage sample is older than three minutes.';
      }
      return {
        provider: 'claude',
        id: p.id,
        label: p.label || p.id,
        email: sample?.email || null,
        planType: null,
        windows,
        resets: null,
        source: 'claude-usage',
        updatedAt: sample?.updatedAt || null,
        stale: !!windows.length && (!stamp(sample?.updatedAt) || time - stamp(sample.updatedAt) > STALE_MS),
        unavailable: !windows.length,
        reason,
      };
    }));
    const homes = await discoverCodexHomes({ io, home, env, profiles, platform });
    const stores = await Promise.all(homes.map(async (dir) => {
      try {
        const store = await io.realpath(path.join(dir, 'sessions'));
        return platform === 'win32' ? store.toLowerCase() : store;
      } catch {
        return null;
      }
    }));
    const shared = (store) => !!store && stores.filter((other) => other === store).length > 1;
    const [claudePlans, codexPlans, cursor] = await Promise.all([
      plans,
      Promise.all(homes.map((dir, index) => codexPlan(dir, time, shared(stores[index])))),
      cursorPlan(),
    ]);
    return { generatedAt: new Date(now()).toISOString(), plans: [...claudePlans, ...codexPlans, cursor] };
  }
  return {
    // Cursor alone, for bin/harbor-lean's mechanical-work route: one read-only
    // request to Cursor's own usage endpoint, no Claude or Codex reads.
    async getCursorPlan() {
      if (env.HARBOR_PLAN_USAGE_FIXTURE) return (await collect()).plans.find((p) => p.provider === 'cursor') || null;
      return cursorPlan();
    },
    getPlans() {
      if (!flight) {
        flight = collect().finally(() => {
          flight = null;
        });
      }
      return flight;
    },
  };
}

module.exports = { createPlanUsageProvider, createRequestCache, codexHomeLabel, discoverCodexHomes, readRolloutSample, windowsFromLimits, jwtClaims, resetCredits, cursorWindow, cursorAuthFile, TAIL_BYTES };
