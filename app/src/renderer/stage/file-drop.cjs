'use strict';

// Drag-and-drop onto Harbor, decided in one place so the overlay, the drop
// handler and the tests all agree.
//
// Backlog item 2 (Pat, 2026-07-25): "no way to drag and drop files/images in
// here cleanly ... the entire harbor app would be an eligible landing zone ...
// right now it's messy and I somehow lost a window". There was NO drop handling
// anywhere in the app, renderer or main, so a dropped file fell through to
// Chromium's default and navigated the window at the file. That is the lost
// window, and it is why the guard (never navigate) matters more than the
// feature (attach it).
//
// A dropped IMAGE takes the paste path: its bytes are saved to the image cache
// and attached with a thumbnail, exactly like Pat's usual pasted screenshot, so
// nothing depends on resolving the original file's path. Any OTHER file takes
// the "+ add files" path: its absolute path is appended to the draft text. Only
// that second case needs Electron's webUtils, since a File carries no path.

// A drag is ours when it carries files. Text/URL drags (a link, selected prose)
// are left to the browser so dropping text into the composer still works.
function dragCarriesFiles(types) {
  if (!types) return false;
  const list = Array.from(types);
  return list.includes('Files');
}

function isImageFile(file) {
  if (!file) return false;
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return true;
  // A file manager can hand over an image with an empty MIME type; fall back to
  // the extension rather than dropping it into the text path as a stray path.
  return /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(String(file.name || ''));
}

function splitDroppedFiles(files) {
  const all = Array.from(files || []);
  return {
    images: all.filter((file) => isImageFile(file)),
    others: all.filter((file) => !isImageFile(file)),
  };
}

// Same rule the + menu's "add files" uses: one space between what is already
// typed and the paths, one trailing space so the next word does not fuse.
function appendPaths(text, paths) {
  const clean = (paths || []).filter((path) => typeof path === 'string' && path.trim());
  if (!clean.length) return text || '';
  const prefix = text || '';
  const gap = prefix && !prefix.endsWith(' ') ? ' ' : '';
  return `${prefix}${gap}${clean.join(' ')} `;
}

function imageExtension(file) {
  const type = String(file?.type || '');
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/gif') return 'gif';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/svg+xml') return 'svg';
  if (type.startsWith('image/')) return type.slice('image/'.length).replace(/[^a-z0-9]/gi, '') || 'png';
  const ext = String(file?.name || '').match(/\.([a-z0-9]+)$/i);
  return ext ? ext[1].toLowerCase() : 'png';
}

// What the overlay says. It never promises what it cannot do: with no session
// selected there is no draft to attach to, and a drop is refused outright.
function dropPrompt({ sessionTitle, hasSession }) {
  if (!hasSession) return { kind: 'refused', text: 'Select a session window first' };
  return {
    kind: 'ready',
    text: sessionTitle ? `Drop to attach to ${sessionTitle}` : 'Drop to attach to this session',
  };
}

// The honest report after a drop: what attached, what could not.
function dropReport({ attached = 0, paths = 0, unresolved = 0 } = {}) {
  const parts = [];
  if (attached) parts.push(`${attached} image${attached === 1 ? '' : 's'} attached`);
  if (paths) parts.push(`${paths} path${paths === 1 ? '' : 's'} added`);
  if (unresolved) parts.push(`${unresolved} file${unresolved === 1 ? '' : 's'} could not be read`);
  return parts.join(', ') || null;
}

module.exports = {
  dragCarriesFiles,
  isImageFile,
  splitDroppedFiles,
  appendPaths,
  imageExtension,
  dropPrompt,
  dropReport,
};
