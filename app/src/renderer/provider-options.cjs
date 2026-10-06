'use strict';

function watchProviderOptions({ api, sessionId, onOptions, onCapabilities, onError = () => {}, focusTarget = globalThis.window }) {
  let generation = 0;
  let active = true;
  const refresh = () => {
    const current = ++generation;
    api.session.newOptions().then((options) => {
      if (active && current === generation) onOptions(options);
    }).catch((error) => { if (active && current === generation) onError(error); });
    if (sessionId && onCapabilities) {
      api.capabilities.get({ sessionId }).then((result) => {
        if (active && current === generation && result?.ok) onCapabilities(result.capabilities);
      }).catch(() => {});
    }
  };
  const off = api.session.onModelsChanged?.(refresh);
  focusTarget?.addEventListener('focus', refresh);
  refresh();
  return () => { active = false; off?.(); focusTarget?.removeEventListener('focus', refresh); };
}

module.exports = { watchProviderOptions };
