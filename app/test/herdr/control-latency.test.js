'use strict';

// Measures select->control-ready latency and debounced-release behavior against
// the isolated herdr harness. Never touches the user's live daemon.

const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');

const { HerdrClient } = require('../../src/main/herdr/client.js');
const { PaneStreamSupervisor } = require('../../src/main/herdr/streams.js');
const H = require('./harness.js');

describe('control latency (isolated)', { timeout: 60000 }, () => {
  let client;
  let sup;
  let paneA;
  let paneB;
  let baseline;

  const waitReady = async (paneId, { timeout = 8000 } = {}) => {
    await H.waitUntil(
      () => sup.controllerReady(paneId),
      { timeout, message: `control never ready for ${paneId}` },
    );
  };

  const acquireMs = async (paneId, size) => {
    const t0 = Date.now();
    sup.acquireControl(paneId, size);
    await waitReady(paneId);
    return Date.now() - t0;
  };

  before(async () => {
    H.stopNamedServer();
    H.deleteNamedSession();
    await H.sleep(400);
    baseline = H.herdrProcs();
    await H.startNamedServer();
    client = new HerdrClient({ socketPath: H.SOCKET_PATH });
    sup = new PaneStreamSupervisor({ socketPath: H.SOCKET_PATH });
    sup.on('error', (e) => console.log('[latency sup error]', e.message));

    const ws = await client.createWorkspace({ cwd: H.HOME, label: 'latency-ws', focus: true });
    const tab = await client.createTab({
      workspace_id: ws.workspace.workspace_id,
      cwd: H.HOME,
      label: 'latency-tab',
      focus: true,
    });
    paneA = tab.root_pane.pane_id;
    const split = await client.splitPane(paneA, { direction: 'right' });
    paneB = split.pane.pane_id;
    sup.attachObserver(paneA, { cols: 80, rows: 24 });
    sup.attachObserver(paneB, { cols: 80, rows: 24 });
    await H.sleep(300);
  });

  after(async () => {
    try {
      sup?.cancelScheduledRelease?.();
      sup?.detach();
    } catch {}
    await H.sleep(500);
    H.stopNamedServer();
    H.deleteNamedSession();
    await H.sleep(400);
    const post = H.herdrProcs();
    const leaked = [...post.keys()].filter((pid) => !baseline.has(pid));
    assert.deepEqual(leaked, [], 'no leaked herdr processes');
  });

  test('cold acquire latency baseline', async () => {
    const ms = await acquireMs(paneA, { cols: 80, rows: 24 });
    console.log('[latency] cold acquire->ready:', ms, 'ms');
    assert.ok(ms < 5000, `cold acquire too slow: ${ms}ms`);
    sup.releaseControl(paneA);
    await H.sleep(500);
  });

  test('simulated before-path: release then re-acquire (no debounce hold)', async () => {
    await acquireMs(paneA, { cols: 80, rows: 24 });
    sup.releaseControl(paneA);
    await H.sleep(350); // old blur path released immediately; child exit settles
    const t0 = Date.now();
    sup.acquireControl(paneA, { cols: 80, rows: 24 });
    await waitReady(paneA);
    const beforePathMs = Date.now() - t0;
    console.log('[latency] before-path release+re-acquire->ready:', beforePathMs, 'ms');
    sup.releaseControl(paneA);
    await H.sleep(350);
  });

  test('after-path: debounced blur cancelled on quick reselect', async () => {
    await acquireMs(paneA, { cols: 80, rows: 24 });
    sup.scheduleReleaseControl(paneA, 450);
    assert.ok(sup.controllerReady(paneA), 'still controlled during debounce');
    sup.cancelScheduledRelease();
    const t0 = Date.now();
    sup.acquireControl(paneA, { cols: 80, rows: 24 });
    if (!sup.controllerReady(paneA)) await waitReady(paneA);
    const reselectMs = Date.now() - t0;
    console.log('[latency] debounce-cancel reselect->ready:', reselectMs, 'ms');
    assert.ok(reselectMs < 200, `warm reselect should be instant, got ${reselectMs}ms`);
    sup.releaseControl(paneA);
    await H.sleep(500);
  });

  test('pane swap latency without explicit pre-release', async () => {
    const coldA = await acquireMs(paneA, { cols: 80, rows: 24 });
    sup.releaseControl(paneA);
    await H.sleep(500);

    await acquireMs(paneA, { cols: 80, rows: 24 });
    const t0 = Date.now();
    sup.acquireControl(paneB, { cols: 80, rows: 24 });
    await waitReady(paneB);
    const swapMs = Date.now() - t0;
    console.log('[latency] swap A->B (no pre-release):', swapMs, 'ms (cold A was', coldA, 'ms)');
    assert.equal(sup.controller?.paneId, paneB);
    assert.ok(!sup.controllerReady(paneA));
    assert.ok(sup.controllerReady(paneB));
    sup.releaseControl(paneB);
  });

  test('scheduled release eventually drops control', async () => {
    await acquireMs(paneA, { cols: 80, rows: 24 });
    sup.scheduleReleaseControl(paneA, 80);
    await H.sleep(200);
    assert.equal(sup.controller, null, 'scheduled release should clear controller');
  });
});
