'use strict';

const path = require('node:path');

// Where the dormancy veto looks for a codex session's rollout (2026-10-15).
// It used to look only under ~/.codex/sessions (or HARBOR_CODEX_SESSION_ROOTS),
// so a session launched on a second Codex account, whose rollout lives under
// that account's own CODEX_HOME, was never found: findProviderTranscript threw
// and the veto failed closed, which kept the session awake forever. bin/ai
// exports the profile's home as the child's CODEX_HOME, and the daemon keeps
// the spawn env in the session's config file, so the session itself names the
// right root. That root goes first; the defaults stay as the fallback for a
// session launched without one.
function codexSessionRoots({ sessionEnv = null, defaults = [] } = {}) {
  const roots = [];
  const home = sessionEnv && typeof sessionEnv.CODEX_HOME === 'string' ? sessionEnv.CODEX_HOME.trim() : '';
  if (home) roots.push(path.join(home, 'sessions'));
  for (const root of defaults) {
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

module.exports = { codexSessionRoots };
