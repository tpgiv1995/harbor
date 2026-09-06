import React from 'react';
import { ProjectIcon } from './ProjectIcon.jsx';
import { formatRelative } from './format.js';

export function SessionRow({
  row, selected, onSelect, iconUrl, showProject = false,
}) {
  const { session } = row;
  const needsAnswer = session.agentStatus === 'blocked';
  const working = session.agentStatus === 'working';
  const title = session.childTitle || session.title;

  return (
    <button
      type="button"
      className={[
        'session-row',
        selected ? 'selected' : '',
        needsAnswer ? 'needs-answer' : '',
        row.pinned ? 'pinned' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onSelect(session)}
    >
      <ProjectIcon label={row.project?.label || session.project} url={iconUrl} />
      <span className={`session-dot${session.isLive ? ' live' : ''}${needsAnswer ? ' blocked' : ''}`} aria-hidden="true" />
      {/* ONE encoding of state per row. This said it three times at once: the
          dot, the word "Idle" under the title, and an "Idle" pill on the
          right, so the loudest thing on a row was the least useful fact about
          it. The dot carries live/blocked, the pill carries only a state worth
          acting on, and the meta line is left for the time. */}
      <span className="session-body">
        <span className="session-title">{title}</span>
        <span className="session-meta">
          {showProject ? (
            <span className="session-project">{row.project?.label || session.project}</span>
          ) : null}
          <span className="session-time">{formatRelative(session.lastActiveMs)}</span>
        </span>
      </span>
      {needsAnswer ? <span className="session-badge">Answer</span> : null}
      {working ? <span className="session-badge working">Working</span> : null}
    </button>
  );
}

