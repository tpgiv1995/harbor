import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SessionTile } from './SessionTile.jsx';
import { CommandBar } from './CommandBar.jsx';
import { useProfiles, profileStyle } from '../providers.js';
import gridNav from './grid-nav.cjs';

const { gridDimensions } = gridNav;

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
          onClick={() => onLaunch(profile.id)}
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

// The stage: an adaptive Slate grid up to 16 windows. One open session gets the
// whole stage, two split side by side, three or four tile 2x2 with dashed
// new-session slots filling the gaps (counts 1-3 only). Right-drag a window
// to rearrange.
export function Stage({
  tiles,
  sessionsById,
  transcripts,
  selectedId,
  focusedId,
  resolvePane,
  sendStates,
  externalControl,
  onSelect,
  onPlace,
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
  orchSummaries,
  onOpenOrch,
  draft,
  onDraftChange,
  onDraftClear,
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
  // Focus mode: one window takes the full stage; the rest stay MOUNTED (their
  // pty streams and scroll positions survive) but hidden via CSS.
  const focusActive = Boolean(focusedId && resolved.some((r) => r.session.id === focusedId));
  const { cols, rows } = focusActive ? { cols: 1, rows: 1 } : gridDimensions(Math.max(count, maxSlot + 1));
  // Every unoccupied cell is a hole: visible as a dashed new-session slot and
  // meaningful as a drop target (a window dropped there OWNS that cell).
  const occupied = new Set(resolved.map((r) => r.slot));
  const holes = focusActive ? [] : Array.from({ length: cols * rows }, (_, c) => c).filter((c) => !occupied.has(c));

  const selected = sessionsById.get(selectedId) || null;
  const selectedPane = selected ? resolvePane(selected) : null;
  const selectedHeader = selected ? transcripts.get(selected.id)?.header || null : null;
  const selectedReadOnly = Boolean(selected?.isChildTask);
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
    const innerW = Math.max(1, rect.width - padL - padR);
    const innerH = Math.max(1, rect.height - padT - padB);
    const cellW = (innerW - gap * (cols - 1)) / cols;
    const cellH = (innerH - gap * (rows - 1)) / rows;
    const cx = Math.min(Math.max(clientX - rect.left - padL, 0), innerW - 1);
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
    <div className="stagewrap">
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
          className={`grid4${focusActive ? ' focus-mode' : ''}`}
          data-grid-count={count}
          data-grid-cols={cols}
          data-grid-rows={rows}
          style={{
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridTemplateRows: `repeat(${rows}, 1fr)`,
          }}
        >
          {resolved.map(({ tile, session, slot }, rank) => {
            const pane = resolvePane(session);
            const isDragging = drag?.sessionId === session.id;
            const cellStyle = focusActive ? undefined : {
              gridColumn: (slot % cols) + 1,
              gridRow: Math.floor(slot / cols) + 1,
            };
            return (
              <SessionTile
                key={session.id}
                ref={(el) => {
                  if (el) tileRefs.current.set(session.id, el);
                  else tileRefs.current.delete(session.id);
                }}
                session={session}
                data={transcripts.get(session.id) || null}
                pane={pane}
                selected={session.id === selectedId}
                index={rank}
                slot={slot}
                readOnly={Boolean(session.isChildTask)}
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
                onNewSibling={() => onNewSession({
                  account: session.home,
                  folder: session.cwd,
                  sessionId: session.id,
                  immediate: true,
                })}
                onOpenConfig={() => onOpenConfig({
                  session,
                  header: transcripts.get(session.id)?.header || null,
                  pane,
                  folder: session.cwd,
                  account: session.home,
                  drivable: Boolean(pane && !session.isChildTask && !isExternalLive(session) && !externalControl[pane.paneId]),
                })}
                queueSummary={session.cwd ? orchSummaries?.[session.cwd] || null : null}
                onOpenOrch={() => onOpenOrch(session)}
                externallyControlled={Boolean(pane && externalControl[pane.paneId])}
                xterm={xterm}
              />
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
              onNew={onNewSession}
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
      />
    </div>
  );
}
