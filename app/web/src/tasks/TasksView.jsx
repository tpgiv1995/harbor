import React, { useMemo, useState } from 'react';
import tasksModel from '../../../src/shared/tasks-model.cjs';
import { projectColor } from '../../../src/renderer/stage/project-colors.js';
import { resolveListColor } from '../../../src/renderer/tasks/list-color.cjs';
import { useTasks, useToday } from './useTasks.js';
import './tasks.css';

const { selectRows, counts, dayDate } = tasksModel;

const VIEWS = [
  ['myday', 'My Day'],
  ['important', 'Important'],
  ['planned', 'Planned'],
  ['all', 'All'],
  ['completed', 'Done'],
];

const EMPTY_COPY = {
  myday: {
    title: 'My Day is clear',
    hint: 'Add something below, or star a task and it will land here tomorrow.',
  },
  important: {
    title: 'Nothing starred yet',
    hint: 'Tap the star on a task to pin it here.',
  },
  planned: {
    title: 'No dates on the board',
    hint: 'Tasks with a due date show up here, overdue first.',
  },
  all: {
    title: 'No tasks yet',
    hint: 'Capture one below — it stays yours, not rewritten by anyone else.',
  },
  completed: {
    title: 'Nothing finished yet',
    hint: 'Completed tasks gather here when you check them off.',
  },
};

function TaskRow({ row, showMyDay, onToggleDone, onToggleStar }) {
  const { task } = row;
  const bits = [];
  if (row.dueLabel) bits.push({ key: 'due', text: row.dueLabel, cls: `due-${row.due}` });
  if (row.myDay && showMyDay) bits.push({ key: 'myday', text: '☀ My Day', cls: 'myday' });

  return (
    <div className={`mtask-row${task.done ? ' done' : ''}`} data-task-id={task.id}>
      <button
        type="button"
        className={`mtask-check${task.done ? ' on' : ''}`}
        aria-label={task.done ? `Mark ${task.title} not done` : `Mark ${task.title} done`}
        onClick={() => onToggleDone(task)}
      >
        ✓
      </button>
      <div className="mtask-main">
        <span className="mtask-title">{task.title}</span>
        {bits.length ? (
          <span className="mtask-meta">
            {bits.map((bit) => (
              <span key={bit.key} className={`mtask-meta-bit${bit.cls ? ` ${bit.cls}` : ''}`}>
                {bit.text}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className={`mtask-star${task.starred ? ' on' : ''}`}
        aria-label={task.starred ? 'Remove from Important' : 'Mark important'}
        onClick={() => onToggleStar(task)}
      >
        ★
      </button>
    </div>
  );
}

function EmptyState({ view }) {
  const copy = EMPTY_COPY[view] || EMPTY_COPY.all;
  return (
    <div className="tasks-mobile-empty motion-fade-up" role="status">
      <p className="tasks-mobile-empty-title">{copy.title}</p>
      <p className="tasks-mobile-empty-hint">{copy.hint}</p>
    </div>
  );
}

export function TasksView({ client }) {
  const today = useToday();
  const { doc, error, notice, dismissNotice, mutate } = useTasks(client);
  const [view, setView] = useState('myday');
  const [addDraft, setAddDraft] = useState('');
  const [query, setQuery] = useState('');

  const stats = useMemo(() => (doc ? counts(doc, today) : null), [doc, today]);
  const rows = useMemo(() => {
    if (!doc) return { open: [], done: [] };
    return selectRows(doc, { view, today, query, sort: 'manual' });
  }, [doc, view, today, query]);

  const addTask = (event) => {
    event.preventDefault();
    const title = addDraft.trim();
    if (!title || !doc) return;
    setAddDraft('');
    mutate({
      type: 'task.add',
      listId: doc.lists[0]?.id || null,
      title,
      myDay: view === 'myday',
      starred: view === 'important',
      dueDate: view === 'planned' ? today : null,
    });
  };

  if (error) {
    return (
      <div className="tasks-mobile" role="alert">
        <p>{`Tasks could not load: ${error}`}</p>
      </div>
    );
  }

  if (!doc) {
    return <div className="tasks-mobile">Loading tasks…</div>;
  }

  const headingDate = view === 'myday' && dayDate(today)
    ? dayDate(today).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : null;

  return (
    <div className="tasks-mobile" aria-label="Tasks">
      <header className="tasks-mobile-head">
        <h2 className="tasks-mobile-title">Tasks</h2>
        {headingDate ? <span className="tasks-mobile-date">{headingDate}</span> : null}
      </header>

      <div className="tasks-view-tabs" role="tablist" aria-label="Task views">
        {VIEWS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            className={`tasks-view-tab${view === key ? ' active' : ''}`}
            onClick={() => setView(key)}
          >
            {label}
            {stats?.[key] ? <span className="tasks-view-count">{stats[key]}</span> : null}
          </button>
        ))}
      </div>

      <div className="tasks-mobile-search">
        <input
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search tasks"
        />
      </div>

      {view !== 'completed' ? (
        <form className="tasks-mobile-add" onSubmit={addTask}>
          <input
            value={addDraft}
            onChange={(e) => setAddDraft(e.target.value)}
            placeholder="Add a task"
            aria-label="Add a task"
          />
          <button type="submit" className="tasks-mobile-add-btn" disabled={!addDraft.trim()}>
            Add
          </button>
        </form>
      ) : null}

      <div className="tasks-mobile-list">
        {rows.open.length === 0 && rows.done.length === 0 ? (
          <EmptyState view={view} />
        ) : null}
        {rows.open.map((row) => (
          <TaskRow
            key={row.task.id}
            row={row}
            showMyDay={view !== 'myday'}
            onToggleDone={(task) => mutate({ type: 'task.setDone', taskId: task.id, done: !task.done })}
            onToggleStar={(task) => mutate({ type: 'task.update', taskId: task.id, patch: { starred: !task.starred } })}
          />
        ))}
        {rows.done.length ? (
          <details className="tasks-mobile-done">
            <summary>{`Completed (${rows.done.length})`}</summary>
            {rows.done.map((row) => (
              <TaskRow
                key={row.task.id}
                row={row}
                showMyDay={view !== 'myday'}
                onToggleDone={(task) => mutate({ type: 'task.setDone', taskId: task.id, done: !task.done })}
                onToggleStar={(task) => mutate({ type: 'task.update', taskId: task.id, patch: { starred: !task.starred } })}
              />
            ))}
          </details>
        ) : null}
      </div>

      {doc.lists.length ? (
        <div className="tasks-mobile-lists" aria-label="Lists">
          {doc.lists.map((list) => (
            <span
              key={list.id}
              className="tasks-list-chip"
              // A colour chosen on the desktop is a property of the LIST, so
              // the phone must render it too. Falling back to the name hash
              // keeps every list that has no chosen colour looking unchanged.
              style={{ '--tag-color': resolveListColor(list, projectColor) }}
            >
              {list.name}
              {stats?.byList?.[list.id] ? ` (${stats.byList[list.id]})` : ''}
            </span>
          ))}
        </div>
      ) : null}

      {notice ? (
        <div className="app-toast" role="alert">
          <span>{notice}</span>
          <button type="button" onClick={dismissNotice} aria-label="Dismiss">×</button>
        </div>
      ) : null}
    </div>
  );
}

export default TasksView;
