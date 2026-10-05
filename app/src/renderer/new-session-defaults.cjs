'use strict';

// Pat's default since 2026-09-28: Opus 5.5 at effort high (xhigh is picked per session for hard work).
const FALLBACK = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };

// 2026-09-19: a fresh renderer uses setup's defaults. Reading an older saved
// choice never migrates or rewrites it; only an explicit save may replace it.
function resolveNewSessionDefaults({ request = {}, stored, options = {} } = {}) {
  const providers = options.providers || {};
  const enabled = (id) => Boolean(providers[id]) && providers[id].enabled !== false;
  const configured = options.defaults || {};
  const saved = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const provider = [request.provider, saved.provider, configured.provider, FALLBACK.provider,
    ...Object.keys(providers)].find(enabled);
  if (!provider) return { provider: null, unavailable: 'Enable a provider in Setup before starting a session.' };

  const registry = providers[provider];
  const result = {
    provider,
    model: registry.defaultModel || 'default',
    effort: registry.defaultEffort || registry.efforts?.[0] || 'default',
  };
  // Never carry another provider's model, effort or account into a fallback.
  const fallback = Object.keys(configured).length ? {} : FALLBACK;
  for (const layer of [fallback, configured, saved, request]) {
    if (layer.provider && layer.provider !== provider) continue;
    for (const key of ['model', 'effort', 'account']) {
      if (layer[key] != null && layer[key] !== '') result[key] = layer[key];
    }
  }
  const profiles = registry.profiles || options.profilesByProvider?.[provider] || [];
  if (!profiles.some((profile) => profile.id === result.account)) {
    result.account = registry.defaultProfile || profiles[0]?.id || null;
  }
  return result;
}

module.exports = { resolveNewSessionDefaults };
