'use strict';
// Codex owner liveness. Codex has no statusline tee and no
// beacon, so the transcript provider asks the bridge whether a live Harbor
// pane is running codex on the session. Two ways a pane names its codex
// session: the daemon reports it itself, or the provider linker pairs it from
// the agent's argv. Either one counts; a pane running a different agent, or
// a pane on another session, never vouches.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');

function fakeHistory() {
  const history = new EventEmitter();
  history.listSessions = async () => [];
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
        workspaces: [{ workspace_id: 'w1', label: 'proj', cwd: '/w/proj' }],
        panes: [
          { pane_id: 'p1', workspace_id: 'w1', agent: 'codex', agent_session: { kind: 'id', value: 'codex-named' } },
          { pane_id: 'p2', workspace_id: 'w1', agent: 'codex' },
          { pane_id: 'p3', workspace_id: 'w1', agent: 'claude', agent_session: { kind: 'id', value: 'claude-1' } },
        ],
      },
      subscription,
    }),
  };
}

function fakeLinker(links) {
  return {
    emitter: new EventEmitter(),
    apply: (panes) => panes.map((pane) => (links[pane.pane_id] && !pane.agent_session
      ? { ...pane, agent_session: { agent: pane.agent, kind: 'id', source: 'harbor:provider-link', value: links[pane.pane_id] } }
      : pane)),
    get: (paneId) => links[paneId] || null,
    resolveNow: () => false,
    start: () => {},
    close: () => {},
  };
}

test('a live pane running codex on the session vouches for its owner; nothing else does', async () => {
  const links = { p2: 'codex-linked' };
  const bridge = createSidebarBridge({
    history: fakeHistory(),
    providerHistory: null,
    providerSessionLinker: fakeLinker(links),
    createControlClient: () => fakeClient(),
    historyRetryMs: [10_000],
  });
  bridge.emitter.on('error', () => {});
  await bridge.start();
  assert.equal(bridge.providerPaneAlive('codex-named', 'codex'), true, 'the daemon named it');
  assert.equal(bridge.providerPaneAlive('codex-linked', 'codex'), true, 'the linker paired it');
  assert.equal(bridge.providerPaneAlive('claude-1', 'codex'), false, 'a claude pane is not a codex owner');
  assert.equal(bridge.providerPaneAlive('codex-elsewhere', 'codex'), false, 'no pane holds this session');
  delete links.p2; // the pane's codex exited, so the linker dropped the link
  assert.equal(bridge.providerPaneAlive('codex-linked', 'codex'), false);
  bridge.close();
});
