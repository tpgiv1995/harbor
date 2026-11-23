'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPlanUsageProvider, createRequestCache } = require('../../src/main/providers/plan-usage.js');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const USAGE = 'https://chatgpt.com/backend-api/wham/usage';
const RESETS = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CURSOR = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const FIXTURES = path.resolve(__dirname, '../../../_astra/plan-usage-test-fixtures');

function jwt(claims) {
  return `synthetic.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

function endpointBody(pct = 73) {
  return {
    plan_type: 'example-plan',
    rate_limit: {
      primary_window: { used_percent: pct, limit_window_seconds: 604800, reset_at: NOW / 1000 + 3600 },
      secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: NOW / 1000 + 600 },
    },
  };
}

function fixture(t) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURES, 'network-'));
  const calls = [];
  const unexpected = [];
  const secrets = [];
  let time = NOW;
  let dispatch = () => { throw Error('Unexpected fetch'); };
  const put = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const codex = (name = '.codex', exp = NOW / 1000 + 3600) => {
    const token = jwt({ sub: name, exp });
    const accountId = `synthetic-account-${name}`;
    secrets.push(token, accountId);
    put(`${name}/auth.json`, { tokens: { access_token: token, account_id: accountId } });
    return { token, accountId };
  };
  const cursor = (exp = NOW / 1000 + 3600, { apiKey } = {}) => {
    const token = jwt({ email: 'token@example.com', exp });
    secrets.push(token);
    if (apiKey) secrets.push(apiKey);
    put('AppData/Roaming/Cursor/auth.json', { accessToken: token, refreshToken: token, ...(apiKey ? { apiKey } : {}) });
    return token;
  };
  const local = (name = '.codex', age = 60_000, pct = 28) => {
    put(`${name}/sessions/2026/10/01/rollout-synthetic.jsonl`, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(time - age).toISOString(),
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: pct, window_minutes: 10080, resets_at: NOW / 1000 + 3600 },
        },
      },
    }));
  };
  const provider = (overrides = {}) => createPlanUsageProvider({
    home: root,
    io: fs.promises,
    env: {},
    platform: 'win32',
    now: () => time,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      try {
        return await dispatch(url, options);
      } catch (error) {
        // The provider sanitizes thrown errors, so preserve assertion failures
        // outside it as well. Intentional transport errors are returned below.
        if (error.code === 'ERR_ASSERTION' || error.message === 'Unexpected fetch') unexpected.push(error);
        throw error;
      }
    },
    ...overrides,
  });
  const clean = (result) => {
    const serialized = JSON.stringify(result);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false, 'credential leaked into a normalized result');
  };
  t.after(() => {
    const target = path.resolve(root);
    assert.ok(target.startsWith(`${FIXTURES}${path.sep}`));
    fs.rmSync(target, { recursive: true, force: true });
    assert.deepEqual(unexpected, [], 'unexpected fetch or failed request assertion was swallowed');
  });
  return {
    calls, secrets, put, codex, cursor, local, provider, clean, root,
    dispatch(fn) { dispatch = fn; },
    advance(ms) { time += ms; },
  };
}

function plan(result, kind = 'codex', label) {
  return result.plans.find((row) => row.provider === kind && (!label || row.label === label));
}

test('plan-usage-network replaces stale or missing Codex samples through fixed read routes', async (t) => {
  for (const hasLocal of [true, false]) {
    await t.test(hasLocal ? 'stale sample' : 'missing sample', async (subtest) => {
      const f = fixture(subtest);
      const auth = f.codex('.codex-extra');
      if (hasLocal) f.local('.codex-extra', 180_001);
      f.dispatch((url, options) => {
        assert.ok([USAGE, RESETS].includes(url));
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        assert.equal(options.body, undefined);
        assert.equal(options.headers.authorization, `Bearer ${auth.token}`);
        assert.equal(options.headers['ChatGPT-Account-Id'], auth.accountId);
        assert.equal(options.headers['user-agent'], 'codex-cli');
        assert.deepEqual(Object.keys(options.headers).sort(), ['ChatGPT-Account-Id', 'authorization', 'user-agent']);
        assert.ok(options.signal instanceof AbortSignal);
        return response(url === USAGE ? endpointBody() : { available_count: 2, credits: [] });
      });
      const result = await f.provider().getPlans();
      const row = plan(result);
      assert.equal(row.label, 'Extra');
      assert.equal(row.source, 'endpoint');
      assert.equal(row.stale, false);
      assert.equal(row.unavailable, false);
      assert.equal(row.updatedAt, new Date(NOW).toISOString());
      assert.deepEqual(row.windows.map((w) => [w.kind, w.usedPct]), [['fiveHour', 12], ['weekly', 73]]);
      assert.deepEqual(row.resets, { available: 2, nextExpiresAt: null });
      assert.deepEqual(f.calls.map((call) => call.url).sort(), [USAGE, RESETS].sort());
      f.clean(result);
    });
  }
});

test('plan-usage-network keeps fresh local usage and only reads reset credits', async (t) => {
  const f = fixture(t);
  f.codex();
  f.local();
  f.dispatch((url) => {
    assert.equal(url, RESETS);
    return response({ available_count: 0 });
  });
  const result = await f.provider().getPlans();
  assert.equal(plan(result).source, 'rollout');
  assert.equal(plan(result).windows[0].usedPct, 28);
  assert.deepEqual(plan(result).resets, { available: 0, nextExpiresAt: null });
  assert.equal(f.calls.length, 1);
  f.clean(result);
});

// bin/harbor-lean's read (2026-10-13): the dropdown's Codex reads and reset
// credits, no Claude or Cursor request, and each plan names its home there only.
test('plan-usage-network getCodexPlans reads only Codex, with resets, and names each home', async (t) => {
  const f = fixture(t);
  f.codex('.codex');
  f.codex('.codex-extra');
  f.local('.codex', 600_000, 91);
  f.cursor();
  f.dispatch((url) => {
    assert.ok([USAGE, RESETS].includes(url), url);
    return response(url === USAGE ? endpointBody(97) : { available_count: 1, credits: [{ id: 'c1', status: 'available', expires_at: new Date(NOW + 86_400_000).toISOString() }] });
  });
  const claude = { getUsage: async () => assert.fail('harbor-lean never reads Claude usage') };
  const rows = await f.provider({ usageProvider: claude }).getCodexPlans();
  assert.deepEqual(rows.map((row) => [row.label, path.basename(row.home), row.windows.find((w) => w.kind === 'weekly').usedPct, row.resets.available]),
    [['Default', '.codex', 97, 1], ['Extra', '.codex-extra', 97, 1]]);
  assert.equal(rows[0].resets.nextExpiresAt, (NOW + 86_400_000) / 1000);
  assert.ok(f.calls.every((call) => call.url !== CURSOR));
  f.clean(rows);
  // The dropdown payload keeps no home path.
  f.dispatch((url) => {
    if (url === CURSOR) return response({ planUsage: { totalPercentUsed: 1 } });
    return response(url === USAGE ? endpointBody(97) : { available_count: 0 });
  });
  f.advance(61_000);
  const plans = (await f.provider({ usageProvider: { getUsage: async () => ({}) } }).getPlans()).plans;
  assert.ok(plans.filter((row) => row.provider === 'codex').every((row) => !('home' in row)));
});

test('plan-usage-network skips expired access tokens for both providers without refreshing them', async (t) => {
  const f = fixture(t);
  f.codex('.codex', NOW / 1000);
  f.cursor(NOW / 1000 - 1);
  f.local('.codex', 240_000);
  const result = await f.provider().getPlans();
  assert.equal(f.calls.length, 0);
  assert.equal(plan(result).windows[0].usedPct, 28);
  assert.equal(plan(result).reason, 'Login token expired; it refreshes the next time codex runs.');
  assert.equal(plan(result).resetsReason, 'Login token expired; it refreshes the next time codex runs.');
  // A browser sign-in (no API key) never renews itself, so Cursor reads as
  // signed out with the day it ended, not as something the next run fixes.
  const row = plan(result, 'cursor');
  assert.equal(row.reason, 'Cursor is signed out: its sign-in expired on 2026-10-01 and does not renew itself. Sign in again with cursor-agent login.');
  assert.equal(row.signedOut, true);
  assert.equal(row.unavailable, true);
  assert.equal(row.signInNotice, null);
  f.clean(result);
});

// An API-key sign-in's tokens last one hour and cursor-agent renews them only
// while it runs, so Harbor trades the key itself (2026-10-13), the way
// cursor-agent does, and keeps the traded token in memory only.
const EXCHANGE = 'https://api2.cursor.sh/auth/exchange_user_api_key';

test('plan-usage-network trades a stored Cursor API key when the stored token is stale', async (t) => {
  const f = fixture(t);
  const apiKey = 'synthetic-cursor-api-key';
  f.cursor(NOW / 1000 - 1, { apiKey });
  const traded = `synthetic.${Buffer.from(JSON.stringify({ exp: NOW / 1000 + 3600, type: 'api_key_token' })).toString('base64url')}.traded`;
  f.secrets.push(traded);
  f.dispatch((url, options) => {
    if (url === EXCHANGE) {
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, '{}');
      assert.deepEqual(options.headers, { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' });
      return response({ accessToken: traded, refreshToken: traded });
    }
    assert.equal(url, CURSOR);
    assert.equal(options.headers.authorization, `Bearer ${traded}`);
    return response({ planUsage: { totalPercentUsed: 4 } });
  });
  const usage = { getUsage: async () => ({}) };
  const provider = f.provider({ usageProvider: usage });
  const first = await provider.getPlans();
  const row = plan(first, 'cursor');
  assert.equal(row.unavailable, false);
  assert.equal(row.signedOut, false);
  assert.equal(row.windows[0].usedPct, 4);
  assert.deepEqual(f.calls.map((c) => c.url), [EXCHANGE, CURSOR]);
  f.clean(first);
  // Past the cooldown, the same provider reuses the traded token: no new exchange,
  // and a new token for the same key is not "sign-in changed".
  f.advance(61_000);
  const second = await provider.getPlans();
  assert.equal(plan(second, 'cursor').windows[0].usedPct, 4);
  assert.deepEqual(f.calls.map((c) => c.url), [EXCHANGE, CURSOR, CURSOR]);
  f.clean(second);
});

test('plan-usage-network uses a still-valid Cursor API-key token without trading the key', async (t) => {
  const f = fixture(t);
  const token = f.cursor(NOW / 1000 + 3000, { apiKey: 'synthetic-cursor-api-key' });
  f.dispatch((url, options) => {
    assert.equal(url, CURSOR);
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    return response({ planUsage: { totalPercentUsed: 4 } });
  });
  const row = plan(await f.provider({ usageProvider: { getUsage: async () => ({}) } }).getPlans(), 'cursor');
  assert.equal(row.windows[0].usedPct, 4);
  assert.equal(row.signInNotice, null);
  assert.deepEqual(f.calls.map((c) => c.url), [CURSOR]);
});

test('plan-usage-network reads a refused Cursor API key as signed out', async (t) => {
  const f = fixture(t);
  f.cursor(NOW / 1000 - 1, { apiKey: 'synthetic-cursor-api-key' });
  f.dispatch((url) => {
    assert.equal(url, EXCHANGE);
    return { ok: false, status: 401, json: async () => ({}) };
  });
  const result = await f.provider({ usageProvider: { getUsage: async () => ({}) } }).getPlans();
  const row = plan(result, 'cursor');
  assert.equal(row.unavailable, true);
  assert.equal(row.signedOut, true);
  assert.match(row.reason, /^Cursor refused its stored API key \(HTTP 401\)/);
  assert.deepEqual(f.calls.map((c) => c.url), [EXCHANGE]);
  f.clean(result);
});

test('plan-usage-network never trades a Cursor API key while usage checks are off', async (t) => {
  const f = fixture(t);
  f.cursor(NOW / 1000 - 1, { apiKey: 'synthetic-cursor-api-key' });
  const row = plan(await f.provider({ env: { HARBOR_NO_USAGE_FETCH: '1' }, usageProvider: { getUsage: async () => ({}) } }).getPlans(), 'cursor');
  assert.equal(f.calls.length, 0);
  assert.match(row.reason, /disabled/);
});

test('plan-usage-network warns in the last week of a Cursor browser sign-in, and only then', async (t) => {
  for (const [days, warned] of [[8, false], [6.5, true]]) {
    await t.test(`${days} days left`, async (subtest) => {
      const f = fixture(subtest);
      const exp = NOW / 1000 + days * 86_400;
      f.cursor(exp);
      f.dispatch((url) => {
        assert.equal(url, CURSOR);
        return response({ planUsage: { totalPercentUsed: 2 } });
      });
      const result = await f.provider({ usageProvider: { getUsage: async () => ({}) } }).getPlans();
      const row = plan(result, 'cursor');
      assert.equal(row.unavailable, false);
      assert.equal(row.signedOut, false);
      assert.equal(row.signInExpiresAt, exp);
      assert.equal(row.signInNotice, warned
        ? `Cursor's sign-in ends on ${new Date(exp * 1000).toISOString().slice(0, 10)} and does not renew itself. Sign in again before then with cursor-agent login.`
        : null);
      f.clean(result);
    });
  }
});

test('plan-usage-network both kill switches disable every authenticated read', async (t) => {
  for (const flag of ['HARBOR_E2E', 'HARBOR_NO_USAGE_FETCH']) {
    await t.test(flag, async (subtest) => {
      const f = fixture(subtest);
      f.codex();
      f.cursor();
      f.local('.codex', 240_000);
      const result = await f.provider({ env: { [flag]: '1' } }).getPlans();
      assert.equal(f.calls.length, 0);
      assert.equal(plan(result).source, 'rollout');
      assert.match(plan(result).reason, /disabled/);
      assert.match(plan(result).resetsReason, /disabled/);
      assert.match(plan(result, 'cursor').reason, /disabled/);
      f.clean(result);
    });
  }
});

test('plan-usage-network HTTP failures preserve local data and never read credential-bearing error bodies', async (t) => {
  const f = fixture(t);
  f.codex();
  f.local('.codex', 240_000);
  f.dispatch((url) => {
    assert.ok([USAGE, RESETS].includes(url));
    return {
      ok: false,
      status: 401,
      json() { assert.fail('Must not read failed response bodies'); },
      text() { assert.fail('Must not read failed response text'); },
    };
  });
  const result = await f.provider().getPlans();
  assert.equal(plan(result).source, 'rollout');
  assert.equal(plan(result).stale, true);
  assert.equal(plan(result).windows[0].usedPct, 28);
  assert.match(plan(result).reason, /HTTP 401/);
  assert.match(plan(result).resetsReason, /HTTP 401/);
  assert.equal(plan(result).resets, null);
  f.clean(result);
});

test('plan-usage-network sanitizes thrown transport and JSON errors for both providers', async (t) => {
  const f = fixture(t);
  const { token } = f.codex();
  const cursorToken = f.cursor();
  f.local('.codex', 240_000);
  f.dispatch((url) => {
    assert.ok([USAGE, RESETS, CURSOR].includes(url));
    if (url === RESETS) return { ok: true, json: async () => { throw Error(`invalid JSON ${token}`); } };
    return Promise.reject(Error(`request authorization: Bearer ${url === CURSOR ? cursorToken : token}`));
  });
  const result = await f.provider().getPlans();
  assert.equal(plan(result).source, 'rollout');
  assert.equal(plan(result).reason, 'Usage endpoint could not be read.');
  assert.equal(plan(result).resetsReason, 'Usage endpoint could not be read.');
  assert.equal(plan(result, 'cursor').reason, 'Usage endpoint could not be read.');
  assert.equal(plan(result, 'cursor').unavailable, true);
  f.clean(result);
});

test('plan-usage-network ten-second deadline covers fetch and response-body reads', async (t) => {
  for (const stage of ['fetch', 'body']) {
    await t.test(stage, async (subtest) => {
      const f = fixture(subtest);
      f.codex();
      f.local('.codex', 240_000);
      const active = new Set();
      let ready;
      const started = new Promise((resolve) => { ready = resolve; });
      let signal;
      f.dispatch((url, options) => {
        assert.ok([USAGE, RESETS].includes(url));
        if (url === RESETS) return response({ available_count: 0 });
        signal = options.signal;
        if (stage === 'fetch') {
          ready();
          return new Promise(() => {});
        }
        return { ok: true, json: () => { ready(); return new Promise(() => {}); } };
      });
      const provider = f.provider({
        setTimer(callback, delay) {
          assert.equal(delay, 10_000);
          active.add(callback);
          return callback;
        },
        clearTimer(callback) { active.delete(callback); },
      });
      const pending = provider.getPlans();
      await started;
      // Drain successful sibling requests before firing the still-active deadline.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(active.size, 1);
      [...active][0]();
      const result = await pending;
      assert.equal(signal.aborted, true);
      assert.equal(active.size, 0);
      assert.equal(plan(result).source, 'rollout');
      assert.equal(plan(result).windows[0].usedPct, 28);
      assert.match(plan(result).reason, /timed out after 10 seconds/);
      f.clean(result);
    });
  }
});

test('plan-usage-network successful usage and reset reads are cached for exactly sixty seconds', async (t) => {
  const f = fixture(t);
  f.codex();
  f.dispatch((url) => {
    assert.ok([USAGE, RESETS].includes(url));
    return response(url === USAGE ? endpointBody(f.calls.length <= 2 ? 73 : 91) : { available_count: 2 });
  });
  const provider = f.provider();
  const first = await provider.getPlans();
  f.advance(59_999);
  const cached = await provider.getPlans();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(plan(cached), plan(first));
  f.advance(1);
  const refreshed = await provider.getPlans();
  assert.equal(f.calls.length, 4);
  assert.equal(plan(refreshed).windows.find((w) => w.kind === 'weekly').usedPct, 91);
  f.clean(refreshed);
});

test('plan-usage-network failed attempts cool down independently for each Codex home', async (t) => {
  const f = fixture(t);
  const first = f.codex();
  f.local();
  f.dispatch((url, options) => {
    assert.equal(url, RESETS);
    return options.headers['ChatGPT-Account-Id'] === first.accountId
      ? { ok: false, status: 503 }
      : response({ available_count: 3 });
  });
  const provider = f.provider();
  await provider.getPlans();
  f.advance(30_000);
  f.codex('.codex-second');
  f.local('.codex-second');
  const second = await provider.getPlans();
  assert.equal(f.calls.length, 2);
  assert.match(plan(second, 'codex', 'Default').resetsReason, /HTTP 503/);
  assert.equal(plan(second, 'codex', 'Second').resets.available, 3);
  f.advance(30_000);
  await provider.getPlans();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].options.headers['ChatGPT-Account-Id'], first.accountId);
  f.advance(30_000);
  const final = await provider.getPlans();
  assert.equal(f.calls.length, 4);
  assert.notEqual(f.calls[3].options.headers['ChatGPT-Account-Id'], first.accountId);
  f.clean(final);
});

test('plan-usage-network reset expiry excludes expired and consumed credits while preserving zero', async (t) => {
  const f = fixture(t);
  f.codex();
  f.local();
  let available = 2;
  f.dispatch((url) => {
    assert.equal(url, RESETS);
    return response({
      available_count: available,
      credits: [
        null,
        { status: 'available', expires_at: new Date(NOW - 1).toISOString() },
        { status: 'consumed', expires_at: new Date(NOW + 30_000).toISOString() },
        { status: 'available', expires_at: new Date(NOW + 120_000).toISOString() },
        { status: 'available', expires_at: new Date(NOW + 240_000).toISOString() },
      ],
    });
  });
  const provider = f.provider();
  assert.deepEqual(plan(await provider.getPlans()).resets, { available: 2, nextExpiresAt: NOW / 1000 + 120 });
  available = 0;
  f.advance(60_000);
  const result = await provider.getPlans();
  assert.deepEqual(plan(result).resets, { available: 0, nextExpiresAt: null });
  assert.equal(plan(result).resetsReason, null);
  f.clean(result);
});

test('plan-usage-network invalidates expired cached credits without bypassing the cooldown', async (t) => {
  const f = fixture(t);
  f.codex();
  f.local();
  let available = 1;
  f.dispatch((url) => {
    assert.equal(url, RESETS);
    return response({
      available_count: available,
      credits: [{ status: 'available', expires_at: new Date(NOW + 10_000).toISOString() }],
    });
  });
  const provider = f.provider();
  assert.deepEqual(plan(await provider.getPlans()).resets, {
    available: 1, nextExpiresAt: NOW / 1000 + 10,
  });
  f.advance(20_000);
  const cached = await provider.getPlans();
  assert.equal(f.calls.length, 1);
  assert.equal(plan(cached).resets, null);
  assert.match(plan(cached).resetsReason, /cached.*expired/i);
  available = 0;
  f.advance(40_000);
  const refreshed = await provider.getPlans();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(plan(refreshed).resets, { available: 0, nextExpiresAt: null });
  assert.equal(plan(refreshed).resetsReason, null);
  f.clean(cached);
  f.clean(refreshed);
});

test('plan-usage-network Cursor preserves Included, Auto and API percentages with a stable label', async (t) => {
  const f = fixture(t);
  const token = f.cursor();
  f.dispatch((url, options) => {
    assert.equal(url, CURSOR);
    assert.equal(options.method, 'POST');
    assert.equal(options.body, '{}');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      'x-cursor-client-type': 'cli',
    });
    return response({
      email: 'response@example.com',
      billingCycleEnd: String(NOW + 86_400_000),
      planUsage: { includedSpend: 500, limit: 2000, totalPercentUsed: 0.4, autoPercentUsed: 0, apiPercentUsed: 0.4 },
    });
  });
  const provider = f.provider();
  const result = await provider.getPlans();
  const row = plan(result, 'cursor');
  assert.equal(row.label, 'Cursor');
  assert.equal(row.email, 'response@example.com');
  assert.equal(row.source, 'endpoint');
  assert.equal(row.unavailable, false);
  assert.deepEqual(row.windows[0], {
    kind: 'monthly', usedPct: 0.4, includedPct: 0.4, autoPct: 0, apiPct: 0.4, resetsAt: NOW / 1000 + 86_400,
    windowMinutes: null, used: 5, limit: 20, unit: 'USD',
  });
  f.advance(59_999);
  assert.deepEqual(plan(await provider.getPlans(), 'cursor'), row);
  assert.equal(f.calls.length, 1);
  f.clean(result);
});

test('plan-usage-network Cursor uses token email when the endpoint omits it and reports failures honestly', async (t) => {
  const f = fixture(t);
  f.cursor();
  let fail = false;
  f.dispatch((url) => {
    assert.equal(url, CURSOR);
    return fail ? { ok: false, status: 403 } : response({ planUsage: { includedSpend: 500, limit: 2000 } });
  });
  const provider = f.provider();
  const first = plan(await provider.getPlans(), 'cursor');
  assert.equal(first.label, 'Cursor');
  assert.equal(first.email, 'token@example.com');
  assert.equal(first.windows[0].usedPct, 25);
  fail = true;
  f.advance(60_000);
  const result = await provider.getPlans();
  const failed = plan(result, 'cursor');
  assert.equal(failed.label, 'Cursor');
  assert.equal(failed.email, 'token@example.com');
  assert.equal(failed.unavailable, true);
  assert.deepEqual(failed.windows, []);
  assert.match(failed.reason, /HTTP 403/);
  f.advance(59_999);
  await provider.getPlans();
  assert.equal(f.calls.length, 2);
  f.clean(result);
});

test('plan-usage-network overlapping cache calls await the same pending read without outer coalescing', async () => {
  const cachedRequest = createRequestCache(() => NOW);
  let release;
  let calls = 0;
  const request = () => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  };
  const first = cachedRequest('synthetic-home:resets', 'synthetic-identity', request);
  await new Promise((resolve) => setImmediate(resolve));
  let secondSettled = false;
  const second = cachedRequest('synthetic-home:resets', 'synthetic-identity', request).then((result) => {
    secondSettled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(secondSettled, false, 'a pending cache entry must not return null');
  const answer = { value: { available: 2, nextExpiresAt: null }, reason: null };
  release(answer);
  assert.deepEqual(await Promise.all([first, second]), [answer, answer]);
  assert.deepEqual(await cachedRequest('synthetic-home:resets', 'synthetic-identity', request), answer);
  assert.equal(calls, 1);
});

// OO 568 (2026-11-23): each good Cursor reading is saved with its time in <home>\.harbor\cursor-usage-last.json, and
// a failed read hands it back with whether the sign-in key is stored, so routing can lean on it.
test('plan-usage-network saves the last good Cursor reading and hands it back when a read fails', async (t) => {
  const f = fixture(t);
  f.cursor(NOW / 1000 + 3000, { apiKey: 'synthetic-cursor-api-key' });
  let fail = false;
  f.dispatch((url) => {
    assert.equal(url, CURSOR);
    return fail ? { ok: false, status: 500, json: async () => ({}) } : response({ planUsage: { totalPercentUsed: 0.2 } });
  });
  const provider = f.provider({ usageProvider: { getUsage: async () => ({}) } });
  const good = plan(await provider.getPlans(), 'cursor');
  assert.equal(good.windows[0].usedPct, 0.2);
  const lastFile = path.join(f.root, '.harbor', 'cursor-usage-last.json');
  const saved = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
  assert.deepEqual(saved, { monthlyPct: 0.2, at: new Date(NOW).toISOString() });
  for (const secret of f.secrets) assert.equal(fs.readFileSync(lastFile, 'utf8').includes(secret), false, 'no credential in the saved reading');
  fail = true;
  f.advance(61_000);
  const lost = await provider.getPlans();
  const row = plan(lost, 'cursor');
  assert.equal(row.unavailable, true);
  assert.equal(row.keyPresent, true);
  assert.deepEqual(row.lastGood, { monthlyPct: 0.2, at: new Date(NOW).toISOString() });
  f.clean(lost);
});

test('plan-usage-network reports no stored key for a Cursor sign-in without one', async (t) => {
  const f = fixture(t);
  f.cursor(NOW / 1000 + 3000);
  f.put('.harbor/cursor-usage-last.json', { monthlyPct: 3, at: '2026-09-30T12:00:00.000Z' });
  f.dispatch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  const row = plan(await f.provider({ usageProvider: { getUsage: async () => ({}) } }).getPlans(), 'cursor');
  assert.equal(row.unavailable, true);
  assert.equal(row.keyPresent, false);
  assert.deepEqual(row.lastGood, { monthlyPct: 3, at: '2026-09-30T12:00:00.000Z' });
});
