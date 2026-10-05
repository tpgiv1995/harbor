'use strict';
const { runStateCue } = require('./session-run-state.cjs');

function providerPlans(options, provider) {
  return (options?.profilesByProvider?.[provider] || options?.profiles || [])
    .filter(profile => (profile.provider || 'claude') === provider);
}
function selectedPlan(options, provider, id) {
  const plans = providerPlans(options, provider);
  return plans.find(p => p.id === id || p.configHome === id)
    || plans.find(p => p.isDefault) || plans[0] || null;
}
function planMoveReason(session, header) {
  if (session?.provider !== 'claude') return 'Changing plans for an existing conversation is available for Claude only. Other providers keep history in separate homes.';
  if (session.isChildTask || session.delegatedBy) return 'Delegated sessions are controlled by their parent.';
  if (!session.isLive || !session.paneId || /^(pane|live):/.test(session.id || '')) return 'Open a running conversation before changing its plan.';
  const cue = runStateCue(session, null, header);
  if (cue?.kind !== 'ready' || header?.working !== false) return 'Wait until this session is idle before changing its plan.';
  return '';
}
module.exports = { providerPlans, selectedPlan, planMoveReason };
