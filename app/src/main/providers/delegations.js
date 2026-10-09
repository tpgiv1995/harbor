'use strict';

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { acquireStoreLock } = require('../store-lock.js');
const { createSingleFlight } = require('../single-flight.js');
const { freshWorking } = require('../../shared/claude-turn-state.cjs');
const { sessionLiveOwned } = require('../../shared/session-run-state.cjs');
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
const FRESH_WINDOW_MS = 30_000; // The incident's launch-to-meta delay is 2.697s.
const RECENT_DONE_MS = 10 * 60 * 1000;
const QUIET_MS = 10 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
async function mergeDelegationLinks(file, updates) {
  const lockDir = `${file}.lock`;
  if (!await acquireStoreLock(lockDir)) throw new Error('Delegation links are busy; the next history event retries.');
  try {
    const links = await fsp.readFile(file, 'utf8').then((text) => JSON.parse(text).links || {}).catch(() => ({}));
    for (const [id, parent] of Object.entries(updates)) {
      if (parent) links[id] = parent; else delete links[id];
    }
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, links }));
    await fsp.rename(tmp, file);
    return links;
  } finally { await fsp.rm(lockDir, { recursive: true, force: true }); }
}
function canonicalCwd(value) {
  return String(value || '').replace(/^\/([a-z])\//i, '$1:/').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
}
// Shell words, not execution. Double quotes follow bash's limited escapes;
// single quotes preserve every character, including backslashes.
// Nested bash -c is unwrapped; text inside a prompt is never a command.
function shellWords(text) {
  const words = []; let word = ''; let quote = null; let started = false;
  const flush = () => { if (started) words.push(word); word = ''; started = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '\\' && ['\\', '"', '$', '`', '\n'].includes(text[i + 1])) {
        const escaped = text[++i]; if (escaped !== '\n') word += escaped;
      }
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) flush();
    else if (';|&<>'.includes(ch)) { flush(); words.push(ch); }
    else { word += ch; started = true; }
  }
  flush(); return words;
}
function dispatchFor(task, parentCwd, depth = 0) {
  if (depth > 3 || !task.command) return null;
  const words = shellWords(task.command);
  let cwd = task.cwd || parentCwd; let start = true;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if ([';', '|', '&'].includes(word)) { start = true; continue; }
    if (!start) continue;
    if (/^[A-Za-z_][\w]*=/.test(word) || ['env', 'export', 'exec', 'call'].includes(word)) continue;
    const exe = word.replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|ps1|mjs|js)$/i, '').toLowerCase();
    if (exe === 'cd') { cwd = words[i + 1] === '/d' ? words[i + 2] : words[i + 1]; start = false; continue; }
    if (['bash', 'sh'].includes(exe) && /^-[a-z]*c$/.test(words[i + 1] || '')) {
      const nested = dispatchFor({ ...task, command: words[i + 2] }, cwd, depth + 1);
      if (nested) return nested;
    }
    if (['node', 'nodejs'].includes(exe)) continue;
    start = false;
    const args = words.slice(i + 1);
    const provider = exe === 'astra-run' || exe === 'codex' && args.some((a) => a === 'exec' || a === 'e') ? 'codex'
      : exe === 'claude' && args.some((a) => a === '-p' || a === '--print') ? 'claude'
        : exe === 'cursor-agent' && args.some((a) => a === '-p' || a === '--print') ? 'cursor' : null;
    if (!provider) continue;
    let resumeId = null; let model = exe === 'astra-run' ? 'gpt-6-astra' : null; let prompt = '';
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if ([';', '|', '&', '<', '>'].includes(a)) break;
      if (a === 'resume' && UUID.test(args[j + 1] || '')) { resumeId = args[++j]; continue; }
      if (['--cd', '-C'].includes(a)) { cwd = args[++j]; continue; }
      if (a.startsWith('--cd=')) { cwd = a.slice(5); continue; }
      if (['--model', '-m'].includes(a)) { model = args[++j]; continue; }
      if (/^--model=/.test(a)) { model = a.slice(8); continue; }
      if (['-c', '--config', '-o', '--output-last-message', '--home', '--effort', '--max-resets', '--sandbox', '-s', '--output-format'].includes(a)) { j++; continue; }
      if (a.startsWith('-') || ['exec', 'e', 'resume'].includes(a)) continue;
      prompt = a.split('\n').find((s) => s.trim())?.slice(0, 500) || '';
    }
    return { ...task, provider, resumeId, model, prompt, cwd: cwd || parentCwd };
  }
  return null;
}
function linkDispatches(parents, providerRows) {
  const roots = providerRows.filter((r) => r.provider === 'codex' && r.lineage?.kind === 'exec' && !r.lineage.parentThreadId);
  const byId = new Map(providerRows.map((r) => [r.id, r]));
  const claimed = new Map(); const dispatches = [];
  for (const parent of parents) for (const task of parent.background?.tasks || []) {
    const dispatch = dispatchFor(task, parent.cwd);
    if (dispatch) dispatches.push({ ...dispatch, parentId: parent.id });
  }
  dispatches.sort((a, b) => a.startedMs - b.startedMs || a.id.localeCompare(b.id));
  const exactOwners = new Map();
  for (const d of dispatches) if (d.provider === 'codex' && d.resumeId) {
    if (!exactOwners.has(d.resumeId)) exactOwners.set(d.resumeId, d.parentId);
    else if (exactOwners.get(d.resumeId) !== d.parentId) exactOwners.set(d.resumeId, null);
  }
  for (const d of dispatches) {
    if (d.provider !== 'codex') continue;
    if (d.resumeId) {
      // Exact identity survives missing rollout files. Cross-parent ownership
      // conflicts remain unlinked, rather than creating two writers.
      if (exactOwners.get(d.resumeId) === d.parentId) {
        d.childId = d.resumeId; claimed.set(d.resumeId, d.parentId);
      }
      continue;
    }
    const matches = roots.filter((r) => !claimed.has(r.id) && (!exactOwners.has(r.id) || exactOwners.get(r.id) === d.parentId) && canonicalCwd(r.cwd) === canonicalCwd(d.cwd)
      && r.lineage.startedMs >= d.startedMs && r.lineage.startedMs - d.startedMs <= FRESH_WINDOW_MS
      && (!d.endedMs || r.lineage.startedMs <= d.endedMs))
      .sort((a, b) => a.lineage.startedMs - b.lineage.startedMs);
    // Sub-second neighboring launches cannot be distinguished honestly by this
    // evidence. Do not make enumeration order decide the owner.
    if (!matches.length || matches[1] && matches[1].lineage.startedMs - matches[0].lineage.startedMs <= 1000) continue;
    d.childId = matches[0].id; claimed.set(d.childId, d.parentId);
  }
  for (const d of dispatches) if (d.childId) d.child = byId.get(d.childId) || null;
  return { dispatches, delegatedBy: Object.fromEntries(claimed) };
}
function agentState(task, rollout, now = Date.now(), familySignalMs = 0) {
  if (['completed', 'failed', 'stopped', 'killed'].includes(task?.status)) return task.status === 'completed' ? 'done' : task.status === 'killed' ? 'stopped' : task.status;
  const evidence = rollout?.signal;
  if (evidence?.endedMs >= (task?.startedMs || 0) && !evidence.working) return evidence.outcome || 'done';
  const lastSignalMs = Math.max(task?.lastSignalMs || 0, evidence?.lastSignalMs || 0, rollout?.lastWriteMs || 0, familySignalMs);
  if (!lastSignalMs) return 'no signal';
  if (now - lastSignalMs >= QUIET_MS) return 'quiet';
  return 'running';
}
function buildDelegationGroups(parents, providerRows, now = Date.now(), links = linkDispatches(parents, providerRows)) {
  const { dispatches, delegatedBy } = links;
  const childrenByParent = new Map();
  for (const row of providerRows) {
    const id = row.lineage?.parentThreadId;
    if (id) { if (!childrenByParent.has(id)) childrenByParent.set(id, []); childrenByParent.get(id).push(row); }
  }
  const childrenFor = (id, seen = new Set()) => {
    if (seen.has(id)) return [];
    const next = new Set([...seen, id]);
    return (childrenByParent.get(id) || []).filter((r) => !next.has(r.id)).map((r) => {
      const children = childrenFor(r.id, next);
      const lastSignalMs = Math.max(r.signal?.lastSignalMs || 0, r.lastWriteMs || 0, ...children.map((c) => c.lastSignalMs));
      return { id: r.id, title: r.title, kind: r.lineage.kind, model: r.signal?.model || r.model,
        state: agentState(null, r, now, lastSignalMs), lastSignalMs, children };
    });
  };
  const groups = [];
  for (const parent of parents) {
    const own = dispatches.filter((d) => d.parentId === parent.id);
    // A finished command with no linked rollout is background inventory, not
    // evidence that an agent started. Preserve its actual command outcome.
    const agentDispatches = own.filter((d) => d.child || d.status === 'running');
    const tasks = (parent.background?.tasks || []).filter((t) => !agentDispatches.some((d) => d.id === t.id));
    if (!own.length && !tasks.length) continue;
    const agents = [];
    for (const d of agentDispatches) {
      const key = d.childId || d.id;
      let agent = agents.find((a) => a.id === key);
      if (!agent) {
        agent = { id: key, sessionId: d.childId || null, provider: d.provider, rounds: [], children: childrenFor(d.childId), linked: Boolean(d.child), };
        agents.push(agent);
      }
      const rolloutLastSignalMs = Math.max(d.child?.signal?.lastSignalMs || 0, d.child?.lastWriteMs || 0, ...agent.children.map((c) => c.lastSignalMs));
      const lastSignalMs = Math.max(d.lastSignalMs || 0, rolloutLastSignalMs);
      const state = agentState(d, d.child, now, lastSignalMs);
      agent.rounds.push({ id: d.id, description: d.description, startedMs: d.startedMs, endedMs: d.endedMs || (state === 'done' ? d.child?.signal?.endedMs : null), outcome: state, parentStatus: d.status });
      Object.assign(agent, { description: d.description, prompt: d.prompt && !d.prompt.includes('$(') ? d.prompt : d.child?.firstPrompt || '', model: d.child?.signal?.model || d.model,
        state, parentState: state, rolloutState: d.child ? agentState({ startedMs: d.startedMs }, d.child, now, rolloutLastSignalMs) : null,
        parentLastSignalMs: d.lastSignalMs || 0, rolloutLastSignalMs, lastSignalMs });
    }
    const lastSignalMs = Math.max(parent.ownerEvidence?.lastWriteMs || 0, parent.background?.lastSignalMs || 0, ...agents.map((a) => a.lastSignalMs), ...tasks.map((t) => t.lastSignalMs || 0));
    groups.push({ parentId: parent.id, title: parent.title, project: parent.project,
      owner: { ...parent.ownerEvidence, isLive: Boolean(parent.isLive) }, working: parent.background?.working, awaitingFinal: parent.background?.awaitingFinal,
      lastInTurnMs: parent.background?.lastInTurnMs || 0,
      lastSignalMs, agents, tasks });
  }
  return { groups: ageDelegationGroups(groups, now), delegatedBy, dispatches };
}

// Only elapsed-time presentation changes on a quiet poll. Matching, shell
// parsing, and family construction already happened in the worker.
function ageDelegationGroups(groups, now = Date.now(), liveIds = null) {
  const live = liveIds == null ? null : new Set(liveIds);
  const activeState = (state) => ['running', 'quiet', 'no signal'].includes(state);
  const ageAgent = (agent, parentAlive) => {
    const reportedState = agent.reportedState || agent.state;
    let state = reportedState;
    // Ten minutes exceeds the measured family gaps (327s at most). A dead
    // parent cannot keep unknown or silent child work active indefinitely.
    // Preserve terminal events and source states so resumed ownership heals.
    if (activeState(state)) {
      if (!parentAlive && (!agent.lastSignalMs || now - agent.lastSignalMs >= RECENT_DONE_MS)) state = 'ended';
      else if (state === 'running' && now - agent.lastSignalMs >= QUIET_MS) state = 'quiet';
    }
    return { ...agent, reportedState, state, children: (agent.children || []).map(child => ageAgent(child, parentAlive)) };
  };
  return groups.map((group) => {
    // Keep evidence timestamps, not a frozen alive boolean. A no-write read
    // must expire outside ownership, and a closed pane must stop owning work.
    const parentAlive = sessionLiveOwned({ isLive: live ? live.has(group.parentId) : group.owner?.isLive }, null, group.owner, now);
    const tasks = group.tasks.map((task) => {
      const reportedStatus = task.reportedStatus || task.status;
      return { ...task, reportedStatus, status: !parentAlive && reportedStatus === 'running' ? 'ended with session' : reportedStatus };
    });
    const agents = group.agents.map((agent) => {
      const parentState = agent.parentState || agent.state;
      const state = parentAlive ? parentState : agent.linked ? agent.rolloutState : activeState(parentState) ? 'ended with session' : parentState;
      const aged = ageAgent({ ...agent, state, reportedState: state,
        lastSignalMs: parentAlive ? Math.max(agent.parentLastSignalMs || 0, agent.rolloutLastSignalMs || 0) : agent.linked ? agent.rolloutLastSignalMs : agent.parentLastSignalMs,
      }, parentAlive);
      return { ...aged, rounds: agent.rounds.map((round) => ({ ...round, reportedOutcome: round.reportedOutcome || round.outcome,
        outcome: !parentAlive && ['ended', 'ended with session'].includes(aged.state) && round.parentStatus === 'running' ? aged.state : round.reportedOutcome || round.outcome })) };
    });
    const working = parentAlive && freshWorking(group, now);
    const active = working || parentAlive && (group.awaitingFinal || agents.some((a) => a.rounds.some((r) => r.parentStatus === 'running')))
      || tasks.some((t) => t.blocking && t.status === 'running') || agents.some((a) => activeState(a.state));
    return { ...group, parentAlive, active, state: working ? 'working' : active ? 'background' : 'done',
      visible: active || now - group.lastSignalMs <= RECENT_DONE_MS, tasks, agents };
  }).sort((a, b) => Number(b.active) - Number(a.active) || b.lastSignalMs - a.lastSignalMs);
}

// The session header's agents chip is about the AGENTS (2026-10-07, Pat: "why
// does it say agents 0 running / 1 up top?"). It used to show for every group on
// record, so a session that delegated once read "agents 0 running / 1" for as
// long as the 48h window kept the group. It now shows while an agent is running
// and for RECENT_DONE_MS after the last agent signal, the overview's linger.
// Deliberately NOT the group's `visible`: a group is active whenever its parent
// is mid-turn, which would keep the chip on every busy session. Aged at read
// time, so it expires without a new write.
function delegationSummaries(groups, now = Date.now(), liveIds = null) {
  const summaries = new Map();
  for (const group of ageDelegationGroups(groups, now, liveIds)) {
    if (!group.agents.length) continue;
    const running = group.agents.filter((a) => ['running', 'quiet', 'no signal'].includes(a.state)).length;
    const lastAgentSignal = Math.max(0, ...group.agents.map((a) => a.lastSignalMs || 0));
    if (!running && now - lastAgentSignal > RECENT_DONE_MS) continue;
    summaries.set(group.parentId, { total: group.agents.length, running });
  }
  return summaries;
}

// One worker and one coalesced flight, triggered by the bridge's existing
// watchers. No new polling, no process-table reads, no per-row meta requests.
function createDelegationIndex(ownerOptions = {}, { cacheFile = null } = {}) {
  let worker = null; let pending = null; let closed = false;
  const scan = createSingleFlight((rows, liveIds) => new Promise((resolve, reject) => {
    if (closed) return resolve({ parents: [], providers: [] });
    if (!worker) {
      worker = new Worker(path.join(__dirname, 'delegations-worker.js'));
      worker.unref();
      worker.on('message', (message) => { const p = pending; pending = null; message.error ? p?.reject(new Error(message.error)) : p?.resolve(message); });
      worker.on('error', (error) => { pending?.reject(error); pending = null; worker = null; });
    }
    pending = { resolve, reject };
    worker.postMessage({ rows: latestRows, liveIds: latestLiveIds, ownerOptions, cacheFile });
  }));
  let latestRows = []; let latestLiveIds = [];
  return { scan(rows, liveIds = []) { latestRows = rows; latestLiveIds = liveIds; return scan(); },
    close() { closed = true; pending?.resolve({ parents: [], providers: [] }); pending = null; worker?.terminate(); worker = null; } };
}
module.exports = { RECENT_WINDOW_MS, FRESH_WINDOW_MS, RECENT_DONE_MS, QUIET_MS, canonicalCwd, shellWords, dispatchFor, linkDispatches, agentState, buildDelegationGroups, ageDelegationGroups, delegationSummaries, createDelegationIndex, mergeDelegationLinks };
