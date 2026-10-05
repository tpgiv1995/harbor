'use strict';

// 2026-09-20: all ways of learning an installed version feed this one signal.
// Invalidate after discovery finishes, otherwise open menus refetch old caches.
function createProviderModelRefresh({ catalogs, notify, env = process.env, log = () => {}, defer = false }) {
  const queues = new Map();
  const deferred = new Map();
  function refresh({ provider, installed, source } = {}) {
    if (env.HARBOR_E2E === '1' || env.HARBOR_NO_MODEL_DISCOVERY === '1') return Promise.resolve();
    if (defer) {
      deferred.set(provider, { provider, installed, source });
      return Promise.resolve();
    }
    const run = async () => {
      try {
        if (catalogs[provider]) {
          const result = await catalogs[provider].refresh({ version: installed, force: source === 'harbor' });
          if (!result?.ok) log(`${provider} model discovery failed: ${result?.reason || JSON.stringify(result?.results)}`);
        }
      } catch (error) { log(`${provider} model discovery failed: ${error.message}`); }
      notify({ provider });
    };
    // A second install while discovery is running must get its own trailing
    // refresh, not reuse the first version's in-flight answer.
    const task = (queues.get(provider) || Promise.resolve()).then(run);
    queues.set(provider, task);
    return task.finally(() => { if (queues.get(provider) === task) queues.delete(provider); });
  }
  refresh.start = async () => {
    defer = false;
    const changes = [...deferred.values()];
    deferred.clear();
    await Promise.all(changes.map(refresh));
    return changes.map((change) => change.provider);
  };
  return refresh;
}

module.exports = { createProviderModelRefresh };
