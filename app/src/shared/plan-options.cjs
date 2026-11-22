'use strict';
const { subSessionReadOnly } = require('./sub-sessions.cjs');
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
// A plan's own name from the configured plan list (the `profiles` of
// new-session:options): "Claude C", "EB Smart", "Ren 2", never the folder id
// title-cased into "Claudec", "Ebsmart", "Ren2" (the phone's plan chip and Plans
// sheet did that until 2026-11-19). An id the list does not name, or a list not
// loaded yet, reads as its id in title case.
function planName(profiles, id) {
  const key = String(id || '').trim();
  if (!key) return '';
  const plan = (Array.isArray(profiles) ? profiles : [])
    .find(p => p && (p.id === key || (p.configHome && p.configHome === key)));
  if (plan?.label) return plan.label;
  return key.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function planMoveReason(session, header) {
  if (session?.provider !== 'claude') return 'Changing plans for an existing conversation is available for Claude only. Other providers keep history in separate homes.';
  if (subSessionReadOnly(session)) return 'Machine-made sessions are read-only here.';
  if (!session.isLive || !session.paneId || /^(pane|live):/.test(session.id || '')) return 'Open a running conversation before changing its plan.';
  const cue = runStateCue(session, null, header);
  if (cue?.kind !== 'ready' || header?.working !== false) return 'Wait until this session is idle before changing its plan.';
  return '';
}
module.exports = { providerPlans, selectedPlan, planName, planMoveReason };
