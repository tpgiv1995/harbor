'use strict';

const crypto = require('node:crypto');

// TRANSCRIPT IMAGES LIVE HERE, ONCE EACH, NOT INSIDE CONVERSATION BLOCKS
// (2026-11-05, Pat: "images are a common pain point in harbor").
//
// A block used to carry every image as a base64 data URI. That one string was
// held in main's V8 heap, copied over IPC into the renderer's heap, kept there
// as an <img> attribute, and sent whole to the phone in a session's first
// snapshot (8.6 MB for one screenshot-heavy chat). To bound all of that, each
// conversation kept only its 32 newest image blocks, so older screenshots
// vanished from long chats. Measured that night: 68 MB of image strings in the
// renderer across 14 windows.
//
// Now a block carries a reference ({ mediaType, id, size }) and the bytes sit
// here as off-heap Buffers, keyed by a hash of their content (the same
// screenshot read twice is stored once). The desktop renderer loads them
// through the harbor-image:// protocol and the phone through
// /transcript-images/<id>, only when an image actually scrolls into view, and
// Chromium owns the decoded pixels. Bounded by bytes, least recently used out
// first; an evicted image that is still on screen answers 404 and the window
// says so instead of showing nothing.

const DEFAULT_MAX_BYTES = 384 * 1024 * 1024;
const IMAGE_ID_RE = /^[0-9a-f]{32}$/;

function imageIdFor(base64) {
  return crypto.createHash('sha1').update(String(base64)).digest('hex').slice(0, 32);
}

function createImageStore({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const entries = new Map(); // id -> { mediaType, bytes }; insertion order is the LRU order
  let total = 0;

  function touch(id, entry) {
    entries.delete(id);
    entries.set(id, entry);
  }

  function put(mediaType, base64) {
    const id = imageIdFor(base64);
    const hit = entries.get(id);
    if (hit) { touch(id, hit); return { id, size: hit.bytes.length }; }
    const bytes = Buffer.from(String(base64), 'base64');
    entries.set(id, { mediaType: String(mediaType || 'application/octet-stream'), bytes });
    total += bytes.length;
    while (total > maxBytes && entries.size > 1) {
      const [oldestId, oldest] = entries.entries().next().value;
      entries.delete(oldestId);
      total -= oldest.bytes.length;
    }
    return { id, size: bytes.length };
  }

  function get(id) {
    const key = String(id || '');
    if (!IMAGE_ID_RE.test(key)) return null;
    const hit = entries.get(key);
    if (!hit) return null;
    touch(key, hit);
    return hit;
  }

  return { put, get, stats: () => ({ images: entries.size, bytes: total }) };
}

// One store per process: main's transcript provider and the harbor-image://
// handler share it; the phone server process has its own, beside its own
// provider and its /transcript-images/ route.
const imageStore = createImageStore();

module.exports = { createImageStore, imageStore, imageIdFor, IMAGE_ID_RE, DEFAULT_MAX_BYTES };
