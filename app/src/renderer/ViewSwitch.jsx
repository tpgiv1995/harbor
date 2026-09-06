import React from 'react';

// The six top-level surfaces include the conversation stage, personal tasks,
// formatted notes, the whiteboard, orchestration, and agent output files.
// This lives at the TOP of the session rail, above the Sessions header and the
// P/T/S launchers.
//
// Tasks sits second on purpose: it and Agents are the two surfaces used all day,
// so they are adjacent. "Files" is the old "Artifacts" tab renamed, which is
// both plainer English and compact enough for the rail.
const VIEWS = [
  ['agents', 'Agents', 'Conversation windows (the stage)', ['M2.5 5.25h7v4.5h-4l-2.5 2v-2h-.5z', 'M7 3.25h6.5v4.5h-2l-2 1.5v-1.5']],
  ['tasks', 'Tasks', 'Your to-do lists', ['M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12', 'm5 8 2 2 4-4']],
  ['notes', 'Notes', 'Drafts formatted for pasting elsewhere', ['M3.25 2.25h6l3.5 3.5v8h-9.5z', 'M9.25 2.5v3.25h3.25', 'm5 11 4.75-4.75 1.5 1.5L6.5 12.5 4.5 13z']],
  ['board', 'Board', 'Infinite whiteboard', ['M2.5 2.5h4.25v4.25H2.5z', 'M9.25 2.5h4.25v4.25H9.25z', 'M2.5 9.25h4.25v4.25H2.5z', 'M9.25 9.25h4.25v4.25H9.25z']],
  ['orch', 'Orch', 'Orchestration queues and kickoff', ['M8 2.25v3.5', 'M3.25 10.25V8h9.5v2.25', 'M2 10.25h2.5v3.5H2z', 'M6.75 10.25h2.5v3.5h-2.5z', 'M11.5 10.25H14v3.5h-2.5z']],
  ['artifacts', 'Files', 'Files your agents produced', ['M2.25 4.25h4l1.25 1.5h6.25v7.5H2.25z', 'M2.25 5.75v-3h4.5l1.25 1.5h5.75v1.5']],
];

// Orchestration is optional (the setup wizard can turn it off, and not everyone
// runs a delegate queue). A disabled Orch tab is removed rather than greyed: the
// panel behind it has no launcher configured, so leaving the tab visible is the
// skippable step into a dead end this repo's doctrine forbids.
export function ViewSwitch({ view, onViewChange, orchEnabled = true, taskAlert = 0 }) {
  const views = orchEnabled ? VIEWS : VIEWS.filter(([key]) => key !== 'orch');
  return (
    <div className="view-switch" role="tablist" aria-label="Main view">
      {views.map(([key, label, title, glyph]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-label={label}
          aria-selected={view === key}
          className={`view-switch-btn${view === key ? ' active' : ''}`}
          title={key === 'tasks' && taskAlert
            ? `${title} · ${taskAlert} due today or overdue`
            : title}
          onClick={() => onViewChange(key)}
        >
          <span className="vs-glyph-wrap" aria-hidden="true">
            <svg className="vs-glyph" viewBox="0 0 16 16" fill="none">
              {glyph.map((d) => <path key={d} d={d} />)}
            </svg>
          </span>
          <span className="vs-label">{label}</span>
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
