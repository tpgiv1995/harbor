'use strict';
// The commit meter (2026-09-04): Windows kills sessions at the COMMIT limit,
// not when RAM runs out, and Harbor never showed that number. The provider
// samples Electron's system memory info, publishes a sample the rail can
// render, and toasts once per crossing of the warning line.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSystemMemoryProvider, sampleFromMemoryInfo, planMemoryAlert,
} = require('../../src/main/providers/system-memory.js');

// The real numbers from the evening this shipped (KB, Electron's shape).
const LIVE = { total: 66347960, free: 32049180, swapTotal: 108291000, swapFree: 19545316 };

test('a sample converts Electron KB to MB and reports commit and physical use', () => {
  const s = sampleFromMemoryInfo(LIVE, 1000);
  assert.equal(s.at, 1000);
  assert.equal(s.commitLimitMB, 105753);
  assert.equal(s.commitUsedMB, 105753 - 19087);
  assert.equal(s.commitPct, 82);
  assert.equal(s.physTotalMB, 64793);
  assert.equal(s.physUsedMB, 64793 - 31298);
});

test('a missing or malformed reading yields no sample rather than a lie', () => {
  assert.equal(sampleFromMemoryInfo(null), null);
  assert.equal(sampleFromMemoryInfo({ total: 1 }), null);
  assert.equal(sampleFromMemoryInfo({ swapTotal: 0, swapFree: 0 }), null);
});

test('the alert fires once on crossing the line and re-arms only below the lower line', () => {
  let state = { armed: true };
  const step = (pct) => { state = planMemoryAlert({ pct, armed: state.armed, warnAt: 85, rearmBelow: 78 }); return state.notify; };
  assert.equal(step(70), false);
  assert.equal(step(84.9), false);
  assert.equal(step(85), true, 'crossing 85 notifies');
  assert.equal(step(90), false, 'staying above does not notify again');
  assert.equal(step(80), false, 'dipping to 80 is not yet re-armed');
  assert.equal(step(86), false, 'so a bounce back up stays quiet');
  assert.equal(step(77), false, 'below 78 re-arms silently');
  assert.equal(step(85), true, 'and the next crossing notifies again');
});

test('the provider publishes samples to subscribers and toasts through the injected notifier', async () => {
  let reading = LIVE;
  const toasts = [];
  const seen = [];
  const provider = createSystemMemoryProvider({
    read: () => reading,
    now: () => 42,
    notify: (title, body) => toasts.push({ title, body }),
    warnAt: 85,
    rearmBelow: 78,
    intervalMs: 3_600_000,
  });
  provider.subscribe((sample) => seen.push(sample));
  await provider.tick();
  assert.equal(seen.length, 1);
  assert.equal(provider.current().commitPct, 82);
  assert.equal(toasts.length, 0, '82% is under the line');

  reading = { ...LIVE, swapFree: 10_000_000 }; // ~90.8%
  await provider.tick();
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].body, /commit at 91%/);
  await provider.tick();
  assert.equal(toasts.length, 1, 'no repeat while it stays high');

  reading = { ...LIVE, swapFree: 40_000_000 }; // ~63%
  await provider.tick();
  reading = { ...LIVE, swapFree: 10_000_000 };
  await provider.tick();
  assert.equal(toasts.length, 2, 're-armed after the dip, so the next crossing toasts again');
});

test('a reader that fails keeps the last good sample and never throws', async () => {
  let fail = false;
  const provider = createSystemMemoryProvider({
    read: () => { if (fail) throw new Error('CIM timed out'); return LIVE; },
    log: () => {},
    intervalMs: 3_600_000,
  });
  await provider.tick();
  const first = provider.current();
  fail = true;
  await assert.doesNotReject(() => provider.tick());
  assert.equal(provider.current(), first);
});
