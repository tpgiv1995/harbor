'use strict';

// Reveals the pane created by a new-session launch under the identity the
// provider can honestly supply. Claude receives a caller-minted id at launch,
// so its first window is real. Codex has no launch-time id and must retain the
// pane-keyed identity until its rollout appears.
async function revealNewSessionWindow({
  result,
  provider,
  cwd,
  account,
  model,
  effort,
  preIds,
  knownIds,
  sinceMs,
  findFreshPane,
  findFreshTranscript,
  setLink,
  focusPane,
  emitLaunched,
  onPaneReady,
  refreshHistory,
}) {
  if (provider === 'claude' && !result?.sessionId) {
    throw new Error('claude launch returned no session id');
  }
  const fresh = await findFreshPane({ preIds, cwd });
  if (!fresh) return;

  const mintedId = provider === 'claude' ? result?.sessionId : null;
  const initialId = mintedId || `pane:${fresh.paneId}`;
  setLink(initialId, fresh);
  Promise.resolve(focusPane(fresh)).catch(() => {});
  emitLaunched({
    sessionId: initialId,
    paneId: fresh.paneId,
    cwd,
    account,
    provider,
    model,
    effort,
    ...(mintedId ? {} : { provisional: true }),
  });

  await onPaneReady(initialId, fresh);
  if (mintedId) return;

  const freshSessionId = await findFreshTranscript({
    cwd,
    provider,
    sinceMs,
    knownIds,
    timeoutMs: 10 * 60_000,
  });
  if (!freshSessionId) return;
  setLink(freshSessionId, fresh);
  emitLaunched({
    sessionId: freshSessionId,
    paneId: fresh.paneId,
    cwd,
    account,
    provider,
    model,
    effort,
    replacesKey: initialId,
  });
  await refreshHistory();
}

module.exports = { revealNewSessionWindow };
