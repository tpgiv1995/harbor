import React, { useEffect, useState } from 'react';
import { OrchProjectPicker } from './OrchProjectPicker.jsx';
import { Delegations } from './Delegations.jsx';
import { SubSessions } from './SubSessions.jsx';
import { createSingleFlight } from '../../shared/single-flight.js';
import { etaText, groupBatches, runCounts, waitingText } from './orch-text.cjs';

function ageText(ms) {
  if (ms == null) return 'no liveness signal';
  if (ms < 60_000) return 'last signal now';
  return `last signal ${Math.max(1, Math.floor(ms / 60_000))}m ago`;
}

function stateText(batch) {
  if (batch.workerState === 'ready') return 'ready, not started';
  if (batch.workerState === 'waiting') return waitingText(batch.waitingOn);
  if (batch.workerState === 'working') return `working, ${ageText(batch.signalAgeMs)}`;
  if (batch.workerState === 'awaiting-review') return `awaiting review, ${ageText(batch.signalAgeMs)}`;
  if (batch.workerState === 'quiet') return `quiet ${Math.max(1, Math.floor(batch.signalAgeMs / 60_000))}m, possibly hung`;
  if (batch.workerState === 'done') return 'done';
  if (batch.workerState === 'error-blocked') return 'error / blocked';
  if (batch.workerState === 'failed') return `worker failed, ${ageText(batch.signalAgeMs)}`;
  if (batch.workerState === 'stopped') return `worker stopped, ${ageText(batch.signalAgeMs)}`;
  return 'no liveness signal';
}

export function OrchLiveRuns({ projects, onPick, focusParentId, onOpenSession }) {
  const [runs, setRuns] = useState(null);
  const [delegations, setDelegations] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    const fail = (reason) => { if (active) setError(reason.message); };
    const loadDelegations = createSingleFlight(() => Promise.resolve(window.harbor.orchestration.listDelegations?.() || [])
      .then((groups) => { if (active) setDelegations(groups || []); }).catch(fail));
    const load = createSingleFlight(() => Promise.all([window.harbor.orchestration.listRuns(), loadDelegations()])
      .then(([rows]) => { if (active) { setRuns(rows || []); setError(null); } }).catch(fail));
    load();
    const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  return (
    <div className="orch-overview">
      <div className="orch-picker-head">
        <h2 className="orch-picker-title">Live runs</h2>
        <span className="orch-picker-subtitle">Every active or recently finished orchestration, with the age of its evidence</span>
      </div>
      {error ? <div className="orch-error-banner">{error}</div> : null}
      {/* The runs this header names come first (2026-10-12). Below them sat a
          sub-sessions list of every approval review, which pushed the run
          cards off the first screen. */}
      {runs === null ? <p className="orch-loading">Loading...</p> : null}
      {runs?.length === 0 && !delegations.some((group) => group.visible) ? <p className="orch-picker-empty">No live or recently finished runs.</p> : null}
      <div className="orch-run-list">
        {(runs || []).map((run) => (
          <button
            type="button"
            className="orch-run-card"
            key={run.summary.queueId || run.summary.workspace}
            onClick={() => onPick({
              label: run.summary.workspace.split(/[\\/]/).filter(Boolean).at(-1) || run.summary.workspace,
              workspace: run.summary.workspace,
              queueId: run.summary.queueId,
              sessions: [],
            })}
          >
            <span className="orch-run-head">
              <strong>{run.summary.workspace.split(/[\\/]/).filter(Boolean).at(-1)}</strong>
              <span>{`${run.summary.done}/${run.summary.total} done`}</span>
            </span>
            {run.queue.goal ? <span className="orch-run-goal">{run.queue.goal}</span> : null}
            <span className="orch-run-batches">
              {groupBatches(run.queue.batches).map((group) => (
                <span className={`orch-run-group ${group.key}`} key={group.key}>
                  <span className="orch-run-group-head">
                    <span className={`orch-run-dot ${group.key}`} aria-hidden="true" />
                    <span>{group.label}</span>
                    <span className="orch-run-group-count">{group.batches.length}</span>
                  </span>
                  {group.batches.map((batch) => {
                    const live = run.liveBatches.find((row) => row.batchId === batch.id) || {};
                    return (
                      <span className={`orch-run-batch ${live.workerState === 'quiet' ? 'quiet' : ''}`} key={batch.id}>
                        <span className="orch-run-batch-title">
                          <span className={`orch-run-dot ${group.key}`} aria-hidden="true" />
                          <span>{batch.title || batch.id}</span>
                        </span>
                        <span>{batch.worker_engine || batch.worker || 'worker not recorded'}</span>
                        <span title={live.waitingOn?.length ? `waits on ${live.waitingOn.join(', ')}` : undefined}>{stateText(live)}</span>
                      </span>
                    );
                  })}
                </span>
              ))}
            </span>
            {runCounts(run.summary) ? <span className="orch-run-eta">{runCounts(run.summary)}</span> : null}
            {etaText(run.summary) ? <span className="orch-run-eta">{etaText(run.summary)}</span> : null}
          </button>
        ))}
      </div>
      <Delegations groups={delegations} focusParentId={focusParentId} onOpenSession={onOpenSession} />
      <SubSessions onOpenSession={onOpenSession} />
      <div className="orch-overview-kickoff">
        <h3>Start or inspect another project</h3>
        <OrchProjectPicker projects={projects} onPick={onPick} compact />
      </div>
    </div>
  );
}
