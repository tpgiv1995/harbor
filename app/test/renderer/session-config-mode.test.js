'use strict';

// The config popover's one real decision: change THIS session, or start a new
// one. Both times it got this wrong the symptom was identical and expensive, a
// session Pat did not ask for, so the rule is pinned here rather than in a
// screenshot: 2026-07-20 (an outside-terminal session could only be "changed"
// by launching a replacement) and 2026-08-02 (a session started seconds ago
// launched a second one in the same project, with its own window).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isReconfigure, currentModel, currentEffort, pendingSwitch,
} = require('../../src/renderer/session-config-mode.cjs');

test('1) a fresh pane-keyed session is RECONFIGURED, because its pane is its identity', () => {
  // The 2026-08-02 case, in full: a provisional window with a live pane.
  assert.equal(isReconfigure({
    provider: 'claude',
    runningProvider: 'claude',
    sessionId: 'pane:7',
    paneId: 7,
  }), true);
  // With no pane there is nothing to type into and no id to resume from, so a
  // launch is the honest answer.
  assert.equal(isReconfigure({
    provider: 'claude', runningProvider: 'claude', sessionId: 'pane:7', paneId: null,
  }), false);
});

test('2) an ordinary session reconfigures with or without a pane', () => {
  // Dead or running in an outside terminal: the switch routes through
  // resume/adopt in the parent. This is the 2026-07-20 rule, kept.
  for (const paneId of [3, null]) {
    assert.equal(isReconfigure({
      provider: 'claude', runningProvider: 'claude', sessionId: 'abc-123', paneId,
    }), true);
  }
});

test('3) a provider change is a new session, and so is no session at all', () => {
  assert.equal(isReconfigure({
    provider: 'codex', runningProvider: 'claude', sessionId: 'abc-123', paneId: 3,
  }), false);
  // Same provider, but not claude: codex/cursor have no in-session model switch.
  assert.equal(isReconfigure({
    provider: 'codex', runningProvider: 'codex', sessionId: 'abc-123', paneId: 3,
  }), false);
  assert.equal(isReconfigure({
    provider: 'claude', runningProvider: 'claude', sessionId: null, paneId: 3,
  }), false);
  assert.equal(isReconfigure(), false);
});

test('4) the current model comes from the header, then the launch, then opus', () => {
  assert.equal(currentModel({ model: { tone: 'sonnet', id: 'claude-sonnet-5' } }, 'opus'), 'sonnet');
  assert.equal(currentModel({ model: { id: 'claude-opus-4-1' } }, 'opus'), 'claude-opus-4-1');
  assert.equal(currentModel(null, 'sonnet'), 'sonnet', 'a session that has not spoken yet');
  assert.equal(currentModel(null, null), 'opus');
  assert.equal(currentEffort({ effort: 'high' }, 'xhigh'), 'high');
  assert.equal(currentEffort(null, 'xhigh'), 'xhigh');
  assert.equal(currentEffort(null, null), null);
});

test('5) Apply sends only what changed, and a launch value counts as current', () => {
  // A session LAUNCHED on sonnet with no transcript yet: picking sonnet is not
  // a change. Before the launch config was consulted this compared against a
  // hardcoded 'opus', so it sent a pointless switch and, worse, treated picking
  // opus as a no-op on a session that was not on opus.
  assert.deepEqual(pendingSwitch({
    header: null, launchedModel: 'sonnet', launchedEffort: 'xhigh', model: 'sonnet', effort: 'xhigh',
  }), { model: null, effort: null });
  assert.deepEqual(pendingSwitch({
    header: null, launchedModel: 'sonnet', launchedEffort: 'xhigh', model: 'opus', effort: 'xhigh',
  }), { model: 'opus', effort: null });
  // An UNKNOWN current effort means apply what was picked, never drop it
  // (live-caught 2026-07-25: most transcripts never stamp an effort, so gating
  // on the header made every effort change a silent no-op).
  assert.deepEqual(pendingSwitch({
    header: null, launchedModel: null, launchedEffort: null, model: 'opus', effort: 'high',
  }), { model: null, effort: 'high' });
  // The header still outranks the launch once the session has spoken.
  assert.deepEqual(pendingSwitch({
    header: { model: { tone: 'haiku' }, effort: 'low' },
    launchedModel: 'opus',
    launchedEffort: 'xhigh',
    model: 'haiku',
    effort: 'low',
  }), { model: null, effort: null });
});

// SUBSTRATE-3: minted claude sessions reconfigure on their real id. The pane:
// branch stays for codex-style provisional windows Pat can still open on claude
// (harness, restored stage, or a codex pane misread as claude elsewhere).
test('6) a minted claude session reconfigures on its real id without pane:', () => {
  assert.equal(isReconfigure({
    provider: 'claude',
    runningProvider: 'claude',
    sessionId: '8e5466c1-960d-4e97-b8e3-999edee069dd',
    paneId: 'w4:p1',
  }), true);
  assert.equal(isReconfigure({
    provider: 'claude',
    runningProvider: 'claude',
    sessionId: '8e5466c1-960d-4e97-b8e3-999edee069dd',
    paneId: null,
  }), true);
});
