import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  restore,
  serializeAsJSON,
  getSceneVersion,
  convertToExcalidrawElements,
  exportToBlob,
  CaptureUpdateAction,
  FONT_FAMILY,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import boardFiles from './board-files.cjs';

const {
  FLUSH_DELAY_MS,
  anchorPoints,
  connectorPlan,
  classifyDragPoint,
  segmentBoxEntry,
  bindingFocusFromDrop,
  pointAtFraction,
  nearestFractionOnPolyline,
  syncConnectorLabels,
  normalizeLinearPoints,
  moveConnectorEndpoint,
  bendConnectorAt,
  moveConnectorPoint,
  elbowWaypoints,
  translateElbowSegment,
  routeConnector,
  ARROWHEADS,
  setConnectorHead,
  swapConnectorHeads,
  detachConnectorEnd,
  bindConnectorEnd,
  STICKY_SIZE,
  STICKY_SIZES,
  DEFAULT_STICKY,
  STICKY_COLORS,
  fitStickyLabels,
  selectionStickyFace,
  zoomAtPoint,
  wheelZoomPlan,
  MINIMAP_W,
  MINIMAP_H,
  minimapPlan,
  minimapJump,
  reorderElements,
  dotGridStyle,
  STYLE_COLORS,
  STROKE_WIDTHS,
  PALETTE_SECTIONS,
  selectionSceneBox,
  sceneBoxToClient,
  toolbarPlacement,
  BORDER_STYLES,
  selectionStrokeStyle,
  setCornerRadius,
  selectionRadiusEditable,
  selectionCornerRadius,
  SWITCH_TYPE_KEYS,
  selectionShapeKey,
  switchShapeType,
  copySelectionStyle,
  pasteSelectionStyle,
  BOARD_FONTS,
  TEXT_ALIGNS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  selectionTextStyle,
  setTextProp,
  ARRANGE_OPS,
  normalizeHex,
  rgbaToHex,
  addRecentColor,
  SHAPE_DEFS,
  SHAPE_GROUPS,
  shapeDef,
  shapeSkeleton,
  isPolyShape,
  syncPolyConnectors,
  isConnectable,
  lockElements,
  selectionLocked,
  unlockAllElements,
  hasLockedElements,
  clearSelectionContent,
  selectionHasContent,
  duplicateElements,
  selectableIds,
  contextMenuModel,
  CONTEXT_MENU_WIDTH,
  contextMenuPlacement,
  FRAME_PRESETS,
  frameSkeleton,
  TABLE_CELL_W,
  TABLE_CELL_H,
  tableSkeleton,
  tableColumnSkeletons,
  tableRowSkeletons,
  tableRemoveRow,
  tableRemoveColumn,
  selectionTableId,
  TEMPLATES,
  stickyNoteSkeleton,
  isStickyShadow,
  syncStickyShadows,
  placeCentered,
  appStatePersistSignature,
  boardChanged,
  mergeBoardScene,
  newBoardFiles,
  recolorElements,
  recolorText,
  selectionHasText,
  selectionTextColor,
  setSelectionProp,
  selectionStyle,
  selectionOpacity,
  selectionIsConnector,
  setConnectorRouting,
  setConnectorDash,
  connectorStyle,
} = boardFiles;

// Excalidraw is the engine; the chrome is ours. New content defaults to clean
// lines, solid fills, and a clean sans (Nunito) instead of Excalidraw's sketchy
// hachure + hand-drawn-font look, which reads much closer to Miro.
const CLEAN_FONT = FONT_FAMILY.Nunito;
const ITEM_DEFAULTS = { currentItemRoughness: 0, currentItemFillStyle: 'solid', currentItemFontFamily: CLEAN_FONT };

function stableAppState(appState) {
  return {
    ...appState,
    collaborators: undefined,
    editingElement: null,
    openMenu: null,
    openPopup: null,
    selectedElementIds: {},
    selectedGroupIds: {},
  };
}

function isTypingTarget() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

const svg = (children) => (
  <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

const TOOL_ICONS = {
  selection: svg(<path d="M5 3l0 13 3.2-3.2 2 4.6 2-.9-2-4.5 4.6 0z" />),
  hand: svg(<><path d="M10 3v14M3 10h14" /><path d="M7.5 5.5 10 3l2.5 2.5M7.5 14.5 10 17l2.5-2.5M5.5 7.5 3 10l2.5 2.5M14.5 7.5 17 10l-2.5 2.5" /></>),
  sticky: svg(<><path d="M4 4h12v8l-4 4H4z" /><path d="M16 12h-4v4" /></>),
  text: svg(<path d="M5 5h10M10 5v11M7.5 16h5" />),
  rectangle: svg(<rect x="4" y="5.5" width="12" height="9" rx="1.4" />),
  ellipse: svg(<ellipse cx="10" cy="10" rx="7" ry="5.5" />),
  diamond: svg(<path d="M10 3l7 7-7 7-7-7z" />),
  arrow: svg(<path d="M4 10h11M11 6l4 4-4 4" />),
  line: svg(<path d="M4 15 16 5" />),
  freedraw: svg(<><path d="M4 16l1-3 8-8 2 2-8 8z" /><path d="M12.5 5.5l2 2" /></>),
  frame: svg(<path d="M6 3v14M14 3v14M3 6h14M3 14h14" />),
  image: svg(<><rect x="4" y="5" width="12" height="10" rx="1.4" /><circle cx="8" cy="9" r="1.1" /><path d="M5 14l3.5-3.5 3 3 2.5-2.5L16 13" /></>),
  eraser: svg(<><path d="M7 15l-2-2 7-7 4 4-5 5z" /><path d="M7 15h8" /></>),
  laser: svg(<><circle cx="10" cy="10" r="2.2" /><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6 15 15M15 5l-1.4 1.4M6.4 13.6 5 15" /></>),
};

const CHROME_ICONS = {
  templates: svg(<><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><rect x="11" y="11" width="6" height="6" rx="1" /></>),
  grid: svg(<><rect x="3" y="3" width="14" height="14" rx="1" /><path d="M8 3v14M13 3v14M3 8h14M3 13h14" /></>),
  snap: svg(<><path d="M6 4v6a4 4 0 008 0V4" /><path d="M5 4h3M12 4h3" /></>),
  zoomFit: svg(<><path d="M4 7V4h3M16 4h3v3M4 13v3h3M16 16h3v-3" /><rect x="7.5" y="7.5" width="5" height="5" rx="1" /></>),
  table: svg(<><rect x="3" y="4" width="14" height="12" rx="1" /><path d="M3 8h14M3 12h14M8 4v12M13 4v12" /></>),
};

// Insert-table sizes offered by the Table flyout (Miro asks rows x columns).
const TABLE_SIZES = [
  { key: '2x2', rows: 2, cols: 2, label: '2 x 2' },
  { key: '3x2', rows: 3, cols: 2, label: '3 x 2' },
  { key: '3x3', rows: 3, cols: 3, label: '3 x 3' },
  { key: '4x3', rows: 4, cols: 3, label: '4 x 3' },
  { key: '5x4', rows: 5, cols: 4, label: '5 x 4' },
];

// A shape flyout icon: native shapes use hand-drawn glyphs; poly shapes derive their icon
// straight from the same normalized points that build the real element, so the button
// always shows exactly what it draws.
const polyIconPath = (points) => `${points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${(3 + px * 14).toFixed(1)} ${(3 + py * 14).toFixed(1)}`).join(' ')} Z`;
const NATIVE_SHAPE_ICONS = {
  rectangle: svg(<rect x="4" y="5.5" width="12" height="9" rx="1" />),
  rounded: svg(<rect x="4" y="5.5" width="12" height="9" rx="3.2" />),
  ellipse: svg(<ellipse cx="10" cy="10" rx="7" ry="5.5" />),
  diamond: svg(<path d="M10 3l7 7-7 7-7-7z" />),
};
const shapeIcon = (def) => (def.kind === 'native' ? NATIVE_SHAPE_ICONS[def.key] : svg(<path d={polyIconPath(def.points)} />));

// Connector style-bar options (Miro parity): routing, line style, and end caps.
const CONNECTOR_ROUTINGS = [
  { key: 'straight', label: 'Straight', icon: svg(<path d="M4 16 16 4" />) },
  { key: 'curved', label: 'Curved', icon: svg(<path d="M4 16C4 9 16 11 16 4" />) },
  { key: 'elbow', label: 'Elbow', icon: svg(<path d="M4 4v8a2 2 0 002 2h10" />) },
];
const CONNECTOR_DASHES = [
  { key: 'solid', label: 'Solid', dash: null },
  { key: 'dashed', label: 'Dashed', dash: '4 3' },
  { key: 'dotted', label: 'Dotted', dash: '1.6 3' },
];
// One mini glyph per native arrowhead (finding 25): a line running left to right
// with the head drawn at the right end; the START picker mirrors it with CSS.
const HEAD_GLYPHS = {
  none: <line x1="2" y1="7" x2="24" y2="7" />,
  arrow: <><line x1="2" y1="7" x2="23" y2="7" /><path d="M17 2.5 23 7l-6 4.5" fill="none" /></>,
  triangle: <><line x1="2" y1="7" x2="17" y2="7" /><path d="M16 2.5 24 7l-8 4.5Z" fill="currentColor" /></>,
  triangle_outline: <><line x1="2" y1="7" x2="17" y2="7" /><path d="M16 2.5 24 7l-8 4.5Z" fill="none" /></>,
  diamond: <><line x1="2" y1="7" x2="15" y2="7" /><path d="M15 7l4.5-4 4.5 4-4.5 4Z" fill="currentColor" /></>,
  diamond_outline: <><line x1="2" y1="7" x2="15" y2="7" /><path d="M15 7l4.5-4 4.5 4-4.5 4Z" fill="none" /></>,
  circle: <><line x1="2" y1="7" x2="16" y2="7" /><circle cx="20" cy="7" r="4" fill="currentColor" /></>,
  circle_outline: <><line x1="2" y1="7" x2="16" y2="7" /><circle cx="20" cy="7" r="4" fill="none" /></>,
  bar: <><line x1="2" y1="7" x2="23" y2="7" /><line x1="23" y1="2.5" x2="23" y2="11.5" /></>,
  crowfoot_one: <><line x1="2" y1="7" x2="24" y2="7" /><line x1="17" y1="2.5" x2="17" y2="11.5" /></>,
  crowfoot_many: <><line x1="2" y1="7" x2="17" y2="7" /><path d="M17 7 24 2.5M17 7l7 4.5M17 7h7" fill="none" /></>,
  crowfoot_one_or_many: <><line x1="2" y1="7" x2="17" y2="7" /><path d="M17 7 24 2.5M17 7l7 4.5M17 7h7" fill="none" /><line x1="14" y1="2.5" x2="14" y2="11.5" /></>,
};
function HeadGlyph({ value, mirror = false }) {
  const body = HEAD_GLYPHS[value || 'none'] || HEAD_GLYPHS.none;
  return (
    <svg viewBox="0 0 26 14" width="26" height="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" style={mirror ? { transform: 'scaleX(-1)' } : undefined} aria-hidden="true">
      {body}
    </svg>
  );
}

// The topmost non-deleted text under a scene point (its native double-click
// gesture, editing, must win over the connector label editor).
function textAtScene(elements, scene) {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i];
    if (el.type !== 'text' || el.isDeleted) continue;
    if (scene.x >= el.x && scene.x <= el.x + el.width && scene.y >= el.y && scene.y <= el.y + el.height) return el;
  }
  return null;
}

// The topmost connector within `tol` scene px of a scene point, plus the length
// fraction where the point projects onto it (finding 22: a double-click anywhere
// on a connector labels it AT that point).
function connectorAtScene(elements, scene, tol) {
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const el = elements[i];
    if (el.type !== 'arrow' || el.isDeleted || !Array.isArray(el.points) || el.points.length < 2) continue;
    const near = nearestFractionOnPolyline(el.points, scene.x - el.x, scene.y - el.y);
    if (near && near.distance <= tol) return { el, t: near.t };
  }
  return null;
}
// A compact connector palette (a full 15-swatch row would make the connector bar wrap
// three deep); the shape bar keeps the rich palette.
const CONNECTOR_COLOR_KEYS = new Set(['black', 'blue', 'red', 'green', 'violet', 'orange', 'teal', 'cyan']);
const CONNECTOR_COLORS = STYLE_COLORS.filter((color) => CONNECTOR_COLOR_KEYS.has(color.key));

const EYEDROPPER_ICON = svg(<><path d="M13 3l4 4-1.5 1.5-4-4z" /><path d="M11.5 4.5 5 11v4h4l6.5-6.5" /></>);
const CUSTOM_ICON = svg(<path d="M10 4v12M4 10h12" />);

// ---- The contextual toolbar above the selection (Miro findings 46-48, 53, 57, 76) -----
// One floating card, centred over the selection, whose every deeper control opens DOWN
// from its own button. These are its glyphs: Miro uses a bold ring for Border and a
// checkerboard for Fill, an underlined A for text colour, and a kebab for More.
const TB_ICONS = {
  border: svg(<circle cx="10" cy="10" r="6" strokeWidth="2.6" />),
  fill: (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <rect x="4" y="4" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="5.4" y="5.4" width="3.3" height="3.3" fill="currentColor" opacity="0.55" />
      <rect x="11.3" y="5.4" width="3.3" height="3.3" fill="currentColor" opacity="0.2" />
      <rect x="5.4" y="11.3" width="3.3" height="3.3" fill="currentColor" opacity="0.2" />
      <rect x="11.3" y="11.3" width="3.3" height="3.3" fill="currentColor" opacity="0.55" />
    </svg>
  ),
  textColor: (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13 10 4l5 9" />
      <path d="M6.7 10.2h6.6" />
      <path d="M4 17h12" strokeWidth="2.6" />
    </svg>
  ),
  arrange: svg(<><path d="M10 3 3 7l7 4 7-4z" /><path d="m3 12 7 4 7-4" /></>),
  more: svg(<><circle cx="10" cy="4.6" r="1.1" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" /><circle cx="10" cy="15.4" r="1.1" fill="currentColor" stroke="none" /></>),
  copyStyle: svg(<><rect x="3.5" y="3.5" width="8" height="8" rx="1.5" /><path d="M8.5 8.5h8v8h-8z" /></>),
  pasteStyle: svg(<><path d="M6 4.5h8v12H6z" /><path d="M8 4.5V3h4v1.5" /><path d="M8.2 10.5h3.6M8.2 13.2h3.6" /></>),
  minus: svg(<path d="M5 10h10" />),
  plus: svg(<path d="M10 5v10M5 10h10" />),
  copyImage: svg(<><rect x="3.5" y="4.5" width="13" height="11" rx="1.6" /><circle cx="7.5" cy="8.5" r="1" /><path d="M4.5 14 8 10.5l2.5 2.5 2.5-2.5 2.5 2.5" /></>),
  lock: svg(<><rect x="4.5" y="9" width="11" height="7" rx="1.6" /><path d="M7.2 9V6.8a2.8 2.8 0 015.6 0V9" /></>),
  unlock: svg(<><rect x="4.5" y="9" width="11" height="7" rx="1.6" /><path d="M7.2 9V6.8a2.8 2.8 0 015.6-.4" /></>),
  duplicate: svg(<><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /><rect x="7.5" y="7.5" width="9" height="9" rx="1.5" /></>),
  trash: svg(<><path d="M4.5 6h11" /><path d="M6.5 6V4.5h7V6" /><path d="M6 6l.7 10h6.6L14 6" /></>),
  clear: svg(<><path d="M5 5h10M5 15h6" /><path d="M8.5 5 6.5 15" /></>),
  selectAll: svg(<><rect x="3.5" y="3.5" width="13" height="13" rx="2" strokeDasharray="3 2" /><path d="M7 10l2.2 2.2L13.5 8" /></>),
  mouse: svg(<><rect x="6.5" y="3.5" width="7" height="13" rx="3.5" /><path d="M10 6.5v2.5" /></>),
  // The rail already owns these three glyphs; reusing them keeps a menu row and its tool
  // showing the same picture instead of drifting apart.
  text: TOOL_ICONS.text,
  sticky: TOOL_ICONS.sticky,
  fit: CHROME_ICONS.zoomFit,
};

// One glyph per context-menu row key (findings 62-64). Keyed off the same keys
// contextMenuModel emits, so a row can never render without its icon.
const CTX_ICONS = {
  copyImage: TB_ICONS.copyImage,
  duplicate: TB_ICONS.duplicate,
  remove: TB_ICONS.trash,
  copyStyle: TB_ICONS.copyStyle,
  pasteStyle: TB_ICONS.pasteStyle,
  clearContent: TB_ICONS.clear,
  arrange: TB_ICONS.arrange,
  lock: TB_ICONS.lock,
  unlock: TB_ICONS.unlock,
  addSticky: TB_ICONS.sticky,
  addText: TB_ICONS.text,
  selectAll: TB_ICONS.selectAll,
  unlockAll: TB_ICONS.unlock,
  showAll: TB_ICONS.fit,
  wheelMode: TB_ICONS.mouse,
};

const WHEEL_MODES = [{ key: 'mouse', label: 'Mouse' }, { key: 'trackpad', label: 'Trackpad' }];

const ALIGN_ICONS = {
  left: svg(<><path d="M4 6h12M4 10h7M4 14h10" /></>),
  center: svg(<><path d="M4 6h12M6.5 10h7M5 14h10" /></>),
  right: svg(<><path d="M4 6h12M9 10h7M6 14h10" /></>),
};

// The border style row's glyph: one line drawn in that dash pattern.
const DASH_PATTERNS = { solid: null, dashed: '4 3', dotted: '1.6 3' };
const dashGlyph = (key) => (
  <svg viewBox="0 0 24 12" width="24" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="2" y1="6" x2="22" y2="6" strokeDasharray={DASH_PATTERNS[key] || undefined} />
  </svg>
);

// The switch-type grid opens on Miro's 12 quick glyphs and expands to every shape
// Harbor draws, which is what Miro's "All shapes" row does. A rail label carries the
// DRAW shortcut ("Ellipse  O"); converting an existing shape does not, so the grid
// shows the bare name.
const SWITCH_QUICK_DEFS = () => SWITCH_TYPE_KEYS.map((key) => shapeDef(key)).filter(Boolean);
const shapeName = (def) => def.label.split('  ')[0];

// The card's own menus are portalled to the body (a backdrop-filter ancestor traps a
// fixed child) and open DOWN from their button, clamped inside the viewport.
const MENU_MARGIN = 8;
// A submenu opens DOWN from its button and is capped to the room actually left below
// it, so a tall palette scrolls inside the panel instead of running off the window.
function menuAnchor(event, width = 240) {
  const rect = event.currentTarget.getBoundingClientRect();
  const left = Math.max(MENU_MARGIN, Math.min(rect.left, window.innerWidth - width - MENU_MARGIN));
  const top = rect.bottom + 6;
  return { left, top, maxHeight: Math.max(200, window.innerHeight - top - MENU_MARGIN * 2) };
}

function ToolbarMenu({ menu, name, className = '', label, children }) {
  if (!menu || menu.key !== name) return null;
  return createPortal(
    <div
      className={`wb-tb-menu ${className}`.trim()}
      role="menu"
      aria-label={label}
      style={{ left: `${menu.left}px`, top: `${menu.top}px`, maxHeight: `${menu.maxHeight}px` }}
    >
      {children}
    </div>,
    document.body,
  );
}

// A labelled slider row (Thickness / Opacity / Rounded corners), Miro's border-popover shape.
function SliderRow({ label, value, min, max, step = 1, suffix = '', onChange, children }) {
  return (
    <div className="wb-tb-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <div className="wb-tb-slider-foot">
        <span>{label}</span>
        {children || <span className="wb-tb-slider-val">{value}{suffix}</span>}
      </div>
    </div>
  );
}

// Drawing tools whose NEW items take a stroke colour (pen, text, lines): the pre-draw bar
// lets the colour be chosen BEFORE drawing, which is the only place a pen/pencil/text colour
// can be set (the style bar only recolours things already on the board).
const PREDRAW_STROKE_TOOLS = new Set(['freedraw', 'line', 'arrow', 'text']);
// Tools whose new items also take a fill (the native container shapes); poly shapes armed via
// `placingShape` join them so a triangle can be pre-coloured too.
const PREDRAW_FILL_TOOLS = new Set(['rectangle', 'ellipse', 'diamond']);

// The reuse list persists per user (not per board): a colour you sampled or dialled in on one
// board should be one click away on the next. Renderer-only localStorage, guarded for a
// first run or a private-mode read that throws.
const RECENT_COLORS_KEY = 'harbor-board-colors';
function loadRecentColors() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_COLORS_KEY) || '[]');
    return Array.isArray(raw) ? raw.map(normalizeHex).filter(Boolean) : [];
  } catch { return []; }
}
function saveRecentColors(list) {
  try { window.localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

// ---- Sticky autosize measurement (finding 31) --------------------------------------
// fitStickyLabels needs real glyph widths; a 2D canvas measures them with the same
// Nunito the labels render in, memoized because the fit check runs from onChange.
// The 3% margin absorbs the small drift between this measure and Excalidraw's own.
let stickyMeasureCtx = null;
const stickyMeasureCache = new Map();
function stickyMeasure(text, fontSize) {
  const key = `${fontSize}|${text}`;
  const hit = stickyMeasureCache.get(key);
  if (hit !== undefined) return hit;
  if (!stickyMeasureCtx) stickyMeasureCtx = document.createElement('canvas').getContext('2d');
  stickyMeasureCtx.font = `${fontSize}px Nunito, sans-serif`;
  const width = stickyMeasureCtx.measureText(text).width * 1.03;
  if (stickyMeasureCache.size > 5000) stickyMeasureCache.clear();
  stickyMeasureCache.set(key, width);
  return width;
}

// The last sticky colour placed: N re-arms it (Miro finding 30, "N places the last color").
const LAST_STICKY_KEY = 'harbor-board-sticky-color';
function loadLastStickyColor() {
  try {
    const saved = window.localStorage.getItem(LAST_STICKY_KEY);
    return STICKY_COLORS.some((color) => color.key === saved) ? saved : DEFAULT_STICKY;
  } catch { return DEFAULT_STICKY; }
}

// Scroll-wheel behaviour (finding 69): Miro's Mouse mode zooms the plain wheel at the
// cursor; Trackpad mode keeps native wheel-scroll + ctrl-wheel-zoom. Default Mouse.
const WHEEL_MODE_KEY = 'harbor-board-wheel';
function loadWheelMode() {
  try { return window.localStorage.getItem(WHEEL_MODE_KEY) === 'trackpad' ? 'trackpad' : 'mouse'; } catch { return 'mouse'; }
}

// Grid style (finding 72): Miro's View menu offers a line grid or a dot grid.
const GRID_STYLE_KEY = 'harbor-board-grid-style';
function loadGridStyle() {
  try { return window.localStorage.getItem(GRID_STYLE_KEY) === 'dot' ? 'dot' : 'line'; } catch { return 'line'; }
}

const ZOOM_MENU_LEVELS = [
  { key: '50', level: 0.5, label: '50%' },
  { key: '100', level: 1, label: '100%', hint: 'Ctrl+0' },
  { key: '200', level: 2, label: '200%' },
  { key: '400', level: 4, label: '400%' },
];

// The docked minimap card (finding 71): elements as solid blue boxes, the viewport as
// a dark-stroked rectangle, click to jump. Drawn from element BOUNDS on a small canvas
// on a coarse tick; nothing here ever serializes the scene.
function Minimap({ getApi }) {
  const canvasRef = useRef(null);
  const planRef = useRef(null);
  useEffect(() => {
    let timer = null;
    let alive = true;
    const draw = () => {
      const api = getApi();
      const canvas = canvasRef.current;
      if (!alive || !api || !canvas) return;
      const app = api.getAppState();
      const plan = minimapPlan(api.getSceneElements(), app);
      planRef.current = plan;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== MINIMAP_W * dpr) { canvas.width = MINIMAP_W * dpr; canvas.height = MINIMAP_H * dpr; }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
      ctx.fillStyle = '#7ba1f0';
      for (const box of plan.boxes) ctx.fillRect(box.x, box.y, Math.max(2, box.w), Math.max(2, box.h));
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(plan.view.x, plan.view.y, plan.view.w, plan.view.h);
    };
    const tick = () => { draw(); timer = setTimeout(tick, 200); };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [getApi]);
  const jump = (event) => {
    const api = getApi();
    const plan = planRef.current;
    if (!api || !plan) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const app = api.getAppState();
    const scroll = minimapJump(plan, event.clientX - rect.left, event.clientY - rect.top, app);
    api.updateScene({ appState: { scrollX: scroll.scrollX, scrollY: scroll.scrollY }, captureUpdate: CaptureUpdateAction.NEVER });
  };
  return (
    <div className="wb-minimap" role="region" aria-label="Minimap">
      <canvas
        ref={canvasRef}
        style={{ width: `${MINIMAP_W}px`, height: `${MINIMAP_H}px` }}
        aria-label="Minimap: click to jump"
        onPointerDown={jump}
      />
    </div>
  );
}

// Keep connect dots alive while the cursor crosses the small gap from a shape body to one of
// its four connect dots (the dots sit ~19px OUTSIDE the edges, Miro's measured offset).
// Without this, moving off the body to reach a dot loses the hover hit-test and the dots
// vanish before you get there (Pat's report). A generous radius around each dot covers the
// whole approach corridor.
const DOT_KEEP_RADIUS = 30;

// Read the colour of the pixel under a client point from Excalidraw's own rendered canvas,
// which includes any dropped/pasted image (embedded as a same-origin data URL, so getImageData
// is not tainted). Transparent pixels (the interactive overlay canvas, or empty board) fall
// through to the next canvas and finally to the board background. Returns `#rrggbb` or null.
function sampleCanvasColor(clientX, clientY, api) {
  const root = document.querySelector('.excalidraw');
  if (root) {
    for (const canvas of root.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) continue;
      const sx = Math.floor((clientX - rect.left) * (canvas.width / rect.width));
      const sy = Math.floor((clientY - rect.top) * (canvas.height / rect.height));
      let hex = null;
      try { hex = rgbaToHex(canvas.getContext('2d').getImageData(sx, sy, 1, 1).data); } catch { hex = null; }
      if (hex) return hex;
    }
  }
  return normalizeHex(api?.getAppState?.().viewBackgroundColor) || null;
}

// The custom-colour popover: a native colour wheel, a hex field, an eyedropper, and the reuse
// row. One instance drives the shape fill/line, the connector, and the pre-draw controls; the
// `mode`/`target` it was opened with decide where a pick lands. Portalled to the body because
// the whiteboard's backdrop-filter would otherwise trap a fixed-position child.
// Render a set of elements to a PNG on the clipboard through the LOCAL_ONLY
// clipboard:write-image IPC. Shared by the main menu's Copy as PNG (the whole board) and
// Wave D's Copy as image (the selection only, catalog findings 56 and 63), so a
// selection export can never drift from the board export. Answers the status message.
async function copyElementsAsPng(api, elements) {
  if (!api) return 'Copy failed';
  if (!elements.length) return 'Board is empty';
  if (!window.harbor?.clipboard?.writeImage) return 'Copy unavailable';
  try {
    const appState = api.getAppState();
    const blob = await exportToBlob({
      elements,
      appState: { ...appState, exportBackground: true, exportEmbedScene: false },
      files: api.getFiles(),
      mimeType: 'image/png',
      exportPadding: 24,
      getDimensions: (width, height) => ({ width, height, scale: Math.min(2, 2400 / Math.max(width, height, 1)) }),
    });
    const dataURL = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const result = await window.harbor.clipboard.writeImage({ dataURL });
    return result?.ok ? 'Copied PNG' : 'Copy failed';
  } catch { return 'Copy failed'; }
}

function ColorPopover({ popover, recent, onPick, onEyedropper, onClose }) {
  const [hexDraft, setHexDraft] = useState('');
  useEffect(() => { setHexDraft(popover ? (popover.value || '') : ''); }, [popover]);
  useEffect(() => {
    if (!popover) return undefined;
    const onDown = (event) => { if (!event.target?.closest?.('.wb-color-pop, .wb-swatch-custom')) onClose(); };
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); };
  }, [popover, onClose]);
  if (!popover) return null;
  const current = normalizeHex(popover.value) || '#000000';
  const commitHex = () => { const norm = normalizeHex(hexDraft); if (norm) onPick(norm); else setHexDraft(popover.value || ''); };
  const allowNoFill = popover.target === 'fill' && popover.mode !== 'connector';
  return createPortal(
    <div className="wb-color-pop" role="dialog" aria-label="Custom colour" style={{ left: `${popover.x}px`, top: `${popover.y}px` }}>
      <div className="wb-color-pop-row">
        <label className="wb-color-wheel" title="Colour picker">
          <input type="color" value={current} onChange={(event) => onPick(event.target.value)} aria-label="Colour picker" />
        </label>
        <span className="wb-color-hash">#</span>
        <input
          className="wb-color-hex"
          value={hexDraft.replace(/^#/, '')}
          spellCheck={false}
          maxLength={7}
          aria-label="Hex colour"
          onChange={(event) => setHexDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitHex(); } }}
          onBlur={commitHex}
        />
        <button type="button" className="wb-eyedrop wb-color-pop-eyedrop" title="Eyedropper: sample a colour from the board" aria-label="Eyedropper" onClick={onEyedropper}>{EYEDROPPER_ICON}</button>
      </div>
      {(recent.length || allowNoFill) ? (
        <div className="wb-color-recent" aria-label="Recent and preset colours">
          {allowNoFill ? (
            <button type="button" className="wb-swatch none" title="No fill" aria-label="No fill" onClick={() => onPick('transparent')} />
          ) : null}
          {recent.map((hex) => (
            <button key={hex} type="button" className={`wb-swatch${popover.value === hex ? ' on' : ''}`} style={{ '--wb-swatch': hex }} title={hex} aria-label={`Recent colour ${hex}`} onClick={() => onPick(hex)} />
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

// key === a real Excalidraw tool type unless action is set (sticky is our own),
// or shapes is set (a flyout of the geometric shape tools, to keep the rail short).
const TOOLS = [
  { key: 'selection', label: 'Select  V' },
  { key: 'hand', label: 'Pan  H' },
  { key: 'sticky', label: 'Sticky note  N', action: true },
  { key: 'text', label: 'Text  T' },
  { key: 'shapes', label: 'Shapes', shapes: true },
  { key: 'arrow', label: 'Arrow  A' },
  { key: 'line', label: 'Line  L' },
  { key: 'freedraw', label: 'Draw  P' },
  { key: 'frame', label: 'Frame  F', frames: true },
  { key: 'image', label: 'Image' },
  { key: 'eraser', label: 'Eraser  E' },
  { key: 'laser', label: 'Laser pointer  K' },
];

const DEFAULT_SHAPE_SIZE = 140;

const selectedIdSet = (api) => new Set(Object.keys(api.getAppState().selectedElementIds || {}));

// What a connector may attach to is ONE spec'd decision, `isConnectable` in
// board-files.cjs, read by the hover path, the drop-target search and the dot resolver
// alike. Wave D widened it to standalone TEXT (catalog finding 38) and narrowed it away
// from locked elements, so both changes land everywhere at once.

// Client (viewport) to scene coordinates, the inverse of anchorForElement's mapping.
function clientToScene(app, clientX, clientY) {
  const zoom = app.zoom?.value || 1;
  return {
    x: (clientX - (app.offsetLeft || 0)) / zoom - app.scrollX,
    y: (clientY - (app.offsetTop || 0)) / zoom - app.scrollY,
  };
}

// The topmost connectable shape under a client point (for drop-to-connect).
function elementAtClient(api, clientX, clientY, excludeId) {
  const app = api.getAppState();
  const { x: sceneX, y: sceneY } = clientToScene(app, clientX, clientY);
  const els = api.getSceneElements();
  for (let i = els.length - 1; i >= 0; i -= 1) {
    const el = els[i];
    if (el.id === excludeId || !isConnectable(el)) continue;
    if (sceneX >= el.x && sceneX <= el.x + el.width && sceneY >= el.y && sceneY <= el.y + el.height) return el;
  }
  return null;
}

// Create an arrow from a source dot to wherever the drag released, with Miro's
// drop semantics (catalog findings 10, 11, 12): a dot or near-edge drop lands on
// the side-midpoint anchor (connectorPlan, the SAME geometry the CLI binds with)
// bound focus-0/gap-6; a BODY drop pins the endpoint AT the drop point via
// Excalidraw's own binding model (focus computed from the drop, gap 0, so the
// entry edge migrates as the shape later moves); an empty-canvas drop leaves a
// dangling FREE end at the drop point, bound only at the origin. New connectors
// default to Excalidraw's bezier (roundness 2), which renders straight between
// aligned anchors exactly like Miro's default (finding 14).
// convertToExcalidrawElements only resolves bindings within its own batch, so the
// binding to pre-existing elements is set on the arrow (start/endBinding) and
// mirrored onto each bound shape's boundElements.
// Set or clear one end's polyBind entry on an arrow (null clears); the poly
// attachment channel for what Excalidraw cannot natively bind (a line).
function setPolyBindEntry(elements, arrowId, whichEnd, entry) {
  return elements.map((e) => {
    if (e.id !== arrowId) return e;
    const bind = { ...((e.customData || {}).polyBind || {}) };
    if (entry) bind[whichEnd] = entry; else delete bind[whichEnd];
    return { ...e, customData: { ...(e.customData || {}), polyBind: bind } };
  });
}

function createConnector(api, sourceId, fromSide, drop) {
  const els = api.getSceneElements();
  const src = els.find((el) => el.id === sourceId);
  if (!src || !drop || !drop.scene) return false;
  const target = drop.targetId ? els.find((el) => el.id === drop.targetId) : null;
  if (target && target.id === sourceId) return false;
  const from = anchorPoints(src)[fromSide];
  let to = drop.scene;
  let endBinding = null;
  const polyBind = {};
  if (target && (drop.mode === 'dot' || drop.mode === 'edge')) {
    const plan = connectorPlan({
      source: src, fromSide, target, toSide: drop.mode === 'dot' ? drop.side : null,
      dropX: drop.scene.x, dropY: drop.scene.y,
    });
    to = plan.to;
    if (isPolyShape(target)) polyBind.end = { id: target.id, side: plan.toSide };
    else endBinding = { elementId: target.id, focus: 0, gap: 6 };
  } else if (target && drop.mode === 'body') {
    if (isPolyShape(target)) {
      // A poly body drop attaches at the nearest side midpoint: there is no
      // native focus math for a line, and syncPolyConnectors owns the glue.
      const plan = connectorPlan({ source: src, fromSide, target, toSide: null, dropX: drop.scene.x, dropY: drop.scene.y });
      to = plan.to;
      polyBind.end = { id: target.id, side: plan.toSide };
    } else {
      endBinding = { elementId: target.id, focus: bindingFocusFromDrop(target, from, drop.scene), gap: 0 };
    }
  }
  const [arrow] = convertToExcalidrawElements([{
    type: 'arrow', x: from.x, y: from.y,
    points: [[0, 0], [to.x - from.x, to.y - from.y]],
    strokeColor: '#495057', strokeWidth: 2, roughness: 0,
  }]);
  arrow.roundness = { type: 2 };
  // A poly SOURCE cannot take a native binding either; its end rides polyBind.
  if (isPolyShape(src)) polyBind.start = { id: sourceId, side: fromSide };
  arrow.startBinding = isPolyShape(src) ? null : { elementId: sourceId, focus: 0, gap: 6 };
  arrow.endBinding = endBinding;
  if (polyBind.start || polyBind.end) arrow.customData = { ...(arrow.customData || {}), polyBind };
  const boundIds = new Set([
    ...(isPolyShape(src) ? [] : [sourceId]),
    ...(endBinding ? [endBinding.elementId] : []),
  ]);
  const next = els.map((el) => (
    boundIds.has(el.id)
      ? { ...el, boundElements: [...(el.boundElements || []), { id: arrow.id, type: 'arrow' }] }
      : el
  ));
  api.updateScene({ elements: [...next, arrow], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return true;
}

// The four edge-dot anchor points of a shape in viewport (client) coordinates, so the
// connect dots can be drawn over the canvas. Shared by the selection path and the hover
// path so a shape shows the same dots whether it is selected or merely hovered (Miro).
// The dots sit a small GAP OUTSIDE each edge (Miro-style), never on the shape body, so a
// click or double-click on the shape itself (to select or to edit its text) is never eaten
// by a connect dot. The connector still binds to the real shape edge; the dot is only the grab.
const CONNECT_DOT_GAP = 19;
function anchorForElement(el, appState) {
  const zoom = appState.zoom?.value || 1;
  const left = (el.x + appState.scrollX) * zoom + (appState.offsetLeft || 0);
  const top = (el.y + appState.scrollY) * zoom + (appState.offsetTop || 0);
  const w = el.width * zoom;
  const h = el.height * zoom;
  const g = CONNECT_DOT_GAP;
  return {
    id: el.id,
    top: { x: left + w / 2, y: top - g },
    right: { x: left + w + g, y: top + h / 2 },
    bottom: { x: left + w / 2, y: top + h + g },
    left: { x: left - g, y: top + h / 2 },
  };
}

// A shape's bounding box in viewport (client) coordinates.
function clientBoxForElement(el, appState) {
  const zoom = appState.zoom?.value || 1;
  return {
    x: (el.x + appState.scrollX) * zoom + (appState.offsetLeft || 0),
    y: (el.y + appState.scrollY) * zoom + (appState.offsetTop || 0),
    width: el.width * zoom,
    height: el.height * zoom,
  };
}

// Miro's two-tier target under a dragged connector end (catalog findings 7-9):
// the nearest DOT hit wins over the topmost BODY hit over the nearest EDGE
// reveal. `rings` are the target's ON-edge side midpoints (client px); a body
// hit also carries `entry`, where the preview arrowhead parks (the point the
// origin-to-cursor segment crosses the boundary) instead of following the
// cursor inside.
function findDragTarget(api, clientX, clientY, excludeIds, originClient) {
  const app = api.getAppState();
  const els = api.getSceneElements();
  let dotBest = null;
  let bodyBest = null;
  let edgeBest = null;
  for (let i = els.length - 1; i >= 0; i -= 1) {
    const el = els[i];
    if (excludeIds.has(el.id) || !isConnectable(el)) continue;
    const box = clientBoxForElement(el, app);
    const hit = classifyDragPoint(box, clientX, clientY);
    if (!hit) continue;
    if (hit.mode === 'dot') {
      const d = Math.hypot(clientX - hit.point.x, clientY - hit.point.y);
      if (!dotBest || d < dotBest.d) dotBest = { el, box, mode: 'dot', side: hit.side, point: hit.point, rings: hit.mids, d };
    } else if (hit.mode === 'body') {
      if (!bodyBest) {
        bodyBest = {
          el, box, mode: 'body', rings: hit.mids,
          entry: originClient ? segmentBoxEntry(box, originClient, { x: clientX, y: clientY }) : null,
        };
      }
    } else if (!edgeBest) edgeBest = { el, box, mode: 'edge', rings: hit.mids };
  }
  return dotBest || bodyBest || edgeBest;
}

// The visual half of two-tier targeting, shared by the create drag and the
// endpoint re-drag: hollow rings ON the target's edge midpoints (the snapped one
// lit solid), and on a body hit the whole shape glows (border blue, fill tinted).
function TargetVisuals({ target }) {
  if (!target) return null;
  return (
    <>
      {target.mode === 'body' ? (
        <div
          className="wb-target-glow"
          style={{
            left: `${target.box.x}px`,
            top: `${target.box.y}px`,
            width: `${target.box.width}px`,
            height: `${target.box.height}px`,
            borderRadius: target.el.type === 'ellipse' ? '50%' : '3px',
          }}
          aria-hidden="true"
        />
      ) : null}
      {['top', 'right', 'bottom', 'left'].map((side) => (
        <span
          key={`ring-${side}`}
          className={`wb-connect-ring${target.mode === 'dot' && target.side === side ? ' snap' : ''}`}
          style={{ left: `${target.rings[side].x}px`, top: `${target.rings[side].y}px` }}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

// The hover guide line Miro draws from a hovered connect dot, extending outward
// across the canvas (finding 3).
function dotGuideStyle(point, side) {
  if (side === 'right') return { left: `${point.x}px`, top: `${point.y}px`, width: `${Math.max(0, window.innerWidth - point.x)}px`, height: '1px' };
  if (side === 'left') return { left: '0px', top: `${point.y}px`, width: `${point.x}px`, height: '1px' };
  if (side === 'top') return { left: `${point.x}px`, top: '0px', width: '1px', height: `${point.y}px` };
  return { left: `${point.x}px`, top: `${point.y}px`, width: '1px', height: `${Math.max(0, window.innerHeight - point.y)}px` };
}

// The white directional arrow inside a hovered dot (finding 3), drawn pointing
// right and rotated per side by CSS.
const DOT_ARROW = (
  <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 6h8M7 3l3 3-3 3" />
  </svg>
);

// The four Miro-style connect dots for a shape (selected OR hovered), plus the
// drag-to-link interaction. Portalled to the body so the dots and the drag line sit
// above the canvas in true viewport coordinates (the whiteboard's backdrop-filter would
// otherwise trap a fixed-position child). The drag preview is a LIVE dark line with an
// arrowhead at its moving end (finding 4), never a dashed accent line; targeting is
// two-tier (findDragTarget), and release binds per Miro's drop semantics, including a
// dangling free end on an empty-canvas release (finding 12).
function ConnectorLayer({ anchor, getApi, onCreated }) {
  const [drag, setDrag] = useState(null);
  const [hoverDot, setHoverDot] = useState(null);
  useEffect(() => {
    if (!drag) return undefined;
    const onMove = (event) => {
      const api = getApi();
      const target = api && anchor
        ? findDragTarget(api, event.clientX, event.clientY, new Set([anchor.id]), drag.from)
        : null;
      const to = target && target.mode === 'dot'
        ? { x: target.point.x, y: target.point.y }
        : (target && target.mode === 'body' && target.entry ? target.entry : { x: event.clientX, y: event.clientY });
      setDrag((current) => (current ? { ...current, to, target } : current));
    };
    const onUp = (event) => {
      const api = getApi();
      const moved = Math.hypot(event.clientX - drag.from.x, event.clientY - drag.from.y) >= 8;
      if (api && anchor && moved) {
        const target = findDragTarget(api, event.clientX, event.clientY, new Set([anchor.id]), drag.from);
        const scene = clientToScene(api.getAppState(), event.clientX, event.clientY);
        const made = createConnector(api, anchor.id, drag.fromSide, {
          mode: target ? target.mode : 'empty',
          targetId: target ? target.el.id : null,
          side: target && target.mode === 'dot' ? target.side : null,
          scene,
        });
        if (made) onCreated();
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
    };
  }, [drag, anchor, getApi, onCreated]);

  if (!anchor) return null;
  const startConnect = (dot) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    setHoverDot(null);
    setDrag({ fromSide: dot, from: { x: anchor[dot].x, y: anchor[dot].y }, to: { x: event.clientX, y: event.clientY }, target: null });
  };
  return createPortal(
    <div className="wb-connect-layer">
      {hoverDot && !drag ? <div className="wb-dot-guide" style={dotGuideStyle(anchor[hoverDot], hoverDot)} aria-hidden="true" /> : null}
      {drag ? (
        <svg className="wb-connect-line" aria-hidden="true">
          <defs>
            <marker id="wb-conn-head" markerWidth="9" markerHeight="8" refX="7.2" refY="4" orient="auto">
              <path d="M0.8 0.8 L8 4 L0.8 7.2 Z" fill="#1a1a1a" />
            </marker>
          </defs>
          <line x1={drag.from.x} y1={drag.from.y} x2={drag.to.x} y2={drag.to.y} markerEnd="url(#wb-conn-head)" />
        </svg>
      ) : null}
      {drag ? <TargetVisuals target={drag.target} /> : null}
      {['top', 'right', 'bottom', 'left'].map((dot) => (
        <button
          key={dot}
          type="button"
          className={`wb-connect-dot side-${dot}${hoverDot === dot ? ' hovered' : ''}`}
          aria-label={`Connect from ${dot}`}
          style={{ left: `${anchor[dot].x}px`, top: `${anchor[dot].y}px` }}
          onPointerDown={startConnect(dot)}
          onPointerEnter={() => setHoverDot(dot)}
          onPointerLeave={() => setHoverDot((current) => (current === dot ? null : current))}
        >{DOT_ARROW}</button>
      ))}
    </div>,
    document.body,
  );
}

// The Miro-style edit layer for a single selected connector (findings 18-21):
// endpoint rings at both ends, and a midpoint handle per span. An ENDPOINT drag
// detaches that end and re-enters the full two-tier snap mechanics; a bezier or
// straight midpoint drag BENDS the line through the dragged point (inserting a
// waypoint, so each half then carries its own handle: repeated bending
// subdivides); an elbow segment handle drags its whole segment orthogonally.
// Custom handles portal ABOVE the canvas, so Excalidraw's native handles can
// never receive the same gesture.
function ConnectorEditLayer({ getApi, arrowId, sig, editingText }) {
  const [edit, setEdit] = useState(null);
  const editRef = useRef(null);
  useEffect(() => { editRef.current = edit; }, [edit]);

  useEffect(() => {
    if (!edit) return undefined;
    const onMove = (event) => {
      const api = getApi();
      const state = editRef.current;
      if (!api || !state) return;
      const els = api.getSceneElements();
      const el = els.find((e) => e.id === arrowId);
      if (!el) return;
      const app = api.getAppState();
      const scene = clientToScene(app, event.clientX, event.clientY);
      if (state.kind === 'end') {
        // The adjacent point (this end's neighbour) anchors the entry-edge math.
        const pts = el.points;
        const adjLocal = state.end === 'start' ? pts[1] : pts[pts.length - 2];
        const adjScene = { x: el.x + adjLocal[0], y: el.y + adjLocal[1] };
        const zoom = app.zoom?.value || 1;
        const adjClient = {
          x: (adjScene.x + app.scrollX) * zoom + (app.offsetLeft || 0),
          y: (adjScene.y + app.scrollY) * zoom + (app.offsetTop || 0),
        };
        const target = findDragTarget(api, event.clientX, event.clientY, new Set([arrowId]), adjClient);
        let park = scene;
        if (target && target.mode === 'dot') {
          const tEl = target.el;
          park = anchorPoints(tEl)[target.side];
        } else if (target && target.mode === 'body' && target.entry) {
          park = clientToScene(app, target.entry.x, target.entry.y);
        }
        setEdit((current) => (current ? { ...current, target, dropScene: scene } : current));
        api.updateScene({
          elements: els.map((e) => (e.id === arrowId ? moveConnectorEndpoint(e, state.end, park.x, park.y) : e)),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } else if (state.kind === 'bend') {
        api.updateScene({
          elements: els.map((e) => (e.id === arrowId ? moveConnectorPoint(e, state.index, scene.x, scene.y) : e)),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      } else if (state.kind === 'seg') {
        const dx = scene.x - state.startScene.x;
        const dy = scene.y - state.startScene.y;
        api.updateScene({
          elements: els.map((e) => (e.id === arrowId ? translateElbowSegment(state.startEl, state.segIndex, dx, dy) : e)),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    };
    const onUp = (event) => {
      const api = getApi();
      const state = editRef.current;
      setEdit(null);
      if (!api || !state) return;
      let els = api.getSceneElements();
      const el = els.find((e) => e.id === arrowId);
      if (!el) return;
      const app = api.getAppState();
      if (state.kind === 'end') {
        const scene = clientToScene(app, event.clientX, event.clientY);
        const target = state.target;
        if (target && (target.mode === 'dot' || target.mode === 'edge')) {
          // Side-midpoint attachment: the dot when snapped, else the side
          // nearest the drop.
          const tEl = els.find((e) => e.id === target.el.id);
          if (tEl) {
            let side = target.mode === 'dot' ? target.side : null;
            if (!side) {
              const anchors = anchorPoints(tEl);
              side = ['top', 'right', 'bottom', 'left']
                .map((s) => [s, Math.hypot(scene.x - anchors[s].x, scene.y - anchors[s].y)])
                .sort((a, b) => a[1] - b[1])[0][0];
            }
            const point = anchorPoints(tEl)[side];
            els = els.map((e) => (e.id === arrowId ? moveConnectorEndpoint(e, state.end, point.x, point.y) : e));
            // A poly cannot take a native Excalidraw binding (it is a `line`):
            // its attachment rides customData.polyBind and syncPolyConnectors
            // glues it from then on. A native target clears any stale polyBind.
            if (isPolyShape(tEl)) {
              els = bindConnectorEnd(els, arrowId, state.end, null);
              els = els.map((e) => (e.id === arrowId
                ? { ...e, customData: { ...(e.customData || {}), polyBind: { ...((e.customData || {}).polyBind || {}), [state.end]: { id: tEl.id, side } } } }
                : e));
            } else {
              els = setPolyBindEntry(els, arrowId, state.end, null);
              els = bindConnectorEnd(els, arrowId, state.end, { elementId: tEl.id, focus: 0, gap: 6 });
            }
          }
        } else if (target && target.mode === 'body') {
          const tEl = els.find((e) => e.id === target.el.id);
          if (tEl && isPolyShape(tEl)) {
            // Body drop on a poly: nearest side midpoint (no native focus math
            // exists for a line), same customData attachment as the dot case.
            const anchors = anchorPoints(tEl);
            const side = ['top', 'right', 'bottom', 'left']
              .map((s) => [s, Math.hypot(scene.x - anchors[s].x, scene.y - anchors[s].y)])
              .sort((a, b) => a[1] - b[1])[0][0];
            els = els.map((e) => (e.id === arrowId ? moveConnectorEndpoint(e, state.end, anchors[side].x, anchors[side].y) : e));
            els = bindConnectorEnd(els, arrowId, state.end, null);
            els = els.map((e) => (e.id === arrowId
              ? { ...e, customData: { ...(e.customData || {}), polyBind: { ...((e.customData || {}).polyBind || {}), [state.end]: { id: tEl.id, side } } } }
              : e));
          } else if (tEl) {
            // Pin at the drop point inside the body (finding 10): the endpoint
            // moves to the drop, the binding focus aims through it, gap 0.
            const pts = el.points;
            const adjLocal = state.end === 'start' ? pts[1] : pts[pts.length - 2];
            const adjScene = { x: el.x + adjLocal[0], y: el.y + adjLocal[1] };
            els = els.map((e) => (e.id === arrowId ? moveConnectorEndpoint(e, state.end, scene.x, scene.y) : e));
            els = setPolyBindEntry(els, arrowId, state.end, null);
            els = bindConnectorEnd(els, arrowId, state.end, {
              elementId: tEl.id, focus: bindingFocusFromDrop(tEl, adjScene, scene), gap: 0,
            });
          }
        }
        // An elbow keeps its orthogonality: re-route against the (possibly new)
        // bound shapes once the endpoint settles.
        const settled = els.find((e) => e.id === arrowId);
        if (settled?.customData?.elbow) {
          const byId = new Map(els.map((e) => [e.id, e]));
          const obstacles = [settled.startBinding?.elementId, settled.endBinding?.elementId]
            .map((id) => (id ? byId.get(id) : null)).filter(Boolean);
          els = els.map((e) => (e.id === arrowId ? routeConnector(e, 'elbow', { obstacles }) : e));
        }
      }
      api.updateScene({ elements: els, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
    };
  }, [edit, arrowId, getApi]);

  const api = getApi();
  if (!api || !arrowId || editingText) return null;
  const el = api.getSceneElements().find((e) => e.id === arrowId);
  if (!el || el.isDeleted || el.type !== 'arrow') return null;
  const app = api.getAppState();
  const zoom = app.zoom?.value || 1;
  const toClient = (sx, sy) => ({
    x: (sx + app.scrollX) * zoom + (app.offsetLeft || 0),
    y: (sy + app.scrollY) * zoom + (app.offsetTop || 0),
  });
  const pts = el.points || [];
  if (pts.length < 2) return null;
  const startClient = toClient(el.x + pts[0][0], el.y + pts[0][1]);
  const endClient = toClient(el.x + pts[pts.length - 1][0], el.y + pts[pts.length - 1][1]);
  const rounded = el.roundness && el.roundness.type === 2;
  const isElbow = !rounded && (el.customData?.elbow || pts.length > 2);
  const handles = [];
  if (isElbow) {
    const wps = elbowWaypoints(el);
    for (let k = 1; k <= wps.length - 3; k += 1) {
      const mid = toClient(el.x + (wps[k][0] + wps[k + 1][0]) / 2, el.y + (wps[k][1] + wps[k + 1][1]) / 2);
      const vertical = wps[k][0] === wps[k + 1][0];
      handles.push({ kind: 'seg', segIndex: k, x: mid.x, y: mid.y, cursor: vertical ? 'ew-resize' : 'ns-resize' });
    }
  } else {
    for (let i = 0; i < pts.length - 1; i += 1) {
      const mid = toClient(el.x + (pts[i][0] + pts[i + 1][0]) / 2, el.y + (pts[i][1] + pts[i + 1][1]) / 2);
      handles.push({ kind: 'bend', spanIndex: i, x: mid.x, y: mid.y, cursor: 'move' });
    }
  }
  const startEnd = (end) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    const current = getApi();
    if (!current) return;
    // Grabbing an endpoint DETACHES that end (finding 19); the drag then decides
    // where (and whether) it re-binds.
    current.updateScene({
      elements: detachConnectorEnd(current.getSceneElements(), arrowId, end),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setEdit({ kind: 'end', end, target: null });
  };
  const startBend = (handle) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    const current = getApi();
    if (!current) return;
    const scene = clientToScene(current.getAppState(), event.clientX, event.clientY);
    if (handle.kind === 'seg') {
      const live = current.getSceneElements().find((e) => e.id === arrowId);
      setEdit({ kind: 'seg', segIndex: handle.segIndex, startScene: scene, startEl: live });
      return;
    }
    // Insert the new waypoint under the cursor; the move handler then drags it.
    current.updateScene({
      elements: current.getSceneElements().map((e) => (e.id === arrowId ? bendConnectorAt(e, handle.spanIndex, scene.x, scene.y) : e)),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    setEdit({ kind: 'bend', index: handle.spanIndex + 1 });
  };
  return createPortal(
    <div className="wb-connect-layer wb-conn-edit">
      {edit && edit.kind === 'end' ? <TargetVisuals target={edit.target} /> : null}
      {handles.map((handle) => (
        <button
          key={`${handle.kind}-${handle.segIndex ?? handle.spanIndex}`}
          type="button"
          className="wb-conn-mid"
          aria-label={handle.kind === 'seg' ? 'Drag to move this segment' : 'Drag to bend the connector'}
          style={{ left: `${handle.x}px`, top: `${handle.y}px`, cursor: handle.cursor }}
          onPointerDown={startBend(handle)}
        />
      ))}
      <button
        type="button"
        className="wb-conn-end"
        aria-label="Connector start point"
        style={{ left: `${startClient.x}px`, top: `${startClient.y}px` }}
        onPointerDown={startEnd('start')}
      />
      <button
        type="button"
        className="wb-conn-end"
        aria-label="Connector end point"
        style={{ left: `${endClient.x}px`, top: `${endClient.y}px` }}
        onPointerDown={startEnd('end')}
      />
    </div>,
    document.body,
  );
}

function WhiteboardCanvas({ board, onSceneChange, externalScene = null }) {
  const apiRef = useRef(null);
  const sceneRef = useRef({ elements: [], appState: {}, files: {} });
  const savedRef = useRef({ version: null, appSig: null });
  const flushTimerRef = useRef(null);
  const gridRef = useRef(false);
  const snapRef = useRef(false);
  const selSigRef = useRef('');
  const editingRef = useRef(false);
  const [editingText, setEditingText] = useState(false);
  const toolRef = useRef('selection');
  const connectSigRef = useRef('');
  const hoverSigRef = useRef('');
  const syncScheduledRef = useRef(false);
  const [connectAnchor, setConnectAnchor] = useState(null);
  const [hoverAnchor, setHoverAnchor] = useState(null);
  const [gridOn, setGridOn] = useState(false);
  const [snapOn, setSnapOn] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [tablesOpen, setTablesOpen] = useState(false);
  const [tableId, setTableId] = useState(null); // the table id when a table cell is selected
  const tableIdRef = useRef(null);
  // Miro model: clicking the sticky tool ARMS placement (opens the colour flyout, shows a
  // crosshair) and the next canvas click drops a sticky where you click; the tool stays
  // armed to place more until Escape or another tool. `placingSticky` is null when off, or
  // the armed colour key. (Replaces the old click-drops-at-centre behaviour.)
  const [placingSticky, setPlacingSticky] = useState(null);
  // Miro-style shape drawing: arming a POLY shape sets `placingShape` to its key; a canvas
  // drag then draws it at that size (a click drops a default-sized one). Native shapes use
  // Excalidraw's own tool and never set this.
  const [placingShape, setPlacingShape] = useState(null);
  const [drawRect, setDrawRect] = useState(null); // live rubber-band while drag-drawing a shape
  const [multiActive, setMultiActive] = useState(false); // a multi-point line is mid-draw
  const multiRef = useRef(false);
  const [shapesOpen, setShapesOpen] = useState(false);
  const [framesOpen, setFramesOpen] = useState(false);
  // The right-click menu (findings 62-64): { kind, x, y } plus the open submenu key.
  const [ctxMenu, setCtxMenu] = useState(null);
  const [ctxSub, setCtxSub] = useState(null);
  const [ctxState, setCtxState] = useState({ hasContent: false, locked: false, anyLocked: false });
  const [status, setStatus] = useState(null);
  const [tool, setTool] = useState('selection');
  const [selCount, setSelCount] = useState(0);
  const [styleTarget, setStyleTarget] = useState('fill');
  const [active, setActive] = useState({ fill: null, stroke: null, width: null, text: null, opacity: null });
  const [hasText, setHasText] = useState(false); // the selection carries recolourable text (a bound label or a standalone text)
  const [isConnector, setIsConnector] = useState(false);
  // Wave C: the contextual toolbar. `selBox` is the selection's CLIENT rect, recomputed on
  // every change so the card tracks a drag, a resize, a pan and a zoom; `barSize` is the
  // card's measured size (placement needs the real width to centre it); `tbMenu` is the one
  // open submenu; the rest is what the border / fill / typography / switch popovers read back.
  const [selBox, setSelBox] = useState(null);
  const selBoxSigRef = useRef('');
  const [barSize, setBarSize] = useState({ width: 320, height: 40 });
  // The DRAWING SURFACE, in client coordinates: the card is clamped to this, never to
  // the window, so it can never ride up over the board header or the app's own chrome.
  const [canvasView, setCanvasView] = useState(null);
  const canvasViewSigRef = useRef('');
  const barRef = useRef(null);
  const [tbMenu, setTbMenu] = useState(null); // { key, left, top }
  const [switchAll, setSwitchAll] = useState(false);
  const [shapeKey, setShapeKey] = useState(null);
  const [strokeStyle, setStrokeStyleState] = useState('solid');
  const [radius, setRadius] = useState(0);
  const [radiusEditable, setRadiusEditable] = useState(false);
  const [textStyle, setTextStyle] = useState(null); // { fontFamily, fontSize, textAlign }
  const [copiedStyle, setCopiedStyle] = useState(null);
  const [connStyle, setConnStyle] = useState({ routing: null, dash: null, start: null, end: null, stroke: null, width: null, opacity: null });
  // A single selected connector gets the Miro edit layer (endpoint rings + span
  // handles); the sig re-renders the layer as the arrow's geometry or the
  // viewport moves. connMenu is the open connector-bar submenu (start / end
  // arrowhead picker, or the Type submenu). labelEdit is the inline connector
  // label editor a double-click on a connector opens (finding 22).
  const [connEdit, setConnEdit] = useState(null);
  const connEditSigRef = useRef('');
  const [connMenu, setConnMenu] = useState(null);
  const [labelEdit, setLabelEdit] = useState(null);
  const labelEditRef = useRef(null);
  useEffect(() => { labelEditRef.current = labelEdit; }, [labelEdit]);
  // Custom colour + eyedropper + pre-draw colour state.
  const [recentColors, setRecentColors] = useState(loadRecentColors);
  const [colorPopover, setColorPopover] = useState(null); // { mode, target, x, bottom, value } or null
  const [sampling, setSampling] = useState(null); // { mode, target } while the eyedropper is armed
  const [predraw, setPredraw] = useState({ stroke: null, fill: null }); // current new-item colours
  const [predrawTarget, setPredrawTarget] = useState('line'); // which the pre-draw swatches set
  const predrawSigRef = useRef('');
  const currentAnchorRef = useRef(null); // the connect-dot anchor currently shown (for the keep-alive corridor)
  // Miro canvas/navigation parity: last sticky colour (N re-arms it), the selected
  // sticky's S/M/L + font facts, the zoom readout, wheel mode, minimap, dot grid.
  const lastStickyColorRef = useRef(loadLastStickyColor());
  const [stickySel, setStickySel] = useState(null); // { id, w, h, font } for the style bar segment
  const stickySigRef = useRef('');
  const [zoomPct, setZoomPct] = useState(100);
  const zoomPctRef = useRef(100);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const wheelModeRef = useRef(loadWheelMode());
  const [wheelMode, setWheelMode] = useState(wheelModeRef.current);
  const [minimapOn, setMinimapOn] = useState(false);
  const gridStyleRef = useRef(loadGridStyle());
  const [gridStyle, setGridStyleState] = useState(gridStyleRef.current);
  const dotActiveRef = useRef(false);
  const [dotActive, setDotActive] = useState(false);
  const dotBgRef = useRef(null); // the real background colour while dot mode holds the canvas transparent
  const dotLayerRef = useRef(null);
  // A clean external merge (H1) marks its own onChange so it is absorbed into
  // savedRef instead of scheduling a flush: updateScene re-indexes the merged
  // elements and bumps their versions AFTER the merge effect's synchronous
  // read (measured live: v1->v2 index/version/versionNonce), so without this
  // the bare reload echoed straight back to disk as a save.
  const absorbChangeUntilRef = useRef(0);
  // E2E-only decision trace: the H1 no-echo guarantee is timing-sensitive
  // (mount normalization, absorb windows, debounced flushes), and when it
  // breaks, a drive that can read WHICH decision fired answers in one run what
  // blind theorizing spends hours on.
  const trace = (window.harbor?.e2e)
    ? (entry) => { (window.__harborBoardTrace = window.__harborBoardTrace || []).push({ t: Date.now(), ...entry }); }
    : () => {};

  const initialData = useMemo(() => restore({
    // Normalize existing shapes to a clean (non-sketchy) render: Excalidraw's
    // `roughness` gives the hand-drawn wobble Pat flagged (uneven circles, doubled
    // outlines). Miro-clean means roughness 0 everywhere.
    elements: (board.elements || []).map((element) => ({ ...element, roughness: 0 })),
    // ITEM_DEFAULTS win over the board's saved appState: the clean look (roughness 0,
    // solid fill, Nunito) is Harbor's aesthetic, not a per-board choice, and a board
    // saved with Excalidraw's rough default must not drag new shapes back to sketchy.
    // Smart guides (objectsSnapModeEnabled) DEFAULT ON, Miro-style (finding 66: Miro
    // has no toggle at all); a board whose saved appState explicitly turned them off
    // keeps its choice because the board spread wins over the seed.
    appState: stableAppState({ objectsSnapModeEnabled: true, ...(board.appState || {}), ...ITEM_DEFAULTS }),
    files: board.files || {},
    // repairBindings heals a one-sided containerId/boundElements pair or a
    // dangling arrow binding at load (b6 review M4). Do NOT also add the
    // dimension-refresh option: it re-measures text before the fonts load and
    // would rewrite existing labels with fallback-font metrics (a source-shape
    // spec in test/renderer/board-files.test.js enforces both halves).
  }, null, null, { repairBindings: true }), [board]);

  const flush = useCallback(() => {
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    const { elements, appState, files } = sceneRef.current;
    // Dot-grid mode holds the LIVE canvas transparent (the dots shine through from a
    // CSS layer) with the native grid off; the PERSISTED board must never inherit
    // either, or a CLI export renders background-less and a reload forgets the grid.
    // savedRef still fingerprints the LIVE appState, or every flush would re-schedule
    // itself against a signature it can never reach.
    const persisted = dotBgRef.current
      ? { ...appState, viewBackgroundColor: dotBgRef.current, gridModeEnabled: true, gridSize: appState.gridSize || 20 }
      : appState;
    const scene = JSON.parse(serializeAsJSON(elements, stableAppState(persisted), files, 'local'));
    savedRef.current = { version: getSceneVersion(elements), appSig: appStatePersistSignature(appState) };
    trace({ kind: 'flush', v: savedRef.current.version });
    onSceneChange(scene);
  }, [onSceneChange]);

  const handleChange = useCallback((elements, appState) => {
    sceneRef.current = { elements, appState, files: apiRef.current?.getFiles() || sceneRef.current.files };

    // Sticky maintenance plus connector-label glue, in ONE deferred pass: fit the
    // sticky label font (Miro autosize) and restore a face Excalidraw grew, glue
    // shadow bands to faces, glue fraction labels to their connectors (finding 22),
    // and repair sub-pixel drift on linear points. Deferred to a MICROTASK so we
    // never call updateScene re-entrantly inside onChange, and coalesced by the ref
    // so a burst schedules one pass. Deliberately a microtask, NOT rAF or
    // setTimeout: an occluded window starves BOTH (rAF to zero, timers to the
    // background budget; live-caught 2026-08-30 as the offscreen drive only running
    // this pass when a screenshot forced a frame), and a backgrounded board must
    // keep its invariants. Convergence is the changed-check: every pass is
    // idempotent (spec'd), so the pass after an applied fix schedules nothing.
    if (!syncScheduledRef.current
      && (syncStickyShadows(elements).changed || fitStickyLabels(elements, stickyMeasure).changed
        || syncConnectorLabels(elements).changed || syncPolyConnectors(elements).changed
        || normalizeLinearPoints(elements).changed)) {
      syncScheduledRef.current = true;
      queueMicrotask(() => {
        syncScheduledRef.current = false;
        const api = apiRef.current;
        if (!api) return;
        // Fit BEFORE shadows (bands follow the restored face height), labels after
        // shadows, poly-bound connector glue after labels (a moved poly drags its
        // attached arrow ends along), and the linear-point repair last: Excalidraw's
        // interactive passes can leave an arrow's points[0] a sub-pixel off [0,0],
        // and a later selection then logs "Linear element is not normalized"; the
        // repair is geometry-identical and settles before any selection can
        // construct the editor.
        const fitted = fitStickyLabels(api.getSceneElements(), stickyMeasure);
        const shadows = syncStickyShadows(fitted.elements);
        const labels = syncConnectorLabels(shadows.elements);
        const polys = syncPolyConnectors(labels.elements);
        const normal = normalizeLinearPoints(polys.elements);
        if (fitted.changed || shadows.changed || labels.changed || polys.changed || normal.changed) {
          api.updateScene({ elements: normal.elements, captureUpdate: CaptureUpdateAction.NEVER });
        }
      });
    }

    // A multi-point line/arrow being placed (click-to-add-points). Excalidraw finishes it
    // on Enter, Escape, or double-click, none of which is discoverable, so a hint is shown
    // while this is true. That is the whole "the arrow just kept going" fix.
    const multi = Boolean(appState.multiElement);
    if (multi !== multiRef.current) { multiRef.current = multi; setMultiActive(multi); }

    // While a shape's text editor is open, the connect dots must NOT show over the editor
    // (they would sit on the shape and swallow clicks meant for the text).
    const editing = Boolean(appState.editingElement || appState.editingTextElement);
    if (editing !== editingRef.current) { editingRef.current = editing; setEditingText(editing); }

    // Grid "on" means EITHER the native line grid or our dot layer: dot mode keeps
    // Excalidraw's gridModeEnabled false (it can only draw lines), so the toggle's
    // sense of on/off must include the dot layer or G would read the wrong state.
    const grid = Boolean(appState.gridModeEnabled) || dotActiveRef.current;
    if (grid !== gridRef.current) { gridRef.current = grid; setGridOn(grid); }
    const snap = Boolean(appState.objectsSnapModeEnabled);
    if (snap !== snapRef.current) { snapRef.current = snap; setSnapOn(snap); }
    const activeTool = appState.activeTool?.type || 'selection';
    if (activeTool !== toolRef.current) { toolRef.current = activeTool; setTool(activeTool); }

    // Zoom readout for the bottom-right cluster (finding 70).
    const pct = Math.round((appState.zoom?.value || 1) * 100);
    if (pct !== zoomPctRef.current) { zoomPctRef.current = pct; setZoomPct(pct); }

    // The dot layer is glued to the scene: repaint its pattern on every pan/zoom.
    // Direct style writes on a ref'd div, no React state, so a drag stays cheap.
    if (dotActiveRef.current && dotLayerRef.current) {
      const style = dotGridStyle({
        gridSize: appState.gridSize || 20,
        zoom: appState.zoom?.value || 1,
        scrollX: appState.scrollX || 0,
        scrollY: appState.scrollY || 0,
      });
      Object.assign(dotLayerRef.current.style, style);
    }

    // Current new-item colours drive the pre-draw bar's active swatch (and the wheel's start
    // value). A backgroundColor of 'transparent' is Excalidraw's no-fill default, shown as such.
    const predrawStroke = appState.currentItemStrokeColor || null;
    const predrawFill = appState.currentItemBackgroundColor || null;
    const predrawSig = `${predrawStroke}|${predrawFill}`;
    if (predrawSig !== predrawSigRef.current) { predrawSigRef.current = predrawSig; setPredraw({ stroke: predrawStroke, fill: predrawFill }); }

    const selIds = Object.keys(appState.selectedElementIds || {});
    const selSig = [...selIds].sort().join(',');
    if (selSig !== selSigRef.current) {
      selSigRef.current = selSig;
      if (!selSig) {
        setSelCount(0); setIsConnector(false); setHasText(false);
        setActive({ fill: null, stroke: null, width: null, text: null, opacity: null });
        setShapeKey(null); setTextStyle(null); setRadiusEditable(false); setTbMenu(null); setSwitchAll(false);
        if (tableIdRef.current) { tableIdRef.current = null; setTableId(null); }
      } else {
        const idSet = new Set(selSig.split(','));
        const style = selectionStyle(elements, idSet);
        const opacity = selectionOpacity(elements, idSet);
        setSelCount(style.count);
        // A table cell in the selection surfaces the +/- row/column controls.
        const tid = selectionTableId(elements, idSet);
        if (tid !== tableIdRef.current) { tableIdRef.current = tid; setTableId(tid); }
        // A connector selection gets the connector style bar (routing/dash/caps); a shape
        // selection keeps the fill/line style bar. They are mutually exclusive.
        const conn = selectionIsConnector(elements, idSet);
        setIsConnector(conn);
        // A Text target appears when the selection carries recolourable text: a bound sticky/
        // shape label or a standalone text element. Its colour is read for the active swatch.
        setHasText(selectionHasText(elements, idSet));
        if (conn) setConnStyle({ ...connectorStyle(elements, idSet), stroke: style.stroke, width: style.width, opacity });
        else setActive({ fill: style.fill, stroke: style.stroke, width: style.width, text: selectionTextColor(elements, idSet), opacity });
        // What the contextual toolbar's own popovers read back for this selection.
        setShapeKey(selectionShapeKey(elements, idSet));
        setStrokeStyleState(selectionStrokeStyle(elements, idSet) || 'solid');
        setRadiusEditable(selectionRadiusEditable(elements, idSet));
        setRadius(selectionCornerRadius(elements, idSet) ?? 0);
        setTextStyle(selectionTextStyle(elements, idSet));
        setTbMenu(null);
        setSwitchAll(false);
      }
    }

    // The floating toolbar's anchor. Recomputed on EVERY change, not just a selection
    // change, because the card has to ride a drag, a resize, a pan and a zoom; the
    // rounded signature keeps that to one setState per moved pixel.
    const sceneBox = selIds.length ? selectionSceneBox(elements, new Set(selIds)) : null;
    const clientBox = sceneBox ? sceneBoxToClient(sceneBox, appState) : null;
    const boxSig = clientBox
      ? `${Math.round(clientBox.left)}:${Math.round(clientBox.top)}:${Math.round(clientBox.width)}:${Math.round(clientBox.height)}`
      : '';
    if (boxSig !== selBoxSigRef.current) {
      selBoxSigRef.current = boxSig;
      setSelBox(clientBox);
    }

    const view = {
      left: appState.offsetLeft || 0,
      top: appState.offsetTop || 0,
      width: appState.width || 0,
      height: appState.height || 0,
    };
    const viewSig = `${view.left}:${view.top}:${view.width}:${view.height}`;
    if (viewSig !== canvasViewSigRef.current) {
      canvasViewSigRef.current = viewSig;
      setCanvasView(view.width && view.height ? view : null);
    }

    // The selected sticky face's S/M/L + font facts for the style bar segment.
    // Recomputed each change (a live corner-drag moves w/h without touching the
    // selection), but only for tiny selections so a big rubber-band stays cheap.
    let stickySig = '';
    let stickyFacts = null;
    if (selIds.length >= 1 && selIds.length <= 2) {
      const faceId = selectionStickyFace(elements, new Set(selIds));
      const face = faceId ? elements.find((el) => el.id === faceId) : null;
      if (face) {
        const font = (face.customData && face.customData.sticky && face.customData.sticky.font) || null;
        stickySig = `${face.id}:${Math.round(face.width)}:${Math.round(face.height)}:${font || 0}`;
        stickyFacts = { id: face.id, w: face.width, h: face.height, font };
      }
    }
    if (stickySig !== stickySigRef.current) {
      stickySigRef.current = stickySig;
      setStickySel(stickyFacts);
    }

    // The connector edit layer follows a single selected arrow, re-rendering as
    // its geometry or the viewport changes (the version rides the sig, so an
    // endpoint drag repaints the handles every frame).
    let editSig = '';
    let editId = null;
    if (selIds.length === 1) {
      const selected = elements.find((item) => item.id === selIds[0]);
      if (selected && selected.type === 'arrow' && !selected.isDeleted) {
        editId = selected.id;
        editSig = `${selected.id}:${selected.version}:${(selected.points || []).length}:${appState.zoom?.value || 1}:${Math.round(appState.scrollX)}:${Math.round(appState.scrollY)}`;
      }
    }
    if (editSig !== connEditSigRef.current) {
      connEditSigRef.current = editSig;
      setConnEdit(editId ? { id: editId, sig: editSig } : null);
      if (!editId) setConnMenu(null);
    }

    // Connector dots on a selection that resolves to exactly ONE connectable shape: a
    // lone shape, or a selected STICKY (whose group is a face + its shadow, so the single
    // non-shadow connectable member is the face). More than one connectable = no dots.
    let connectSig = '';
    const connFaces = selIds
      .map((id) => elements.find((item) => item.id === id))
      .filter((item) => isConnectable(item));
    if (connFaces.length === 1) {
      const el = connFaces[0];
      const zoom = appState.zoom?.value || 1;
      const left = (el.x + appState.scrollX) * zoom + (appState.offsetLeft || 0);
      const top = (el.y + appState.scrollY) * zoom + (appState.offsetTop || 0);
      const w = el.width * zoom;
      const h = el.height * zoom;
      connectSig = `${el.id}:${Math.round(left)}:${Math.round(top)}:${Math.round(w)}:${Math.round(h)}`;
      if (connectSig !== connectSigRef.current) setConnectAnchor(anchorForElement(el, appState));
    }
    if (connectSig !== connectSigRef.current) {
      connectSigRef.current = connectSig;
      if (!connectSig) setConnectAnchor(null);
    }

    const next = { version: getSceneVersion(elements), appSig: appStatePersistSignature(appState) };
    if (absorbChangeUntilRef.current) {
      const withinWindow = Date.now() <= absorbChangeUntilRef.current;
      absorbChangeUntilRef.current = 0;
      if (withinWindow) {
        // This onChange is the external merge applying itself (H1); adopting
        // its version as the saved baseline is what keeps a bare reload from
        // echoing back to disk as a save.
        trace({ kind: 'absorb', v: next.version, saved: savedRef.current.version });
        savedRef.current = next;
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
        return;
      }
      trace({ kind: 'absorb-expired', v: next.version, saved: savedRef.current.version });
    }
    if (!boardChanged(savedRef.current, next)) return;
    trace({ kind: 'schedule-flush', v: next.version, saved: savedRef.current.version });
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flush, FLUSH_DELAY_MS);
  }, [flush]);

  useEffect(() => () => { if (flushTimerRef.current) flush(); }, [flush]);

  // H1: the board changed ON DISK under this open canvas (a CLI write pushed
  // over whiteboard:changed). The on-disk scene MERGES into the live one
  // (mergeBoardScene: higher element version wins, unsaved local work
  // survives, disk additions land), so neither side clobbers the other. When
  // the canvas was CLEAN, savedRef is fast-forwarded to the merged version and
  // the pending flush is cancelled, so a bare reload never echoes back as a
  // save; when it was DIRTY, the normal debounce persists the union, which is
  // exactly what keeps the CLI's sticky alive across Pat's next edit. Placed
  // after flush/handleChange on purpose (a dep referenced before declaration
  // is a render-time TDZ crash the build never catches).
  const externalRevisionRef = useRef(0);
  useEffect(() => {
    if (!externalScene || externalScene.revision === externalRevisionRef.current) return;
    const api = apiRef.current;
    if (!api) return;
    externalRevisionRef.current = externalScene.revision;
    const current = api.getSceneElementsIncludingDeleted();
    const dirty = Boolean(flushTimerRef.current) || boardChanged(savedRef.current, {
      version: getSceneVersion(current),
      appSig: appStatePersistSignature(api.getAppState()),
    });
    const merged = mergeBoardScene(current, externalScene.elements);
    const files = newBoardFiles(api.getFiles(), externalScene.files);
    trace({ kind: 'merge', dirty, changed: merged.changed, canvasAhead: merged.canvasAhead, timer: Boolean(flushTimerRef.current), v: getSceneVersion(current), saved: savedRef.current.version });
    if (!merged.changed && !files.length && !merged.canvasAhead) return;
    if (files.length) api.addFiles(files);
    if (merged.changed) {
      // NEVER: an outside write is not a step in Pat's undo history.
      api.updateScene({ elements: merged.elements, captureUpdate: CaptureUpdateAction.NEVER });
    }
    if (!dirty && !merged.canvasAhead) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
      // updateScene applies (and re-indexes, version-bumping) the merged
      // elements on a LATER onChange than this synchronous read, so the next
      // onChange within the window is absorbed as this merge's own
      // application rather than compared against a stale baseline.
      if (merged.changed) absorbChangeUntilRef.current = Date.now() + 500;
      savedRef.current = {
        version: getSceneVersion(api.getSceneElementsIncludingDeleted()),
        appSig: appStatePersistSignature(api.getAppState()),
      };
    } else if (merged.canvasAhead && !flushTimerRef.current) {
      // The disk is BEHIND the canvas (a CLI read-modify-write raced a save):
      // persist the union even though local editing state reads clean, or the
      // app's own last edit never reaches the file.
      flushTimerRef.current = setTimeout(flush, FLUSH_DELAY_MS);
    }
  }, [externalScene, flush]);

  // Miro-style hover dots: hovering ANY connectable shape (selection tool, no button
  // held) reveals its four edge dots so a connector can be dragged from it, not just
  // from the selected shape. A held button means a drag/pan is underway, so the anchor
  // is frozen (the dots must not chase the cursor mid-connect).
  useEffect(() => {
    const onMove = (event) => {
      if (event.buttons) return;
      const api = apiRef.current;
      if (!api) return;
      const t = event.target;
      if (t instanceof Element && t.closest('.wb-connect-dot')) return;
      if (toolRef.current !== 'selection' || !(t instanceof Element) || !t.closest('.excalidraw') || t.closest('.wb-rail, .wb-style-bar')) {
        if (hoverSigRef.current) { hoverSigRef.current = ''; setHoverAnchor(null); }
        return;
      }
      const el = elementAtClient(api, event.clientX, event.clientY, null);
      if (el && isConnectable(el)) {
        const app = api.getAppState();
        const zoom = app.zoom?.value || 1;
        const sig = `${el.id}:${Math.round((el.x + app.scrollX) * zoom)}:${Math.round((el.y + app.scrollY) * zoom)}:${Math.round(el.width * zoom)}`;
        if (sig !== hoverSigRef.current) { hoverSigRef.current = sig; setHoverAnchor(anchorForElement(el, app)); }
      } else if (hoverSigRef.current) {
        // Not over the shape body, but keep the dots alive if the cursor is heading INTO one of
        // the four dots (they sit a gap outside the edges); otherwise moving off the body to
        // reach a dot would drop the dots before you get there (Pat's report).
        const anchor = currentAnchorRef.current;
        const nearDot = anchor && ['top', 'right', 'bottom', 'left'].some((k) => (
          anchor[k] && Math.hypot(event.clientX - anchor[k].x, event.clientY - anchor[k].y) <= DOT_KEEP_RADIUS
        ));
        if (!nearDot) { hoverSigRef.current = ''; setHoverAnchor(null); }
      }
    };
    // A drag freezes the hover anchor (button held), so a stale hover position would
    // otherwise override the live selection anchor and the dots would LAG behind the
    // shape being moved (Pat's report). Clearing the hover anchor when a non-dot drag
    // starts lets the selection anchor, which tracks the move frame by frame, drive the
    // dots. A drag that starts ON a connect dot keeps the anchor (that IS the connector drag).
    const onDown = (event) => {
      const t = event.target;
      if (t instanceof Element && t.closest('.wb-connect-dot')) return;
      if (hoverSigRef.current) { hoverSigRef.current = ''; setHoverAnchor(null); }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerdown', onDown, true); };
  }, []);

  const flash = useCallback((message) => {
    setStatus(message);
    setTimeout(() => setStatus((current) => (current === message ? null : current)), 1400);
  }, []);

  const insertSkeleton = useCallback((skeleton, { select = true, fit = false, group = false, scroll = true } = {}) => {
    const api = apiRef.current;
    if (!api) return [];
    const created = convertToExcalidrawElements(skeleton);
    // Bound labels convert with Excalidraw's default hand-drawn font; force the
    // clean sans so templates and stickies read like Miro, not a napkin.
    created.forEach((element) => { if (element.type === 'text') element.fontFamily = CLEAN_FONT; });
    // A sticky insert links its shadow bands (locked in the skeleton) to its face by
    // id, so syncStickyShadows glues them without GROUPING them: the face stays a
    // normal single element that click, double-click-to-type, and connectors treat
    // as one shape. The face is the last non-shadow rectangle (a text label from a
    // `label` skeleton converts to an EXTRA element, so position is not trusted).
    if (group && created.length > 1) {
      const face = [...created].reverse().find((el) => el.type === 'rectangle' && !isStickyShadow(el));
      if (face) {
        created.forEach((el) => {
          if (isStickyShadow(el)) el.customData = { ...(el.customData || {}), stickyShadow: true, faceId: face.id };
        });
      }
    }
    api.updateScene({ elements: [...api.getSceneElements(), ...created], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    if (select && created.length) {
      // Never select the shadow (it is locked decoration); a sticky selects as its face.
      const selectedElementIds = {};
      created.forEach((element) => { if (!isStickyShadow(element)) selectedElementIds[element.id] = true; });
      api.updateScene({ appState: { selectedElementIds }, captureUpdate: CaptureUpdateAction.EVENTUALLY });
    }
    if (fit) api.scrollToContent(created, { fitToContent: true, animate: true, duration: 300 });
    else if (scroll && select && created.length) api.scrollToContent(created, { animate: false });
    return created;
  }, []);

  // Drop a sticky of `colorKey` with its CENTRE at scene point (sx, sy). No scroll: the
  // sticky lands under the cursor, which is already in view, so re-centring would jump.
  const placeStickyAtScene = useCallback((colorKey, sx, sy) => {
    insertSkeleton(stickyNoteSkeleton({ color: colorKey, x: sx - STICKY_SIZE / 2, y: sy - STICKY_SIZE / 2 }), { group: true, scroll: false });
  }, [insertSkeleton]);

  // Arm (or re-arm) sticky placement, Miro-style: open the colour flyout, disarm any other
  // flyout, and keep Excalidraw's own tool out of the way so a canvas click means "place a
  // sticky here", not "start a selection". Clicking the tool again disarms. With no colour
  // named, the LAST placed colour arms (finding 30: N places the last color).
  const armSticky = useCallback((colorKey) => {
    const api = apiRef.current;
    if (api) api.setActiveTool({ type: 'selection' });
    setPlacingShape(null);
    setDrawRect(null);
    setTemplatesOpen(false);
    setShapesOpen(false);
    setPlacingSticky((current) => (colorKey || (current ? null : lastStickyColorRef.current)));
  }, []);

  // Pick a shape from the flyout. A NATIVE shape (rectangle/rounded/ellipse/diamond) uses
  // Excalidraw's own tool (drag-to-draw, double-click-to-add-text); rounded sets the round
  // corner style first. A POLY shape arms draw-to-size (`placingShape`): a canvas drag draws
  // it at that size, a plain click drops a default-sized one.
  const pickShape = useCallback((def) => {
    const api = apiRef.current;
    if (!api) return;
    setPlacingSticky(null);
    setShapesOpen(false);
    if (def.kind === 'native') {
      setPlacingShape(null);
      setDrawRect(null);
      api.updateScene({ appState: { currentItemRoundness: def.rounded ? 'round' : 'sharp' }, captureUpdate: CaptureUpdateAction.EVENTUALLY });
      api.setActiveTool({ type: def.tool });
      return;
    }
    api.setActiveTool({ type: 'selection' });
    setPlacingShape(def.key);
  }, []);

  const addTemplate = useCallback((key) => {
    setTemplatesOpen(false);
    const api = apiRef.current;
    const template = TEMPLATES.find((item) => item.key === key);
    if (!api || !template) return;
    const { x, y } = placeCentered(api.getAppState(), template.width, template.height);
    insertSkeleton(template.build(x, y), { select: false, fit: true });
  }, [insertSkeleton]);

  const pickTool = useCallback((entry) => {
    const api = apiRef.current;
    if (!api) return;
    setPlacingSticky(null); // choosing any other tool disarms sticky placement
    setPlacingShape(null);
    setDrawRect(null);
    if (entry.action) { armSticky(); return; }
    api.setActiveTool({ type: entry.key });
  }, [armSticky]);

  // Drop a rows x cols table centred in the viewport. Cells are editable rectangles sharing
  // one table id; double-click a cell to type. Not selected on drop (selecting every cell
  // would hide the double-click-to-type affordance behind a multi-select).
  const addTable = useCallback((rows, cols) => {
    setTablesOpen(false);
    setPlacingSticky(null);
    setPlacingShape(null);
    const api = apiRef.current;
    if (!api) return;
    const tid = `tbl-${(globalThis.crypto?.randomUUID?.() || String(Date.now())).slice(0, 8)}`;
    const { x, y } = placeCentered(api.getAppState(), cols * TABLE_CELL_W, rows * TABLE_CELL_H);
    const created = insertSkeleton(tableSkeleton(tid, rows, cols, x, y), { select: false, scroll: false });
    if (created.length) api.scrollToContent(created, { animate: false });
  }, [insertSkeleton]);

  // Add/remove the last table row or column of the selected cell's table. Adds go through
  // convertToExcalidrawElements (fresh ids, customData preserved); removes MARK isDeleted so
  // updateScene actually drops them (a merge keeps omitted elements).
  const addTableCells = useCallback((skeletonsFor) => {
    const api = apiRef.current;
    const tid = tableIdRef.current;
    if (!api || !tid) return;
    const skeletons = skeletonsFor(api.getSceneElements(), tid);
    if (!skeletons.length) return;
    const created = convertToExcalidrawElements(skeletons);
    api.updateScene({ elements: [...api.getSceneElements(), ...created], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }, []);

  const mutateTable = useCallback((mutator) => {
    const api = apiRef.current;
    const tid = tableIdRef.current;
    if (!api || !tid) return;
    api.updateScene({ elements: mutator(api.getSceneElements(), tid), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }, []);

  // While armed, a left click on the CANVAS drops ONE ~110px sticky centred where you
  // clicked, which immediately enters text edit with the caret ready, and the tool
  // DISARMS: one click, one sticky, straight into typing (Miro's model, finding 30;
  // this deliberately replaces the 2026-08-26 stay-armed behaviour). Clicks on the
  // rail/style-bar/connect-dots are not placements. The handler is capture-phase so
  // Excalidraw never also starts a selection; the text edit is a real double-click
  // dispatched at the same point two frames later, once the face is hit-testable,
  // because Excalidraw has no public start-text-editing API.
  useEffect(() => {
    if (!placingSticky) return undefined;
    const onDown = (event) => {
      if (event.button !== 0) return;
      const t = event.target;
      if (!(t instanceof Element) || !t.closest('.excalidraw') || t.closest('.wb-rail, .wb-style-bar, .wb-connect-dot')) return;
      const api = apiRef.current;
      if (!api) return;
      const app = api.getAppState();
      const zoom = app.zoom?.value || 1;
      const sceneX = (event.clientX - (app.offsetLeft || 0)) / zoom - app.scrollX;
      const sceneY = (event.clientY - (app.offsetTop || 0)) / zoom - app.scrollY;
      placeStickyAtScene(placingSticky, sceneX, sceneY);
      lastStickyColorRef.current = placingSticky;
      try { window.localStorage.setItem(LAST_STICKY_KEY, placingSticky); } catch { /* ignore */ }
      setPlacingSticky(null);
      const { clientX, clientY } = event;
      // The edit-opening dblclick rides the click's own POINTERUP, not a timer or a
      // frame: an occluded window starves rAF and throttles setTimeout (live-caught
      // 2026-08-30, nondeterministically), while the pointerup of the very click
      // that placed the sticky always arrives. The microtask hop lets Excalidraw
      // finish its own pointerup handling before the dblclick lands.
      const openEditor = () => {
        window.removeEventListener('pointerup', openEditor, true);
        queueMicrotask(() => {
          const under = document.elementFromPoint(clientX, clientY);
          if (under && under.closest('.excalidraw')) {
            under.dispatchEvent(new MouseEvent('dblclick', { clientX, clientY, bubbles: true, cancelable: true, view: window }));
          }
        });
      };
      window.addEventListener('pointerup', openEditor, true);
      event.preventDefault();
      event.stopPropagation();
    };
    document.body.classList.add('wb-placing-sticky');
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      document.body.classList.remove('wb-placing-sticky');
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [placingSticky, placeStickyAtScene]);

  // Draw-to-size a POLY shape (Miro): drag on the canvas draws the armed shape at that size;
  // a plain click drops a default-sized one where clicked. Capture-phase so Excalidraw (in
  // selection tool) never also starts a selection box. One-shot: it disarms after one draw,
  // like Excalidraw's own shape tools. A rubber-band rect (drawRect) shows the live size.
  useEffect(() => {
    if (!placingShape) return undefined;
    let start = null;
    const clientToScene = (cx, cy) => {
      const app = apiRef.current.getAppState();
      const zoom = app.zoom?.value || 1;
      return { x: (cx - (app.offsetLeft || 0)) / zoom - app.scrollX, y: (cy - (app.offsetTop || 0)) / zoom - app.scrollY };
    };
    const isCanvas = (t) => t instanceof Element && t.closest('.excalidraw') && !t.closest('.wb-rail, .wb-style-bar, .wb-connect-dot, .wb-hint');
    const onDown = (event) => {
      if (event.button !== 0 || !isCanvas(event.target)) return;
      start = { x: event.clientX, y: event.clientY };
      setDrawRect({ x: event.clientX, y: event.clientY, w: 0, h: 0 });
      event.preventDefault();
      event.stopPropagation();
    };
    const onMove = (event) => {
      if (!start) return;
      setDrawRect({ x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), w: Math.abs(event.clientX - start.x), h: Math.abs(event.clientY - start.y) });
    };
    const onUp = (event) => {
      if (!start) return;
      const api = apiRef.current;
      const zoom = api.getAppState().zoom?.value || 1;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      let sceneX; let sceneY; let w; let h;
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) {
        const c = clientToScene(start.x, start.y);
        w = DEFAULT_SHAPE_SIZE; h = DEFAULT_SHAPE_SIZE;
        sceneX = c.x - w / 2; sceneY = c.y - h / 2;
      } else {
        const p0 = clientToScene(Math.min(start.x, event.clientX), Math.min(start.y, event.clientY));
        w = Math.abs(dx) / zoom; h = Math.abs(dy) / zoom;
        sceneX = p0.x; sceneY = p0.y;
      }
      // Honour the pre-draw colours for a poly shape too: currentItemStrokeColor for the
      // outline, and a non-transparent currentItemBackgroundColor for the fill (else the clean
      // default fill stands). shapeSkeleton falls back to SHAPE_FILL/SHAPE_STROKE for undefined.
      const app = api.getAppState();
      const bg = app.currentItemBackgroundColor;
      insertSkeleton(shapeSkeleton(placingShape, sceneX, sceneY, w, h, {
        stroke: app.currentItemStrokeColor || undefined,
        fill: (bg && bg !== 'transparent') ? bg : undefined,
        strokeWidth: app.currentItemStrokeWidth || undefined,
      }), { scroll: false });
      start = null;
      setDrawRect(null);
      setPlacingShape(null);
    };
    document.body.classList.add('wb-placing-shape');
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    return () => {
      document.body.classList.remove('wb-placing-shape');
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
    };
  }, [placingShape, insertSkeleton]);

  // Grid mode in the LINE style both DRAWS the background grid and snaps element
  // create/move/resize to it (Excalidraw's gridModeEnabled does both natively,
  // verified: an off-grid draw lands on gridSize multiples). The DOT style (Miro's
  // View > Dot grid, finding 72) cannot use that path: Excalidraw couples drawing
  // and snap on one flag and only draws lines, so dots render as our own CSS layer
  // under a transparent canvas, native grid off. That matches Miro exactly, whose
  // own snap-to-grid is a separate toggle OFF by default; the flash says which
  // behaviour is in force so neither mode lies about snapping.
  const applyGridMode = useCallback((on, style) => {
    const api = apiRef.current;
    if (!api) return;
    const dot = on && style === 'dot';
    const patch = { gridModeEnabled: on && style === 'line', gridSize: on ? 20 : null };
    if (dot && !dotBgRef.current) {
      const bg = api.getAppState().viewBackgroundColor;
      dotBgRef.current = bg && bg !== 'transparent' ? bg : '#ffffff';
      patch.viewBackgroundColor = 'transparent';
    } else if (!dot && dotBgRef.current) {
      patch.viewBackgroundColor = dotBgRef.current;
      dotBgRef.current = null;
    }
    dotActiveRef.current = dot;
    setDotActive(dot);
    document.body.classList.toggle('wb-dot-grid', dot);
    gridRef.current = on;
    setGridOn(on);
    api.updateScene({ appState: patch, captureUpdate: CaptureUpdateAction.EVENTUALLY });
    if (dot && dotLayerRef.current) {
      const app = api.getAppState();
      Object.assign(dotLayerRef.current.style, dotGridStyle({
        gridSize: 20, zoom: app.zoom?.value || 1, scrollX: app.scrollX || 0, scrollY: app.scrollY || 0,
      }));
    }
  }, []);

  const toggleGrid = useCallback(() => {
    const on = !gridRef.current;
    applyGridMode(on, gridStyleRef.current);
    flash(on ? (gridStyleRef.current === 'dot' ? 'Dot grid on' : 'Grid on, shapes snap to it') : 'Grid off');
  }, [applyGridMode, flash]);

  const setGridStyle = useCallback((style) => {
    gridStyleRef.current = style;
    setGridStyleState(style);
    try { window.localStorage.setItem(GRID_STYLE_KEY, style); } catch { /* ignore */ }
    if (gridRef.current) applyGridMode(true, style);
  }, [applyGridMode]);

  // Object snapping is the other alignment aid: smart guides that snap an element to
  // the edges and centres of OTHER elements (distinct from grid snapping above).
  const toggleSnap = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const on = !snapRef.current;
    snapRef.current = on; setSnapOn(on);
    api.updateScene({ appState: { objectsSnapModeEnabled: on }, captureUpdate: CaptureUpdateAction.EVENTUALLY });
    flash(on ? 'Snap to objects on' : 'Snap to objects off');
  }, [flash]);

  // The dots currently on screen come from `hoverAnchor || connectAnchor`; the keep-alive
  // corridor test needs their live positions from inside a stable (mounted-once) listener.
  useEffect(() => { currentAnchorRef.current = hoverAnchor || connectAnchor; }, [hoverAnchor, connectAnchor]);

  const pushRecent = useCallback((hex) => {
    setRecentColors((current) => { const next = addRecentColor(current, hex); saveRecentColors(next); return next; });
  }, []);

  // The one place a chosen colour (swatch, wheel, hex, recent, or eyedropper sample) is applied.
  // `mode` decides where it lands: a shape/text selection (fill or line), a connector's stroke,
  // or the pre-draw default for the next new item. Every real colour is remembered for reuse.
  const applyColorValue = useCallback((mode, target, hex) => {
    const api = apiRef.current;
    if (!api) return;
    if (mode === 'predraw') {
      const prop = target === 'fill' ? 'currentItemBackgroundColor' : 'currentItemStrokeColor';
      api.updateScene({ appState: { [prop]: hex }, captureUpdate: CaptureUpdateAction.EVENTUALLY });
      setPredraw((current) => ({ ...current, [target === 'fill' ? 'fill' : 'stroke']: hex }));
    } else {
      const ids = selectedIdSet(api);
      if (!ids.size) return;
      if (mode === 'connector') {
        api.updateScene({ elements: setSelectionProp(api.getSceneElements(), ids, 'strokeColor', hex), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        setConnStyle((current) => ({ ...current, stroke: hex }));
      } else if (target === 'text') {
        // Recolour the bound label (sticky/shape) or a standalone text, not the container.
        api.updateScene({ elements: recolorText(api.getSceneElements(), ids, hex), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        setActive((current) => ({ ...current, text: hex }));
      } else {
        api.updateScene({ elements: recolorElements(api.getSceneElements(), ids, target, hex), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        setActive((current) => (target === 'line' ? { ...current, stroke: hex } : { ...current, fill: hex }));
      }
    }
    pushRecent(hex); // addRecentColor ignores 'transparent'/invalid, so no-fill never enters the list
  }, [pushRecent]);

  // Open the custom-colour popover next to the trigger button, carrying which target it
  // feeds. It opens DOWNWARD (Miro's submenu direction) and flips above only when the
  // bottom of the window would cut it off, which is what a bottom-anchored bar needs.
  const openColorPopover = useCallback((mode, target, event, value) => {
    setSampling(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 220;
    const height = 190;
    const x = Math.max(8, Math.min(rect.left - 40, window.innerWidth - width - 16));
    let y = rect.bottom + 8;
    if (y + height > window.innerHeight - 8) y = Math.max(8, rect.top - 8 - height);
    setColorPopover((current) => (
      current && current.mode === mode && current.target === target
        ? null // clicking the same custom button again closes it
        : { mode, target, value: value || '', x, y }
    ));
  }, []);

  // Arm the eyedropper for a target; the next canvas click samples a pixel and applies it.
  const startSampling = useCallback((mode, target) => {
    setColorPopover(null);
    setSampling({ mode, target });
    flash('Click the board to sample a colour, Esc to cancel');
  }, [flash]);

  // Eyedropper: while armed, a canvas click samples the pixel under it (from the rendered
  // scene, so it reads a dropped/pasted image's colours) and applies it to the armed target,
  // then disarms. Capture-phase so Excalidraw never also starts a selection; Escape cancels.
  // Placed AFTER applyColorValue on purpose: its dep array is read during render, so referencing
  // applyColorValue before its declaration would be a temporal-dead-zone error.
  useEffect(() => {
    if (!sampling) return undefined;
    const onDown = (event) => {
      if (event.button !== 0) return;
      const t = event.target;
      if (!(t instanceof Element) || !t.closest('.excalidraw') || t.closest('.wb-rail, .wb-style-bar, .wb-color-pop, .wb-connect-dot')) return;
      event.preventDefault();
      event.stopPropagation();
      const hex = sampleCanvasColor(event.clientX, event.clientY, apiRef.current);
      if (hex) { applyColorValue(sampling.mode, sampling.target, hex); flash(`Sampled ${hex}`); }
      else flash('Nothing to sample there');
      setSampling(null);
    };
    const onKey = (event) => { if (event.key === 'Escape') setSampling(null); };
    document.body.classList.add('wb-sampling');
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.classList.remove('wb-sampling');
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [sampling, applyColorValue, flash]);

  const applyWidth = useCallback((value) => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: setSelectionProp(api.getSceneElements(), ids, 'strokeWidth', value), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setActive((current) => ({ ...current, width: value }));
    setConnStyle((current) => ({ ...current, width: value }));
  }, []);

  // Opacity (transparency) 0-100 for the selection. Excalidraw's own element property, so a
  // shape, sticky, text, or connector goes translucent uniformly. A sticky's locked shadow is
  // never in the selection, so it keeps its own faint opacity.
  const applyOpacity = useCallback((value) => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: setSelectionProp(api.getSceneElements(), ids, 'opacity', value), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setActive((current) => ({ ...current, opacity: value }));
    setConnStyle((current) => ({ ...current, opacity: value }));
  }, []);

  // Connector style bar handlers: routing rewrites the connector's points (straight /
  // curved / elbow), dash sets strokeStyle, heads sets start/end arrowheads, colour sets
  // strokeColor. Each mirrors the change into connStyle so the toolbar highlights it.
  const applyRouting = useCallback((kind) => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: setConnectorRouting(api.getSceneElements(), ids, kind), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setConnStyle((current) => ({ ...current, routing: kind }));
  }, []);

  const applyDash = useCallback((style) => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: setConnectorDash(api.getSceneElements(), ids, style), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setConnStyle((current) => ({ ...current, dash: style }));
  }, []);

  // Per-end arrowhead pick (finding 25): each end chooses independently from the
  // native head set; Swap line ends flips them (finding 23).
  const applyHead = useCallback((whichEnd, value) => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: setConnectorHead(api.getSceneElements(), ids, whichEnd, value), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setConnStyle((current) => ({ ...current, [whichEnd]: value ?? null }));
    setConnMenu(null);
  }, []);

  const swapEnds = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: swapConnectorHeads(api.getSceneElements(), ids), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setConnStyle((current) => ({ ...current, start: current.end, end: current.start }));
  }, []);

  // Double-click anywhere ON a connector opens an inline label editor AT that
  // point (finding 22); the fraction along the line is stored on the label so it
  // survives re-route and routing-type changes. Native gestures win where they
  // exist: a double-click on a shape (bound text) or on a text element (edit it)
  // is never intercepted. Capture phase, so Excalidraw's own arrow double-click
  // (which would open a midpoint-bound label) never also fires.
  useEffect(() => {
    const onDblClick = (event) => {
      const api = apiRef.current;
      if (!api) return;
      const t = event.target;
      if (!(t instanceof Element) || !t.closest('.excalidraw')) return;
      if (t.closest('.wb-rail, .wb-style-bar, .wb-connect-dot, .wb-conn-end, .wb-conn-mid, .wb-label-input')) return;
      const app = api.getAppState();
      const scene = clientToScene(app, event.clientX, event.clientY);
      const els = api.getSceneElements();
      if (elementAtClient(api, event.clientX, event.clientY, null)) return;
      if (textAtScene(els, scene)) return;
      const zoom = app.zoom?.value || 1;
      const hit = connectorAtScene(els, scene, 6 / zoom);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      setLabelEdit({ arrowId: hit.el.id, t: hit.t, x: event.clientX, y: event.clientY, value: '' });
    };
    window.addEventListener('dblclick', onDblClick, true);
    return () => window.removeEventListener('dblclick', onDblClick, true);
  }, []);

  const commitLabel = useCallback((text) => {
    const pending = labelEditRef.current;
    labelEditRef.current = null; // an unmount blur must not commit twice (or after Escape)
    setLabelEdit(null);
    const api = apiRef.current;
    const value = String(text || '').trim();
    if (!api || !pending || !value) return;
    const arrow = api.getSceneElements().find((e) => e.id === pending.arrowId);
    if (!arrow) return;
    const [created] = convertToExcalidrawElements([{ type: 'text', text: value, fontSize: 16, x: 0, y: 0, strokeColor: '#1a1a1a' }]);
    created.fontFamily = CLEAN_FONT;
    created.customData = { labelFor: arrow.id, labelFraction: pending.t };
    const [lx, ly] = pointAtFraction(arrow.points || [[0, 0], [0, 0]], pending.t);
    created.x = arrow.x + lx - created.width / 2;
    created.y = arrow.y + ly - created.height / 2;
    api.updateScene({ elements: [...api.getSceneElements(), created], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }, []);

  const copyPng = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    flash(await copyElementsAsPng(api, api.getSceneElements()));
  }, [flash]);

  // Fit every element into view (Miro's "fit to screen", Alt+1), or reset zoom on an empty board.
  const zoomToFit = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const elements = api.getSceneElements();
    if (elements.length) api.scrollToContent(elements, { fitToContent: true, animate: true, duration: 300 });
    else api.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } }, captureUpdate: CaptureUpdateAction.NEVER });
  }, []);

  // Zoom to the selection (Miro's Alt+2); nothing selected is a quiet no-op.
  const zoomToSelection = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    const els = api.getSceneElements().filter((el) => ids.has(el.id));
    if (els.length) api.scrollToContent(els, { fitToContent: true, animate: true, duration: 300 });
  }, []);

  // Jump to an absolute zoom level anchored at the viewport centre (the zoom menu's
  // 50/100/200/400 rows and Ctrl+0's 100%).
  const setZoomLevel = useCallback((level) => {
    const api = apiRef.current;
    if (!api) return;
    setZoomMenuOpen(false);
    const app = api.getAppState();
    const plan = zoomAtPoint(app, level, (app.offsetLeft || 0) + (app.width || 0) / 2, (app.offsetTop || 0) + (app.height || 0) / 2);
    api.updateScene({ appState: { zoom: { value: plan.zoom }, scrollX: plan.scrollX, scrollY: plan.scrollY }, captureUpdate: CaptureUpdateAction.NEVER });
  }, []);

  // The +/- buttons beside the readout: one Miro-ish step, centre-anchored.
  const stepZoom = useCallback((factor) => {
    const api = apiRef.current;
    if (!api) return;
    const app = api.getAppState();
    const plan = zoomAtPoint(app, (app.zoom?.value || 1) * factor, (app.offsetLeft || 0) + (app.width || 0) / 2, (app.offsetTop || 0) + (app.height || 0) / 2);
    api.updateScene({ appState: { zoom: { value: plan.zoom }, scrollX: plan.scrollX, scrollY: plan.scrollY }, captureUpdate: CaptureUpdateAction.NEVER });
  }, []);

  const setWheelModePref = useCallback((mode) => {
    wheelModeRef.current = mode;
    setWheelMode(mode);
    try { window.localStorage.setItem(WHEEL_MODE_KEY, mode); } catch { /* ignore */ }
  }, []);

  // Mouse mode (finding 69, the default): a plain wheel over the CANVAS zooms at the
  // cursor, Miro-style. Modified wheels (ctrl = trackpad pinch, shift = horizontal
  // scroll) and wheels over menus/inputs keep their native meaning, and Trackpad mode
  // touches nothing at all. Capture-phase on window so Excalidraw's own wheel-pans
  // never race it; targeting the CANVAS element only is what protects every overlay.
  useEffect(() => {
    const onWheel = (event) => {
      if (wheelModeRef.current !== 'mouse') return;
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      const t = event.target;
      if (!(t instanceof Element) || t.tagName !== 'CANVAS' || !t.closest('.excalidraw')) return;
      const api = apiRef.current;
      if (!api) return;
      event.preventDefault();
      event.stopPropagation();
      const plan = wheelZoomPlan(api.getAppState(), event.clientX, event.clientY, event.deltaY);
      api.updateScene({ appState: { zoom: { value: plan.zoom }, scrollX: plan.scrollX, scrollY: plan.scrollY }, captureUpdate: CaptureUpdateAction.NEVER });
    };
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // PgUp/PgDn z-order (catalog finding 57: PgUp to front, Shift+PgUp one step forward,
  // PgDn/Shift+PgDn mirrored). reorderElements carries shadows and bound text along.
  const applyZOrder = useCallback((op) => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    const next = reorderElements(api.getSceneElements(), ids, op);
    if (next) api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }, []);

  // S/M/L sticky presets (finding 32): the intended size changes with the box so the
  // autosize pass refits the label against the new square instead of snapping back.
  const applyStickySize = useCallback((px) => {
    const api = apiRef.current;
    const id = stickySigRef.current.split(':')[0];
    if (!api || !id) return;
    api.updateScene({
      elements: api.getSceneElements().map((el) => (el.id === id ? {
        ...el,
        width: px,
        height: px,
        customData: { ...(el.customData || {}), sticky: { ...((el.customData || {}).sticky || {}), w: px, h: px } },
      } : el)),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, []);

  // Pin a numeric label size, or null to return to Miro's Auto mode (finding 31).
  const applyStickyFont = useCallback((font) => {
    const api = apiRef.current;
    const id = stickySigRef.current.split(':')[0];
    if (!api || !id) return;
    api.updateScene({
      elements: api.getSceneElements().map((el) => {
        if (el.id !== id) return el;
        const sticky = { ...((el.customData || {}).sticky || {}) };
        if (sticky.w == null) { sticky.w = el.width; sticky.h = el.height; }
        if (font) sticky.font = font; else delete sticky.font;
        return { ...el, customData: { ...(el.customData || {}), sticky } };
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }, []);

  // ---- Contextual toolbar handlers (findings 46-48, 56, 57) ---------------------------
  // Every one of these writes through a PURE helper in board-files.cjs and mirrors the
  // result into the toolbar's own state, so the popover highlights what the board carries.
  const applyBorderStyle = useCallback((key) => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: setSelectionProp(api.getSceneElements(), ids, 'strokeStyle', key), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setStrokeStyleState(key);
  }, []);

  const applyCornerRadius = useCallback((value) => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: setCornerRadius(api.getSceneElements(), ids, value), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setRadius(value);
  }, []);

  // Switch type converts IN PLACE on the same ids, so a connector bound to the shape
  // stays bound and the stack position never moves (the whole point of the gesture).
  const applySwitchType = useCallback((key) => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: switchShapeType(api.getSceneElements(), ids, key), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setShapeKey(key);
    setTbMenu(null);
  }, []);

  // Typography: family / size / alignment onto every text the selection carries. The
  // glyph measure is passed so a bound label is re-laid-out (Excalidraw only re-measures
  // through its own editing actions, so a font written straight in would keep the old box).
  const applyTextProp = useCallback((prop, value) => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: setTextProp(api.getSceneElements(), ids, prop, value, stickyMeasure), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setTextStyle((current) => ({ ...(current || {}), [prop]: value }));
  }, []);

  // A sticky owns its own label size (Auto, or a pinned number), so the one size control
  // routes there for a sticky and to the text element itself for anything else.
  const applyFontSize = useCallback((value) => {
    const size = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(value)));
    if (stickySigRef.current) applyStickyFont(size);
    else applyTextProp('fontSize', size);
  }, [applyStickyFont, applyTextProp]);

  const doCopyStyle = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    const style = copySelectionStyle(api.getSceneElements(), ids);
    if (!style) { flash('Nothing to copy a style from'); return; }
    setCopiedStyle(style);
    setTbMenu(null);
    flash('Style copied');
  }, [flash]);

  const doPasteStyle = useCallback(() => {
    const api = apiRef.current;
    if (!api || !copiedStyle) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({ elements: pasteSelectionStyle(api.getSceneElements(), ids, copiedStyle), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    setTbMenu(null);
    flash('Style pasted');
  }, [copiedStyle, flash]);

  // ---- Wave D actions (catalog findings 40, 56, 61-64) --------------------------------
  // Each is the canvas half of a PURE decision in board-files.cjs; nothing here decides
  // anything the unit specs cannot also decide.

  // Drop a preset frame centred in the viewport (finding 40). Custom arms Excalidraw's
  // own frame tool instead, which is the drag-to-draw Miro's Custom gives you.
  const addFrame = useCallback((key) => {
    setFramesOpen(false);
    setPlacingSticky(null);
    setPlacingShape(null);
    const api = apiRef.current;
    if (!api) return;
    if (key === 'custom') { api.setActiveTool({ type: 'frame' }); return; }
    const skeleton = frameSkeleton(key, 0, 0);
    if (!skeleton.length) return;
    const { x, y } = placeCentered(api.getAppState(), skeleton[0].width, skeleton[0].height);
    const created = insertSkeleton(skeleton.map((el) => ({ ...el, x, y })), { select: true, fit: true });
    if (created.length) flash(`${skeleton[0].name} frame`);
  }, [insertSkeleton, flash]);

  const copySelectionPng = useCallback(async () => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    const picked = api.getSceneElements().filter((el) => ids.has(el.id) || (el.containerId && ids.has(el.containerId))
      || (isStickyShadow(el) && ids.has(el.customData.faceId)));
    flash(await copyElementsAsPng(api, picked.length ? picked : api.getSceneElements()));
  }, [flash]);

  // Lock / Unlock the selection (finding 61). A locked element stops being selectable, so
  // the selection is cleared on lock: leaving it selected would leave a floating toolbar
  // pointed at something the next click can no longer reach.
  const toggleLock = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    const els = api.getSceneElements();
    const locked = selectionLocked(els, ids);
    api.updateScene({ elements: lockElements(els, ids, !locked), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    if (!locked) api.updateScene({ appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.EVENTUALLY });
    flash(locked ? 'Unlocked' : 'Locked');
  }, [flash]);

  const doUnlockAll = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const next = unlockAllElements(api.getSceneElements());
    if (!next.changed) { flash('Nothing is locked'); return; }
    api.updateScene({ elements: next.elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    flash('Unlocked all');
  }, [flash]);

  const doClearContent = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    const next = clearSelectionContent(api.getSceneElements(), ids);
    if (next.changed) api.updateScene({ elements: next.elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }, []);

  // Miro's Duplicate: the copy lands BESIDE the original and is what stays selected
  // (finding 59), unlike Excalidraw's own +10/+10 offset on Ctrl+D.
  const doDuplicate = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    const made = duplicateElements(api.getSceneElements(), ids, () => (globalThis.crypto?.randomUUID?.() || `dup-${Math.random().toString(36).slice(2)}`));
    if (!made.ids.length) return;
    api.updateScene({ elements: made.elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    const selectedElementIds = {};
    for (const id of made.ids) {
      const el = made.elements.find((item) => item.id === id);
      if (el && !isStickyShadow(el) && !el.containerId) selectedElementIds[id] = true;
    }
    api.updateScene({ appState: { selectedElementIds }, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  }, []);

  // Delete the selection the way Excalidraw does: tombstoned, never omitted (updateScene
  // merges by id, the sticky-shadow lesson). The maintenance pass then reaps the sticky
  // bands and connector labels that lost their host.
  const doDelete = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const ids = selectedIdSet(api);
    if (!ids.size) return;
    api.updateScene({
      // A bound label and a poly's standalone labelFor label both die with their host: a
      // surviving labelFor pointing at a deleted element is exactly the violation
      // validateScene reports the next time the CLI reads this board.
      elements: api.getSceneElements().map((el) => (
        ids.has(el.id)
          || (el.containerId && ids.has(el.containerId))
          || (el.customData && ids.has(el.customData.labelFor))
          ? { ...el, isDeleted: true } : el
      )),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    api.updateScene({ appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  }, []);

  const doSelectAll = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const selectedElementIds = {};
    for (const id of selectableIds(api.getSceneElements())) selectedElementIds[id] = true;
    api.updateScene({ appState: { selectedElementIds }, captureUpdate: CaptureUpdateAction.EVENTUALLY });
  }, []);

  // The canvas menu's Add rows place AT the click, which is where a user pointed. The
  // text lands with a placeholder and opens its editor the same way a placed sticky does
  // (Excalidraw has no public start-editing API, so a real dblclick is dispatched once
  // the new element is hit-testable; riding pointerup rather than a timer, because an
  // occluded window throttles timers).
  const openEditorAt = useCallback((clientX, clientY) => {
    queueMicrotask(() => {
      const under = document.elementFromPoint(clientX, clientY);
      if (under && under.closest('.excalidraw')) {
        under.dispatchEvent(new MouseEvent('dblclick', { clientX, clientY, bubbles: true, cancelable: true, view: window }));
      }
    });
  }, []);

  const addTextAt = useCallback((clientX, clientY) => {
    const api = apiRef.current;
    if (!api) return;
    const scene = clientToScene(api.getAppState(), clientX, clientY);
    const created = insertSkeleton([{
      type: 'text', text: 'Text', fontSize: 20, x: Math.round(scene.x), y: Math.round(scene.y),
      strokeColor: api.getAppState().currentItemStrokeColor || '#1e1e1e',
    }], { scroll: false });
    if (created.length) openEditorAt(clientX, clientY);
  }, [insertSkeleton, openEditorAt]);

  // ---- The right-click menus (findings 62-64) ------------------------------------------
  // Right-clicking an unselected element selects it first (Miro's behaviour), so every row
  // acts on what the user pointed at rather than on a stale selection.
  const openContextMenu = useCallback((clientX, clientY) => {
    const api = apiRef.current;
    if (!api) return;
    const app = api.getAppState();
    const scene = clientToScene(app, clientX, clientY);
    const els = api.getSceneElements();
    // Topmost first, but FRAMES only when nothing else answered: a frame is a container
    // whose whole body is hit-testable, so taking it on the first pass would make every
    // shape inside an A4 frame unreachable by right-click.
    const hitAt = (el) => {
      if (el.isDeleted || isStickyShadow(el) || el.containerId) return false;
      if (el.type === 'arrow' || (el.type === 'line' && !isPolyShape(el))) {
        return Boolean(connectorAtScene([el], scene, 8 / (app.zoom?.value || 1)));
      }
      const box = isPolyShape(el)
        ? {
          x: el.x + Math.min(...el.points.map((p) => p[0])), y: el.y + Math.min(...el.points.map((p) => p[1])),
          w: Math.max(...el.points.map((p) => p[0])) - Math.min(...el.points.map((p) => p[0])),
          h: Math.max(...el.points.map((p) => p[1])) - Math.min(...el.points.map((p) => p[1])),
        }
        : { x: el.x, y: el.y, w: el.width, h: el.height };
      return scene.x >= box.x && scene.x <= box.x + box.w && scene.y >= box.y && scene.y <= box.y + box.h;
    };
    const isFrame = (el) => el.type === 'frame' || el.type === 'magicframe';
    let hit = null;
    for (let i = els.length - 1; i >= 0 && !hit; i -= 1) if (!isFrame(els[i]) && hitAt(els[i])) hit = els[i];
    for (let i = els.length - 1; i >= 0 && !hit; i -= 1) if (isFrame(els[i]) && hitAt(els[i])) hit = els[i];
    let ids = selectedIdSet(api);
    if (hit && !ids.has(hit.id)) {
      api.updateScene({ appState: { selectedElementIds: { [hit.id]: true } }, captureUpdate: CaptureUpdateAction.EVENTUALLY });
      ids = new Set([hit.id]);
    }
    if (!hit) ids = new Set();
    const kind = hit ? ((hit.type === 'arrow' || (hit.type === 'line' && !isPolyShape(hit))) ? 'connector' : 'element') : 'canvas';
    setCtxState({
      hasContent: ids.size ? selectionHasContent(els, ids) : false,
      locked: ids.size ? selectionLocked(els, ids) : false,
      anyLocked: hasLockedElements(els),
    });
    setCtxSub(null);
    setTbMenu(null);
    setCtxMenu({ kind, x: clientX, y: clientY });
  }, []);

  const runContextAction = useCallback((key) => {
    const menu = ctxMenu;
    setCtxMenu(null);
    setCtxSub(null);
    if (!menu) return;
    if (key === 'copyImage') { copySelectionPng(); return; }
    if (key === 'duplicate') { doDuplicate(); return; }
    if (key === 'remove') { doDelete(); return; }
    if (key === 'copyStyle') { doCopyStyle(); return; }
    if (key === 'pasteStyle') { doPasteStyle(); return; }
    if (key === 'clearContent') { doClearContent(); return; }
    if (key === 'lock' || key === 'unlock') { toggleLock(); return; }
    if (key === 'unlockAll') { doUnlockAll(); return; }
    if (key === 'selectAll') { doSelectAll(); return; }
    if (key === 'showAll') { zoomToFit(); return; }
    if (key === 'addText') { addTextAt(menu.x, menu.y); return; }
    if (key === 'addSticky') {
      const api = apiRef.current;
      if (!api) return;
      const scene = clientToScene(api.getAppState(), menu.x, menu.y);
      placeStickyAtScene(lastStickyColorRef.current, scene.x, scene.y);
      openEditorAt(menu.x, menu.y);
    }
  }, [ctxMenu, copySelectionPng, doDuplicate, doDelete, doCopyStyle, doPasteStyle, doClearContent,
    toggleLock, doUnlockAll, doSelectAll, zoomToFit, addTextAt, placeStickyAtScene, openEditorAt]);

  // Keyboard (catalog section 6). V/H/T/R/O/L/P/E/F are Excalidraw's own native tool
  // shortcuts and need no code here; this handler adds the Miro keys Excalidraw lacks:
  // N sticky, G grid, M minimap, Alt+1 fit, Alt+2 zoom-to-selection, and the PgUp
  // family for z-order. Capture phase because Excalidraw binds PgUp/PgDn to page-scroll
  // and would eat them first; every branch is guarded off typing targets so nothing
  // fires while the sticky label editor or the board name field has the caret.
  useEffect(() => {
    const onKey = (event) => {
      // Escape disarms sticky/shape placement (Miro exits the tool on Escape) and closes
      // the right-click menu, which otherwise sits over the board eating the next click
      // (the same trap the Wave C submenus paid for).
      if (event.key === 'Escape') {
        if (placingSticky) setPlacingSticky(null);
        if (placingShape) { setPlacingShape(null); setDrawRect(null); }
        setCtxMenu(null);
        setCtxSub(null);
        return;
      }
      if (isTypingTarget()) return;
      // The shortcuts the context menu advertises, so no hint in it is a lie. Ctrl+D is
      // intercepted on purpose: Excalidraw's own duplicate offsets +10/+10, while Miro
      // (and therefore this menu's hint) places the copy BESIDE the original.
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.shiftKey && event.code === 'KeyL') { event.preventDefault(); event.stopPropagation(); toggleLock(); return; }
        if (event.shiftKey && event.code === 'KeyC') { event.preventDefault(); event.stopPropagation(); copySelectionPng(); return; }
        if (!event.shiftKey && event.code === 'KeyD') { event.preventDefault(); event.stopPropagation(); doDuplicate(); return; }
        if (!event.shiftKey && event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); doClearContent(); return; }
      }
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        applyZOrder(event.key === 'PageUp' ? (event.shiftKey ? 'forward' : 'front') : (event.shiftKey ? 'backward' : 'back'));
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === '1' || event.key === '2')) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === '1') zoomToFit(); else zoomToSelection();
        return;
      }
      // Copy style / Paste style (Miro's Ctrl+Alt+C / Ctrl+Alt+V, findings 56 and 63).
      // Capture phase with stopPropagation so Excalidraw's own paste-styles action never
      // also runs and applies a second, different recipe on the same keystroke.
      if (event.altKey && (event.ctrlKey || event.metaKey) && (event.code === 'KeyC' || event.code === 'KeyV')) {
        event.preventDefault();
        event.stopPropagation();
        if (event.code === 'KeyC') doCopyStyle(); else doPasteStyle();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') { event.preventDefault(); armSticky(); }
      else if (key === 'g') { event.preventDefault(); toggleGrid(); }
      else if (key === 'm') { event.preventDefault(); setMinimapOn((on) => !on); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [armSticky, toggleGrid, applyZOrder, zoomToFit, zoomToSelection, placingSticky, placingShape,
    doCopyStyle, doPasteStyle, toggleLock, copySelectionPng, doDuplicate, doClearContent]);

  // Close the contextual toolbar's submenus on any pointer-down outside them (their own
  // trigger buttons re-toggle), or on Escape.
  useEffect(() => {
    if (!tbMenu) return undefined;
    const onDown = (event) => {
      const t = event.target;
      if (t instanceof Element && t.closest('.wb-tb-menu, .wb-tb-btn, .wb-color-pop')) return;
      setTbMenu(null);
    };
    const onKey = (event) => { if (event.key === 'Escape') setTbMenu(null); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [tbMenu]);

  // The card is centred on the selection, so placement needs its REAL width: measure it
  // whenever its contents change (a typography group appears, a table segment shows) and
  // whenever the window resizes.
  useEffect(() => {
    const node = barRef.current;
    if (!node) return undefined;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setBarSize((current) => (
        Math.abs(current.width - rect.width) < 0.5 && Math.abs(current.height - rect.height) < 0.5
          ? current
          : { width: rect.width, height: rect.height }
      ));
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (observer) observer.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [selCount, isConnector, hasText, tableId, stickySel, shapeKey]);

  // Close the zoom menu on any pointer-down outside the zoom cluster, or Escape.
  useEffect(() => {
    if (!zoomMenuOpen) return undefined;
    const onDown = (event) => {
      if (event.target?.closest?.('.wb-zoom')) return;
      setZoomMenuOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setZoomMenuOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [zoomMenuOpen]);

  // Close the rail flyouts on any pointer-down outside the rail. The sticky flyout is a
  // MODE (placingSticky), not a transient flyout: a canvas click places a sticky and keeps
  // it armed, so it is not closed here; it disarms on Escape or another tool.
  useEffect(() => {
    if (!templatesOpen && !shapesOpen && !tablesOpen && !framesOpen) return undefined;
    const onDown = (event) => {
      if (event.target?.closest?.('.wb-rail')) return;
      setTemplatesOpen(false);
      setShapesOpen(false);
      setTablesOpen(false);
      setFramesOpen(false);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      setTemplatesOpen(false);
      setShapesOpen(false);
      setTablesOpen(false);
      setFramesOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [templatesOpen, shapesOpen, tablesOpen, framesOpen]);

  // Close the connector-bar submenus (arrowhead pickers, Type) on any pointer-down
  // outside the bar, or on Escape. Escape matters more since Wave C: the card floats
  // over the canvas and its submenus open DOWNWARD onto it, so a submenu left open
  // covers the board and eats the next click meant for a shape (drive-caught).
  useEffect(() => {
    if (!connMenu) return undefined;
    const onDown = (event) => {
      if (event.target?.closest?.('.wb-connector-bar')) return;
      setConnMenu(null);
    };
    const onKey = (event) => { if (event.key === 'Escape') setConnMenu(null); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [connMenu]);

  // Right-drag pans the canvas, the way Miro does. A plain right-click (no drag)
  // still opens the context menu; only a drag past a small threshold suppresses
  // it. Panning writes scrollX/scrollY directly and never records an undo step.
  useEffect(() => {
    let panning = false;
    let moved = false;
    let suppressMenu = false;
    let startX = 0;
    let startY = 0;
    let baseX = 0;
    let baseY = 0;
    const onCanvas = (target) => (
      target instanceof Element
      && target.closest('.excalidraw')
      && !target.closest('.wb-rail, .wb-style-bar')
    );
    const onDown = (event) => {
      if (event.button !== 2 || !onCanvas(event.target)) return;
      const api = apiRef.current;
      if (!api) return;
      const app = api.getAppState();
      panning = true; moved = false;
      startX = event.clientX; startY = event.clientY;
      baseX = app.scrollX || 0; baseY = app.scrollY || 0;
    };
    const onMove = (event) => {
      if (!panning) return;
      const api = apiRef.current;
      if (!api) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && (dx * dx + dy * dy) > 9) moved = true;
      const zoom = api.getAppState().zoom?.value || 1;
      api.updateScene({ appState: { scrollX: baseX + dx / zoom, scrollY: baseY + dy / zoom }, captureUpdate: CaptureUpdateAction.NEVER });
      event.preventDefault();
      event.stopPropagation();
    };
    const onUp = () => {
      if (!panning) return;
      panning = false;
      if (moved) suppressMenu = true;
    };
    // A right-click that was not a pan opens HARBOR's menu (findings 62-64), never
    // Excalidraw's: the two lists are different and one of them is the one Pat is
    // matching. Excalidraw's own is suppressed by preventing the default here, in the
    // capture phase, before its listener ever sees the event.
    const onContext = (event) => {
      if (suppressMenu) {
        suppressMenu = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const t = event.target;
      if (!(t instanceof Element) || !t.closest('.excalidraw')) return;
      if (t.closest('.wb-rail, .wb-style-bar, .wb-tb-menu, .wb-ctx-menu, .wb-color-pop, .wb-zoom, .wb-minimap, .wb-label-input')) return;
      event.preventDefault();
      event.stopPropagation();
      openContextMenu(event.clientX, event.clientY);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('contextmenu', onContext, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('contextmenu', onContext, true);
    };
  }, [openContextMenu]);

  // The context menu closes on any pointer-down outside it (Escape is handled with the
  // other keys). Its own rows close it themselves through runContextAction.
  useEffect(() => {
    if (!ctxMenu) return undefined;
    const onDown = (event) => {
      if (event.button === 2) return; // a fresh right-click re-opens it at the new point
      if (event.target?.closest?.('.wb-ctx-menu')) return;
      setCtxMenu(null);
      setCtxSub(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [ctxMenu]);

  const getApi = useCallback(() => apiRef.current, []);
  const onConnectCreated = useCallback(() => {}, []);
  // The style bar target can be fill, line, or (when the selection has text) text. If the text
  // control is hidden but somehow still selected, fall back to fill so the swatches still apply.
  const effectiveStyleTarget = (styleTarget === 'text' && !hasText) ? 'fill' : styleTarget;
  const paletteActive = effectiveStyleTarget === 'text' ? active.text : (effectiveStyleTarget === 'line' ? active.stroke : active.fill);

  // A colour row: the quick-pick swatches, a "＋" custom-colour button (opens the wheel/hex
  // popover), and an eyedropper. Shared by the shape, connector, and pre-draw bars; `mode`
  // and `target` route where a pick lands, `activeHex` highlights the current colour.
  const colorRow = (mode, target, activeHex, colors = STYLE_COLORS) => (
    <div className="wb-swatches">
      {colors.map((color) => (
        <button
          key={color.key}
          type="button"
          className={`wb-swatch${color.hex === 'transparent' ? ' none' : ''}${activeHex === color.hex ? ' on' : ''}`}
          style={{ '--wb-swatch': color.hex === 'transparent' ? 'transparent' : color.hex }}
          title={color.label}
          aria-label={color.label}
          onClick={() => applyColorValue(mode, target, color.hex)}
        />
      ))}
      <button
        type="button"
        className={`wb-swatch wb-swatch-custom${colorPopover && colorPopover.mode === mode && colorPopover.target === target ? ' on' : ''}`}
        title="Custom colour"
        aria-label="Custom colour"
        onClick={(event) => openColorPopover(mode, target, event, activeHex)}
      >{CUSTOM_ICON}</button>
      <button
        type="button"
        className={`wb-eyedrop${sampling && sampling.mode === mode && sampling.target === target ? ' on' : ''}`}
        title="Eyedropper: sample a colour from the board"
        aria-label="Eyedropper"
        onClick={() => startSampling(mode, target)}
      >{EYEDROPPER_ICON}</button>
    </div>
  );

  // Opacity (transparency) slider, 0-100%, shared by the shape and connector style bars.
  const opacityControl = (value) => (
    <div className="wb-opacity" title="Opacity (transparency)">
      <input
        type="range"
        min="0"
        max="100"
        step="10"
        value={value ?? 100}
        aria-label="Opacity"
        onChange={(event) => applyOpacity(Number(event.target.value))}
      />
      <span className="wb-opacity-val">{value ?? 100}%</span>
    </div>
  );

  // The full Brand / All palette (finding 26): two labelled sections of round swatches
  // four to a row, an optional "No color" above them, and the custom-colour tail at the
  // very bottom. Shared by the border, fill and text-colour popovers.
  const palettePanel = (mode, target, activeHex, { noColor = null } = {}) => (
    <div className="wb-palette">
      {noColor ? (
        <button type="button" className="wb-tb-nocolor" aria-label={noColor.label} onClick={noColor.onPick}>
          {svg(<><circle cx="10" cy="10" r="6.5" /><path d="M5.4 14.6 14.6 5.4" /></>)}
          <span>{noColor.label}</span>
        </button>
      ) : null}
      {PALETTE_SECTIONS.map((section) => (
        <div className="wb-palette-section" key={section.key}>
          <div className="wb-palette-label">{section.label}</div>
          <div className="wb-palette-grid" role="group" aria-label={section.label}>
            {section.colors.map((color) => (
              <button
                key={color.key}
                type="button"
                className={`wb-dot-swatch${activeHex === color.hex ? ' on' : ''}`}
                style={{ '--wb-swatch': color.hex }}
                title={`${color.label} ${color.hex}`}
                aria-label={`${section.label}: ${color.label}`}
                onClick={() => applyColorValue(mode, target, color.hex)}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="wb-palette-tail">
        <button
          type="button"
          className="wb-swatch wb-swatch-custom"
          title="Add a custom colour"
          aria-label="Add a custom colour"
          onClick={(event) => openColorPopover(mode, target, event, activeHex)}
        >{CUSTOM_ICON}</button>
        <span>Add a custom color</span>
        <button
          type="button"
          className={`wb-eyedrop${sampling && sampling.mode === mode && sampling.target === target ? ' on' : ''}`}
          title="Eyedropper: sample a colour from the board"
          aria-label="Eyedropper"
          onClick={() => startSampling(mode, target)}
        >{EYEDROPPER_ICON}</button>
      </div>
    </div>
  );

  // One toolbar button: an icon (or icon + caption) that toggles its own submenu.
  const menuButton = (key, label, icon, { width = 240, caption = null, disabled = false } = {}) => (
    <button
      type="button"
      className={`wb-tb-btn${tbMenu && tbMenu.key === key ? ' open' : ''}`}
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={Boolean(tbMenu && tbMenu.key === key)}
      disabled={disabled}
      onClick={(event) => {
        const anchor = menuAnchor(event, width);
        setTbMenu((current) => (current && current.key === key ? null : { key, ...anchor }));
      }}
    >
      {icon}
      {caption ? <span className="wb-tb-caption">{caption}</span> : null}
    </button>
  );

  const currentFont = BOARD_FONTS.find((f) => FONT_FAMILY[f.family] === (textStyle && textStyle.fontFamily));
  const currentSize = stickySel ? (stickySel.font || null) : (textStyle && textStyle.fontSize);
  const placement = (selBox && canvasView) ? toolbarPlacement({
    box: selBox,
    size: barSize,
    viewport: canvasView,
    // The tool rail owns the left edge of the canvas at every window size (12px in,
    // ~50px wide), so the card starts clear of it.
    minLeft: canvasView.left + 70,
  }) : null;
  const showToolbar = selCount > 0 && !multiActive && Boolean(placement);
  // The right-click card is anchored by its top OR its bottom, so it never needs its own
  // measured height and never jumps on its first frame.
  const ctxPlace = ctxMenu ? contextMenuPlacement({
    x: ctxMenu.x, y: ctxMenu.y, viewport: { width: window.innerWidth, height: window.innerHeight },
  }) : null;
  const ctxRows = ctxMenu ? contextMenuModel({
    kind: ctxMenu.kind, hasCopiedStyle: Boolean(copiedStyle), ...ctxState,
  }) : [];

  const predrawFillTool = PREDRAW_FILL_TOOLS.has(tool) || Boolean(placingShape);
  const showPredraw = selCount === 0 && !multiActive && !editingText && (PREDRAW_STROKE_TOOLS.has(tool) || predrawFillTool);
  const predrawEffectiveTarget = predrawFillTool ? predrawTarget : 'line';
  const predrawActive = predrawEffectiveTarget === 'fill' ? predraw.fill : predraw.stroke;

  return (
    <>
      {/* Dot-grid layer (finding 72): sits UNDER the canvas, which dot mode holds
          transparent, so the dots read as the board background and never paint over
          elements. Pattern position/scale are written directly from handleChange. */}
      <div ref={dotLayerRef} className="wb-dot-layer" aria-hidden="true" style={{ display: dotActive ? 'block' : 'none' }} />
      <Excalidraw
        initialData={initialData}
        theme="light"
        onChange={handleChange}
        excalidrawAPI={(api) => {
          apiRef.current = api;
          const appState = api.getAppState();
          savedRef.current = { version: getSceneVersion(api.getSceneElements()), appSig: appStatePersistSignature(appState) };
          // Opening a board is not an edit: the first commit re-indexes any
          // CLI-authored elements (index null) and bumps their versions, and
          // its onChange can land BEFORE this baseline read (measured live:
          // it had already scheduled a flush against the {version: null}
          // baseline, which wrote every open of a CLI-authored board back to
          // disk and made the H1 merge read as dirty). Cancel anything the
          // pre-baseline onChange scheduled, and absorb one that lands after.
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
          absorbChangeUntilRef.current = Date.now() + 500;
          trace({ kind: 'baseline', v: savedRef.current.version });
          gridRef.current = Boolean(appState.gridModeEnabled);
          snapRef.current = Boolean(appState.objectsSnapModeEnabled);
          setGridOn(gridRef.current);
          setSnapOn(snapRef.current);
          zoomPctRef.current = Math.round((appState.zoom?.value || 1) * 100);
          setZoomPct(zoomPctRef.current);
          // A board saved with the grid on reopens in the user's chosen STYLE: the
          // dot preference re-derives the transparent-canvas + CSS-dot rendering
          // (the file itself always persists gridModeEnabled, see flush).
          if (gridRef.current && gridStyleRef.current === 'dot') {
            requestAnimationFrame(() => applyGridMode(true, 'dot'));
          }
          if (window.harbor?.e2e) window.__harborBoardApi = api;
        }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.CommandPalette />
          <MainMenu.Separator />
          <MainMenu.Item onSelect={copyPng} icon={CHROME_ICONS.templates}>Copy as PNG</MainMenu.Item>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Logo>Harbor Board</WelcomeScreen.Center.Logo>
            <WelcomeScreen.Center.Heading>
              Sketch, sticky, and diagram, offline. Pick a tool on the left, or press N for a sticky note.
            </WelcomeScreen.Center.Heading>
          </WelcomeScreen.Center>
        </WelcomeScreen>
      </Excalidraw>

      <div className="wb-rail" role="toolbar" aria-label="Board tools" aria-orientation="vertical">
        {TOOLS.map((entry) => {
          if (entry.key === 'sticky') {
            return (
              <div className="wb-rail-host" key="sticky">
                <button
                  type="button"
                  className={`wb-rail-btn accent${placingSticky ? ' on' : ''}`}
                  title="Sticky note  N  (click, then click the canvas to place)"
                  aria-label={entry.label}
                  aria-haspopup="menu"
                  aria-expanded={Boolean(placingSticky)}
                  aria-pressed={Boolean(placingSticky)}
                  onClick={() => armSticky()}
                >{TOOL_ICONS.sticky}</button>
                {placingSticky ? (
                  <div className="wb-rail-flyout wb-flyout-swatches" role="menu">
                    {STICKY_COLORS.map((color) => (
                      <button
                        key={color.key}
                        type="button"
                        className={`wb-sticky${placingSticky === color.key ? ' on' : ''}`}
                        style={{ '--wb-sticky': color.bg }}
                        title={`${color.label} sticky note`}
                        aria-label={`${color.label} sticky note`}
                        onClick={() => armSticky(color.key)}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          }
          if (entry.shapes) {
            const activeShapeDef = placingShape ? shapeDef(placingShape) : SHAPE_DEFS.find((s) => s.kind === 'native' && s.tool === tool);
            const isActive = Boolean(placingShape) || Boolean(activeShapeDef && activeShapeDef.kind === 'native' && tool === activeShapeDef.tool);
            return (
              <div className="wb-rail-host" key="shapes">
                <button
                  type="button"
                  className={`wb-rail-btn${isActive ? ' on' : ''}${shapesOpen ? ' open' : ''}`}
                  title="Shapes"
                  aria-label="Shapes"
                  aria-haspopup="menu"
                  aria-expanded={shapesOpen}
                  onClick={() => { setPlacingSticky(null); setPlacingShape(null); setDrawRect(null); setTemplatesOpen(false); setFramesOpen(false); setShapesOpen((open) => !open); }}
                >{shapeIcon(activeShapeDef || SHAPE_DEFS[0])}</button>
                {shapesOpen ? (
                  // Miro's shape panel is SECTIONED (finding 36), and at 34 glyphs a flat
                  // grid would be a wall. One labelled block per group, the panel itself
                  // scrolling, so the rail's own overflow stays visible (the 2026-08-26
                  // clipped-flyout trap: overflow-y on the RAIL clips these open-right panels).
                  <div className="wb-rail-flyout wb-flyout-shapes" role="menu" aria-label="Shapes">
                    {SHAPE_GROUPS.map((group) => (
                      <div className="wb-shape-group" key={group.key}>
                        <div className="wb-shape-group-label">{group.label}</div>
                        <div className="wb-shape-grid" role="group" aria-label={group.label}>
                          {SHAPE_DEFS.filter((def) => (def.group || 'basic') === group.key).map((def) => (
                            <button
                              key={def.key}
                              type="button"
                              className={`wb-rail-btn${placingShape === def.key ? ' on' : ''}`}
                              title={def.label}
                              aria-label={def.label}
                              onClick={() => pickShape(def)}
                            >{shapeIcon(def)}</button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          }
          if (entry.frames) {
            return (
              <div className="wb-rail-host" key="frame">
                <button
                  type="button"
                  className={`wb-rail-btn${tool === 'frame' ? ' on' : ''}${framesOpen ? ' open' : ''}`}
                  title="Frame  F"
                  aria-label="Frame"
                  aria-haspopup="menu"
                  aria-expanded={framesOpen}
                  onClick={() => { setPlacingSticky(null); setPlacingShape(null); setDrawRect(null); setShapesOpen(false); setTemplatesOpen(false); setTablesOpen(false); setFramesOpen((open) => !open); }}
                >{TOOL_ICONS.frame}</button>
                {framesOpen ? (
                  // Miro's Frame flyout (finding 40): Custom first (draw it yourself),
                  // then the paper and ratio presets, then the device sizes.
                  <div className="wb-rail-flyout wb-flyout-list" role="menu" aria-label="Frame presets">
                    {FRAME_PRESETS.map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        className="wb-template-item"
                        role="menuitem"
                        aria-label={`${preset.label} frame`}
                        onClick={() => addFrame(preset.key)}
                      >
                        <span>{preset.label}</span>
                        {preset.width ? <em>{preset.width} x {preset.height}</em> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          }
          return (
            <button
              key={entry.key}
              type="button"
              className={`wb-rail-btn${tool === entry.key ? ' on' : ''}`}
              title={entry.label}
              aria-label={entry.label}
              aria-pressed={tool === entry.key}
              onClick={() => pickTool(entry)}
            >{TOOL_ICONS[entry.key]}</button>
          );
        })}

        <div className="wb-rail-sep" />

        <div className="wb-rail-host">
          <button
            type="button"
            className={`wb-rail-btn${templatesOpen ? ' open' : ''}`}
            title="Templates"
            aria-label="Templates"
            aria-haspopup="menu"
            aria-expanded={templatesOpen}
            onClick={() => { setPlacingSticky(null); setShapesOpen(false); setFramesOpen(false); setTemplatesOpen((open) => !open); }}
          >{CHROME_ICONS.templates}</button>
          {templatesOpen ? (
            <div className="wb-rail-flyout wb-flyout-list" role="menu">
              {TEMPLATES.map((template) => (
                <button key={template.key} type="button" className="wb-template-item" role="menuitem" onClick={() => addTemplate(template.key)}>{template.label}</button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="wb-rail-host">
          <button
            type="button"
            className={`wb-rail-btn${tablesOpen ? ' open' : ''}`}
            title="Table"
            aria-label="Table"
            aria-haspopup="menu"
            aria-expanded={tablesOpen}
            onClick={() => { setPlacingSticky(null); setPlacingShape(null); setShapesOpen(false); setTemplatesOpen(false); setFramesOpen(false); setTablesOpen((open) => !open); }}
          >{CHROME_ICONS.table}</button>
          {tablesOpen ? (
            <div className="wb-rail-flyout wb-flyout-list" role="menu">
              {TABLE_SIZES.map((size) => (
                <button key={size.key} type="button" className="wb-template-item" role="menuitem" onClick={() => addTable(size.rows, size.cols)}>{size.label}</button>
              ))}
            </div>
          ) : null}
        </div>

        <button type="button" className={`wb-rail-btn${gridOn ? ' on' : ''}`} title="Grid and snap to grid  (G)" aria-label="Toggle grid and snap to grid" aria-pressed={gridOn} onClick={toggleGrid}>{CHROME_ICONS.grid}</button>
        <button type="button" className={`wb-rail-btn${snapOn ? ' on' : ''}`} title="Snap to objects (smart guides)" aria-label="Toggle snap to objects" aria-pressed={snapOn} onClick={toggleSnap}>{CHROME_ICONS.snap}</button>
        <button type="button" className="wb-rail-btn" title="Fit board to screen" aria-label="Fit board to screen" onClick={zoomToFit}>{CHROME_ICONS.zoomFit}</button>
      </div>

      {/* The contextual toolbar (Miro finding 76): ONE floating card above the
          selection, centred on it, replacing the old bottom style bar. Portalled to
          the body because the board's backdrop-filter would trap a fixed child, and
          because a card anchored to viewport coordinates has no business inside the
          scrolling canvas. Every deeper control opens DOWN from its own button. */}
      {showToolbar ? createPortal(
        <div
          ref={barRef}
          className={`wb-style-bar wb-float-bar${isConnector ? ' wb-connector-bar' : ''}`}
          role="toolbar"
          aria-label={isConnector ? 'Connector style' : 'Selection style'}
          data-place={placement.above ? 'above' : 'below'}
          style={{ left: `${placement.left}px`, top: `${placement.top}px` }}
        >
          {isConnector ? (
            <>
                <div className="wb-conn-host">
                  <button
                    type="button"
                    className={`wb-conn-pick${connMenu === 'start' ? ' open' : ''}`}
                    title="Start arrowhead"
                    aria-label="Start arrowhead"
                    aria-haspopup="menu"
                    aria-expanded={connMenu === 'start'}
                    onClick={() => setConnMenu((m) => (m === 'start' ? null : 'start'))}
                  ><HeadGlyph value={connStyle.start} mirror /></button>
                  {connMenu === 'start' ? (
                    <div className="wb-conn-menu wb-conn-heads" role="menu" aria-label="Start arrowhead options">
                      {ARROWHEADS.map((head) => (
                        <button key={head.key} type="button" className={`wb-conn-head-opt${(connStyle.start ?? null) === head.value ? ' on' : ''}`} role="menuitem" title={head.label} aria-label={head.label} onClick={() => applyHead('start', head.value)}>
                          <HeadGlyph value={head.value} mirror />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <button type="button" className="wb-conn-pick" title="Swap line ends" aria-label="Swap line ends" onClick={swapEnds}>
                  {svg(<><path d="M4 7h12M13 4l3 3-3 3" /><path d="M16 13H4M7 10l-3 3 3 3" /></>)}
                </button>
                <div className="wb-conn-host">
                  <button
                    type="button"
                    className={`wb-conn-pick${connMenu === 'end' ? ' open' : ''}`}
                    title="End arrowhead"
                    aria-label="End arrowhead"
                    aria-haspopup="menu"
                    aria-expanded={connMenu === 'end'}
                    onClick={() => setConnMenu((m) => (m === 'end' ? null : 'end'))}
                  ><HeadGlyph value={connStyle.end} /></button>
                  {connMenu === 'end' ? (
                    <div className="wb-conn-menu wb-conn-heads" role="menu" aria-label="End arrowhead options">
                      {ARROWHEADS.map((head) => (
                        <button key={head.key} type="button" className={`wb-conn-head-opt${(connStyle.end ?? null) === head.value ? ' on' : ''}`} role="menuitem" title={head.label} aria-label={head.label} onClick={() => applyHead('end', head.value)}>
                          <HeadGlyph value={head.value} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="wb-divider" />
                <div className="wb-conn-host">
                  <button
                    type="button"
                    className={`wb-conn-pick wb-conn-type-btn${connMenu === 'type' ? ' open' : ''}`}
                    title="Line type"
                    aria-label="Line type"
                    aria-haspopup="menu"
                    aria-expanded={connMenu === 'type'}
                    onClick={() => setConnMenu((m) => (m === 'type' ? null : 'type'))}
                  >{svg(<path d="M3 14c4-8 10 8 14-6" />)}<span>Type</span></button>
                  {connMenu === 'type' ? (
                    <div className="wb-conn-menu wb-conn-type" role="menu" aria-label="Line type options">
                      <div className="wb-conn-width" title="Line width">
                        <input
                          type="range"
                          min="1"
                          max="10"
                          step="1"
                          value={connStyle.width ?? 2}
                          aria-label="Line width"
                          onChange={(event) => applyWidth(Number(event.target.value))}
                        />
                        <span className="wb-conn-width-val">{connStyle.width ?? 2}px</span>
                      </div>
                      <div className="wb-seg wb-icon-seg" aria-label="Routing">
                        {CONNECTOR_ROUTINGS.map((r) => (
                          <button key={r.key} type="button" className={connStyle.routing === r.key ? 'on' : ''} title={r.label} aria-label={`${r.label} connector`} aria-pressed={connStyle.routing === r.key} onClick={() => applyRouting(r.key)}>{r.icon}</button>
                        ))}
                      </div>
                      <div className="wb-seg wb-icon-seg" aria-label="Line style">
                        {CONNECTOR_DASHES.map((d) => (
                          <button key={d.key} type="button" className={connStyle.dash === d.key ? 'on' : ''} title={d.label} aria-label={`${d.label} line`} aria-pressed={connStyle.dash === d.key} onClick={() => applyDash(d.key)}>
                            <svg viewBox="0 0 24 12" width="24" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="2" y1="6" x2="22" y2="6" strokeDasharray={d.dash || undefined} /></svg>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="wb-divider" />
                {colorRow('connector', 'line', connStyle.stroke, CONNECTOR_COLORS)}
                <div className="wb-divider" />
                {opacityControl(connStyle.opacity)}
            </>
          ) : (
            <>
              {shapeKey ? (
                <>
                  {menuButton('switch', 'Switch type', shapeIcon(shapeDef(shapeKey) || SHAPE_DEFS[0]), { width: 208 })}
                  <ToolbarMenu menu={tbMenu} name="switch" className="wb-tb-switch" label="Switch shape type">
                    <div className="wb-switch-grid">
                      {(switchAll ? SHAPE_DEFS : SWITCH_QUICK_DEFS()).map((def) => (
                        <button
                          key={def.key}
                          type="button"
                          className={`wb-tb-glyph${shapeKey === def.key ? ' on' : ''}`}
                          role="menuitem"
                          title={shapeName(def)}
                          aria-label={`Switch to ${shapeName(def)}`}
                          onClick={() => applySwitchType(def.key)}
                        >{shapeIcon(def)}</button>
                      ))}
                    </div>
                    <button type="button" className="wb-tb-row wb-tb-allshapes" role="menuitem" onClick={() => setSwitchAll((on) => !on)}>
                      <span>{switchAll ? 'Fewer shapes' : 'All shapes'}</span>
                    </button>
                  </ToolbarMenu>
                  <div className="wb-divider" />
                </>
              ) : null}

              {(hasText || stickySel) ? (
                <>
                  {hasText ? (
                    <>
                      {menuButton('font', 'Font', <span className="wb-tb-font">{currentFont ? currentFont.label : 'Font'}</span>, { width: 200 })}
                      <ToolbarMenu menu={tbMenu} name="font" className="wb-tb-list" label="Font family">
                        {BOARD_FONTS.map((font) => (
                          <button
                            key={font.key}
                            type="button"
                            className={`wb-tb-row${currentFont && currentFont.key === font.key ? ' on' : ''}`}
                            role="menuitem"
                            aria-label={font.label}
                            onClick={() => { applyTextProp('fontFamily', FONT_FAMILY[font.family]); setTbMenu(null); }}
                          ><span>{font.label}</span></button>
                        ))}
                      </ToolbarMenu>
                    </>
                  ) : null}
                  <div className="wb-stepper" title={stickySel ? 'Sticky text size (blank is Auto)' : 'Text size'}>
                    <button type="button" aria-label="Smaller text" onClick={() => applyFontSize((currentSize || 20) - 2)}>{TB_ICONS.minus}</button>
                    <input
                      type="number"
                      min={FONT_SIZE_MIN}
                      max={FONT_SIZE_MAX}
                      value={currentSize || ''}
                      placeholder={stickySel ? 'Auto' : ''}
                      aria-label="Text size"
                      onChange={(event) => {
                        const raw = Number(event.target.value);
                        if (stickySel && !(raw >= FONT_SIZE_MIN)) applyStickyFont(null);
                        else if (raw >= FONT_SIZE_MIN) applyFontSize(raw);
                      }}
                    />
                    <button type="button" aria-label="Bigger text" onClick={() => applyFontSize((currentSize || 20) + 2)}>{TB_ICONS.plus}</button>
                  </div>
                  {stickySel ? (
                    <button
                      type="button"
                      className={`wb-tb-btn wb-tb-auto${stickySel.font ? '' : ' on'}`}
                      title="Auto: the text shrinks to fit and the note never grows"
                      aria-label="Auto text size"
                      onClick={() => applyStickyFont(null)}
                    ><span className="wb-tb-caption">Auto</span></button>
                  ) : null}
                  {hasText ? (
                    <>
                      {menuButton('align', 'Text alignment', ALIGN_ICONS[(textStyle && textStyle.textAlign) || 'left'], { width: 160 })}
                      <ToolbarMenu menu={tbMenu} name="align" className="wb-tb-inline" label="Text alignment">
                        {TEXT_ALIGNS.map((entry) => (
                          <button
                            key={entry.key}
                            type="button"
                            className={`wb-tb-glyph${textStyle && textStyle.textAlign === entry.key ? ' on' : ''}`}
                            role="menuitem"
                            title={entry.label}
                            aria-label={entry.label}
                            onClick={() => { applyTextProp('textAlign', entry.key); setTbMenu(null); }}
                          >{ALIGN_ICONS[entry.key]}</button>
                        ))}
                      </ToolbarMenu>
                      {menuButton('textcolor', 'Text colour', TB_ICONS.textColor, { width: 250 })}
                      <ToolbarMenu menu={tbMenu} name="textcolor" className="wb-tb-pop" label="Text colour">
                        {palettePanel('selection', 'text', active.text)}
                      </ToolbarMenu>
                    </>
                  ) : null}
                  <div className="wb-divider" />
                </>
              ) : null}

              {menuButton('border', 'Border options', TB_ICONS.border, { width: 250 })}
              <ToolbarMenu menu={tbMenu} name="border" className="wb-tb-pop" label="Border options">
                <div className="wb-seg wb-icon-seg" aria-label="Border style">
                  {BORDER_STYLES.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      className={strokeStyle === entry.key ? 'on' : ''}
                      title={entry.label}
                      aria-label={`${entry.label} border`}
                      aria-pressed={strokeStyle === entry.key}
                      onClick={() => applyBorderStyle(entry.key)}
                    >{dashGlyph(entry.key)}</button>
                  ))}
                </div>
                <SliderRow label="Thickness" value={active.width ?? 2} min={1} max={10} suffix="px" onChange={applyWidth} />
                <SliderRow label="Opacity" value={active.opacity ?? 100} min={0} max={100} step={10} suffix="%" onChange={applyOpacity} />
                {radiusEditable ? (
                  <SliderRow label="Rounded corners" value={radius} min={0} max={60} onChange={applyCornerRadius}>
                    <input
                      className="wb-tb-num"
                      type="number"
                      min="0"
                      max="60"
                      value={radius}
                      aria-label="Corner radius"
                      onChange={(event) => applyCornerRadius(Math.max(0, Math.min(60, Number(event.target.value) || 0)))}
                    />
                  </SliderRow>
                ) : null}
                {palettePanel('selection', 'line', active.stroke, {
                  noColor: { label: 'No color', onPick: () => applyColorValue('selection', 'line', 'transparent') },
                })}
              </ToolbarMenu>

              {menuButton('fill', 'Fill colour', TB_ICONS.fill, { width: 250 })}
              <ToolbarMenu menu={tbMenu} name="fill" className="wb-tb-pop" label="Fill colour">
                <SliderRow label="Opacity" value={active.opacity ?? 100} min={0} max={100} step={10} suffix="%" onChange={applyOpacity} />
                {palettePanel('selection', 'fill', active.fill, {
                  noColor: { label: 'No color', onPick: () => applyColorValue('selection', 'fill', 'transparent') },
                })}
              </ToolbarMenu>

              {tableId ? (
                <>
                  <div className="wb-divider" />
                  <div className="wb-seg wb-table-seg" aria-label="Table">
                    <button type="button" title="Add column" aria-label="Add column" onClick={() => addTableCells(tableColumnSkeletons)}>+ Col</button>
                    <button type="button" title="Add row" aria-label="Add row" onClick={() => addTableCells(tableRowSkeletons)}>+ Row</button>
                    <button type="button" title="Remove column" aria-label="Remove column" onClick={() => mutateTable(tableRemoveColumn)}>&minus; Col</button>
                    <button type="button" title="Remove row" aria-label="Remove row" onClick={() => mutateTable(tableRemoveRow)}>&minus; Row</button>
                  </div>
                </>
              ) : null}

              {stickySel ? (
                <>
                  <div className="wb-divider" />
                  <div className="wb-seg wb-sticky-seg" aria-label="Sticky note size">
                    {STICKY_SIZES.map((size) => (
                      <button
                        key={size.key}
                        type="button"
                        className={stickySel.w === size.px && stickySel.h === size.px ? 'on' : ''}
                        title={`${size.label} sticky (${size.px}px)`}
                        aria-label={`${size.label} sticky note`}
                        onClick={() => applyStickySize(size.px)}
                      >{size.key}</button>
                    ))}
                  </div>
                </>
              ) : null}
            </>
          )}

          <div className="wb-divider" />
          {menuButton('arrange', 'Arrange', TB_ICONS.arrange, { width: 244 })}
          <ToolbarMenu menu={tbMenu} name="arrange" className="wb-tb-list" label="Arrange">
            {ARRANGE_OPS.map((op) => (
              <button
                key={op.key}
                type="button"
                className="wb-tb-row"
                role="menuitem"
                aria-label={op.label}
                onClick={() => { applyZOrder(op.key); setTbMenu(null); }}
              ><span>{op.label}</span><kbd>{op.hint}</kbd></button>
            ))}
          </ToolbarMenu>
          {menuButton('more', 'More', TB_ICONS.more, { width: 244 })}
          <ToolbarMenu menu={tbMenu} name="more" className="wb-tb-list" label="More actions">
            <button type="button" className="wb-tb-row" role="menuitem" aria-label="Copy style" onClick={doCopyStyle}>
              {TB_ICONS.copyStyle}<span>Copy style</span><kbd>Ctrl+Alt+C</kbd>
            </button>
            <button type="button" className="wb-tb-row" role="menuitem" aria-label="Paste style" disabled={!copiedStyle} onClick={doPasteStyle}>
              {TB_ICONS.pasteStyle}<span>Paste style</span><kbd>Ctrl+Alt+V</kbd>
            </button>
            {/* Wave D fills in the two deeper More rows Miro carries that Excalidraw can
                honestly execute (findings 56, 61). The rest of Miro's More menu (Copy link,
                Rename, Create frame, Save as template, Export to CSV) names things a Harbor
                board has no notion of, and stays absent rather than inert. */}
            <button type="button" className="wb-tb-row" role="menuitem" aria-label="Copy as image" onClick={() => { setTbMenu(null); copySelectionPng(); }}>
              {TB_ICONS.copyImage}<span>Copy as image</span><kbd>Ctrl+Shift+C</kbd>
            </button>
            <button type="button" className="wb-tb-row" role="menuitem" aria-label="Lock" onClick={() => { setTbMenu(null); toggleLock(); }}>
              {TB_ICONS.lock}<span>Lock</span><kbd>Ctrl+Shift+L</kbd>
            </button>
          </ToolbarMenu>
          {status ? <span className="wb-status" role="status">{status}</span> : null}
        </div>,
        document.body,
      ) : null}

      {showPredraw ? (
        <div className="wb-style-bar wb-predraw-bar" role="toolbar" aria-label="New item style">
          <span className="wb-predraw-label">{predrawFillTool ? 'New shape' : 'New'}</span>
          {predrawFillTool ? (
            <>
              <div className="wb-seg">
                <button type="button" className={predrawTarget === 'fill' ? 'on' : ''} onClick={() => setPredrawTarget('fill')}>Fill</button>
                <button type="button" className={predrawTarget === 'line' ? 'on' : ''} onClick={() => setPredrawTarget('line')}>Line</button>
              </div>
              <div className="wb-divider" />
            </>
          ) : null}
          {colorRow('predraw', predrawEffectiveTarget, predrawActive)}
        </div>
      ) : null}
      {/* Bottom-right zoom cluster (finding 70), Miro's layout: minimap docks above it. */}
      {minimapOn ? <Minimap getApi={getApi} /> : null}
      <div className="wb-zoom" role="toolbar" aria-label="Zoom">
        <button type="button" className="wb-zoom-btn" title="Zoom out" aria-label="Zoom out" onClick={() => stepZoom(1 / 1.2)}>
          {svg(<path d="M4 10h12" />)}
        </button>
        <button
          type="button"
          className="wb-zoom-pct"
          title="Zoom options"
          aria-label="Zoom options"
          aria-haspopup="menu"
          aria-expanded={zoomMenuOpen}
          onClick={() => setZoomMenuOpen((open) => !open)}
        >{zoomPct}%</button>
        <button type="button" className="wb-zoom-btn" title="Zoom in" aria-label="Zoom in" onClick={() => stepZoom(1.2)}>
          {svg(<path d="M4 10h12M10 4v12" />)}
        </button>
        {zoomMenuOpen ? (
          <div className="wb-zoom-menu" role="menu" aria-label="Zoom menu">
            <button type="button" className="wb-zoom-item" role="menuitem" onClick={() => { setZoomMenuOpen(false); zoomToFit(); }}>
              <span>Fit to screen</span><kbd>Alt+1</kbd>
            </button>
            <button type="button" className="wb-zoom-item" role="menuitem" onClick={() => { setZoomMenuOpen(false); zoomToSelection(); }}>
              <span>Zoom to selection</span><kbd>Alt+2</kbd>
            </button>
            {ZOOM_MENU_LEVELS.map((row) => (
              <button key={row.key} type="button" className="wb-zoom-item" role="menuitem" onClick={() => setZoomLevel(row.level)}>
                <span>{row.label}</span>{row.hint ? <kbd>{row.hint}</kbd> : null}
              </button>
            ))}
            <button type="button" className="wb-zoom-item" role="menuitemcheckbox" aria-checked={minimapOn} onClick={() => { setZoomMenuOpen(false); setMinimapOn((on) => !on); }}>
              <span>{minimapOn ? 'Hide minimap' : 'Show minimap'}</span><kbd>M</kbd>
            </button>
            <div className="wb-zoom-sep" />
            <div className="wb-zoom-row" aria-label="Scroll wheel behaviour">
              <span className="wb-zoom-row-label">Wheel</span>
              <div className="wb-seg">
                <button type="button" className={wheelMode === 'mouse' ? 'on' : ''} title="Mouse: the wheel zooms at the cursor" onClick={() => setWheelModePref('mouse')}>Mouse</button>
                <button type="button" className={wheelMode === 'trackpad' ? 'on' : ''} title="Trackpad: the wheel scrolls, pinch zooms" onClick={() => setWheelModePref('trackpad')}>Trackpad</button>
              </div>
            </div>
            <div className="wb-zoom-row" aria-label="Grid style">
              <span className="wb-zoom-row-label">Grid</span>
              <div className="wb-seg">
                <button type="button" className={gridStyle === 'line' ? 'on' : ''} title="Line grid (snaps shapes to it)" onClick={() => setGridStyle('line')}>Lines</button>
                <button type="button" className={gridStyle === 'dot' ? 'on' : ''} title="Dot grid, Miro-style" onClick={() => setGridStyle('dot')}>Dots</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {status && selCount === 0 ? <span className="wb-status wb-status-float" role="status">{status}</span> : null}
      {multiActive ? (
        <div className="wb-hint" role="status">Placing a line. Double-click or press Enter to finish, Esc to cancel.</div>
      ) : null}
      {placingShape ? (
        <div className="wb-hint" role="status">Drag on the canvas to draw the shape, or click to drop one. Esc to cancel.</div>
      ) : null}
      {drawRect ? createPortal(
        <div className="wb-draw-rect" style={{ left: `${drawRect.x}px`, top: `${drawRect.y}px`, width: `${drawRect.w}px`, height: `${drawRect.h}px` }} />,
        document.body,
      ) : null}
      {/* The right-click menus (catalog findings 62-64). Portalled to the body like every
          other board panel (a backdrop-filter ancestor traps a fixed child), opaque, and
          closed by Escape or any outside pointer-down so it can never eat the next click. */}
      {ctxMenu && ctxPlace ? createPortal(
        <div
          className="wb-ctx-menu"
          role="menu"
          data-kind={ctxMenu.kind}
          aria-label={ctxMenu.kind === 'canvas' ? 'Board menu' : (ctxMenu.kind === 'connector' ? 'Connector menu' : 'Element menu')}
          style={{
            left: `${ctxPlace.left}px`,
            width: `${CONTEXT_MENU_WIDTH}px`,
            maxHeight: `${ctxPlace.maxHeight}px`,
            ...(ctxPlace.top != null ? { top: `${ctxPlace.top}px` } : { bottom: `${ctxPlace.bottom}px` }),
          }}
        >
          {ctxRows.map((row) => {
            if (row.kind === 'sep') return <div className="wb-ctx-sep" key={row.key} />;
            if (row.kind === 'submenu') {
              return (
                <div className="wb-ctx-host" key={row.key}>
                  <button
                    type="button"
                    className={`wb-tb-row${ctxSub === row.submenu ? ' on' : ''}`}
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={ctxSub === row.submenu}
                    aria-label={row.label}
                    onClick={() => setCtxSub((current) => (current === row.submenu ? null : row.submenu))}
                  >{CTX_ICONS[row.key]}<span>{row.label}</span><kbd>&gt;</kbd></button>
                  {ctxSub === row.submenu ? (
                    <div className="wb-ctx-sub" role="menu" aria-label={`${row.label} options`}>
                      {row.submenu === 'arrange' ? ARRANGE_OPS.map((op) => (
                        <button
                          key={op.key}
                          type="button"
                          className="wb-tb-row"
                          role="menuitem"
                          aria-label={op.label}
                          onClick={() => { applyZOrder(op.key); setCtxMenu(null); setCtxSub(null); }}
                        ><span>{op.label}</span><kbd>{op.hint}</kbd></button>
                      )) : WHEEL_MODES.map((mode) => (
                        <button
                          key={mode.key}
                          type="button"
                          className={`wb-tb-row${wheelMode === mode.key ? ' on' : ''}`}
                          role="menuitemradio"
                          aria-checked={wheelMode === mode.key}
                          aria-label={mode.label}
                          onClick={() => { setWheelModePref(mode.key); setCtxMenu(null); setCtxSub(null); }}
                        ><span>{mode.label}</span></button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            }
            return (
              <button
                key={row.key}
                type="button"
                className="wb-tb-row"
                role="menuitem"
                aria-label={row.label}
                disabled={row.disabled}
                onClick={() => runContextAction(row.key)}
              >{CTX_ICONS[row.key]}<span>{row.label}</span>{row.hint ? <kbd>{row.hint}</kbd> : null}</button>
            );
          })}
        </div>,
        document.body,
      ) : null}
      <ColorPopover
        popover={colorPopover}
        recent={recentColors}
        onPick={(hex) => {
          const target = colorPopover;
          if (!target) return;
          applyColorValue(target.mode, target.target, hex);
          setColorPopover((current) => (current ? { ...current, value: normalizeHex(hex) || hex } : current));
        }}
        onEyedropper={() => { if (colorPopover) startSampling(colorPopover.mode, colorPopover.target); }}
        onClose={() => setColorPopover(null)}
      />
      <ConnectorLayer anchor={editingText || placingShape || placingSticky || sampling ? null : (hoverAnchor || connectAnchor)} getApi={getApi} onCreated={onConnectCreated} />
      {connEdit ? (
        <ConnectorEditLayer getApi={getApi} arrowId={connEdit.id} sig={connEdit.sig} editingText={editingText} />
      ) : null}
      {labelEdit ? createPortal(
        <input
          className="wb-label-input"
          style={{ left: `${labelEdit.x}px`, top: `${labelEdit.y}px` }}
          placeholder="Text"
          aria-label="Connector label"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); commitLabel(event.currentTarget.value); }
            else if (event.key === 'Escape') { event.preventDefault(); labelEditRef.current = null; setLabelEdit(null); }
            event.stopPropagation();
          }}
          onBlur={(event) => commitLabel(event.currentTarget.value)}
        />,
        document.body,
      ) : null}
    </>
  );
}

export default React.memo(WhiteboardCanvas);
