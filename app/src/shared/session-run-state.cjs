'use strict';
const { freshWorking } = require('./claude-turn-state.cjs');

function processAliveFromEvidence(evidence = {}, now = Date.now()) {
  if (evidence.processAlive != null) return evidence.processAlive;
  if (evidence.beaconMs != null) return now - Math.max(evidence.beaconMs, evidence.lastWriteMs || 0) < 10 * 60 * 1000;
  return null;
}
function sessionLiveOwned(session, pane, header, now = Date.now()) {
  if (session?.isLive || pane) return true;
  const evidence = { ...session?.ownerEvidence, ...header };
  const alive = processAliveFromEvidence(evidence, now);
  if (alive != null) return alive;
  return Boolean(evidence.lastWriteMs && now - evidence.lastWriteMs < 3 * 60 * 1000);
}
function backgroundBusy(session, header, pane) {
  const background = session?.background;
  return Boolean(sessionLiveOwned(session, pane, header) && background
    && (background.outstanding?.length || background.awaitingFinal));
}
function runStateCue(session = {}, pane, header, now = Date.now()) {
  session ||= {};
  const alive = sessionLiveOwned(session, pane, header, now);
  if (header?.blocked || alive && session.agentStatus === 'blocked') return { kind: 'blocked', label: 'needs your answer', ariaLabel: 'blocked: needs your answer' };
  if (alive && (header?.working || session.agentStatus === 'working' || freshWorking(session.background, now))) {
    const verb = header?.workingText || header?.text || 'Working';
    return { kind: 'running', label: verb, ariaLabel: `running: ${verb}` };
  }
  if (alive && backgroundBusy(session, header, pane)) {
    const tasks = session.background.outstanding || [];
    const agents = tasks.filter((t) => t.delegated || t.kind === 'agent').length;
    const label = agents ? `waiting on ${agents} agent${agents === 1 ? '' : 's'}`
      : tasks.length && tasks.every((t) => t.kind === 'monitor') ? 'watching'
        : tasks.length ? `${tasks.length} task${tasks.length === 1 ? '' : 's'} running` : 'finishing background work';
    const tooltip = tasks.map((t) => `${t.description} (${t.delegated ? 'agent' : t.kind}, ${now - t.startedMs < 60000 ? '<1m' : `${Math.floor((now - t.startedMs) / 60000)}m`})`).join('\n');
    return { kind: 'background', label, ariaLabel: `background: ${label}`, tooltip };
  }
  return alive ? { kind: 'ready', label: 'ready', ariaLabel: 'ready' } : null;
}
module.exports = { processAliveFromEvidence, sessionLiveOwned, backgroundBusy, runStateCue };
