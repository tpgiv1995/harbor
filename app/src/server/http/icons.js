'use strict';
const fs = require('node:fs');
function createIconHandler({ provider }) { return async function icons(req, res) {
  try {
    const url = new URL(req.url, 'http://harbor.local');
    if (!url.pathname.startsWith('/icons/')) return false;
    const file = decodeURIComponent(url.pathname.slice('/icons/'.length));
    const target = await provider.filePathFor(file);
    if (!target) { res.writeHead(404); res.end('not found'); return true; }
    res.writeHead(200, { 'content-type': provider.mimeFor(file) || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
    fs.createReadStream(target).pipe(res); return true;
  } catch { res.writeHead(404); res.end('not found'); return true; }
}; }
module.exports = { createIconHandler };
