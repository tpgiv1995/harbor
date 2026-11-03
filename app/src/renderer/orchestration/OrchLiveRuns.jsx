import React, { useState } from 'react';
import { OrchProjectPicker } from './OrchProjectPicker.jsx';
import { SubSessions } from './SubSessions.jsx';
import { TeamChart } from './TeamChart.jsx';

// The Orch view's landing page. Since 2026-11-02 the Live runs list and the
// Delegated agents list are one TEAM CHART (Pat: "an upgrade of the Orch view,
// not a new tab"): every running agent as a card, who launched or directs
// whom as lines, each run's batches and ETA in its project's header with the
// link into the run panel (Research and Execute live there).
//
// Since 2026-11-03 the sub-sessions are ON the chart, as trays of mini cards
// under the agents that started them (Pat: "showing all these down below
// defeats the whole point"). The searchable list stays for history, search
// and "Show in rail", folded shut and not even mounted (so not polling)
// until it is opened.
export function OrchLiveRuns({ projects, onPick, focusParentId, onOpenSession }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <div className="orch-overview">
      <TeamChart onPick={onPick} onOpenSession={onOpenSession} focusId={focusParentId} />
      <details className="orch-subs-history" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <summary>Search all sub-sessions</summary>
        {historyOpen ? <SubSessions onOpenSession={onOpenSession} /> : null}
      </details>
      <div className="orch-overview-kickoff">
        <h3>Start or inspect another project</h3>
        <OrchProjectPicker projects={projects} onPick={onPick} compact />
      </div>
    </div>
  );
}
