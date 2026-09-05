import React, {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import notesModel from '../../../src/shared/notes-model.cjs';
import './notes.css';

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

// Apple-Notes-style editor: the note IS the screen. Title is the first line, the
// body flows beneath with no field chrome, actions live behind a menu, and it
// auto-saves on close. A note left completely empty is discarded (no litter).
function NoteEditor({ note, opener, onClosed, mutate }) {
  const [title, setTitle] = useState(note.title);
  const [tags, setTags] = useState(note.tags.join(', '));
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const titleRef = useRef(null);
  const bodyRef = useRef(null);
  const closingRef = useRef(false);

  const finish = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const body = bodyRef.current?.value ?? note.body;
    const parsedTags = tagsFromDraft(tags);
    const empty = !title.trim() && !body.trim() && !parsedTags.length;
    if (empty) {
      await mutate({ type: 'note.remove', noteId: note.id });
    } else {
      await mutate({ type: 'note.update', noteId: note.id, patch: { title, body, tags: parsedTags } });
    }
    onClosed();
    opener?.focus();
  };

  useEffect(() => {
    const background = document.querySelectorAll('.app-header, .app-main, .bottom-nav');
    background.forEach((node) => { node.inert = true; });
    // A note with content opens ready to read/continue in the body; a blank new
    // note opens on the title, cursor waiting.
    (note.title || note.body ? bodyRef.current : titleRef.current)?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (menuOpen) setMenuOpen(false);
      else if (confirmDelete) setConfirmDelete(false);
      else finish();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      background.forEach((node) => { node.inert = false; });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, confirmDelete]);

  const togglePin = () => {
    setMenuOpen(false);
    mutate({ type: 'note.pin', noteId: note.id, pinned: !note.pinned });
  };

  const remove = async () => {
    await mutate({ type: 'note.remove', noteId: note.id });
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
        <input ref={titleRef} className="ne-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} placeholder="Title" aria-label="Title" />
        <textarea ref={bodyRef} key={note.id} className="ne-body" defaultValue={note.body} maxLength={MAX_BODY} placeholder="Start writing..." aria-label="Note" />
      </div>

      <footer className="ne-tags">
        <span className="ne-tags-hash" aria-hidden="true">#</span>
        <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Add tags, comma separated" aria-label="Tags" />
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
        <label className="notes-search"><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" aria-label="Search notes" /></label>
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
