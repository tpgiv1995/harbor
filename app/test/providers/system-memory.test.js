'use strict';
// The commit meter (2026-09-04): Windows kills sessions at the COMMIT limit,
// not when RAM runs out, and Harbor never showed that number. The provider
// samples Electron's system memory info, publishes a sample the rail can
// render, and toasts once per crossing of the warning line.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSystemMemoryProvider, sampleFromMemoryInfo, planMemoryAlert, pagefileGrowthMB, GROWTH_REFRESH_MS,
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

// A stock 16 GB laptop on a page file Windows manages (2026-10-29, the public
// user who was told to buy a second computer): ~2.75 GB page file, so a
// 19,200 MB limit today, 88% of it committed in ordinary use, on a 476 GB
// drive with 200 GB free.
const LAPTOP = { total: 16 * 1024 * 1024, free: 3 * 1024 * 1024, swapTotal: 19200 * 1024, swapFree: 2304 * 1024 };
const LAPTOP_PAGEFILE = {
  ramMB: 16384,
  automatic: true,
  files: [{ allocatedMB: 2816, maxMB: 0, volumeMB: 487424, freeMB: 204800 }],
};

test('a page file Windows manages can grow to 3 x RAM, capped at an eighth of its drive', () => {
  // min(max(3 x 16384, 4096), 487424 / 8) = 49152; minus the 2816 it holds now.
  assert.equal(pagefileGrowthMB(LAPTOP_PAGEFILE), 46336);
  const smallDrive = { ...LAPTOP_PAGEFILE, files: [{ ...LAPTOP_PAGEFILE.files[0], volumeMB: 128 * 1024 }] };
  assert.equal(pagefileGrowthMB(smallDrive), 16384 - 2816, 'a 128 GB drive caps the file at 16 GB');
  const tinyRam = { ramMB: 1024, automatic: true, files: [{ allocatedMB: 1024, maxMB: 0, volumeMB: 487424, freeMB: 204800 }] };
  assert.equal(pagefileGrowthMB(tinyRam), 4096 - 1024, '4 GB is the floor when 3 x RAM is smaller');
});

test('a page file never grows into disk space that is not free', () => {
  const fullDrive = { ...LAPTOP_PAGEFILE, files: [{ ...LAPTOP_PAGEFILE.files[0], freeMB: 5 * 1024 }] };
  assert.equal(pagefileGrowthMB(fullDrive), 4 * 1024, '1 GB of the free space is left to the volume');
  const noFree = { ...LAPTOP_PAGEFILE, files: [{ ...LAPTOP_PAGEFILE.files[0], freeMB: 512 }] };
  assert.equal(pagefileGrowthMB(noFree), 0);
});

test('a page file sized by hand keeps the meter it had, even with room to its maximum', () => {
  // This machine, read live 2026-10-29: 64 GB initial, 192 GB maximum, set by hand.
  const legion = { ramMB: 64793, automatic: false, files: [{ allocatedMB: 65536, maxMB: 196608, volumeMB: 1951047, freeMB: 558830 }] };
  assert.equal(pagefileGrowthMB(legion), 0);
  assert.deepEqual(sampleFromMemoryInfo(LIVE, 1000, 0), sampleFromMemoryInfo(LIVE, 1000));
  const fixed = { ramMB: 16384, automatic: false, files: [{ allocatedMB: 8192, maxMB: 8192, volumeMB: 487424, freeMB: 204800 }] };
  assert.equal(pagefileGrowthMB(fixed), 0);
  const systemSizedFile = { ramMB: 16384, automatic: false, files: [{ allocatedMB: 4096, maxMB: 0, volumeMB: 487424, freeMB: 204800 }] };
  assert.equal(pagefileGrowthMB(systemSizedFile), 49152 - 4096, 'a 0 maximum on one file means Windows sizes that file');
});

test('no page file, or a reading that makes no sense, adds no room', () => {
  assert.equal(pagefileGrowthMB({ ramMB: 16384, automatic: true, files: [] }), 0);
  assert.equal(pagefileGrowthMB({}), 0);
  assert.equal(pagefileGrowthMB(), 0);
  assert.equal(pagefileGrowthMB({ ramMB: 'x', automatic: true, files: [{ allocatedMB: 2816, maxMB: 0 }] }), 0);
  assert.equal(pagefileGrowthMB({ ramMB: 16384, automatic: true, files: [null, { maxMB: 0 }] }), 0);
});

test('the meter divides by the ceiling the page file can reach, and keeps the limit as it stands today', () => {
  const today = sampleFromMemoryInfo(LAPTOP, 1000);
  assert.equal(today.commitPct, 88, 'the old meter: 88% of 19,200 MB, red');
  const s = sampleFromMemoryInfo(LAPTOP, 1000, pagefileGrowthMB(LAPTOP_PAGEFILE));
  assert.equal(s.commitUsedMB, 16896);
  assert.equal(s.commitLimitNowMB, 19200);
  assert.equal(s.commitLimitMB, 19200 + 46336);
  assert.equal(s.commitPct, 25.8);
});

test('a stock laptop in ordinary use does not toast, and its page file is read once per refresh window', async () => {
  let clock = 0;
  let growthReads = 0;
  const toasts = [];
  const provider = createSystemMemoryProvider({
    read: () => LAPTOP,
    readGrowth: async () => { growthReads += 1; return pagefileGrowthMB(LAPTOP_PAGEFILE); },
    now: () => clock,
    notify: (title, body) => toasts.push({ title, body }),
    intervalMs: 3_600_000,
  });
  await provider.tick();
  assert.equal(provider.current().commitPct, 25.8);
  assert.equal(toasts.length, 0, '88% of the limit today is 26% of the real wall');
  clock += GROWTH_REFRESH_MS - 1;
  await provider.tick();
  assert.equal(growthReads, 1, 'no second CIM read inside the window');
  clock += 1;
  await provider.tick();
  assert.equal(growthReads, 2, 'and one more once it has passed');
});

test('a page-file read that fails leaves the stricter meter, and never throws', async () => {
  const toasts = [];
  const provider = createSystemMemoryProvider({
    read: () => LAPTOP,
    readGrowth: async () => { throw new Error('CIM timed out'); },
    now: () => 0,
    log: () => {},
    notify: (title, body) => toasts.push({ title, body }),
    intervalMs: 3_600_000,
  });
  await assert.doesNotReject(() => provider.tick());
  assert.equal(provider.current().commitPct, 88);
  assert.equal(toasts.length, 1, 'with no room known, 88% is still past the line');
});

test('an injected memory reader never triggers a real page-file read', async () => {
  // The suites above inject `read`; without `readGrowth` the provider must not
  // spawn PowerShell on the machine running the tests.
  const provider = createSystemMemoryProvider({ read: () => LIVE, intervalMs: 3_600_000 });
  await provider.tick();
  assert.equal(provider.current().commitLimitMB, provider.current().commitLimitNowMB);
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
