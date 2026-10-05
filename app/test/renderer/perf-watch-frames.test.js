'use strict';

// The stall watch asks "are frames still arriving" once per tick. It used to answer that with a
// requestAnimationFrame callback that re-requested itself forever, which wakes the renderer's
// main thread at the display rate (240 times a second on a 240 Hz panel) for the whole life of
// the window. These tests drive the INSTALLED watch against a fake window: a healthy second may
// cost one frame request per tick and no more, and a frozen compositor is still caught.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TICK_MS, RAF_STALL_MS } = require('../../src/renderer/perf-watch.cjs');

const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../src/renderer/perf-watch.js')).href;

function fakeWindow() {
  const world = { now: 1000, requests: 0, cancelled: 0, pending: new Map(), reports: [], nextId: 1 };
  Object.defineProperty(globalThis, 'performance', { value: { now: () => world.now, memory: null }, configurable: true });
  globalThis.document = {
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    activeElement: null,
  };
  globalThis.window = {
    harbor: { perf: { stall: (line) => world.reports.push(line) } },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn) => { world.requests += 1; const id = world.nextId++; world.pending.set(id, fn); return id; },
    cancelAnimationFrame: (id) => { if (world.pending.delete(id)) world.cancelled += 1; },
  };
  // One vsync: every callback requested so far runs once. A callback that re-requests itself is
  // picked up by the NEXT vsync, exactly as a browser does it.
  world.vsync = () => {
    const batch = [...world.pending.values()];
    world.pending.clear();
    for (const fn of batch) fn(world.now);
  };
  return world;
}

const context = { snapshot: () => ({}), noteKeydown() {} };
const VSYNCS_PER_TICK = 60; // 240 Hz for one 250 ms tick

function runTick(t, world, { frames }) {
  for (let i = 0; i < VSYNCS_PER_TICK; i++) {
    world.now += TICK_MS / VSYNCS_PER_TICK;
    if (frames) world.vsync();
  }
  t.mock.timers.tick(TICK_MS);
}

test('a healthy second costs one frame request per tick, not one per vsync', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const world = fakeWindow();
  const { installPerfWatch } = await import(moduleUrl);
  const uninstall = installPerfWatch(context);
  const ticks = 1000 / TICK_MS;
  for (let i = 0; i < ticks; i++) runTick(t, world, { frames: true });
  assert.ok(world.requests <= ticks + 1, `${world.requests} frame requests in one second; a self-re-requesting loop makes ${ticks * VSYNCS_PER_TICK}`);
  assert.deepEqual(world.reports, [], 'and a healthy window reports nothing');
  uninstall();
});

test('frames that stop while the window is focused are still reported, once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const world = fakeWindow();
  const { installPerfWatch } = await import(moduleUrl);
  const uninstall = installPerfWatch(context);
  runTick(t, world, { frames: true });
  const frozenTicks = Math.ceil(RAF_STALL_MS / TICK_MS) + 4;
  for (let i = 0; i < frozenTicks; i++) runTick(t, world, { frames: false });
  const stalls = world.reports.filter((r) => r.kind === 'compositor-stall');
  assert.equal(stalls.length, 1, 'one line per frozen period, not one per tick');
  assert.ok(stalls[0].ms >= RAF_STALL_MS);

  // Frames come back, then freeze again: that is a second period and a second line.
  for (let i = 0; i < 3; i++) runTick(t, world, { frames: true });
  for (let i = 0; i < frozenTicks; i++) runTick(t, world, { frames: false });
  assert.equal(world.reports.filter((r) => r.kind === 'compositor-stall').length, 2);
  uninstall();
});

test('uninstall cancels the outstanding frame request and asks for no more', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const world = fakeWindow();
  const { installPerfWatch } = await import(moduleUrl);
  const uninstall = installPerfWatch(context);
  assert.equal(world.pending.size, 1);
  uninstall();
  assert.equal(world.pending.size, 0);
  const before = world.requests;
  for (let i = 0; i < 4; i++) runTick(t, world, { frames: true });
  assert.equal(world.requests, before);
});
