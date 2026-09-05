'use strict';

// The rules that make "am I hardware accelerated right now?" answerable from
// inside the app. The incident these exist for is in docs/BACKLOG.md: two GPU
// process deaths on 2026-07-28, each followed within 30 to 60 ms by a 16 second
// main-process stall, and nothing anywhere recorded the rendering mode either
// side of them.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGpuTelemetry,
  summarizeFeatureStatus,
  summarizeGpuInfo,
  gpuProcessPresent,
  CHROMIUM_GPU_CRASH_LIMIT,
} = require('../../src/main/gpu-telemetry.js');

// A real Chromium status map, hardware path.
const ACCELERATED = {
  '2d_canvas': 'enabled',
  gpu_compositing: 'enabled',
  opengl: 'enabled_on',
  rasterization: 'enabled',
  video_decode: 'enabled',
  vulkan: 'disabled_off',
  webgl: 'enabled',
  webgl2: 'enabled',
};

// The same map when Chromium has fallen back, which is the state the 07-28
// forensics had to infer by enumerating /proc for a --type=gpu-process.
const SOFTWARE = {
  '2d_canvas': 'enabled',
  gpu_compositing: 'disabled_software',
  opengl: 'disabled_off',
  rasterization: 'disabled_software',
  video_decode: 'disabled_software',
  vulkan: 'disabled_off',
  webgl: 'unavailable_software',
  webgl2: 'unavailable_software',
};

function collector() {
  const lines = [];
  const log = (payload) => { lines.push(payload); };
  log.of = (kind) => lines.filter((l) => l.kind === kind);
  log.lines = lines;
  return log;
}

test('accelerated and software statuses are told apart by gpu_compositing', () => {
  assert.equal(summarizeFeatureStatus(ACCELERATED).accelerated, true);
  assert.equal(summarizeFeatureStatus(SOFTWARE).accelerated, false);
  assert.equal(summarizeFeatureStatus(SOFTWARE).compositing, 'disabled_software');
});

test('a missing answer is null, never a fabricated false', () => {
  // Same discipline as the context gauge refusing to guess a denominator: an
  // absent reading is not a negative reading.
  assert.equal(summarizeFeatureStatus(null).accelerated, null);
  assert.equal(summarizeFeatureStatus({}).accelerated, null);
  assert.equal(summarizeFeatureStatus({ webgl: 'enabled' }).accelerated, null);
});

test('degraded features are named, so a capture says WHICH ones fell back', () => {
  const s = summarizeFeatureStatus(SOFTWARE);
  assert.ok(s.degraded.includes('gpu_compositing=disabled_software'));
  assert.ok(s.degraded.includes('webgl=unavailable_software'));
  // An accelerated stack still names anything genuinely off, and nothing else.
  assert.deepEqual(summarizeFeatureStatus(ACCELERATED).degraded, ['vulkan=disabled_off']);
});

test('boot records the rendering mode and the adapter', async () => {
  const log = collector();
  const t = createGpuTelemetry({
    log,
    getFeatureStatus: () => ACCELERATED,
    getGpuInfo: async () => ({
      gpuDevice: [{ vendorId: 32902, deviceId: 29417, active: true }],
      auxAttributes: { glRenderer: 'Mesa Intel Graphics', glVendor: 'Intel' },
    }),
  });
  await t.readStatus('boot');

  const [line] = log.of('gpu-status');
  assert.equal(line.phase, 'boot');
  assert.equal(line.accelerated, true);
  assert.equal(line.adapter.glRenderer, 'Mesa Intel Graphics');
  assert.equal(line.gpuCrashes, 0);
  assert.equal(line.chromiumGaveUp, false);
});

test('a GPU death is counted and re-read, so the log says whether it recovered', async () => {
  const log = collector();
  const timers = [];
  let status = ACCELERATED;
  const t = createGpuTelemetry({
    log,
    getFeatureStatus: () => status,
    getGpuInfo: async () => null,
    setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} }; },
  });

  const handled = t.handleChildProcessGone({ type: 'GPU', reason: 'abnormal-exit', exitCode: 512 });
  assert.equal(handled, true);
  assert.equal(t.gpuCrashes, 1);

  const [gone] = log.of('gpu-process-gone');
  assert.equal(gone.reason, 'abnormal-exit');
  assert.equal(gone.exitCode, 512);

  // Chromium fell back between the crash and the recheck: the whole point.
  status = SOFTWARE;
  timers.forEach((fn) => fn());
  await new Promise((r) => setImmediate(r));

  const after = log.of('gpu-status').find((l) => l.phase === 'after-gpu-crash');
  assert.ok(after, 'a GPU crash must be followed by a status re-read');
  assert.equal(after.accelerated, false);
});

test('past Chromium\'s crash limit the log says it gave up, rather than leaving it inferred', async () => {
  const log = collector();
  const t = createGpuTelemetry({
    log,
    getFeatureStatus: () => SOFTWARE,
    getGpuInfo: async () => null,
    setTimeoutFn: () => ({ unref() {} }),
  });
  for (let i = 0; i < CHROMIUM_GPU_CRASH_LIMIT; i++) {
    t.handleChildProcessGone({ type: 'GPU', reason: 'abnormal-exit', exitCode: 512 });
  }
  const last = log.of('gpu-process-gone').at(-1);
  assert.equal(last.gpuCrashes, CHROMIUM_GPU_CRASH_LIMIT);
  assert.equal(last.chromiumGaveUp, true);
});

test('a non-GPU child death is ignored here, because index.js already logs it', () => {
  const log = collector();
  const t = createGpuTelemetry({ log, getFeatureStatus: () => ACCELERATED });
  // The 07-28 log also holds Utility/NetworkService deaths; double-logging them
  // would bury the GPU signal this module exists to surface.
  assert.equal(t.handleChildProcessGone({ type: 'Utility', reason: 'killed', exitCode: 15 }), false);
  assert.equal(t.gpuCrashes, 0);
  assert.equal(log.lines.length, 0);
});

test('telemetry never throws, whatever Chromium does', async () => {
  const log = collector();
  const t = createGpuTelemetry({
    log,
    getFeatureStatus: () => { throw new Error('GPU stack not ready'); },
    getGpuInfo: async () => { throw new Error('no gpu info'); },
  });
  // Boot must survive a GPU stack that is not there at all.
  const result = await t.readStatus('boot');
  assert.equal(result.accelerated, null);
  assert.equal(log.of('gpu-status').length, 1);
});

test('a throwing logger cannot break the app either', async () => {
  const t = createGpuTelemetry({
    log: () => { throw new Error('disk full'); },
    getFeatureStatus: () => ACCELERATED,
    setTimeoutFn: () => ({ unref() {} }),
  });
  await t.readStatus('boot');
  assert.equal(t.handleChildProcessGone({ type: 'GPU', reason: 'abnormal-exit', exitCode: 512 }), true);
});

// --- the watcher: the boot read alone is blind to a suspend teardown ---

test('a GPU process is detected from Chromium\'s own process table, not /proc', () => {
  assert.equal(gpuProcessPresent([{ type: 'Browser' }, { type: 'GPU' }, { type: 'Tab' }]), true);
  assert.equal(gpuProcessPresent([{ type: 'Browser' }, { type: 'Tab' }]), false);
  // Unavailable is null, not false: absence of an answer is not a negative one.
  assert.equal(gpuProcessPresent(undefined), null);
});

test('the status carries BOTH accelerated and gpuProcess, because one can lie', async () => {
  // The suspend hypothesis exactly: GpuDataManager still reports 'enabled' from
  // cache while the process is gone. Either number alone answers the wrong
  // question, which is how the 07-28 forensics needed /proc at all.
  const log = collector();
  const t = createGpuTelemetry({
    log,
    getFeatureStatus: () => ACCELERATED,
    getAppMetrics: () => [{ type: 'Browser' }],
    getGpuInfo: async () => null,
  });
  const r = await t.readStatus('boot');
  assert.equal(r.accelerated, true);
  assert.equal(r.gpuProcess, false);
  assert.equal(log.of('gpu-status')[0].gpuProcess, false);
});

test('the poll logs on CHANGE and stays silent otherwise', async () => {
  const log = collector();
  let metrics = [{ type: 'Browser' }, { type: 'GPU' }];
  const t = createGpuTelemetry({
    log,
    getFeatureStatus: () => ACCELERATED,
    getAppMetrics: () => metrics,
    getGpuInfo: async () => null,
    nowFn: () => 0, // heartbeat never due, so this isolates change detection
  });

  await t.sample();               // first sample establishes the baseline
  await t.sample();               // unchanged
  await t.sample();               // unchanged
  assert.equal(log.of('gpu-status').length, 0, 'an unchanged poll must not write a line');

  metrics = [{ type: 'Browser' }]; // the GPU process disappeared
  await t.sample();
  const lines = log.of('gpu-status');
  assert.equal(lines.length, 1, 'a change must write exactly one line');
  assert.equal(lines[0].phase, 'changed');
  assert.equal(lines[0].gpuProcess, false);
});

test('a heartbeat proves the watcher is alive without repeating the adapter', async () => {
  const log = collector();
  let now = 0;
  let gpuInfoCalls = 0;
  const t = createGpuTelemetry({
    log,
    getFeatureStatus: () => ACCELERATED,
    getAppMetrics: () => [{ type: 'GPU' }],
    getGpuInfo: async () => { gpuInfoCalls++; return null; },
    nowFn: () => now,
    heartbeatMs: 1000,
  });
  await t.sample();          // baseline, no line
  now = 5000;                // heartbeat due
  await t.sample();
  const hb = log.of('gpu-status');
  assert.equal(hb.length, 1);
  assert.equal(hb[0].phase, 'heartbeat');
  assert.equal(hb[0].adapter, null, 'a heartbeat must not pay the 1.5ms getGPUInfo cost');
  assert.equal(gpuInfoCalls, 0);
});

test('suspend and resume are logged as a pair, and resume re-reads after settling', async () => {
  const log = collector();
  const timers = [];
  let gpuUp = true;
  const t = createGpuTelemetry({
    log,
    getFeatureStatus: () => (gpuUp ? ACCELERATED : SOFTWARE),
    getAppMetrics: () => (gpuUp ? [{ type: 'GPU' }] : [{ type: 'Browser' }]),
    getGpuInfo: async () => null,
    setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} }; },
  });

  await t.handleSuspend();
  assert.equal(log.of('gpu-status')[0].phase, 'before-suspend');
  assert.equal(log.of('gpu-status')[0].gpuProcess, true, 'the reading going INTO the sleep');

  gpuUp = false;             // the hypothesis under test
  await t.handleResume();
  const resumed = log.of('gpu-status').find((l) => l.phase === 'after-resume');
  assert.ok(resumed, 'resume must read immediately');
  assert.equal(resumed.gpuProcess, false);

  gpuUp = true;              // Chromium brought it back a moment later
  timers.forEach((fn) => fn());
  await new Promise((r) => setImmediate(r));
  const settled = log.of('gpu-status').find((l) => l.phase === 'after-resume-settled');
  assert.ok(settled, 'gone-at-once differs from gone-for-good; both must be recorded');
  assert.equal(settled.gpuProcess, true);
});

test('start/stop own exactly one timer and never throw', () => {
  const log = collector();
  let intervals = 0;
  const t = createGpuTelemetry({
    log,
    getFeatureStatus: () => ACCELERATED,
    setIntervalFn: () => { intervals++; return { unref() {} }; },
    clearIntervalFn: () => { intervals--; },
  });
  t.start();
  t.start();                 // idempotent: a second start must not double-poll
  assert.equal(intervals, 1);
  t.stop();
  assert.equal(intervals, 0);
  t.stop();                  // stopping twice is a no-op, not a crash
});

test('a tick survives a throwing Chromium', async () => {
  const log = collector();
  const t = createGpuTelemetry({
    log,
    getFeatureStatus: () => { throw new Error('gone'); },
    getAppMetrics: () => { throw new Error('gone'); },
    nowFn: () => 0,
  });
  await t.sample();
  await t.sample();
  assert.equal(log.lines.length, 0, 'a broken read is not a state change');
});

test('adapter summary keeps identity and drops the rest', () => {
  const s = summarizeGpuInfo({
    gpuDevice: [{ vendorId: 4318, deviceId: 10082, active: true, driverVersion: '580.1', cudaComputeCapabilityMajor: 12 }],
    auxAttributes: { glRenderer: 'NVIDIA', amdSwitchable: false, glExtensions: 'x'.repeat(5000) },
  });
  assert.equal(s.devices[0].driverVersion, '580.1');
  assert.equal(s.glRenderer, 'NVIDIA');
  assert.equal('glExtensions' in s, false, 'the 5KB extension blob must not reach the log');
  assert.equal('cudaComputeCapabilityMajor' in s.devices[0], false);
});
