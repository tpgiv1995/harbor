import React from 'react';

// The four top-level surfaces (Pat, 2026-07-25, extended 2026-07-30): Agents is
// the conversation stage, Tasks is the personal to-do list, Orch promotes the
// per-project orchestration panel to a peer, and Files browses what agents
// produced. Lives at the TOP of the session rail (moved from the title bar on
// Pat's request), above the Sessions header and the P/T/S launchers.
//
// Tasks sits second on purpose: it and Agents are the two surfaces used all day,
// so they are adjacent. "Files" is the old "Artifacts" tab renamed, which is
// both plainer English and the label that lets four tabs fit the rail without
// anything ellipsizing (measured, not guessed; see .view-switch in styles.css).
const VIEWS = [
  ['agents', 'Agents', 'Conversation windows (the stage)'],
  ['tasks', 'Tasks', 'Your to-do lists'],
  ['orch', 'Orch', 'Orchestration queues and kickoff'],
  ['artifacts', 'Files', 'Files your agents produced'],
];

// Orchestration is optional (the setup wizard can turn it off, and not everyone
// runs a delegate queue). A disabled Orch tab is removed rather than greyed: the
// panel behind it has no launcher configured, so leaving the tab visible is the
// skippable step into a dead end this repo's doctrine forbids.
export function ViewSwitch({ view, onViewChange, orchEnabled = true, taskAlert = 0 }) {
  const views = orchEnabled ? VIEWS : VIEWS.filter(([key]) => key !== 'orch');
  return (
    <div className="view-switch" role="tablist" aria-label="Main view">
      {views.map(([key, label, title]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={view === key}
          className={`view-switch-btn${view === key ? ' active' : ''}`}
          title={key === 'tasks' && taskAlert
            ? `${title} · ${taskAlert} due today or overdue`
            : title}
          onClick={() => onViewChange(key)}
        >
          {label}
          {/* The one badge on this control, and only when something is actually
              due: a permanent count would be furniture, but "you have three
              things due today" is the entire reason the view exists. */}
          {key === 'tasks' && taskAlert ? (
            <span className="view-switch-badge" aria-label={`${taskAlert} due today or overdue`}>
              {taskAlert > 99 ? '99+' : taskAlert}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
