'use strict';

// ONE STATUS FEED INTO THE NOTIFIER. main/index.js used to run a second
// session subscription per live-pane set beside the sidebar bridge's own. On
// sessiond it ignored its pane list, polled every session once a second, and
// was rebuilt unseeded on every pane-set change, so it replayed every pane's
// events into the bridge and would hand each status to the notifier twice.
// The bridge's subscription is now the only feed, and the notifier is seeded
// from the snapshot that subscription was seeded with, at boot and on every
// reconnect.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');
const { SessionDaemonClient } = require('../../src/main/session-daemon/client.js');

test('main/index.js feeds the notifier from the bridge subscription only', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
  assert.doesNotMatch(source, /subscribeAgentStatus/);
  assert.equal((source.match(/\.onPaneAgentStatus\(/g) || []).length, 0, 'nothing outside the bridge feeds its status door');
  assert.match(source, /sidebarBridge\.emitter\.on\('daemon-snapshot', \(snapshot\) => notifier\?\.seedFromSnapshot\(snapshot\)\)/);
  assert.equal(typeof SessionDaemonClient.prototype.subscribeAgentStatus, 'undefined');
});

test('the bridge hands out its boot snapshot at start and again after a reconnect', { timeout: 15_000 }, async (t) => {
  const history = new EventEmitter();
  Object.assign(history, { listSessions: async () => [], sessionHomes: async () => ({}), close() {} });
  const subscriptions = [];
  let boots = 0;
  const client = {
    bootstrap: async () => {
      boots += 1;
      const subscription = new EventEmitter();
      subscription.close = () => {};
      subscriptions.push(subscription);
      const panes = [{ pane_id: 'p', workspace_id: 'w', agent: 'claude', agent_status: boots === 1 ? 'working' : 'idle' }];
      return { snapshot: { workspaces: [{ workspace_id: 'w', label: 'Synthetic project' }], panes }, subscription };
    },
  };
  const bridge = createSidebarBridge({ history, providerHistory: null, providerSessionLinker: null, delegationIndex: null, createControlClient: () => client });
  t.after(() => bridge.close());
  const seeds = [];
  bridge.emitter.on('daemon-snapshot', (snapshot) => seeds.push(snapshot.panes.map((pane) => pane.agent_status)));
  bridge.emitter.on('error', () => {});
  await bridge.start();
  assert.deepEqual(seeds, [['working']]);
  subscriptions[0].emit('close');
  const deadline = Date.now() + 10_000;
  while (seeds.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seeds, [['working'], ['idle']]);
});
