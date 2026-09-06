import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import tasksModel from '../../shared/tasks-model.cjs';
import { projectColor } from '../stage/project-colors.js';
import { armedConfirmClick, DISARM_MS } from '../armed-confirm.cjs';
import { planMove } from './reorder-move.cjs';
import { TaskEditor } from './TaskEditor.jsx';
import { ColorPicker } from './ColorPicker.jsx';
import { resolveListColor } from './list-color.cjs';
import { AssignToClaudeModal } from './AssignToClaudeModal.jsx';

const {
  MAX_DEPTH, SORTS, childrenOf, counts, dayDate, selectRows, sortComparator, tagIndex, tagKey,
} = tasksModel;

// The Tasks view: a plain, fast place to put something down before it is
// forgotten, in the shape Microsoft To Do proved works. Smart views on the left
// (My Day, Important, Planned), real lists under them, tags under those; one
// input at the top of the main column that turns a sentence into a task on
// Enter; a circle you click to finish something.
//
// Nothing here talks to a session, a pane or a daemon. It is the one surface in
// Harbor that is purely the user's own, which is why the document behind it is
// plain JSON in their config folder rather than anything Harbor-shaped.

const UI_STORE_KEY = 'harbor-tasks-ui';

const SMART = [
  ['myday', '☀', 'My Day'],
  ['important', '★', 'Important'],
  ['planned', '◷', 'Planned'],
  ['all', '≡', 'All tasks'],
  ['completed', '✓', 'Completed'],
];

const SORT_LABEL = {
  manual: 'My order',
  due: 'Due date',
  created: 'Recently added',
  title: 'Alphabetical',
};

const EMPTY = {
  myday: ['Nothing in My Day yet', 'Put what you actually intend to do today here. It clears itself each morning.'],
  important: ['Nothing marked important', 'Star a task and it shows up here.'],
  planned: ['Nothing has a due date', 'Give a task a date and it lands here.'],
  all: ['No open tasks', 'Type in the box above and press Enter.'],
  completed: ['Nothing completed yet', 'Finished tasks collect here.'],
  list: ['This list is empty', 'Type in the box above and press Enter.'],
};

function readUiState() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STORE_KEY) || 'null');
    return saved && typeof saved === 'object' ? saved : {};
  } catch { return {}; }
}

function longDate(key) {
  const date = dayDate(key);
  return date
    ? date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : '';
}

function dropPosition(event, element) {
  const box = element.getBoundingClientRect();
  return event.clientY < box.top + box.height / 2 ? 'before' : 'after';
}

function TaskRow({
  row, showList, showMyDay, collapsed, dragId, dragOver, onToggleDone, onToggleStar, onOpen,
  onToggleCollapse, onAddSub, onDuplicate, onMove, onDragState,
  onAssign,
}) {
  const { task, depth, childCount, childDoneCount } = row;
  const bits = [];
  if (row.breadcrumb?.length) bits.push({ key: 'trail', text: row.breadcrumb.join(' › '), cls: 'trail' });
  if (showList && !row.breadcrumb?.length && row.listName) bits.push({ key: 'list', text: row.listName });
  if (row.dueLabel) bits.push({ key: 'due', text: row.dueLabel, cls: `due-${row.due}` });
  // My Day reads as METADATA, beside the due date, not as a second flag at the
  // right edge: measured at 2560x1600, a ☀ next to the ★ rendered as two nearly
  // identical glyphs and looked like a bug. Suppressed inside My Day itself,
  // where saying it on every row says nothing.
  if (row.myDay && showMyDay) bits.push({ key: 'myday', text: '☀ My Day', cls: 'myday' });
  if (childCount) bits.push({ key: 'kids', text: `${childDoneCount}/${childCount} sub-tasks` });

  const draggable = Boolean(onMove);
  return (
    <div
      className={[
        'task-row',
        task.done ? 'done' : '',
        row.scaffold ? 'scaffold' : '',
        dragOver ? `dragover-${dragOver}` : '',
        dragId === task.id ? 'dragging' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--task-depth': depth }}
      data-task-id={task.id}
      data-depth={depth}
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable) return;
        event.dataTransfer.effectAllowed = 'move';
        // A private mime type, never Files: the window-level drop guard claims
        // any drag carrying Files, and an internal reorder must stay clear of it.
        event.dataTransfer.setData('text/harbor-task', task.id);
        onDragState({ id: task.id, over: null, position: null });
      }}
      onDragEnd={() => onDragState(null)}
      onDragOver={(event) => {
        if (!draggable || !dragId || dragId === task.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragState({ id: dragId, over: task.id, position: dropPosition(event, event.currentTarget) });
      }}
      onDragLeave={() => { if (dragOver) onDragState({ id: dragId, over: null, position: null }); }}
      onDrop={(event) => {
        if (!draggable || !dragId || dragId === task.id) return;
        event.preventDefault();
        const position = dropPosition(event, event.currentTarget);
        onDragState(null);
        onMove(dragId, task.id, position);
      }}
    >
      <span className="task-rail" aria-hidden="true" />
      <button
        type="button"
        className={`task-check${task.done ? ' on' : ''}`}
        aria-label={task.done ? `Mark ${task.title} as not completed` : `Mark ${task.title} as completed`}
        aria-pressed={task.done}
        onClick={() => onToggleDone(task)}
      >
        <span className="task-check-mark" aria-hidden="true">✓</span>
      </button>
      {/* Only where collapsing does something. A flat smart view lists every
          match as its own row, so a caret there would be a control that
          visibly does nothing. */}
      {childCount && onToggleCollapse ? (
        <button
          type="button"
          className={`task-expand${collapsed ? '' : ' open'}`}
          aria-label={collapsed ? `Show sub-tasks of ${task.title}` : `Hide sub-tasks of ${task.title}`}
          aria-expanded={!collapsed}
          onClick={() => onToggleCollapse(task.id)}
        >
          ▸
        </button>
      ) : (
        <span className="task-expand-spacer" aria-hidden="true" />
      )}
      <button
        type="button"
        className="task-main"
        onClick={() => onOpen(task.id)}
        onKeyDown={(event) => {
          // Alt+arrows move a task among its siblings. Dragging does the same
          // thing with a mouse; this is the path that works without one, and
          // the one a test can drive deterministically.
          if (!onMove || !event.altKey) return;
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          onMove(task.id, null, event.key === 'ArrowUp' ? 'up' : 'down');
        }}
      >
        <span className="task-title">{task.title}</span>
        {bits.length || task.tags.length ? (
          <span className="task-sub">
            {bits.map((bit) => (
              <span key={bit.key} className={`task-sub-bit${bit.cls ? ` ${bit.cls}` : ''}`}>{bit.text}</span>
            ))}
            {task.tags.map((tag) => (
              <span className="task-tag" key={tagKey(tag)} style={{ '--tag-color': projectColor(tag) }}>
                {tag}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      {depth < MAX_DEPTH ? (
        <button
          type="button"
          className="task-addsub"
          aria-label={`Add a sub-task to ${task.title}`}
          title="Add a sub-task"
          onClick={() => onAddSub(task.id)}
        >
          +
        </button>
      ) : null}
      <button
        type="button"
        className="task-duplicate"
        aria-label={`Duplicate ${task.title}`}
        title="Duplicate"
        onClick={() => onDuplicate(task.id)}
      >
        ⎘
      </button>
      <button type="button" className="task-assign-claude" title="Assign to Claude" aria-label={`Assign ${task.title} to Claude`} onClick={() => onAssign(task.id)}>Claude</button>
      <button
        type="button"
        className={`task-star${task.starred ? ' on' : ''}`}
        aria-label={task.starred ? `Remove ${task.title} from Important` : `Mark ${task.title} as important`}
        aria-pressed={task.starred}
        onClick={() => onToggleStar(task)}
      >
        ★
      </button>
    </div>
  );
}

export function TasksView({ doc, today, recovery, error, notice, dismissNotice, mutate }) {
  const [ui, setUi] = useState(readUiState);
  const [openId, setOpenId] = useState(null);
  const [assignId, setAssignId] = useState(null);
  const [addDraft, setAddDraft] = useState('');
  const [newList, setNewList] = useState(null);
  // The colour chosen for the list being created, and which existing list has
  // its recolour popover open. Separate state: creating and recolouring are
  // different flows and must not share a target.
  const [newListColor, setNewListColor] = useState(null);
  const [colorFor, setColorFor] = useState(null);
  const [subFor, setSubFor] = useState(null);
  const [subDraft, setSubDraft] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [armedClear, setArmedClear] = useState(null);
  const [armedListDelete, setArmedListDelete] = useState(null);
  const [drag, setDrag] = useState(null);
  const addRef = useRef(null);
  const subRef = useRef(null);
  // The sub-task add commits from both Enter and blur, and a focused input that
  // React unmounts can still emit focusout in Chromium. These refs make the
  // commit idempotent: whichever path runs first takes the value and clears it.
  const subForRef = useRef(null);
  const subDraftRef = useRef('');
  subDraftRef.current = subDraft;

  useEffect(() => {
    try { localStorage.setItem(UI_STORE_KEY, JSON.stringify(ui)); }
    catch { /* view state just will not restore */ }
  }, [ui]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(dismissNotice, 6000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  useEffect(() => {
    if (armedClear === null && armedListDelete === null) return undefined;
    const timer = setTimeout(() => { setArmedClear(null); setArmedListDelete(null); }, DISARM_MS);
    return () => clearTimeout(timer);
  }, [armedClear, armedListDelete]);

  useEffect(() => { if (subFor) subRef.current?.focus(); }, [subFor]);
  // The cursor lands in the add box when the view opens, because the whole point
  // is getting something written down before it is forgotten. Mount only: it
  // must not yank focus every time a list is clicked.
  useEffect(() => { addRef.current?.focus(); }, []);

  const lists = doc?.lists || [];
  const view = ui.view && (SMART.some(([k]) => k === ui.view) || ui.view === 'list') ? ui.view : 'myday';
  const storedListId = ui.listId && lists.some((l) => l.id === ui.listId) ? ui.listId : null;
  // A stored list that has since been deleted falls back rather than rendering
  // an empty pane titled with a name nothing answers to.
  const activeList = view === 'list' ? (storedListId || lists[0]?.id || null) : null;
  const activeView = view === 'list' && !activeList ? 'myday' : view;
  const sort = SORTS.includes(ui.sort) ? ui.sort : 'manual';
  const query = ui.query || '';
  const tag = ui.tag && (doc?.tasks || []).some((t) => t.tags.some((x) => tagKey(x) === tagKey(ui.tag)))
    ? ui.tag
    : null;
  const collapsed = useMemo(
    () => new Set(Array.isArray(ui.collapsed) ? ui.collapsed : []),
    [ui.collapsed],
  );

  const patchUi = useCallback((next) => setUi((prev) => ({ ...prev, ...next })), []);

  const stats = useMemo(() => (doc ? counts(doc, today) : null), [doc, today]);
  const tags = useMemo(() => (doc ? tagIndex(doc) : []), [doc]);

  const rows = useMemo(() => {
    if (!doc) return { mode: 'flat', open: [], done: [] };
    return selectRows(doc, { view: activeView, listId: activeList, today, query, sort, tag });
  }, [doc, activeView, activeList, today, query, sort, tag]);

  // Hide the descendants of a collapsed task without hiding the task itself.
  // Rows arrive parent-before-child, so one pass is enough.
  const hideCollapsed = useCallback((list) => {
    if (rows.mode !== 'tree') return list;
    const hidden = new Set();
    return list.filter((row) => {
      if (row.task.parentId && hidden.has(row.task.parentId)) { hidden.add(row.task.id); return false; }
      if (collapsed.has(row.task.id)) hidden.add(row.task.id);
      return true;
    });
  }, [rows.mode, collapsed]);

  const openRows = useMemo(() => hideCollapsed(rows.open), [rows.open, hideCollapsed]);
  const doneRows = useMemo(() => hideCollapsed(rows.done), [rows.done, hideCollapsed]);

  // Only counted where completed work is actually ON SCREEN. My Day, Important,
  // Planned and All tasks all show open work only, so offering to clear
  // completed there is an armed delete for things the user cannot see.
  const completedInScope = useMemo(() => {
    if (!doc || (activeView !== 'list' && activeView !== 'completed')) return 0;
    return doc.tasks.filter((t) => t.done && (activeView === 'list' ? t.listId === activeList : true)).length;
  }, [doc, activeView, activeList]);

  const listName = lists.find((l) => l.id === activeList)?.name || '';
  const heading = activeView === 'list'
    ? listName
    : SMART.find(([key]) => key === activeView)?.[2] || 'Tasks';

  const toggleCollapse = useCallback((id) => setUi((prev) => {
    const set = new Set(Array.isArray(prev.collapsed) ? prev.collapsed : []);
    if (set.has(id)) set.delete(id); else set.add(id);
    return { ...prev, collapsed: [...set] };
  }), []);

  const addTask = (event) => {
    event.preventDefault();
    const title = addDraft.trim();
    if (!title) return;
    setAddDraft('');
    // Adding INTO a smart view means what the view says: a task typed under My
    // Day is in My Day, one typed under Important is starred, one typed under
    // Planned is due today. Anything else creates a task that vanishes the
    // instant it exists, which is the fastest way to stop trusting a list.
    mutate({
      type: 'task.add',
      listId: activeList || lists[0]?.id || null,
      title,
      myDay: activeView === 'myday',
      starred: activeView === 'important',
      dueDate: activeView === 'planned' ? today : null,
      tags: tag ? [tag] : [],
    });
  };

  const commitSubTask = (event) => {
    event?.preventDefault?.();
    const parentId = subForRef.current;
    const title = subDraftRef.current.trim();
    subForRef.current = null;
    subDraftRef.current = '';
    setSubFor(null);
    setSubDraft('');
    if (!title || !parentId) return;
    // A brand-new sub-task under a collapsed parent would be invisible.
    setUi((prev) => ({
      ...prev,
      collapsed: (Array.isArray(prev.collapsed) ? prev.collapsed : []).filter((id) => id !== parentId),
    }));
    mutate({ type: 'task.add', parentId, title });
  };

  const openSubAdd = (parentId) => {
    subForRef.current = parentId;
    subDraftRef.current = '';
    setSubFor(parentId);
    setSubDraft('');
  };

  const move = useCallback((taskId, targetId, position) => {
    if (!doc) return;
    const task = doc.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const siblings = task.parentId
      ? childrenOf(doc, task.parentId)
      : doc.tasks.filter((t) => !t.parentId && t.listId === task.listId)
        .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    // Screen order and stored order are two different sequences once a star
    // pins its task to the top, so the translation between them lives in
    // planMove where a test can drive it.
    const plan = planMove({
      order: siblings.map((t) => t.id),
      shown: [...siblings].sort(sortComparator('manual')).map((t) => t.id),
      pinned: siblings.filter((t) => t.starred).map((t) => t.id),
      taskId,
      targetId,
      position,
    });
    if (!plan) return;
    mutate({ type: 'task.reorder', taskId, toIndex: plan.toIndex });
  }, [doc, mutate]);

  const clearCompleted = () => {
    const { armed, fire } = armedConfirmClick(armedClear, Date.now());
    setArmedClear(armed);
    if (fire) mutate({ type: 'tasks.purgeCompleted', listId: activeList || null });
  };

  const deleteList = (listId) => {
    // Arming is PER LIST: clicking one list's × and then another's must re-arm,
    // never inherit the first one's consent.
    const previous = armedListDelete?.listId === listId ? armedListDelete : null;
    const { armed, fire } = armedConfirmClick(previous, Date.now(), { listId });
    setArmedListDelete(armed);
    if (!fire) return;
    mutate({ type: 'list.remove', listId }).then((result) => {
      if (result?.ok) patchUi({ view: 'myday', listId: null });
    });
  };

  const rowProps = (row) => ({
    row,
    showList: activeView !== 'list',
    showMyDay: activeView !== 'myday',
    collapsed: collapsed.has(row.task.id),
    onToggleDone: (task) => mutate({ type: 'task.setDone', taskId: task.id, done: !task.done }),
    onToggleStar: (task) => mutate({ type: 'task.update', taskId: task.id, patch: { starred: !task.starred } }),
    onOpen: setOpenId,
    onToggleCollapse: rows.mode === 'tree' ? toggleCollapse : null,
    onAddSub: openSubAdd,
    onDuplicate: (taskId) => {
      mutate({ type: 'task.duplicate', taskId }).then((r) => {
        if (r?.ok && r.taskId) setOpenId(r.taskId);
      });
    },
    onDragState: setDrag,
    onAssign: setAssignId,
  });

  if (error) {
    return (
      <div className="tasks-view" aria-label="Tasks">
        <div className="tasks-error" role="alert">{`Tasks could not load: ${error}`}</div>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="tasks-view" aria-label="Tasks">
        <div className="tasks-loading">Loading tasks…</div>
      </div>
    );
  }

  const canAdd = activeView !== 'completed';
  const emptyCopy = EMPTY[activeView === 'list' ? 'list' : activeView] || EMPTY.all;
  // Manual order is only meaningful when the list is showing everything in its
  // own order; reordering a filtered or re-sorted view would move things the
  // user cannot see. Within that, a star pins its task to the top, so planMove
  // refuses a move ACROSS the pin rather than writing an order the screen
  // cannot show: the star is the pin, and unstarring is how a task comes back
  // down.
  const reorderable = sort === 'manual' && !query && !tag;

  return (
    <div className="tasks-view" aria-label="Tasks">
      <nav className="tasks-nav" aria-label="Task lists">
        <div className="tasks-search">
          <input
            className="tasks-search-input"
            type="search"
            value={query}
            placeholder="Search tasks"
            aria-label="Search tasks"
            onChange={(e) => patchUi({ query: e.target.value })}
          />
        </div>

        <div className="tasks-nav-sec">
          {SMART.map(([key, glyph, label]) => (
            <button
              key={key}
              type="button"
              className={`tasks-nav-btn${activeView === key ? ' active' : ''}`}
              onClick={() => patchUi({ view: key, listId: null })}
            >
              <span className="tasks-nav-glyph" aria-hidden="true">{glyph}</span>
              <span className="tasks-nav-label">{label}</span>
              {stats?.[key] ? <span className="tasks-nav-count">{stats[key]}</span> : null}
            </button>
          ))}
        </div>

        <div className="tasks-nav-sec">
          <h3 className="tasks-nav-sec-label">Lists</h3>
          {lists.map((list) => (
            <div className="tasks-list-row" key={list.id}>
              {renaming === list.id ? (
                <form
                  className="tasks-rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const name = new FormData(e.currentTarget).get('name');
                    setRenaming(null);
                    mutate({ type: 'list.rename', listId: list.id, name });
                  }}
                >
                  {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                  <input
                    name="name"
                    autoFocus
                    className="tasks-rename-input"
                    defaultValue={list.name}
                    aria-label="List name"
                    onBlur={(e) => e.currentTarget.form?.requestSubmit()}
                    onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }}
                  />
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className={`tasks-nav-btn${activeView === 'list' && activeList === list.id ? ' active' : ''}`}
                    onClick={() => patchUi({ view: 'list', listId: list.id })}
                    onDoubleClick={() => setRenaming(list.id)}
                  >
                    <span
                      className="tasks-nav-dot"
                      aria-hidden="true"
                      style={{ background: resolveListColor(list, projectColor) }}
                    />
                    <span className="tasks-nav-label">{list.name}</span>
                    {stats?.byList?.[list.id] ? (
                      <span className="tasks-nav-count">{stats.byList[list.id]}</span>
                    ) : null}
                  </button>
                  <span className="tasks-list-actions">
                    <button
                      type="button"
                      className="tasks-list-act tasks-list-color"
                      title="List colour"
                      aria-label={`Colour for ${list.name}`}
                      aria-expanded={colorFor === list.id}
                      onClick={() => setColorFor(colorFor === list.id ? null : list.id)}
                    >
                      <span
                        className="tasks-list-color-chip"
                        aria-hidden="true"
                        style={{ background: resolveListColor(list, projectColor) }}
                      />
                    </button>
                    {colorFor === list.id ? (
                      <div className="tasks-color-pop">
                        <ColorPicker
                          value={list.color || null}
                          onChange={(hex) => mutate({ type: 'list.color', listId: list.id, color: hex })}
                          onClose={() => setColorFor(null)}
                        />
                        {list.color ? (
                          <button
                            type="button"
                            className="tasks-color-reset"
                            onClick={() => {
                              mutate({ type: 'list.color', listId: list.id, color: null });
                              setColorFor(null);
                            }}
                          >
                            Reset to automatic
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="tasks-list-act"
                      title="Rename list"
                      aria-label={`Rename ${list.name}`}
                      onClick={() => setRenaming(list.id)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className={`tasks-list-act danger${armedListDelete?.listId === list.id ? ' armed' : ''}`}
                      title={armedListDelete?.listId === list.id
                        ? `Click again to delete ${list.name} and everything in it`
                        : 'Delete list'}
                      aria-label={`Delete ${list.name}`}
                      onClick={() => deleteList(list.id)}
                    >
                      {armedListDelete?.listId === list.id ? '!' : '×'}
                    </button>
                  </span>
                </>
              )}
            </div>
          ))}
          {newList === null ? (
            <button
              type="button"
              className="tasks-nav-btn tasks-newlist-btn"
              onClick={() => { setNewList(''); setNewListColor(null); }}
            >
              <span className="tasks-nav-glyph" aria-hidden="true">+</span>
              <span className="tasks-nav-label">New list</span>
            </button>
          ) : (
            <form
              className="tasks-newlist"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newList.trim();
                const color = newListColor;
                setNewList(null);
                setNewListColor(null);
                if (!name) return;
                mutate({ type: 'list.add', name, color }).then((result) => {
                  if (result?.ok && result.listId) patchUi({ view: 'list', listId: result.listId });
                });
              }}
            >
              <div className="tasks-newlist-row">
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input
                  autoFocus
                  className="tasks-newlist-input"
                  value={newList}
                  placeholder="List name"
                  aria-label="New list name"
                  onChange={(e) => setNewList(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setNewList(null); setNewListColor(null); } }}
                  // Submit-on-blur is what makes this form feel light, but a
                  // colour control sits INSIDE it now: without this guard,
                  // clicking a swatch blurs the field and submits the list
                  // before the colour is ever applied. Only a blur that leaves
                  // the form submits.
                  onBlur={(e) => {
                    if (!e.currentTarget.closest('.tasks-newlist')?.contains(e.relatedTarget)) {
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <span
                  className="tasks-newlist-preview"
                  aria-hidden="true"
                  style={{ background: newListColor || resolveListColor({ name: newList }, projectColor) }}
                />
              </div>
              <ColorPicker embedded value={newListColor} onChange={setNewListColor} />
              <div className="tasks-newlist-actions">
                <button type="submit" className="tasks-newlist-save">Create list</button>
                <button
                  type="button"
                  className="tasks-newlist-cancel"
                  onClick={() => { setNewList(null); setNewListColor(null); }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>

        {tags.length ? (
          <div className="tasks-nav-sec">
            <h3 className="tasks-nav-sec-label">Tags</h3>
            <div className="tasks-tagrow">
              {tags.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={`tasks-tag-btn${tag && tagKey(tag) === entry.key ? ' active' : ''}`}
                  style={{ '--tag-color': projectColor(entry.tag) }}
                  onClick={() => patchUi({ tag: tag && tagKey(tag) === entry.key ? null : entry.tag })}
                >
                  {entry.tag}
                  <span className="tasks-tag-count">{entry.open}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="tasks-nav-foot">
          <button
            type="button"
            className="tasks-reveal"
            title="Your tasks are plain JSON in Harbor's config folder"
            onClick={() => window.harbor.tasks.reveal()}
          >
            Show the tasks file
          </button>
        </div>
      </nav>

      <div className="tasks-main">
        <div className="tasks-head">
          <div className="tasks-head-title-block">
            <h2 className="tasks-title">{heading}</h2>
            <span className="tasks-subtitle">
              {[
                activeView === 'myday' ? longDate(today) : null,
                tag ? `tagged ${tag}` : null,
                query ? `matching “${query}”` : null,
                `${rows.open.length} open`,
                completedInScope ? `${completedInScope} completed` : null,
              ].filter(Boolean).join(' · ')}
            </span>
          </div>
          <div className="tasks-head-actions">
            <label className="tasks-sort">
              <span className="tasks-sort-label">Sort</span>
              <select
                className="tasks-sort-select"
                value={sort}
                aria-label="Sort tasks"
                onChange={(e) => patchUi({ sort: e.target.value })}
              >
                {SORTS.map((key) => (
                  <option key={key} value={key}>{SORT_LABEL[key]}</option>
                ))}
              </select>
            </label>
            {completedInScope ? (
              <button
                type="button"
                className={`tasks-head-btn${armedClear ? ' armed' : ''}`}
                onClick={clearCompleted}
              >
                {armedClear ? 'Delete them for good?' : `Clear completed (${completedInScope})`}
              </button>
            ) : null}
          </div>
        </div>

        {recovery ? (
          <div className="tasks-recovery" role="alert">
            {recovery.kind === 'restored-backup'
              ? `The task file could not be read, so Harbor restored the last good copy. The unreadable one is kept at ${recovery.detail}`
              : recovery.kind === 'corrupt'
                ? `The task file could not be read and there was no backup, so Harbor started a new one. The unreadable file is kept at ${recovery.detail}`
                : `The task file at ${recovery.detail} could not be read.`}
          </div>
        ) : null}

        {canAdd ? (
          <form className="tasks-add" onSubmit={addTask}>
            <span className="tasks-add-glyph" aria-hidden="true">+</span>
            <input
              ref={addRef}
              className="tasks-add-input"
              value={addDraft}
              placeholder={activeView === 'list'
                ? `Add a task to ${listName}`
                : `Add a task to ${heading}`}
              aria-label="Add a task"
              onChange={(e) => setAddDraft(e.target.value)}
            />
            <button type="submit" className="tasks-add-btn" disabled={!addDraft.trim()}>Add</button>
          </form>
        ) : null}

        <div className="tasks-body">
          {openRows.length === 0 && doneRows.length === 0 ? (
            <div className="tasks-empty">
              <p className="tasks-empty-title">{query || tag ? 'Nothing matches' : emptyCopy[0]}</p>
              <p className="tasks-empty-hint">
                {query || tag ? 'Try a different search, or clear the tag filter.' : emptyCopy[1]}
              </p>
            </div>
          ) : null}

          <div className="tasks-rows">
            {openRows.map((row) => (
              <React.Fragment key={row.task.id}>
                <TaskRow
                  {...rowProps(row)}
                  dragId={drag?.id || null}
                  dragOver={drag?.over === row.task.id ? drag.position : null}
                  onMove={reorderable ? move : null}
                />
                {subFor === row.task.id ? (
                  <form
                    className="tasks-subadd"
                    style={{ '--task-depth': row.depth + 1 }}
                    onSubmit={commitSubTask}
                  >
                    <input
                      ref={subRef}
                      className="tasks-subadd-input"
                      value={subDraft}
                      placeholder={`Sub-task of ${row.task.title}`}
                      aria-label={`Add a sub-task to ${row.task.title}`}
                      onChange={(e) => setSubDraft(e.target.value)}
                      onBlur={commitSubTask}
                      onKeyDown={(e) => {
                        if (e.key !== 'Escape') return;
                        subForRef.current = null;
                        subDraftRef.current = '';
                        setSubFor(null);
                        setSubDraft('');
                      }}
                    />
                  </form>
                ) : null}
              </React.Fragment>
            ))}
          </div>

          {doneRows.length ? (
            <div className="tasks-donesec">
              <button
                type="button"
                className={`tasks-done-toggle${ui.hideDone ? '' : ' open'}`}
                aria-expanded={!ui.hideDone}
                onClick={() => patchUi({ hideDone: !ui.hideDone })}
              >
                <span className="tasks-done-caret" aria-hidden="true">▸</span>
                {`Completed (${doneRows.length})`}
              </button>
              {ui.hideDone ? null : (
                <div className="tasks-rows">
                  {doneRows.map((row) => (
                    <TaskRow key={row.task.id} {...rowProps(row)} dragId={null} dragOver={null} onMove={null} />
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {openId && doc.tasks.some((t) => t.id === openId) ? (
        <TaskEditor
          doc={doc}
          taskId={openId}
          today={today}
          onNavigate={setOpenId}
          onClose={() => setOpenId(null)}
          mutate={mutate}
          onAssign={() => setAssignId(openId)}
        />
      ) : null}
      {assignId ? <AssignToClaudeModal doc={doc} taskId={assignId} mutate={mutate} onClose={() => setAssignId(null)} /> : null}

      {notice ? createPortal(
        <div className="tasks-toast" role="alert">
          <span className="tasks-toast-text">{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={dismissNotice}>×</button>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
