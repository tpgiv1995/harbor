'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ago, formatWindow, formatResets } = require('../../src/renderer/plan-usage-format.cjs');
const { resetBadge, resetTooltip } = require('../../src/renderer/sidebar/usage-reset.cjs');
const now = new Date(2026, 9, 1, 12).getTime();

test('plan-usage format shares exact rail reset time and tooltip', () => {
  for (const kind of ['fiveHour', 'weekly']) {
    const w = { kind, usedPct: 42, resetsAt: (now + 27 * 3600000) / 1000 };
    const f = formatWindow(w, now);
    assert.ok(f.reset.endsWith(resetBadge(w.resetsAt, { window: kind, nowMs: now })));
    assert.equal(f.tooltip, resetTooltip({ window: kind, pct: w.usedPct, resetsAt: w.resetsAt, nowMs: now }));
  }
});
test('plan-usage format clamps bars but preserves percentages and unknowns', () => {
  assert.equal(formatWindow({ kind: 'weekly', usedPct: 120 }).width, 100);
  assert.equal(formatWindow({ kind: 'weekly', usedPct: 120 }).label, 'Week 120%');
  assert.equal(formatWindow({ kind: 'fiveHour', usedPct: null }).label, '5h unknown');
  assert.equal(formatWindow({ kind: 'fiveHour', usedPct: 0, rolled: true }).reset, 'window reset');
  assert.equal(formatWindow({ kind: 'weekly', usedPct: 75 }).color, 'var(--warn)');
});
test('plan-usage format preserves sub-one usage for every provider and keeps Cursor breakdown in its tooltip', () => {
  for (const kind of ['fiveHour', 'weekly', 'monthly', 'other']) {
    for (const usedPct of [0.01, 0.4, 0.99]) {
      const formatted = formatWindow({ kind, usedPct }, now);
      assert.ok(formatted.label.endsWith(' <1%'));
      assert.ok(formatted.tooltip.includes('<1% used'));
      assert.equal(formatted.width, usedPct);
    }
    assert.ok(formatWindow({ kind, usedPct: 0 }, now).label.endsWith(' 0%'));
    assert.ok(formatWindow({ kind, usedPct: 1 }, now).label.endsWith(' 1%'));
  }
  const cursor = formatWindow({ kind: 'monthly', usedPct: 0.4, includedPct: 0.4,
    autoPct: 0, apiPct: 0.4, unit: 'USD', used: 5, limit: 20 }, now);
  assert.equal(cursor.label, 'Included <1%');
  assert.equal(cursor.tooltip, 'Included <1% used; Auto 0% used; API <1% used; reset unknown');
  assert.ok(!JSON.stringify(cursor).includes('$'));
  const missing = formatWindow({ kind: 'monthly', usedPct: 3, includedPct: 3, autoPct: null, apiPct: null }, now);
  assert.ok(!missing.tooltip.includes('Auto'));
  assert.ok(!missing.tooltip.includes('API'));
});
test('plan-usage format distinguishes known zero resets and unknown reset counts', () => {
  assert.equal(formatResets(null), 'Resets left: unknown');
  assert.equal(formatResets({ available: 0 }), 'Resets left: 0');
  assert.equal(formatResets({ available: 2, nextExpiresAt: new Date(2026, 9, 3, 12).getTime() / 1000 }), 'Resets left: 2 (next expires Oct 3)');
});
test('plan-usage freshness handles missing, future, minute, hour and day stamps', () => {
  assert.equal(ago(null, now), 'time unknown');
  assert.equal(ago(new Date(now + 60000).toISOString(), now), '<1m ago');
  assert.equal(ago(new Date(now - 240000).toISOString(), now), '4m ago');
  assert.equal(ago(new Date(now - 7200000).toISOString(), now), '2h ago');
  assert.equal(ago(new Date(now - 172800000).toISOString(), now), '2d ago');
});
