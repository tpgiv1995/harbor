import React, { useCallback, useEffect, useRef, useState } from 'react';

// In-window workflow visibility (Pat, 2026-07-24: "both are running dynamic
// workflows. i have zero insight into this"). A compact strip appears at the
// top of a session window whenever the session has workflow runs on disk;
// clicking it opens the inspector overlay with phases and per-agent rows.
// Everything renders from the run files (journal, agent transcripts,
// completion record); a run the OOM kill orphaned says "killed mid-run",
// never running, never quietly done.

const POLL_MS = 4000;

const STATUS_LABEL = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  killed: 'killed mid-run',
};

function shortModel(model) {
  if (!model) return '';
  const m = String(model).match(/(fable|opus|sonnet|haiku)(?:-(\d+))?/);
  if (!m) return String(model);
  return m[2] ? `${m[1]} ${m[2]}` : m[1];
}

function fmtTokens(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function AgentRow({ agent }) {
  const label = agent.label || agent.promptPreview || agent.agentId;
  const facts = [
    shortModel(agent.model),
    agent.lastTool ? `${agent.lastTool}` : null,
    fmtTokens(agent.tokens) ? `${fmtTokens(agent.tokens)} tok` : null,
    agent.state === 'running' ? fmtAge(agent.lastActivityMs) : null,
    Number.isFinite(agent.durationMs) ? fmtDuration(agent.durationMs) : null,
  ].filter(Boolean);
  return (
    <div className={`wf-agent ${agent.state}`}>
      <span className={`wf-agent-dot ${agent.state}`} aria-hidden="true" />
      <span className="wf-agent-label" title={agent.promptPreview || label}>{label}</span>
      <span className="wf-agent-facts">{facts.join(' · ')}</span>
      {agent.resultPreview ? (
        <div className="wf-agent-result" title={agent.resultPreview}>{agent.resultPreview}</div>
      ) : null}
    </div>
  );
}

function RunCard({ run }) {
  const phaseFor = (agent) => agent.phaseTitle || null;
  const phased = run.phases && run.agents.some(phaseFor);
  const groups = new Map();
  if (phased) {
    for (const phase of run.phases) groups.set(phase.title, []);
    for (const agent of run.agents) {
      const key = phaseFor(agent) || run.phases[0]?.title;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(agent);
    }
  }
  const totals = [
    fmtTokens(run.totalTokens) ? `${fmtTokens(run.totalTokens)} tok` : null,
    Number.isFinite(run.totalToolCalls) ? `${run.totalToolCalls} tool calls` : null,
    fmtDuration(run.durationMs),
  ].filter(Boolean);
  return (
    <div className={`wf-run ${run.status}`}>
      <div className="wf-run-head">
        <span className={`wf-pill ${run.status}`}>{STATUS_LABEL[run.status] || run.status}</span>
        <span className="wf-run-name" title={run.summary || run.runId}>{run.name}</span>
        <span className="wf-run-count">
          {`${run.agentsDone}/${run.agentsTotal} agents`}
          {run.agentsRunning ? ` · ${run.agentsRunning} running` : ''}
        </span>
        {totals.length ? <span className="wf-run-totals">{totals.join(' · ')}</span> : null}
      </div>
      {run.status === 'killed' ? (
        <div className="wf-killed-note">
          {`This run died mid-flight (no completion record): ${run.agentsDone} of ${run.agentsTotal} agents returned before it stopped. Its disk state is whatever those agents wrote.`}
        </div>
      ) : null}
      {run.phases && !phased ? (
        <div className="wf-phases">{run.phases.map((p) => p.title).join(' → ')}</div>
      ) : null}
      <div className="wf-agents">
        {phased ? [...groups.entries()].map(([phase, agents]) => (agents.length ? (
          <div className="wf-phase-group" key={phase}>
            <div className="wf-phase-title">{phase}</div>
            {agents.map((a) => <AgentRow key={a.agentId} agent={a} />)}
          </div>
        ) : null)) : run.agents.map((a) => <AgentRow key={a.agentId} agent={a} />)}
      </div>
    </div>
  );
}

export function WorkflowStrip({ sessionId }) {
  const [runs, setRuns] = useState([]);
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);

  const poll = useCallback(async () => {
    try {
      const res = await window.harbor.session.workflowRuns({ sessionId });
      setRuns(res?.runs || []);
    } catch { /* keep previous */ }
  }, [sessionId]);

  useEffect(() => {
    // pane:<id> / live:<id> windows have no transcript identity yet, and
    // therefore no run directory to look in.
    if (!sessionId || /^(pane|live):/.test(String(sessionId))) return undefined;
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [sessionId, poll]);

  if (!runs.length) return null;
  const top = runs[0];
  const glyph = top.status === 'running' ? '▶' : top.status === 'completed' ? '✓' : top.status === 'killed' ? '✖' : '!';

  return (
    <>
      <button
        type="button"
        className={`wf-strip ${top.status}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-expanded={open}
        aria-label={`Workflow ${top.name}: ${STATUS_LABEL[top.status] || top.status}, ${top.agentsDone} of ${top.agentsTotal} agents done`}
      >
        <span className={`wf-strip-glyph ${top.status}`} aria-hidden="true">{glyph}</span>
        <span className="wf-strip-name">{top.name}</span>
        <span className="wf-strip-facts">
          {`${STATUS_LABEL[top.status] || top.status} · ${top.agentsDone}/${top.agentsTotal}`}
          {top.agentsRunning ? ` · ${top.agentsRunning} running` : ''}
          {fmtTokens(top.totalTokens) ? ` · ${fmtTokens(top.totalTokens)} tok` : ''}
        </span>
        {runs.length > 1 ? <span className="wf-strip-more">{`+${runs.length - 1} more`}</span> : null}
        <span className="wf-strip-open" aria-hidden="true">{open ? 'close' : 'open'}</span>
      </button>
      {open ? (
        <div className="wf-inspector" onClick={(e) => e.stopPropagation()} role="region" aria-label="Workflow runs">
          {runs.map((run) => <RunCard key={run.runId} run={run} />)}
        </div>
      ) : null}
    </>
  );
}
