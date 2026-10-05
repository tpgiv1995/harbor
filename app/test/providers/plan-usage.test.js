'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPlanUsageProvider, discoverCodexHomes, windowsFromLimits, readRolloutSample,
  jwtClaims, resetCredits, cursorWindow, TAIL_BYTES } = require('../../src/main/providers/plan-usage.js');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const io = fs.promises;
const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'plan-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  return { root, put };
}
const event = (limits, time = NOW - 60000) => JSON.stringify({ type: 'event_msg', timestamp: new Date(time).toISOString(), payload: { type: 'token_count', rate_limits: limits } });
const limits = { limit_id: 'codex', plan_type: 'example-plan', primary: { used_percent: 53, window_minutes: 10080, resets_at: NOW / 1000 + 600 }, secondary: null };

test('plan-usage discovers both home suffixes, env and configured homes, ignores missing and empty dirs, deduplicates', async (t) => {
  const { root, put } = fixture(t);
  for (const dir of ['.codex', '.codex-extra', 'custom', '.codex-empty', '.codexBad']) fs.mkdirSync(path.join(root, dir));
  put('.codex/auth.json', {}); put('.codex-extra/sessions/.keep', ''); put('custom/auth.json', {});
  const homes = await discoverCodexHomes({ io, home: root, env: { CODEX_HOME: path.join(root, 'custom') },
    profiles: [{ provider: 'codex', configHome: path.join(root, '.codex') }, { provider: 'codex', configHome: path.join(root, 'missing') }], platform: process.platform });
  assert.deepEqual(homes.map((p) => path.basename(p)).sort(), ['.codex', '.codex-extra', 'custom']);
});

test('plan-usage classifies windows by minutes, including weekly primary and expired secondary', () => {
  const windows = windowsFromLimits({ ...limits, secondary: { used_percent: 99, window_minutes: 300, resets_at: NOW / 1000 - 1 } }, NOW);
  assert.deepEqual(windows.map((w) => [w.kind, w.usedPct, w.resetsAt, w.rolled]), [['fiveHour', 0, null, true], ['weekly', 53, NOW / 1000 + 600, false]]);
  const endpoint = windowsFromLimits({ primary_window: { used_percent: 15, limit_window_seconds: 604800, reset_at: NOW / 1000 + 600 } }, NOW, true);
  assert.equal(endpoint[0].kind, 'weekly');
  assert.equal(windowsFromLimits({ primary: { used_percent: 8, window_minutes: 60 } }, NOW)[0].kind, 'other');
});

test('plan-usage reads a bounded tail of a large rollout and uses the event timestamp', async (t) => {
  const { root, put } = fixture(t);
  put('sessions/2026/10/01/rollout-a.jsonl', `${JSON.stringify({ payload: 'x'.repeat(2 * TAIL_BYTES) })}\n${event(limits)}\n`);
  let readBytes = 0; let position = 0; let closed = false;
  const counted = { ...io, open: async (...args) => { const h = await io.open(...args); return {
    stat: () => h.stat(), close: async () => { closed = true; await h.close(); },
    read: async (buffer, offset, length, pos) => { readBytes += length; position = pos; return h.read(buffer, offset, length, pos); },
  }; } };
  const sample = await readRolloutSample(root, counted, NOW);
  assert.equal(sample.windows[0].usedPct, 53); assert.equal(sample.updatedAt, new Date(NOW - 60000).toISOString());
  assert.equal(readBytes, TAIL_BYTES); assert.ok(position > 0); assert.equal(closed, true);
});

test('plan-usage compares event times across rollouts, ignores other meters and malformed tails', async (t) => {
  const { root, put } = fixture(t);
  put('sessions/2026/09/01/rollout-old.jsonl', `${event({ ...limits, primary: { ...limits.primary, used_percent: 75 } })}\n`);
  put('sessions/2026/10/01/rollout-new.jsonl', `${event(limits, NOW - 300000)}\n${event({ ...limits, limit_id: 'code-review' }, NOW)}\n{incomplete`);
  assert.equal((await readRolloutSample(root, io, NOW)).windows[0].usedPct, 75);
});

test('plan-usage reuses Claude provider, keeps unavailable profiles and exposes no JWT or account id', async (t) => {
  const { root, put } = fixture(t); const calls = [];
  const token = jwt({ email: 'user@example.com' });
  put('.codex/auth.json', { tokens: { id_token: token, access_token: 'synthetic-secret', account_id: 'synthetic-id' } });
  put('.codex/sessions/2026/10/01/rollout-a.jsonl', event(limits));
  const provider = createPlanUsageProvider({ home: root, env: { HARBOR_E2E: '1' }, io, now: () => NOW,
    profiles: [{ id: 'a', label: 'Example', provider: 'claude' }, { id: 'b', provider: 'claude' }],
    usageProvider: { getUsage: async (id) => { calls.push(id); return id === 'a' ? { fiveHourPct: 42, weeklyPct: 64, weeklyResetsAt: NOW / 1000 + 1000, updatedAt: new Date(NOW).toISOString() } : { unavailable: true, reason: 'No sample' }; } } });
  const result = await provider.getPlans(); assert.deepEqual(calls, ['a', 'b']);
  assert.equal(result.plans[0].windows[0].usedPct, 42); assert.equal(result.plans[1].reason, 'No sample');
  assert.equal(result.plans.find((p) => p.provider === 'codex').email, 'user@example.com');
  assert.equal(result.plans.find((p) => p.provider === 'cursor').unavailable, true);
  const serialized = JSON.stringify(result);
  for (const secret of [token, 'synthetic-secret', 'synthetic-id']) assert.ok(!serialized.includes(secret));
  assert.deepEqual(jwtClaims('malformed'), {});
  assert.deepEqual(jwtClaims(jwt(null)), {});
  assert.deepEqual(jwtClaims(jwt([])), {});
});

test('plan-usage reset count is authoritative, expiry only considers available future credits', () => {
  assert.deepEqual(resetCredits({ available_count: 2, credits: [
    { status: 'used', expires_at: new Date(NOW + 1000).toISOString() },
    { status: 'available', expires_at: new Date(NOW + 60000).toISOString() },
    { status: 'available', expires_at: new Date(NOW + 120000).toISOString() },
  ] }, NOW), { available: 2, nextExpiresAt: NOW / 1000 + 60 });
  assert.equal(resetCredits({}, NOW), null);
  assert.deepEqual(resetCredits({ available_count: 0 }, NOW), { available: 0, nextExpiresAt: null });
});

test('plan-usage Cursor meters included usage in cents and respects the reported percentage', () => {
  const w = cursorWindow({ billingCycleEnd: String(NOW + 86400000), planUsage: { includedSpend: 500, limit: 2000, totalPercentUsed: 30 } });
  assert.equal(w.usedPct, 30); assert.equal(w.used, 5); assert.equal(w.limit, 20); assert.equal(w.resetsAt, (NOW + 86400000) / 1000);
  assert.equal(cursorWindow({ planUsage: { includedSpend: 500, limit: 2000 } }).usedPct, 25);
  assert.equal(cursorWindow({}), null); assert.equal(cursorWindow({ planUsage: { limit: 0 } }), null);
});

test('plan-usage fixture fails closed and never reads homes', async (t) => {
  const { root, put } = fixture(t); put('fixture.json', { generatedAt: new Date(NOW).toISOString(), plans: [] });
  const provider = createPlanUsageProvider({ home: root, env: { HARBOR_PLAN_USAGE_FIXTURE: path.join(root, 'fixture.json') },
    io: { readFile: io.readFile, readdir: () => { throw Error('Must not discover'); } } });
  assert.deepEqual((await provider.getPlans()).plans, []);
  put('fixture.json', '{invalid'); await assert.rejects(provider.getPlans(), /fixture is unreadable or invalid/);
});

test('plan-usage coalesces concurrent reads', async (t) => {
  const { root } = fixture(t); let calls = 0;
  const provider = createPlanUsageProvider({ home: root, env: { HARBOR_E2E: '1' }, now: () => NOW,
    profiles: [{ id: 'a', provider: 'claude' }], usageProvider: { getUsage: async () => { calls++; return {}; } } });
  await Promise.all([provider.getPlans(), provider.getPlans()]); assert.equal(calls, 1);
});

test('plan-usage reads independent Claude accounts together and marks missing freshness', async (t) => {
  const { root } = fixture(t); const started = []; const releases = [];
  const provider = createPlanUsageProvider({ home: root, env: { HARBOR_E2E: '1' }, now: () => NOW,
    profiles: ['a', 'b', 'c'].map((id) => ({ id, provider: 'claude' })),
    usageProvider: { getUsage: (id) => { started.push(id); return new Promise((resolve) => releases.push(resolve)); } } });
  const result = provider.getPlans();
  assert.deepEqual(started, ['a', 'b', 'c'], 'all calls start before any completes');
  releases.forEach((resolve) => resolve({ fiveHourPct: 42, updatedAt: null }));
  const plan = (await result).plans[0];
  assert.equal(plan.stale, true); assert.equal(plan.reason, 'Usage sample has no timestamp.');
});
