import React from 'react';

// Explicit edge/corner resize handles for the frameless window. Undecorated
// windows are not reliably edge-resizable across Linux WMs/compositors, so we
// drive resize ourselves via setBounds rather than trusting the WM. Screen
// coordinates keep it correct regardless of window position or monitor.
const GRIPS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const MIN_W = 960;
const MIN_H = 600;

export function ResizeGrips() {
  const draggingRef = React.useRef(false);
  const onPointerDown = async (dir, event) => {
    if (event.button !== 0 || draggingRef.current) return;
    event.preventDefault();
    const bounds = await window.harbor.win?.getBounds?.();
    if (!bounds) return;
    draggingRef.current = true;
    const startX = event.screenX;
    const startY = event.screenY;

    let raf = null;
    let pending = null;
    const flush = () => {
      raf = null;
      if (pending) window.harbor.win?.setBounds?.(pending);
    };
    // Listen on window (not the 4px grip) so the drag keeps tracking after the
    // pointer leaves the handle. Screen coords stay correct across monitors.
    const onMove = (moveEvent) => {
      // Self-terminate if the button is already up (a pointerup we never saw,
      // e.g. released off-screen) so the window never keeps resizing.
      if ((moveEvent.buttons & 1) === 0) { onUp(); return; }
      const dx = moveEvent.screenX - startX;
      const dy = moveEvent.screenY - startY;
      let { x, y, width, height } = bounds;
      if (dir.includes('e')) width = Math.max(MIN_W, bounds.width + dx);
      if (dir.includes('s')) height = Math.max(MIN_H, bounds.height + dy);
      if (dir.includes('w')) {
        width = Math.max(MIN_W, bounds.width - dx);
        x = bounds.x + (bounds.width - width);
      }
      if (dir.includes('n')) {
        height = Math.max(MIN_H, bounds.height - dy);
        y = bounds.y + (bounds.height - height);
      }
      pending = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
      if (raf == null) raf = requestAnimationFrame(flush);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (raf != null) cancelAnimationFrame(raf);
      if (pending) window.harbor.win?.setBounds?.(pending);
      draggingRef.current = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="resize-grips" aria-hidden="true">
      {GRIPS.map((dir) => (
        <div
          key={dir}
          className={`resize-grip resize-grip-${dir}`}
          onPointerDown={(event) => onPointerDown(dir, event)}
        />
      ))}
    </div>
  );
}
