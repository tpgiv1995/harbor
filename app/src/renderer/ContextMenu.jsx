import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The app-wide right-click menu, carrying Chromium's spelling suggestions.
//
// Drawn in Slate rather than as a native GTK popup, for the same reason the
// xterm pane draws its own: a system menu inside a frameless glass app reads as
// a foreign object. Main pushes a finished model (see main/context-menu.js);
// this component only renders it and reports the pick back.
//
// Portaled to document.body because every glass surface in Harbor sets
// backdrop-filter, which would become this fixed menu's containing block and
// strand it inside whatever it was opened over.

// Keeping the caret and selection alive is the whole game: replaceMisspelling
// acts on the focused editable, so any menu interaction that blurs it would
// silently no-op. Suppressing mousedown means focus never leaves the composer.
const keepFocus = (event) => event.preventDefault();

// Nudge the menu back inside the viewport when it opens near an edge, so the
// last suggestion is never the one you cannot reach.
function clampToViewport(x, y, element) {
  if (!element) return { left: x, top: y };
  const { offsetWidth: width, offsetHeight: height } = element;
  const margin = 8;
  return {
    left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  };
}

export function ContextMenu() {
  const [menu, setMenu] = useState(null);
  const [position, setPosition] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => window.harbor?.contextMenu?.onShow?.((model) => {
    setPosition(null);
    setMenu(model);
  }), []);

  // Measure after paint, then place. Reading offsetWidth before the menu has
  // its content would clamp against a zero-sized box.
  useEffect(() => {
    if (!menu) return;
    setPosition(clampToViewport(menu.x, menu.y, menuRef.current));
  }, [menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setMenu(null); };
    // A scroll or resize under an open menu leaves it pointing at text that has
    // moved; close rather than mislead.
    const onDismiss = () => setMenu(null);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onDismiss);
    window.addEventListener('blur', onDismiss);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onDismiss);
      window.removeEventListener('blur', onDismiss);
    };
  }, [menu]);

  if (!menu) return null;

  const run = (fn) => async () => {
    setMenu(null);
    await fn();
  };

  const bridge = window.harbor?.contextMenu;
  const hasSpellSection = menu.suggestions.length > 0 || menu.canAddToDictionary;
  const hasEditSection = menu.actions.cut || menu.actions.copy
    || menu.actions.paste || menu.actions.selectAll;

  return createPortal(
    <>
      <button
        type="button"
        className="ctxmenu-backdrop"
        onMouseDown={keepFocus}
        onClick={() => setMenu(null)}
        onContextMenu={(event) => { event.preventDefault(); setMenu(null); }}
        aria-label="Close menu"
      />
      <div
        ref={menuRef}
        className="ctxmenu"
        role="menu"
        aria-label="Right-click menu"
        style={{
          left: position ? position.left : menu.x,
          top: position ? position.top : menu.y,
          // Placed after measuring; showing it at the raw point first would be
          // a visible jump on every edge-of-screen open.
          visibility: position ? 'visible' : 'hidden',
        }}
        onMouseDown={keepFocus}
      >
        {menu.suggestions.map((word) => (
          <button
            key={word}
            type="button"
            role="menuitem"
            className="ctxmenu-suggestion"
            onMouseDown={keepFocus}
            onClick={run(() => bridge?.replaceMisspelling?.(word))}
          >
            {word}
          </button>
        ))}

        {/* A misspelling Chromium cannot guess at still gets this row: names
            and jargon are exactly what the personal dictionary is for. */}
        {menu.suggestions.length === 0 && menu.canAddToDictionary ? (
          <div className="ctxmenu-empty" role="presentation">No suggestions</div>
        ) : null}

        {menu.canAddToDictionary ? (
          <button
            type="button"
            role="menuitem"
            className="ctxmenu-add"
            onMouseDown={keepFocus}
            onClick={run(() => bridge?.addToDictionary?.(menu.misspelledWord))}
          >
            Add “{menu.misspelledWord}” to dictionary
          </button>
        ) : null}

        {hasSpellSection && hasEditSection ? <div className="ctxmenu-sep" role="separator" /> : null}

        {menu.actions.cut ? (
          <button type="button" role="menuitem" onMouseDown={keepFocus} onClick={run(() => bridge?.editAction?.('cut'))}>Cut</button>
        ) : null}
        {menu.actions.copy ? (
          <button type="button" role="menuitem" onMouseDown={keepFocus} onClick={run(() => bridge?.editAction?.('copy'))}>Copy</button>
        ) : null}
        {menu.actions.paste ? (
          <button type="button" role="menuitem" onMouseDown={keepFocus} onClick={run(() => bridge?.editAction?.('paste'))}>Paste</button>
        ) : null}
        {menu.actions.selectAll ? (
          <button type="button" role="menuitem" onMouseDown={keepFocus} onClick={run(() => bridge?.editAction?.('selectAll'))}>Select all</button>
        ) : null}
      </div>
    </>,
    document.body,
  );
}
