import React, { memo } from 'react';

// The task checklist card (main/providers/transcript.js syncTasksBlock): the
// FULL task list as of the latest task call in its turn. Shared by the desktop
// conversation (stage/Conversation.jsx, styled in renderer/styles.css) and the
// phone's (web/src/conversation/Conversation.jsx, styled in its own
// conversation.css); both draw the same markup and class names.
//
// Nothing in either stylesheet animates (test/renderer/
// no-decorative-gpu-cost.test.js), so "in progress" is a shape and a colour:
// a blue arc while the turn still runs, a plain ring once it ended.
export function TaskIcon({ status, live }) {
  if (status === 'completed') {
    return (
      <svg className="conv-task-icon done" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" />
        <path d="M4.9 8.3l2.1 2.1 4.2-4.4" />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return (
      <svg className={`conv-task-icon doing${live ? ' live' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
        <circle className="track" cx="8" cy="8" r="6" />
        {live ? <path className="arc" d="M8 2a6 6 0 0 1 6 6a6 6 0 0 1-3 5.2" /> : null}
      </svg>
    );
  }
  return (
    <svg className="conv-task-icon todo" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
    </svg>
  );
}

const TASK_STATE_LABEL = { pending: 'Not started', in_progress: 'In progress', completed: 'Done' };

// Rows are keyed by task id (ids are unique within a list; the parser never
// lets two collide), so removing one task does not remount the rows after it.
export const TaskCard = memo(function TaskCard({ tasks, live }) {
  if (!tasks?.length) return null;
  return (
    <div className={`conv-tasks${live ? ' live' : ''}`} role="list" aria-label="Tasks">
      {tasks.map((task) => {
        const text = task.status === 'in_progress' ? (task.activeForm || task.subject) : task.subject;
        return (
          <div
            key={task.id}
            role="listitem"
            className={`conv-task ${task.status}`}
            title={`${TASK_STATE_LABEL[task.status] || ''}: ${task.subject}`}
          >
            <TaskIcon status={task.status} live={live} />
            <span className="conv-task-text">{text}</span>
          </div>
        );
      })}
    </div>
  );
});
