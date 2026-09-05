'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createReadStream } = require('node:fs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};

function createStaticHandler({ root, index = 'index.html', logger = console } = {}) {
  const resolvedRoot = path.resolve(root);
  return async function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url, 'http://harbor.local');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('..')) {
      res.writeHead(400);
      res.end('bad path');
      return true;
    }
    if (pathname === '/') pathname = `/${index}`;
    const filePath = path.join(resolvedRoot, pathname);
    if (!filePath.startsWith(resolvedRoot)) {
      res.writeHead(403);
      res.end('forbidden');
      return true;
    }
    let stat;
    try {
      stat = await fsp.stat(filePath);
      if (stat.isDirectory()) {
        const nested = path.join(filePath, index);
        stat = await fsp.stat(nested);
        return sendFile(req, res, nested, stat);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn(`harbor-server: static ${filePath}: ${error.message}`);
        res.writeHead(500);
        res.end('static error');
        return true;
      }
      // SPA fallback: unknown paths serve index.html unless they look like assets.
      if (!pathname.includes('.')) {
        const fallback = path.join(resolvedRoot, index);
        try {
          stat = await fsp.stat(fallback);
          return sendFile(req, res, fallback, stat);
        } catch {
          return false;
        }
      }
      return false;
    }
    return sendFile(req, res, filePath, stat);
  };
}

// Only CONTENT-HASHED output may be cached immutably, because only there does a
// changed file mean a changed URL. Everything else keeps a stable name across
// builds, so an immutable header freezes it on the device forever.
//
// Live-caught 2026-08-02: sw.js and manifest.webmanifest were served with
// max-age=31536000, immutable. A new service worker and a corrected app icon
// were both shipped and NEITHER reached Pat's phone, because Safari had been
// told it could keep the old ones for a year. Combined with a cache-first
// service worker that had precached index.html, the installed app was
// unupdatable by any means short of clearing website data.
//
// sw.js is the most dangerous of these: it is the one file that decides whether
// every OTHER file can ever be refreshed, so it is explicitly no-store.
function cacheControlFor(filePath, ext) {
  const name = path.basename(filePath);
  if (name === 'sw.js') return 'no-store, must-revalidate';
  if (ext === '.html' || ext === '.webmanifest') return 'no-cache';
  // Vite emits build output into /assets/ with a content hash in the filename.
  if (filePath.includes(`${path.sep}assets${path.sep}`)) return 'public, max-age=31536000, immutable';
  // Icons and anything else with a stable name: revalidate rather than freeze.
  return 'public, max-age=0, must-revalidate';
}

function sendFile(req, res, filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': cacheControlFor(filePath, ext),
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
  return true;
}

module.exports = { createStaticHandler };
