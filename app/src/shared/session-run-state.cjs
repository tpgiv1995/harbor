'use strict';
const { freshWorking } = require('./claude-turn-state.cjs');

function processAliveFromEvidence(evidence = {}, now = Date.now()) {
  if (evidence.processAlive != null) return evidence.processAlive;
  if (evidence.beaconMs != null) return now - Math.max(evidence.beaconMs, evidence.lastWriteMs || 0) < 10 * 60 * 1000;
  return null;
}
function sessionLiveOwned(session, pane, header, now = Date.now()) {
  // cliAlive: the CLI itself lists this session as running (`claude agents
  // --json`, main/providers/cli-agents.js), wherever it runs.
  if (session?.isLive || session?.cliAlive || pane) return true;
  const evidence = { ...session?.ownerEvidence, ...header };
  const alive = processAliveFromEvidence(evidence, now);
  if (alive != null) return alive;
  return Boolean(evidence.lastWriteMs && now - evidence.lastWriteMs < 3 * 60 * 1000);
}
function backgroundBusy(session, header, pane, now = Date.now()) {
  const background = session?.background;
  return Boolean(sessionLiveOwned(session, pane, header, now) && background
    && (background.outstanding?.length || background.awaitingFinal));
}
// The CLI's own words for a blocked session (OSC 7501 `msg`, measured on CLI
// 2.1.301): "approve Write: /path/to/file" reads as "approve Write" on the chip
// with the whole message in the tooltip, "Not logged in · Please run /login"
// as "Not logged in", and AskUserQuestion's "answer: <the question>" as
// "answer a question" (the bare verb alone reads as nothing).
function blockedLabel(session) {
  const msg = typeof session?.agentStatusMsg === 'string' ? session.agentStatusMsg.trim() : '';
  if (!msg || session.agentStatus !== 'blocked') return null;
  const short = msg.split(/:\s|\s·\s/)[0].trim();
  if (/^answer$/i.test(short)) return 'answer a question';
  return short && short.length <= 40 ? short : null;
}

function runStateCue(session = {}, pane, header, now = Date.now()) {
  session ||= {};
  const alive = sessionLiveOwned(session, pane, header, now);
  if (header?.blocked || alive && session.agentStatus === 'blocked') {
    const label = (alive && blockedLabel(session)) || 'needs your answer';
    // Without OSC 7501 words, the CLI list says what the session waits on. A
    // session Harbor does not run can only be answered where it runs.
    const elsewhere = !session.isLive && !pane && session.cliAlive;
    const tooltip = alive && session.agentStatus === 'blocked' && session.agentStatusMsg ? session.agentStatusMsg
      : alive && session.agentStatus === 'blocked' && session.agentWaitingFor
        ? `waiting on a ${session.agentWaitingFor}${elsewhere ? ' in a window outside Harbor' : ''}` : null;
    return { kind: 'blocked', label, ariaLabel: `blocked: ${label}`, ...(tooltip ? { tooltip } : {}) };
  }
  if (alive && (header?.working || session.agentStatus === 'working' || freshWorking(session.background, now))) {
    // The CLI says what step it is on ("Running tests"); that beats the
    // transcript's generic verb whenever the CLI is reporting one.
    const step = session.agentStatus === 'working' && typeof session.agentStatusMsg === 'string' ? session.agentStatusMsg.trim() : '';
    const verb = step || header?.workingText || header?.text || 'Working';
    return { kind: 'running', label: verb, ariaLabel: `running: ${verb}` };
  }
  if (alive && backgroundBusy(session, header, pane, now)) {
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
module.exports = { processAliveFromEvidence, sessionLiveOwned, backgroundBusy, runStateCue, blockedLabel };
