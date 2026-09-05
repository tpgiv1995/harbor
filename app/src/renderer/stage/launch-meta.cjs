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
 *
 * The ACCOUNT belongs here for the same reason the model does, and leaving it
 * out was worse than leaving out the model, because a missing home does not
 * render as nothing (2026-08-09). `resolveProfile` falls back to the default
 * profile, so a window launched on the third plan drew the FIRST plan's letter:
 * Pat clicked the rail's `S`, got a `T`, and clicked it four more times over two
 * minutes because a badge naming the wrong plan and a button that did nothing
 * look identical. Five sessions where he wanted one.
 *
 * The gap is not small and cannot be closed downstream: a row's `home` comes
 * from the history index, the index is built from transcript files, and a claude
 * session writes no transcript until its first message. Measured on the session
 * that produced the report: launched 15:48:11, transcript born 15:49:57. Harbor
 * knew the account for all 106 of those seconds, having passed
 * `--home <configHome>` on the argv itself.
 */
function withLaunchFacts(session, meta) {
  if (!session || !meta) return session;
  const patch = {};
  if (!session.model && meta.model) patch.model = meta.model;
  if (!session.modelLabel && meta.modelLabel) patch.modelLabel = meta.modelLabel;
  if (!session.effort && meta.effort) patch.effort = meta.effort;
  if (!session.home && meta.account) patch.home = meta.account;
  if (!Object.keys(patch).length) return session;
  return { ...session, ...patch };
}

module.exports = { mergeLaunchMeta, withLaunchFacts };
