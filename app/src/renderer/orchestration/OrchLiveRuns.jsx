import React, { useEffect, useState } from 'react';
import { OrchProjectPicker } from './OrchProjectPicker.jsx';

function ageText(ms) {
  if (ms == null) return 'no liveness signal';
  if (ms < 60_000) return 'last signal now';
  return `last signal ${Math.max(1, Math.floor(ms / 60_000))}m ago`;
}

function stateText(batch) {
  if (batch.workerState === 'working') return `working, ${ageText(batch.signalAgeMs)}`;
  if (batch.workerState === 'awaiting-review') return `awaiting review, ${ageText(batch.signalAgeMs)}`;
  if (batch.workerState === 'quiet') return `quiet ${Math.max(1, Math.floor(batch.signalAgeMs / 60_000))}m, possibly hung`;
  if (batch.workerState === 'done') return 'done';
  if (batch.workerState === 'error-blocked') return 'error / blocked';
  return 'no liveness signal';
}

export function OrchLiveRuns({ projects, onPick }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    const load = () => window.harbor.orchestration.listRuns()
      .then((rows) => { if (active) { setRuns(rows || []); setError(null); } })
      .catch((reason) => { if (active) setError(reason.message); });
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
      {runs === null ? <p className="orch-loading">Loading...</p> : null}
      {runs?.length === 0 ? <p className="orch-picker-empty">No live or recently finished runs.</p> : null}
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
              {run.queue.batches.map((batch) => {
                const live = run.liveBatches.find((row) => row.batchId === batch.id) || {};
                return (
                  <span className={`orch-run-batch ${live.workerState === 'quiet' ? 'quiet' : ''}`} key={batch.id}>
                    <span>{batch.title || batch.id}</span>
                    <span>{batch.worker_engine || batch.worker || 'worker not recorded'}</span>
                    <span>{stateText(live)}</span>
                  </span>
                );
              })}
            </span>
            {run.summary.etaMs ? <span className="orch-run-eta">rough ETA {Math.max(1, Math.round(run.summary.etaMs / 60_000))}m</span> : null}
          </button>
        ))}
      </div>
      <div className="orch-overview-kickoff">
        <h3>Start or inspect another project</h3>
        <OrchProjectPicker projects={projects} onPick={onPick} compact />
      </div>
    </div>
  );
}
