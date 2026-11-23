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

// ---- 2026-11-23: the rail said Claude C's week was about 20% while it was at
// 99%. The direct read kept failing with HTTP 429 (and was retried inside the
// provider's own wait every minute), a restart had emptied the only good read,
// and the rail drew a two-day-old statusline sample as if it were current.

const fs = require('node:fs');
const os = require('node:os');
const { parseRetryAfter, SHOWN_STALE_MS, DEFAULT_RETRY_AFTER_MS } = require('../../src/main/providers/usage.js');

const OLD_TEE = {
  updated_at: '2026-11-21T10:00:00.000Z',
  rate_limits: { five_hour: { used_percentage: 0 }, seven_day: { used_percentage: 20, resets_at: Date.parse('2026-11-28T08:00:00Z') / 1000 } },
  cost: { total_cost_usd: 0 },
};

function clockFixture({ tee = OLD_TEE, fetches = [], remoteDir, startIso = '2026-11-23T05:40:00.000Z' } = {}) {
  let nowMs = Date.parse(startIso);
  const files = new Map([[path.join('/tee', 'usage-planc.json'), JSON.stringify(tee)]]);
  const calls = [];
  const realRead = fs.promises.readFile;
  const usage = createUsageProvider({
    homes: { planc: '/planc' },
    teeDir: '/tee',
    remoteDir: remoteDir || null,
    // Fixture files are in memory; the shared store is a real temp folder.
    readFile: async (file, enc) => {
      if (remoteDir && file.startsWith(remoteDir)) return realRead(file, enc);
      if (!files.has(file)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }
      return files.get(file);
    },
    now: () => new Date(nowMs),
    fetchRemoteUsage: async (home) => { calls.push(home); const next = fetches.shift(); return next === undefined ? null : next; },
  });
  return { usage, calls, advance: (ms) => { nowMs += ms; }, nowMs: () => nowMs };
}

const RATE_LIMITED = (retryAfterMs) => ({ unavailable: true, status: 429, retryAfterMs, reason: 'Claude usage request failed: HTTP 429 (rate limited; Claude asked for a pause before the next read)' });
const GOOD_READ = (iso, weekly) => ({ payload: { rate_limits: { five_hour: { used_percentage: 0 }, seven_day: { used_percentage: weekly } } }, updatedAt: iso });

test('a 429 is honoured: no endpoint call inside the provider\'s wait, one call after it', async () => {
  const { usage, calls, advance } = clockFixture({ fetches: [RATE_LIMITED(14 * 60 * 1000), GOOD_READ('2026-11-23T05:55:00.000Z', 99)] });
  await usage.getUsage('planc');
  assert.equal(calls.length, 1);
  // Past the 60 s cooldown but inside the 14-minute wait: still no call.
  for (const step of [2, 5, 6]) { advance(step * 60 * 1000); await usage.getUsage('planc'); }
  assert.equal(calls.length, 1, 'called the endpoint again inside the Retry-After wait');
  advance(2 * 60 * 1000); // 15 minutes in: the wait is over
  const result = await usage.getUsage('planc');
  assert.equal(calls.length, 2);
  assert.equal(result.weeklyPct, 99);
});

test('an old reading is marked stale with the reason and the next read time; a fresh one is not', async () => {
  const { usage } = clockFixture({ fetches: [RATE_LIMITED(14 * 60 * 1000)] });
  const stale = await usage.getUsage('planc');
  assert.equal(stale.weeklyPct, 20, 'the old number is still shown, as a floor');
  assert.equal(stale.stale, true);
  assert.match(stale.staleReason, /HTTP 429/);
  assert.equal(stale.nextReadAt, new Date(Date.parse('2026-11-23T05:40:00.000Z') + 14 * 60 * 1000).toISOString());

  const fresh = clockFixture({ tee: { ...OLD_TEE, updated_at: '2026-11-23T05:39:00.000Z' } });
  const result = await fresh.usage.getUsage('planc');
  assert.equal(result.stale, undefined);
  assert.equal(result.staleReason, undefined);
});

test('a reading just inside the stale line is not marked, just past it is', async () => {
  const at = (ageMs) => clockFixture({ tee: { ...OLD_TEE, updated_at: new Date(Date.parse('2026-11-23T05:40:00.000Z') - ageMs).toISOString() } });
  assert.equal((await at(SHOWN_STALE_MS).usage.getUsage('planc')).stale, undefined);
  assert.equal((await at(SHOWN_STALE_MS + 60 * 1000).usage.getUsage('planc')).stale, true);
});

test('the last good read and the 429 wait survive a restart and reach the other process', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-usage-remote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remoteDir = path.join(root, 'usage-remote');
  const desktop = clockFixture({ remoteDir, fetches: [GOOD_READ('2026-11-23T05:40:00.000Z', 97)] });
  assert.equal((await desktop.usage.getUsage('planc')).weeklyPct, 97);
  assert.equal(JSON.parse(fs.readFileSync(path.join(remoteDir, 'planc.json'), 'utf8')).payload.rate_limits.seven_day.used_percentage, 97);

  // A restarted Harbor (or the phone server) whose own read is refused still
  // shows the kept 97%, not the two-day-old statusline 20%.
  const restarted = clockFixture({ remoteDir, startIso: '2026-11-23T05:50:00.000Z', fetches: [RATE_LIMITED(30 * 60 * 1000)] });
  const shown = await restarted.usage.getUsage('planc');
  assert.equal(shown.weeklyPct, 97);
  assert.equal(restarted.calls.length, 1);

  // The wait it was given is on disk, so a third process makes no call at all,
  // and the kept reading survives the 429 write.
  const phone = clockFixture({ remoteDir, startIso: '2026-11-23T06:00:00.000Z', fetches: [GOOD_READ('x', 1)] });
  const phoneShown = await phone.usage.getUsage('planc');
  assert.equal(phone.calls.length, 0, 'the other process ignored the stored wait');
  assert.equal(phoneShown.weeklyPct, 97);
  assert.equal(phoneShown.stale, true);
  assert.match(phoneShown.staleReason, /HTTP 429/);
  assert.equal(fs.readdirSync(remoteDir).filter((name) => name.includes('.tmp-')).length, 0, 'a tmp file was left behind');
});

test('fetchOauthUsage hands back the provider\'s Retry-After on a 429 (seconds, HTTP date, or the default)', async () => {
  const creds = async () => ({ claudeAiOauth: { accessToken: 'fixture', expiresAt: 9999999999999 } });
  const now = () => new Date('2026-11-23T17:53:00.000Z');
  const answer = (value) => async () => ({ ok: false, status: 429, headers: { get: (name) => (name === 'retry-after' ? value : null) } });
  const read = (value) => fetchOauthUsage('/claude', { readCredentials: creds, reportUnavailable: true, now, fetchImpl: answer(value) });
  assert.equal((await read('817')).retryAfterMs, 817_000);
  assert.equal((await read('Mon, 23 Nov 2026 18:53:00 GMT')).retryAfterMs, 3_600_000);
  assert.equal((await read(null)).retryAfterMs, DEFAULT_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter('garbage', 0), null);
  // A non-429 failure carries no wait.
  const other = await fetchOauthUsage('/claude', { readCredentials: creds, reportUnavailable: true, now, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(other.retryAfterMs, undefined);
});

// ---- 2026-11-23, the same afternoon: the stale marks above were honest but not
// the fix. Nine idle plans showed "N%+" because their ACCESS token had lapsed
// (the login was fine), and Harbor never refreshes a token. Pat: "this happens
// when we havent used one of them in a few days but the credentials are good".
// The provider now asks the Claude CLI to renew it (`claude -p /usage`, a local
// command, no model call) and reads the live number right after.

const { renewTokenWithCli, RENEW_COOLDOWN_MS } = require('../../src/main/providers/usage.js');
const { EventEmitter } = require('node:events');

const LAPSED = { unavailable: true, tokenLapsed: true, reason: 'lapsed' };

test('a lapsed token is renewed through the CLI once, and the live reading follows on the next read', async () => {
  const renewals = [];
  let release;
  const files = new Map([[path.join('/tee', 'usage-planc.json'), JSON.stringify(OLD_TEE)]]);
  let nowMs = Date.parse('2026-11-23T05:40:00.000Z');
  const fetches = [LAPSED, GOOD_READ('2026-11-23T05:41:00.000Z', 94)];
  const fetched = [];
  const provider = createUsageProvider({
    homes: { planc: '/planc' },
    teeDir: '/tee',
    readFile: async (file) => { if (!files.has(file)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; } return files.get(file); },
    now: () => new Date(nowMs),
    fetchRemoteUsage: async (home) => { fetched.push(home); return fetches.shift() ?? null; },
    renewLapsedToken: (home) => { renewals.push(home); return new Promise((resolve) => { release = resolve; }); },
  });
  const first = await provider.getUsage('planc');
  assert.deepEqual(renewals, ['/planc']);
  assert.equal(first.stale, true);
  assert.match(first.staleReason, /renewing this idle plan's sign-in through the Claude CLI/);
  // While it runs, later reads neither start a second renewal nor call the endpoint early.
  nowMs += 30 * 1000;
  await provider.getUsage('planc');
  assert.deepEqual(renewals, ['/planc']);
  release({ ok: true });
  await provider.settleRenewals();
  // The very next read fetches (no 60 s endpoint cooldown after a renewal) and shows the live number.
  nowMs += 5 * 1000;
  const after = await provider.getUsage('planc');
  assert.equal(fetched.length, 2);
  assert.equal(after.weeklyPct, 94);
  assert.equal(after.stale, undefined);
});

test('a failed renewal says why, and is not retried inside the cooldown', async () => {
  const renewals = [];
  let nowMs = Date.parse('2026-11-23T05:40:00.000Z');
  const provider = createUsageProvider({
    homes: { planc: '/planc' },
    teeDir: '/tee',
    readFile: async (file) => { if (file === path.join('/tee', 'usage-planc.json')) return JSON.stringify(OLD_TEE); const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
    now: () => new Date(nowMs),
    fetchRemoteUsage: async () => LAPSED,
    renewLapsedToken: async (home) => { renewals.push(home); return { ok: false, reason: 'the Claude CLI was not found' }; },
  });
  await provider.getUsage('planc');
  await provider.settleRenewals();
  nowMs += 2 * 60 * 1000;
  const shown = await provider.getUsage('planc');
  assert.match(shown.staleReason, /could not renew .*the Claude CLI was not found/);
  assert.equal(renewals.length, 1);
  nowMs += RENEW_COOLDOWN_MS;
  await provider.getUsage('planc');
  await provider.settleRenewals();
  assert.equal(renewals.length, 2);
});

test('a renewal that turned into a model call stops all further renewals', async () => {
  const renewals = [];
  let nowMs = Date.parse('2026-11-23T05:40:00.000Z');
  const provider = createUsageProvider({
    homes: { a: '/a', b: '/b' },
    teeDir: '/tee',
    readFile: async () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
    now: () => new Date(nowMs),
    fetchRemoteUsage: async () => LAPSED,
    renewLapsedToken: async (home) => { renewals.push(home); return { ok: false, modelCall: true, reason: 'model call' }; },
  });
  await provider.getUsage('a');
  await provider.settleRenewals();
  await provider.getUsage('b');
  await provider.settleRenewals();
  assert.deepEqual(renewals, ['/a']);
});

test('the default provider renews only on the real machine: an injected reader or fetcher never starts the CLI', async () => {
  // No renewLapsedToken passed: a fixture that injects its reader and fetcher
  // must get no renewer, so a lapsed reading is reported, never "renewing".
  const provider = createUsageProvider({
    homes: { planc: '/planc' },
    teeDir: '/tee',
    readFile: async (file) => { if (file === path.join('/tee', 'usage-planc.json')) return JSON.stringify(OLD_TEE); const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
    now: () => new Date('2026-11-23T05:40:00.000Z'),
    fetchRemoteUsage: async () => LAPSED,
  });
  const shown = await provider.getUsage('planc');
  await provider.settleRenewals();
  assert.equal(shown.stale, true);
  assert.equal(shown.staleReason, 'lapsed');
});

function fakeSpawn({ stdout, code = 0, onSpawn }) {
  return (bin, args, opts) => {
    onSpawn?.(bin, args, opts);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', stdout); child.emit('close', code); });
    return child;
  };
}

test('renewTokenWithCli runs /usage locally, windowless, without the API key, and trusts only the credentials file', async (t) => {
  const seen = [];
  const cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-renew-'));
  t.after(() => fs.rmSync(cwdRoot, { recursive: true, force: true }));
  const base = {
    resolveBin: async () => 'C:/fake/claude.exe',
    env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/elsewhere', PATH: 'p' },
    cwdRoot,
    homedir: '/users/x',
    now: () => 1000,
  };
  const ok = await renewTokenWithCli('/users/x/.claude-ocean', {
    ...base,
    spawnImpl: fakeSpawn({ stdout: JSON.stringify({ num_turns: 0, total_cost_usd: 0, result: 'Current week: 94% used' }), onSpawn: (...a) => seen.push(a) }),
    readCredentials: async () => ({ claudeAiOauth: { expiresAt: 2000 } }),
  });
  assert.deepEqual(ok, { ok: true });
  const [bin, args, opts] = seen[0];
  assert.equal(bin, 'C:/fake/claude.exe');
  assert.deepEqual(args.slice(0, 2), ['-p', '/usage']);
  for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--output-format']) assert.ok(args.includes(flag), flag);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(opts.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(opts.env.CLAUDE_CONFIG_DIR, '/users/x/.claude-ocean');
  assert.equal(fs.readdirSync(opts.cwd).length, 0, 'the CLI must start in an empty folder');

  // The default home is the CLI's own default: no CLAUDE_CONFIG_DIR at all.
  seen.length = 0;
  await renewTokenWithCli('/users/x/.claude', { ...base, spawnImpl: fakeSpawn({ stdout: '{"num_turns":0}', onSpawn: (...a) => seen.push(a) }), readCredentials: async () => ({ claudeAiOauth: { expiresAt: 2000 } }) });
  assert.equal(seen[0][2].env.CLAUDE_CONFIG_DIR, undefined);

  // A model call is reported as such, whatever the token says.
  const model = await renewTokenWithCli('/users/x/.claude-ocean', { ...base, spawnImpl: fakeSpawn({ stdout: JSON.stringify({ num_turns: 1, total_cost_usd: 0.5 }) }), readCredentials: async () => ({ claudeAiOauth: { expiresAt: 2000 } }) });
  assert.equal(model.ok, false);
  assert.equal(model.modelCall, true);

  // A clean exit with the token still lapsed is a failure, with the CLI's own words.
  const stuck = await renewTokenWithCli('/users/x/.claude-ocean', { ...base, spawnImpl: fakeSpawn({ stdout: JSON.stringify({ num_turns: 0, result: 'Not logged in' }) }), readCredentials: async () => ({ claudeAiOauth: { expiresAt: 500 } }) });
  assert.equal(stuck.ok, false);
  assert.match(stuck.reason, /without renewing it: Not logged in/);

  const missing = await renewTokenWithCli('/users/x/.claude-ocean', { ...base, resolveBin: async () => null });
  assert.deepEqual(missing, { ok: false, reason: 'the Claude CLI was not found' });
});
