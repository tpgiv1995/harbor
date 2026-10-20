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
  isReconfigure, currentModel, currentEffort, pendingSwitch, currentCodexPermission, codexApplyPlan,
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
  // Cursor has no in-session model switch and no resume-with-model: new session.
  assert.equal(isReconfigure({
    provider: 'cursor', runningProvider: 'cursor', sessionId: 'abc-123', paneId: 3,
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

// CODEX RECONFIGURES BY RESUMING. Its model switch is a picker
// inside its own TUI, but `codex resume -m X -c model_reasoning_effort=Y` takes
// new settings by id, so a codex session with a real id is CHANGED, not
// replaced. A provisional window has no id to resume from yet.
test('6) a codex session with a real id reconfigures; a provisional one still launches', () => {
  for (const paneId of [3, null]) {
    assert.equal(isReconfigure({ provider: 'codex', runningProvider: 'codex', sessionId: '01a14000-0000-7000-8000-000000000001', paneId }), true);
  }
  for (const sessionId of ['pane:3', 'live:3']) {
    assert.equal(isReconfigure({ provider: 'codex', runningProvider: 'codex', sessionId, paneId: 3 }), false);
  }
  // A codex header's tone is a palette bucket, so codex compares on the slug.
  assert.equal(currentModel({ model: { id: 'gpt-6-sol', tone: 'other' } }, null, 'codex'), 'gpt-6-sol');
  assert.equal(currentModel(null, 'gpt-6-luna', 'codex'), 'gpt-6-luna');
  assert.equal(currentModel(null, null, 'codex'), 'default');
});

test('7) the header names a codex mode only when it can name exactly one', () => {
  assert.equal(currentCodexPermission({ sandboxPolicy: 'danger-full-access', approvalPolicy: 'never' }), 'full');
  assert.equal(currentCodexPermission({ sandboxPolicy: { type: 'read-only' } }), 'read-only');
  // Workspace-write is auto OR ask depending on the reviewer, which the header
  // does not carry: unknown, never a guess.
  assert.equal(currentCodexPermission({ sandboxPolicy: 'workspace-write', approvalPolicy: 'on-request' }), null);
  assert.equal(currentCodexPermission({ sandboxPolicy: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' }), 'ask');
  assert.equal(currentCodexPermission(null), null);
});

const IDLE = { model: { id: 'gpt-6-sol' }, effort: 'high', sandboxPolicy: 'danger-full-access', working: false, lastSignal: 'idle' };

test('8) codex Apply: a dormant session resumes, an idle Harbor pane restarts, the rest refuse', () => {
  const base = { session: { id: 's' }, header: IDLE, model: 'gpt-6-luna', effort: 'high', permission: 'full' };
  // Only the model changed: the effort and the (recorded) full mode stay home.
  assert.deepEqual(codexApplyPlan({ ...base, pane: null }), {
    kind: 'resume', overrides: { model: 'gpt-6-luna', effort: null, permission: null },
  });
  assert.equal(codexApplyPlan({ ...base, pane: { paneId: 'p1' }, drivable: true }).kind, 'restart');
  // Nothing changed: nothing happens, whatever the pane is doing.
  assert.equal(codexApplyPlan({ ...base, model: 'gpt-6-sol', pane: { paneId: 'p1' }, drivable: true }).kind, 'none');
  // A permission change alone is a change.
  assert.deepEqual(codexApplyPlan({ ...base, model: 'gpt-6-sol', permission: 'auto', pane: null }).overrides, { model: null, effort: null, permission: 'auto' });
  // Picking "Codex default" is no model override: the resume keeps the record.
  assert.equal(codexApplyPlan({ ...base, model: 'default', pane: null }).kind, 'none');
  // Mid-turn: the close would cut the turn off.
  const busy = codexApplyPlan({ ...base, header: { ...IDLE, working: true, lastSignal: 'user-turn' }, pane: { paneId: 'p1' }, drivable: true });
  assert.equal(busy.kind, 'blocked');
  assert.match(busy.reason, /wait until this turn finishes/);
  // Not Harbor's pane, or live outside Harbor with no pane at all.
  assert.match(codexApplyPlan({ ...base, pane: { paneId: 'p1' }, drivable: false }).reason, /outside Harbor/);
  assert.match(codexApplyPlan({ ...base, session: { id: 's', isLive: true }, pane: null }).reason, /outside Harbor/);
});
