'use strict';

// SUBSTRATE-3 audit: which code still emits session id upgrades (replacesKey) after
// caller-minted claude ids shipped. Minting removed ONE trigger (claude launch
// pane:<id> -> transcript id), not the mechanism.

const test = require('node:test');
const assert = require('node:assert/strict');

const { revealNewSessionWindow } = require('../../src/main/new-session-window.cjs');

function captureReveal(provider, sessionId) {
  const emitted = [];
  return {
    emitted,
    run: () => revealNewSessionWindow({
      result: { sessionId },
      provider,
      cwd: '/work/project',
      account: 'team',
      model: provider === 'codex' ? 'gpt-5.6-sol' : 'opus',
      effort: 'xhigh',
      preIds: new Set(),
      knownIds: new Set(),
      sinceMs: 0,
      findFreshPane: async () => ({ paneId: 'fresh-pane', workspaceId: 'w1' }),
      findFreshTranscript: async () => 'codex-linked-id',
      setLink: () => {},
      focusPane: async () => {},
      emitLaunched: (payload) => emitted.push(payload),
      onPaneReady: async () => {},
      refreshHistory: async () => {},
    }),
  };
}

test('emitter 1) codex launch still emits replacesKey when its rollout appears', async () => {
  const fx = captureReveal('codex', 'ignored-for-codex');
  await fx.run();
  const upgrade = fx.emitted.find((e) => e.replacesKey);
  assert.ok(upgrade, 'codex must still upgrade a provisional window');
  assert.equal(upgrade.replacesKey, 'pane:fresh-pane');
  assert.equal(upgrade.sessionId, 'codex-linked-id');
});

test('emitter 1) claude minted launch never emits replacesKey', async () => {
  const fx = captureReveal('claude', 'claude-minted-id');
  await fx.run();
  assert.equal(fx.emitted.length, 1);
  assert.equal(fx.emitted[0].sessionId, 'claude-minted-id');
  assert.equal(fx.emitted[0].replacesKey, undefined);
  assert.equal(fx.emitted[0].provisional, undefined);
});

// Emitter 2 is the `provider-session-linked` handler in main/index.js. It is
// registered inside createWindow on a live sidebar bridge, so it cannot be
// imported and driven the way emitter 1 can. Since the 2026-11-09 Codex
// thread-following change the handler delegates to publishProviderLink
// (providers/provider-link-events.js), which IS importable: the source check
// below only pins the delegation, and the upgrade itself is driven for real.
// (The previous version of this spec built its own array of keys and asserted
// on that, so it would have passed no matter what main did. A spec that cannot
// fail when its subject changes is not evidence of anything.)
test('emitter 2) provider-session-link still upgrades BOTH pane: and live: keys in main', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
  const handler = source.match(/on\('provider-session-linked'[\s\S]{0,600}?\n\s*\}\);/);
  assert.ok(handler, 'the provider-session-linked handler must still exist in main/index.js');
  assert.match(handler[0], /publishProviderLink\(link,/, 'main must hand every link to publishProviderLink');
  const { publishProviderLink } = require('../../src/main/providers/provider-link-events.js');
  const emitted = [];
  publishProviderLink({ paneId: 'p1', sessionId: 'codex-linked-id', provider: 'codex' }, null,
    (channel, payload) => emitted.push({ channel, payload }));
  assert.deepEqual(emitted.map((e) => e.payload.replacesKey), ['pane:p1', 'live:p1'],
    'must upgrade both the pane-keyed and the live-keyed window');
  assert.ok(emitted.every((e) => e.channel === 'session:launched' && e.payload.sessionId === 'codex-linked-id'));
  // Guards the audit's conclusion: while this emitter lives, renamedDraftStore
  // has a live trigger for ANY provider and cannot be removed.
});
