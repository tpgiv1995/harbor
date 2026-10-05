'use strict';
// The rail's boot must degrade the way the terminal bridge's already does.
//
// Live-caught 2026-09-04: sidebarBridge.start() awaited refreshHistory() with
// no guard, so any index worker failure at boot (a cache rename that lost the
// race against the Harbor Mobile server's copy of the same worker, on the same
// file) rejected start(), rejected the Promise.all in the boot chain, and the
// app called app.exit(1) before creating a window. Six boots that evening; the
// ones that died this way left no window, no log line, and no clue. The daemon
// was healthy and every session alive the whole time.
//
// The rule: a history failure at boot costs the history ROWS until the next
// successful refresh, never the daemon connection and never the process. And
// the bridge retries the failed refresh on its own clock, because a quiet
// machine (no transcript writes) would otherwise never trigger one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');

function fakeHistory({ failFirst = 0 } = {}) {
  const history = new EventEmitter();
  let calls = 0;
  history.calls = () => calls;
  history.listSessions = async () => {
    calls += 1;
    if (calls <= failFirst) {
      const error = new Error('EPERM: operation not permitted, rename index.json');
      error.code = 'EPERM';
      throw error;
    }
    return [{
      id: 'hist-1', lastActive: '2026-09-04 22:00', project: 'proj', title: 'a finished session',
      firstPrompt: 'do the thing', cwd: 'C:\\dev\\proj',
    }];
  };
  history.sessionHomes = async () => ({});
  history.sessionMeta = async () => ({});
  history.sessionPreview = async () => '';
  history.close = () => {};
  return history;
}

function fakeClient() {
  const subscription = new EventEmitter();
  subscription.close = () => {};
  return {
    bootstrap: async () => ({
      snapshot: {
        workspaces: [{ workspace_id: 'w1', label: 'proj', cwd: 'C:\\dev\\proj' }],
        panes: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'claude', agent_session: { kind: 'id', value: 'live-1' } }],
      },
      subscription,
    }),
  };
}

function sessionIds(model) {
  return (model.projects || []).flatMap((project) => project.sessions.map((session) => session.id)).sort();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a history failure at boot degrades to live rows and the daemon still connects', async () => {
  const history = fakeHistory({ failFirst: 1 });
  const bridge = createSidebarBridge({
    history,
    providerHistory: null,
    providerSessionLinker: null,
    createControlClient: () => fakeClient(),
    historyRetryMs: [10_000],
  });
  const errors = [];
  const updates = [];
  bridge.emitter.on('error', (error) => errors.push(error));
  bridge.emitter.on('update', (update) => updates.push(update));

  await assert.doesNotReject(() => bridge.start(), 'start must not reject when the index worker fails');
  assert.equal(errors.length, 1, 'the failure is reported, not hidden');
  assert.match(errors[0].message, /EPERM/);
  assert.deepEqual(sessionIds(bridge.getState().model), ['live-1'], 'the daemon connected: live rows are there without history');
  assert.ok(updates.length >= 1, 'the renderer was told what there is');
  bridge.close();
});

test('after a failed refresh the bridge retries on its own clock and recovers the rows', async () => {
  const history = fakeHistory({ failFirst: 1 });
  const bridge = createSidebarBridge({
    history,
    providerHistory: null,
    providerSessionLinker: null,
    createControlClient: () => fakeClient(),
    historyRetryMs: [40],
  });
  bridge.emitter.on('error', () => {});
  await bridge.start();
  assert.deepEqual(sessionIds(bridge.getState().model), ['live-1']);
  // No history-changed event is emitted here on purpose: the retry must come
  // from the bridge itself.
  await sleep(200);
  assert.ok(history.calls() >= 2, 'the bridge retried the refresh without an fs event');
  assert.deepEqual(sessionIds(bridge.getState().model), ['hist-1', 'live-1'], 'the history rows arrived on the retry');
  bridge.close();
});

test('a runtime refresh failure keeps the rows it already had', async () => {
  const history = fakeHistory({ failFirst: 0 });
  const bridge = createSidebarBridge({
    history,
    providerHistory: null,
    providerSessionLinker: null,
    createControlClient: () => fakeClient(),
    historyRetryMs: [10_000],
  });
  const errors = [];
  bridge.emitter.on('error', (error) => errors.push(error));
  await bridge.start();
  assert.deepEqual(sessionIds(bridge.getState().model), ['hist-1', 'live-1']);
  history.listSessions = async () => { throw new Error('worker exited with code 1'); };
  history.emit('history-changed');
  await sleep(400);
  assert.equal(errors.length, 1);
  assert.deepEqual(sessionIds(bridge.getState().model), ['hist-1', 'live-1'], 'a failed refresh never publishes fewer rows');
  bridge.close();
});
