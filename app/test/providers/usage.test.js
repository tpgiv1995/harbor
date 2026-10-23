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

// ---- which Keychain item a home uses, and a login on another plan --------
// readItem is an injected fake: no Keychain is read here.

const { pickKeychainCredentials, homePlan, fetchOauthUsage: fetchUsage } = require('../../src/main/providers/usage.js');

const item = (subscriptionType, accessToken = 'synthetic-token') => JSON.stringify({ claudeAiOauth: { accessToken, subscriptionType } });
const missing = () => { const e = new Error('no item'); e.code = 44; throw e; };
const reader = (items) => async (service) => {
  const value = items[service];
  if (value instanceof Error) throw value;
  if (value === undefined) missing();
  return value;
};

test('the Keychain item on the home\'s plan wins over another plan\'s login', async () => {
  const creds = await pickKeychainCredentials(['bare', 'hashed'], reader({ bare: item('max'), hashed: item('team', 'team-token') }), { plan: 'team' });
  assert.equal(creds.claudeAiOauth.accessToken, 'team-token');
  assert.equal(creds.planMismatch, undefined);
  // An unknown home plan or item plan never blocks the first token.
  assert.equal((await pickKeychainCredentials(['bare'], reader({ bare: item('max') }), { plan: null })).planMismatch, undefined);
  assert.equal((await pickKeychainCredentials(['bare'], reader({ bare: item('future') }), { plan: 'team' })).planMismatch, undefined);
  // A tokenless item is the answer only when no item holds a token.
  const tokenless = JSON.stringify({ claudeAiOauth: { subscriptionType: 'team' } });
  assert.equal((await pickKeychainCredentials(['bare', 'hashed'], reader({ bare: tokenless, hashed: item('team', 'later') }), { plan: 'team' })).claudeAiOauth.accessToken, 'later');
});

test('the only login, on another plan, is used and marked as a plan mismatch', async () => {
  const creds = await pickKeychainCredentials(['bare', 'hashed'], reader({ hashed: item('max') }), { plan: 'team' });
  assert.equal(creds.claudeAiOauth.accessToken, 'synthetic-token');
  assert.deepEqual(creds.planMismatch, { keychain: 'max', home: 'team' });
});

test('a mismatched login is not used when another item could not be read, or when several disagree', async () => {
  const denied = Object.assign(new Error('denied'), { code: 51 });
  const partial = await pickKeychainCredentials(['bare', 'hashed'], reader({ bare: item('max'), hashed: denied }), { plan: 'team' });
  assert.equal(partial.planMismatch, undefined);
  assert.match(partial.keychainError, /security exited 51/);
  const several = await pickKeychainCredentials(['bare', 'hashed'], reader({ bare: item('max'), hashed: item('pro') }), { plan: 'team' });
  assert.match(several.keychainError, /no Keychain login is on this home's team plan \(found max, pro\)/);
});

test('homePlan reads organizationType, the default home from beside it too', async () => {
  const files = new Map([
    [path.join('/u/.claude-work', '.claude.json'), JSON.stringify({ oauthAccount: { organizationType: 'claude_team' } })],
    [path.join('/u', '.claude.json'), JSON.stringify({ oauthAccount: { organizationType: 'claude_max' } })],
    [path.join('/u/.claude-odd', '.claude.json'), JSON.stringify({ oauthAccount: { organizationType: 'something_else' } })],
  ]);
  const readFile = async (file) => { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); };
  assert.equal(await homePlan('/u/.claude-work', readFile, '/u'), 'team');
  assert.equal(await homePlan('/u/.claude', readFile, '/u'), 'max');
  assert.equal(await homePlan('/u/.claude-odd', readFile, '/u'), null);
  assert.equal(await homePlan('/u/.claude-none', readFile, '/u'), null);
});

test('fetchOauthUsage carries a plan mismatch onto the sample it fetched', async () => {
  const fetched = await fetchUsage('/claude', {
    readCredentials: async () => ({ claudeAiOauth: { accessToken: 'synthetic-token' }, planMismatch: { keychain: 'max', home: 'team' } }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 17 }, seven_day: { utilization: 12 } }) }),
  });
  assert.equal(fetched.payload.rate_limits.five_hour.used_percentage, 17);
  assert.deepEqual(fetched.planMismatch, { keychain: 'max', home: 'team' });
});

function mismatchFixture({ otherPlan }) {
  const files = new Map([
    [path.join('/team', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'team@example.com', organizationType: 'claude_team' } })],
    [path.join('/other', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'other@example.com', organizationType: `claude_${otherPlan}` } })],
  ]);
  return createUsageProvider({
    profiles: [
      { id: 'team', label: 'Team', configHome: '/team' },
      { id: 'other', label: 'Other', configHome: '/other' },
      { id: 'cx', label: 'Codex', provider: 'codex', configHome: '/cx' },
    ],
    teeDir: '/tee',
    readFile: async (file) => { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); },
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    fetchRemoteUsage: async (home) => (home === '/team' ? {
      payload: { rate_limits: { five_hour: { used_percentage: 17 }, seven_day: { used_percentage: 12 } } },
      updatedAt: '2026-10-16T12:00:00.000Z',
      planMismatch: { keychain: 'max', home: 'team' },
    } : null),
  });
}

test('a mismatched login shows its numbers with the mismatch when no other home is on its plan', async () => {
  const result = await mismatchFixture({ otherPlan: 'pro' }).getUsage('team');
  assert.equal(result.fiveHourPct, 17);
  assert.deepEqual(result.planMismatch, { keychain: 'max', home: 'team' });
  assert.match(result.planMismatchNote, /Plan mismatch: the Keychain login is on the max plan but this home's \.claude\.json says team/);
});

test('a mismatched login on another configured home\'s plan is refused, never shown under this name', async () => {
  const result = await mismatchFixture({ otherPlan: 'max' }).getUsage('team');
  assert.equal(result.unavailable, true);
  assert.equal(result.fiveHourPct, undefined);
  assert.match(result.reason, /on the max plan, which Other is signed in to/);
  assert.equal(result.email, 'team@example.com');
});
