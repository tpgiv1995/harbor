'use strict';

// Claude usage reads: failure backoff, Retry-After, a refused Keychain prompt
// that stays refused until the user refreshes, the visibility / live-session
// cadence, and an old sample that is not shown as current while the endpoint
// fails. Every provider here gets an injected readFile and an injected
// fetchRemoteUsage (or fetchOauthUsage with an injected credential reader and
// fetchImpl) on a fake clock: nothing reaches the network or the Keychain.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');

const {
  createUsageProvider, fetchOauthUsage, keychainFailure, parseRetryAfter,
  FAILURE_BACKOFF_BASE_MS, FAILURE_BACKOFF_MAX_MS, IDLE_STALE_AFTER_MS, HIDDEN_STALE_AFTER_MS,
  FAILING_SAMPLE_MAX_AGE_MS,
} = require('../../src/main/providers/usage.js');

const START = Date.parse('2026-10-19T12:00:00Z');
const MIN = 60 * 1000;
const enoent = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

function okAnswer(clock) {
  return {
    payload: { rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 5 } } },
    updatedAt: new Date(clock).toISOString(),
  };
}

// One Claude account on a fake clock. `answer(state)` is what the endpoint
// returns; `state.attempts` records the clock at every endpoint ask.
function rig({ answer, activity, files = {} } = {}) {
  const state = { clock: START, attempts: [] };
  const fileMap = new Map(Object.entries(files));
  const provider = createUsageProvider({
    homes: { a: '/fake-home/a' },
    teeDir: '/fake-tee',
    readFile: async (file) => (fileMap.has(file) ? fileMap.get(file) : enoent()),
    now: () => new Date(state.clock),
    activity,
    fetchRemoteUsage: async () => {
      state.attempts.push(state.clock);
      return answer(state);
    },
  });
  return { provider, state };
}

// The desktop app's load: the 60 s usage:update timer plus a focus read,
// i.e. two reads a minute. `everyMs` makes the clock finer when a test needs
// exact retry instants.
async function drive(provider, state, totalMs, { everyMs = MIN, readsPerStep = 2 } = {}) {
  const end = state.clock + totalMs;
  while (state.clock < end) {
    for (let i = 0; i < readsPerStep; i += 1) await provider.getUsage('a');
    state.clock += everyMs;
  }
}

const gaps = (times) => times.slice(1).map((t, i) => (t - times[i]) / 1000);

test('overlapping reads share one in-flight fetch and both get the numbers', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { provider, state } = rig({ answer: async (s) => { await gate; return okAnswer(s.clock); } });
  const first = provider.getUsage('a');
  const second = provider.getUsage('a');
  release();
  const results = await Promise.all([first, second]);
  assert.equal(state.attempts.length, 1);
  for (const r of results) {
    assert.notEqual(r.unavailable, true);
    assert.equal(r.fiveHourPct, 10);
    assert.equal(r.weeklyPct, 5);
  }
});

test('failures back off 60 s doubling to a 30 min cap, and a success resets it', async () => {
  let failing = true;
  const { provider, state } = rig({ answer: (s) => (failing ? { unavailable: true, reason: 'Claude usage request failed: HTTP 500' } : okAnswer(s.clock)) });
  await drive(provider, state, 120 * MIN, { everyMs: 10 * 1000, readsPerStep: 1 });
  assert.deepEqual(gaps(state.attempts), [60, 120, 240, 480, 960, 1800, 1800]);
  assert.equal(FAILURE_BACKOFF_BASE_MS, 60 * 1000);
  assert.equal(FAILURE_BACKOFF_MAX_MS, 30 * 60 * 1000);
  const failingResult = await provider.getUsage('a');
  assert.equal(failingResult.unavailable, true);
  assert.match(failingResult.reason, /HTTP 500/);

  // Recovery: the next allowed ask succeeds and the cadence is the healthy
  // one again (stale after 3 min), not the 30 min backoff.
  failing = false;
  const before = state.attempts.length;
  await drive(provider, state, 40 * MIN, { everyMs: 10 * 1000, readsPerStep: 1 });
  const after = state.attempts.slice(before - 1);
  assert.ok(after.length >= 3, `expected healthy asks after recovery, got ${after.length - 1}`);
  const healthyGaps = gaps(after).slice(1);
  assert.ok(healthyGaps.every((g) => g <= 200), `healthy gaps ${healthyGaps}`);
  const ok = await provider.getUsage('a');
  assert.equal(ok.unavailable, undefined);
  assert.equal(ok.fiveHourPct, 10);
});

test('Retry-After waits at least as long as it says; the longer of it and the backoff wins', async () => {
  const retryAfter = [10 * MIN, 30 * 1000, null];
  let n = 0;
  const { provider, state } = rig({
    answer: () => {
      const ms = retryAfter[n++];
      return { unavailable: true, reason: 'Claude usage request failed: HTTP 429 (rate limited)', ...(ms ? { retryAfterMs: ms } : {}) };
    },
  });
  await drive(provider, state, 20 * MIN, { everyMs: 10 * 1000, readsPerStep: 1 });
  // 1st failure: Retry-After 10 min beats the 60 s backoff. 2nd: 30 s loses
  // to the 120 s backoff. 3rd: no header, 240 s backoff.
  assert.deepEqual(gaps(state.attempts).slice(0, 3), [600, 120, 240]);
});

test('a manual refresh skips the backoff but never Retry-After or the cooldown', async () => {
  let ms = 5 * MIN;
  const { provider, state } = rig({ answer: () => ({ unavailable: true, reason: 'HTTP 429', ...(ms ? { retryAfterMs: ms } : {}) }) });
  await provider.getUsage('a');
  assert.equal(state.attempts.length, 1);
  state.clock += 2 * MIN;
  await provider.getUsage('a', { manual: true });
  assert.equal(state.attempts.length, 1, 'inside Retry-After even a manual refresh waits');
  state.clock += 4 * MIN; // past Retry-After; the backoff is now 120 s from this ask
  ms = null;
  await provider.getUsage('a', { manual: true });
  assert.equal(state.attempts.length, 2);
  state.clock += 70 * 1000;
  await provider.getUsage('a');
  assert.equal(state.attempts.length, 2, 'an automatic read respects the backoff');
  await provider.getUsage('a', { manual: true });
  assert.equal(state.attempts.length, 3, 'a manual one does not');
  state.clock += 20 * 1000;
  await provider.getUsage('a', { manual: true });
  assert.equal(state.attempts.length, 3, 'the 60 s per-account cooldown still holds');
});

test('parseRetryAfter reads delay-seconds and HTTP-dates', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(parseRetryAfter('120', now), 120000);
  assert.equal(parseRetryAfter(' 0 ', now), 0);
  assert.equal(parseRetryAfter('Mon, 19 Oct 2026 12:05:00 GMT', now), 5 * MIN);
  assert.equal(parseRetryAfter('Mon, 19 Oct 2026 11:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(undefined, now), null);
});

test('fetchOauthUsage carries Retry-After from a 429 into the answer', async () => {
  const now = () => new Date(START);
  const creds = async () => ({ claudeAiOauth: { accessToken: 'fixture', expiresAt: 9999999999999 } });
  const res = (value) => ({ ok: false, status: 429, headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? value : null) } });
  const secs = await fetchOauthUsage('/claude', { readCredentials: creds, reportUnavailable: true, now, fetchImpl: async () => res('90') });
  assert.equal(secs.unavailable, true);
  assert.match(secs.reason, /HTTP 429 \(rate limited\)/);
  assert.equal(secs.retryAfterMs, 90000);
  const date = await fetchOauthUsage('/claude', { readCredentials: creds, reportUnavailable: true, now, fetchImpl: async () => res('Mon, 19 Oct 2026 12:02:00 GMT') });
  assert.equal(date.retryAfterMs, 2 * MIN);
  const none = await fetchOauthUsage('/claude', { readCredentials: creds, reportUnavailable: true, now, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(none.retryAfterMs, undefined);
});

test('keychainFailure marks a refused or timed-out prompt, not a missing or unreadable item', () => {
  assert.deepEqual(keychainFailure(Object.assign(new Error('User canceled'), { code: 128 })), { keychainError: 'security exited 128', keychainPrompt: true });
  assert.deepEqual(keychainFailure(Object.assign(new Error('killed'), { killed: true, code: null })), { keychainError: 'the Keychain prompt timed out', keychainPrompt: true });
  assert.deepEqual(keychainFailure(Object.assign(new Error('no item'), { code: 44 })), { keychainError: 'no Claude Code entry in the Keychain' });
  assert.deepEqual(keychainFailure(new SyntaxError('Unexpected token')), { keychainError: 'the Claude Code Keychain entry is not readable JSON' });
});

// The provider driving the real fetchOauthUsage, with an injected credential
// reader standing in for the Keychain and an injected fetchImpl.
function keychainRig({ readItem }) {
  let clock = START;
  const provider = createUsageProvider({
    homes: { a: '/fake-home/a' },
    teeDir: '/fake-tee',
    readFile: async () => enoent(),
    now: () => new Date(clock),
    fetchRemoteUsage: (home) => fetchOauthUsage(home, {
      reportUnavailable: true,
      now: () => new Date(clock),
      readCredentials: async () => {
        try { return JSON.parse(await readItem()); } catch (error) { return keychainFailure(error); }
      },
      fetchImpl: async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 12 }, seven_day: { utilization: 34 } }) }),
    }),
  });
  return { provider, tick: (ms) => { clock += ms; } };
}

test('a refused Keychain prompt is not asked again until the user refreshes, and the row says so', async () => {
  let reads = 0;
  let deny = true;
  const { provider, tick } = keychainRig({
    readItem: async () => {
      reads += 1;
      if (deny) throw Object.assign(new Error('User canceled'), { code: 128 });
      return JSON.stringify({ claudeAiOauth: { accessToken: 'fixture', expiresAt: 9999999999999 } });
    },
  });
  for (let m = 0; m < 180; m += 1) {
    await provider.getUsage('a');
    await provider.getUsage('a');
    tick(MIN);
  }
  assert.equal(reads, 1, 'three hours of timer and focus reads asked the Keychain once');
  const row = await provider.getUsage('a');
  assert.equal(row.unavailable, true);
  assert.match(row.reason, /Keychain/);
  assert.match(row.reason, /refresh the title-bar Plan usage menu/);

  // The user opens the Plan usage menu (and allows the prompt this time).
  deny = false;
  const refreshed = await provider.getUsage('a', { manual: true });
  assert.equal(reads, 2);
  assert.equal(refreshed.unavailable, undefined);
  assert.equal(refreshed.fiveHourPct, 12);
});

test('a timed-out Keychain prompt is sticky too; a missing item only backs off', async () => {
  for (const [error, sticky] of [[Object.assign(new Error('killed'), { killed: true, code: null }), true], [Object.assign(new Error('no item'), { code: 44 }), false]]) {
    let reads = 0;
    const { provider, tick } = keychainRig({ readItem: async () => { reads += 1; throw error; } });
    for (let m = 0; m < 120; m += 1) { await provider.getUsage('a'); tick(MIN); }
    if (sticky) assert.equal(reads, 1, 'timeout: asked once');
    else assert.equal(reads, 8, 'missing item: not sticky, backed off (0, 1, 3, 7, 15, 31, 61, 91 min)');
  }
});

test('a refused prompt after a good read keeps the numbers and shows why they stopped refreshing', async () => {
  let deny = false;
  const { provider, state } = rig({
    answer: (s) => (deny
      ? { unavailable: true, reason: 'Could not read Claude credentials from the macOS Keychain: the Keychain prompt timed out', sticky: true }
      : okAnswer(s.clock)),
  });
  await provider.getUsage('a');
  deny = true;
  state.clock += 4 * MIN;
  const row = await provider.getUsage('a');
  assert.equal(row.unavailable, undefined);
  assert.equal(row.fiveHourPct, 10);
  assert.match(row.notice, /Keychain prompt timed out/);
  assert.match(row.notice, /refresh the title-bar Plan usage menu/);
});

test('cadence: visible + live keeps ~4 min, visible + idle waits 15 min, hidden waits 30 min', async () => {
  const counts = {};
  for (const [label, activity] of [
    ['live', () => ({ visible: true, live: true })],
    ['idle', () => ({ visible: true, live: false })],
    ['hidden', () => ({ visible: false, live: false })],
    ['default', undefined],
  ]) {
    const { provider, state } = rig({ answer: (s) => okAnswer(s.clock), activity });
    await drive(provider, state, 120 * MIN);
    counts[label] = state.attempts.length;
  }
  assert.equal(IDLE_STALE_AFTER_MS, 15 * MIN);
  assert.equal(HIDDEN_STALE_AFTER_MS, 30 * MIN);
  assert.deepEqual(counts, { live: 30, idle: 8, hidden: 4, default: 30 });
});

test('cadence follows the window: showing it with a live session refreshes at once', async () => {
  const view = { visible: false, live: true };
  const { provider, state } = rig({ answer: (s) => okAnswer(s.clock), activity: () => view });
  await drive(provider, state, 20 * MIN);
  assert.equal(state.attempts.length, 1);
  view.visible = true;
  await provider.getUsage('a');
  assert.equal(state.attempts.length, 2, 'a 20-min-old sample is stale for a visible live account');
  // setActivity replaces the hook; a hook that throws counts as visible + live.
  const throws = rig({ answer: (s) => okAnswer(s.clock) });
  throws.provider.setActivity(() => { throw new Error('boom'); });
  await drive(throws.provider, throws.state, 10 * MIN);
  assert.equal(throws.state.attempts.length, 3, 'a broken activity hook falls back to live cadence');
});

test('a weeks-old tee is not shown as "0% used" when the endpoint fails at startup', async () => {
  const teePath = path.join('/fake-tee', 'usage-a.json');
  const tee = (updatedAt) => JSON.stringify({
    updated_at: updatedAt,
    rate_limits: { five_hour: { used_percentage: 40, resets_at: START / 1000 - 3600 }, seven_day: { used_percentage: 60, resets_at: START / 1000 - 3600 } },
    cost: { total_cost_usd: 1 },
  });
  const old = rig({ files: { [teePath]: tee('2026-10-05T12:00:00Z') }, answer: () => ({ unavailable: true, reason: 'Claude usage request failed: HTTP 429 (rate limited)' }) });
  const row = await old.provider.getUsage('a');
  assert.equal(row.unavailable, true);
  assert.match(row.reason, /HTTP 429/);
  assert.equal(row.fiveHourPct, undefined);
  assert.equal(FAILING_SAMPLE_MAX_AGE_MS, 60 * MIN);

  // A recent tee (inside the hour) still shows, with the failure as a notice.
  const recent = rig({
    files: { [teePath]: JSON.stringify({ updated_at: new Date(START - 20 * MIN).toISOString(), rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 60 } }, cost: { total_cost_usd: 1 } }) },
    answer: () => ({ unavailable: true, reason: 'Claude usage request failed: HTTP 429 (rate limited)' }),
  });
  const recentRow = await recent.provider.getUsage('a');
  assert.equal(recentRow.fiveHourPct, 40);
  assert.match(recentRow.notice, /HTTP 429/);

  // With the endpoint off (harness), an old tee is shown as before.
  const offline = createUsageProvider({
    homes: { a: '/fake-home/a' },
    teeDir: '/fake-tee',
    now: () => new Date(START),
    readFile: async (file) => (file === teePath ? tee('2026-10-05T12:00:00Z') : enoent()),
    fetchRemoteUsage: null,
  });
  const offlineRow = await offline.getUsage('a');
  assert.equal(offlineRow.unavailable, undefined);
});

test('the Plan usage menu passes its refresh through as manual, and a notice becomes its reason', async (t) => {
  const { createPlanUsageProvider } = require('../../src/main/providers/plan-usage.js');
  const root = fs.mkdtempSync(path.join(realTmpDir(), 'plan-usage-manual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seen = [];
  const fetches = [];
  const plans = createPlanUsageProvider({
    home: root,
    env: { HARBOR_E2E: '1' },
    platform: 'linux',
    now: () => START,
    fetchImpl: async (url) => { fetches.push(url); throw new Error('no network in tests'); },
    profiles: [{ id: 'a', provider: 'claude' }],
    usageProvider: {
      getUsage: async (id, opts) => {
        seen.push(opts?.manual);
        return { fiveHourPct: 10, weeklyPct: 5, updatedAt: new Date(START - 10 * MIN).toISOString(), notice: 'Claude usage request failed: HTTP 429 (rate limited)' };
      },
    },
  });
  await plans.getPlans();
  const manual = await plans.getPlans({ manual: true });
  assert.deepEqual(seen, [false, true]);
  const row = manual.plans.find((p) => p.provider === 'claude');
  assert.match(row.reason, /HTTP 429/);
  assert.deepEqual(fetches, []);
});
