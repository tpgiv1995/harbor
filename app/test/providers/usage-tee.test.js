'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUsageProvider, NO_SAMPLE_REASON } = require('../../src/main/providers/usage.js');

function makeTeeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-usage-tee-'));
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), value);
  }
  return dir;
}

const TEE_PAYLOAD = JSON.stringify({
  account_email: 'tee@example.com',
  updated_at: '2026-07-17T01:30:00-05:00',
  rate_limits: {
    five_hour: { used_percentage: 31, resets_at: 1752750000 },
    seven_day: { used_percentage: 58, resets_at: 1753100000 },
  },
  cost: { total_cost_usd: 1.23 },
  model: 'Fable 5',
  session_id: 'tee-test',
});

test('usage falls back to the statusline tee file when no live sample exists', async () => {
  const teeDir = makeTeeDir({ 'usage-personal.json': TEE_PAYLOAD });
  const provider = createUsageProvider({
    homes: { personal: '/nonexistent-home' },
    teeDir,
    // Before the fixture's resets_at, so the expiry roll stays out of frame.
    now: () => new Date(1752700000 * 1000),
  });
  const usage = await provider.getUsage('personal');
  assert.equal(usage.unavailable, undefined);
  assert.equal(usage.fiveHourPct, 31);
  assert.equal(usage.weeklyPct, 58);
  assert.equal(usage.cost, 1.23);
  assert.equal(usage.fiveHourResetsAt, 1752750000);
  assert.equal(usage.weeklyResetsAt, 1753100000);
  assert.equal(usage.email, 'tee@example.com');
  assert.equal(usage.updatedAt, '2026-07-17T01:30:00-05:00');
});

test('in-memory sample wins over the tee file', async () => {
  const teeDir = makeTeeDir({ 'usage-personal.json': TEE_PAYLOAD });
  const provider = createUsageProvider({
    homes: { personal: '/nonexistent-home' },
    teeDir,
    now: () => new Date('2026-07-17T02:00:00-05:00'),
  });
  provider.recordStatuslinePayload('personal', {
    rate_limits: {
      five_hour: { used_percentage: 90 },
      seven_day: { used_percentage: 91 },
    },
    cost: { total_cost_usd: 9.99 },
  });
  const usage = await provider.getUsage('personal');
  assert.equal(usage.fiveHourPct, 90);
  assert.equal(usage.cost, 9.99);
});

test('missing tee file still reports the honest unavailable state', async () => {
  const teeDir = makeTeeDir({});
  const provider = createUsageProvider({
    homes: { team: '/nonexistent-home' },
    teeDir,
  });
  const usage = await provider.getUsage('team');
  assert.equal(usage.unavailable, true);
  assert.equal(usage.reason, NO_SAMPLE_REASON);
});

test('corrupt tee file degrades to unavailable, never throws', async () => {
  const teeDir = makeTeeDir({ 'usage-personal.json': '{not json' });
  const provider = createUsageProvider({
    homes: { personal: '/nonexistent-home' },
    teeDir,
  });
  const usage = await provider.getUsage('personal');
  assert.equal(usage.unavailable, true);
});

test('expired windows roll to 0% instead of showing stale percentages', async () => {
  const teeDir = makeTeeDir({ 'usage-personal.json': TEE_PAYLOAD });
  const provider = createUsageProvider({
    homes: { personal: '/nonexistent-home' },
    teeDir,
    // Past the 5h reset, before the weekly reset.
    now: () => new Date(1752800000 * 1000),
  });
  const usage = await provider.getUsage('personal');
  assert.equal(usage.fiveHourPct, 0);
  assert.equal(usage.fiveHourRolled, true);
  assert.equal(usage.fiveHourResetsAt, undefined);
  assert.equal(usage.weeklyPct, 58); // weekly window still active
  assert.equal(usage.weeklyResetsAt, 1753100000);
});
