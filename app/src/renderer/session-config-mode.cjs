'use strict';

const { runStateCue } = require('../shared/session-run-state.cjs');
const { codexPermissionFromPolicy } = require('../shared/codex-permission.cjs');

// Does the config popover CHANGE this session, or START a new one?
//
// Getting this wrong has now cost Pat the same thing twice, and both times the
// symptom was a session he did not ask for:
//
//   2026-07-20: gated on a live drivable pane, so changing the model of a
//   session running in an outside terminal launched a new one ("the only route
//   is to create a new session"). Fixed by routing the switch through
//   adopt/resume instead of narrowing the question.
//
//   2026-08-02: gated on the id not being provisional, so changing the model of
//   a session started SECONDS AGO launched another one, in the same project,
//   with its own window ("it created a whole new window/session instead of what
//   it should do which is just update the current one").
//
// A `pane:<id>` window is not "no session": Claude Code writes no transcript
// until the first message, so a brand-new session HAS no id of its own yet and
// the pane is its identity. It is a running CLI in a real pty, and a model
// switch is typed into that pty exactly like every other session's. The one
// thing it cannot do is switch a session that has no pane at all, because a
// provisional id has nothing to resume from.
//
// Kept out of the component and pure so the rule has a test rather than a
// screenshot.

//   A CODEX session with a real id reconfigures too. Codex has no
//   in-pane model switch Harbor can type (its /model is an interactive
//   picker), but it RESUMES by id with -m / -c model_reasoning_effort / its
//   permission flags, so Apply resumes it on the new settings (see
//   codexApplyPlan). A provisional codex window (`pane:` / `live:`) has no id
//   to resume from yet, so it still launches.
function isReconfigure({ provider, runningProvider, sessionId, paneId } = {}) {
  if (!sessionId) return false;
  // A provider change is a different tool: that IS a new session.
  if (provider !== runningProvider) return false;
  if (provider === 'codex') return !/^(pane|live):/.test(String(sessionId));
  if (provider !== 'claude') return false;
  return !String(sessionId).startsWith('pane:') || Boolean(paneId);
}

// What the session is on right now, as a value the picker can compare against.
// The transcript header is the authority once there is one; before that (a
// session that has not spoken, which is exactly when this gets used) the launch
// config is what Harbor knows. Falling straight through to 'opus' meant a
// session launched on sonnet showed opus, and picking sonnet then counted as
// "no change" and sent nothing at all.
// A codex header's tone is a palette bucket ('other'), never a model value, so
// codex compares on the recorded slug.
function currentModel(header, launched, provider = 'claude') {
  if (provider !== 'claude') return header?.model?.id || launched || 'default';
  return header?.model?.tone || header?.model?.id || launched || 'opus';
}

function currentEffort(header, launched) {
  return header?.effort || launched || null;
}

/**
 * What Apply should actually send: only what the user changed.
 *
 * Effort is NOT gated on the header carrying one. Most transcripts never stamp
 * an effort, and requiring it made every effort change a silent no-op
 * (live-caught 2026-07-25). An UNKNOWN current effort means apply what was
 * picked, not drop it.
 */
function pendingSwitch({ header, launchedModel, launchedEffort, model, effort, provider = 'claude' } = {}) {
  const baseModel = currentModel(header, launchedModel, provider);
  const baseEffort = currentEffort(header, launchedEffort);
  return {
    model: model && model !== baseModel ? model : null,
    effort: effort && effort !== baseEffort ? effort : null,
  };
}

// The mode a codex session is in, as far as its transcript header can say.
// A header that carries no approval and sandbox policy (or no reviewer, for a
// workspace-write session) reads as unknown (null) here; the resume reads the
// full record off the rollout and keeps the mode when none is picked.
function currentCodexPermission(header) {
  return codexPermissionFromPolicy({
    approvalPolicy: header?.approvalPolicy,
    sandboxPolicy: header?.sandboxPolicy,
    approvalsReviewer: header?.approvalsReviewer,
  });
}

/**
 * How Apply reaches an existing CODEX session.
 *
 * Only what changed travels; the resume fills the rest from the rollout. A session
 * with no pane (dead, dormant, never reopened) simply resumes on the new
 * settings. A live pane Harbor drives is CLOSED through the same verified
 * worker close the workers menu uses, then resumed: codex cannot be
 * re-modelled from outside its TUI, and the close is the user's own click, the
 * same authority the workers menu's close already acts on. It is refused while
 * the session is working (the close would cut a turn off mid-flight) and for
 * a pane Harbor does not drive (an outside codex is not Harbor's to stop).
 */
function codexApplyPlan({
  session, pane, drivable, header, model, effort, permission, launchedModel, launchedEffort,
} = {}) {
  const next = pendingSwitch({ header, launchedModel, launchedEffort, model, effort, provider: 'codex' });
  const baseline = currentCodexPermission(header);
  const overrides = {
    model: next.model && next.model !== 'default' ? next.model : null,
    effort: next.effort && next.effort !== 'default' ? next.effort : null,
    permission: permission && permission !== baseline ? permission : null,
  };
  if (!overrides.model && !overrides.effort && !overrides.permission) return { kind: 'none', overrides };
  const outside = { kind: 'blocked', overrides, reason: 'This Codex session is running outside Harbor. Stop it there first; Harbor will not close a pane it does not drive.' };
  // Live with no Harbor pane is an outside codex: a resume would put a second
  // writer on its rollout.
  if (!pane?.paneId) return session?.isLive || session?.cliAlive ? outside : { kind: 'resume', overrides };
  if (drivable === false) return outside;
  const cue = runStateCue(session || {}, pane, header);
  if (cue?.kind !== 'ready' || header?.working !== false) {
    return { kind: 'blocked', overrides, reason: 'Codex is working. Apply restarts its pane, so wait until this turn finishes.' };
  }
  return { kind: 'restart', overrides };
}

module.exports = {
  isReconfigure, currentModel, currentEffort, pendingSwitch, currentCodexPermission, codexApplyPlan,
};
