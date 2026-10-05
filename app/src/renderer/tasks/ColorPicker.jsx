import React, { useEffect, useRef, useState } from 'react';
import { LIST_SWATCHES, hslToHex, hexToHsl } from './list-color.cjs';
import { hexFieldMaySyncFromValue, settleHexDraft } from './color-picker-hex.cjs';

/**
 * List colour picker: preset swatches, a hue spectrum, and hex entry.
 *
 * Deliberately NOT <input type="color">. On Linux Chromium hands that to the
 * GTK colour chooser through the desktop portal, which is a native modal: it
 * would draw on the real desktop from a harness and block the main process
 * waiting for an answer no test can give. That is the same trap the file
 * chooser sprang on 2026-07-26, and the reason resolveDialogPolicy exists.
 * Everything here is ordinary DOM, so the gate can drive it.
 */
export function ColorPicker({
  value, onChange, onClose,
  // When the picker is EMBEDDED in a form that owns its own dismissal, it must
  // not install document handlers: its Escape listener runs in the capture
  // phase, so it would swallow the key before the host form's own Escape and
  // leave the form stuck open. Popover use passes embedded={false}.
  embedded = false,
}) {
  const rootRef = useRef(null);
  const hexFocusedRef = useRef(false);
  const fallback = value || '#4ec9b6';
  const [hex, setHex] = useState(fallback);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!hexFieldMaySyncFromValue(hexFocusedRef.current)) return;
    setHex(fallback);
    setInvalid(false);
  }, [fallback]);

  // Close on outside click / Escape. Escape must not bubble to the view behind.
  useEffect(() => {
    if (embedded) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose?.(); }
    };
    const onDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) onClose?.();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose, embedded]);

  const commit = (next) => {
    hexFocusedRef.current = false;
    setHex(next);
    setInvalid(false);
    onChange(next);
  };

  const settleHexField = () => {
    hexFocusedRef.current = false;
    const settled = settleHexDraft(hex, fallback);
    setHex(settled.hex);
    setInvalid(settled.invalid);
    if (settled.commit) onChange(settled.commit);
  };

  const hue = hexToHsl(hex)?.h ?? 170;

  return (
    <div className="color-picker" ref={rootRef} role="group" aria-label="List colour">
      <div className="color-picker-swatches">
        {LIST_SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className={`color-swatch${swatch === hex ? ' selected' : ''}`}
            style={{ background: swatch }}
            aria-label={swatch}
            aria-pressed={swatch === hex}
            onClick={() => commit(swatch)}
          />
        ))}
      </div>

      <label className="color-picker-spectrum">
        <span className="sr-only">Hue</span>
        <input
          type="range"
          min="0"
          max="359"
          value={hue}
          aria-label="Hue"
          onChange={(event) => commit(hslToHex(Number(event.target.value), 60, 68))}
        />
      </label>

      <div className="color-picker-hex">
        <span className="color-picker-preview" style={{ background: invalid ? 'transparent' : hex } } aria-hidden="true" />
        <input
          type="text"
          value={hex}
          spellCheck={false}
          aria-label="Hex colour"
          aria-invalid={invalid || undefined}
          placeholder="#4ec9b6"
          onFocus={() => { hexFocusedRef.current = true; setInvalid(false); }}
          onBlur={settleHexField}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onChange={(event) => setHex(event.target.value)}
        />
      </div>
      {invalid ? <p className="color-picker-err">Use a hex value like #4ec9b6</p> : null}
    </div>
  );
}
