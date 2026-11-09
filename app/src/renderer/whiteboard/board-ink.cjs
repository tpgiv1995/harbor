'use strict';

// The board's dark canvas and its ink, as pure functions (no DOM, no Excalidraw).
//
// The Board draws on a solid dark canvas (CANVAS_DARK) with Excalidraw running in its
// LIGHT theme. Excalidraw's own dark theme inverts the finished canvas with a CSS filter
// (invert 93% + hue-rotate 180deg), which flips every colour on the board: pasted
// screenshots and sticky fills come out wrong (see docs/claude/board.md). So the canvas is
// simply a dark background colour and the INK is adapted instead:
//
//   * The FILE is the truth and is never rewritten by this module. Stored near-black ink
//     stays near-black on disk.
//   * In memory, an element whose stored ink would be unreadable on the colour behind it
//     is shown with a readable ink of the same family (`applyBoardInk`). A ledger
//     (id -> { stored, shown }) remembers what was stored, and `restoreStoredInk` puts it
//     back at save time, so open + save leaves an untouched element byte-for-byte as it was.
//   * What counts as "behind": a text bound to a container sits on the container's opaque
//     fill (a sticky keeps its dark text), a shape with an opaque fill is visible by that
//     fill and keeps its ink as stored, anything else sits on the canvas.
//   * A colour the user deliberately picked that is readable is never touched. A pick that
//     is unreadable on the canvas is adapted for display only, and stays as picked on disk.
//
// The canvas colour follows the same idea: a board whose stored background is the retired
// white default (or unset) shows CANVAS_DARK; any other stored background is a deliberate
// choice and stays.

const CANVAS_DARK = '#141a26';
const INK_LIGHT = '#e4e5ec';
const INK_DARK = '#1e1e1e';
// A deliberately picked white is stored one level off pure white, so a later load can tell
// it from the retired default (which is exactly #ffffff, or unset).
const CANVAS_WHITE_PICKED = '#fefefe';

const TEXT_CONTRAST = 4.5;
const SHAPE_CONTRAST = 3;

// Element types whose strokeColor is an ink we adapt. Images, frames and embeds are not.
const INK_TYPES = new Set(['text', 'line', 'arrow', 'freedraw', 'rectangle', 'ellipse', 'diamond']);

function parseHex(value) {
  if (typeof value !== 'string') return null;
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return null;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHsl([r, g, b]) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const hn = h / 360;
  return [hue(hn + 1 / 3) * 255, hue(hn) * 255, hue(hn - 1 / 3) * 255];
}

// The retired default canvas: unset, transparent, or exactly Excalidraw's old white.
function isRetiredCanvas(value) {
  if (value == null) return true;
  const v = String(value).trim().toLowerCase();
  return v === '' || v === 'transparent' || v === 'white' || v === '#fff' || v === '#ffffff';
}

// What the board shows behind everything.
function canvasForDisplay(stored) {
  return isRetiredCanvas(stored) ? CANVAS_DARK : String(stored).trim();
}

// What to write back for a live canvas colour (the inverse of canvasForDisplay for the
// one case it cannot invert on its own: a white the user picked on purpose).
function canvasForStorage(live) {
  if (live == null) return CANVAS_DARK;
  const v = String(live).trim().toLowerCase();
  if (v === '#ffffff' || v === '#fff' || v === 'white') return CANVAS_WHITE_PICKED;
  return String(live).trim();
}

function isDarkBackdrop(hex) {
  const rgb = parseHex(hex);
  return rgb ? relativeLuminance(rgb) < 0.4 : true;
}

// A readable ink for `color` on `backdrop`. Returns `color` unchanged when it already reads
// (or cannot be judged); a neutral that does not read becomes the canvas's standard ink; a
// coloured ink keeps its hue and slides in lightness until it reads.
function readableInk(color, backdrop, minContrast = SHAPE_CONTRAST) {
  const rgb = parseHex(color);
  const bg = parseHex(backdrop);
  if (!rgb || !bg) return color;
  const ratio = contrastRatio(color, backdrop);
  if (ratio === null || ratio >= minContrast) return color;
  const darkBackdrop = relativeLuminance(bg) < 0.4;
  const [h, s, l] = rgbToHsl(rgb);
  // Neutral means little chroma, not little HSL saturation (the light ink itself is a cool grey).
  if (Math.max(...rgb) - Math.min(...rgb) <= 24) {
    const std = darkBackdrop ? INK_LIGHT : INK_DARK;
    if ((contrastRatio(std, backdrop) || 0) >= minContrast) return std;
  }
  const dir = darkBackdrop ? 1 : -1;
  for (let step = 1; step <= 100; step += 1) {
    const nl = Math.max(0, Math.min(1, l + dir * step * 0.01));
    const next = toHex(hslToRgb([h, s, nl]));
    if ((contrastRatio(next, backdrop) || 0) >= minContrast) return next;
    if (nl === 0 || nl === 1) break;
  }
  return darkBackdrop ? INK_LIGHT : INK_DARK;
}

function opaqueFill(el) {
  if (!el || !parseHex(el.backgroundColor)) return false;
  if ((el.opacity == null ? 100 : el.opacity) < 60) return false;
  return (el.fillStyle || 'solid') === 'solid';
}

// Does the earlier element `holder` fully contain `el` (bounding boxes, 1px of slack)?
function boxContains(holder, el) {
  const pad = 1;
  const hx = Math.min(holder.x, holder.x + holder.width);
  const hy = Math.min(holder.y, holder.y + holder.height);
  const hw = Math.abs(holder.width);
  const hh = Math.abs(holder.height);
  const ex = Math.min(el.x, el.x + el.width);
  const ey = Math.min(el.y, el.y + el.height);
  return ex >= hx - pad && ey >= hy - pad
    && ex + Math.abs(el.width) <= hx + hw + pad && ey + Math.abs(el.height) <= hy + hh + pad;
}

// The colour an element's ink sits on, or null when the element needs no adapting.
// `index` is the element's z-order position in `list`; only elements BEFORE it (painted
// under it) can be what it sits on.
function inkBackdrop(el, index, list, byId, canvas) {
  if (el.type === 'text' && el.containerId) {
    const container = byId.get(el.containerId);
    if (container && opaqueFill(container)) return container.backgroundColor;
    return canvas;
  }
  // A shape with its own opaque fill is visible by that fill whatever its border is, so its
  // ink is the user's (or the template's) and is left alone.
  if (el.type !== 'text' && opaqueFill(el)) return null;
  // Ink laid over a filled shape or a pasted image (a template's column title, a pen stroke
  // annotating a screenshot) sits on that, not on the canvas. An image has no colour we can
  // judge, so ink over one is left as the user drew it.
  for (let i = index - 1; i >= 0; i -= 1) {
    const holder = list[i];
    if (!holder || holder.isDeleted || holder.id === el.id) continue;
    const isImage = holder.type === 'image';
    if (!isImage && !(holder.type !== 'text' && opaqueFill(holder))) continue;
    if (!boxContains(holder, el)) continue;
    return isImage ? null : holder.backgroundColor;
  }
  return canvas;
}

function sameColor(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

// Adapt every element's ink to `canvas` (a hex). `ledger` is a Map(id -> { stored, shown }),
// updated in place. Returns { elements, changed }; an untouched element is returned as the
// same object. `bump` (optional) is called on an element whose shown ink changed AFTER the
// scene exists (a canvas change, a merge), where Excalidraw needs a new version to repaint;
// at load the elements are fresh and need none.
function applyBoardInk(elements, canvas, ledger, bump) {
  const list = Array.isArray(elements) ? elements : [];
  const byId = new Map(list.map((el) => [el.id, el]));
  let changed = false;
  const out = list.map((el, index) => {
    if (!el || el.isDeleted || !INK_TYPES.has(el.type) || !parseHex(el.strokeColor)) {
      if (el && ledger.has(el.id) && (el.isDeleted || !INK_TYPES.has(el.type))) ledger.delete(el.id);
      return el;
    }
    const entry = ledger.get(el.id);
    const base = entry && sameColor(entry.shown, el.strokeColor) ? entry.stored : el.strokeColor;
    const min = el.type === 'text' ? TEXT_CONTRAST : SHAPE_CONTRAST;
    // Fast path: ink that already reads on the canvas needs no backdrop search, which keeps
    // a large board linear (the search is only for ink that does NOT read on the canvas).
    const onCanvas = contrastRatio(base, canvas);
    if (onCanvas === null || onCanvas >= min) {
      ledger.delete(el.id);
      if (sameColor(el.strokeColor, base)) return el;
      changed = true;
      return bump ? bump(el, { strokeColor: base }) : { ...el, strokeColor: base };
    }
    const backdrop = inkBackdrop(el, index, list, byId, canvas);
    const shown = backdrop ? readableInk(base, backdrop, min) : base;
    if (sameColor(shown, base)) {
      ledger.delete(el.id);
      if (sameColor(el.strokeColor, base)) return el;
      changed = true;
      return bump ? bump(el, { strokeColor: base }) : { ...el, strokeColor: base };
    }
    ledger.set(el.id, { stored: base, shown });
    if (sameColor(el.strokeColor, shown)) return el;
    changed = true;
    return bump ? bump(el, { strokeColor: shown }) : { ...el, strokeColor: shown };
  });
  return { elements: changed ? out : list, changed };
}

// Text typed into a shape or a sticky is created in the board's DEFAULT ink, which is light
// on a dark canvas, so a note on a light fill reads as pale text on pale paper. Any text
// that is still wearing exactly that default but sits on an opaque fill it cannot be read
// on is set to a readable ink for the fill. This is a real colour change (a new element's
// own colour, not a display adaptation), so it is stored; a colour the user picked is never
// touched. Idempotent: after the fix the text no longer wears the default.
function fixBoundTextInk(elements, bump) {
  const list = Array.isArray(elements) ? elements : [];
  let byId = null;
  let changed = false;
  const out = list.map((el) => {
    if (!el || el.isDeleted || el.type !== 'text' || !sameColor(el.strokeColor, INK_LIGHT)) return el;
    const hostId = el.containerId || (el.customData && el.customData.labelFor);
    if (!hostId) return el;
    if (!byId) byId = new Map(list.map((e) => [e.id, e]));
    const host = byId.get(hostId);
    if (!host || host.isDeleted || !opaqueFill(host)) return el;
    if ((contrastRatio(el.strokeColor, host.backgroundColor) || TEXT_CONTRAST) >= TEXT_CONTRAST) return el;
    const next = readableInk(INK_DARK, host.backgroundColor, TEXT_CONTRAST);
    changed = true;
    return bump ? bump(el, { strokeColor: next }) : { ...el, strokeColor: next };
  });
  return { elements: changed ? out : list, changed };
}

// The save-time inverse: every element still wearing the ink we gave it gets its stored ink
// back. Returns the same array when nothing was adapted.
function restoreStoredInk(elements, ledger) {
  if (!ledger || ledger.size === 0) return elements;
  let changed = false;
  const out = elements.map((el) => {
    const entry = el && ledger.get(el.id);
    if (entry && sameColor(entry.shown, el.strokeColor) && !sameColor(entry.stored, el.strokeColor)) {
      changed = true;
      return { ...el, strokeColor: entry.stored };
    }
    return el;
  });
  return changed ? out : elements;
}

// A whole stored scene as the board shows it (used by the export path, which has no live
// canvas): the canvas colour and the adapted ink, with no ledger kept.
function displayScene(scene) {
  const appState = scene && scene.appState ? scene.appState : {};
  const canvas = canvasForDisplay(appState.viewBackgroundColor);
  const { elements } = applyBoardInk(scene && scene.elements, canvas, new Map());
  return {
    elements,
    appState: { ...appState, viewBackgroundColor: canvas },
  };
}

module.exports = {
  CANVAS_DARK,
  CANVAS_WHITE_PICKED,
  INK_LIGHT,
  INK_DARK,
  TEXT_CONTRAST,
  SHAPE_CONTRAST,
  parseHex,
  contrastRatio,
  isDarkBackdrop,
  isRetiredCanvas,
  canvasForDisplay,
  canvasForStorage,
  readableInk,
  applyBoardInk,
  fixBoundTextInk,
  restoreStoredInk,
  displayScene,
};
