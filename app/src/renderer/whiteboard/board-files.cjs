'use strict';

const SAVE_DELAY_MS = 1200;
// The version-gated flush inside the canvas coalesces a burst of real edits
// before it serializes once; the parent's SAVE_DELAY_MS debounce still owns
// the disk write. This is deliberately shorter than SAVE_DELAY_MS.
const FLUSH_DELAY_MS = 400;
// Miro's small sticky: ~110px square placed at the click (catalog finding 30).
// 180 was the pre-parity size; existing boards keep whatever their elements say.
const STICKY_SIZE = 110;
const DEFAULT_STICKY = 'yellow';
// The S / M / L presets of Miro's "Sticky note size" submenu (finding 32). S IS
// the placement default; corner handles still resize freely on top of these.
const STICKY_SIZES = [
  { key: 'S', px: 110, label: 'Small' },
  { key: 'M', px: 200, label: 'Medium' },
  { key: 'L', px: 300, label: 'Large' },
];

// Miro's own sticky palette, sampled live from a real Miro board (the exact hexes
// from its colour picker: Yellow #ffe86d is Miro's default). Soft pastels, not the
// saturated fills Harbor shipped first; Miro renders near-black text on every one,
// so `text` is a single dark tone rather than a per-colour tint. The note is
// BORDERLESS (flat, like Miro); `stroke` is only the toolbar swatch outline. The
// note is created label-less (double-click to type, the gesture Excalidraw binds
// text with natively).
// Miro's full sticky palette in Miro's own order, sampled live from its colour picker
// (a 2-column grid). Dark text on every light note; white text only on the black note.
const STICKY_TEXT = '#1a1a1a';
const STICKY_COLORS = [
  { key: 'gray', label: 'Gray', bg: '#f3f5f7', text: STICKY_TEXT },
  { key: 'light-yellow', label: 'Light Yellow', bg: '#fff79e', text: STICKY_TEXT },
  { key: 'yellow', label: 'Yellow', bg: '#ffe86d', text: STICKY_TEXT },
  { key: 'orange', label: 'Orange', bg: '#ffb575', text: STICKY_TEXT },
  { key: 'light-green', label: 'Light Green', bg: '#d1f09f', text: STICKY_TEXT },
  { key: 'green', label: 'Green', bg: '#b3e65f', text: STICKY_TEXT },
  { key: 'dark-green', label: 'Dark Green', bg: '#6ae08d', text: STICKY_TEXT },
  { key: 'cyan', label: 'Cyan', bg: '#81e7de', text: STICKY_TEXT },
  { key: 'light-pink', label: 'Light Pink', bg: '#ffd2f2', text: STICKY_TEXT },
  { key: 'pink', label: 'Pink', bg: '#fd9ae7', text: STICKY_TEXT },
  { key: 'violet', label: 'Violet', bg: '#b8acfb', text: STICKY_TEXT },
  { key: 'red', label: 'Red', bg: '#ff9e9e', text: STICKY_TEXT },
  { key: 'light-blue', label: 'Light Blue', bg: '#b2d0fe', text: STICKY_TEXT },
  { key: 'blue', label: 'Blue', bg: '#9ce6ff', text: STICKY_TEXT },
  { key: 'dark-blue', label: 'Dark Blue', bg: '#86b4f9', text: STICKY_TEXT },
  { key: 'black', label: 'Black', bg: '#151515', text: '#ffffff' },
];

function stickyColor(key) {
  return STICKY_COLORS.find((color) => color.key === key) || STICKY_COLORS[0];
}

// A Miro sticky is what Excalidraw can't draw with one element: a flat coloured square
// with a soft DROP SHADOW that lifts it off the board (what makes it read as a real
// sticky and not a coloured rectangle; verified against live Miro). Excalidraw has no
// per-element shadow, so the sticky is TWO elements grouped as one: a low-opacity dark
// square offset down-right (the shadow) behind the coloured face. The shadow carries
// `customData.stickyShadow` so connectors, hover dots, and recolour all skip it and it
// is never a target or independently selectable. Sharp corners (Excalidraw's adaptive
// rounding reads as a button, which Pat rejected). Grouping is assigned at insert time.
const STICKY_SHADOW_COLOR = '#0f172a';
// Legacy single-shadow glue offsets (pre-2026-08-30 stickies on existing boards
// carry no per-shadow dx/dy customData and keep this exact down-right look).
const STICKY_SHADOW_DX = 5;
const STICKY_SHADOW_DY = 7;
// Miro's real shadow (finding 34, sampled pixel by pixel): BOTTOM-ONLY, ~8px of
// soft falloff, peaking ~9% darker than the canvas, no side shadow. Excalidraw
// has no blur, so the falloff is approximated by TWO full-size bands offset
// straight down: the near band stops at 4px (rows 0-4 composite with the far
// band to the ~9% peak), the far band reaches 8px (rows 4-8 are the ~4% tail).
const STICKY_SHADOW_BANDS = [
  { dx: 0, dy: 8, opacity: 4 }, // far tail, drawn first (bottom of the stack)
  { dx: 0, dy: 4, opacity: 5 }, // near peak
];

function stickyNoteSkeleton({ color = DEFAULT_STICKY, x = 0, y = 0, text = '' } = {}) {
  const c = stickyColor(color);
  const rx = Math.round(x);
  const ry = Math.round(y);
  const base = {
    type: 'rectangle',
    width: STICKY_SIZE,
    height: STICKY_SIZE,
    strokeColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    roughness: 0,
    roundness: null,
  };
  // LOCKED, not grouped: grouping the sticky makes Excalidraw demand you enter the group
  // before you can double-click-to-type (verified: it broke the label gesture). A locked
  // shadow is non-interactive, so the FACE stays a normal single element you click,
  // double-click, and connect to; the bands are glued to the face by syncStickyShadows,
  // each by its OWN dx/dy carried in customData.
  const shadows = STICKY_SHADOW_BANDS.map((band) => ({
    ...base,
    x: rx + band.dx,
    y: ry + band.dy,
    backgroundColor: STICKY_SHADOW_COLOR,
    opacity: band.opacity,
    locked: true,
    customData: { stickyShadow: true, dx: band.dx, dy: band.dy },
  }));
  const face = {
    ...base,
    x: rx,
    y: ry,
    backgroundColor: c.bg,
    // The sticky tag: intended size bookkeeping for autosize ("the note NEVER
    // grows", finding 31) and the key the S/M/L + font controls answer to.
    customData: { sticky: { w: STICKY_SIZE, h: STICKY_SIZE } },
  };
  if (text) face.label = { text, fontSize: 20, textAlign: 'center', verticalAlign: 'center', strokeColor: c.text };
  // Shadows first so the coloured face renders on top and is the last element inserted.
  return [...shadows, face];
}

// True for a sticky's shadow element, which every interaction must treat as decoration.
function isStickyShadow(el) {
  return Boolean(el && el.customData && el.customData.stickyShadow);
}

// Keep every sticky shadow glued to its face's position and size. The shadow links to
// its face by `customData.faceId` (set at insert). A shadow whose face is gone (deleted)
// is dropped. Returns { elements, changed } so the caller only writes when something
// actually moved, which is what keeps this from looping when called from onChange.
function syncStickyShadows(elements) {
  const byId = new Map(elements.map((el) => [el.id, el]));
  let changed = false;
  const out = [];
  for (const el of elements) {
    if (!isStickyShadow(el) || el.isDeleted) { out.push(el); continue; }
    const face = el.customData && el.customData.faceId ? byId.get(el.customData.faceId) : null;
    // An orphan is a shadow whose face is GONE or itself marked deleted. onChange hands us
    // the full list INCLUDING the just-deleted face (isDeleted:true), so a missing face is
    // not enough; the deleted face must also count as gone, or the cleanup never fires
    // (that was Pat's grey-ghost bug). The shadow is then MARKED deleted rather than dropped
    // from the array, because Excalidraw's updateScene merges by id and an omitted element
    // simply survives.
    if (!face || face.isDeleted) {
      changed = true;
      out.push({ ...el, isDeleted: true });
      continue;
    }
    // Each band glues by its own offsets; a legacy shadow (no dx/dy customData,
    // pre-band boards) keeps the historical 5/7 down-right glue.
    const dx = typeof el.customData.dx === 'number' ? el.customData.dx : STICKY_SHADOW_DX;
    const dy = typeof el.customData.dy === 'number' ? el.customData.dy : STICKY_SHADOW_DY;
    const wantX = face.x + dx;
    const wantY = face.y + dy;
    if (Math.round(el.x) !== Math.round(wantX) || Math.round(el.y) !== Math.round(wantY)
      || el.width !== face.width || el.height !== face.height || el.angle !== face.angle) {
      changed = true;
      out.push({ ...el, x: wantX, y: wantY, width: face.width, height: face.height, angle: face.angle });
    } else out.push(el);
  }
  return { elements: out, changed };
}

// ---- Sticky autosize: text shrinks, the note NEVER grows (finding 31) ---------------
// Miro's sticky font mode is "Auto": 12 characters render ~28px and a 150-character
// paragraph auto-shrinks to ~9px in the SAME square. Excalidraw does the opposite
// (bound-text overflow GROWS the container), so this pass counteracts it for tagged
// sticky faces: pick the largest font in [MIN..MAX] whose wrapped layout fits the
// intended box, rewrite the label, and put a grown face back to its intended height.
const STICKY_FONT_MAX = 28;
const STICKY_FONT_MIN = 8;
const STICKY_TEXT_PAD = 5; // Excalidraw's own BOUND_TEXT_PADDING
const STICKY_LINE_HEIGHT = 1.25;

// Greedy word wrap at ONE font size using the injected glyph measure; a word wider
// than the line is hard-broken by characters (the way Excalidraw wraps). Always
// answers with the wrapped lines; height is somebody else's question.
function wrapTextToWidth(text, fontSize, maxW, measure) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    const words = paragraph.split(' ');
    for (let word of words) {
      // hard-break any word that can never fit a line on its own
      while (measure(word, fontSize) > maxW && word.length > 1) {
        if (line) { lines.push(line); line = ''; }
        let cut = word.length - 1;
        while (cut > 1 && measure(word.slice(0, cut), fontSize) > maxW) cut -= 1;
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const joined = line ? `${line} ${word}` : word;
      if (line && measure(joined, fontSize) > maxW) { lines.push(line); line = word; } else line = joined;
    }
    lines.push(line);
  }
  return lines;
}

// The sticky fit's view of the same wrap: the lines, or null when they cannot fit
// maxH at this size (which is what makes the binary search in fitStickyFontSize work).
function wrapSticky(text, fontSize, maxW, maxH, lineHeight, measure) {
  const lines = wrapTextToWidth(text, fontSize, maxW, measure);
  const maxLines = Math.max(1, Math.floor(maxH / (fontSize * lineHeight)));
  return lines.length > maxLines ? null : lines;
}

// The largest font size in [minSize..maxSize] whose wrapped layout fits the padded
// box; at the floor the layout is returned even when it overflows (the honest
// alternative to an invisible 0px font). Binary search: fit is monotone in size.
function fitStickyFontSize({
  text, width, height, measure,
  lineHeight = STICKY_LINE_HEIGHT, maxSize = STICKY_FONT_MAX, minSize = STICKY_FONT_MIN, padding = STICKY_TEXT_PAD,
} = {}) {
  const maxW = Math.max(8, width - padding * 2);
  const maxH = Math.max(8, height - padding * 2);
  const attempt = (size) => wrapSticky(text, size, maxW, maxH, lineHeight, measure);
  let lo = minSize;
  let hi = maxSize;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const lines = attempt(mid);
    if (lines) { best = { fontSize: mid, lines }; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best) {
    // nothing fits even at the floor: wrap at the floor width-wise and let it overflow down
    const lines = wrapSticky(text, minSize, maxW, Number.POSITIVE_INFINITY, lineHeight, measure) || [String(text)];
    best = { fontSize: minSize, lines };
  }
  const textWidth = best.lines.reduce((w, line) => Math.max(w, measure(line, best.fontSize)), 0);
  return { ...best, textWidth, textHeight: best.lines.length * best.fontSize * lineHeight };
}

// Faces that are stickies: tagged with customData.sticky (new), or named by a
// shadow's faceId (legacy boards, which the fit pass deliberately leaves alone).
function stickyFaceIds(elements) {
  const tagged = new Set();
  const legacy = new Set();
  for (const el of elements) {
    if (el.isDeleted) continue;
    if (el.customData && el.customData.sticky) tagged.add(el.id);
    else if (isStickyShadow(el) && el.customData.faceId) legacy.add(el.customData.faceId);
  }
  for (const id of tagged) legacy.delete(id);
  return { tagged, legacy };
}

// The maintenance pass behind Miro's Auto font mode, run beside syncStickyShadows
// from onChange (rAF-deferred, idempotent so it can never loop):
// - a TAGGED face whose width changed was corner-resized by the user: adopt the new
//   size as the intent (no snap-back);
// - a tagged face with a bound label in Auto mode: fit the font, rewrite the wrapped
//   label centred in the intended box, and RESTORE a height Excalidraw grew;
// - a pinned face (sticky.font) forces that font and lets Excalidraw manage height;
// - LEGACY faces (shadow-linked, untagged) are never touched: an old board's text
//   must not reflow the day this ships.
function fitStickyLabels(elements, measure) {
  const { tagged } = stickyFaceIds(elements);
  if (!tagged.size) return { elements, changed: false };
  const byId = new Map(elements.map((el) => [el.id, el]));
  const patched = new Map();
  for (const faceId of tagged) {
    const face = byId.get(faceId);
    if (!face || face.isDeleted) continue;
    const intent = { ...face.customData.sticky };
    const label = (face.boundElements || [])
      .filter((b) => b.type === 'text')
      .map((b) => byId.get(b.id))
      .find((el) => el && !el.isDeleted && el.containerId === faceId) || null;
    let nextFace = face;
    if (face.width !== intent.w) {
      // width only moves on a user resize (Excalidraw's text growth is vertical), so
      // the whole current size becomes the new intent.
      intent.w = face.width;
      intent.h = face.height;
      nextFace = { ...face, customData: { ...face.customData, sticky: intent } };
    } else if (face.height !== intent.h && !label && !intent.font) {
      // no label to have grown it: a deliberate vertical resize, adopt it
      intent.h = face.height;
      nextFace = { ...face, customData: { ...face.customData, sticky: intent } };
    }
    if (label) {
      if (intent.font) {
        // pinned numeric size: force it, let Excalidraw own the height
        if (label.fontSize !== intent.font) patched.set(label.id, { ...label, fontSize: intent.font });
      } else {
        const fit = fitStickyFontSize({
          text: label.originalText != null ? label.originalText : label.text,
          width: intent.w,
          height: intent.h,
          lineHeight: label.lineHeight || STICKY_LINE_HEIGHT,
          measure,
        });
        if (nextFace.height !== intent.h) nextFace = { ...nextFace, height: intent.h };
        const wrapped = fit.lines.join('\n');
        const wantX = nextFace.x + (intent.w - fit.textWidth) / 2;
        const wantY = nextFace.y + (intent.h - fit.textHeight) / 2;
        if (label.fontSize !== fit.fontSize || label.text !== wrapped
          || Math.abs(label.width - fit.textWidth) > 0.5 || Math.abs(label.height - fit.textHeight) > 0.5
          || Math.abs(label.x - wantX) > 0.5 || Math.abs(label.y - wantY) > 0.5) {
          patched.set(label.id, {
            ...label,
            fontSize: fit.fontSize,
            text: wrapped,
            width: fit.textWidth,
            height: fit.textHeight,
            x: wantX,
            y: wantY,
          });
        }
      }
    }
    if (nextFace !== face) patched.set(faceId, nextFace);
  }
  if (!patched.size) return { elements, changed: false };
  return { elements: elements.map((el) => patched.get(el.id) || el), changed: true };
}

// The id of the ONE selected sticky face, or null: the S/M/L + font segment of the
// style bar answers only to a lone sticky (tagged, or legacy shadow-linked).
function selectionStickyFace(elements, ids) {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  const { tagged, legacy } = stickyFaceIds(elements);
  let found = null;
  for (const el of elements) {
    if (!idSet.has(el.id) || el.isDeleted || isStickyShadow(el)) continue;
    if (el.type === 'text' && el.containerId) continue; // a selected bound label rides its face
    if (found) return null; // more than one real element selected
    found = (tagged.has(el.id) || legacy.has(el.id)) ? el.id : 'not-a-sticky';
  }
  return found && found !== 'not-a-sticky' ? found : null;
}

// ---- Wheel zoom at the cursor (Miro Mouse mode, finding 69) -------------------------
const ZOOM_MIN = 0.1; // Excalidraw's own limits
const ZOOM_MAX = 30;
// One Miro wheel notch (240 delta) took 100% to 112%, measured live.
const WHEEL_ZOOM_PER_DELTA = Math.log(1.12) / 240;

// Zoom to nextZoom keeping the scene point under (clientX, clientY) fixed. The
// transform is client = (scene + scroll) * zoom + offset, so holding the anchor
// means scroll' = (client - offset) / zoom' - scene.
function zoomAtPoint(app, nextZoom, clientX, clientY) {
  const zoom = (app.zoom && app.zoom.value) || 1;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));
  const px = clientX - (app.offsetLeft || 0);
  const py = clientY - (app.offsetTop || 0);
  const sceneX = px / zoom - (app.scrollX || 0);
  const sceneY = py / zoom - (app.scrollY || 0);
  return { zoom: clamped, scrollX: px / clamped - sceneX, scrollY: py / clamped - sceneY };
}

function wheelZoomPlan(app, clientX, clientY, deltaY) {
  const zoom = (app.zoom && app.zoom.value) || 1;
  return zoomAtPoint(app, zoom * Math.exp(-deltaY * WHEEL_ZOOM_PER_DELTA), clientX, clientY);
}

// ---- Minimap (finding 71): solid boxes, a dark viewport rect, click to jump --------
const MINIMAP_W = 220;
const MINIMAP_H = 140;
const MINIMAP_PAD = 8;

// Map the world (union of element bounds and the current viewport) into the card.
// The viewport is part of the world on purpose: the view rect must always be inside
// the card, even when the user has panned far away from every element.
function minimapPlan(elements, app) {
  const zoom = (app.zoom && app.zoom.value) || 1;
  const view = { x: -(app.scrollX || 0), y: -(app.scrollY || 0), w: (app.width || 0) / zoom, h: (app.height || 0) / zoom };
  let minX = view.x;
  let minY = view.y;
  let maxX = view.x + view.w;
  let maxY = view.y + view.h;
  const rects = [];
  for (const el of elements) {
    if (el.isDeleted || isStickyShadow(el)) continue;
    if (!(el.width > 0) || !(el.height > 0)) continue;
    rects.push({ x: el.x, y: el.y, w: el.width, h: el.height });
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.width);
    maxY = Math.max(maxY, el.y + el.height);
  }
  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);
  const scale = Math.min((MINIMAP_W - MINIMAP_PAD * 2) / worldW, (MINIMAP_H - MINIMAP_PAD * 2) / worldH);
  const ox = MINIMAP_PAD + ((MINIMAP_W - MINIMAP_PAD * 2) - worldW * scale) / 2;
  const oy = MINIMAP_PAD + ((MINIMAP_H - MINIMAP_PAD * 2) - worldH * scale) / 2;
  const toMap = (r) => ({ x: ox + (r.x - minX) * scale, y: oy + (r.y - minY) * scale, w: r.w * scale, h: r.h * scale });
  return { scale, minX, minY, ox, oy, boxes: rects.map(toMap), view: toMap(view) };
}

// A click at (mapX, mapY) centres the viewport on that scene point.
function minimapJump(plan, mapX, mapY, app) {
  const zoom = (app.zoom && app.zoom.value) || 1;
  const sceneX = plan.minX + (mapX - plan.ox) / plan.scale;
  const sceneY = plan.minY + (mapY - plan.oy) / plan.scale;
  return { scrollX: (app.width || 0) / (2 * zoom) - sceneX, scrollY: (app.height || 0) / (2 * zoom) - sceneY };
}

// ---- Z-order (catalog finding 57 / section 6): PgUp family ---------------------------
// Reorder the selection through the stack. A sticky face travels with its shadow
// bands and a container with its bound text, so a raised sticky can never leave its
// shadow (or its label) stranded at the old depth. Moved elements get index:null so
// Excalidraw's own fractional-index sync reassigns them by array position. Answers
// null when the move is a no-op so the caller skips the scene update entirely.
function reorderElements(elements, ids, op) {
  const idSet = ids instanceof Set ? new Set(ids) : new Set(ids);
  for (const el of elements) {
    if (!idSet.has(el.id)) continue;
    for (const bound of el.boundElements || []) { if (bound.type === 'text') idSet.add(bound.id); }
  }
  for (const el of elements) {
    if (isStickyShadow(el) && el.customData.faceId && idSet.has(el.customData.faceId)) idSet.add(el.id);
  }
  const moved = [];
  const rest = [];
  let lastMovedAt = -1;
  let firstMovedAt = -1;
  elements.forEach((el, at) => {
    if (idSet.has(el.id)) {
      moved.push({ ...el, index: null });
      lastMovedAt = at;
      if (firstMovedAt === -1) firstMovedAt = at;
    } else rest.push(el);
  });
  if (!moved.length || moved.length === elements.length) return null;
  if (op === 'front') {
    if (lastMovedAt === elements.length - 1 && firstMovedAt === elements.length - moved.length) return null;
    return [...rest, ...moved];
  }
  if (op === 'back') {
    if (firstMovedAt === 0 && lastMovedAt === moved.length - 1) return null;
    return [...moved, ...rest];
  }
  // one step: past the nearest non-moved neighbour above (forward) or below (backward)
  const restIndexOf = (el) => elements.indexOf(el);
  if (op === 'forward') {
    const neighbourAt = rest.findIndex((el) => restIndexOf(el) > lastMovedAt);
    if (neighbourAt === -1) return null; // already on top
    return [...rest.slice(0, neighbourAt + 1), ...moved, ...rest.slice(neighbourAt + 1)];
  }
  if (op === 'backward') {
    let neighbourAt = -1;
    rest.forEach((el, at) => { if (restIndexOf(el) < firstMovedAt) neighbourAt = at; });
    if (neighbourAt === -1) return null; // already at the bottom
    return [...rest.slice(0, neighbourAt), ...moved, ...rest.slice(neighbourAt)];
  }
  return null;
}

// ---- Dot grid (finding 72): a CSS dot layer glued to the scene ----------------------
// Excalidraw couples grid DRAWING and grid snap on one flag and only draws lines, so
// the dot style renders as our own layer under a transparent canvas. This is the pure
// style math: dots sit on scene-grid multiples, so the pattern pans and zooms with
// the board. Scene (0,0) lands at client (scroll * zoom), hence the modular offset.
function dotGridStyle({ gridSize = 20, zoom = 1, scrollX = 0, scrollY = 0, color = 'rgba(90, 100, 118, 0.38)' } = {}) {
  const size = gridSize * zoom;
  // Zoomed far out the cells collapse and a full dot field reads as noise; both
  // Miro and Excalidraw's line grid fade the minor grid below ~10px cells
  // (screenshot-caught at the drive's 40% fit view), so the dots do the same.
  if (size < 10) {
    return { backgroundImage: 'none', backgroundSize: `${size}px ${size}px`, backgroundPosition: '0px 0px' };
  }
  const mod = (v) => ((v % size) + size) % size;
  const dot = Math.max(1, Math.min(2, zoom * 1.2));
  return {
    backgroundImage: `radial-gradient(circle, ${color} ${dot}px, transparent ${dot + 0.5}px)`,
    backgroundSize: `${size}px ${size}px`,
    backgroundPosition: `${mod((scrollX || 0) * zoom)}px ${mod((scrollY || 0) * zoom)}px`,
  };
}

const LABEL = '#212529';
const CONNECTOR = '#868e96';

// The rich Miro-style palette the contextual style bar offers for a selection,
// far past Excalidraw's five baked-in quick picks (whose panel palette has no
// public prop to override). `transparent` is the no-fill option.
const STYLE_COLORS = [
  { key: 'transparent', hex: 'transparent', label: 'No fill' },
  { key: 'white', hex: '#ffffff', label: 'White' },
  { key: 'black', hex: '#1e1e1e', label: 'Black' },
  { key: 'red', hex: '#ff8787', label: 'Red' },
  { key: 'pink', hex: '#f06595', label: 'Pink' },
  { key: 'grape', hex: '#cc5de8', label: 'Purple' },
  { key: 'violet', hex: '#7950f2', label: 'Violet' },
  { key: 'indigo', hex: '#4c6ef5', label: 'Indigo' },
  { key: 'blue', hex: '#4dabf7', label: 'Blue' },
  { key: 'cyan', hex: '#22b8cf', label: 'Cyan' },
  { key: 'teal', hex: '#20c997', label: 'Teal' },
  { key: 'green', hex: '#40c057', label: 'Green' },
  { key: 'lime', hex: '#82c91e', label: 'Lime' },
  { key: 'yellow', hex: '#ffd43b', label: 'Yellow' },
  { key: 'orange', hex: '#ff922b', label: 'Orange' },
];

const STROKE_WIDTHS = [
  { key: 'thin', value: 1, label: 'Thin' },
  { key: 'medium', value: 2, label: 'Medium' },
  { key: 'bold', value: 4, label: 'Bold' },
];

// ---- The Brand / All palette (catalog finding 26) ------------------------------------
// Miro's colour popover is TWO labelled sections, brand first then the standard named
// set, round swatches four to a row, with the custom-colour tail at the very bottom.
// Both lists below are the exact hexes and names sampled off Pat's own Miro org, so a
// colour picked here matches a colour picked there. STYLE_COLORS above stays the compact
// quick-pick row the connector and pre-draw bars use; this is the full popover palette.
const BRAND_COLORS = [
  { key: 'brand-primary', hex: '#0a3255', label: 'Primary' },
  { key: 'brand-blue', hex: '#5596e1', label: 'Blue' },
  { key: 'brand-light-blue', hex: '#aad7f5', label: 'Light Blue' },
  { key: 'brand-green', hex: '#00b464', label: 'Green' },
  { key: 'brand-light-gray', hex: '#bec8d7', label: 'Light Gray' },
  { key: 'brand-orange', hex: '#f05541', label: 'Orange' },
  { key: 'brand-navy', hex: '#465f82', label: 'Navy' },
  { key: 'brand-white', hex: '#ffffff', label: 'White' },
  { key: 'brand-nocturne', hex: '#04070f', label: 'Nocturne' },
  { key: 'brand-luminous', hex: '#437ffe', label: 'Luminous' },
  { key: 'brand-sky', hex: '#79a6ff', label: 'Sky' },
  { key: 'brand-gold-leaf', hex: '#d4a537', label: 'Gold Leaf' },
  { key: 'brand-chalk', hex: '#f6f7ff', label: 'Chalk' },
  { key: 'brand-slate', hex: '#8a93a8', label: 'Slate' },
  { key: 'brand-amethyst', hex: '#8b5cff', label: 'Amethyst' },
  { key: 'brand-emerald', hex: '#24b27c', label: 'Emerald' },
  { key: 'brand-lapis', hex: '#1e387f', label: 'Lapis' },
  { key: 'brand-ink', hex: '#0a1024', label: 'Ink' },
];

const ALL_COLORS = [
  { key: 'all-light-yellow', hex: '#fff6b6', label: 'Light Yellow' },
  { key: 'all-yellow', hex: '#ffdc4a', label: 'Yellow' },
  { key: 'all-dark-yellow', hex: '#af7e04', label: 'Dark Yellow' },
  { key: 'all-white', hex: '#ffffff', label: 'White' },
  { key: 'all-light-orange', hex: '#f8d3af', label: 'Light Orange' },
  { key: 'all-orange', hex: '#fe9f4d', label: 'Orange' },
  { key: 'all-dark-orange', hex: '#9b4a08', label: 'Dark Orange' },
  { key: 'all-light-gray', hex: '#e7e7e7', label: 'Light Gray' },
  { key: 'all-light-red', hex: '#ffc6c6', label: 'Light Red' },
  { key: 'all-red', hex: '#ff6464', label: 'Red' },
  { key: 'all-magenta', hex: '#bd0a0a', label: 'Magenta' },
  { key: 'all-gray', hex: '#b0b0b0', label: 'Gray' },
  { key: 'all-light-green', hex: '#adf0c7', label: 'Light Green' },
  { key: 'all-green', hex: '#2dc75c', label: 'Green' },
  { key: 'all-dark-green', hex: '#067429', label: 'Dark Green' },
  { key: 'all-dark-gray', hex: '#595959', label: 'Dark Gray' },
  { key: 'all-cyan', hex: '#c6dcff', label: 'Cyan' },
  { key: 'all-blue', hex: '#659df2', label: 'Blue' },
  { key: 'all-dark-blue', hex: '#305bab', label: 'Dark Blue' },
  { key: 'all-black', hex: '#1a1a1a', label: 'Black' },
  { key: 'all-light-violet', hex: '#dedaff', label: 'Light Violet' },
  { key: 'all-violet', hex: '#8f7fee', label: 'Violet' },
  { key: 'all-dark-violet', hex: '#6631d7', label: 'Dark Violet' },
];

const PALETTE_SECTIONS = [
  { key: 'brand', label: 'Brand colors', colors: BRAND_COLORS },
  { key: 'all', label: 'All colors', colors: ALL_COLORS },
];

// ---- Custom colour: any hex, an eyedropper's sampled pixel, and a reuse list --------
// The fixed palettes above are the quick picks; these back the "＋ custom" popover so a
// user can set ANY colour for a shape fill, a line/pen/text stroke, or a connector, and
// reuse a sampled or hand-entered colour. All three are pure so they unit-test without a DOM.

// The most custom colours remembered for reuse (the popover's recent row). Oldest drops off.
const RECENT_COLORS_MAX = 12;

// Normalize a hex string to lowercase `#rrggbb`, expanding a 3-digit shorthand, tolerant of a
// missing `#` and surrounding whitespace. Returns null for anything that is not a 3/6-digit hex
// (named colours, `transparent`, 4/8-digit alpha forms), so callers can reject bad input cleanly.
function normalizeHex(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(raw)) return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
  return null;
}

// Convert a sampled RGBA pixel (a 3- or 4-length array, e.g. a getImageData slice) to `#rrggbb`.
// A fully transparent pixel (alpha 0) means nothing was under the cursor, so it returns null.
function rgbaToHex(rgba) {
  if (!rgba || rgba.length < 3) return null;
  if (rgba.length >= 4 && rgba[3] === 0) return null;
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
  const two = (n) => clamp(n).toString(16).padStart(2, '0');
  return `#${two(rgba[0])}${two(rgba[1])}${two(rgba[2])}`;
}

// Push a colour to the front of the reuse list: normalized, deduped (a 3-digit and its 6-digit
// form are one colour), capped at max with the oldest dropped. Invalid input leaves the list
// unchanged, so the caller never has to pre-validate a hand-typed or sampled value.
function addRecentColor(list, hex, max = RECENT_COLORS_MAX) {
  const norm = normalizeHex(hex);
  if (!norm) return Array.isArray(list) ? list : [];
  const rest = (Array.isArray(list) ? list : []).filter((c) => normalizeHex(c) !== norm);
  return [norm, ...rest].slice(0, max);
}

// ---- Shapes palette (Miro parity: far more than Excalidraw's 3) ----------------
// Two kinds. NATIVE shapes are Excalidraw's own container tools (rectangle, rounded
// rectangle, ellipse, diamond): they drag-to-draw and support double-click bound text.
// POLY shapes are closed filled `line` elements built from normalized points (verified
// to render filled in 0.18.1); they drag-to-draw via the canvas's own draw handler.
const SHAPE_FILL = '#a5d8ff';
const SHAPE_STROKE = '#1e1e1e';

// A regular n-gon inscribed in the unit box, first vertex at startDeg (clockwise, y-down).
function regularPolygon(sides, startDeg) {
  const pts = [];
  for (let i = 0; i < sides; i += 1) {
    const a = ((startDeg + (i * 360) / sides) * Math.PI) / 180;
    pts.push([Number((0.5 + 0.5 * Math.cos(a)).toFixed(4)), Number((0.5 + 0.5 * Math.sin(a)).toFixed(4))]);
  }
  return pts;
}

// A 5-point star: 10 vertices alternating outer (0.5) and inner (0.5 * ratio) radius.
function starPolygon(points = 5, ratio = 0.42, startDeg = -90) {
  const pts = [];
  for (let i = 0; i < points * 2; i += 1) {
    const a = ((startDeg + (i * 360) / (points * 2)) * Math.PI) / 180;
    const r = i % 2 === 0 ? 0.5 : 0.5 * ratio;
    pts.push([Number((0.5 + r * Math.cos(a)).toFixed(4)), Number((0.5 + r * Math.sin(a)).toFixed(4))]);
  }
  return pts;
}

// ---- Curved outlines as polygons (Wave D, catalog finding 36) -----------------------
// Miro's basic set carries shapes whose outline is CURVED (cloud, cylinder, the D-shape,
// the flowchart terminator and document). Excalidraw's `line` draws straight segments
// between its points, so a curve is expressed the way the octagon already expresses a
// circle: SAMPLED. These three helpers author in any convenient coordinate space and
// `unitPolygon` rescales the result into the [0,1] box every SHAPE_DEFS entry speaks in,
// so nothing here needs hand-tuned coordinates that happen to land on 0 and 1.

// Points along an ellipse arc, y DOWN (screen space): 0deg is right, 90deg is bottom,
// 180deg left, 270deg top. Inclusive of both endpoints.
function arcPoints(cx, cy, rx, ry, fromDeg, toDeg, steps = 12) {
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

// A quadratic bow from a to b, bulged by `bulge` times the segment length along the
// left-hand normal (y down). Excludes `a` so segments chain without duplicating a vertex.
function bowSegment(a, b, bulge, steps = 8) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const mx = (a[0] + b[0]) / 2 + dy * bulge;
  const my = (a[1] + b[1]) / 2 - dx * bulge;
  const out = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * mx + t * t * b[0], u * u * a[1] + 2 * u * t * my + t * t * b[1]]);
  }
  return out;
}

// Rescale an authored outline into the unit box, so every SHAPE_DEFS entry is
// comparable and shapeSkeleton's `point * size` scaling holds for all of them.
function unitPolygon(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1;
  const spanY = Math.max(...ys) - minY || 1;
  return points.map(([x, y]) => [
    Number(((x - minX) / spanX).toFixed(4)),
    Number(((y - minY) / spanY).toFixed(4)),
  ]);
}

// A cloud: a flat bottom and five bulged lobes over the top, walked clockwise. The bulge
// is 0.9 because a quadratic's apex is HALF its control offset, so a semicircular lobe
// needs ~1.0; the first pass used 0.34 and drew a hill instead of a cloud (screenshot-caught).
const CLOUD_BULGE = 0.9;

function cloudPolygon() {
  const spine = [[0.06, 0.78], [0.14, 0.52], [0.38, 0.34], [0.64, 0.32], [0.88, 0.50], [0.96, 0.74], [0.96, 0.86], [0.06, 0.86]];
  const out = [spine[0]];
  for (let i = 0; i < spine.length - 1; i += 1) {
    const bulged = i < 5; // the top run scallops; the right drop and the bottom stay straight
    out.push(...(bulged ? bowSegment(spine[i], spine[i + 1], CLOUD_BULGE, 9) : [spine[i + 1]]));
  }
  return unitPolygon(out);
}

// A cylinder (the database glyph). The silhouette alone reads as a rounded rectangle, so
// the FRONT arc of the top ellipse is drawn as a zero-area spur: the outline walks out
// along it and straight back, which strokes the arc while contributing no fill area.
// Excalidraw draws one path per `line`, so a spur is the only way to put a line INSIDE a
// filled poly; `cylinder`, `split-rect` and `flow-document`'s twin all use it.
function cylinderPolygon(ry = 0.16) {
  const front = arcPoints(0.5, ry, 0.5, ry, 180, 0, 12); // bulges DOWN through 90deg
  const back = arcPoints(0.5, ry, 0.5, ry, 180, 360, 12); // over the top
  const bottom = arcPoints(0.5, 1 - ry, 0.5, ry, 0, 180, 12);
  return unitPolygon([
    ...front,
    ...front.slice(0, -1).reverse(), // straight back along the same arc: the spur
    ...back.slice(1),
    ...bottom,
  ]);
}

// A rectangle with one horizontal divider, again as a spur off the left edge.
function splitRectPolygon(at = 0.34) {
  return [[0, 0], [1, 0], [1, 1], [0, 1], [0, at], [1, at], [0, at]];
}

// A rectangle with one semicircular right end (Miro's D-shape; the flowchart delay is
// the same outline with a longer straight run). `flat` is where the straight top edge
// ends, so the arc's radius shrinks as the flat grows and the box still fills [0,1].
// NOT run through unitPolygon: rescaling would stretch the arc back out to a full D and
// erase the very difference between the D-shape and the delay.
function dShapePolygon(flat = 0) {
  const rx = (1 - flat) / 2;
  const cx = flat + rx;
  return [
    [0, 0],
    ...arcPoints(cx, 0.5, rx, 0.5, -90, 90, 12).map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]),
    [0, 1],
  ];
}

// A stadium / terminator: both ends semicircular.
function stadiumPolygon() {
  return unitPolygon([
    ...arcPoints(0.75, 0.5, 0.25, 0.5, -90, 90, 10),
    ...arcPoints(0.25, 0.5, 0.25, 0.5, 90, 270, 10),
  ]);
}

// The flowchart document: a rectangle whose bottom edge is one S-wave.
function documentPolygon() {
  return unitPolygon([
    [0, 0], [1, 0], [1, 0.82],
    ...bowSegment([1, 0.82], [0.5, 0.82], -0.22, 6),
    ...bowSegment([0.5, 0.82], [0, 0.82], 0.22, 6),
  ]);
}

// Miro's shape panel is SECTIONED (finding 36: Basic Shapes, Flowchart, Callouts), and
// the flyout renders one block per group in this order.
const SHAPE_GROUPS = [
  { key: 'basic', label: 'Basic shapes' },
  { key: 'flowchart', label: 'Flowchart' },
];

// The catalog's Basic Shapes list (finding 36), matched glyph for glyph where Excalidraw
// can genuinely draw it, plus the two Harbor already had that Miro does not (right
// triangle, chevron). ONE Miro basic glyph is deliberately absent: `braces` ({ }) is two
// DISJOINT stroked curls, and a `line` element is a single closed path whose fill would
// paint the inside of each curl, so it can only be faked. It is skipped, not faked.
// The Flowchart group is the standard ANSI symbols that are honestly one closed outline;
// it is NOT a claim of parity with Miro's 32 (the catalog never enumerates those 32, so
// there is nothing to match against). Symbols needing interior detail that is not a
// single spur (predefined process, internal storage, the OR/summing junctions) are absent
// for the same reason as braces.
const SHAPE_DEFS = [
  { key: 'rectangle', label: 'Rectangle  R', group: 'basic', kind: 'native', tool: 'rectangle', rounded: false },
  { key: 'rounded', label: 'Rounded rectangle', group: 'basic', kind: 'native', tool: 'rectangle', rounded: true },
  { key: 'ellipse', label: 'Ellipse  O', group: 'basic', kind: 'native', tool: 'ellipse' },
  { key: 'diamond', label: 'Diamond  D', group: 'basic', kind: 'native', tool: 'diamond' },
  { key: 'triangle', label: 'Triangle', group: 'basic', kind: 'poly', points: [[0.5, 0], [1, 1], [0, 1]] },
  { key: 'right-triangle', label: 'Right triangle', group: 'basic', kind: 'poly', points: [[0, 0], [0, 1], [1, 1]] },
  { key: 'pentagon', label: 'Pentagon', group: 'basic', kind: 'poly', points: regularPolygon(5, -90) },
  { key: 'hexagon', label: 'Hexagon', group: 'basic', kind: 'poly', points: regularPolygon(6, 0) },
  { key: 'octagon', label: 'Octagon', group: 'basic', kind: 'poly', points: regularPolygon(8, 22.5) },
  { key: 'star', label: 'Star', group: 'basic', kind: 'poly', points: starPolygon() },
  { key: 'parallelogram', label: 'Parallelogram', group: 'basic', kind: 'poly', points: [[0.25, 0], [1, 0], [0.75, 1], [0, 1]] },
  { key: 'trapezoid', label: 'Trapezoid', group: 'basic', kind: 'poly', points: [[0.2, 0], [0.8, 0], [1, 1], [0, 1]] },
  { key: 'arrow-block', label: 'Arrow right', group: 'basic', kind: 'poly', points: [[0, 0.3], [0.6, 0.3], [0.6, 0.05], [1, 0.5], [0.6, 0.95], [0.6, 0.7], [0, 0.7]] },
  { key: 'arrow-left', label: 'Arrow left', group: 'basic', kind: 'poly', points: [[1, 0.3], [0.4, 0.3], [0.4, 0.05], [0, 0.5], [0.4, 0.95], [0.4, 0.7], [1, 0.7]] },
  { key: 'arrow-both', label: 'Arrow both ways', group: 'basic', kind: 'poly', points: [[0, 0.5], [0.24, 0.05], [0.24, 0.3], [0.76, 0.3], [0.76, 0.05], [1, 0.5], [0.76, 0.95], [0.76, 0.7], [0.24, 0.7], [0.24, 0.95]] },
  { key: 'chevron', label: 'Chevron', group: 'basic', kind: 'poly', points: [[0, 0], [0.6, 0], [1, 0.5], [0.6, 1], [0, 1], [0.4, 0.5]] },
  { key: 'cross', label: 'Cross', group: 'basic', kind: 'poly', points: [[0.35, 0], [0.65, 0], [0.65, 0.35], [1, 0.35], [1, 0.65], [0.65, 0.65], [0.65, 1], [0.35, 1], [0.35, 0.65], [0, 0.65], [0, 0.35], [0.35, 0.35]] },
  { key: 'speech', label: 'Speech bubble', group: 'basic', kind: 'poly', points: [[0, 0], [1, 0], [1, 0.72], [0.36, 0.72], [0.18, 1], [0.24, 0.72], [0, 0.72]] },
  { key: 'flag', label: 'Flag', group: 'basic', kind: 'poly', points: [[0, 0], [1, 0], [0.8, 0.5], [1, 1], [0, 1]] },
  { key: 'd-shape', label: 'D-shape', group: 'basic', kind: 'poly', points: dShapePolygon(0) },
  { key: 'cloud', label: 'Cloud', group: 'basic', kind: 'poly', points: cloudPolygon() },
  { key: 'cylinder', label: 'Cylinder', group: 'basic', kind: 'poly', points: cylinderPolygon() },
  { key: 'split-rect', label: 'Split rectangle', group: 'basic', kind: 'poly', points: splitRectPolygon() },
  { key: 'flow-terminator', label: 'Terminator', group: 'flowchart', kind: 'poly', points: stadiumPolygon() },
  { key: 'flow-document', label: 'Document', group: 'flowchart', kind: 'poly', points: documentPolygon() },
  { key: 'flow-manual-input', label: 'Manual input', group: 'flowchart', kind: 'poly', points: [[0, 0.2], [1, 0], [1, 1], [0, 1]] },
  { key: 'flow-manual-operation', label: 'Manual operation', group: 'flowchart', kind: 'poly', points: [[0, 0], [1, 0], [0.82, 1], [0.18, 1]] },
  { key: 'flow-preparation', label: 'Preparation', group: 'flowchart', kind: 'poly', points: [[0.16, 0], [0.84, 0], [1, 0.5], [0.84, 1], [0.16, 1], [0, 0.5]] },
  { key: 'flow-off-page', label: 'Off-page connector', group: 'flowchart', kind: 'poly', points: [[0, 0], [1, 0], [1, 0.66], [0.5, 1], [0, 0.66]] },
  { key: 'flow-display', label: 'Display', group: 'flowchart', kind: 'poly', points: unitPolygon([[0.14, 0], [0.78, 0], ...bowSegment([0.78, 0], [0.78, 1], 0.34, 8), [0.14, 1], [0, 0.5]]) },
  { key: 'flow-delay', label: 'Delay', group: 'flowchart', kind: 'poly', points: dShapePolygon(0.5) },
  { key: 'flow-merge', label: 'Merge', group: 'flowchart', kind: 'poly', points: [[0, 0], [1, 0], [0.5, 1]] },
  { key: 'flow-card', label: 'Card', group: 'flowchart', kind: 'poly', points: [[0.22, 0], [1, 0], [1, 1], [0, 1], [0, 0.22]] },
  { key: 'flow-stored-data', label: 'Stored data', group: 'flowchart', kind: 'poly', points: unitPolygon([[1, 0], [1, 1], [0.16, 1], ...bowSegment([0.16, 1], [0.16, 0], 0.24, 8)]) },
];

function shapeDef(key) {
  return SHAPE_DEFS.find((def) => def.key === key) || null;
}

// Build a POLY shape as a closed, filled `line` skeleton scaled to (w, h) at (x, y).
// The points close the loop (first vertex repeated) so the fill is unambiguous. Returns
// a one-element array for insertSkeleton; native shapes return [] (drawn by their tool).
function shapeSkeleton(key, x, y, w, h, { fill = SHAPE_FILL, stroke = SHAPE_STROKE, strokeWidth = 2 } = {}) {
  const def = shapeDef(key);
  if (!def || def.kind !== 'poly') return [];
  const width = Math.max(4, Math.round(w));
  const height = Math.max(4, Math.round(h));
  const loop = [...def.points, def.points[0]];
  return [{
    type: 'line',
    x: Math.round(x),
    y: Math.round(y),
    width,
    height,
    points: loop.map(([px, py]) => [Number((px * width).toFixed(2)), Number((py * height).toFixed(2))]),
    backgroundColor: fill,
    fillStyle: 'solid',
    strokeColor: stroke,
    strokeWidth,
    roughness: 0,
    roundness: null,
    // Marks this `line` as a drawn polygon SHAPE, not a connector: the style bar and the
    // connector detection key off this so a triangle offers fill/colour, not routing/arrowheads.
    customData: { polyShape: key },
  }];
}

// True for a `line` element that is actually a drawn polygon shape (triangle, star, etc.).
function isPolyShape(el) {
  return Boolean(el && el.customData && el.customData.polyShape);
}

// ---- Tables (Miro parity: Excalidraw has no table element) ---------------------
// A table is a GRID of rectangle cells, each tagged `customData.table = { id, r, c }`.
// Cells are ordinary rectangles (NOT grouped), so double-click-to-type edits a cell the
// same gesture as any shape (grouping would force "enter the group first", the sticky
// lesson). The whole table shares one string id, so add/remove row/column find their
// siblings by that id and never by element id (which convertToExcalidrawElements
// regenerates). Row 0 is a tinted header. Adjacent 1px borders overlap to read as one grid line.
const TABLE_CELL_W = 150;
const TABLE_CELL_H = 44;
const TABLE_HEADER_BG = '#f1f3f5';
const TABLE_CELL_BG = '#ffffff';
const TABLE_BORDER = '#ced4da';

function tableCellSkeleton(tid, r, c, x, y, w, h) {
  return {
    type: 'rectangle',
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(w),
    height: Math.round(h),
    backgroundColor: r === 0 ? TABLE_HEADER_BG : TABLE_CELL_BG,
    strokeColor: TABLE_BORDER,
    fillStyle: 'solid',
    strokeWidth: 1,
    roughness: 0,
    roundness: null,
    customData: { table: { id: tid, r, c } },
  };
}

// Build a rows x cols table anchored at (x, y). Returns cell skeletons for insertSkeleton
// (which runs convertToExcalidrawElements, preserving customData and minting fresh ids).
function tableSkeleton(tid, rows, cols, x, y, { cellW = TABLE_CELL_W, cellH = TABLE_CELL_H } = {}) {
  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      cells.push(tableCellSkeleton(tid, r, c, x + c * cellW, y + r * cellH, cellW, cellH));
    }
  }
  return cells;
}

function tableCells(elements, tid) {
  return elements.filter((el) => el && !el.isDeleted && el.customData && el.customData.table && el.customData.table.id === tid);
}

function tableGeometry(cells) {
  let rows = 0;
  let cols = 0;
  for (const cell of cells) {
    rows = Math.max(rows, cell.customData.table.r + 1);
    cols = Math.max(cols, cell.customData.table.c + 1);
  }
  return { rows, cols };
}

// Skeletons for a new right-hand column, inheriting each row's own cell size and colour.
function tableColumnSkeletons(elements, tid) {
  const cells = tableCells(elements, tid);
  if (!cells.length) return [];
  const { rows, cols } = tableGeometry(cells);
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    const base = cells.find((cell) => cell.customData.table.r === r && cell.customData.table.c === cols - 1);
    if (!base) continue;
    const cell = tableCellSkeleton(tid, r, cols, base.x + base.width, base.y, base.width, base.height);
    cell.backgroundColor = base.backgroundColor;
    cell.strokeColor = base.strokeColor;
    out.push(cell);
  }
  return out;
}

// Skeletons for a new bottom row (always a data row, never a second header).
function tableRowSkeletons(elements, tid) {
  const cells = tableCells(elements, tid);
  if (!cells.length) return [];
  const { rows, cols } = tableGeometry(cells);
  const out = [];
  for (let c = 0; c < cols; c += 1) {
    const base = cells.find((cell) => cell.customData.table.r === rows - 1 && cell.customData.table.c === c);
    if (!base) continue;
    const cell = tableCellSkeleton(tid, rows, c, base.x, base.y + base.height, base.width, base.height);
    cell.backgroundColor = TABLE_CELL_BG;
    cell.strokeColor = base.strokeColor;
    out.push(cell);
  }
  return out;
}

// Remove the last row/column and any text bound into the removed cells. Keeps at least 1x1.
// Removed cells are MARKED isDeleted (not dropped): Excalidraw's updateScene merges by id, so
// an omitted element simply survives; only isDeleted actually removes it (the sticky lesson).
function tableRemoveRow(elements, tid) {
  const cells = tableCells(elements, tid);
  const { rows } = tableGeometry(cells);
  if (rows <= 1) return elements;
  const gone = new Set(cells.filter((cell) => cell.customData.table.r === rows - 1).map((cell) => cell.id));
  return elements.map((el) => (
    gone.has(el.id) || (el.type === 'text' && gone.has(el.containerId)) ? { ...el, isDeleted: true } : el
  ));
}

function tableRemoveColumn(elements, tid) {
  const cells = tableCells(elements, tid);
  const { cols } = tableGeometry(cells);
  if (cols <= 1) return elements;
  const gone = new Set(cells.filter((cell) => cell.customData.table.c === cols - 1).map((cell) => cell.id));
  return elements.map((el) => (
    gone.has(el.id) || (el.type === 'text' && gone.has(el.containerId)) ? { ...el, isDeleted: true } : el
  ));
}

// The table id of a selection that lands on a table cell (so the +row/+col controls show),
// else null. First matching cell wins; a selection spanning two tables is ambiguous and
// simply drives the first one's controls.
function selectionTableId(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  for (const el of elements) {
    if (ids.has(el.id) && el.customData && el.customData.table) return el.customData.table.id;
  }
  return null;
}

// Pure recolor of a selection: 'line' sets strokeColor; 'fill' sets a solid
// backgroundColor (transparent clears it). Returns a new elements array so the
// caller hands it straight to updateScene.
function recolorElements(elements, selectedIds, target, color) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return elements.map((el) => {
    if (!ids.has(el.id) || isStickyShadow(el)) return el; // a sticky's shadow keeps its own colour
    if (target === 'line') return { ...el, strokeColor: color };
    if (color === 'transparent') return { ...el, backgroundColor: 'transparent' };
    return { ...el, backgroundColor: color, fillStyle: 'solid' };
  });
}

function setSelectionProp(elements, selectedIds, prop, value) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return elements.map((el) => (ids.has(el.id) ? { ...el, [prop]: value } : el));
}

// A text element's colour is its strokeColor. A sticky's label and a shape's caption are
// BOUND text (their own element with `containerId` pointing at the container), so selecting
// the sticky/shape never selects the label; recolouring the container's stroke only touches
// its (often transparent) border. `recolorText` recolours the text itself: a selected text
// element, or the bound text of a selected container. This is the "change the text colour on
// a sticky" path.
function isTextTarget(el, ids) {
  return el.type === 'text' && (ids.has(el.id) || (el.containerId && ids.has(el.containerId)));
}

function recolorText(elements, selectedIds, color) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return elements.map((el) => (isTextTarget(el, ids) ? { ...el, strokeColor: color } : el));
}

// True when the selection carries any recolourable text (a bound label or a standalone text),
// which is what makes the Text control appear in the style bar.
function selectionHasText(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return elements.some((el) => isTextTarget(el, ids));
}

// The current text colour of a selection (for the active-swatch highlight), null when the
// texts disagree or there is none.
function selectionTextColor(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let color; let seen = 0;
  for (const el of elements) {
    if (!isTextTarget(el, ids)) continue;
    if (seen === 0) color = el.strokeColor;
    else if (el.strokeColor !== color) color = null;
    seen += 1;
  }
  return seen ? (color ?? null) : null;
}

// ---- Connectors (arrows/lines), Miro-style editing --------------------------
// Miro lets you restyle a selected connector: routing (straight / curved / elbow),
// line style (solid / dashed / dotted), and the end/start caps. Excalidraw accepts
// strokeStyle and start/endArrowhead directly, but routing is NOT a flag it re-lays-out
// on: setting `elbowed` alone leaves the old points (verified live), so routing is done
// by rewriting the connector's own `points` (Excalidraw keeps waypoints on a bound
// arrow and re-snaps only the first/last to the shape edges).
const CONNECTOR_TYPES = ['arrow', 'line'];

function selectionIsConnector(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let any = false;
  for (const el of elements) {
    if (!ids.has(el.id)) continue;
    // A drawn polygon is a `line` under the hood but is a SHAPE: it gets the fill/colour bar,
    // never the connector bar.
    if (isPolyShape(el)) return false;
    if (!CONNECTOR_TYPES.includes(el.type)) return false;
    any = true;
  }
  return any;
}

// Rewrite a connector's waypoints for the chosen routing, preserving its endpoints.
// straight: two points. curved: a single bowed midpoint with rounded joins (roundness
// type 2 turns the bend into a smooth arc). elbow: an orthogonal route that CLEARS the
// bound shapes' bodies by ELBOW_CLEARANCE and rounds each corner ~ELBOW_CORNER_RADIUS
// (Miro finding 17); the LOGICAL waypoints ride customData.elbow so segment handles
// stay per-segment while `points` carries the rounded expansion.
// Drop a stale elbow waypoint record without ever writing `customData: undefined`
// (board-model's base schema forbids undefined values, and an element that never
// had customData must not grow the key).
function withoutElbowData(el, changes) {
  const next = { ...el, ...changes };
  if (el.customData && el.customData.elbow) {
    const { elbow, ...rest } = el.customData;
    if (Object.keys(rest).length) next.customData = rest;
    else delete next.customData;
  }
  return next;
}

function routeConnector(el, kind, opts = {}) {
  const pts = el.points && el.points.length ? el.points : [[0, 0], [0, 0]];
  const start = pts[0];
  const end = pts[pts.length - 1];
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (kind === 'elbow') {
    const obstacles = (opts.obstacles || []).map((box) => ({
      x: box.x - (el.x || 0), y: box.y - (el.y || 0), width: box.width, height: box.height,
    }));
    const waypoints = orthogonalRoute([0, 0], [dx, dy], obstacles);
    return {
      ...el,
      points: roundElbowCorners(waypoints, ELBOW_CORNER_RADIUS),
      roundness: null,
      customData: { ...(el.customData || {}), elbow: { waypoints } },
    };
  }
  if (kind === 'curved') {
    const len = Math.hypot(dx, dy) || 1;
    const off = Math.min(70, len * 0.22);
    const px = (-dy / len) * off;
    const py = (dx / len) * off;
    return withoutElbowData(el, { points: [[0, 0], [dx / 2 + px, dy / 2 + py], [dx, dy]], roundness: { type: 2 } });
  }
  // straight
  return withoutElbowData(el, { points: [[0, 0], [dx, dy]], roundness: null });
}

// Re-route the selected connectors. The obstacle boxes an elbow must clear are the
// shapes its own bindings name, looked up from the same elements array.
function setConnectorRouting(elements, selectedIds, kind) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const byId = new Map(elements.map((el) => [el.id, el]));
  return elements.map((el) => {
    if (!ids.has(el.id) || el.type !== 'arrow') return el;
    const obstacles = [el.startBinding?.elementId, el.endBinding?.elementId]
      .map((id) => (id ? byId.get(id) : null))
      .filter((shape) => shape && !shape.isDeleted);
    return routeConnector(el, kind, { obstacles });
  });
}

function setConnectorDash(elements, selectedIds, style) {
  return setSelectionProp(elements, selectedIds, 'strokeStyle', style);
}

// heads: { start: null|'arrow', end: null|'arrow' }
function setConnectorHeads(elements, selectedIds, heads) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return elements.map((el) => (
    ids.has(el.id) && CONNECTOR_TYPES.includes(el.type)
      ? { ...el, startArrowhead: heads.start ?? null, endArrowhead: heads.end ?? null }
      : el
  ));
}

// Read the current connector styling of a selection (first connector) for the toolbar's
// active-state highlighting. routing is inferred from the shape: roundness type 2 is
// curved (a 2-point curved connector renders straight, the Miro bezier default, finding
// 14), 3+ sharp points is elbow, else straight.
function connectorStyle(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const el = elements.find((e) => ids.has(e.id) && CONNECTOR_TYPES.includes(e.type));
  if (!el) return { routing: null, dash: null, start: null, end: null };
  const n = (el.points || []).length;
  const rounded = el.roundness && el.roundness.type === 2;
  const routing = rounded ? 'curved' : (n <= 2 ? 'straight' : 'elbow');
  return {
    routing,
    dash: el.strokeStyle || 'solid',
    start: el.startArrowhead || null,
    end: el.endArrowhead || null,
  };
}

// The shared opacity (0-100) of a selection for the transparency slider, defaulting an unset
// opacity to 100 (fully opaque), null when the selected elements disagree or there are none.
// Sticky shadows carry their own faint opacity and are never counted (a sticky reads its face).
function selectionOpacity(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let value; let seen = 0;
  for (const el of elements) {
    if (!ids.has(el.id) || isStickyShadow(el)) continue;
    const o = typeof el.opacity === 'number' ? el.opacity : 100;
    if (seen === 0) value = o;
    else if (o !== value) value = null;
    seen += 1;
  }
  return seen ? (value ?? null) : null;
}

// The fill/stroke swatches currently on the selection (for the active-swatch
// highlight), read from the first selected element, null when they disagree.
function selectionStyle(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let fill; let stroke; let width; let seen = 0;
  for (const el of elements) {
    if (!ids.has(el.id)) continue;
    if (seen === 0) { fill = el.backgroundColor; stroke = el.strokeColor; width = el.strokeWidth; }
    else {
      if (el.backgroundColor !== fill) fill = null;
      if (el.strokeColor !== stroke) stroke = null;
      if (el.strokeWidth !== width) width = null;
    }
    seen += 1;
  }
  return { count: seen, fill: fill ?? null, stroke: stroke ?? null, width: width ?? null };
}

// ---- The contextual toolbar above the selection (catalog findings 46-48, 53, 57, 76) --
// Miro has NO bottom style bar: one floating white card sits ABOVE the selection,
// horizontally centred on it, and every deeper control (border, fill, typography,
// switch type, arrange) opens DOWN from its own button. Everything here is the pure
// half of that: where the card goes, what the popovers write, and what they read back.

// The scene-space bounding box of a selection. Sticky shadow bands are decoration and
// never count, so a sticky's box is its face; a deleted element never counts either.
// Null when the selection has nothing measurable in it.
function selectionSceneBox(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  let seen = 0;
  for (const el of elements) {
    if (!ids.has(el.id) || el.isDeleted || isStickyShadow(el)) continue;
    const w = el.width || 0;
    const h = el.height || 0;
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + w);
    maxY = Math.max(maxY, el.y + h);
    seen += 1;
  }
  if (!seen) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Scene box to a client (viewport) rect, the same mapping the connect dots use.
function sceneBoxToClient(box, appState = {}) {
  const zoom = (appState.zoom && appState.zoom.value) || 1;
  const left = (box.x + (appState.scrollX || 0)) * zoom + (appState.offsetLeft || 0);
  const top = (box.y + (appState.scrollY || 0)) * zoom + (appState.offsetTop || 0);
  const width = box.width * zoom;
  const height = box.height * zoom;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

const TOOLBAR_GAP = 12; // px between the selection box and the card (Miro sits just off it)
const TOOLBAR_MARGIN = 8; // px the card keeps from every viewport edge

// Where the floating card goes: centred over the selection and ABOVE it, flipped BELOW
// when there is no room above, and always clamped inside the CANVAS. The viewport is
// the drawing surface (`left`/`top` default to 0), never the whole window: clamping to
// the window let the card ride up over Harbor's own board header and banner, which are
// not board (screenshot-caught). `minLeft` keeps it clear of the tool rail, which owns
// the left edge at every window size.
function toolbarPlacement({
  box, size, viewport, gap = TOOLBAR_GAP, margin = TOOLBAR_MARGIN, minLeft = null,
} = {}) {
  if (!box || !size || !viewport) return null;
  const viewLeft = viewport.left || 0;
  const viewTop = viewport.top || 0;
  const viewRight = viewLeft + viewport.width;
  const viewBottom = viewTop + viewport.height;
  const lowLeft = Math.max(viewLeft + margin, minLeft == null ? viewLeft + margin : minLeft);
  const maxLeft = Math.max(lowLeft, viewRight - size.width - margin);
  const centred = box.left + box.width / 2 - size.width / 2;
  const left = Math.max(lowLeft, Math.min(centred, maxLeft));
  let top = box.top - gap - size.height;
  let above = true;
  if (top < viewTop + margin) {
    top = box.bottom + gap;
    above = false;
  }
  // The final clamp is two-sided: a selection scrolled PAST the top of the canvas has
  // its "below" position above the canvas too, and one-sided clamping let the card land
  // on the board header (screenshot-caught).
  const minTop = viewTop + margin;
  const maxTop = Math.max(minTop, viewBottom - margin - size.height);
  top = Math.max(minTop, Math.min(top, maxTop));
  return { left: Math.round(left), top: Math.round(top), above };
}

// Border style row (finding 47): the same three Miro offers, applied as Excalidraw's
// own strokeStyle so an existing board reads back correctly.
const BORDER_STYLES = [
  { key: 'solid', label: 'Solid' },
  { key: 'dashed', label: 'Dashed' },
  { key: 'dotted', label: 'Dotted' },
];

// The shared strokeStyle of a selection (null when they disagree), defaulting an unset
// value to 'solid' the way Excalidraw renders it.
function selectionStrokeStyle(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let value; let seen = 0;
  for (const el of elements) {
    if (!ids.has(el.id) || isStickyShadow(el)) continue;
    const style = el.strokeStyle || 'solid';
    if (seen === 0) value = style;
    else if (style !== value) value = null;
    seen += 1;
  }
  return seen ? (value ?? null) : null;
}

// Miro's "Rounded corners" is a NUMBER, and Excalidraw can express exactly that: an
// ADAPTIVE_RADIUS roundness carries an optional numeric `value` its renderer honours
// (measured in 0.18.1: radius = value once the side is large enough, and the smaller
// proportional 0.25 * side below that). Adaptive only applies to rectangles and images;
// a diamond / ellipse / line has only the PROPORTIONAL form, which carries no number,
// so the toolbar hides the numeric control for those instead of lying about it.
const ROUNDNESS_ADAPTIVE = 3;
const ROUNDNESS_PROPORTIONAL = 2;
const DEFAULT_CORNER_RADIUS = 32;
const ADAPTIVE_RADIUS_TYPES = new Set(['rectangle', 'image', 'embeddable', 'iframe']);

function cornerRoundness(el, radius) {
  if (!(radius > 0)) return null;
  if (ADAPTIVE_RADIUS_TYPES.has(el.type)) return { type: ROUNDNESS_ADAPTIVE, value: Math.round(radius) };
  return { type: ROUNDNESS_PROPORTIONAL };
}

function setCornerRadius(elements, selectedIds, radius) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return elements.map((el) => (
    ids.has(el.id) && !isStickyShadow(el) ? { ...el, roundness: cornerRoundness(el, radius) } : el
  ));
}

// True when every selected element can carry a numeric corner radius (so the slider is
// telling the truth about what will render).
function selectionRadiusEditable(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let seen = 0;
  for (const el of elements) {
    if (!ids.has(el.id) || isStickyShadow(el)) continue;
    if (!ADAPTIVE_RADIUS_TYPES.has(el.type)) return false;
    seen += 1;
  }
  return seen > 0;
}

// The selection's current corner radius: 0 for sharp, the carried value (or Excalidraw's
// 32 default) for an adaptive roundness, null when they disagree or none applies.
function selectionCornerRadius(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let value; let seen = 0;
  for (const el of elements) {
    if (!ids.has(el.id) || isStickyShadow(el)) continue;
    const r = el.roundness;
    let radius = 0;
    if (r && r.type === ROUNDNESS_ADAPTIVE) radius = typeof r.value === 'number' ? r.value : DEFAULT_CORNER_RADIUS;
    else if (r) radius = DEFAULT_CORNER_RADIUS;
    if (seen === 0) value = radius;
    else if (radius !== value) value = null;
    seen += 1;
  }
  return seen ? (value ?? null) : null;
}

// ---- Switch type: change what a shape IS, in place (finding 46) -----------------------
// Miro's quick-convert grid is 12 glyphs plus "All shapes". Conversion here keeps the
// SAME element id, box, colours and stack position, so every connector bound to the
// shape stays bound and nothing jumps. Two directions need real work rather than a type
// swap: a native container carries BOUND text (containerId), while a poly shape is a
// `line` Excalidraw will not bind text to, so its label is the standalone tagged text
// the CLI writes (customData.labelFor). Converting either way moves the label across.
const SWITCH_TYPE_KEYS = [
  'rectangle', 'rounded', 'ellipse', 'diamond',
  'triangle', 'right-triangle', 'pentagon', 'hexagon',
  'star', 'parallelogram', 'trapezoid', 'speech',
];

// A selected shape's current switch-type key (which glyph the button shows), or null when
// the selection is not a single convertible shape.
function selectionShapeKey(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const picked = elements.filter((el) => ids.has(el.id) && !el.isDeleted && !isStickyShadow(el));
  if (picked.length !== 1) return null;
  const el = picked[0];
  if (isPolyShape(el)) return el.customData.polyShape;
  if (el.type === 'rectangle') return el.roundness ? 'rounded' : 'rectangle';
  if (el.type === 'ellipse' || el.type === 'diamond') return el.type;
  return null;
}

// Elements a switch-type click may convert: the native containers and the poly shapes.
// A sticky face is deliberately NOT convertible: its shadow bands are rectangles glued
// to the face, so an ellipse sticky would render square shadows under a round note.
function isSwitchable(el) {
  if (!el || el.isDeleted || isStickyShadow(el)) return false;
  if (el.customData && el.customData.sticky) return false;
  if (isPolyShape(el)) return true;
  return el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond';
}

// Strip a key off customData without ever writing `customData: undefined` (board-model's
// base schema forbids undefined values, and an element that had none must not grow one).
function withoutCustomKey(el, key) {
  if (!el.customData || !(key in el.customData)) return { ...el };
  const rest = { ...el.customData };
  delete rest[key];
  const next = { ...el };
  if (Object.keys(rest).length) next.customData = rest;
  else delete next.customData;
  return next;
}

function withCustomKey(el, key, value) {
  return { ...el, customData: { ...(el.customData || {}), [key]: value } };
}

function boundTextIdOf(el) {
  const bound = (el.boundElements || []).find((b) => b && b.type === 'text');
  return bound ? bound.id : null;
}

function switchShapeType(elements, selectedIds, targetKey) {
  const def = shapeDef(targetKey);
  if (!def) return elements;
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const byId = new Map(elements.map((el) => [el.id, el]));
  const targets = elements.filter((el) => ids.has(el.id) && isSwitchable(el));
  if (!targets.length) return elements;
  const patched = new Map();
  for (const el of targets) {
    const width = el.width || 0;
    const height = el.height || 0;
    let next;
    if (def.kind === 'native') {
      next = withoutCustomKey(el, 'polyShape');
      next.type = def.tool;
      next.roundness = def.rounded ? { type: ROUNDNESS_ADAPTIVE } : null;
      // A `line` stores its points RELATIVE to x/y, and the first point is not the
      // top-left (normalizeLinearPoints rebases every linear element so points[0] is
      // the origin), so a poly's x/y is not its box. Taking the absolute bounds is what
      // keeps the shape exactly where it was drawn instead of jumping by half its width.
      if (Array.isArray(el.points) && el.points.length) {
        const xs = el.points.map((p) => p[0]);
        const ys = el.points.map((p) => p[1]);
        next.x = el.x + Math.min(...xs);
        next.y = el.y + Math.min(...ys);
        next.width = Math.max(...xs) - Math.min(...xs);
        next.height = Math.max(...ys) - Math.min(...ys);
      }
      delete next.points;
      delete next.lastCommittedPoint;
      // A poly's standalone label becomes real bound text on the new container.
      const label = elements.find((t) => t.type === 'text' && !t.isDeleted
        && t.customData && t.customData.labelFor === el.id);
      if (label && !boundTextIdOf(next)) {
        const bound = withoutCustomKey(label, 'labelFor');
        bound.containerId = el.id;
        patched.set(label.id, bound);
        next.boundElements = [...(next.boundElements || []), { type: 'text', id: label.id }];
      }
    } else {
      const loop = [...def.points, def.points[0]];
      next = withCustomKey(el, 'polyShape', def.key);
      next.type = 'line';
      next.roundness = null;
      const scaled = loop.map(([px, py]) => [
        Number((px * width).toFixed(2)),
        Number((py * height).toFixed(2)),
      ]);
      // Rebase onto points[0] up front, the way normalizeLinearPoints would a frame
      // later, so the stored origin and the drawn shape agree from the first render.
      const [ox, oy] = scaled[0];
      next.x = el.x + ox;
      next.y = el.y + oy;
      next.points = scaled.map(([px, py]) => [Number((px - ox).toFixed(2)), Number((py - oy).toFixed(2))]);
      // Excalidraw binds text to containers only, never to a line, so a container's
      // bound label becomes the standalone tagged text a poly shape wears.
      const boundId = boundTextIdOf(el);
      const label = boundId ? byId.get(boundId) : null;
      if (label && !label.isDeleted) {
        const free = withCustomKey(label, 'labelFor', el.id);
        free.containerId = null;
        free.x = el.x + (width - (label.width || 0)) / 2;
        free.y = el.y + (height - (label.height || 0)) / 2;
        patched.set(label.id, free);
        next.boundElements = (next.boundElements || []).filter((b) => !(b && b.type === 'text' && b.id === label.id));
      }
    }
    patched.set(el.id, next);
  }
  if (!patched.size) return elements;
  return elements.map((el) => patched.get(el.id) || el);
}

// ---- Copy style / paste style (findings 56, 63) ---------------------------------------
// Miro's More menu and every context menu carry Copy style Ctrl+Alt+C / Paste style
// Ctrl+Alt+V. The copied recipe is the paint, never the geometry: no x/y/width/height,
// no points, no bindings, no text CONTENT, so pasting onto a different shape restyles it
// where it stands. A pasted roundness is re-derived for the target type, because an
// adaptive radius means nothing on an ellipse.
const SHAPE_STYLE_KEYS = ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity'];
const TEXT_STYLE_KEYS = ['fontFamily', 'fontSize', 'textAlign', 'strokeColor'];

function pickKeys(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function copySelectionStyle(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const shapeEl = elements.find((el) => ids.has(el.id) && !el.isDeleted && !isStickyShadow(el) && el.type !== 'text');
  const textEl = elements.find((el) => !el.isDeleted && isTextTarget(el, ids));
  if (!shapeEl && !textEl) return null;
  const style = {};
  if (shapeEl) {
    style.shape = pickKeys(shapeEl, SHAPE_STYLE_KEYS);
    style.radius = selectionCornerRadius(elements, new Set([shapeEl.id]));
  }
  if (textEl) style.text = pickKeys(textEl, TEXT_STYLE_KEYS);
  return style;
}

function pasteSelectionStyle(elements, selectedIds, style) {
  if (!style) return elements;
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return elements.map((el) => {
    if (el.isDeleted || isStickyShadow(el)) return el;
    if (isTextTarget(el, ids)) return style.text ? { ...el, ...style.text } : el;
    if (!ids.has(el.id) || !style.shape) return el;
    const next = { ...el, ...style.shape };
    if (style.radius != null) next.roundness = cornerRoundness(el, style.radius);
    return next;
  });
}

// ---- Typography (findings 49-51) ------------------------------------------------------
// Miro offers 43 fonts; Excalidraw ships the eight below and renders nothing else, so the
// list is what the engine can honestly draw rather than a menu of fallbacks. `family` is
// the key into Excalidraw's own FONT_FAMILY map, resolved in the renderer (this module
// stays dependency-free). Bold / italic / underline / strikethrough are NOT here: an
// Excalidraw text element has no weight, slant, or decoration field, and a button that
// changes nothing is worse than an absent one.
const BOARD_FONTS = [
  { key: 'nunito', family: 'Nunito', label: 'Nunito' },
  { key: 'helvetica', family: 'Helvetica', label: 'Helvetica' },
  { key: 'liberation', family: 'Liberation Sans', label: 'Liberation Sans' },
  { key: 'lilita', family: 'Lilita One', label: 'Lilita One' },
  { key: 'excalifont', family: 'Excalifont', label: 'Excalifont' },
  { key: 'comic', family: 'Comic Shanns', label: 'Comic Shanns' },
  { key: 'cascadia', family: 'Cascadia', label: 'Cascadia Mono' },
];

const TEXT_ALIGNS = [
  { key: 'left', label: 'Align left' },
  { key: 'center', label: 'Align centre' },
  { key: 'right', label: 'Align right' },
];

const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 144;

// The shared typography of a selection (bound labels included), null per field when the
// selected texts disagree, and null overall when the selection carries no text.
function selectionTextStyle(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let family; let size; let align; let seen = 0;
  for (const el of elements) {
    if (el.isDeleted || !isTextTarget(el, ids)) continue;
    const elAlign = el.textAlign || 'left';
    if (seen === 0) { family = el.fontFamily; size = el.fontSize; align = elAlign; } else {
      if (el.fontFamily !== family) family = null;
      if (el.fontSize !== size) size = null;
      if (elAlign !== align) align = null;
    }
    seen += 1;
  }
  if (!seen) return null;
  return { fontFamily: family ?? null, fontSize: size ?? null, textAlign: align ?? null };
}

// Re-lay-out a bound label inside its container after a font change. Excalidraw only
// re-measures bound text through its own editing actions, so a font written straight
// into the scene would keep the OLD box and overflow; the same greedy wrap and the same
// injected glyph measure the sticky autosize uses put it right.
function layoutBoundText(text, container, measure, padding = STICKY_TEXT_PAD) {
  const fontSize = text.fontSize || 20;
  const lineHeight = text.lineHeight || STICKY_LINE_HEIGHT;
  const maxW = Math.max(8, (container.width || 0) - padding * 2);
  const source = text.originalText != null ? text.originalText : text.text;
  const lines = wrapTextToWidth(source, fontSize, maxW, measure);
  const width = lines.reduce((w, line) => Math.max(w, measure(line, fontSize)), 0);
  const height = lines.length * fontSize * lineHeight;
  const align = text.textAlign || 'left';
  let x = container.x + (container.width - width) / 2;
  if (align === 'left') x = container.x + padding;
  else if (align === 'right') x = container.x + container.width - padding - width;
  const vertical = text.verticalAlign || 'middle';
  let y = container.y + (container.height - height) / 2;
  if (vertical === 'top') y = container.y + padding;
  else if (vertical === 'bottom') y = container.y + container.height - padding - height;
  return { text: lines.join('\n'), width, height, x, y };
}

// Write one typography property onto every text the selection carries (a standalone text,
// or a container's bound label). With a `measure` the bound labels are re-laid-out; a
// sticky's label is left to the autosize pass, which owns its size by design.
function setTextProp(elements, selectedIds, prop, value, measure) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const byId = new Map(elements.map((el) => [el.id, el]));
  return elements.map((el) => {
    if (el.isDeleted || !isTextTarget(el, ids)) return el;
    const next = { ...el, [prop]: value };
    if (!measure || !el.containerId) return next;
    const container = byId.get(el.containerId);
    if (!container || (container.customData && container.customData.sticky)) return next;
    return { ...next, ...layoutBoundText(next, container, measure) };
  });
}

// ---- Arrange (finding 57): Miro's z-order submenu, in Miro's order ---------------------
const ARRANGE_OPS = [
  { key: 'forward', label: 'Bring forward', hint: 'Shift+PgUp' },
  { key: 'front', label: 'Bring to front', hint: 'PgUp' },
  { key: 'backward', label: 'Send backward', hint: 'Shift+PgDn' },
  { key: 'back', label: 'Send to back', hint: 'PgDn' },
];

// ---- Wave D: what a connector may attach to (catalog finding 38) ----------------------
// Miro's TEXT is connectable: a placed text carries the same four side anchors a shape
// does. Excalidraw agrees (its ExcalidrawBindableElement union includes text in 0.18.1),
// so a text is a first-class connect target here. Two exclusions are structural rather
// than stylistic: a container's BOUND label is not its own object (the shape it lives in
// is the target, and dots on the label would sit inside the shape's own dots), and a
// LOCKED element is not interactive at all, which now includes every sticky shadow band.
const CONNECTABLE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'text']);

function isConnectable(el) {
  if (!el || el.isDeleted || el.locked || isStickyShadow(el)) return false;
  // A catalog poly is a filled `line` under the hood, but to the user it is a
  // SHAPE and Miro gives shapes connect dots (Pat, 2026-08-30: dragging between
  // catalog shapes had no dots and no snap; this exclusion was the lie).
  // Excalidraw cannot NATIVELY bind to a line, so poly attachments ride
  // customData.polyBind and syncPolyConnectors glues them each change.
  if (isPolyShape(el)) return true;
  if (!CONNECTABLE_TYPES.has(el.type)) return false;
  if (el.type === 'text' && el.containerId) return false;
  return true;
}

// ---- Poly attachments: our own binding for what Excalidraw cannot bind -----------
// customData.polyBind = { start?: { id, side }, end?: { id, side } } on an ARROW.
// Each maintenance pass re-glues the bound ends to the poly's box side midpoints,
// so the arrow follows a moved or resized poly the way a native binding would.
// A deleted host drops its entry and the end stays where it was: an honest
// dangling end, exactly what Miro shows when you delete a connected shape.
function syncPolyConnectors(elements) {
  const byId = new Map(elements.map((el) => [el.id, el]));
  let changed = false;
  const out = elements.map((el) => {
    if (el.type !== 'arrow' || el.isDeleted || !el.customData || !el.customData.polyBind) return el;
    let next = el;
    const bind = { ...el.customData.polyBind };
    let bindChanged = false;
    for (const which of ['start', 'end']) {
      const entry = bind[which];
      if (!entry) continue;
      const host = byId.get(entry.id);
      if (!host || host.isDeleted) {
        delete bind[which];
        bindChanged = true;
        continue;
      }
      const anchor = anchorPoints(host)[entry.side] || anchorPoints(host).left;
      const points = next.points || [[0, 0], [0, 0]];
      if (which === 'end') {
        const last = points[points.length - 1];
        const want = [anchor.x - next.x, anchor.y - next.y];
        if (Math.round(last[0]) !== Math.round(want[0]) || Math.round(last[1]) !== Math.round(want[1])) {
          next = { ...next, points: [...points.slice(0, -1), want] };
          changed = true;
        }
      } else {
        // Glue the START by moving the arrow origin and compensating every
        // other point, so only points[0]'s scene position changes.
        const startScene = { x: next.x + points[0][0], y: next.y + points[0][1] };
        const dx = anchor.x - startScene.x;
        const dy = anchor.y - startScene.y;
        if (Math.round(dx) !== 0 || Math.round(dy) !== 0) {
          next = {
            ...next,
            x: next.x + dx,
            y: next.y + dy,
            points: points.map((p, i) => (i === 0 ? p : [p[0] - dx, p[1] - dy])),
          };
          changed = true;
        }
      }
    }
    if (bindChanged) {
      next = { ...next, customData: { ...next.customData, polyBind: bind } };
      changed = true;
    }
    return next;
  });
  return { elements: out, changed };
}

// ---- Wave D: Lock, Unlock all, Clear content, Duplicate (findings 56, 59, 61-64) ------
// Every row of Miro's element menu that Harbor can honestly execute is a pure decision
// here; the canvas only runs it. What is deliberately NOT here, and why:
//   - Copy / Paste: clipboard element transfer is Excalidraw's own Ctrl+C / Ctrl+V and
//     already works. Chromium refuses a script-driven paste outright, so a menu row for
//     it could only be a button that does nothing.
//   - Copy link / Link to / Info: a board element has no Harbor-side identity or URL.
//   - Create frame / Save as template / Export to CSV: no template store, and a board is
//     not tabular (the diff plan's own verdict on CSV was "likely never").
const LOCKABLE_SKIP = (el) => isStickyShadow(el);

// Lock or unlock a selection. A container's bound label travels with it (an unlocked
// label inside a locked shape would still take clicks), and a sticky's shadow bands are
// skipped: they are locked decoration whose lock is not the user's to toggle.
function lockElements(elements, selectedIds, locked) {
  const ids = selectedIds instanceof Set ? new Set(selectedIds) : new Set(selectedIds);
  for (const el of elements) {
    if (!ids.has(el.id)) continue;
    for (const bound of el.boundElements || []) if (bound.type === 'text') ids.add(bound.id);
  }
  // A poly shape's label is a standalone tagged text rather than bound text, so it needs
  // naming separately or a locked star would leave a clickable label floating on it.
  for (const el of elements) {
    if (el.type === 'text' && el.customData && ids.has(el.customData.labelFor)) ids.add(el.id);
  }
  return elements.map((el) => (
    ids.has(el.id) && !LOCKABLE_SKIP(el) ? { ...el, locked: Boolean(locked) } : el
  ));
}

// True when the selection is entirely locked (so the row reads Unlock, not Lock).
function selectionLocked(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  let seen = 0;
  for (const el of elements) {
    if (!ids.has(el.id) || el.isDeleted || isStickyShadow(el)) continue;
    if (!el.locked) return false;
    seen += 1;
  }
  return seen > 0;
}

// Miro's canvas menu carries "Unlock all" (finding 62). Sticky shadow bands stay locked:
// unlocking them would make a sticky's decoration independently draggable.
function unlockAllElements(elements) {
  let changed = false;
  const out = elements.map((el) => {
    if (!el.locked || el.isDeleted || isStickyShadow(el)) return el;
    changed = true;
    return { ...el, locked: false };
  });
  return { elements: out, changed };
}

// True when anything on the board is unlockable, which is what enables the row.
function hasLockedElements(elements) {
  return elements.some((el) => el.locked && !el.isDeleted && !isStickyShadow(el));
}

// Miro's "Clear content" empties an object's text without deleting the object. Excalidraw
// has no empty text element (an empty one is a validateScene violation and renders
// nothing), so clearing means TOMBSTONING the label and dropping the container's mirror
// entry. A directly selected standalone text has nothing but its content, so clearing it
// removes it; that is the honest reading of the same verb.
function clearSelectionContent(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const doomed = new Set();
  for (const el of elements) {
    if (el.isDeleted || el.type !== 'text') continue;
    if (ids.has(el.id) || (el.containerId && ids.has(el.containerId))
      || (el.customData && ids.has(el.customData.labelFor))) doomed.add(el.id);
  }
  if (!doomed.size) return { elements, changed: false };
  return {
    elements: elements.map((el) => {
      if (doomed.has(el.id)) return { ...el, isDeleted: true };
      if (!(el.boundElements || []).some((b) => doomed.has(b.id))) return el;
      return { ...el, boundElements: el.boundElements.filter((b) => !doomed.has(b.id)) };
    }),
    changed: true,
  };
}

// True when the selection carries text at all (what enables Clear content).
function selectionHasContent(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return elements.some((el) => !el.isDeleted && el.type === 'text' && (
    ids.has(el.id) || (el.containerId && ids.has(el.containerId))
    || (el.customData && ids.has(el.customData.labelFor))
  ));
}

// Miro's Duplicate places the copy BESIDE the original, same y, ~40px gap (finding 59).
// The clone carries everything the selection owns: bound labels, poly labelFor labels,
// and sticky shadow bands, all re-pointed at the CLONED ids so the copy is a whole
// object rather than a shape whose label still belongs to the original. A binding that
// leaves the copied set (a connector to a shape that was not copied) is dropped, because
// a clone that silently re-binds the original's connectors is worse than a bare copy.
const DUPLICATE_GAP = 40;

function duplicateElements(elements, selectedIds, newId, gap = DUPLICATE_GAP) {
  const ids = selectedIds instanceof Set ? new Set(selectedIds) : new Set(selectedIds);
  for (const el of elements) {
    if (!ids.has(el.id) || el.isDeleted) continue;
    for (const bound of el.boundElements || []) if (bound.type === 'text') ids.add(bound.id);
  }
  for (const el of elements) {
    if (el.isDeleted || !el.customData) continue;
    if (isStickyShadow(el) && ids.has(el.customData.faceId)) ids.add(el.id);
    if (el.type === 'text' && ids.has(el.customData.labelFor)) ids.add(el.id);
  }
  const picked = elements.filter((el) => ids.has(el.id) && !el.isDeleted);
  if (!picked.length) return { elements, ids: [] };
  const box = selectionSceneBox(elements, ids);
  const dx = (box ? box.width : 0) + gap;
  const map = new Map(picked.map((el) => [el.id, newId()]));
  const remap = (id) => map.get(id) || null;
  const clones = [];
  for (const el of picked) {
    const next = { ...el, id: map.get(el.id), x: el.x + dx, index: null };
    if (el.boundElements) {
      next.boundElements = el.boundElements.filter((b) => map.has(b.id)).map((b) => ({ ...b, id: map.get(b.id) }));
    }
    // A label whose container was not copied becomes a free-standing text; a labelFor
    // pointing at an uncopied host loses the tag rather than naming a missing element
    // (validateScene's "labelFor names a missing element"), and an orphaned shadow band
    // is dropped outright since it is decoration with nothing left to decorate.
    if (el.containerId) next.containerId = remap(el.containerId);
    if (el.customData) {
      const custom = { ...el.customData };
      if (custom.faceId) {
        if (!map.has(custom.faceId)) continue;
        custom.faceId = map.get(custom.faceId);
      }
      if (custom.labelFor) {
        if (map.has(custom.labelFor)) custom.labelFor = map.get(custom.labelFor);
        else delete custom.labelFor;
      }
      next.customData = custom;
    }
    for (const side of ['startBinding', 'endBinding']) {
      if (!el[side]) continue;
      next[side] = map.has(el[side].elementId) ? { ...el[side], elementId: map.get(el[side].elementId) } : null;
    }
    clones.push(next);
  }
  return { elements: [...elements, ...clones], ids: clones.map((el) => el.id) };
}

// Ctrl+A: everything a user can actually act on. Bound labels ride their containers,
// shadow bands are decoration, and a locked element is deliberately out of reach.
function selectableIds(elements) {
  return elements
    .filter((el) => !el.isDeleted && !el.locked && !isStickyShadow(el) && !(el.type === 'text' && el.containerId))
    .map((el) => el.id);
}

// ---- Wave D: the right-click menus (catalog findings 62-64) ---------------------------
// Miro's three verbatim lists, minus the rows named unbuildable above. The model is pure
// so the rows, their order, their shortcuts and their disabled state are all spec'd; the
// canvas only renders it and runs the handler each key names.
const CONTEXT_ROWS = {
  copyImage: { key: 'copyImage', label: 'Copy as image', hint: 'Ctrl+Shift+C' },
  duplicate: { key: 'duplicate', label: 'Duplicate', hint: 'Ctrl+D' },
  remove: { key: 'remove', label: 'Delete', hint: 'Del' },
  copyStyle: { key: 'copyStyle', label: 'Copy style', hint: 'Ctrl+Alt+C' },
  pasteStyle: { key: 'pasteStyle', label: 'Paste style', hint: 'Ctrl+Alt+V' },
  clearContent: { key: 'clearContent', label: 'Clear content', hint: 'Ctrl+Backspace' },
  arrange: { key: 'arrange', label: 'Arrange', submenu: 'arrange' },
  lock: { key: 'lock', label: 'Lock', hint: 'Ctrl+Shift+L' },
  unlock: { key: 'unlock', label: 'Unlock', hint: 'Ctrl+Shift+L' },
  addSticky: { key: 'addSticky', label: 'Add sticky note', hint: 'N' },
  addText: { key: 'addText', label: 'Add text', hint: 'T' },
  selectAll: { key: 'selectAll', label: 'Select all', hint: 'Ctrl+A' },
  unlockAll: { key: 'unlockAll', label: 'Unlock all' },
  showAll: { key: 'showAll', label: 'Show all', hint: 'Alt+1' },
  wheelMode: { key: 'wheelMode', label: 'Mouse or trackpad', submenu: 'wheel' },
};

function contextMenuModel(ctx = {}) {
  const {
    kind = 'canvas', hasCopiedStyle = false, hasContent = false, locked = false, anyLocked = false,
  } = ctx;
  const row = (base, disabled = false) => ({ ...base, kind: base.submenu ? 'submenu' : 'item', disabled });
  const rows = [];
  if (kind === 'canvas') {
    rows.push(row(CONTEXT_ROWS.addSticky), row(CONTEXT_ROWS.addText), null,
      row(CONTEXT_ROWS.selectAll), row(CONTEXT_ROWS.unlockAll, !anyLocked),
      row(CONTEXT_ROWS.pasteStyle, !hasCopiedStyle), null,
      row(CONTEXT_ROWS.showAll), row(CONTEXT_ROWS.wheelMode));
  } else {
    rows.push(row(CONTEXT_ROWS.copyImage), row(CONTEXT_ROWS.duplicate), row(CONTEXT_ROWS.remove), null,
      row(CONTEXT_ROWS.copyStyle), row(CONTEXT_ROWS.pasteStyle, !hasCopiedStyle));
    // Miro's connector menu drops Clear content (finding 64); ours drops it for the same
    // reason, a connector's label is not its content.
    if (kind === 'element') rows.push(row(CONTEXT_ROWS.clearContent, !hasContent));
    rows.push(null, row(CONTEXT_ROWS.arrange), row(locked ? CONTEXT_ROWS.unlock : CONTEXT_ROWS.lock));
  }
  let seps = 0;
  return rows.map((entry) => {
    if (entry) return entry;
    seps += 1;
    return { key: `sep-${seps}`, kind: 'sep' };
  });
}

// Where the context menu lands. The card is anchored by its TOP in the upper half of the
// canvas and by its BOTTOM in the lower half, so placement never needs the menu's own
// height (which is only known after a render, and a menu that jumps on its first frame is
// the thing this avoids). Horizontally it is clamped by its known width.
const CONTEXT_MENU_WIDTH = 228;
const CONTEXT_MENU_MARGIN = 8;

function contextMenuPlacement({
  x, y, width = CONTEXT_MENU_WIDTH, viewport, margin = CONTEXT_MENU_MARGIN,
} = {}) {
  if (!viewport) return null;
  const vw = viewport.width || 0;
  const vh = viewport.height || 0;
  const left = Math.max(margin, Math.min(x, Math.max(margin, vw - width - margin)));
  if (y > vh / 2) {
    return { left, top: null, bottom: Math.max(margin, vh - y), maxHeight: Math.max(160, y - margin * 2), flipped: true };
  }
  return { left, top: Math.max(margin, y), bottom: null, maxHeight: Math.max(160, vh - y - margin * 2), flipped: false };
}

// ---- Wave D: frame presets (catalog finding 40) ---------------------------------------
// Miro's Frame flyout: Custom (draw it), the paper and screen ratios, then the three
// prototyping device sizes. Custom carries no size and arms Excalidraw's own frame tool.
// Pixel sizes are the honest ones: A4 and Letter at 96dpi, the ratios at their common
// pixel dimensions, the devices at their real logical resolutions.
const FRAME_PRESETS = [
  { key: 'custom', label: 'Custom', width: null, height: null },
  { key: 'a4', label: 'A4', width: 794, height: 1123 },
  { key: 'letter', label: 'Letter', width: 816, height: 1056 },
  { key: 'wide', label: '16:9', width: 1920, height: 1080 },
  { key: 'classic', label: '4:3', width: 1600, height: 1200 },
  { key: 'square', label: '1:1', width: 1200, height: 1200 },
  { key: 'mobile', label: 'Mobile', width: 390, height: 844 },
  { key: 'tablet', label: 'Tablet', width: 820, height: 1180 },
  { key: 'desktop', label: 'Desktop', width: 1440, height: 1024 },
];

function framePreset(key) {
  return FRAME_PRESETS.find((preset) => preset.key === key) || null;
}

// A frame skeleton for convertToExcalidrawElements. `children: []` is required by the
// skeleton type; Excalidraw adopts whatever the frame is later dropped over.
function frameSkeleton(key, x, y) {
  const preset = framePreset(key);
  if (!preset || !preset.width) return [];
  return [{
    type: 'frame',
    name: preset.label,
    children: [],
    x: Math.round(x),
    y: Math.round(y),
    width: preset.width,
    height: preset.height,
  }];
}

// Each template returns a skeleton array anchored at (x, y) top-left, plus its
// bounding size so the caller can drop it centred in the viewport. Skeleton ids
// are unique WITHIN a template only; convertToExcalidrawElements regenerates
// them per insert (so inserting the same template twice never collides) while
// preserving the label/arrow bindings that reference those local ids.
const TEMPLATES = [
  {
    key: 'kanban',
    label: 'Kanban',
    width: 708,
    height: 460,
    build(x, y) {
      const columns = [['To do', '#e7f5ff', '#74c0fc'], ['Doing', '#fff3bf', '#ffd43b'], ['Done', '#ebfbee', '#8ce99a']];
      const W = 220;
      const H = 460;
      const gap = 24;
      const els = [];
      columns.forEach(([title, fill, stroke], i) => {
        const cx = x + i * (W + gap);
        els.push({ type: 'rectangle', x: cx, y, width: W, height: H, backgroundColor: fill, strokeColor: stroke, fillStyle: 'solid', strokeWidth: 1, roughness: 0, roundness: { type: 3 } });
        els.push({ type: 'text', x: cx + 16, y: y + 16, text: title, fontSize: 20, strokeColor: LABEL });
      });
      return els;
    },
  },
  {
    key: 'matrix',
    label: '2×2 Matrix',
    width: 528,
    height: 560,
    build(x, y) {
      const S = 260;
      const gap = 8;
      const ox = x;
      const oy = y + 32;
      const els = [
        { type: 'text', x: ox + S - 20, y, text: 'Impact ↑', fontSize: 16, strokeColor: LABEL },
        { type: 'text', x: ox + 2 * S + gap - 70, y: oy + 2 * S + gap + 6, text: 'Effort →', fontSize: 16, strokeColor: LABEL },
      ];
      const tints = ['#e7f5ff', '#ebfbee', '#fff3bf', '#ffe3e3'];
      [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(([cx, cy], i) => {
        els.push({ type: 'rectangle', x: ox + cx * (S + gap), y: oy + cy * (S + gap), width: S, height: S, backgroundColor: tints[i], strokeColor: '#adb5bd', fillStyle: 'solid', strokeWidth: 1, roughness: 0 });
      });
      return els;
    },
  },
  {
    key: 'flow',
    label: 'Flowchart',
    width: 200,
    height: 500,
    build(x, y) {
      const W = 200;
      const H = 70;
      const gap = 60;
      const start = { id: 'fc-start', type: 'ellipse', x, y, width: W, height: H, backgroundColor: '#d3f9d8', strokeColor: '#40c057', fillStyle: 'solid', strokeWidth: 1, roughness: 0, label: { text: 'Start', strokeColor: LABEL } };
      const proc = { id: 'fc-proc', type: 'rectangle', x, y: y + (H + gap), width: W, height: H, backgroundColor: '#d0ebff', strokeColor: '#4dabf7', fillStyle: 'solid', strokeWidth: 1, roughness: 0, roundness: { type: 3 }, label: { text: 'Process', strokeColor: LABEL } };
      const dec = { id: 'fc-dec', type: 'diamond', x, y: y + 2 * (H + gap), width: W, height: H + 20, backgroundColor: '#fff3bf', strokeColor: '#f59f00', fillStyle: 'solid', strokeWidth: 1, roughness: 0, label: { text: 'Decision?', strokeColor: LABEL } };
      const end = { id: 'fc-end', type: 'ellipse', x, y: y + 3 * (H + gap) + 20, width: W, height: H, backgroundColor: '#ffe3e3', strokeColor: '#f06595', fillStyle: 'solid', strokeWidth: 1, roughness: 0, label: { text: 'End', strokeColor: LABEL } };
      // Each connector starts at the bottom edge of its source node and runs one
      // gap straight down to the next; the id bindings keep it attached as nodes move.
      const arrow = (from, to, topY) => ({ type: 'arrow', x: x + W / 2, y: topY, points: [[0, 0], [0, gap]], strokeColor: CONNECTOR, strokeWidth: 1, roughness: 0, start: { id: from }, end: { id: to } });
      return [
        start, proc, dec, end,
        arrow('fc-start', 'fc-proc', y + H),
        arrow('fc-proc', 'fc-dec', y + 2 * H + gap),
        arrow('fc-dec', 'fc-end', y + 3 * H + 2 * gap + 20),
      ];
    },
  },
  {
    key: 'mindmap',
    label: 'Mind map',
    width: 700,
    height: 420,
    build(x, y) {
      const cx = x + 275;
      const cy = y + 175;
      const center = { id: 'mm-c', type: 'ellipse', x: cx, y: cy, width: 180, height: 70, backgroundColor: '#d0ebff', strokeColor: '#4dabf7', fillStyle: 'solid', strokeWidth: 1, roughness: 0, label: { text: 'Central idea', strokeColor: LABEL } };
      const leaves = [
        { dx: -260, dy: -140, bg: '#d3f9d8', stroke: '#40c057', text: 'Idea 1' },
        { dx: 260, dy: -140, bg: '#fff3bf', stroke: '#f59f00', text: 'Idea 2' },
        { dx: -260, dy: 140, bg: '#ffe3e3', stroke: '#f06595', text: 'Idea 3' },
        { dx: 260, dy: 140, bg: '#e5dbff', stroke: '#7950f2', text: 'Idea 4' },
      ];
      const els = [center];
      leaves.forEach((leaf, i) => {
        const id = `mm-${i}`;
        els.push({ id, type: 'rectangle', x: cx + leaf.dx, y: cy + leaf.dy, width: 150, height: 60, backgroundColor: leaf.bg, strokeColor: leaf.stroke, fillStyle: 'solid', strokeWidth: 1, roughness: 0, roundness: { type: 3 }, label: { text: leaf.text, strokeColor: LABEL } });
        els.push({ type: 'arrow', x: cx, y: cy, strokeColor: CONNECTOR, strokeWidth: 1, roughness: 0, start: { id: 'mm-c' }, end: { id } });
      });
      return els;
    },
  },
];

// Scene coordinate at the centre of the visible canvas, derived from Excalidraw's
// own viewport transform (sceneX = (viewportX)/zoom - scrollX). Used to drop new
// content where the user is actually looking instead of at the origin.
function viewportCenterScene(appState = {}) {
  const zoom = (appState.zoom && appState.zoom.value) || 1;
  const width = appState.width || 0;
  const height = appState.height || 0;
  const scrollX = appState.scrollX || 0;
  const scrollY = appState.scrollY || 0;
  return { x: width / 2 / zoom - scrollX, y: height / 2 / zoom - scrollY };
}

function placeCentered(appState, w = 0, h = 0) {
  const center = viewportCenterScene(appState);
  return { x: Math.round(center.x - w / 2), y: Math.round(center.y - h / 2) };
}

// Cheap fingerprint of the appState fields we actually persist and that a user
// can change deliberately. Deliberately EXCLUDES scrollX/scrollY/zoom so panning
// and zooming never schedule a save; those still ride along in the serialized
// scene whenever a real edit or a flush-on-leave writes.
function appStatePersistSignature(appState = {}) {
  return [
    appState.viewBackgroundColor || '',
    appState.gridModeEnabled ? 1 : 0,
    appState.gridSize || 0,
    appState.objectsSnapModeEnabled ? 1 : 0,
    appState.theme || '',
  ].join('|');
}

// The persist decision the canvas makes on every onChange: write only when the
// element version or the persisted-appState fingerprint actually moved.
function boardChanged(saved = {}, next = {}) {
  return saved.version !== next.version || saved.appSig !== next.appSig;
}

function boardSlug(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled-board';
}

function availableBoardId(name, existingIds = []) {
  const base = boardSlug(name);
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function orderBoards(boards) {
  return [...boards].sort((left, right) => (
    String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
    || String(left.name || '').localeCompare(String(right.name || ''))
  ));
}

// The board switcher's search: trimmed, case-insensitive substring on the name.
// A blank query means "show everything", not "match nothing".
function filterBoards(boards, query) {
  if (!Array.isArray(boards)) return [];
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [...boards];
  return boards.filter((board) => String(board?.name || '').toLowerCase().includes(needle));
}

// Duplicate names the Miro way: "Copy of X", then a numeric suffix past collisions.
function duplicateName(name, takenNames) {
  const base = `Copy of ${String(name || '').trim() || 'Untitled board'}`;
  const taken = new Set((takenNames || []).map((taken1) => String(taken1)));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

// A stable hue per board id for the switcher's tile, so a board keeps its colour
// across sessions without storing anything.
function boardHue(id) {
  let hash = 0;
  const text = String(id || '');
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function debouncePlan({ dirty, elapsedMs = 0, flush = false, delayMs = SAVE_DELAY_MS } = {}) {
  if (!dirty) return { action: 'none', waitMs: 0 };
  if (flush || elapsedMs >= delayMs) return { action: 'save', waitMs: 0 };
  return { action: 'wait', waitMs: Math.max(0, delayMs - elapsedMs) };
}

// H1: a board changed on disk underneath an OPEN canvas (a CLI write). Neither
// side may clobber the other, so the scenes MERGE per element: the higher
// `version` wins (Excalidraw bumps it on every edit, and so does the CLI's
// reducer), a tie keeps the canvas copy (identical content), unsaved local
// elements survive, and disk-only elements land in their disk order. A
// disk-only TOMBSTONE (isDeleted, absent from the canvas) is skipped: the app's
// own saves drop deleted elements, so it was already gone here, and appending
// it would make every reload look like a change. `changed: false` is the
// contract that lets a bare reload skip updateScene entirely and never echo
// back as a save.
// Version, index, versionNonce and updated are BOOKKEEPING, not content:
// Excalidraw's mount normalization re-indexes CLI-authored elements (index
// null) and bumps all three counters with zero content change (measured live),
// so a merge that trusted version numbers alone read every CLI-authored board
// as permanently diverged and echoed a pointless save. Two copies are the same
// element unless they differ MATERIALLY.
const MERGE_BOOKKEEPING = new Set(['index', 'version', 'versionNonce', 'updated']);
function materialEquals(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    if (MERGE_BOOKKEEPING.has(key)) continue;
    if (JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key])) return false;
  }
  return true;
}

function mergeBoardScene(canvasElements, diskElements) {
  const canvas = Array.isArray(canvasElements) ? canvasElements : [];
  const disk = Array.isArray(diskElements) ? diskElements : [];
  const diskById = new Map(disk.map((el) => [el.id, el]));
  const canvasIds = new Set(canvas.map((el) => el.id));
  let changed = false;
  // canvasAhead: the disk is MISSING canvas-side truth (a canvas-only element,
  // or a materially newer canvas copy). That happens when a CLI
  // read-modify-write raced an app save and rewrote the file from a stale
  // read; the caller must persist the union even if its editing state reads
  // clean, or the app's own edit silently never reaches disk.
  let canvasAhead = false;
  const merged = canvas.map((el) => {
    const remote = diskById.get(el.id);
    if (!remote) { canvasAhead = true; return el; }
    if (materialEquals(el, remote)) return el;
    // A material conflict: the higher version wins, the canvas on a tie
    // (what the user is looking at outranks a same-generation file copy).
    if ((Number(remote.version) || 0) > (Number(el.version) || 0)) { changed = true; return remote; }
    canvasAhead = true;
    return el;
  });
  for (const el of disk) {
    if (canvasIds.has(el.id) || el.isDeleted) continue;
    merged.push(el);
    changed = true;
  }
  return { elements: merged, changed, canvasAhead };
}

// The disk files (image bytes) the canvas has not seen yet, in the shape
// excalidrawAPI.addFiles takes. Files are content-addressed (sha1 ids) and
// immutable, so id presence is the whole question.
function newBoardFiles(canvasFiles, diskFiles) {
  const have = new Set(Object.keys(canvasFiles || {}));
  return Object.entries(diskFiles || {})
    .filter(([id]) => !have.has(id))
    .map(([, file]) => file);
}

// ---- interactive connector snap (Miro-style) --------------------------------
// anchorPoints is the ONE side-midpoint rule for connector attachment, in scene
// coordinates. It lives HERE and board-model consumes it (board-model already
// requires this file for routeConnector and the palettes; requiring board-model
// from here is a circular require that hands vite's CJS interop a partial
// module and crashes the renderer at boot, live-caught 2026-08-30).
function anchorPoints(el) {
  return {
    top: { x: el.x + el.width / 2, y: el.y },
    right: { x: el.x + el.width, y: el.y + el.height / 2 },
    bottom: { x: el.x + el.width / 2, y: el.y + el.height },
    left: { x: el.x, y: el.y + el.height / 2 },
  };
}

const SNAP_RADIUS = 24; // px, screen space: how close a dragged endpoint must be to a dot to snap

// The nearest of a shape's four connect dots to a client point, within radius.
// anchorMap is anchorForElement's output (client coordinates).
function nearestAnchorSide(anchorMap, x, y, radius = SNAP_RADIUS) {
  let best = null;
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const point = anchorMap?.[side];
    if (!point) continue;
    const d = Math.hypot(x - point.x, y - point.y);
    if (d <= radius && (!best || d < best.d)) best = { side, point: { x: point.x, y: point.y }, d };
  }
  return best ? { side: best.side, point: best.point } : null;
}

// Scene-coordinate endpoints for a dot-to-dot connector. fromSide is the dot the
// drag STARTED from and is always honoured. toSide is the snapped dot; when the
// drop hit the shape body instead of a dot, the target side nearest the drop
// point wins, and with no drop point at all the side facing the source does.
function connectorPlan({ source, fromSide, target, toSide = null, dropX = null, dropY = null }) {
  const from = anchorPoints(source)[fromSide];
  const toAnchors = anchorPoints(target);
  let side = toSide;
  if (!side && dropX != null && dropY != null) {
    let best = null;
    for (const s of ['top', 'right', 'bottom', 'left']) {
      const d = Math.hypot(dropX - toAnchors[s].x, dropY - toAnchors[s].y);
      if (!best || d < best.d) best = { s, d };
    }
    side = best.s;
  }
  if (!side) {
    const dx = (target.x + target.width / 2) - (source.x + source.width / 2);
    const dy = (target.y + target.height / 2) - (source.y + source.height / 2);
    side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'left' : 'right') : (dy >= 0 ? 'top' : 'bottom');
  }
  return { from: { x: from.x, y: from.y }, to: { x: toAnchors[side].x, y: toAnchors[side].y }, fromSide, toSide: side };
}

// ---- Miro connector parity (live-measured catalog, 2026-08-30) ---------------
// Two-tier drag targeting, Excalidraw-focus pinned body bindings, elbow clearance
// routing, per-fraction labels, endpoint/waypoint editing, and the native arrowhead
// set. All pure; the canvas JSX only executes these decisions.

const EDGE_REVEAL = 25; // px: target rings appear within this of the shape EDGE (finding 7)
const ELBOW_CLEARANCE = 28; // px: elbow routing clears shape bodies by this (finding 17)
const ELBOW_CORNER_RADIUS = 8; // px: elbow corners round at roughly this radius (finding 17)

// The on-edge side midpoints of a box: where the TARGET rings render during a drag
// (finding 7: ON the border, unlike the source dots which float outside).
function edgeMidpoints(box) {
  return {
    top: { x: box.x + box.width / 2, y: box.y },
    right: { x: box.x + box.width, y: box.y + box.height / 2 },
    bottom: { x: box.x + box.width / 2, y: box.y + box.height },
    left: { x: box.x, y: box.y + box.height / 2 },
  };
}

// Miro's two-tier targeting while a connector end is dragged (findings 7, 8, 9):
// within snapRadius of a side midpoint = 'dot' (that anchor lights and the head parks
// on it); inside the body = 'body' (the whole shape highlights, the head parks at the
// crossed edge); within edgeReveal of the edge = 'edge' (the rings reveal, nothing
// lit); further out = null. box, x, y share one coordinate space (client px).
function classifyDragPoint(box, x, y, { snapRadius = SNAP_RADIUS, edgeReveal = EDGE_REVEAL } = {}) {
  const mids = edgeMidpoints(box);
  const dot = nearestAnchorSide(mids, x, y, snapRadius);
  if (dot) return { mode: 'dot', side: dot.side, point: dot.point, mids };
  const inside = x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
  if (inside) return { mode: 'body', mids };
  const dx = Math.max(box.x - x, 0, x - (box.x + box.width));
  const dy = Math.max(box.y - y, 0, y - (box.y + box.height));
  if (Math.hypot(dx, dy) <= edgeReveal) return { mode: 'edge', mids };
  return null;
}

// Where the segment from `from` (outside) to `to` (inside) first crosses the box
// boundary: the point the preview arrowhead parks at while the cursor is over the
// body (finding 9). Null when the segment never enters the box.
function segmentBoxEntry(box, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let tMin = 0;
  let tMax = 1;
  for (const [p, d, lo, hi] of [
    [from.x, dx, box.x, box.x + box.width],
    [from.y, dy, box.y, box.y + box.height],
  ]) {
    if (d === 0) { if (p < lo || p > hi) return null; continue; }
    let t1 = (lo - p) / d;
    let t2 = (hi - p) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMin <= 0 || tMin > 1) return null;
  return { x: from.x + dx * tMin, y: from.y + dy * tMin };
}

// ---- Excalidraw binding focus, ported for angle-0 shapes ---------------------
// A body drop pins the endpoint via Excalidraw's OWN binding model: focus positions
// the aim line and gap 0 makes the recomputed endpoint LAND on the focus point
// (updateBoundPoint's gap===0 branch), so the endpoint travels with the shape and the
// entry edge migrates (finding 10). These mirror determineFocusDistance /
// determineFocusPoint in @excalidraw/excalidraw 0.18.1 exactly (angle 0), because the
// value is consumed by Excalidraw's own re-binding math when the shape later moves.
function crossV(ax, ay, bx, by) { return ax * by - bx * ay; }

function segSegIntersection(a1, a2, b1, b2) {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const denom = crossV(d1x, d1y, d2x, d2y);
  if (Math.abs(denom) < 1e-12) return null;
  const t = crossV(b1[0] - a1[0], b1[1] - a1[1], d2x, d2y) / denom;
  const u = crossV(b1[0] - a1[0], b1[1] - a1[1], d1x, d1y) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return [a1[0] + d1x * t, a1[1] + d1y * t];
}

function bindingFocusFromDrop(element, a, b) {
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) return 0;
  const sign = Math.sign(crossV(b.x - a.x, b.y - a.y, b.x - cx, b.y - cy)) * -1;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const reach = Math.max(element.width * 2, element.height * 2);
  const q = [b.x + ((b.x - a.x) / len) * reach, b.y + ((b.y - a.y) / len) * reach];
  const { x, y, width: w, height: h } = element;
  const interceptees = element.type === 'diamond'
    ? [
      [[x + w / 2, y - h], [x + w / 2, y + h * 2]],
      [[x - w, y + h / 2], [x + w * 2, y + h / 2]],
    ]
    : [
      [[x - w, y - h], [x + w * 2, y + h * 2]],
      [[x + w * 2, y - h], [x - w, y + h * 2]],
    ];
  const axesHalf = element.type === 'diamond' ? [h / 2, w / 2] : [Math.hypot(w, h) / 2, Math.hypot(w, h) / 2];
  const hits = interceptees
    .map((seg) => segSegIntersection([b.x, b.y], q, seg[0], seg[1]))
    .filter((p) => p !== null)
    .sort((g, k) => ((g[0] - b.x) ** 2 + (g[1] - b.y) ** 2) - ((k[0] - b.x) ** 2 + (k[1] - b.y) ** 2))
    .map((p, idx) => sign * Math.hypot(cx - p[0], cy - p[1]) / axesHalf[idx])
    .sort((g, k) => Math.abs(g) - Math.abs(k));
  return hits[0] ?? 0;
}

function bindingFocusPoint(element, focus, adjacentPoint) {
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  if (focus === 0) return { x: cx, y: cy };
  const { x, y, width: w, height: h } = element;
  const corners = element.type === 'diamond'
    ? [[x, y + h / 2], [x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h]]
    : [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const c = corners.map(([px, py]) => [cx + (px - cx) * Math.abs(focus), cy + (py - cy) * Math.abs(focus)]);
  const adj = [adjacentPoint.x, adjacentPoint.y];
  const edge = (i, j) => crossV(adj[0] - c[i][0], adj[1] - c[i][1], c[j][0] - c[i][0], c[j][1] - c[i][1]);
  const selected = [
    edge(0, 1) > 0 && (focus > 0 ? edge(1, 2) < 0 : edge(3, 0) < 0),
    edge(1, 2) > 0 && (focus > 0 ? edge(2, 3) < 0 : edge(0, 1) < 0),
    edge(2, 3) > 0 && (focus > 0 ? edge(3, 0) < 0 : edge(1, 2) < 0),
    edge(3, 0) > 0 && (focus > 0 ? edge(0, 1) < 0 : edge(2, 3) < 0),
  ];
  const pick = selected[0] ? (focus > 0 ? c[1] : c[0])
    : selected[1] ? (focus > 0 ? c[2] : c[1])
      : selected[2] ? (focus > 0 ? c[3] : c[2])
        : (focus > 0 ? c[0] : c[3]);
  return { x: pick[0], y: pick[1] };
}

// ---- Label position fractions along a connector (finding 22) -----------------
function polylineSpans(points) {
  const spans = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const len = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    spans.push({ from: points[i], to: points[i + 1], len, start: total });
    total += len;
  }
  return { spans, total };
}

// The point a fraction t (arc length) along the polyline, in the polyline's own
// (element-local) coordinates. A missing fraction reads as the midpoint, which is
// what upgrades old centre-labelled boards without touching them.
function pointAtFraction(points, t) {
  const frac = typeof t === 'number' && Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0.5;
  if (!Array.isArray(points) || points.length === 0) return [0, 0];
  if (points.length === 1) return [points[0][0], points[0][1]];
  const { spans, total } = polylineSpans(points);
  if (total === 0) return [points[0][0], points[0][1]];
  const want = frac * total;
  for (const span of spans) {
    if (want <= span.start + span.len || span === spans[spans.length - 1]) {
      const k = span.len === 0 ? 0 : (want - span.start) / span.len;
      return [span.from[0] + (span.to[0] - span.from[0]) * k, span.from[1] + (span.to[1] - span.from[1]) * k];
    }
  }
  return [points[points.length - 1][0], points[points.length - 1][1]];
}

// Project a point onto the polyline: the fraction of the nearest spot plus its
// distance, so a double-click anywhere on a connector knows where along it landed.
function nearestFractionOnPolyline(points, x, y) {
  const { spans, total } = polylineSpans(points);
  if (!spans.length || total === 0) return { t: 0.5, distance: Math.hypot(x - (points?.[0]?.[0] || 0), y - (points?.[0]?.[1] || 0)) };
  let best = null;
  for (const span of spans) {
    const dx = span.to[0] - span.from[0];
    const dy = span.to[1] - span.from[1];
    const lenSq = dx * dx + dy * dy;
    const k = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - span.from[0]) * dx + (y - span.from[1]) * dy) / lenSq));
    const px = span.from[0] + dx * k;
    const py = span.from[1] + dy * k;
    const d = Math.hypot(x - px, y - py);
    if (!best || d < best.distance) best = { distance: d, t: (span.start + span.len * k) / total };
  }
  return best;
}

// Keep every fraction label glued to its connector: text tagged
// customData.labelFor pointing at an ARROW re-centres on pointAtFraction of the
// arrow's live points (so it survives re-route, routing-type changes, and moves),
// and follows the arrow into deletion (the sticky-shadow contract: tombstoned, not
// dropped, because updateScene merges by id). A labelFor text whose host is a poly
// SHAPE is the CLI's centred label and is deliberately untouched.
function syncConnectorLabels(elements) {
  const byId = new Map(elements.map((el) => [el.id, el]));
  let changed = false;
  const out = elements.map((el) => {
    if (el.type !== 'text' || el.isDeleted || !el.customData || !el.customData.labelFor) return el;
    const host = byId.get(el.customData.labelFor);
    if (!host) {
      // Only OUR fraction labels tombstone on a hard-missing host; a CLI label
      // with no fraction keeps the CLI's own missing-host validation story.
      if (typeof el.customData.labelFraction === 'number') { changed = true; return { ...el, isDeleted: true }; }
      return el;
    }
    if (host.type !== 'arrow') return el;
    if (host.isDeleted) { changed = true; return { ...el, isDeleted: true }; }
    const [lx, ly] = pointAtFraction(host.points || [[0, 0], [0, 0]], el.customData.labelFraction);
    const wantX = host.x + lx - el.width / 2;
    const wantY = host.y + ly - el.height / 2;
    if (Math.abs(el.x - wantX) > 0.5 || Math.abs(el.y - wantY) > 0.5) {
      changed = true;
      return { ...el, x: wantX, y: wantY };
    }
    return el;
  });
  return { elements: out, changed };
}

// ---- Endpoint and waypoint editing (findings 19, 20, 21) ---------------------
// Excalidraw keeps points[0] at [0,0] with (x, y) the first point's absolute
// position, so moving the START endpoint rebases the whole element while moving the
// END only rewrites the last point. Interior points keep their absolute positions.
function moveConnectorEndpoint(el, whichEnd, absX, absY) {
  const pts = el.points.map((p) => [p[0], p[1]]);
  if (whichEnd === 'start') {
    const ddx = absX - el.x;
    const ddy = absY - el.y;
    const moved = pts.map((p, i) => (i === 0 ? [0, 0] : [p[0] - ddx, p[1] - ddy]));
    return { ...el, x: absX, y: absY, points: moved };
  }
  pts[pts.length - 1] = [absX - el.x, absY - el.y];
  return { ...el, points: pts };
}

// Bend: insert a waypoint into span k at the dragged point (finding 20). Each half
// then reads as its own span, which is what makes repeated bending subdivide.
function bendConnectorAt(el, spanIndex, absX, absY) {
  const pts = el.points.map((p) => [p[0], p[1]]);
  const at = Math.max(0, Math.min(pts.length - 2, spanIndex)) + 1;
  pts.splice(at, 0, [absX - el.x, absY - el.y]);
  return { ...el, points: pts };
}

function moveConnectorPoint(el, index, absX, absY) {
  const pts = el.points.map((p) => [p[0], p[1]]);
  if (index <= 0 || index >= pts.length - 1) return el;
  pts[index] = [absX - el.x, absY - el.y];
  return { ...el, points: pts };
}

// The LOGICAL elbow waypoints: the orthogonal corners the segment handles work on,
// carried in customData.elbow (points itself holds the rounded expansion). An elbow
// from before the rounding era falls back to its raw points.
function elbowWaypoints(el) {
  const stored = el.customData?.elbow?.waypoints;
  if (Array.isArray(stored) && stored.length >= 2) return stored.map((p) => [p[0], p[1]]);
  return (el.points || []).map((p) => [p[0], p[1]]);
}

// Drag an elbow SEGMENT orthogonally (finding 21): a vertical segment moves in x, a
// horizontal one in y; adjacent segments stretch. Endpoint-touching segments refuse
// (the endpoints have their own rings, and translating them would silently detach).
function translateElbowSegment(el, segIndex, dxAbs, dyAbs) {
  const wps = elbowWaypoints(el);
  if (segIndex < 1 || segIndex > wps.length - 3) return el;
  const vertical = wps[segIndex][0] === wps[segIndex + 1][0];
  const next = wps.map((p) => [p[0], p[1]]);
  if (vertical) {
    next[segIndex][0] += dxAbs;
    next[segIndex + 1][0] += dxAbs;
  } else {
    next[segIndex][1] += dyAbs;
    next[segIndex + 1][1] += dyAbs;
  }
  return {
    ...el,
    points: roundElbowCorners(next, ELBOW_CORNER_RADIUS),
    roundness: null,
    customData: { ...(el.customData || {}), elbow: { waypoints: next } },
  };
}

// ---- Orthogonal elbow routing with clearance (finding 17) --------------------
function inflateBox(box, m) {
  return { x: box.x - m, y: box.y - m, width: box.width + 2 * m, height: box.height + 2 * m };
}

// Does an axis-aligned segment cross the box INTERIOR (boundary-riding allowed)?
function segCrossesBox(box, p, q) {
  const eps = 0.01;
  if (p[0] === q[0]) {
    if (p[0] <= box.x + eps || p[0] >= box.x + box.width - eps) return false;
    const y1 = Math.min(p[1], q[1]);
    const y2 = Math.max(p[1], q[1]);
    return y2 > box.y + eps && y1 < box.y + box.height - eps;
  }
  if (p[1] <= box.y + eps || p[1] >= box.y + box.height - eps) return false;
  const x1 = Math.min(p[0], q[0]);
  const x2 = Math.max(p[0], q[0]);
  return x2 > box.x + eps && x1 < box.x + box.width - eps;
}

// Which side of a box a point sits on (nearest boundary), or null when it is not
// on or near the box at all. Decides the outward stub direction for a bound end.
function boxSideOfPoint(box, p) {
  const within = p[0] >= box.x - 2 && p[0] <= box.x + box.width + 2 && p[1] >= box.y - 2 && p[1] <= box.y + box.height + 2;
  if (!within) return null;
  const d = [
    ['left', Math.abs(p[0] - box.x)],
    ['right', Math.abs(p[0] - (box.x + box.width))],
    ['top', Math.abs(p[1] - box.y)],
    ['bottom', Math.abs(p[1] - (box.y + box.height))],
  ].sort((a, b) => a[1] - b[1]);
  return d[0][0];
}

const SIDE_DIR = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

// A small orthogonal router: stub out of each bound shape by the clearance, then
// find a rectilinear path between the stubs over a sparse grid of channel
// coordinates, refusing to cross any obstacle's clearance-inflated body. Cost is
// bends first, length second. With no reachable path (or no obstacles at all) it
// falls back to the blind L, which is the pre-clearance behaviour.
function orthogonalRoute(start, end, obstacles = [], clearance = ELBOW_CLEARANCE) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const blindL = Math.abs(dx) >= Math.abs(dy)
    ? [start, [start[0] + dx / 2, start[1]], [start[0] + dx / 2, end[1]], end]
    : [start, [start[0], start[1] + dy / 2], [end[0], start[1] + dy / 2], end];
  if (!obstacles.length) return simplifyOrtho(blindL);

  const sideS = obstacles.map((box) => boxSideOfPoint(box, start)).find(Boolean) || null;
  const sideE = obstacles.map((box) => boxSideOfPoint(box, end)).find(Boolean) || null;
  const dirS = sideS ? SIDE_DIR[sideS] : null;
  const dirE = sideE ? SIDE_DIR[sideE] : null;
  const s2 = dirS ? [start[0] + dirS[0] * clearance, start[1] + dirS[1] * clearance] : start;
  const e2 = dirE ? [end[0] + dirE[0] * clearance, end[1] + dirE[1] * clearance] : end;

  // Channel coordinates: the stub points plus each obstacle's clearance ring.
  const xs = new Set([s2[0], e2[0]]);
  const ys = new Set([s2[1], e2[1]]);
  for (const box of obstacles) {
    xs.add(box.x - clearance);
    xs.add(box.x + box.width + clearance);
    ys.add(box.y - clearance);
    ys.add(box.y + box.height + clearance);
  }
  const gx = [...xs].sort((a, b) => a - b);
  const gy = [...ys].sort((a, b) => a - b);
  const blocked = obstacles.map((box) => inflateBox(box, clearance - 1));
  const key = (i, j) => `${i},${j}`;
  const si = gx.indexOf(s2[0]);
  const sj = gy.indexOf(s2[1]);
  const ei = gx.indexOf(e2[0]);
  const ej = gy.indexOf(e2[1]);
  // Dijkstra by (bends, length), tracking arrival direction.
  const best = new Map();
  const queue = [{ i: si, j: sj, dir: dirS ? (dirS[0] !== 0 ? 'h' : 'v') : null, bends: 0, len: 0, path: [[s2[0], s2[1]]] }];
  let found = null;
  while (queue.length) {
    queue.sort((a, b) => (a.bends - b.bends) || (a.len - b.len));
    const cur = queue.shift();
    const k = key(cur.i, cur.j) + (cur.dir || '');
    const prev = best.get(k);
    if (prev && (prev.bends < cur.bends || (prev.bends === cur.bends && prev.len <= cur.len))) continue;
    best.set(k, { bends: cur.bends, len: cur.len });
    if (cur.i === ei && cur.j === ej) { found = cur; break; }
    for (const [di, dj, dir] of [[1, 0, 'h'], [-1, 0, 'h'], [0, 1, 'v'], [0, -1, 'v']]) {
      const ni = cur.i + di;
      const nj = cur.j + dj;
      if (ni < 0 || nj < 0 || ni >= gx.length || nj >= gy.length) continue;
      const from = [gx[cur.i], gy[cur.j]];
      const to = [gx[ni], gy[nj]];
      if (blocked.some((box) => segCrossesBox(box, from, to))) continue;
      const bends = cur.bends + (cur.dir && cur.dir !== dir ? 1 : 0);
      const len = cur.len + Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]);
      queue.push({ i: ni, j: nj, dir, bends, len, path: [...cur.path, to] });
    }
  }
  if (!found) return simplifyOrtho(blindL);
  const path = [start, ...found.path, ...(dirE ? [end] : [])];
  if (!dirE && (path[path.length - 1][0] !== end[0] || path[path.length - 1][1] !== end[1])) path.push(end);
  return simplifyOrtho(path);
}

// Drop duplicate and colinear intermediate points from an orthogonal path.
function simplifyOrtho(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) continue;
    out.push([p[0], p[1]]);
  }
  for (let i = out.length - 2; i >= 1; i -= 1) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) out.splice(i, 1);
  }
  return out;
}

// Round each interior corner of an orthogonal polyline at ~radius px: the corner
// point becomes flank-arc-flank (an 8px corner reads rounded at board scale without
// roundness, which on a multi-point line would bow the STRAIGHT runs too).
function roundElbowCorners(points, radius) {
  if (!Array.isArray(points) || points.length < 3 || radius <= 0) return (points || []).map((p) => [p[0], p[1]]);
  const out = [[points[0][0], points[0][1]]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i - 1];
    const c = points[i];
    const n = points[i + 1];
    const inLen = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const outLen = Math.hypot(n[0] - c[0], n[1] - c[1]);
    if (inLen < 1e-6 || outLen < 1e-6) { out.push([c[0], c[1]]); continue; }
    const inDir = [(c[0] - p[0]) / inLen, (c[1] - p[1]) / inLen];
    const outDir = [(n[0] - c[0]) / outLen, (n[1] - c[1]) / outLen];
    const orthogonal = Math.abs(inDir[0] * outDir[0] + inDir[1] * outDir[1]) < 1e-6;
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (!orthogonal || r < 0.75) { out.push([c[0], c[1]]); continue; }
    const f1 = [c[0] - inDir[0] * r, c[1] - inDir[1] * r];
    const f2 = [c[0] + outDir[0] * r, c[1] + outDir[1] * r];
    const center = [c[0] - inDir[0] * r + outDir[0] * r, c[1] - inDir[1] * r + outDir[1] * r];
    const toC = [c[0] - center[0], c[1] - center[1]];
    const mag = Math.hypot(toC[0], toC[1]) || 1;
    const mid = [center[0] + (toC[0] / mag) * r, center[1] + (toC[1] / mag) * r];
    out.push([Number(f1[0].toFixed(2)), Number(f1[1].toFixed(2))]);
    out.push([Number(mid[0].toFixed(2)), Number(mid[1].toFixed(2))]);
    out.push([Number(f2[0].toFixed(2)), Number(f2[1].toFixed(2))]);
  }
  out.push([points[points.length - 1][0], points[points.length - 1][1]]);
  return out;
}

// ---- The native arrowhead set (finding 25) -----------------------------------
// Exactly what Excalidraw 0.18.1 draws (verified against the shipped bundle), plus
// None. Miro's remaining heads (double bar, circle+crowfoot, circle+bar, and its
// duplicate small-solid-arrow) have no native Excalidraw drawing and are SKIPPED
// rather than faked.
const ARROWHEADS = [
  { key: 'none', value: null, label: 'None' },
  { key: 'arrow', value: 'arrow', label: 'Open arrow' },
  { key: 'triangle', value: 'triangle', label: 'Solid arrow' },
  { key: 'triangle-outline', value: 'triangle_outline', label: 'Open triangle' },
  { key: 'diamond', value: 'diamond', label: 'Solid diamond' },
  { key: 'diamond-outline', value: 'diamond_outline', label: 'Open diamond' },
  { key: 'circle', value: 'circle', label: 'Solid circle' },
  { key: 'circle-outline', value: 'circle_outline', label: 'Open circle' },
  { key: 'bar', value: 'bar', label: 'Bar' },
  { key: 'crowfoot-one', value: 'crowfoot_one', label: 'ERD one' },
  { key: 'crowfoot-many', value: 'crowfoot_many', label: 'ERD many' },
  { key: 'crowfoot-one-or-many', value: 'crowfoot_one_or_many', label: 'ERD one or many' },
];

function setConnectorHead(elements, selectedIds, whichEnd, value) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const prop = whichEnd === 'start' ? 'startArrowhead' : 'endArrowhead';
  return elements.map((el) => (
    ids.has(el.id) && CONNECTOR_TYPES.includes(el.type) && !isPolyShape(el) ? { ...el, [prop]: value ?? null } : el
  ));
}

// Miro's "Swap line ends": which end carries which arrowhead flips (finding 23).
function swapConnectorHeads(elements, selectedIds) {
  const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  return elements.map((el) => (
    ids.has(el.id) && CONNECTOR_TYPES.includes(el.type) && !isPolyShape(el)
      ? { ...el, startArrowhead: el.endArrowhead ?? null, endArrowhead: el.startArrowhead ?? null }
      : el
  ));
}

// Excalidraw's linear-element invariant: points[0] must be exactly [0, 0] with
// (x, y) the first point's absolute position; its LinearElementEditor logs
// "Linear element is not normalized" whenever a selection finds otherwise, and
// its own interactive passes can leave a sub-pixel offset behind on arrows we
// author. This repair shifts x/y by the stray offset and rebases every point, so
// every ABSOLUTE position is untouched while the invariant is restored.
function normalizeLinearPoints(elements) {
  let changed = false;
  const out = elements.map((el) => {
    if (!el || el.isDeleted || !['arrow', 'line'].includes(el.type)) return el;
    const pts = el.points;
    if (!Array.isArray(pts) || !pts.length) return el;
    const [ox, oy] = pts[0];
    if (Math.abs(ox) < 1e-6 && Math.abs(oy) < 1e-6) return el;
    changed = true;
    return {
      ...el,
      x: el.x + ox,
      y: el.y + oy,
      points: pts.map((p) => [p[0] - ox, p[1] - oy]),
    };
  });
  return { elements: out, changed };
}

// ---- Bind and detach one connector end (finding 19) --------------------------
// Detaching clears the arrow's binding AND the target's mirrored boundElements
// entry, unless the arrow's OTHER end still binds the same shape (one mirror entry
// serves both ends). Binding restores both sides, deduped.
function detachConnectorEnd(elements, arrowId, whichEnd) {
  const arrow = elements.find((el) => el.id === arrowId);
  if (!arrow) return elements;
  const prop = whichEnd === 'start' ? 'startBinding' : 'endBinding';
  const otherProp = whichEnd === 'start' ? 'endBinding' : 'startBinding';
  const oldTarget = arrow[prop]?.elementId || null;
  const otherTarget = arrow[otherProp]?.elementId || null;
  return elements.map((el) => {
    if (el.id === arrowId) return { ...el, [prop]: null };
    if (el.id === oldTarget && oldTarget !== otherTarget) {
      return { ...el, boundElements: (el.boundElements || []).filter((b) => !(b.type === 'arrow' && b.id === arrowId)) };
    }
    return el;
  });
}

function bindConnectorEnd(elements, arrowId, whichEnd, binding) {
  const prop = whichEnd === 'start' ? 'startBinding' : 'endBinding';
  return elements.map((el) => {
    if (el.id === arrowId) return { ...el, [prop]: binding };
    if (el.id === binding.elementId) {
      const bound = el.boundElements || [];
      if (bound.some((b) => b.type === 'arrow' && b.id === arrowId)) return el;
      return { ...el, boundElements: [...bound, { id: arrowId, type: 'arrow' }] };
    }
    return el;
  });
}

module.exports = {
  SAVE_DELAY_MS,
  FLUSH_DELAY_MS,
  STICKY_SIZE,
  DEFAULT_STICKY,
  STICKY_COLORS,
  STICKY_SHADOW_BANDS,
  STICKY_SHADOW_COLOR,
  STICKY_SHADOW_DX,
  STICKY_SHADOW_DY,
  STYLE_COLORS,
  STROKE_WIDTHS,
  BRAND_COLORS,
  ALL_COLORS,
  PALETTE_SECTIONS,
  RECENT_COLORS_MAX,
  normalizeHex,
  rgbaToHex,
  addRecentColor,
  SHAPE_DEFS,
  SHAPE_GROUPS,
  SHAPE_FILL,
  SHAPE_STROKE,
  shapeDef,
  shapeSkeleton,
  isPolyShape,
  regularPolygon,
  starPolygon,
  arcPoints,
  bowSegment,
  unitPolygon,
  TABLE_CELL_W,
  TABLE_CELL_H,
  tableSkeleton,
  tableCells,
  tableColumnSkeletons,
  tableRowSkeletons,
  tableRemoveRow,
  tableRemoveColumn,
  selectionTableId,
  TEMPLATES,
  stickyColor,
  stickyNoteSkeleton,
  isStickyShadow,
  syncStickyShadows,
  STICKY_SIZES,
  STICKY_FONT_MAX,
  STICKY_FONT_MIN,
  STICKY_TEXT_PAD,
  STICKY_LINE_HEIGHT,
  fitStickyFontSize,
  fitStickyLabels,
  stickyFaceIds,
  selectionStickyFace,
  ZOOM_MIN,
  ZOOM_MAX,
  zoomAtPoint,
  wheelZoomPlan,
  MINIMAP_W,
  MINIMAP_H,
  minimapPlan,
  minimapJump,
  reorderElements,
  dotGridStyle,
  recolorElements,
  recolorText,
  selectionHasText,
  selectionTextColor,
  setSelectionProp,
  selectionStyle,
  selectionOpacity,
  selectionSceneBox,
  sceneBoxToClient,
  toolbarPlacement,
  TOOLBAR_GAP,
  TOOLBAR_MARGIN,
  BORDER_STYLES,
  selectionStrokeStyle,
  DEFAULT_CORNER_RADIUS,
  cornerRoundness,
  setCornerRadius,
  selectionRadiusEditable,
  selectionCornerRadius,
  SWITCH_TYPE_KEYS,
  selectionShapeKey,
  isSwitchable,
  switchShapeType,
  SHAPE_STYLE_KEYS,
  TEXT_STYLE_KEYS,
  copySelectionStyle,
  pasteSelectionStyle,
  BOARD_FONTS,
  TEXT_ALIGNS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  selectionTextStyle,
  wrapTextToWidth,
  layoutBoundText,
  setTextProp,
  ARRANGE_OPS,
  CONNECTABLE_TYPES,
  isConnectable,
  syncPolyConnectors,
  lockElements,
  selectionLocked,
  unlockAllElements,
  hasLockedElements,
  clearSelectionContent,
  selectionHasContent,
  DUPLICATE_GAP,
  duplicateElements,
  selectableIds,
  CONTEXT_ROWS,
  contextMenuModel,
  CONTEXT_MENU_WIDTH,
  contextMenuPlacement,
  FRAME_PRESETS,
  framePreset,
  frameSkeleton,
  selectionIsConnector,
  setConnectorRouting,
  setConnectorDash,
  setConnectorHeads,
  connectorStyle,
  routeConnector,
  viewportCenterScene,
  placeCentered,
  appStatePersistSignature,
  boardChanged,
  mergeBoardScene,
  newBoardFiles,
  availableBoardId,
  boardSlug,
  debouncePlan,
  orderBoards,
  filterBoards,
  duplicateName,
  boardHue,
  SNAP_RADIUS,
  anchorPoints,
  nearestAnchorSide,
  connectorPlan,
  EDGE_REVEAL,
  ELBOW_CLEARANCE,
  ELBOW_CORNER_RADIUS,
  edgeMidpoints,
  classifyDragPoint,
  segmentBoxEntry,
  bindingFocusFromDrop,
  bindingFocusPoint,
  pointAtFraction,
  nearestFractionOnPolyline,
  syncConnectorLabels,
  moveConnectorEndpoint,
  bendConnectorAt,
  moveConnectorPoint,
  elbowWaypoints,
  translateElbowSegment,
  orthogonalRoute,
  roundElbowCorners,
  ARROWHEADS,
  setConnectorHead,
  swapConnectorHeads,
  normalizeLinearPoints,
  detachConnectorEnd,
  bindConnectorEnd,
};
