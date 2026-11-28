import React, {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import notesModel from '../../../src/shared/notes-model.cjs';
import './notes.css';
import { usePendingPatches } from '../../../src/renderer/use-pending-patches.js';

const { MAX_BODY, selectNotes } = notesModel;
const MAX_TAGS = 12;
const MAX_TAG = 40;

function tagsFromDraft(value) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, MAX_TAGS)
    .map((tag) => tag.slice(0, MAX_TAG));
}

function previewText(body) {
  return body.replace(/\s+/g, ' ').trim();
}

function sameTags(a, b) {
  const key = (list) => (list || []).map((tag) => String(tag).trim().toLowerCase()).join('\n');
  return key(a) === key(b);
}

// Apple-Notes-style editor: the note IS the screen. Title is the first line, the
// body flows beneath with no field chrome, actions live behind a menu, and it
// auto-saves on close. A note left completely empty is discarded (no litter).
//
// It never writes back text it only showed (2026-11-27, Pat: "I keep having mobile
// harbor overwrite harbor notes"; docs/BACKLOG.md "Notes sync"). It used to load the
// note once and, on close, send the whole title, body and tags it held, so an edit
// made elsewhere while it was open (an agent updating a board note)
// was erased by a body nobody here had typed in, and it showed a draft this phone had
// kept in storage since Nov 23 AS the note, then saved it over the newer text. Now:
//   * baseRef holds what the screen showed before the user typed; every edit carries
//     it, and the store merges against it (shared/edit-merge.cjs), or keeps the
//     user's version as its own "(conflicting copy)" note when both cannot be kept.
//   * A field the user has not typed in follows the note live, base included.
//   * Closing sends only the fields that differ from what was shown.
//   * A draft restored from this phone's storage shows again only while it is current
//     (the note has not changed since it was typed), so unsaved typing is never hidden.
//     A stale one is never shown as the note: it is sent once, with its base, as the
//     editor opens, and the screen shows the result (merged, or kept as its own note).
function NoteEditor({ note, opener, onClosed, mutate }) {
  const edits = usePendingPatches('note', note.id, mutate);
  const startRef = useRef(null);
  if (!startRef.current) {
    const restored = edits.pending(note.id);
    const stale = Boolean(restored) && edits.stale(note.id, note);
    startRef.current = { stale, shown: restored && !stale ? { ...note, ...restored } : note };
  }
  const restoredRef = useRef(startRef.current.stale);
  const baseRef = useRef({ title: note.title, body: note.body, tags: note.tags });
  const [title, setTitle] = useState(startRef.current.shown.title);
  const [tags, setTags] = useState((startRef.current.shown.tags || []).join(', '));
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const titleRef = useRef(null);
  const bodyRef = useRef(null);
  const closingRef = useRef(false);
  const finishRef = useRef(null);

  useEffect(() => {
    if (!restoredRef.current) return;
    restoredRef.current = false;
    edits.flush().then((result) => {
      if (!result?.ok) setSaveError(result?.reason || 'An edit kept on this phone did not save. Retry before closing.');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An edit made elsewhere lands in the doc while this note is open: every field the
  // user has not typed in shows it, and it becomes that field's base.
  const tagsKey = note.tags.join('\n');
  useEffect(() => {
    const typed = edits.pending(note.id) || {};
    const base = { ...baseRef.current };
    if (!('title' in typed) && note.title !== base.title) { base.title = note.title; setTitle(note.title); }
    if (!('body' in typed) && note.body !== base.body) {
      base.body = note.body;
      if (bodyRef.current) bodyRef.current.value = note.body;
    }
    if (!('tags' in typed) && !sameTags(note.tags, base.tags)) { base.tags = note.tags; setTags(note.tags.join(', ')); }
    baseRef.current = base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.title, note.body, tagsKey]);

  const finish = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const body = bodyRef.current?.value ?? baseRef.current.body;
    const parsedTags = tagsFromDraft(tags);
    const base = baseRef.current;
    const empty = !title.trim() && !body.trim() && !parsedTags.length;
    // An emptied note is deleted only while nobody else has changed it since it was
    // shown; otherwise the empty fields go through the merge like any other edit.
    const unchangedElsewhere = note.title === base.title && note.body === base.body && sameTags(note.tags, base.tags);
    const fields = {};
    if (title !== base.title) fields.title = title;
    if (body !== base.body) fields.body = body;
    if (!sameTags(parsedTags, base.tags)) fields.tags = parsedTags;
    const removing = empty && unchangedElsewhere;
    if (!removing && Object.keys(fields).length) edits.queue(fields, base);
    let result = { ok: true };
    if (removing) result = await mutate({ type: 'note.remove', noteId: note.id });
    else if (edits.pending(note.id)) result = await edits.flush();
    if (!result?.ok) {
      closingRef.current = false;
      setSaveError(result?.reason || 'That change did not save. Retry before closing.');
      return;
    }
    edits.discard(note.id);
    onClosed();
    opener?.focus();
  };
  finishRef.current = finish;

  useEffect(() => {
    const background = document.querySelectorAll('.app-header, .app-main, .bottom-nav');
    background.forEach((node) => { node.inert = true; });
    // A saved note opens for READING: focusing its body raised the keyboard
    // over half the note every time one was opened just to be read or copied
    // (2026-10-21 review). A tap in the text starts editing. A blank new note
    // still opens on the title, cursor waiting.
    if (!note.title && !note.body) titleRef.current?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (menuOpen) setMenuOpen(false);
      else if (confirmDelete) setConfirmDelete(false);
      else finishRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      background.forEach((node) => { node.inert = false; });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, confirmDelete]);

  const togglePin = async () => {
    setMenuOpen(false);
    const result = await mutate({ type: 'note.pin', noteId: note.id, pinned: !note.pinned });
    setSaveError(result?.ok ? null : (result?.reason || 'That change did not save. Retry.'));
  };

  const remove = async () => {
    const result = await mutate({ type: 'note.remove', noteId: note.id });
    if (!result?.ok) {
      setConfirmDelete(false);
      setSaveError(result?.reason || 'The note was not deleted. Retry.');
      return;
    }
    edits.discard(note.id);
    onClosed();
    opener?.focus();
  };

  return createPortal(
    <div className="ne-screen motion-sheet" role="dialog" aria-modal="true" aria-label="Edit note">
      <header className="ne-bar">
        <button type="button" className="ne-back" onClick={finish}>
          <svg viewBox="0 0 12 20" width="11" height="18" aria-hidden="true"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Notes
        </button>
        <div className="ne-bar-right">
          {note.pinned ? <span className="ne-pinned">Pinned</span> : null}
          <button type="button" className="ne-more" onClick={() => setMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Note actions">
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="4" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="16" cy="10" r="1.6" /></svg>
          </button>
          {menuOpen ? (
            <div className="ne-menu" role="menu">
              <button type="button" role="menuitem" onClick={togglePin}>{note.pinned ? 'Unpin note' : 'Pin note'}</button>
              <button type="button" role="menuitem" className="danger" onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}>Delete note</button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="ne-page">
        {saveError || edits.error ? <p className="notes-status" role="alert">{edits.error || saveError}</p> : null}
        <input autoComplete="off" ref={titleRef} className="ne-title" value={title} onChange={(event) => { setTitle(event.target.value); edits.queue({ title: event.target.value }, baseRef.current); }} maxLength={300} placeholder="Title" aria-label="Title" />
        <textarea autoComplete="off" ref={bodyRef} key={note.id} className="ne-body" defaultValue={startRef.current.shown.body} onChange={(event) => edits.queue({ body: event.target.value }, baseRef.current)} maxLength={MAX_BODY} placeholder="Start writing..." aria-label="Note" />
      </div>

      <footer className="ne-tags">
        <span className="ne-tags-hash" aria-hidden="true">#</span>
        <input autoComplete="off" value={tags} onChange={(event) => { setTags(event.target.value); edits.queue({ tags: tagsFromDraft(event.target.value) }, baseRef.current); }} placeholder="Add tags, comma separated" aria-label="Tags" />
      </footer>

      {menuOpen ? <button type="button" className="ne-scrim" tabIndex={-1} aria-hidden="true" onClick={() => setMenuOpen(false)} /> : null}

      {confirmDelete ? (
        <div className="ne-confirm-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setConfirmDelete(false)}>
          <section className="ne-confirm" role="alertdialog" aria-modal="true" aria-label="Delete note">
            <h3>Delete note?</h3>
            <p>“{note.title || 'Untitled'}” will be permanently removed.</p>
            <div><button type="button" onClick={() => setConfirmDelete(false)}>Keep</button><button type="button" className="danger" onClick={remove}>Delete</button></div>
          </section>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function NoteRow({ note, onOpen }) {
  const preview = previewText(note.body);
  return (
    <button type="button" className="note-row" onClick={(event) => onOpen(note.id, event.currentTarget)}>
      <span className="note-row-title">{note.title || 'New Note'}</span>
      <span className="note-row-preview">{preview || 'No additional text'}</span>
    </button>
  );
}

export function NotesView({ doc, error, notice, dismissNotice, mutate }) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const openerRef = useRef(null);
  const notes = useMemo(() => (doc ? selectNotes(doc, { query }) : []), [doc, query]);
  const editingNote = doc?.notes.find((note) => note.id === editingId) || null;

  const openEditor = (id, opener) => { openerRef.current = opener; setEditingId(id); };

  const createNote = async (opener) => {
    openerRef.current = opener;
    const result = await mutate({ type: 'note.add', title: '', body: '', tags: [] });
    if (result?.ok && result.noteId) setEditingId(result.noteId);
  };

  if (error) return <div className="notes-mobile notes-status" role="alert">Notes could not load: {error}</div>;
  if (!doc) return <div className="notes-mobile notes-status">Loading notes...</div>;

  const pinned = notes.filter((note) => note.pinned);
  const rest = notes.filter((note) => !note.pinned);

  return (
    <div className="notes-mobile" aria-label="Notes">
      <div className="notes-top">
        <h1 className="notes-h1">Notes</h1>
        <label className="notes-search"><span aria-hidden="true">⌕</span><input autoComplete="off" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search notes" /></label>
      </div>

      {!notes.length ? (
        <div className="notes-empty motion-fade-up">
          <span className="notes-empty-mark" aria-hidden="true">✦</span>
          <h3>{query ? 'No matching notes' : 'No notes yet'}</h3>
          <p>{query ? 'Try a different search.' : 'Tap the compose button to start your first note.'}</p>
        </div>
      ) : (
        <div className="notes-scroll">
          {pinned.length ? (
            <>
              <div className="notes-section">Pinned</div>
              <div className="notes-group">{pinned.map((note) => <NoteRow key={note.id} note={note} onOpen={openEditor} />)}</div>
            </>
          ) : null}
          {rest.length ? (
            <>
              {pinned.length ? <div className="notes-section">Notes</div> : null}
              <div className="notes-group">{rest.map((note) => <NoteRow key={note.id} note={note} onOpen={openEditor} />)}</div>
            </>
          ) : null}
        </div>
      )}

      <button type="button" className="notes-compose" onClick={(event) => createNote(event.currentTarget)} aria-label="New note">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 20h16M14.5 4.5l3 3L8 17l-4 1 1-4Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>

      {editingNote ? <NoteEditor note={editingNote} opener={openerRef.current} mutate={mutate} onClosed={() => setEditingId(null)} /> : null}
      {notice ? <div className="app-toast" role="alert"><span>{notice}</span><button type="button" onClick={dismissNotice} aria-label="Dismiss">×</button></div> : null}
    </div>
  );
}

export default NotesView;
