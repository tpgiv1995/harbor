'use strict';
const { imageStore } = require('../../main/providers/image-store.js');

// The phone's half of on-demand transcript images (2026-11-05): a block
// carries { mediaType, id, size } and the phone fetches /transcript-images/<id>
// only when it draws the image, instead of every image riding inline in a
// session's first snapshot (8.6 MB for one screenshot-heavy chat). Serves only
// an id this process's store holds; the ids are content hashes.
function createTranscriptImageHandler({ store = imageStore } = {}) {
  return async function transcriptImages(req, res) {
    let url;
    try { url = new URL(req.url, 'http://harbor.local'); } catch { return false; }
    if (!url.pathname.startsWith('/transcript-images/')) return false;
    const hit = store.get(url.pathname.slice('/transcript-images/'.length));
    if (!hit) { res.writeHead(404); res.end('not found'); return true; }
    res.writeHead(200, {
      'content-type': hit.mediaType,
      'content-length': String(hit.bytes.length),
      'cache-control': 'private, max-age=31536000, immutable',
    });
    res.end(hit.bytes);
    return true;
  };
}

module.exports = { createTranscriptImageHandler };
