// Put text on the clipboard from a tap, and say whether it landed (2026-10-31).
//
// The header's copy-id button must show its check only for a copy that really
// happened, so this returns a boolean and never throws. Two paths, in the order
// that works on iOS Safari:
//   1. navigator.clipboard.writeText, called synchronously inside the tap
//      handler (Safari only allows it during a user gesture, and only over a
//      secure context, which the Tailscale https address is);
//   2. a hidden readonly textarea and document.execCommand('copy'), for a page
//      where the async API is missing (an http address, an older browser) or
//      refuses. With no async API this too runs inside the gesture.
// `env` exists so the node tests can hand it a fake navigator and document.
export async function copyText(text, env = {}) {
  const value = String(text ?? '');
  if (!value) return false;
  const nav = env.navigator ?? globalThis.navigator;
  const doc = env.document ?? globalThis.document;
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(value);
      return true;
    } catch { /* refused: fall back to the selection copy */ }
  }
  return execCommandCopy(doc, value);
}

function execCommandCopy(doc, value) {
  if (!doc?.body || typeof doc.execCommand !== 'function') return false;
  const area = doc.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  // 16px so iOS never zooms the page to it; off to the side of nothing, never
  // drawn, never hit by a finger.
  Object.assign(area.style, {
    position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', padding: '0',
    border: '0', opacity: '0', fontSize: '16px', pointerEvents: 'none',
  });
  const previous = doc.activeElement;
  doc.body.appendChild(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    // iOS ignores select() on a readonly field; an explicit range is what works.
    area.setSelectionRange(0, value.length);
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area.remove();
    try { previous?.focus?.({ preventScroll: true }); } catch { /* the page keeps its own focus */ }
  }
}
