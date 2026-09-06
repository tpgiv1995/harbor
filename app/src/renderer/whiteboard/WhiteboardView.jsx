import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import boardFiles from './board-files.cjs';

const WhiteboardCanvas = lazy(() => import('./WhiteboardCanvas.jsx'));

const { SAVE_DELAY_MS, orderBoards, filterBoards, duplicateName, boardHue } = boardFiles;

// This view can render inside a popped-out board window (main loads
// index.html?window=board); there, the "Pop out" affordance is hidden.
const IN_BOARD_WINDOW = new URLSearchParams(window.location.search).get('window') === 'board';

function relativeTime(iso) {
  const elapsed = Math.max(0, Date.now() - Date.parse(iso || 0));
  if (elapsed < 60000) return 'now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h`;
  return `${Math.floor(elapsed / 86400000)}d`;
}

export function WhiteboardView() {
  const [boards, setBoards] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [armedDelete, setArmedDelete] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  // A board changed on disk underneath us (a CLI write, b6 H1): the fresh
  // on-disk scene rides to the canvas as { boardId, revision, elements, files }
  // and the canvas MERGES it into the live scene. Revision makes each event
  // apply exactly once; boardId keeps a stale event off the wrong board.
  const [externalScene, setExternalScene] = useState(null);
  const externalRevisionRef = useRef(0);
  const activeIdRef = useRef(null);
  const pendingRef = useRef(null);
  const saveTimerRef = useRef(null);

  // Full screen is two things at once: the in-app chrome (rail, titlebar, banners,
  // margins) collapses via a body attribute so the board fills the window, AND the
  // real OS window goes edge-to-edge through the DOM Fullscreen API (a user gesture,
  // so no main-process IPC and no focus-steal concern). The two are kept in sync by
  // `fullscreenchange` so the native Esc/F11 exit also restores the chrome.
  const applyFullscreen = useCallback((on) => {
    setFullscreen(on);
    document.body.toggleAttribute('data-board-fullscreen', on);
    try {
      if (on) { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {}); }
      else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    } catch { /* fullscreen unsupported: the in-app fill still applies */ }
  }, []);

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && document.body.hasAttribute('data-board-fullscreen')) {
        setFullscreen(false);
        document.body.removeAttribute('data-board-fullscreen');
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Leaving the board view (unmount) must never strand the app in fullscreen.
  useEffect(() => () => {
    document.body.removeAttribute('data-board-fullscreen');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }, []);

  const refreshList = useCallback(async (preferredId = null) => {
    const result = await window.harbor.whiteboard.list();
    if (!result.ok) throw new Error(result.reason || 'Could not list boards');
    setBoards(orderBoards(result.boards || []));
    if (result.recovery?.length) setNotice(`${result.recovery.length} corrupt board file was set aside`);
    return preferredId || result.boards?.[0]?.id || null;
  }, []);

  const openBoard = useCallback(async (id) => {
    if (!id) { setBoard(null); setActiveId(null); activeIdRef.current = null; return; }
    setLoading(true);
    const result = await window.harbor.whiteboard.read({ id });
    if (!result.ok) {
      setNotice(result.reason || 'Could not open board');
      setLoading(false);
      return;
    }
    setActiveId(id);
    activeIdRef.current = id;
    setExternalScene(null); // a fresh open IS the disk state; no stale merge may follow it
    setBoard(result.board);
    setLoading(false);
  }, []);

  const flushSave = useCallback(async () => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const pending = pendingRef.current;
    if (!pending) return { ok: true };
    pendingRef.current = null;
    const result = await window.harbor.whiteboard.write(pending).catch((error) => ({
      ok: false, reason: error?.message || String(error),
    }));
    if (!result.ok) {
      pendingRef.current = pending;
      setNotice(result.reason || 'Board save failed');
      return result;
    }
    setBoards((current) => orderBoards(current.map((item) => (
      item.id === pending.id ? { ...item, updatedAt: result.board.updatedAt } : item
    ))));
    return result;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let id = await refreshList();
        if (!id) {
          const created = await window.harbor.whiteboard.create({ name: 'Untitled board' });
          if (!created.ok) throw new Error(created.reason || 'Could not create a board');
          id = created.board.id;
          await refreshList(id);
        }
        if (!cancelled) await openBoard(id);
      } catch (error) {
        if (!cancelled) { setNotice(error?.message || String(error)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; flushSave(); };
  }, [flushSave, openBoard, refreshList]);

  useEffect(() => {
    const beforeUnload = () => { flushSave(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [flushSave]);

  // An outside write (bin/harbor-board) pushed over whiteboard:changed: refresh
  // the picker metadata, and when it hit the OPEN board, hand the fresh on-disk
  // scene to the canvas to merge. Reading through whiteboard:read (rather than
  // shipping scenes in the push) keeps a multi-megabyte board off the wire for
  // windows that are not even showing it.
  useEffect(() => {
    if (!window.harbor?.whiteboard?.onChange) return undefined;
    return window.harbor.whiteboard.onChange(async (payload) => {
      if (!payload?.id) return;
      if (payload.removed) {
        setBoards((current) => current.filter((item) => item.id !== payload.id));
        return;
      }
      setBoards((current) => {
        const known = current.some((item) => item.id === payload.id);
        const next = known
          ? current.map((item) => (item.id === payload.id ? { ...item, name: payload.name ?? item.name, updatedAt: payload.updatedAt ?? item.updatedAt } : item))
          : [...current, { id: payload.id, name: payload.name || payload.id, updatedAt: payload.updatedAt || new Date(0).toISOString() }];
        return orderBoards(next);
      });
      if (payload.id !== activeIdRef.current) return;
      const result = await window.harbor.whiteboard.read({ id: payload.id });
      if (!result?.ok || payload.id !== activeIdRef.current) return;
      externalRevisionRef.current += 1;
      setExternalScene({
        boardId: payload.id,
        revision: externalRevisionRef.current,
        elements: result.board.elements || [],
        files: result.board.files || {},
      });
    });
  }, []);

  const onSceneChange = useCallback((scene) => {
    if (!activeId) return;
    pendingRef.current = { id: activeId, scene };
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { flushSave(); }, SAVE_DELAY_MS);
  }, [activeId, flushSave]);

  const switchBoard = async (id) => {
    if (id === activeId) return;
    await flushSave();
    await openBoard(id);
  };

  const createBoard = async () => {
    await flushSave();
    const result = await window.harbor.whiteboard.create({ name: 'Untitled board' });
    if (!result.ok) { setNotice(result.reason); return; }
    await refreshList(result.board.id);
    await openBoard(result.board.id);
    // The fresh board renames inline in the picker bar (Miro's editable title).
    setRenamingId(result.board.id);
    setRenameDraft(result.board.name);
  };

  const commitRename = async (id) => {
    const name = renameDraft.trim();
    if (!name) return;
    // A same-name commit is a no-op: the bar rename blurs on the first canvas
    // click, and a real rename here would remount the canvas mid-gesture.
    if (name === boards.find((item) => item.id === id)?.name) { setRenamingId(null); return; }
    await flushSave();
    const result = await window.harbor.whiteboard.rename({ id, name });
    if (!result.ok) { setNotice(result.reason); return; }
    setRenamingId(null);
    await refreshList(result.board.id);
    if (activeId === id) await openBoard(result.board.id);
  };

  const deleteBoard = async (id) => {
    if (armedDelete !== id) { setArmedDelete(id); return; }
    await flushSave();
    const result = await window.harbor.whiteboard.delete({ id });
    setArmedDelete(null);
    if (!result.ok) { setNotice(result.reason); return; }
    const nextId = await refreshList();
    if (activeId === id) await openBoard(nextId);
  };

  // The Miro-style board switcher: the board name is a dropdown opening a
  // searchable list of every board with rename / duplicate / delete / new.
  // The panel PORTALS to document.body (backdrop-filter traps fixed
  // descendants, the app-wide popover rule).
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [panelPos, setPanelPos] = useState(null);
  const [query, setQuery] = useState('');
  const switcherBtnRef = useRef(null);
  const panelRef = useRef(null);

  const openSwitcher = useCallback(() => {
    const rect = switcherBtnRef.current?.getBoundingClientRect();
    setPanelPos(rect ? { left: Math.round(rect.left), top: Math.round(rect.bottom + 6) } : { left: 12, top: 48 });
    setQuery('');
    setArmedDelete(null);
    setSwitcherOpen(true);
  }, []);

  const closeSwitcher = useCallback(() => {
    setSwitcherOpen(false);
    setArmedDelete(null);
    setRenamingId(null);
  }, []);

  useEffect(() => {
    if (!switcherOpen) return undefined;
    const onDown = (event) => {
      if (panelRef.current?.contains(event.target)) return;
      if (switcherBtnRef.current?.contains(event.target)) return;
      closeSwitcher();
    };
    const onKey = (event) => { if (event.key === 'Escape') closeSwitcher(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [switcherOpen, closeSwitcher]);

  // Duplicate composes existing IPC (read + create + write), no new channels.
  const duplicateBoard = async (id) => {
    await flushSave();
    const source = await window.harbor.whiteboard.read({ id });
    if (!source.ok) { setNotice(source.reason || 'Could not read board'); return; }
    const name = duplicateName(source.board.name, boards.map((item) => item.name));
    const created = await window.harbor.whiteboard.create({ name });
    if (!created.ok) { setNotice(created.reason); return; }
    const scene = {
      elements: source.board.elements || [],
      files: source.board.files || {},
      appState: source.board.appState || {},
    };
    const wrote = await window.harbor.whiteboard.write({ id: created.board.id, scene });
    if (!wrote.ok) { setNotice(wrote.reason); return; }
    await refreshList(created.board.id);
    await openBoard(created.board.id);
  };

  return (
    <div className="whiteboard-view">
      <div className="whiteboard-picker" aria-label="Boards">
        {!switcherOpen && renamingId === activeId && renamingId !== null ? (
          <input
            className="whiteboard-rename wb-switcher-title-rename"
            value={renameDraft}
            autoFocus
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={() => commitRename(activeId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename(activeId);
              if (event.key === 'Escape') setRenamingId(null);
            }}
          />
        ) : (
          <button
            type="button"
            className={`wb-switcher-btn${switcherOpen ? ' open' : ''}`}
            ref={switcherBtnRef}
            aria-haspopup="listbox"
            aria-expanded={switcherOpen}
            title="Switch board"
            onClick={() => (switcherOpen ? closeSwitcher() : openSwitcher())}
          >
            <span className="wb-switcher-tile" style={{ background: `hsl(${boardHue(activeId)} 62% 52%)` }} aria-hidden="true" />
            <span className="wb-switcher-name">{boards.find((item) => item.id === activeId)?.name || 'Boards'}</span>
            <span className="wb-switcher-caret" aria-hidden="true">{'▾'}</span>
          </button>
        )}
        {switcherOpen && panelPos ? createPortal(
          <div className="wb-switcher-panel" ref={panelRef} style={{ left: panelPos.left, top: panelPos.top }} role="listbox" aria-label="All boards">
            <input
              className="wb-switcher-search"
              placeholder="Search boards"
              value={query}
              autoFocus={renamingId === null}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="wb-switcher-list">
              {filterBoards(boards, query).map((item) => (
                <div className={`wb-switcher-row${item.id === activeId ? ' active' : ''}`} key={item.id}>
                  {renamingId === item.id ? (
                    <input
                      className="whiteboard-rename"
                      value={renameDraft}
                      autoFocus
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={() => commitRename(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename(item.id);
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                    />
                  ) : (
                    <button type="button" className="wb-switcher-main" onClick={() => { closeSwitcher(); switchBoard(item.id); }}>
                      <span className="wb-switcher-tile" style={{ background: `hsl(${boardHue(item.id)} 62% 52%)` }} aria-hidden="true" />
                      <span className="wb-switcher-name">{item.name}</span>
                      <time>{relativeTime(item.updatedAt)}</time>
                    </button>
                  )}
                  <button
                    type="button"
                    className="wb-switcher-act"
                    title="Rename board"
                    onClick={() => { setRenamingId(item.id); setRenameDraft(item.name); }}
                  >Rename</button>
                  <button
                    type="button"
                    className="wb-switcher-act"
                    title="Duplicate board"
                    onClick={() => duplicateBoard(item.id)}
                  >Duplicate</button>
                  <button
                    type="button"
                    className={`wb-switcher-act delete${armedDelete === item.id ? ' armed' : ''}`}
                    title={armedDelete === item.id ? 'Click again to move board to trash' : 'Delete board'}
                    onClick={() => deleteBoard(item.id)}
                  >{armedDelete === item.id ? 'Confirm' : 'Delete'}</button>
                </div>
              ))}
              {filterBoards(boards, query).length === 0 ? (
                <div className="wb-switcher-empty">No boards match</div>
              ) : null}
            </div>
            <button type="button" className="wb-switcher-newrow" onClick={createBoard}>New board</button>
          </div>,
          document.body,
        ) : null}
        {IN_BOARD_WINDOW ? null : (
          <button
            type="button"
            className="whiteboard-popout"
            title="Open this board in its own window"
            onClick={() => window.harbor?.win?.openBoard?.()}
          >Pop out</button>
        )}
        <button
          type="button"
          className={`whiteboard-fs${fullscreen ? ' on' : ''}`}
          title={fullscreen ? 'Exit full screen' : 'Full screen'}
          aria-pressed={fullscreen}
          onClick={() => applyFullscreen(!fullscreen)}
        >{fullscreen ? 'Exit full screen' : 'Full screen'}</button>
        <button type="button" className="whiteboard-new" onClick={createBoard}>New board</button>
      </div>
      <div className="whiteboard-canvas">
        {notice ? <button type="button" className="whiteboard-notice" onClick={() => setNotice(null)}>{notice}</button> : null}
        {loading ? <div className="whiteboard-loading">Loading board...</div> : null}
        {!loading && board ? (
          <Suspense fallback={<div className="whiteboard-loading">Loading canvas...</div>}>
            <WhiteboardCanvas
              key={board.id}
              board={board}
              onSceneChange={onSceneChange}
              externalScene={externalScene && externalScene.boardId === board.id ? externalScene : null}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
