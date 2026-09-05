'use strict';

const crypto = require('node:crypto');
const {
  STICKY_COLORS, STICKY_SIZE, STICKY_SHADOW_BANDS, STICKY_SHADOW_COLOR,
  STICKY_SHADOW_DX, STICKY_SHADOW_DY, SHAPE_DEFS, TEMPLATES,
  TABLE_CELL_W, TABLE_CELL_H, routeConnector, anchorPoints,
} = require('../renderer/whiteboard/board-files.cjs');

const MAX_INT = 2 ** 31;
const BASE_KEYS = [
  'id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor',
  'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness',
  'opacity', 'groupIds', 'frameId', 'index', 'roundness', 'seed', 'version',
  'versionNonce', 'isDeleted', 'boundElements', 'updated', 'link', 'locked',
];

function defaultNewId() { return crypto.randomBytes(16).toString('base64url').slice(0, 21); }
function randomInt() { return Math.floor(Math.random() * MAX_INT); }
function context(ctx = {}) {
  return {
    newId: ctx.newId || defaultNewId,
    now: ctx.now === undefined ? Date.now : ctx.now,
    randomInt: ctx.randomInt || randomInt,
  };
}
function clock(ctx) { return typeof ctx.now === 'function' ? ctx.now() : ctx.now; }
function base(type, props = {}, supplied = {}) {
  const ctx = context(supplied);
  const element = {
    id: props.id || ctx.newId(), type,
    x: Number(props.x) || 0, y: Number(props.y) || 0,
    width: Number(props.width) || 0, height: Number(props.height) || 0,
    angle: Number(props.angle) || 0,
    strokeColor: props.strokeColor ?? '#1e1e1e',
    backgroundColor: props.backgroundColor ?? 'transparent',
    fillStyle: props.fillStyle || 'solid', strokeWidth: props.strokeWidth ?? 2,
    strokeStyle: props.strokeStyle || 'solid', roughness: 0,
    opacity: props.opacity ?? 100, groupIds: [], frameId: null, index: null,
    roundness: props.roundness ?? null, seed: ctx.randomInt(), version: 1,
    versionNonce: ctx.randomInt(), isDeleted: false,
    boundElements: Array.isArray(props.boundElements) ? props.boundElements : [],
    updated: clock(ctx), link: null, locked: props.locked === true,
  };
  if (props.customData !== undefined) element.customData = props.customData;
  return element;
}

function normalizePoints(points) {
  const input = Array.isArray(points) ? points : [];
  if (input.length < 2) return [[0, 0], [1, 1]];
  const ox = Number(input[0][0]) || 0; const oy = Number(input[0][1]) || 0;
  return input.map((p) => [(Number(p[0]) || 0) - ox, (Number(p[1]) || 0) - oy]);
}
function pointSize(points) {
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
function linear(type, props, ctx) {
  const original = Array.isArray(props.points) ? props.points : [[0, 0], [props.width || 100, props.height || 0]];
  const ox = Number(original[0]?.[0]) || 0; const oy = Number(original[0]?.[1]) || 0;
  const points = normalizePoints(original); const size = pointSize(points);
  return Object.assign(base(type, { ...props, x: (Number(props.x) || 0) + ox, y: (Number(props.y) || 0) + oy, ...size }, ctx), {
    points, lastCommittedPoint: null, startBinding: props.startBinding || null,
    endBinding: props.endBinding || null, startArrowhead: props.startArrowhead ?? null,
    endArrowhead: type === 'arrow' ? (props.endArrowhead ?? 'arrow') : (props.endArrowhead ?? null),
    ...(type === 'arrow' ? { elbowed: false } : {}),
  });
}

function estimateLineWidth(text, fontSize) {
  let em = 0;
  for (const ch of text) em += /[iljt.,' :!|]/.test(ch) ? 0.3 : /[mwMW@%&]/.test(ch) ? 0.82 : 0.55;
  return Number((em * fontSize).toFixed(4));
}
function getBoundTextMaxWidth(container, fontSize = 20) {
  if (container.type === 'ellipse') return Math.max(1, Math.round((container.width / 2) * Math.sqrt(2)) - 10);
  if (container.type === 'diamond') return Math.max(1, Math.round(container.width / 2) - 10);
  if (container.type === 'arrow') return Math.max(0.7 * container.width, fontSize * 11);
  return Math.max(1, container.width - 10);
}
function getBoundTextMaxHeight(container) {
  if (container.type === 'ellipse') return Math.max(1, Math.round((container.height / 2) * Math.sqrt(2)) - 10);
  if (container.type === 'diamond') return Math.max(1, Math.round(container.height / 2) - 10);
  return Math.max(1, container.height - 10);
}
function wrapText(value, maxWidth, fontSize) {
  const original = String(value ?? '').replace(/\s+/g, ' ').trim();
  const words = original ? original.split(' ') : [];
  const lines = [];
  for (const word of words) {
    if (estimateLineWidth(word, fontSize) > maxWidth) {
      let part = '';
      for (const ch of word) {
        if (part && estimateLineWidth(part + ch, fontSize) > maxWidth) { lines.push(part); part = ch; } else part += ch;
      }
      if (part) lines.push(part);
      continue;
    }
    const candidate = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
    if (lines.length && estimateLineWidth(candidate, fontSize) > maxWidth) lines.push(word);
    else if (lines.length) lines[lines.length - 1] = candidate;
    else lines.push(word);
  }
  return { original, wrapped: lines.join('\n') };
}
function boundPosition(container, text) {
  // An arrow label sits at the arrow's midpoint (Excalidraw's own placement),
  // not at the box-container offset formula, which parks it off the line.
  if (container.type === 'arrow' || container.type === 'line') {
    const pts = Array.isArray(container.points) && container.points.length ? container.points : [[0, 0]];
    const xs = pts.map((p) => Number(p[0]) || 0); const ys = pts.map((p) => Number(p[1]) || 0);
    return {
      x: container.x + (Math.min(...xs) + Math.max(...xs)) / 2 - text.width / 2,
      y: container.y + (Math.min(...ys) + Math.max(...ys)) / 2 - text.height / 2,
    };
  }
  let offsetX = 5; let offsetY = 5;
  if (container.type === 'ellipse') {
    offsetX += (container.width / 2) * (1 - Math.sqrt(2) / 2);
    offsetY += (container.height / 2) * (1 - Math.sqrt(2) / 2);
  } else if (container.type === 'diamond') {
    offsetX += container.width / 4; offsetY += container.height / 4;
  }
  const maxWidth = getBoundTextMaxWidth(container, text.fontSize);
  const maxHeight = getBoundTextMaxHeight(container);
  return { x: container.x + offsetX + maxWidth / 2 - text.width / 2, y: container.y + offsetY + maxHeight / 2 - text.height / 2 };
}
function textNote(props = {}, supplied = {}) {
  const fontSize = Number(props.fontSize) || 20; const lineHeight = 1.35;
  const maxWidth = props.container ? getBoundTextMaxWidth(props.container, fontSize) : (Number(props.maxWidth) || Infinity);
  const wrapped = wrapText(props.text, maxWidth, fontSize);
  if (!wrapped.original) return null;
  const lines = wrapped.wrapped.split('\n');
  const width = Math.min(maxWidth, Math.max(1, ...lines.map((line) => estimateLineWidth(line, fontSize))));
  const el = Object.assign(base('text', { ...props, width, height: fontSize * lineHeight * lines.length, strokeColor: props.strokeColor || '#1e1e1e' }, supplied), {
    text: wrapped.wrapped, fontSize, fontFamily: 6,
    textAlign: props.container ? 'center' : (props.textAlign || 'left'),
    verticalAlign: props.container ? 'middle' : (props.verticalAlign || 'top'),
    containerId: props.container ? props.container.id : (props.containerId || null),
    originalText: wrapped.original, autoResize: true, lineHeight,
  });
  if (props.container) Object.assign(el, boundPosition(props.container, el));
  return el;
}
function bindLabel(container, text, ctx, options = {}) {
  if (!String(text ?? '').trim()) return [];
  const label = textNote({ text, container, fontSize: options.fontSize || 20, strokeColor: options.strokeColor || '#212529' }, ctx);
  // APPEND to boundElements, never replace: a connected shape's boundElements
  // also carries its arrow mirrors, and wiping those strands every connector
  // (the setText-on-a-connected-shape path hits exactly that).
  container.boundElements = [
    ...(container.boundElements || []).filter((b) => b.type !== 'text'),
    { type: 'text', id: label.id },
  ];
  return [label];
}
// A poly shape is a closed `line` under the hood, and Excalidraw does not treat
// a line as a text container (binding onto one is undefined behavior; the app
// deliberately offers no text on poly shapes). Its label is therefore a
// STANDALONE centered text tagged customData.labelFor, which show/setText/move/
// rm all follow, and which never violates the container contract.
function polyLabel(poly, text, ctx, options = {}) {
  if (!String(text ?? '').trim()) return [];
  const label = textNote({
    text,
    fontSize: options.fontSize || 20,
    strokeColor: options.strokeColor || '#212529',
    maxWidth: Math.max(1, poly.width - 10),
    textAlign: 'center',
    customData: { labelFor: poly.id },
  }, ctx);
  label.x = poly.x + poly.width / 2 - label.width / 2;
  label.y = poly.y + poly.height / 2 - label.height / 2;
  return [label];
}
function shape(props = {}, supplied = {}) {
  const key = props.shape || props.kind || props.type || 'rectangle';
  const def = SHAPE_DEFS.find((item) => item.key === key);
  if (!def) return [];
  const width = Math.max(4, Number(props.width) || 180); const height = Math.max(4, Number(props.height) || 100);
  let el;
  if (def.kind === 'poly') {
    const raw = [...def.points, def.points[0]].map(([x, y]) => [Number((x * width).toFixed(2)), Number((y * height).toFixed(2))]);
    el = linear('line', { ...props, type: undefined, points: raw, backgroundColor: props.backgroundColor || '#a5d8ff', strokeColor: props.strokeColor || '#1e1e1e', customData: { polyShape: key } }, supplied);
    return [el, ...polyLabel(el, props.text, supplied, props)];
  }
  el = base(def.tool, { ...props, width, height, backgroundColor: props.backgroundColor || 'transparent', roundness: def.rounded ? { type: 3 } : props.roundness }, supplied);
  return [el, ...bindLabel(el, props.text, supplied, props)];
}
// A CLI sticky is the SAME two-element-family object the app writes: the coloured face
// plus the locked shadow BANDS behind it. Wave B replaced the single offset shadow with
// Miro's bottom-only falloff (two full-size bands straight down, STICKY_SHADOW_BANDS in
// board-files.cjs), and this factory was still writing the old +5/+7 square, so a
// CLI-authored sticky read visibly different from a placed one on the same board. The
// bands are the shared constants, and each carries its own dx/dy in customData exactly
// like the app's, which is what syncStickyShadows glues by.
function stickyNote(props = {}, supplied = {}) {
  const ctx = context(supplied); const faceId = ctx.newId();
  const shadowIds = STICKY_SHADOW_BANDS.map(() => ctx.newId());
  const labelId = ctx.newId();
  let labelUsed = false; const labelCtx = { ...ctx, newId: () => { labelUsed = true; return labelId; } };
  const color = STICKY_COLORS.find((c) => c.key === (props.color || 'yellow')) || STICKY_COLORS.find((c) => c.key === 'yellow');
  const x = Math.round(Number(props.x) || 0); const y = Math.round(Number(props.y) || 0);
  const shadows = STICKY_SHADOW_BANDS.map((band, i) => base('rectangle', {
    id: shadowIds[i], x: x + band.dx, y: y + band.dy, width: STICKY_SIZE, height: STICKY_SIZE,
    strokeColor: 'transparent', backgroundColor: STICKY_SHADOW_COLOR, strokeWidth: 1,
    opacity: band.opacity, locked: true,
    customData: { stickyShadow: true, faceId, dx: band.dx, dy: band.dy },
  }, ctx));
  const face = base('rectangle', { id: faceId, x, y, width: STICKY_SIZE, height: STICKY_SIZE, strokeColor: 'transparent', backgroundColor: color.bg, strokeWidth: 1 }, ctx);
  const labels = bindLabel(face, props.text, labelCtx, { fontSize: 20, strokeColor: color.text });
  return labelUsed ? [...shadows, face, ...labels] : [...shadows, face];
}

// The offsets a shadow element is glued by: its own recorded band, or the historical
// +5/+7 for a legacy shadow written before the bands existed. One rule, read by both the
// move path and validateScene, so a legacy board keeps validating as it always did.
function shadowOffsets(shadow) {
  const data = shadow.customData || {};
  return {
    dx: typeof data.dx === 'number' ? data.dx : STICKY_SHADOW_DX,
    dy: typeof data.dy === 'number' ? data.dy : STICKY_SHADOW_DY,
  };
}
// The four Miro-style connect anchors of a shape's bounding box: the midpoint
// of each side (the same points the app's connect dots mark). A connector picks
// the pair facing each other along the dominant axis between the two centers,
// so the line STOPS at the edges instead of running center to center through
// the shape bodies (Pat's mindmap-export report, b6 follow-up H5).
// anchorPoints lives in board-files.cjs (the one side-midpoint rule; requiring
// the other direction is a boot-crashing circular require) and is re-exported
// here for the CLI and its tests.
function connectorEndpoints(source, target) {
  const dx = (target.x + target.width / 2) - (source.x + source.width / 2);
  const dy = (target.y + target.height / 2) - (source.y + source.height / 2);
  const from = anchorPoints(source); const to = anchorPoints(target);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: from.right, to: to.left } : { from: from.left, to: to.right };
  }
  return dy >= 0 ? { from: from.bottom, to: to.top } : { from: from.top, to: to.bottom };
}
function connector(props = {}, supplied = {}) {
  const source = props.source || props.start || null; const target = props.target || props.end || null;
  // Anchors apply only when BOTH endpoints are shapes and the caller gave no
  // explicit coordinates (a template with authored points keeps them).
  const anchored = (source && target
    && props.x === undefined && props.y === undefined
    && props.endX === undefined && props.endY === undefined)
    ? connectorEndpoints(source, target) : null;
  const sx = props.x ?? (anchored ? anchored.from.x : (source ? source.x + source.width / 2 : 0));
  const sy = props.y ?? (anchored ? anchored.from.y : (source ? source.y + source.height / 2 : 0));
  const ex = props.endX ?? (anchored ? anchored.to.x : (target ? target.x + target.width / 2 : sx + 100));
  const ey = props.endY ?? (anchored ? anchored.to.y : (target ? target.y + target.height / 2 : sy));
  let arrow = linear('arrow', { ...props, x: sx, y: sy, points: [[0, 0], [ex - sx, ey - sy]], startBinding: source ? { elementId: source.id, focus: 0, gap: 6 } : null, endBinding: target ? { elementId: target.id, focus: 0, gap: 6 } : null, strokeColor: props.strokeColor || '#868e96' }, supplied);
  arrow = routeConnector(arrow, props.routing || 'straight');
  if (source) source.boundElements = [...(source.boundElements || []).filter((b) => b.id !== arrow.id), { id: arrow.id, type: 'arrow' }];
  if (target) target.boundElements = [...(target.boundElements || []).filter((b) => b.id !== arrow.id), { id: arrow.id, type: 'arrow' }];
  return arrow;
}
// Intrinsic pixel dimensions from the image header bytes: PNG IHDR, JPEG SOF
// markers (walking past APPn/quantization segments; C4/C8/CC are not frames),
// and the trivial GIF logical screen. Anything else answers null honestly, no
// dependency, no decode.
function imageDimensions(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a
    && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  const gifMagic = bytes.length >= 10 ? bytes.toString('ascii', 0, 6) : '';
  if (gifMagic === 'GIF87a' || gifMagic === 'GIF89a') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null; // lost sync: refuse rather than guess
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset += 1; continue; } // fill byte
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; } // standalone markers
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) return null;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        if (offset + 9 > bytes.length) return null;
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}
function image(props = {}, supplied = {}) {
  const bytes = Buffer.isBuffer(props.bytes) ? props.bytes : Buffer.from(props.bytes || '', props.encoding || 'base64');
  const fileId = props.fileId || crypto.createHash('sha1').update(bytes).digest('hex'); const ctx = context(supplied); const stamp = clock(ctx);
  const mimeType = props.mimeType || 'image/png';
  // Placed size defaults to the image's INTRINSIC dimensions (a 2560x1400
  // screenshot must not render squashed into 320x200); a lone width or height
  // scales the other proportionally; explicit both wins; unparsable bytes keep
  // the legacy 320x200 fallback.
  const intrinsic = imageDimensions(bytes);
  let width = Number(props.width) || 0; let height = Number(props.height) || 0;
  if (!width && !height) {
    width = intrinsic ? intrinsic.width : 320;
    height = intrinsic ? intrinsic.height : 200;
  } else if (!height) {
    height = intrinsic && intrinsic.width ? Math.round(width * (intrinsic.height / intrinsic.width)) : 200;
  } else if (!width) {
    width = intrinsic && intrinsic.height ? Math.round(height * (intrinsic.width / intrinsic.height)) : 320;
  }
  const element = Object.assign(base('image', { ...props, width: Math.max(1, width), height: Math.max(1, height), strokeColor: 'transparent', backgroundColor: '#ffffff' }, ctx), { status: 'pending', fileId, scale: [1, 1], crop: null });
  return { element, file: { mimeType, id: fileId, dataURL: props.dataURL || `data:${mimeType};base64,${bytes.toString('base64')}`, created: stamp, lastRetrieved: stamp } };
}
function table(props = {}, supplied = {}) {
  const ctx = context(supplied); const tableId = props.tableId || ctx.newId(); const rows = Math.max(1, Math.trunc(props.rows || 2)); const cols = Math.max(1, Math.trunc(props.cols || 2));
  const w = Number(props.cellWidth) || TABLE_CELL_W; const h = Number(props.cellHeight) || TABLE_CELL_H; const out = [];
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) out.push(base('rectangle', { x: (Number(props.x) || 0) + c * w, y: (Number(props.y) || 0) + r * h, width: w, height: h, backgroundColor: r === 0 ? '#f1f3f5' : '#ffffff', strokeColor: '#ced4da', strokeWidth: 1, customData: { table: { id: tableId, r, c } } }, ctx));
  return out;
}
function template(name, props = {}, supplied = {}) {
  const key = name === 'flowchart' ? 'flow' : name; const spec = TEMPLATES.find((item) => item.key === key); if (!spec) return [];
  const skeletons = spec.build(Number(props.x) || 0, Number(props.y) || 0); const ctx = context(supplied); const local = new Map(); const output = [];
  for (const sk of skeletons) if (sk.id) local.set(sk.id, ctx.newId());
  for (const sk of skeletons) {
    if (sk.type === 'arrow') continue;
    if (sk.type === 'text') {
      const label = textNote(sk, ctx);
      if (label) output.push(label);
      continue;
    }
    const [el, ...labels] = shape({ ...sk, shape: sk.type, id: sk.id ? local.get(sk.id) : undefined, text: sk.label?.text, strokeColor: sk.strokeColor, backgroundColor: sk.backgroundColor }, ctx);
    output.push(el, ...labels);
  }
  for (const sk of skeletons.filter((item) => item.type === 'arrow')) {
    const source = output.find((el) => el.id === local.get(sk.start?.id)); const target = output.find((el) => el.id === local.get(sk.end?.id));
    const hasPts = Array.isArray(sk.points) && sk.points.length >= 2;
    const connProps = hasPts
      ? { ...sk, source, target, x: sk.x, y: sk.y, endX: sk.x + sk.points.at(-1)[0], endY: sk.y + sk.points.at(-1)[1] }
      : { ...sk, source, target, x: undefined, y: undefined, endX: undefined, endY: undefined };
    output.push(connector(connProps, ctx));
  }
  return output;
}

// Perceptive luminance of a #rgb/#rrggbb value in [0,1]; null for anything else
// (transparent, named colors), which honestly means "no contrast verdict".
function hexLuminance(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16); const g = parseInt(hex.slice(2, 4), 16); const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function cloneScene(scene) { return { ...(scene || {}), elements: (scene?.elements || []).map((e) => ({ ...e, boundElements: Array.isArray(e.boundElements) ? e.boundElements.map((b) => ({ ...b })) : e.boundElements })), files: { ...(scene?.files || {}) } }; }
function bump(el, ctx) { return { ...el, version: (Number(el.version) || 0) + 1, versionNonce: ctx.randomInt(), updated: clock(ctx) }; }
function applyOp(input, op, supplied = {}) {
  const scene = cloneScene(input); const ctx = context(supplied); const type = String(op?.type || ''); let added = [];
  if (type === 'board.addSticky') added = stickyNote(op, ctx);
  else if (type === 'board.addShape') added = shape(op, ctx);
  else if (type === 'board.addText') {
    const el = textNote(op, ctx);
    if (el) {
      added = [el];
      // A label created WITH a container (connect --label) must mirror
      // { type: 'text', id } into that container's boundElements, on the SCENE
      // copy of the container (the op's object is from a pre-clone scene). A
      // one-sided binding is exactly the violation validateScene reports.
      const hostId = op.container?.id || op.containerId;
      if (hostId) {
        const index = scene.elements.findIndex((e) => e.id === hostId && !e.isDeleted);
        if (index === -1) return scene;
        const host = scene.elements[index];
        // One bound label per container, and a `line` is never a container.
        if (host.type === 'line' || (host.boundElements || []).some((b) => b.type === 'text')) return scene;
        scene.elements[index] = bump({ ...host, boundElements: [...(host.boundElements || []), { type: 'text', id: el.id }] }, ctx);
      }
    }
  }
  else if (type === 'board.addImage') { const made = image(op, ctx); added = [made.element]; scene.files[made.element.fileId] = made.file; }
  else if (type === 'board.addTemplate') added = template(op.template || op.name, op, ctx);
  else if (type === 'board.addTable') added = table(op, ctx);
  else if (type === 'board.connect') {
    const source = scene.elements.find((e) => e.id === (op.sourceId || op.startId) && !e.isDeleted); const target = scene.elements.find((e) => e.id === (op.targetId || op.endId) && !e.isDeleted);
    if (source && target) added = [connector({ ...op, source, target }, ctx)];
  } else if (['board.moveElement', 'board.setText', 'board.setColor'].includes(type)) {
    const el = scene.elements.find((e) => e.id === op.elementId && !e.isDeleted); if (!el) return scene;
    if (type === 'board.moveElement') {
      el.x = Number(op.x) || 0; el.y = Number(op.y) || 0;
      // H2: keep a bound label centered in its moved container (headless has no
      // restore to recompute it); a poly's standalone labelFor label follows too.
      for (const child of scene.elements) {
        if (child.type !== 'text' || child.isDeleted) continue;
        if (child.containerId === el.id) Object.assign(child, boundPosition(el, child));
        else if (child.customData?.labelFor === el.id) { child.x = el.x + el.width / 2 - child.width / 2; child.y = el.y + el.height / 2 - child.height / 2; } else continue;
        const ci = scene.elements.findIndex((e) => e.id === child.id); scene.elements[ci] = bump(child, ctx);
      }
    }
    if (type === 'board.setColor') {
      if (op.backgroundColor !== undefined || op.color !== undefined) el.backgroundColor = op.backgroundColor ?? op.color;
      if (op.strokeColor !== undefined) el.strokeColor = op.strokeColor;
      // L3: a label must stay readable over its new fill. A dark fill flips the
      // bound (or labelFor) text to white, a light fill back to the house dark;
      // a non-hex fill (transparent, named) leaves the label alone.
      const luminance = hexLuminance(el.backgroundColor);
      if ((op.backgroundColor !== undefined || op.color !== undefined) && luminance !== null) {
        const labelIndex = scene.elements.findIndex((e) => e.type === 'text' && !e.isDeleted && (e.containerId === el.id || e.customData?.labelFor === el.id));
        if (labelIndex !== -1) scene.elements[labelIndex] = bump({ ...scene.elements[labelIndex], strokeColor: luminance < 0.5 ? '#ffffff' : '#1a1a1a' }, ctx);
      }
    }
    if (type === 'board.setText') {
      const wantsText = String(op.text ?? '').trim();
      const target = el.type === 'text' ? el : scene.elements.find((e) => e.type === 'text' && !e.isDeleted && (e.containerId === el.id || e.customData?.labelFor === el.id));
      if (!target) {
        // The element has no label yet (e.g. a compose sticky created empty):
        // create one now (H3), standalone for a poly line, else no-op honestly.
        if (el.type === 'text' || !wantsText) return scene;
        const labels = el.type === 'line'
          ? polyLabel(el, op.text, ctx, { fontSize: 20, strokeColor: '#212529' })
          : bindLabel(el, op.text, ctx, { fontSize: 20, strokeColor: '#212529' });
        const idx = scene.elements.findIndex((e) => e.id === el.id); scene.elements[idx] = bump(el, ctx);
        if (labels.length) scene.elements.push(...labels);
        return scene;
      }
      if (!wantsText) return scene;
      const rebuilt = textNote({
        ...target,
        text: op.text,
        maxWidth: target.customData?.labelFor ? Math.max(1, el.width - 10) : undefined,
        container: target.containerId ? scene.elements.find((e) => e.id === target.containerId) : null,
      }, { ...ctx, newId: () => target.id });
      Object.assign(target, rebuilt);
      if (target.customData?.labelFor === el.id) { target.x = el.x + el.width / 2 - target.width / 2; target.y = el.y + el.height / 2 - target.height / 2; }
      const targetIndex = scene.elements.findIndex((e) => e.id === target.id); scene.elements[targetIndex] = bump(target, ctx);
    }
    if (type !== 'board.setText' || el.type !== 'text') { const index = scene.elements.findIndex((e) => e.id === el.id); scene.elements[index] = bump(el, ctx); }
    // Every band of the sticky's shadow follows the face, each by its OWN offsets.
    for (const shadow of scene.elements) {
      if (shadow.isDeleted || !shadow.customData?.stickyShadow || shadow.customData.faceId !== el.id) continue;
      const { dx, dy } = shadowOffsets(shadow);
      shadow.x = el.x + dx; shadow.y = el.y + dy;
      shadow.width = el.width; shadow.height = el.height; shadow.angle = el.angle;
    }
  } else if (type === 'board.removeElement') {
    const target = scene.elements.find((e) => e.id === op.elementId && !e.isDeleted); if (!target) return scene;
    // Cascade for EVERY family, not just the rectangle sticky: shadows, bound
    // labels, and poly labelFor labels all die with their host.
    const doomed = new Set([target.id]);
    for (const e of scene.elements) {
      if (e.isDeleted) continue;
      if (e.customData?.stickyShadow && e.customData.faceId === target.id) doomed.add(e.id);
      if (e.type === 'text' && (e.containerId === target.id || e.customData?.labelFor === target.id)) doomed.add(e.id);
    }
    // M2: nothing may keep pointing at the dead. Survivors drop boundElements
    // entries naming a doomed id, and an arrow whose endpoint died loses that
    // binding side; each touched survivor is version-bumped.
    scene.elements = scene.elements.map((e) => {
      if (doomed.has(e.id)) return bump({ ...e, isDeleted: true }, ctx);
      if (e.isDeleted) return e;
      let next = e; let touched = false;
      if (Array.isArray(e.boundElements) && e.boundElements.some((b) => doomed.has(b.id))) {
        next = { ...next, boundElements: e.boundElements.filter((b) => !doomed.has(b.id)) }; touched = true;
      }
      if (next.type === 'arrow' || next.type === 'line') {
        for (const side of ['startBinding', 'endBinding']) {
          if (next[side] && doomed.has(next[side].elementId)) { next = { ...next, [side]: null }; touched = true; }
        }
      }
      return touched ? bump(next, ctx) : e;
    });
    // L2: bytes whose last placed image just died leave the file with it, so a
    // board does not accumulate dead megabytes every read and save then pays.
    // Scoped to THIS op's doomed images only: a pre-existing orphan file (bytes
    // with no placed element) stays, because sceneImages deliberately surfaces
    // those as content Pat may still want seen.
    const doomedFileIds = new Set(scene.elements.filter((e) => e.type === 'image' && doomed.has(e.id) && e.fileId).map((e) => e.fileId));
    const liveFileIds = new Set(scene.elements.filter((e) => e.type === 'image' && !e.isDeleted && e.fileId).map((e) => e.fileId));
    for (const fileId of doomedFileIds) if (!liveFileIds.has(fileId)) delete scene.files[fileId];
  }
  if (added.length) scene.elements.push(...added);
  return scene;
}

function validateScene(scene) {
  const errors = []; const elements = Array.isArray(scene?.elements) ? scene.elements : []; const byId = new Map();
  const bad = (id, message) => errors.push(`${id}: ${message}`);
  for (const el of elements) { if (byId.has(el.id)) bad(el.id, 'duplicate id'); else byId.set(el.id, el); }
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i]; if (!el || el.isDeleted) continue;
    if (el.width === 0 && el.height === 0 && !['line', 'arrow'].includes(el.type)) bad(el.id, 'invisibly small');
    if (['line', 'arrow'].includes(el.type) && (!Array.isArray(el.points) || el.points.length < 2)) bad(el.id, 'linear element needs two points');
    if (el.type === 'text' && el.text === '') bad(el.id, 'empty text');
    // A shadow is glued by its OWN band offsets; a legacy shadow (no dx/dy, written
    // before the bands) still validates at the historical +5/+7, so boards written by
    // either era pass unchanged.
    if (el.customData?.stickyShadow) { const face = byId.get(el.customData.faceId); if (!face || face.isDeleted) bad(el.id, 'missing live sticky face'); else { const off = shadowOffsets(el); if (!el.locked) bad(el.id, 'sticky shadow is not locked'); if (elements.indexOf(face) < i) bad(el.id, 'sticky shadow must precede face'); if (Math.round(el.x) !== Math.round(face.x + off.dx) || Math.round(el.y) !== Math.round(face.y + off.dy) || el.width !== face.width || el.height !== face.height || el.angle !== face.angle) bad(el.id, 'sticky shadow geometry differs'); } }
    if (el.type === 'text' && el.containerId) {
      const container = byId.get(el.containerId);
      if (!container || container.isDeleted || !(container.boundElements || []).some((b) => b.type === 'text' && b.id === el.id)) bad(el.id, 'container binding is not mirrored');
      // Excalidraw binds text to containers and arrows, never to a `line`; a
      // poly shape's label must be a standalone labelFor text instead.
      if (container && !container.isDeleted && container.type === 'line') bad(el.id, 'text is bound to a line container');
    }
    if (el.type === 'text' && el.customData?.labelFor) { const host = byId.get(el.customData.labelFor); if (!host || host.isDeleted) bad(el.id, 'labelFor names a missing element'); }
    const textBindings = (el.boundElements || []).filter((b) => b.type === 'text'); if (textBindings.length > 1) bad(el.id, 'multiple bound texts');
    for (const binding of el.boundElements || []) { const other = byId.get(binding.id); if (!other || other.isDeleted) bad(el.id, `bound element ${binding.id} is missing`); else if (binding.type === 'text' && other.containerId !== el.id) bad(el.id, 'text binding is not mirrored'); else if (binding.type === 'arrow' && ![other.startBinding?.elementId, other.endBinding?.elementId].includes(el.id)) bad(el.id, 'arrow binding is not mirrored'); }
    if (el.type === 'arrow') for (const side of ['startBinding', 'endBinding']) if (el[side]) { const endpoint = byId.get(el[side].elementId); if (!endpoint || endpoint.isDeleted || !(endpoint.boundElements || []).some((b) => b.type === 'arrow' && b.id === el.id)) bad(el.id, `${side} is not mirrored`); }
  }
  const tables = new Map(); for (const el of elements.filter((e) => !e.isDeleted && e.customData?.table)) { const t = el.customData.table; if (!tables.has(t.id)) tables.set(t.id, []); tables.get(t.id).push(t); }
  for (const cells of tables.values()) { const rows = Math.max(...cells.map((c) => c.r)) + 1; const cols = Math.max(...cells.map((c) => c.c)) + 1; for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) if (!cells.some((cell) => cell.r === r && cell.c === c)) bad(elements.find((e) => e.customData?.table?.id === cells[0].id)?.id || cells[0].id, `table gap at ${r},${c}`); }
  return errors;
}

module.exports = { BASE_KEYS, anchorPoints, applyOp, connector, connectorEndpoints, defaultNewId, getBoundTextMaxHeight, getBoundTextMaxWidth, hexLuminance, image, imageDimensions, shadowOffsets, shape, stickyNote, table, template, textNote, validateScene };
