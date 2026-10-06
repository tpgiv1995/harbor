'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createUsageProvider,
  usageFromStatuslinePayload,
} = require('../../src/main/providers/usage.js');

test('usageFromStatuslinePayload ports the exact statusline JSON fields', () => {
  assert.deepEqual(usageFromStatuslinePayload({
    cost: { total_cost_usd: 12.345 },
    rate_limits: {
      five_hour: { used_percentage: 42.8 },
      seven_day: { used_percentage: 71 },
    },
  }, { email: 'pat@example.com', updatedAt: '2026-07-17T07:00:00.000Z' }), {
    fiveHourPct: 42.8,
    weeklyPct: 71,
    cost: 12.345,
    email: 'pat@example.com',
    updatedAt: '2026-07-17T07:00:00.000Z',
  });
});

test('usageFromStatuslinePayload: nothing usable is unavailable with freshness', () => {
  assert.deepEqual(usageFromStatuslinePayload({ rate_limits: {} }, { email: 'pat@example.com', updatedAt: 't1' }), {
    unavailable: true,
    reason: 'Claude statusline payload did not include 5-hour usage, weekly usage, and cost',
    email: 'pat@example.com',
    updatedAt: 't1',
  });
});

test('usageFromStatuslinePayload renders partial fields instead of hiding the account', () => {
  const partial = usageFromStatuslinePayload(
    { rate_limits: { five_hour: { used_percentage: 42 } } },
    { email: 'pat@example.com', updatedAt: 't2' },
  );
  assert.equal(partial.partial, true);
  assert.equal(partial.fiveHourPct, 42);
  assert.equal(partial.weeklyPct, undefined);
  assert.equal(partial.cost, undefined);
  assert.equal(partial.updatedAt, 't2');
});

test('provider keeps samples separate per account and reads each account email', async () => {
  const files = new Map([
    [path.join('/personal', '.claude.json'), '{"oauthAccount":{"emailAddress":"personal@example.com"}}'],
    [path.join('/team', '.claude.json'), '{"oauthAccount":{"emailAddress":"team@example.com"}}'],
  ]);
  const usage = createUsageProvider({
    homes: { personal: '/personal', team: '/team' },
    readFile: async (file) => files.get(file),
    now: () => new Date('2026-07-17T07:00:00.000Z'),
  });
  usage.recordStatuslinePayload('team', {
    cost: { total_cost_usd: 3 },
    rate_limits: { five_hour: { used_percentage: 20 }, seven_day: { used_percentage: 30 } },
  });
  assert.deepEqual(await usage.getUsage('team'), {
    fiveHourPct: 20,
    weeklyPct: 30,
    cost: 3,
    email: 'team@example.com',
    updatedAt: '2026-07-17T07:00:00.000Z',
  });
  const personal = await usage.getUsage('personal');
  assert.equal(personal.unavailable, true);
  assert.equal(personal.email, 'personal@example.com');
  assert.match(personal.reason, /Claude is not signed in/);
});

test('a codex profile is answered as not-Claude without touching its home or the endpoint', async () => {
  const reads = [];
  const fetches = [];
  const usage = createUsageProvider({
    profiles: [
      { id: 'personal', provider: 'claude', configHome: '/personal' },
      { id: 'codex-second', provider: 'codex', configHome: '/codex-second' },
    ],
    teeDir: '/tee',
    readFile: async (file) => { reads.push(file); const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
    fetchRemoteUsage: async (home) => { fetches.push(home); return null; },
  });
  const codex = await usage.getUsage('codex-second');
  assert.equal(codex.unavailable, true);
  assert.equal(codex.notClaude, true);
  assert.match(codex.reason, /Not a Claude account/);
  assert.deepEqual(reads, []);
  assert.deepEqual(fetches, []);
  // The Claude profile beside it still goes through the normal path.
  const personal = await usage.getUsage('personal');
  assert.equal(personal.notClaude, undefined);
  assert.deepEqual(fetches, ['/personal']);
});

test('provider rejects unknown accounts', async () => {
  const usage = createUsageProvider();
  await assert.rejects(() => usage.getUsage('unknown'), /unknown account/);
  assert.throws(() => usage.recordStatuslinePayload('unknown', {}), /unknown account/);
});

// ---- direct-endpoint fallback (live-caught 2026-07-24: the statusline only
// repaints on interactive activity, so a workflow-fleet session left the
// third-pool account's meter frozen at its boot render, 1 percent, while its
// real window was 68) --

function remoteFixture({ tee, fetches, nowIso = '2026-07-24T22:50:00.000Z', cooldownMs, staleMs } = {}) {
  const files = new Map([
    [path.join('/plan3', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'third@example.com' } })],
  ]);
  if (tee) files.set(path.join('/tee', 'usage-plan3.json'), JSON.stringify(tee));
  const calls = [];
  return {
    calls,
    usage: createUsageProvider({
      homes: { plan3: '/plan3' },
      teeDir: '/tee',
      readFile: async (file) => {
        if (!files.has(file)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
        return files.get(file);
      },
      now: () => new Date(nowIso),
      staleAfterMs: staleMs ?? 3 * 60 * 1000,
      remoteCooldownMs: cooldownMs ?? 60 * 1000,
      fetchRemoteUsage: async (home) => {
        calls.push(home);
        const next = fetches?.shift();
        return next === undefined ? null : next;
      },
    }),
  };
}

test('a stale tee sample triggers the direct endpoint and the fresh result wins', async () => {
  const { usage, calls } = remoteFixture({
    tee: {
      account_email: 'third@example.com',
      updated_at: '2026-07-24T21:18:49-05:00',
      rate_limits: { five_hour: { used_percentage: 1 }, seven_day: { used_percentage: 21 } },
      cost: { total_cost_usd: 0 },
    },
    nowIso: '2026-07-24T22:50:00.000-05:00',
    fetches: [{
      payload: { rate_limits: { five_hour: { used_percentage: 68, resets_at: 1784963400 }, seven_day: { used_percentage: 4 } } },
      updatedAt: '2026-07-24T22:50:00.000-05:00',
    }],
  });
  const result = await usage.getUsage('plan3');
  assert.deepEqual(calls, ['/plan3']);
  assert.equal(result.fiveHourPct, 68);
  assert.equal(result.weeklyPct, 4);
  assert.equal(result.updatedAt, '2026-07-24T22:50:00.000-05:00');
});

test('a failed direct fetch keeps serving the stale sample honestly', async () => {
  const { usage, calls } = remoteFixture({
    tee: {
      updated_at: '2026-07-24T21:18:49-05:00',
      rate_limits: { five_hour: { used_percentage: 1 }, seven_day: { used_percentage: 21 } },
      cost: { total_cost_usd: 0 },
    },
    nowIso: '2026-07-24T22:50:00.000-05:00',
    fetches: [null],
  });
  const result = await usage.getUsage('plan3');
  assert.deepEqual(calls, ['/plan3']);
  assert.equal(result.fiveHourPct, 1);
  assert.equal(result.updatedAt, '2026-07-24T21:18:49-05:00');
});

test('the cooldown holds: repeated stale reads fire one fetch, later reads reuse the cached remote sample', async () => {
  const { usage, calls } = remoteFixture({
    nowIso: '2026-07-24T22:50:00.000-05:00',
    fetches: [{
      payload: { rate_limits: { five_hour: { used_percentage: 68 }, seven_day: { used_percentage: 4 } } },
      updatedAt: '2026-07-24T22:50:00.000-05:00',
    }],
  });
  const first = await usage.getUsage('plan3');
  const second = await usage.getUsage('plan3');
  assert.deepEqual(calls, ['/plan3']);
  assert.equal(first.fiveHourPct, 68);
  assert.equal(second.fiveHourPct, 68);
});

test('fetchRemoteUsage: null disables the fallback entirely (E2E, harnesses)', async () => {
  const usage = createUsageProvider({
    homes: { plan3: '/plan3' },
    teeDir: '/tee',
    readFile: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
    now: () => new Date('2026-07-24T22:50:00.000-05:00'),
    fetchRemoteUsage: null,
  });
  const result = await usage.getUsage('plan3');
  assert.equal(result.unavailable, true);
});

const { fetchOauthUsage } = require('../../src/main/providers/usage.js');

test('fetchOauthUsage maps the endpoint response into the statusline payload shape', async () => {
  const result = await fetchOauthUsage('/plan3', {
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 9999999999999 } }),
    now: () => new Date('2026-07-24T22:50:00.000Z'),
    fetchImpl: async (url, opts) => {
      assert.match(url, /api\/oauth\/usage/);
      assert.equal(opts.headers.authorization, 'Bearer tok');
      return {
        ok: true,
        json: async () => ({
          five_hour: { utilization: 68.0, resets_at: '2026-07-25T07:09:59.812960+00:00' },
          seven_day: { utilization: 4.0, resets_at: '2026-08-01T02:59:59.812986+00:00' },
        }),
      };
    },
  });
  assert.equal(result.payload.rate_limits.five_hour.used_percentage, 68);
  assert.equal(result.payload.rate_limits.five_hour.resets_at, Date.parse('2026-07-25T07:09:59.812960+00:00') / 1000);
  assert.equal(result.payload.rate_limits.seven_day.used_percentage, 4);
  assert.equal(result.updatedAt, '2026-07-24T22:50:00.000Z');
});

test('fetchOauthUsage never calls the endpoint with an expired token', async () => {
  const result = await fetchOauthUsage('/plan3', {
    readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: 1000 } }),
    now: () => new Date('2026-07-24T22:50:00.000Z'),
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result, null);
});

// 2026-10-05: every endpoint failure collapsed to null, so the panel showed one
// generic "unavailable" line for a timeout, a 429 and an empty body alike.
test('fetchOauthUsage names the failure when asked for reasons, and stays null when not', async () => {
  const creds = async () => ({ claudeAiOauth: { accessToken: 'fixture', expiresAt: 9999999999999 } });
  const cases = [
    [async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }, /request failed: ENOTFOUND/],
    [async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, /timed out after 10s/],
    [async () => ({ ok: false, status: 429 }), /HTTP 429 \(rate limited/],
    [async () => ({ ok: false, status: 401 }), /HTTP 401$/],
    [async () => ({ ok: true, json: async () => { throw new Error('bad'); } }), /not JSON/],
    [async () => ({ ok: true, json: async () => ({ five_hour: null }) }), /no 5-hour or weekly numbers/],
  ];
  for (const [fetchImpl, reason] of cases) {
    const loud = await fetchOauthUsage('/claude', { readCredentials: creds, reportUnavailable: true, fetchImpl });
    assert.equal(loud.unavailable, true);
    assert.match(loud.reason, reason);
    assert.equal(await fetchOauthUsage('/claude', { readCredentials: creds, fetchImpl }), null);
  }
});

test('a Keychain read failure is reported as such, not as "not signed in"', async () => {
  const r = await fetchOauthUsage('/claude', {
    readCredentials: async () => ({ keychainError: 'the Keychain prompt timed out' }),
    reportUnavailable: true,
    fetchImpl: async () => { throw new Error('must not call'); },
  });
  assert.equal(r.unavailable, true);
  assert.match(r.reason, /macOS Keychain: the Keychain prompt timed out/);
});

test('keychainServicesFor names each config home its own Claude Code credential item', () => {
  const { keychainServicesFor } = require('../../src/main/providers/usage.js');
  const sha8 = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 8);
  // A custom home reads ONLY its own hashed item, never the default account's.
  assert.deepEqual(keychainServicesFor('/Users/x/.claude-max', '/Users/x'),
    [`Claude Code-credentials-${sha8('/Users/x/.claude-max')}`]);
  // A literal pin, so a naming change is caught here. The formula was checked
  // against a real Keychain item on 2026-10-05; the path is neutral.
  assert.deepEqual(keychainServicesFor('/Users/demo/.claude-max', '/Users/demo'),
    ['Claude Code-credentials-2683c6ee']);
  // The default home: the bare item first, then its hashed twin.
  assert.deepEqual(keychainServicesFor('/Users/x/.claude', '/Users/x'),
    ['Claude Code-credentials', `Claude Code-credentials-${sha8('/Users/x/.claude')}`]);
});
