'use strict';

// What a window knows about its own session before the session says anything.
//
// A new session writes no transcript until its first message, so for the whole
// of that window the model chip has nothing to read: the header is null, and
// the rail row (which is about identity, not configuration) carries no model
// either. The chip therefore fell back to the bare provider label, and Pat's
// report was exact: "i cant even see what model im in for these new sessions".
//
// Harbor knows, though. It launched the CLI itself, with `--model` and
// `--effort` on the argv, and the launch event carries both. The rules here are
// what keeps that knowledge alive long enough to be useful.

/**
 * Fold a `session:launched` payload into whatever is already known.
 *
 * The launch flow's own events carry model/effort; the daemon's pane-to-session
 * pairing event (the OTHER way a provisional window learns its real id) carries
 * neither, and it can arrive first. Replacing the record wholesale dropped the
 * launch config on the floor exactly when the window still had no transcript to
 * show it from, so a null NEVER overwrites a known value.
 */
function mergeLaunchMeta(previous, next) {
  const merged = { ...(previous || {}) };
  for (const [key, value] of Object.entries(next || {})) {
    if (value != null) merged[key] = value;
  }
  return merged;
}

/**
 * The session row a window should render, with the launch config filled in
 * where the row has nothing.
 *
 * Only ever FILLS: a real fact from the index or the daemon outranks the launch
 * config, because a session can be reconfigured after it starts and the launch
 * argv is then history. Returns the SAME object when there is nothing to add,
 * so a memo does not churn.
 */
function withLaunchFacts(session, meta) {
  if (!session || !meta) return session;
  const patch = {};
  if (!session.model && meta.model) patch.model = meta.model;
  if (!session.modelLabel && meta.modelLabel) patch.modelLabel = meta.modelLabel;
  if (!session.effort && meta.effort) patch.effort = meta.effort;
  if (!Object.keys(patch).length) return session;
  return { ...session, ...patch };
}

module.exports = { mergeLaunchMeta, withLaunchFacts };
