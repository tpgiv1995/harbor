import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

// Look at a pending composer attachment before sending it. Pat, 2026-08-13:
// clicking a chip did nothing at all unless the click landed on its little
// '×', so the only interaction the chip offered was destroying it.
//
// Portalled to document.body like every other overlay in the app: each glass
// surface sets backdrop-filter, which makes it the containing block for any
// fixed-position descendant, and a lightbox rendered inside the command bar
// would be trapped in the command bar (the same trap ContextMenu and the
// model quick-switch are portalled to escape).
//
// Read-only on purpose. Removing the attachment stays the chip's own '×', so a
// misclick into a preview can never destroy the thing it was opened to look at.
export function ImagePreview({ src, name, onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      // Stopped here so Escape closes the preview WITHOUT also reaching the
      // stage's own Escape handling and changing what is selected underneath.
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="image-preview" role="dialog" aria-label={`Image preview${name ? `: ${name}` : ''}`}>
      <button
        type="button"
        tabIndex={-1}
        className="image-preview-backdrop"
        aria-label="Close preview"
        onClick={onClose}
      />
      <div className="image-preview-panel">
        <div className="image-preview-head">
          <span className="image-preview-name" title={name || ''}>{name || 'Pending attachment'}</span>
          <button type="button" className="image-preview-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="image-preview-body">
          {src
            ? <img className="image-preview-img" src={src} alt={name || 'Pending attachment'} />
            : <span className="image-preview-empty">This image could not be read back for preview.</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ImagePreview;
