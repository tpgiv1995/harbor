import React from 'react';
import { OrchProjectPicker } from './OrchProjectPicker.jsx';
import { SubSessions } from './SubSessions.jsx';
import { TeamChart } from './TeamChart.jsx';

// The Orch view's landing page. Since 2026-11-02 the Live runs list and the
// Delegated agents list are one TEAM CHART (Pat: "an upgrade of the Orch view,
// not a new tab"): every running agent as a card, who launched or directs
// whom as lines, each run's batches and ETA in its project's header with the
// link into the run panel (Research and Execute live there). Sub-sessions
// stays as it was, and so does the project picker below it.
export function OrchLiveRuns({ projects, onPick, focusParentId, onOpenSession }) {
  return (
    <div className="orch-overview">
      <TeamChart onPick={onPick} onOpenSession={onOpenSession} focusId={focusParentId} />
      <SubSessions onOpenSession={onOpenSession} />
      <div className="orch-overview-kickoff">
        <h3>Start or inspect another project</h3>
        <OrchProjectPicker projects={projects} onPick={onPick} compact />
      </div>
    </div>
  );
}
