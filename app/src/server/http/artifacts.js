'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MIME = { '.html': 'text/html', '.htm': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.woff': 'font/woff', '.woff2': 'font/woff2' };

function createArtifactHandler({ provider }) {
  return async function artifacts(req, res) {
    try {
      const url = new URL(req.url, 'http://harbor.local');
      if (url.pathname !== '/artifacts') return false;
      const target = path.normalize(url.searchParams.get('path') || '');
      if (!target || !provider.isServable(target)) { res.writeHead(404); res.end('not found'); return true; }
      let resolved = target;
      try { resolved = await fsp.realpath(target); } catch { res.writeHead(404); res.end('not found'); return true; }
      if (resolved !== path.resolve(target) && !provider.isServable(resolved)) {
        res.writeHead(404); res.end('not found'); return true;
      }
      const stat = await fsp.stat(resolved);
      if (!stat.isFile()) throw new Error('not a file');
      const headers = { 'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream', 'accept-ranges': 'bytes' };
      const match = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
      if (match && (match[1] || match[2])) {
        const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
          res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); res.end(); return true;
        }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': String(end - start + 1) });
        fs.createReadStream(resolved, { start, end }).pipe(res); return true;
      }
      if (stat.size > 128 * 1024 * 1024) { res.writeHead(413); res.end('too large'); return true; }
      res.writeHead(200, { ...headers, 'content-length': String(stat.size) }); fs.createReadStream(resolved).pipe(res); return true;
    } catch { res.writeHead(404); res.end('not found'); return true; }
  };
}

module.exports = { createArtifactHandler };
