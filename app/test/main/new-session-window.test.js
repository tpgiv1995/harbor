'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { revealNewSessionWindow } = require('../../src/main/new-session-window.cjs');

function fixture(provider, sessionId) {
  const emitted = [];
  const links = [];
  const transcriptCalls = [];
  const focused = [];
  return {
    emitted,
    links,
    transcriptCalls,
    focused,
    run: () => revealNewSessionWindow({
      result: { sessionId },
      provider,
      cwd: '/work/project',
      account: 'team',
      model: provider === 'codex' ? 'gpt-5.6-sol' : 'opus',
      effort: 'xhigh',
      preIds: new Set(['old-pane']),
      knownIds: new Set(['old-session']),
      sinceMs: 1234,
      findFreshPane: async () => ({ paneId: 'fresh-pane', workspaceId: 'fresh-workspace' }),
      findFreshTranscript: async (args) => {
        transcriptCalls.push(args);
        return 'codex-real-id';
      },
      setLink: (id, pane) => links.push([id, pane]),
      focusPane: (pane) => focused.push(pane),
      emitLaunched: (payload) => emitted.push(payload),
      onPaneReady: async () => {},
      refreshHistory: async () => {},
    }),
  };
}

test('claude opens the fresh pane on its minted real id without a provisional phase', async () => {
  const fx = fixture('claude', 'claude-minted-id');
  await fx.run();

  assert.deepEqual(fx.emitted, [{
    sessionId: 'claude-minted-id',
    paneId: 'fresh-pane',
    cwd: '/work/project',
    account: 'team',
    provider: 'claude',
    model: 'opus',
    effort: 'xhigh',
  }]);
  assert.deepEqual(fx.links, [[
    'claude-minted-id',
    { paneId: 'fresh-pane', workspaceId: 'fresh-workspace' },
  ]]);
  assert.equal(fx.transcriptCalls.length, 0, 'claude never enters provisional transcript discovery');
  assert.deepEqual(fx.focused, [{ paneId: 'fresh-pane', workspaceId: 'fresh-workspace' }]);
});

test('claude refuses to reveal a window when its required minted id is absent', async () => {
  const fx = fixture('claude', null);
  await assert.rejects(fx.run(), /claude launch returned no session id/);
  assert.deepEqual(fx.emitted, []);
  assert.deepEqual(fx.links, []);
  assert.equal(fx.transcriptCalls.length, 0);
});

test('codex still opens provisionally and upgrades when its transcript materializes', async () => {
  const fx = fixture('codex', 'must-not-be-used-for-codex');
  await fx.run();

  assert.deepEqual(fx.emitted, [
    {
      sessionId: 'pane:fresh-pane',
      paneId: 'fresh-pane',
      cwd: '/work/project',
      account: 'team',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      provisional: true,
    },
    {
      sessionId: 'codex-real-id',
      paneId: 'fresh-pane',
      cwd: '/work/project',
      account: 'team',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      replacesKey: 'pane:fresh-pane',
    },
  ]);
  assert.deepEqual(fx.links.map(([id]) => id), ['pane:fresh-pane', 'codex-real-id']);
  assert.equal(fx.transcriptCalls.length, 1, 'codex keeps transcript discovery live');
  assert.equal(fx.transcriptCalls[0].provider, 'codex');
  assert.equal(fx.transcriptCalls[0].timeoutMs, 10 * 60_000);
});
