'use strict';

function restoreProviderLink({ paneId, sessionId, workspaceId, cwd, provider }, links, emit) {
  links?.dropPane(paneId);
  links?.set(sessionId, { paneId, workspaceId });
  for (const replacesKey of [`pane:${paneId}`, `live:${paneId}`]) emit?.('session:launched', {
    sessionId, paneId, workspaceId, cwd, provider, replacesKey,
  });
}

function publishProviderLink(link, links, emit) {
  const { paneId, sessionId, provider, cwd, workspaceId, previousSessionId } = link;
  restoreProviderLink(link, links, emit);
  const replacements = [];
  if (previousSessionId && previousSessionId !== sessionId) replacements.push(previousSessionId);
  for (const replacesKey of replacements) emit('session:launched', {
    sessionId, paneId, workspaceId, cwd, provider, replacesKey,
  });
}

module.exports = { publishProviderLink, restoreProviderLink };
