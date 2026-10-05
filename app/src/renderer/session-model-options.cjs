'use strict';

function sessionModelOptions({ provider, providerOptions, caps, model, showVersions }) {
  const rows = [...(providerOptions?.models || [])];
  const versions = caps?.models?.versions || providerOptions?.modelVersions || [];
  if (provider === 'claude' && showVersions) {
    for (const item of versions) {
      if (!rows.some(row => row.value === item.id)) rows.push({ value: item.id, label: item.label, hint: item.id });
    }
  }
  if (model && !rows.some(row => row.value === model)) {
    const known = [...(caps?.models?.cached || []), ...versions].find(item => item.id === model);
    rows.unshift({ value: model, label: known?.label || model, hint: 'current' });
  }
  return rows;
}

// 2026-09-20: display and submission use the same constrained effort. Keeping
// an old Ultra in state after selecting GPT-5.5 must not send an invalid launch.
function sessionEffortOptions({ providerOptions, model, effort }) {
  const levels = (providerOptions?.effortsByModel?.[model] || providerOptions?.efforts || [])
    .filter((value) => value !== 'default');
  const fallback = levels.includes(providerOptions?.defaultEffort) ? providerOptions.defaultEffort : levels[0];
  if (effort === 'default' && providerOptions?.efforts?.includes('default')) return { levels, effort };
  return { levels, effort: levels.includes(effort) ? effort : (fallback || 'default') };
}

module.exports = { sessionModelOptions, sessionEffortOptions };
