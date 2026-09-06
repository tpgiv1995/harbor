import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dateRoll from '../../shared/date-roll.cjs';
import notesModel from '../../shared/notes-model.cjs';
import { armedConfirmClick, DISARM_MS } from '../armed-confirm.cjs';
import { ComposeEditor } from '../stage/ComposeEditor.jsx';
import { copyText } from '../stage/md.jsx';
import { projectColor } from '../stage/project-colors.js';
import { ColorPicker } from '../tasks/ColorPicker.jsx';
import { resolveListColor } from '../tasks/list-color.cjs';
import notesViewModel from './notes-view-model.cjs';
import { useNotes } from './use-notes.js';

const { formatRelative } = dateRoll;
const { tagKey } = notesModel;
const { copyPayload, displayTitle, groupRows, listRows, topicRows } = notesViewModel;
const TYPING_SETTLE_MS = 400;
const UI_STORE_KEY = 'harbor-notes-ui';

function readUiState() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STORE_KEY) || 'null');
    return saved && typeof saved === 'object' ? saved : {};
  } catch { return {}; }
}

// The topics editor: the same comma/Enter chip input tasks uses for tags, so a
// list of labels already in your head types in one go. Reuses the notes model's
// tagKey so "Work" and "work" are one topic.
function TopicsField({ tags, onChange }) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const value = draft.trim();
    if (!value) return;
    const added = value.split(',').map((t) => t.trim()).filter(Boolean);
    const merged = [...tags];
    for (const tag of added) {
      if (!merged.some((t) => tagKey(t) === tagKey(tag))) merged.push(tag);
    }
    setDraft('');
    onChange(merged);
  };
  return (
    <div className="notes-topics-field">
      {tags.map((tag) => (
        <span className="notes-topic-chip" key={tagKey(tag)} style={{ '--tag-color': projectColor(tag) }}>
          {tag}
          <button
            type="button"
            aria-label={`Remove topic ${tag}`}
            onClick={() => onChange(tags.filter((t) => tagKey(t) !== tagKey(tag)))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="notes-topic-input"
        value={draft}
        placeholder={tags.length ? 'Add a topic' : 'work, personal'}
        aria-label="Add a topic"
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

export function NotesView() {
  const notes = useNotes();
  const { doc, error, notice, dismissNotice, mutate } = notes;
  const [ui, setUi] = useState(readUiState);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [armedDelete, setArmedDelete] = useState(null);
  const [copyState, setCopyState] = useState(null);
  // Group management state, each a distinct flow so they never share a target.
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [renamingGroupId, setRenamingGroupId] = useState(null);
  const [colorForGroup, setColorForGroup] = useState(null);
  const [armedGroupDelete, setArmedGroupDelete] = useState(null);
  const settleRef = useRef(null);
  const pendingRef = useRef(null);
  const editorRef = useRef(null);
  // A single-input form fires BOTH Enter-submit and the unmount blur; without
  // this lock the second call reads the same draft and creates the group twice.
  const createLockRef = useRef(false);

  const groups = doc?.groups || [];
  const navGroups = useMemo(() => (doc ? groupRows(doc) : []), [doc]);
  const topics = useMemo(() => (doc ? topicRows(doc) : []), [doc]);
  // A stored topic filter that no longer exists falls back to "all" rather than
  // filtering the whole tree down to nothing.
  const activeTag = ui.tag && topics.some((t) => t.key === tagKey(ui.tag)) ? ui.tag : null;
  const collapsed = useMemo(
    () => new Set(Array.isArray(ui.collapsed) ? ui.collapsed : []),
    [ui.collapsed],
  );
  // A search or topic filter overrides every collapse: a note that matches must
  // never hide inside a folded group.
  const filtering = Boolean(query.trim() || activeTag);

  // The tree: every group with the notes it holds under the current filter.
  // When a filter is on, groups with no match drop out entirely rather than
  // parade a wall of empty headers.
  const tree = useMemo(() => {
    if (!doc) return [];
    return navGroups
      .map((group) => ({
        group,
        notes: listRows(doc, { query, groupId: group.id, tag: activeTag }),
      }))
      .filter((entry) => !filtering || entry.notes.length);
  }, [doc, navGroups, query, activeTag, filtering]);

  const note = useMemo(
    () => doc?.notes?.find((item) => item.id === openId) || null,
    [doc, openId],
  );

  const patchUi = useCallback((next) => setUi((prev) => ({ ...prev, ...next })), []);

  useEffect(() => {
    try { localStorage.setItem(UI_STORE_KEY, JSON.stringify(ui)); }
    catch { /* view state just will not restore */ }
  }, [ui]);

  useEffect(() => {
    if (!doc) return;
    if (openId && doc.notes.some((item) => item.id === openId)) return;
    setOpenId(listRows(doc)[0]?.id || null);
  }, [doc, openId]);

  useEffect(() => {
    setTitle(note?.title || '');
    setBody(note?.body || '');
    setArmedDelete(null);
    setCopyState(null);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  // An OUTSIDE edit (harbor-notes CLI, another window) lands in the doc while
  // this note sits open. With nothing pending here, the editor resyncs to it;
  // with keystrokes pending, local typing wins (a settle-flush would otherwise
  // bake the stale body into its patch and silently erase the outside edit,
  // caught in review 2026-08-25). The title compares TRIMMED because the model
  // trims titles: the store's echo of "Meeting " comes back "Meeting", and
  // resyncing to that mid-typing glued the next word onto the last (round-2
  // review catch); a local value that differs only by edge whitespace is the
  // user's own text, not an outside edit.
  useEffect(() => {
    if (!note || pendingRef.current?.noteId === note.id) return;
    setTitle((current) => (current.trim() === (note.title || '') ? current : (note.title || '')));
    setBody((current) => (current === (note.body || '') ? current : (note.body || '')));
  }, [note]);

  const flush = useCallback(() => {
    clearTimeout(settleRef.current);
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending?.noteId && Object.keys(pending.patch).length) {
      mutate({ type: 'note.update', noteId: pending.noteId, patch: pending.patch }).then((result) => {
        // A refused flush (oversized body, transiently unreadable file) must
        // not let the resync effect wipe the editor back to the disk copy:
        // restoring the pending patch keeps the user's text in front of them
        // next to the notice, unless newer typing already took the slot.
        if (!result?.ok && !pendingRef.current) pendingRef.current = pending;
      });
    }
  }, [mutate]);

  const settle = useCallback((patch) => {
    pendingRef.current = {
      noteId: openId,
      patch: { ...(pendingRef.current?.noteId === openId ? pendingRef.current.patch : {}), ...patch },
    };
    clearTimeout(settleRef.current);
    settleRef.current = setTimeout(flush, TYPING_SETTLE_MS);
  }, [flush, openId]);

  useEffect(() => flush, [flush]);

  // Closing or reloading the window unmounts nothing, so without this the
  // last <=400ms of typing dies with the app (the whiteboard flushes the same
  // way; caught in review 2026-08-25).
  useEffect(() => {
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [flush]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(dismissNotice, 6000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  useEffect(() => {
    if (!armedDelete) return undefined;
    const timer = setTimeout(() => setArmedDelete(null), DISARM_MS);
    return () => clearTimeout(timer);
  }, [armedDelete]);

  useEffect(() => {
    if (!armedGroupDelete) return undefined;
    const timer = setTimeout(() => setArmedGroupDelete(null), DISARM_MS);
    return () => clearTimeout(timer);
  }, [armedGroupDelete]);

  useEffect(() => {
    if (!copyState) return undefined;
    const timer = setTimeout(() => setCopyState(null), 1800);
    return () => clearTimeout(timer);
  }, [copyState]);

  const open = (id) => {
    flush();
    setOpenId(id);
  };

  const expandGroup = useCallback((groupId) => setUi((prev) => ({
    ...prev,
    collapsed: (Array.isArray(prev.collapsed) ? prev.collapsed : []).filter((id) => id !== groupId),
  })), []);

  const toggleCollapse = useCallback((groupId) => setUi((prev) => {
    const set = new Set(Array.isArray(prev.collapsed) ? prev.collapsed : []);
    if (set.has(groupId)) set.delete(groupId); else set.add(groupId);
    return { ...prev, collapsed: [...set] };
  }), []);

  // A new note lands in a specific group (the one whose + was clicked, or the
  // first group for the toolbar's New note), inherits an active topic filter so
  // it does not vanish the instant it exists, expands its group, and opens for
  // editing with the cursor in the body.
  const add = async (groupId) => {
    flush();
    const target = groups.some((g) => g.id === groupId) ? groupId : groups[0]?.id;
    const result = await mutate({
      type: 'note.add', title: '', body: '', groupId: target, tags: activeTag ? [activeTag] : [],
    });
    if (result?.ok && result.noteId) {
      if (target) expandGroup(target);
      setOpenId(result.noteId);
      requestAnimationFrame(() => editorRef.current?.focus());
    }
  };

  const togglePin = (item) => {
    flush();
    mutate({ type: 'note.pin', noteId: item.id, pinned: !item.pinned });
  };

  const removeNote = (noteId) => {
    const previous = armedDelete?.noteId === noteId ? armedDelete : null;
    const { armed, fire } = armedConfirmClick(previous, Date.now(), { noteId });
    setArmedDelete(armed);
    if (!fire) return;
    if (noteId === openId) flush();
    mutate({ type: 'note.remove', noteId });
  };

  const copyFormatted = async () => {
    flush();
    const result = await window.harbor.clipboard.writeFormatted(copyPayload({ ...note, body }))
      .catch(() => ({ ok: false }));
    if (result?.ok) setCopyState('formatted');
  };

  const copyMarkdown = async () => {
    if (await copyText(body)) setCopyState('markdown');
  };

  const openNewGroup = () => {
    createLockRef.current = false;
    setCreatingGroup(true);
    setNewGroupName('');
  };

  // Cancelling must arm the SAME lock the commit path uses: unmounting the input
  // fires its onBlur, which calls createGroup on a closure that still holds the
  // typed name, so a bare setCreatingGroup(false) would let Escape create the
  // group it was meant to discard.
  const cancelNewGroup = () => {
    createLockRef.current = true;
    setCreatingGroup(false);
    setNewGroupName('');
  };

  const createGroup = () => {
    if (createLockRef.current) return;
    createLockRef.current = true;
    const name = newGroupName.trim();
    setCreatingGroup(false);
    setNewGroupName('');
    if (!name) return;
    mutate({ type: 'group.add', name }).then((result) => {
      if (result?.ok && result.groupId) expandGroup(result.groupId);
    });
  };

  const deleteGroup = (groupId) => {
    // Arming is PER GROUP: clicking one group's × then another's must re-arm,
    // never inherit the first one's consent.
    const previous = armedGroupDelete?.groupId === groupId ? armedGroupDelete : null;
    const { armed, fire } = armedConfirmClick(previous, Date.now(), { groupId });
    setArmedGroupDelete(armed);
    if (!fire) return;
    mutate({ type: 'group.remove', groupId });
  };

  const setNoteGroup = (groupId) => {
    flush();
    mutate({ type: 'note.update', noteId: openId, patch: { groupId } });
  };

  const setNoteTopics = (tags) => {
    flush();
    mutate({ type: 'note.update', noteId: openId, patch: { tags } });
  };

  if (error) {
    return <div className="notes-view" aria-label="Notes"><div className="notes-status error" role="alert">{`Notes could not load: ${error}`}</div></div>;
  }
  if (!doc) {
    return <div className="notes-view" aria-label="Notes"><div className="notes-status">Loading notes...</div></div>;
  }

  const treeEmpty = tree.length === 0;

  return (
    <div className="notes-view" aria-label="Notes">
      <aside className="notes-tree-pane">
        <div className="notes-tree-tools">
          <input
            className="notes-search-input"
            type="search"
            value={query}
            placeholder="Search notes"
            aria-label="Search notes"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="notes-new-btn" onClick={() => add(groups[0]?.id)}>New note</button>
        </div>

        {topics.length ? (
          <div className="notes-topicrow" role="group" aria-label="Filter by topic">
            {topics.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`notes-topic-btn${activeTag && tagKey(activeTag) === entry.key ? ' active' : ''}`}
                style={{ '--tag-color': projectColor(entry.tag) }}
                onClick={() => patchUi({ tag: activeTag && tagKey(activeTag) === entry.key ? null : entry.tag })}
              >
                {entry.tag}
                <span className="notes-topic-count">{entry.count}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="notes-tree" role="tree" aria-label="Groups and notes">
          {tree.map(({ group, notes: groupNotes }) => {
            const isCollapsed = !filtering && collapsed.has(group.id);
            const dot = resolveListColor(group, projectColor);
            return (
              <div className="notes-group" key={group.id} style={{ '--group-color': dot }}>
                <div className="notes-group-row" role="treeitem" aria-expanded={!isCollapsed}>
                  {renamingGroupId === group.id ? (
                    <form
                      className="notes-rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name = new FormData(e.currentTarget).get('name');
                        setRenamingGroupId(null);
                        mutate({ type: 'group.rename', groupId: group.id, name });
                      }}
                    >
                      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                      <input
                        name="name"
                        autoFocus
                        className="notes-rename-input"
                        defaultValue={group.name}
                        aria-label="Group name"
                        onBlur={(e) => e.currentTarget.form?.requestSubmit()}
                        onKeyDown={(e) => { if (e.key === 'Escape') setRenamingGroupId(null); }}
                      />
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="notes-group-head"
                        aria-expanded={!isCollapsed}
                        onClick={() => (filtering ? null : toggleCollapse(group.id))}
                        onDoubleClick={() => setRenamingGroupId(group.id)}
                      >
                        <span className={`notes-group-caret${isCollapsed ? '' : ' open'}`} aria-hidden="true">▸</span>
                        <span className="notes-group-dot" aria-hidden="true" style={{ background: dot }} />
                        <span className="notes-group-name">{group.name}</span>
                        <span className="notes-group-count">{group.count}</span>
                      </button>
                      <span className="notes-group-actions">
                        <button
                          type="button"
                          className="notes-group-act"
                          title={`Add a note to ${group.name}`}
                          aria-label={`Add a note to ${group.name}`}
                          onClick={() => add(group.id)}
                        >
                          +
                        </button>
                        <button
                          type="button"
                          className="notes-group-act"
                          title="Group colour"
                          aria-label={`Colour for ${group.name}`}
                          aria-expanded={colorForGroup === group.id}
                          onClick={() => setColorForGroup(colorForGroup === group.id ? null : group.id)}
                        >
                          <span className="notes-group-color-chip" aria-hidden="true" style={{ background: dot }} />
                        </button>
                        {colorForGroup === group.id ? (
                          <div className="notes-color-pop">
                            <ColorPicker
                              value={group.color || null}
                              onChange={(hex) => mutate({ type: 'group.color', groupId: group.id, color: hex })}
                              onClose={() => setColorForGroup(null)}
                            />
                            {group.color ? (
                              <button
                                type="button"
                                className="notes-color-reset"
                                onClick={() => {
                                  mutate({ type: 'group.color', groupId: group.id, color: null });
                                  setColorForGroup(null);
                                }}
                              >
                                Reset to automatic
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          className="notes-group-act"
                          title="Rename group"
                          aria-label={`Rename ${group.name}`}
                          onClick={() => setRenamingGroupId(group.id)}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className={`notes-group-act danger${armedGroupDelete?.groupId === group.id ? ' armed' : ''}`}
                          title={armedGroupDelete?.groupId === group.id
                            ? `Click again to delete ${group.name}; its notes move to another group`
                            : 'Delete group (its notes are kept)'}
                          aria-label={`Delete ${group.name}`}
                          onClick={() => deleteGroup(group.id)}
                        >
                          {armedGroupDelete?.groupId === group.id ? '!' : '×'}
                        </button>
                      </span>
                    </>
                  )}
                </div>

                {isCollapsed ? null : (
                  <div className="notes-group-notes" role="group">
                    {groupNotes.map((item) => (
                      <div className={`notes-item${item.id === openId ? ' active' : ''}`} key={item.id} role="treeitem">
                        <button type="button" className="notes-item-main" onClick={() => open(item.id)}>
                          <span className="notes-item-title">{displayTitle(item)}</span>
                          <span className="notes-item-time">{formatRelative(new Date(item.updatedAt))}</span>
                        </button>
                        <button
                          type="button"
                          className={`notes-item-act notes-item-pin${item.pinned ? ' on' : ''}`}
                          title={item.pinned ? 'Unpin' : 'Pin to top'}
                          aria-label={item.pinned ? `Unpin ${displayTitle(item)}` : `Pin ${displayTitle(item)}`}
                          aria-pressed={item.pinned}
                          onClick={() => togglePin(item)}
                        >
                          ★
                        </button>
                        <button
                          type="button"
                          className={`notes-item-act notes-item-del${armedDelete?.noteId === item.id ? ' armed' : ''}`}
                          title={armedDelete?.noteId === item.id ? 'Click again to delete' : 'Delete note'}
                          aria-label={armedDelete?.noteId === item.id ? `Confirm delete ${displayTitle(item)}` : `Delete ${displayTitle(item)}`}
                          onClick={() => removeNote(item.id)}
                        >
                          {armedDelete?.noteId === item.id ? '!' : '×'}
                        </button>
                      </div>
                    ))}
                    {!groupNotes.length ? (
                      <button type="button" className="notes-item-empty" onClick={() => add(group.id)}>
                        No notes yet. Add one.
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}

          {treeEmpty ? (
            <div className="notes-tree-empty">{query ? 'No notes match' : 'No notes yet'}</div>
          ) : null}

          {creatingGroup ? (
            <form
              className="notes-newgroup"
              onSubmit={(e) => { e.preventDefault(); createGroup(); }}
            >
              {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
              <input
                autoFocus
                className="notes-newgroup-input"
                value={newGroupName}
                placeholder="Group name"
                aria-label="New group name"
                onChange={(e) => setNewGroupName(e.target.value)}
                onBlur={createGroup}
                onKeyDown={(e) => { if (e.key === 'Escape') cancelNewGroup(); }}
              />
            </form>
          ) : (
            <button type="button" className="notes-newgroup-btn" onClick={openNewGroup}>
              <span aria-hidden="true">+</span>
              New group
            </button>
          )}
        </div>
      </aside>

      <section className="notes-editor-pane">
        {notice ? <div className="notes-notice" role="alert">{notice}</div> : null}
        {note ? (
          <>
            <header className="notes-editor-head">
              <input
                className="notes-title-input"
                value={title}
                placeholder="Untitled note"
                aria-label="Note title"
                onChange={(event) => { setTitle(event.target.value); settle({ title: event.target.value }); }}
                onBlur={flush}
              />
              <button
                type="button"
                className={`notes-delete-btn${armedDelete ? ' armed' : ''}`}
                onClick={() => removeNote(openId)}
              >
                {armedDelete?.noteId === openId ? 'Delete for good?' : 'Delete'}
              </button>
            </header>
            <div className="notes-editor-meta">
              <label className="notes-editor-metafield">
                <span className="notes-editor-meta-label">Group</span>
                <select
                  className="notes-editor-group-select"
                  value={note.groupId}
                  aria-label="Note group"
                  onChange={(event) => setNoteGroup(event.target.value)}
                >
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </label>
              <div className="notes-editor-metafield notes-editor-metafield-topics">
                <span className="notes-editor-meta-label">Topics</span>
                <TopicsField key={note.id} tags={note.tags} onChange={setNoteTopics} />
              </div>
            </div>
            <div className="notes-compose-wrap">
              <ComposeEditor
                ref={editorRef}
                value={body}
                onChange={(value) => { setBody(value); settle({ body: value }); }}
                submitOnEnter={false}
                formatOpen
                knownCommandNames={[]}
                placeholder="Draft something worth pasting elsewhere"
                className="notes-compose-editor"
              />
            </div>
            <footer className="notes-actions">
              <button type="button" className="notes-copy-primary" onClick={copyFormatted}>
                {copyState === 'formatted' ? 'Copied for pasting' : 'Copy formatted'}
              </button>
              <button type="button" className="notes-copy-secondary" onClick={copyMarkdown}>
                {copyState === 'markdown' ? 'Copied markdown' : 'Copy as markdown'}
              </button>
            </footer>
          </>
        ) : (
          <div className="notes-empty-editor">
            <h2>Your formatted scratchpad</h2>
            <p>Create a note, then copy it into Teams, Outlook, or anywhere rich text is accepted.</p>
            <button type="button" className="notes-copy-primary" onClick={() => add(groups[0]?.id)}>New note</button>
          </div>
        )}
      </section>
    </div>
  );
}
