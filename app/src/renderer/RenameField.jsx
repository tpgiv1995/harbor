import React, { useEffect, useRef, useState } from 'react';

// RENAME A SESSION IN PLACE (2026-11-15, Pat: "like a little pencil icon where
// i could type in a custom title"). The one editor behind every pencil: the
// rail row and the window header. Enter or leaving the field saves, Escape puts
// the old title back, and saving an empty field brings the automatic title back
// (main/session-names.js). An unchanged title saves nothing, so opening the
// editor and leaving never turns an automatic title into a fixed one.
//
// Its events stay inside it: the row button, the header's drag and the
// window's click-to-arm-the-composer never see a click or a key meant for the
// text.

export function PencilIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 0l.2.2a1.6 1.6 0 0 1 0 2.3L5.6 12.9 2.5 13.5l.6-3.1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9.8 3.7l2.5 2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export default function RenameField({ initial, onSave, onDone, className = '' }) {
  const [value, setValue] = useState(initial || '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const settledRef = useRef(false);

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    node.select();
  }, []);

  const finish = async (save) => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (!save || value.trim() === String(initial || '').trim()) { onDone(); return; }
    setBusy(true);
    const result = await Promise.resolve(onSave(value)).catch((cause) => ({ ok: false, reason: String(cause?.message || cause) }));
    if (result && result.ok === false) {
      // Stay open with the text kept, and say why, rather than snapping back.
      settledRef.current = false;
      setBusy(false);
      setError(result.reason || 'Harbor could not save that name');
      inputRef.current?.focus();
      return;
    }
    onDone();
  };

  const stop = (event) => event.stopPropagation();
  return (
    <input
      ref={inputRef}
      className={`rename-field${error ? ' has-error' : ''}${className ? ` ${className}` : ''}`}
      type="text"
      value={value}
      maxLength={120}
      disabled={busy}
      spellCheck
      draggable={false}
      placeholder="Empty for the automatic title"
      aria-label="Session name"
      aria-invalid={error ? true : undefined}
      title={error || 'Enter to save, Esc to cancel. Leave it empty for the automatic title.'}
      onChange={(event) => { setValue(event.target.value); if (error) setError(null); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      }}
      onBlur={() => finish(true)}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      onContextMenu={stop}
    />
  );
}
