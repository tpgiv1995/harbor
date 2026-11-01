'use strict';

const { selectedPlan } = require('../../../src/shared/plan-options.cjs');

// The New session sheet's starting choices (2026-10-31). Opened from the session
// browser's plus there is no preset and these are the sheet's normal defaults,
// exactly as before. Opened from a chat's header button the preset names that
// chat's provider and plan, which are honoured only when the server still offers
// them: a provider that is switched off, or a plan that no longer exists, falls
// back to the default rather than launching somewhere the user did not look at.
function presetChoices(options, preset) {
  const providers = options?.providers || {};
  const defaultProvider = options?.defaults?.provider || 'claude';
  const provider = preset?.provider && providers[preset.provider] ? preset.provider : defaultProvider;
  const account = selectedPlan(options, provider, preset?.account || undefined)?.id || '';
  return { provider, account };
}

// The folder the sheet must offer even when the server's candidate list left it
// out (a worktree, a new folder): it goes first, once. The server answers its
// own list as normalized paths, so the comparison ignores separator style.
function sameFolder(left, right) {
  const norm = (value) => String(value || '').replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return norm(left) === norm(right);
}

function withPresetFolder(candidates, folder) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!folder) return list;
  return [folder, ...list.filter((candidate) => !sameFolder(candidate, folder))];
}

module.exports = { presetChoices, withPresetFolder, sameFolder };
