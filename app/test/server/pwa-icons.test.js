'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { createStaticHandler } = require('../../src/server/http/static.js');

const webRoot = path.resolve(__dirname, '../../web');

function request(port, target) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
    }).on('error', reject);
  });
}

test('browser and PWA icon declarations resolve through the app static route', async (t) => {
  const html = await fs.readFile(path.join(webRoot, 'index.html'), 'utf8');
  const manifest = JSON.parse(await fs.readFile(path.join(webRoot, 'public/manifest.webmanifest'), 'utf8'));
  const linkPattern = /<link\s+([^>]+)>/g;
  const attributePattern = /([\w-]+)="([^"]+)"/g;
  const links = [...html.matchAll(linkPattern)].map((match) =>
    Object.fromEntries([...match[1].matchAll(attributePattern)].map((attribute) => [attribute[1], attribute[2]])),
  );
  const favicon = links.find((link) => link.rel === 'icon');
  const appleTouchIcon = links.find((link) => link.rel === 'apple-touch-icon');

  assert.ok(favicon, 'index.html must declare a favicon');
  assert.ok(appleTouchIcon, 'index.html must declare an apple-touch-icon');
  assert.equal(appleTouchIcon.sizes, '180x180');
  assert.ok(manifest.icons.some((icon) => icon.purpose.split(/\s+/).includes('maskable')));

  const declaredIcons = [
    { src: favicon.href, type: favicon.type },
    { src: appleTouchIcon.href, type: 'image/png' },
    ...manifest.icons,
  ];
  const staticHandler = createStaticHandler({ root: path.join(webRoot, 'public') });
  const server = http.createServer(async (req, res) => {
    if (!(await staticHandler(req, res))) {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  for (const icon of declaredIcons) {
    const response = await request(server.address().port, icon.src);
    assert.equal(response.status, 200, `${icon.src} must resolve`);
    assert.equal(response.headers['content-type'], icon.type, `${icon.src} must use its declared MIME type`);
  }
});
