import React, { useEffect, useRef, useState } from 'react';

// The clean single app menu that replaces the removed OS menu bar. Grouped
// File / View / Help sections in one dropdown off a titlebar button. Hints
// mirror the accelerators the hidden OS menu actually binds (main/index.js
// installAppMenu), so every hint here is a real working shortcut.
//
// The File section is BUILT FROM THE CONFIGURED PROFILES, not from a pair of
// hardcoded rows. It used to read "New team session" / "New personal session",
// which was the last surface still naming the two accounts the app was written
// on: a user with one plan saw a menu offering an account they do not have, and
// a user with three or more could never reach the rest from here. The rail and
// the stage were converted to render one button per discovered profile; this was
// the one place left behind.
const ITEMS = [
  { section: 'File' },
  { profiles: true },
  { sep: true },
  { id: 'quit', label: 'Quit Harbor', hint: 'Ctrl+Shift+Q' },
  { section: 'View' },
  { id: 'reload', label: 'Reload', hint: 'Ctrl+Shift+R' },
  { id: 'zoom-in', label: 'Zoom in', hint: 'Ctrl +' },
  { id: 'zoom-out', label: 'Zoom out', hint: 'Ctrl -' },
  { id: 'zoom-reset', label: 'Reset zoom', hint: 'Ctrl 0' },
  { id: 'fullscreen', label: 'Toggle full screen', hint: 'F11' },
  { id: 'devtools', label: 'Toggle developer tools', hint: 'Ctrl+Shift+I' },
  { section: 'Help' },
  { id: 'help', label: 'Quick guide', hint: 'F1' },
  { id: 'about', label: 'About Harbor' },
];

export function AppMenu({ onOpenHelp, onNewSession, profiles = [] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const close = () => {
    setOpen(false);
    btnRef.current?.focus();
  };

  const toggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen((value) => !value);
  };

  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector('.app-menu-item')?.focus();
    const dismiss = () => setOpen(false);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [open]);

  const run = async (id) => {
    setOpen(false);
    if (id.startsWith('new-session:')) {
      await onNewSession?.(id.slice('new-session:'.length));
      return;
    }
    if (id === 'help') {
      onOpenHelp?.();
      return;
    }
    window.harbor.win?.menuAction?.(id);
  };

  return (
    <div className="app-menu">
      <button
        ref={btnRef}
        type="button"
        className={`app-menu-btn${open ? ' open' : ''}`}
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Application menu"
        title="Menu"
      >
        <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
          <rect x="1.5" y="3" width="12" height="1.4" fill="currentColor" />
          <rect x="1.5" y="7" width="12" height="1.4" fill="currentColor" />
          <rect x="1.5" y="11" width="12" height="1.4" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <>
          <button
            type="button"
            tabIndex={-1}
            className="app-menu-backdrop"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <div
            ref={menuRef}
            className="app-menu-dropdown"
            role="menu"
            aria-label="Application menu"
            onKeyDown={(event) => { if (event.key === 'Escape') close(); }}
            style={pos ? { top: pos.top, left: pos.left } : undefined}
          >
            {ITEMS.map((item, index) => {
              if (item.section) return <div key={`s-${item.section}`} className="app-menu-section">{item.section}</div>;
              if (item.sep) return <div key={`sep-${index}`} className="app-menu-sep" />;
              if (item.profiles) {
                // Zero profiles is a real state (a codex-only or cursor-only
                // install, or a first run before the wizard), so this renders
                // one honest row rather than an empty File section.
                if (!profiles.length) {
                  return (
                    <button
                      key="new-session-default"
                      type="button"
                      role="menuitem"
                      className="app-menu-item"
                      data-action="new-session:"
                      onClick={() => run('new-session:')}
                    >
                      <span>New session</span>
                    </button>
                  );
                }
                return profiles.map((profile) => (
                  <button
                    key={`new-session-${profile.id}`}
                    type="button"
                    role="menuitem"
                    className="app-menu-item"
                    data-action={`new-session:${profile.id}`}
                    onClick={() => run(`new-session:${profile.id}`)}
                  >
                    <span>{`New ${profile.label || profile.id} session`}</span>
                  </button>
                ));
              }
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="app-menu-item"
                  data-action={item.id}
                  onClick={() => run(item.id)}
                >
                  <span>{item.label}</span>
                  {item.hint ? <span className="app-menu-hint">{item.hint}</span> : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
