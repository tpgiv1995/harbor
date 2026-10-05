import { RetainedAdds, useRetainedAdds } from '../RetainedAdds.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import tasksModel from '../../shared/tasks-model.cjs';
import { usePendingPatches } from '../use-pending-patches.js';
import '../edit-save-status.css';
import { armedConfirmClick, DISARM_MS } from '../armed-confirm.cjs';

const {
  MAX_DEPTH, childrenOf, dueLabel, isMyDay, shiftDay, tagKey,
} = tasksModel;

// How long typing settles before it reaches disk. Long enough that a sentence
// is one write, short enough that closing the window a beat later has already
// saved. Every path also flushes explicitly, so this is a latency knob and
// never the thing standing between a keystroke and durability.
const TYPING_SETTLE_MS = 400;

function stamp(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function DueChips({ today, value, onPick }) {
  const chips = [
    ['Today', today],
    ['Tomorrow', shiftDay(today, 1)],
    ['Next week', shiftDay(today, 7)],
  ];
  return (
    <div className="task-editor-chips">
      {chips.map(([label, key]) => (
        <button
          key={label}
          type="button"
          className={`task-editor-chip${value === key ? ' on' : ''}`}
          onClick={() => onPick(value === key ? null : key)}
        >
          {label}
        </button>
      ))}
      {value ? (
        <button type="button" className="task-editor-chip clear" onClick={() => onPick(null)}>
          Clear
        </button>
      ) : null}
    </div>
  );
}

function TagField({ tags, onChange }) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const value = draft.trim();
    if (!value) return;
    // Comma-separated in one go, because that is how a list of labels gets
    // typed when it is already in your head.
    const added = value.split(',').map((t) => t.trim()).filter(Boolean);
    const merged = [...tags];
    for (const tag of added) {
      if (!merged.some((t) => tagKey(t) === tagKey(tag))) merged.push(tag);
    }
    setDraft('');
    onChange(merged);
  };
  return (
    <div className="task-editor-tags">
      {tags.map((tag) => (
        <span className="task-editor-tag" key={tagKey(tag)}>
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            onClick={() => onChange(tags.filter((t) => tagKey(t) !== tagKey(tag)))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="task-editor-tag-input"
        value={draft}
        placeholder={tags.length ? 'Add another' : 'work, errands'}
        aria-label="Add a tag"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
          if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
        }}
      />
    </div>
  );
}

/**
 * The full editor for one task: every field it has, its sub-tasks, and the
 * metadata that says when it was created, last changed and finished.
 *
 * Two rules keep it honest while it is open:
 *   * Typed fields are UNCONTROLLED-ish (local state, seeded once per task id)
 *     and settle to disk on a timer. A document update arriving mid-sentence
 *     must never rewrite the caret out from under the sentence, which is the
 *     same lesson the composer learned.
 *   * Everything that is a single decision (a checkbox, a date, a list) writes
 *     IMMEDIATELY. There is no Save button to forget to press.
 */
export function TaskEditor({ doc, taskId, today, onNavigate, onClose, mutate, onAssign }) {
  const savedTask = useMemo(() => doc.tasks.find((t) => t.id === taskId) || null, [doc, taskId]);
  const edits = usePendingPatches('task', taskId, mutate);
  const task = savedTask ? { ...savedTask, ...edits.draft,
    ...('myDay' in edits.draft ? { myDayDate: edits.draft.myDay ? today : null } : {}),
  } : null;
  const parent = useMemo(
    () => (task?.parentId ? doc.tasks.find((t) => t.id === task.parentId) || null : null),
    [doc, task],
  );
  const children = useMemo(() => (task ? childrenOf(doc, task.id) : []), [doc, task]);

  const [title, setTitle] = useState(task?.title || '');
  const [notes, setNotes] = useState(task?.notes || '');
  const [subDraft, setSubDraft] = useState('');
  const additions = useRetainedAdds('harbor-failed-editor-task-adds', mutate);
  const [armedDelete, setArmedDelete] = useState(null);
  const settleRef = useRef(null);
  const titleRef = useRef(null);

  // Seed on IDENTITY, not on every document change: re-seeding on each update
  // would fight the keyboard, because every keystroke causes an update.
  useEffect(() => {
    setTitle(task?.title || '');
    setNotes(task?.notes || '');
    setSubDraft('');
    setArmedDelete(null);
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(async () => {
    clearTimeout(settleRef.current);
    return (await edits.flush()).ok;
  }, [edits.flush]);

  const settle = useCallback((fields) => {
    edits.queue(fields);
    clearTimeout(settleRef.current);
    settleRef.current = setTimeout(flush, TYPING_SETTLE_MS);
  }, [edits.queue, flush]);

  // Unmount is the last chance: closing the window, switching tasks or quitting
  // the view must not drop the sentence that was mid-settle.
  useEffect(() => flush, [flush]);

  const close = useCallback(async () => {
    if (await flush()) onClose();
  }, [flush, onClose]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  useEffect(() => {
    if (armedDelete === null) return undefined;
    const timer = setTimeout(() => setArmedDelete(null), DISARM_MS);
    return () => clearTimeout(timer);
  }, [armedDelete]);

  useEffect(() => { titleRef.current?.focus(); }, [taskId]);

  if (!task) return null;

  const patch = async (fields) => {
    settle(fields);
    return flush();
  };
  const navigate = async (id) => { if (await flush()) onNavigate(id); };

  const onDelete = async () => {
    const { armed, fire } = armedConfirmClick(armedDelete, Date.now());
    setArmedDelete(armed);
    if (!fire) return;
    if (!await flush()) return;
    const result = await mutate({ type: 'task.remove', taskId });
    if (result?.ok) onClose();
  };

  const addSub = (event) => {
    event.preventDefault();
    const value = subDraft.trim();
    if (!value) return;
    setSubDraft('');
    additions.add({ type: 'task.add', parentId: task.id, title: value }).then((result) => {
      if (!result?.ok) setSubDraft((current) => current || value);
    });
  };

  const due = dueLabel(task, today);

  return createPortal(
    <div className="task-editor" role="dialog" aria-modal="true" aria-label={`Edit task ${task.title}`}>
      <button type="button" tabIndex={-1} className="task-editor-backdrop" aria-label="Close editor" onClick={close} />
      <div className="task-editor-panel">
        <div className="task-editor-head">
          <button
            type="button"
            className={`task-check${task.done ? ' on' : ''}`}
            aria-label={task.done ? 'Mark as not completed' : 'Mark as completed'}
            aria-pressed={task.done}
            onClick={() => mutate({ type: 'task.setDone', taskId, done: !task.done })}
          >
            <span className="task-check-mark" aria-hidden="true">✓</span>
          </button>
          <div className="task-editor-headings">
            {parent ? (
              <button
                type="button"
                className="task-editor-parent"
                title="Open the parent task"
                onClick={() => navigate(parent.id)}
              >
                {`↑ ${parent.title}`}
              </button>
            ) : null}
            <input
              ref={titleRef}
              className="task-editor-title"
              value={title}
              aria-label="Task name"
              onChange={(e) => { setTitle(e.target.value); settle({ title: e.target.value }); }}
              onBlur={flush}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); flush(); } }}
            />
          </div>
          <button
            type="button"
            className={`task-star${task.starred ? ' on' : ''}`}
            aria-label={task.starred ? 'Remove from Important' : 'Mark as important'}
            aria-pressed={task.starred}
            onClick={() => patch({ starred: !task.starred })}
          >
            ★
          </button>
          <button
            type="button"
            className="task-editor-duplicate"
            onClick={async () => {
              if (!await flush()) return;
              mutate({ type: 'task.duplicate', taskId }).then((r) => {
                if (r?.ok && r.taskId) onNavigate(r.taskId);
              });
            }}
          >
            Duplicate
          </button>
          <button type="button" className="task-editor-assign" onClick={async () => { if (await flush()) onAssign(); }}>Assign to Claude</button>
          <button type="button" className="task-editor-close" aria-label="Close" onClick={close}>×</button>
        </div>

        <div className="task-editor-body">
          {edits.needsAttention ? <div className="edit-save-status" role="status">
            <span>{edits.error || 'Unsaved changes are kept here until saved.'}</span>
            <button type="button" onClick={flush}>Retry save</button>
          </div> : null}
          <div className="task-editor-toggles">
            <button
              type="button"
              className={`task-editor-toggle${isMyDay(task, today) ? ' on' : ''}`}
              aria-pressed={isMyDay(task, today)}
              onClick={() => patch({ myDay: !isMyDay(task, today) })}
            >
              <span aria-hidden="true">☀</span>
              {isMyDay(task, today) ? 'In My Day' : 'Add to My Day'}
            </button>
            <span className={`task-editor-status status-${task.done ? 'done' : 'open'}`}>
              {task.done ? 'Completed' : 'Not completed'}
            </span>
          </div>

          <label className="task-editor-field">
            <span className="task-editor-label">Due date</span>
            <span className="task-editor-daterow">
              <input
                type="date"
                className="task-editor-date"
                value={task.dueDate || ''}
                onChange={(e) => patch({ dueDate: e.target.value || null })}
              />
              {due ? <span className={`task-editor-due due-${task.done ? 'done' : (tasksModel.dueState(task, today) || 'future')}`}>{due}</span> : null}
            </span>
          </label>
          <DueChips today={today} value={task.dueDate} onPick={(value) => patch({ dueDate: value })} />

          <label className="task-editor-field">
            <span className="task-editor-label">List</span>
            {task.parentId ? (
              <span className="task-editor-static">
                {`Sub-task of “${parent?.title || 'its parent'}”`}
              </span>
            ) : (
              <select
                className="task-editor-select"
                value={task.listId}
                onChange={(e) => patch({ listId: e.target.value })}
              >
                {doc.lists.map((list) => (
                  <option key={list.id} value={list.id}>{list.name}</option>
                ))}
              </select>
            )}
          </label>

          <div className="task-editor-field">
            <span className="task-editor-label">Tags</span>
            <TagField tags={task.tags} onChange={(tags) => patch({ tags })} />
          </div>

          <label className="task-editor-field">
            <span className="task-editor-label">Notes</span>
            <textarea
              className="task-editor-notes"
              value={notes}
              rows={5}
              placeholder="Anything you will want in front of you when you pick this up"
              onChange={(e) => { setNotes(e.target.value); settle({ notes: e.target.value }); }}
              onBlur={flush}
            />
          </label>

          <div className="task-editor-field">
            <span className="task-editor-label">
              {`Sub-tasks${children.length ? ` (${children.filter((c) => c.done).length}/${children.length})` : ''}`}
            </span>
            <RetainedAdds {...additions} onSaved={op => setSubDraft(current => current.trim() === op.title ? '' : current)} />
            <div className="task-editor-subs">
              {children.map((child) => (
                <div className={`task-editor-sub${child.done ? ' done' : ''}`} key={child.id}>
                  <button
                    type="button"
                    className={`task-check small${child.done ? ' on' : ''}`}
                    aria-label={child.done ? `Mark ${child.title} as not completed` : `Mark ${child.title} as completed`}
                    onClick={() => mutate({ type: 'task.setDone', taskId: child.id, done: !child.done })}
                  >
                    <span className="task-check-mark" aria-hidden="true">✓</span>
                  </button>
                  <button
                    type="button"
                    className="task-editor-sub-title"
                    onClick={() => navigate(child.id)}
                  >
                    {child.title}
                  </button>
                  <button
                    type="button"
                    className="task-editor-sub-del"
                    aria-label={`Delete ${child.title}`}
                    onClick={() => mutate({ type: 'task.remove', taskId: child.id })}
                  >
                    ×
                  </button>
                </div>
              ))}
              {task.depth < MAX_DEPTH ? (
                <form className="task-editor-subadd" onSubmit={addSub}>
                  <input
                    className="task-editor-subadd-input"
                    value={subDraft}
                    placeholder="Add a sub-task"
                    aria-label="Add a sub-task"
                    onChange={(e) => setSubDraft(e.target.value)}
                  />
                </form>
              ) : (
                <p className="task-editor-hint">
                  This is a level-3 sub-task, which is as deep as sub-tasks go.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="task-editor-foot">
          <span className="task-editor-meta">
            {`Created ${stamp(task.createdAt)}`}
            {task.updatedAt && task.updatedAt !== task.createdAt ? ` · Modified ${stamp(task.updatedAt)}` : ''}
            {task.completedAt ? ` · Completed ${stamp(task.completedAt)}` : ''}
          </span>
          <button
            type="button"
            className={`task-editor-delete${armedDelete ? ' armed' : ''}`}
            onClick={onDelete}
          >
            {armedDelete
              ? (children.length ? `Delete this and ${children.length} sub-task${children.length > 1 ? 's' : ''}?` : 'Delete for good?')
              : 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
