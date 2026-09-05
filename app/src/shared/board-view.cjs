'use strict';

// Read side of the Board, flattened for an agent (bin/harbor-board show).
//
// An Excalidraw scene is a flat element list with implicit relationships:
// bound text carries a `containerId`, a Miro sticky is a locked shadow rect
// (customData.stickyShadow, plus faceId pointing at its coloured face) behind a
// face rect behind a bound text, an image element references bytes held in
// scene.files by fileId, and a connector is an arrow with start/end bindings.
// An agent should not have to know any of that to answer "what did Pat write on
// this board and what screenshots did he leave". flattenScene turns the scene
// into {stickies, texts, images, shapes, connectors}.
//
// The load-bearing guarantee: EVERY non-deleted text and EVERY image is
// surfaced (in `texts` and `images`), regardless of whether sticky detection
// recognises its container. Losing an annotation Pat left for review is the one
// failure this whole feature exists to prevent, so detection is additive polish
// over a complete raw listing, never a filter in front of it.

function live(elements) {
  return (Array.isArray(elements) ? elements : []).filter((el) => el && !el.isDeleted);
}

function isStickyShadow(el) {
  return Boolean(el && el.customData && el.customData.stickyShadow);
}

function textOf(el) {
  // originalText is the text as typed; `text` carries the WRAP (hard newlines
  // Excalidraw or the sticky autosize inserted to fit the box), which is a layout
  // artifact a reader should never mistake for the author's line breaks.
  if (typeof el.originalText === 'string') return el.originalText;
  if (typeof el.text === 'string') return el.text;
  return '';
}

function box(el) {
  return {
    x: Math.round(el.x || 0),
    y: Math.round(el.y || 0),
    w: Math.round(el.width || 0),
    h: Math.round(el.height || 0),
  };
}

function flattenScene(scene) {
  const elements = live(scene && scene.elements);
  const files = (scene && scene.files && typeof scene.files === 'object') ? scene.files : {};

  // containerId -> its bound text (first wins), so a shape or sticky can report
  // the label typed into it. A poly shape's label is a STANDALONE text tagged
  // customData.labelFor (a line is not an Excalidraw container), so that key
  // pairs it the same way.
  const textByContainer = new Map();
  for (const el of elements) {
    if (el.type !== 'text') continue;
    const key = el.containerId || (el.customData && el.customData.labelFor) || null;
    if (key && !textByContainer.has(key)) textByContainer.set(key, el);
  }

  // A face is any element some shadow names via customData.faceId. That is the
  // reliable sticky signal (the shadow is minted with faceId at insert); it does
  // not depend on colour or stroke, which vary.
  const faceIds = new Set();
  for (const el of elements) {
    if (isStickyShadow(el) && el.customData && el.customData.faceId) faceIds.add(el.customData.faceId);
  }

  const stickies = [];
  const texts = [];
  const images = [];
  const shapes = [];
  const connectors = [];

  for (const el of elements) {
    if (isStickyShadow(el)) continue; // presentation only, never content

    if (el.type === 'text') {
      texts.push({
        id: el.id,
        text: textOf(el),
        boundTo: el.containerId || null,
        ...box(el),
      });
      continue;
    }

    if (el.type === 'image') {
      const file = el.fileId && files[el.fileId] ? files[el.fileId] : null;
      images.push({
        id: el.id,
        fileId: el.fileId || null,
        mimeType: file ? (file.mimeType || null) : null,
        hasBytes: Boolean(file && typeof file.dataURL === 'string' && file.dataURL.length > 0),
        ...box(el),
      });
      continue;
    }

    if (el.type === 'arrow' || (el.type === 'line' && (el.startBinding || el.endBinding))) {
      connectors.push({
        id: el.id,
        type: el.type,
        startBoundTo: el.startBinding ? el.startBinding.elementId : null,
        endBoundTo: el.endBinding ? el.endBinding.elementId : null,
        label: textByContainer.has(el.id) ? textOf(textByContainer.get(el.id)) : null,
        points: Array.isArray(el.points) ? el.points.length : 0,
      });
      continue;
    }

    const label = textByContainer.has(el.id) ? textOf(textByContainer.get(el.id)) : null;
    if (faceIds.has(el.id)) {
      stickies.push({
        id: el.id,
        text: label || '',
        color: el.backgroundColor || null,
        ...box(el),
      });
      continue;
    }

    shapes.push({
      id: el.id,
      type: el.type,
      label,
      backgroundColor: el.backgroundColor || null,
      strokeColor: el.strokeColor || null,
      ...box(el),
    });
  }

  // Top-to-bottom, left-to-right: the order Pat reads the board in.
  const byPosition = (a, b) => (a.y - b.y) || (a.x - b.x);
  stickies.sort(byPosition);
  texts.sort(byPosition);
  images.sort(byPosition);
  shapes.sort(byPosition);

  return { stickies, texts, images, shapes, connectors };
}

// The images an agent can actually view: every scene.files entry with a decodable
// data URL, paired with the placed image element that references it (for position
// and size context). A file with no placed element is still returned (an orphan
// paste is still bytes Pat may want seen).
function sceneImages(scene) {
  const files = (scene && scene.files && typeof scene.files === 'object') ? scene.files : {};
  const placedByFileId = new Map();
  for (const el of live(scene && scene.elements)) {
    if (el.type === 'image' && el.fileId && !placedByFileId.has(el.fileId)) placedByFileId.set(el.fileId, el);
  }
  const out = [];
  for (const [fileId, file] of Object.entries(files)) {
    if (!file || typeof file.dataURL !== 'string') continue;
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(file.dataURL);
    if (!match) continue;
    const mimeType = match[1] || 'application/octet-stream';
    const isBase64 = Boolean(match[2]);
    const placed = placedByFileId.get(fileId) || null;
    out.push({
      fileId,
      mimeType,
      isBase64,
      data: match[3],
      placed: placed ? { id: placed.id, ...box(placed) } : null,
    });
  }
  return out;
}

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

function extForMime(mimeType) {
  return EXT_BY_MIME[String(mimeType || '').toLowerCase()] || 'bin';
}

module.exports = { flattenScene, sceneImages, extForMime, isStickyShadow };
