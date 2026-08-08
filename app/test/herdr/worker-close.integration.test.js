'use strict';

const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');

const { HerdrClient } = require('../../src/main/herdr/client.js');
const { createTerminalBridge } = require('../../src/main/terminal-bridge.js');
const H = require('./harness.js');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

describe('worker close (isolated named session)', { timeout: 60000 }, () => {
  let client;
  let bridge;

  before(async () => {
    await H.startNamedServer();
    client = new HerdrClient({ socketPath: H.SOCKET_PATH });
    bridge = createTerminalBridge({
      socketPath: H.SOCKET_PATH,
      env: { ...process.env, HARBOR_SESSION_BACKEND: 'herdr' },
      closePollIntervalMs: 100,
      closePollAttempts: 50,
    });
    await bridge.start();
  });

  after(async () => {
    bridge?.close();
    await H.stopAndWait();
  });

  async function scratchPane(label) {
    const ws = await client.createWorkspace({ cwd: H.HOME, label: `${label}-ws`, focus: true });
    const tab = await client.createTab({
      workspace_id: ws.workspace.workspace_id, cwd: H.HOME, label, focus: true,
    });
    const paneId = tab.root_pane.pane_id;
    const info = await client.processInfo(paneId);
    return { paneId, pid: info.process_info.shell_pid };
  }

  test('tab close verifies pane gone and exact shell process dead', async () => {
    const { paneId, pid } = await scratchPane('tab-close');
    assert.ok(pidAlive(pid), `scratch shell ${pid} starts alive`);

    const result = await bridge.closePaneTab(paneId);
    assert.deepEqual(result, { ok: true, method: 'tab', verified: true });
    await H.waitUntil(() => !pidAlive(pid), {
      timeout: 8000, interval: 100, message: `shell ${pid} remained alive after verified tab close`,
    });
    console.log(`[kill-verify poll] tab pane ${paneId}, exact shell pid ${pid}: gone`);
  });

  test('force signal SIGTERMs the documented exact process and polls it gone', async () => {
    const { paneId, pid } = await scratchPane('signal-close');
    assert.ok(pidAlive(pid), `scratch shell ${pid} starts alive`);

    const result = await bridge.closePaneTab(paneId, { force: true });
    assert.deepEqual(result, { ok: true, method: 'signal', verified: true });
    await H.waitUntil(() => !pidAlive(pid), {
      timeout: 8000, interval: 100, message: `shell ${pid} remained alive after verified SIGTERM`,
    });
    console.log(`[kill-verify poll] signal pane ${paneId}, exact shell pid ${pid}: gone`);
  });
});
