import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectRootSessionId } from '../../shared/sidebar-model.js';

const STATUS_COLORS = {
  pending: 'orch-status-pending',
  active: 'orch-status-active',
  done: 'orch-status-done',
  blocked: 'orch-status-blocked',
  error: 'orch-status-error',
};

function StatusDot({ status }) {
  return <span className={`orch-status-dot ${STATUS_COLORS[status] || 'orch-status-pending'}`} aria-label={status} />;
}

function formatEta(ms) {
  if (!ms) return 'estimate unavailable';
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `about ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours}h${rest ? ` ${rest}m` : ''}`;
}

function BatchCard({ batch, onPreview, previewText, previewLoading }) {
  const [expanded, setExpanded] = useState(false);
  const hasExcerpt = batch.last_result_excerpt || batch.last_error;
  const hasSession = Boolean(batch.last_session_id);
  const lastEvent = batch.last_event || batch.status_note || batch.last_error || batch.last_result_excerpt;

  return (
    <div className={`orch-batch-card ${STATUS_COLORS[batch.status] || ''}`}>
      <div className="orch-batch-header">
        <StatusDot status={batch.status} />
        <span className="orch-batch-id">{batch.id}</span>
        <span className="orch-batch-title" title={batch.title || batch.id}>{batch.title || batch.id}</span>
        <span className="orch-batch-status">{batch.status || 'pending'}</span>
        <span className="orch-batch-priority">{batch.priority || ''}</span>
        {hasExcerpt && (
          <button
            type="button"
            className="orch-batch-expand"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'less' : 'more'}
          </button>
        )}
      </div>
      <div className="orch-batch-meta">
        {batch.worker && <span className="orch-batch-worker" title={batch.worker}>{batch.worker}</span>}
        {batch.dispatch_count > 0 && (
          <span className="orch-batch-dispatched">
            {'dispatched '}
            {batch.dispatch_count}
            x
          </span>
        )}
        {batch.updated_at && (
          <span className="orch-batch-time">{new Date(batch.updated_at).toLocaleString()}</span>
        )}
        {batch.started_at && <span className="orch-batch-time">started {new Date(batch.started_at).toLocaleString()}</span>}
        {(batch.completed_at || batch.finished_at) && (
          <span className="orch-batch-time">finished {new Date(batch.completed_at || batch.finished_at).toLocaleString()}</span>
        )}
        {lastEvent && <span className="orch-batch-event" title={lastEvent}>{lastEvent}</span>}
      </div>
      {expanded && (
        <div className="orch-batch-detail">
          {batch.last_error && (
            <pre className="orch-batch-error">{batch.last_error}</pre>
          )}
          {batch.last_result_excerpt && !batch.last_error && (
            <pre className="orch-batch-excerpt">{batch.last_result_excerpt}</pre>
          )}
          {hasSession && (
            <div className="orch-batch-preview-row">
              <button
                type="button"
                className="orch-preview-btn"
                onClick={() => onPreview(batch.id, batch.last_session_id)}
              >
                {previewLoading === batch.id ? 'loading...' : 'view transcript preview'}
              </button>
              {previewText?.batchId === batch.id && (
                <pre className="orch-preview-text">{previewText.text}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function OrchPanel({ project, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [researchGoal, setResearchGoal] = useState('');
  const [researchState, setResearchState] = useState('idle');
  const [executeState, setExecuteState] = useState('idle');
  const [overrideMutexReason, setOverrideMutexReason] = useState(null);
  const [previewText, setPreviewText] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(null);

  // For verify-mode: expose a way to force mutex blocked state
  useEffect(() => {
    window.__forceOrchMutex = (reason) => setOverrideMutexReason(reason);
    return () => { delete window.__forceOrchMutex; };
  }, []);

  // Same rule the rail's Orch chip is gated on, so the chip can never open a
  // panel that then cannot find a root. Its own finder used to accept a `live:`
  // row, which carries no session id and resolves nothing.
  const sessionId = useMemo(() => projectRootSessionId(project), [project]);

  // Start watching when panel opens, stop when it closes
  useEffect(() => {
    if (!sessionId) { setError('No session to determine project root'); return undefined; }
    let active = true;
    window.harbor.orchestration.watch({ projectLabel: project.label, sessionId })
      .then((payload) => {
        if (!active) return;
        if (payload?.error) { setError(payload.error); return; }
        setData(payload);
        setError(null);
      })
      .catch((err) => { if (active) setError(err.message); });

    const unsub = window.harbor.orchestration.onUpdate((payload) => {
      setData(payload);
      setError(null);
    });

    return () => {
      active = false;
      unsub();
      window.harbor.orchestration.unwatch().catch(() => {});
    };
  }, [project.label, sessionId]);

  const sprintGroups = useMemo(() => {
    const batches = data?.queue?.batches || [];
    const sprintPlan = data?.queue?.sprint_plan || {};
    const groups = new Map();

    for (const batch of batches) {
      const sprintKey = batch.sprint != null ? String(batch.sprint) : null;
      const label = sprintKey && sprintPlan[sprintKey]
        ? `Sprint ${sprintKey}: ${sprintPlan[sprintKey].label}`
        : 'Unassigned';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(batch);
    }
    return groups;
  }, [data]);

  const mutex = overrideMutexReason
    ? { blocked: true, reason: overrideMutexReason }
    : (data?.mutex || { blocked: false, reason: null });

  const handlePreview = useCallback(async (batchId, sid) => {
    setPreviewLoading(batchId);
    try {
      const result = await window.harbor.orchestration.sessionPreview({ sessionId: sid });
      setPreviewText({ batchId, text: result?.text || '(no preview)' });
    } catch (err) {
      setPreviewText({ batchId, text: `Error: ${err.message}` });
    } finally {
      setPreviewLoading(null);
    }
  }, []);

  const handleResearch = async () => {
    if (!researchGoal.trim() || researchState === 'running') return;
    setResearchState('running');
    try {
      const result = await window.harbor.orchestration.kickoffResearch({
        projectLabel: project.label,
        sessionId,
        goal: researchGoal.trim(),
      });
      if (result?.error) throw new Error(result.error);
      setResearchState('done');
      setResearchGoal('');
      // The kickoff focused its new pane; close the panel so it is on screen.
      setTimeout(() => onClose?.(), 900);
    } catch (err) {
      setResearchState('error');
      setError(`Research kickoff failed: ${err.message}`);
    }
  };

  const handleExecute = async () => {
    if (mutex.blocked || executeState === 'running') return;
    setExecuteState('running');
    try {
      const result = await window.harbor.orchestration.kickoffExecute({
        projectLabel: project.label,
        sessionId,
      });
      if (result?.blocked) {
        setOverrideMutexReason(result.reason);
        setExecuteState('idle');
        return;
      }
      if (result?.error) throw new Error(result.error);
      setExecuteState('done');
      setTimeout(() => onClose?.(), 900);
    } catch (err) {
      setExecuteState('error');
      setError(`Execute kickoff failed: ${err.message}`);
    }
  };

  const workers = data?.workers || [];

  return (
    <div className="orch-panel">
      <div className="orch-panel-header">
        <div className="orch-panel-title-block">
          <h2 className="orch-panel-title">{project.label}</h2>
          <span className="orch-panel-subtitle">Orchestration</span>
        </div>
        <button type="button" className="orch-close-btn" onClick={onClose} aria-label="Close orchestration panel">
          Close
        </button>
      </div>

      {error && <div className="orch-error-banner">{error}</div>}

      {workers.length > 0 && (
        <div className="orch-section">
          <h3 className="orch-section-label">Workers</h3>
          <div className="orch-workers-list">
            {workers.map((w) => (
              <span key={w.name || w.id} className="orch-worker-tag">{w.name || w.id}</span>
            ))}
          </div>
        </div>
      )}

      <div className="orch-section orch-queue-section">
        <h3 className="orch-section-label">
          Queue
          {data?.projectRoot && (
            <span className="orch-queue-root" title={data.projectRoot}>{data.projectRoot}</span>
          )}
        </h3>
        {data?.summary && (
          <div className="orch-eta" role="status">
            <span>{`${data.summary.done}/${data.summary.total} complete`}</span>
            <span>{`ETA estimate: ${formatEta(data.summary.etaMs)}`}</span>
          </div>
        )}
        {!data && !error && <p className="orch-loading">Loading...</p>}
        {data && sprintGroups.size === 0 && (
          <div className="orch-empty">
            <p className="orch-empty-title">No batches in queue</p>
            <p className="orch-empty-hint">
              A queue appears after running
              {' '}
              <code>/orchestrate-research</code>
              {' '}
              in this project.
            </p>
          </div>
        )}
        {[...sprintGroups.entries()].map(([label, batches]) => (
          <div key={label} className="orch-sprint">
            <h4 className="orch-sprint-label">{label}</h4>
            {batches.map((batch) => (
              <BatchCard
                key={batch.id}
                batch={batch}
                onPreview={handlePreview}
                previewText={previewText}
                previewLoading={previewLoading}
              />
            ))}
          </div>
        ))}
      </div>

      {data?.events?.length > 0 && (
        <div className="orch-section orch-events-section">
          <h3 className="orch-section-label">Events</h3>
          <div className="orch-events-list">
            {data.events.map((event, index) => (
              <div className="orch-event-row" key={`${event.t}-${index}`}>
                <time>{event.t}</time>
                <span>{event.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="orch-section orch-kickoff-section">
        <h3 className="orch-section-label">Kickoff</h3>

        <div className="orch-kickoff-research">
          <label className="orch-goal-label" htmlFor="orch-goal-input">Research goal</label>
          <textarea
            id="orch-goal-input"
            className="orch-goal-textarea"
            value={researchGoal}
            onInput={(e) => setResearchGoal(e.target.value)}
            placeholder="Describe the research goal..."
            rows={4}
          />
          <button
            type="button"
            className="orch-kickoff-btn orch-research-btn"
            disabled={!researchGoal.trim() || researchState === 'running' || !sessionId}
            onClick={handleResearch}
          >
            {researchState === 'running' ? 'Starting...' : 'Start research (team)'}
          </button>
          {researchState === 'done' && (
            <p className="orch-kickoff-ok">Research session started. Opening its pane...</p>
          )}
        </div>

        <div className="orch-kickoff-execute">
          <button
            type="button"
            className="orch-kickoff-btn orch-execute-btn"
            disabled={mutex.blocked || executeState === 'running' || !sessionId}
            onClick={handleExecute}
          >
            {executeState === 'running' ? 'Starting...' : 'Execute (team)'}
          </button>
          {mutex.blocked && (
            <p className="orch-mutex-reason">{mutex.reason}</p>
          )}
          {executeState === 'done' && !mutex.blocked && (
            <p className="orch-kickoff-ok">Execution session started. Opening its pane...</p>
          )}
        </div>
      </div>
    </div>
  );
}
