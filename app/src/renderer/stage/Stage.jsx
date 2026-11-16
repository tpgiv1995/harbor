import { subSessionReadOnly } from '../../shared/sub-sessions.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SessionTile } from './SessionTile.jsx';
import { ErrorBoundary } from '../ErrorBoundary.jsx';
import { CommandBar } from './CommandBar.jsx';
import { useProfiles, profileStyle } from '../providers.js';
import gridNav from './grid-nav.cjs';
import conversationScroll from './conversation-scroll.cjs';
import { siblingSessionRequest } from '../new-session-defaults.cjs';

const { gridDimensions } = gridNav;
const { scrollsWithin, wheelPixels } = conversationScroll;

const isEditable = (el) => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
// Hand a scroll to a conversation window as Pat's own (use-conversation-scroll.js).
const routeScroll = (conv, detail) => conv?.dispatchEvent(new CustomEvent('harbor-conv-scroll', { detail }));
const byId = (a, b) => (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0);

// One button per configured profile, in the order the user put them in, coloured
// from the profile itself. These were three hardcoded buttons naming Pat's own
// accounts, which is wrong twice over for anybody else: a person with one plan
// got two buttons that launch into config homes they do not have, and a person
// whose profile carried any other id got no button
// that could reach it. Rendering from the profile list is also what keeps the
// zero-profile first-run state honest, where there is nothing to launch yet.
function ProfileLaunchButtons({ profiles, onLaunch, suffix = '' }) {
  if (!profiles.length) return null;
  return (
    <div className="slot-actions">
      {profiles.map((profile) => (
        <button
          key={profile.id}
          type="button"
          className="slot-btn"
          style={profileStyle(profile)}
          title={profile.email || profile.label}
          onClick={() => onLaunch({ account: profile.id, provider: profile.provider || 'claude' })}
        >
          {`+ ${profile.label}${suffix}`}
        </button>
      ))}
    </div>
  );
}

function NewSessionSlot({ onNew, style }) {
  const { profiles } = useProfiles();
  return (
    <div className="win2 slot" role="group" aria-label="New session" style={style}>
      <div className="slot-inner">
        <span className="slot-word">New session</span>
        <ProfileLaunchButtons profiles={profiles} onLaunch={onNew} />
      </div>
    </div>
  );
}

const DRAG_THRESHOLD = 6;
// Columns layout: below this width a column stops being readable, so the
// stage scrolls sideways instead of crushing every window.
const COLUMN_MIN_PX = 380;

// The stage: an adaptive Slate grid up to 16 windows. One open session gets the
// whole stage, two split side by side, three or four tile 2x2 with dashed
// new-session slots filling the gaps (counts 1-3 only). Right-drag a window
// to rearrange. layout="columns" puts every window in one row of full-height
// columns instead.
export function Stage({
  tiles,
  sessionsById,
  transcripts,
  asksBySession,
  waitingIds,
  selectedId,
  attention,
  focusedId,
  resolvePane,
  sendStates,
  externalControl,
  onSelect,
  onPlace,
  layout = 'tiles',
  onClose,
  onToggleTty,
  onToggleFocus,
  onNewSession,
  onSend,
  onInterrupt,
  liveVoice,
  onCancelQueued,
  onResume,
  onTakeover,
  onModelSwitch,
  onEffortSwitch,
  onRunWorkflow,
  onOpenConfig,
  handoffChains,
  onHandoffChain,
  orchSummaries,
  onOpenOrch,
  onOpenDelegations,
  draft,
  onDraftChange,
  onDraftClear,
  appendSessionDraft,
  xterm,
  isExternalLive,
}) {
  const { profiles } = useProfiles();
  const gridRef = useRef(null);
  const tileRefs = useRef(new Map());
  const dragCleanupRef = useRef(null);
  const dragPosRef = useRef(null);
  const dragRafRef = useRef(null);
  const [drag, setDrag] = useState(null);

  const resolved = tiles
    .map((tile, i) => ({ tile, session: sessionsById.get(tile.sessionId), slot: Number.isInteger(tile.slot) ? tile.slot : i }))
    .filter((r) => r.session)
    .sort((a, b) => a.slot - b.slot);
  const count = resolved.length;
  const maxSlot = resolved.reduce((m, r) => Math.max(m, r.slot), -1);
  // Slot order numbers the windows (^1, ^2 ...). The PAGE order is by session id
  // and never changes when windows are rearranged: every tile is placed by its
  // own grid row and column, so page order decides nothing on screen, but a
  // keyed list re-sorted by slot made React MOVE tiles in the page on every
  // rearrange, and a browser puts a scroll box that is moved at its top. That
  // was Pat's "windows scroll to the top of the chat" (2026-11-16): idle windows
  // sat on their first prompt until the session next wrote
  // (scripts/drive-conversation-scroll-win.js, step "reorder").
  const rankById = new Map(resolved.map((r, i) => [r.session.id, i]));
  const pageOrder = [...resolved].sort(byId);
  // Focus mode: one window takes the full stage; the rest stay MOUNTED (their
  // pty streams and scroll positions survive) but hidden via CSS.
  const focusActive = Boolean(focusedId && resolved.some((r) => r.session.id === focusedId));
  const columnsLayout = layout === 'columns' && !focusActive;
  const { cols, rows } = focusActive ? { cols: 1, rows: 1 } : gridDimensions(Math.max(count, maxSlot + 1), layout);
  // Every unoccupied cell is a hole: visible as a dashed new-session slot and
  // meaningful as a drop target (a window dropped there OWNS that cell).
  const occupied = new Set(resolved.map((r) => r.slot));
  const holes = focusActive ? [] : Array.from({ length: cols * rows }, (_, c) => c).filter((c) => !occupied.has(c));

  const selected = sessionsById.get(selectedId) || null;
  const selectedPane = selected ? resolvePane(selected) : null;
  const selectedTranscriptHeader = selected ? transcripts.get(selected.id)?.header || null : null;
  // The command bar hears "waiting on you" from the same evidence as the badge
  // (index.jsx waitingIds); the transcript header alone never says it.
  const selectedWaiting = Boolean(selected && waitingIds?.has(selected.id));
  const selectedHeader = useMemo(
    () => (selectedWaiting ? { ...selectedTranscriptHeader, blocked: true } : selectedTranscriptHeader),
    [selectedTranscriptHeader, selectedWaiting],
  );
  const selectedReadOnly = subSessionReadOnly(selected);
  const selectedExternalLive = selected ? isExternalLive(selected) : false;

  // Slot index straight from the grid's geometry. NEVER hit-test the rendered
  // tiles: the dragged tile is position-fixed under the cursor at all times
  // and the live preview keeps reshuffling its siblings, so a DOM hit test
  // resolves back to the dragged tile's own index and every human-speed drag
  // drops as a no-op (live-caught by Pat; the fast synthetic drag hid it).
  const hitTestIndex = useCallback((clientX, clientY) => {
    const grid = gridRef.current;
    if (!grid) return drag?.overIndex ?? 0;
    const rect = grid.getBoundingClientRect();
    const styles = getComputedStyle(grid);
    const cols = Number(grid.dataset.gridCols) || 1;
    const rows = Number(grid.dataset.gridRows) || 1;
    const padL = parseFloat(styles.paddingLeft) || 0;
    const padT = parseFloat(styles.paddingTop) || 0;
    const padR = parseFloat(styles.paddingRight) || 0;
    const padB = parseFloat(styles.paddingBottom) || 0;
    const gap = parseFloat(styles.gap) || 0;
    // scrollWidth/scrollLeft, not the rect: the columns layout scrolls
    // sideways once the columns hit their minimum width.
    const innerW = Math.max(1, Math.max(rect.width, grid.scrollWidth) - padL - padR);
    const innerH = Math.max(1, rect.height - padT - padB);
    const cellW = (innerW - gap * (cols - 1)) / cols;
    const cellH = (innerH - gap * (rows - 1)) / rows;
    const cx = Math.min(Math.max(clientX - rect.left + grid.scrollLeft - padL, 0), innerW - 1);
    const cy = Math.min(Math.max(clientY - rect.top - padT, 0), innerH - 1);
    const col = Math.min(cols - 1, Math.max(0, Math.floor(cx / (cellW + gap))));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(cy / (cellH + gap))));
    return row * cols + col;
  }, [drag]);

  const endDrag = useCallback((commit) => {
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    dragPosRef.current = null;
    setDrag((current) => {
      if (commit && current && current.overCell !== current.fromSlot) {
        onPlace(current.sessionId, current.overCell);
      }
      return null;
    });
  }, [onPlace]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  // Columns can overflow the stage sideways: bring the selected window into
  // view when it changes (rail click, Alt+arrows, Ctrl+1-9).
  useEffect(() => {
    if (!columnsLayout || !selectedId) return;
    tileRefs.current.get(selectedId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [columnsLayout, selectedId]);

  // The mouse wheel and PageUp/PageDown scroll a conversation from anywhere on
  // the stage (Pat, 2026-11-16: "if i have a chat/window selected ... the scroll
  // wheel on my mouse will scroll the chat"). Over a conversation the browser
  // scrolls it as always. Over a window's header, that window. Over the command
  // bar, the gaps or an empty slot, the selected window. Anything that scrolls
  // itself (a long draft, a menu, the raw terminal) keeps its own wheel.
  // PageUp/PageDown move the selected window a page with the cursor in the
  // message box, as in Discord and Slack; a terminal or another text field keeps them.
  const wrapRef = useRef(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const selectedConv = () => wrap.querySelector('.win2.sel:not(.focus-hidden) .conv') || wrap.querySelector('.win2.focused .conv');
    const onWheel = (event) => {
      if (event.ctrlKey || event.defaultPrevented || !event.deltaY) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('.conv, .tile-tty, .terminal-pane')) return;
      if (scrollsWithin(target, wrap, event.deltaY, (el) => getComputedStyle(el))) return;
      const tile = target.closest('.win2[data-session-id]');
      const conv = tile ? tile.querySelector('.conv') : selectedConv();
      if (conv) routeScroll(conv, { by: wheelPixels(event, conv.clientHeight) });
    };
    const onKey = (event) => {
      if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const active = document.activeElement;
      const inComposer = Boolean(active?.closest?.('.ubar-input'));
      if (!inComposer && active && active !== document.body) {
        if (!wrap.contains(active) || isEditable(active) || active.closest('.tile-tty, .terminal-pane')) return;
      }
      const conv = selectedConv();
      if (!conv) return;
      event.preventDefault();
      routeScroll(conv, { page: event.key === 'PageUp' ? -1 : 1 });
    };
    wrap.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('keydown', onKey, true);
    return () => {
      wrap.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const onHeaderPointerDown = useCallback((event, fromSlot, sessionId) => {
    const diag = (k, extra) => window.__harborDiag?.push({
      k,
      pointerType: event.pointerType,
      button: event.button,
      target: String(event.target?.className || event.target?.nodeName || '?').slice(0, 50),
      ...extra,
    });
    if (event.button !== 2) { diag('drag-skip-button'); return; }
    // GRID MODE RULE: windows rearrange only on right-drag from anywhere in
    // the tile. Left-drag remains native so conversation text can be selected.
    // Buttons, inputs, links, menus, and the raw terminal keep their clicks.
    if (event.target.closest('button, input, textarea, a, .terminal-pane, .cap-menu, .plus-menu, .ubar')) { diag('drag-skip-target'); return; }
    diag('drag-armed', { fromSlot });
    event.preventDefault();

    const tileEl = tileRefs.current.get(sessionId);
    const rect = tileEl?.getBoundingClientRect();
    const offsetX = rect ? event.clientX - rect.left : 0;
    const offsetY = rect ? event.clientY - rect.top : 0;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!active && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        active = true;
        window.__harborDiag?.push({ k: 'drag-lift', sessionId: String(sessionId).slice(0, 8) });
        const pos = {
          x: ev.clientX,
          y: ev.clientY,
          offsetX,
          offsetY,
          width: rect?.width || 320,
          height: rect?.height || 240,
        };
        dragPosRef.current = pos;
        setDrag({
          sessionId,
          fromSlot,
          overCell: fromSlot,
          width: pos.width,
          height: pos.height,
        });
      }
      if (!active) return;
      const pos = dragPosRef.current;
      if (!pos) return;
      pos.x = ev.clientX;
      pos.y = ev.clientY;
      const ghost = tileRefs.current.get(sessionId);
      if (ghost) {
        ghost.style.left = `${pos.x - pos.offsetX}px`;
        ghost.style.top = `${pos.y - pos.offsetY}px`;
      }
      if (dragRafRef.current) return;
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
        const overCell = hitTestIndex(pos.x, pos.y);
        setDrag((prev) => (prev && prev.overCell !== overCell ? { ...prev, overCell } : prev));
      });
    };

    const onUp = () => {
      cleanup();
      window.__harborDiag?.push({ k: active ? 'drag-drop' : 'drag-click' });
      if (active) endDrag(true);
      else onSelect(sessionId);
    };

    const onCancel = () => {
      // The browser claimed the gesture (touch scroll, native drag): cancel
      // cleanly instead of wedging half-armed.
      window.__harborDiag?.push({ k: 'drag-pointercancel', active });
      cleanup();
      if (active) endDrag(false);
    };

    const onKey = (ev) => {
      if (ev.key === 'Escape' && active) {
        ev.preventDefault();
        cleanup();
        endDrag(false);
      }
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      dragCleanupRef.current = null;
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
  }, [endDrag, hitTestIndex, onSelect]);

  return (
    <div className="stagewrap" ref={wrapRef}>
      {count === 0 ? (
        <div className="stage-empty">
          <div className="stage-empty-inner">
            <h2>Nothing on the stage</h2>
            <p>Open a session from the rail, or start a fresh one.</p>
            <ProfileLaunchButtons profiles={profiles} onLaunch={onNewSession} suffix=" session" />
          </div>
        </div>
      ) : (
        <div
          ref={gridRef}
          className={`grid4${focusActive ? ' focus-mode' : ''}${columnsLayout ? ' columns' : ''}`}
          data-layout={columnsLayout ? 'columns' : 'tiles'}
          data-grid-count={count}
          data-grid-cols={cols}
          data-grid-rows={rows}
          style={{
            gridTemplateColumns: columnsLayout ? `repeat(${cols}, minmax(${COLUMN_MIN_PX}px, 1fr))` : `repeat(${cols}, 1fr)`,
            gridTemplateRows: `repeat(${rows}, 1fr)`,
          }}
        >
          {pageOrder.map(({ tile, session, slot }) => {
            const rank = rankById.get(session.id);
            const pane = resolvePane(session);
            const isDragging = drag?.sessionId === session.id;
            const cellStyle = focusActive ? undefined : {
              gridColumn: (slot % cols) + 1,
              gridRow: Math.floor(slot / cols) + 1,
            };
            return (
              <ErrorBoundary key={session.id} name={`Session: ${session.title || session.id}`} className={`session-error${focusActive && session.id !== focusedId ? ' focus-hidden' : ''}`} style={cellStyle}>
              <SessionTile
                key={session.id}
                ref={(el) => {
                  if (el) tileRefs.current.set(session.id, el);
                  else tileRefs.current.delete(session.id);
                }}
                session={session}
                data={transcripts.get(session.id) || null}
                pendingAsk={asksBySession?.get(session.id) || null}
                pane={pane}
                selected={session.id === selectedId}
                attention={attention?.get?.(session.id) || null}
                index={rank}
                slot={slot}
                readOnly={subSessionReadOnly(session)}
                tty={Boolean(tile.tty)}
                focused={focusActive && session.id === focusedId}
                focusHidden={focusActive && session.id !== focusedId}
                dragging={isDragging}
                dragStyle={isDragging && dragPosRef.current ? {
                  position: 'fixed',
                  left: dragPosRef.current.x - dragPosRef.current.offsetX,
                  top: dragPosRef.current.y - dragPosRef.current.offsetY,
                  width: dragPosRef.current.width,
                  height: dragPosRef.current.height,
                  zIndex: 200,
                } : cellStyle}
                placeholder={false}
                onHeaderPointerDown={focusActive ? undefined : (e) => onHeaderPointerDown(e, slot, session.id)}
                onSelect={() => onSelect(session.id)}
                onClose={() => onClose(session.id)}
                onToggleTty={() => onToggleTty(session.id)}
                onToggleFocus={() => onToggleFocus(session.id)}
                onNewSibling={() => onNewSession(siblingSessionRequest(session))}
                onOpenConfig={() => onOpenConfig({
                  session,
                  header: transcripts.get(session.id)?.header || null,
                  pane,
                  folder: session.cwd,
                  account: session.home,
                  drivable: Boolean(pane && !subSessionReadOnly(session) && !isExternalLive(session) && !externalControl[pane.paneId]),
                })}
                queueSummary={session.cwd ? orchSummaries?.[session.cwd] || null : null}
                onOpenOrch={() => onOpenOrch(session)}
                onOpenDelegations={() => onOpenDelegations(session.id)}
                externallyControlled={Boolean(pane && externalControl[pane.paneId])}
                xterm={xterm}
              />
              </ErrorBoundary>
            );
          })}
          {drag ? (
            <div
              className="win2 drag-vacated"
              aria-hidden="true"
              style={{ gridColumn: (drag.fromSlot % cols) + 1, gridRow: Math.floor(drag.fromSlot / cols) + 1 }}
            />
          ) : null}
          {drag && drag.overCell !== drag.fromSlot ? (
            <div
              className="drop-hint"
              aria-hidden="true"
              style={{ gridColumn: (drag.overCell % cols) + 1, gridRow: Math.floor(drag.overCell / cols) + 1 }}
            />
          ) : null}
          {holes.map((cell) => (
            <NewSessionSlot
              key={`hole-${cell}`}
              onNew={(request) => onNewSession({ ...request, stageSlot: cell })}
              style={{ gridColumn: (cell % cols) + 1, gridRow: Math.floor(cell / cols) + 1 }}
            />
          ))}
        </div>
      )}
      <CommandBar
        session={selected}
        header={selectedHeader}
        pane={selectedPane}
        readOnly={selectedReadOnly}
        externalLive={selectedExternalLive}
        externallyControlled={Boolean(selectedPane && externalControl[selectedPane.paneId])}
        sendState={selected ? sendStates.get(selected.id) || null : null}
        onSend={onSend}
        onInterrupt={onInterrupt}
        liveVoice={liveVoice}
        onCancelQueued={onCancelQueued}
        onResume={onResume}
        onTakeover={onTakeover}
        onModelSwitch={onModelSwitch}
        onEffortSwitch={onEffortSwitch}
        onRunWorkflow={onRunWorkflow}
        handoffChain={selected ? handoffChains?.get(selected.id) || null : null}
        onHandoffChain={selected && onHandoffChain ? () => onHandoffChain(selected.id) : undefined}
        onOpenConfig={(insertDraft) => onOpenConfig({
          session: selected,
          header: selectedHeader,
          pane: selectedPane,
          folder: selected?.cwd,
          account: selected?.home,
          drivable: Boolean(selectedPane && !selectedReadOnly && !selectedExternalLive && !externalControl[selectedPane.paneId]),
          insertDraft,
        })}
        draft={draft}
        onDraftChange={onDraftChange}
        onDraftClear={onDraftClear}
        appendSessionDraft={appendSessionDraft}
      />
    </div>
  );
}
