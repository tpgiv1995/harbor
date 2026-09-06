'use strict';

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

function isReconfigure({ provider, runningProvider, sessionId, paneId } = {}) {
  if (!sessionId) return false;
  // A provider change is a different tool: that IS a new session.
  if (provider !== runningProvider) return false;
  if (provider !== 'claude') return false;
  return !String(sessionId).startsWith('pane:') || Boolean(paneId);
}

// What the session is on right now, as a value the picker can compare against.
// The transcript header is the authority once there is one; before that (a
// session that has not spoken, which is exactly when this gets used) the launch
// config is what Harbor knows. Falling straight through to 'opus' meant a
// session launched on sonnet showed opus, and picking sonnet then counted as
// "no change" and sent nothing at all.
function currentModel(header, launched) {
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
function pendingSwitch({ header, launchedModel, launchedEffort, model, effort } = {}) {
  const baseModel = currentModel(header, launchedModel);
  const baseEffort = currentEffort(header, launchedEffort);
  return {
    model: model && model !== baseModel ? model : null,
    effort: effort && effort !== baseEffort ? effort : null,
  };
}

module.exports = { isReconfigure, currentModel, currentEffort, pendingSwitch };
