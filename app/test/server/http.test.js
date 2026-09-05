'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const { realTmpDir } = require('../support/real-tmpdir.js');
const path = require('node:path');
const test = require('node:test');
const { createArtifactHandler } = require('../../src/server/http/artifacts.js');
const { canSymlink } = require('../support/can-symlink.js');
function request(port, target, headers = {}) { return new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: target, headers }, (response) => { const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
}); }
test('artifact route serves only indexed paths and supports byte ranges', async (t) => {
  const dir = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-artifact-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const indexed = path.join(dir, 'report.pdf'); const secret = path.join(dir, 'secret.pdf');
  await fs.writeFile(indexed, '0123456789'); await fs.writeFile(secret, 'not allowed');
  const handler = createArtifactHandler({ provider: { isServable: (candidate) => candidate === indexed } });
  const server = http.createServer(handler); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve))); const port = server.address().port;
  const ranged = await request(port, `/artifacts?path=${encodeURIComponent(indexed)}`, { range: 'bytes=2-5' });
  assert.equal(ranged.status, 206); assert.equal(ranged.body.toString(), '2345'); assert.equal(ranged.headers['content-range'], 'bytes 2-5/10');
  assert.equal((await request(port, `/artifacts?path=${encodeURIComponent(secret)}`)).status, 404);
});

test('artifact route refuses symlinks that escape the indexed directory', {
  skip: !canSymlink() && 'cannot create symlinks in this session: no SeCreateSymbolicLinkPrivilege',
}, async (t) => {
  const parent = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-artifact-symlink-'));
  const dir = path.join(parent, 'bundle');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await fs.mkdir(dir, { recursive: true });
  const indexed = path.join(dir, 'report.html');
  const outside = path.join(parent, 'outside-secret.txt');
  await fs.writeFile(indexed, '0123456789');
  await fs.writeFile(outside, 'secret');
  await fs.symlink(outside, path.join(dir, 'escape.txt'));
  const artifactDir = path.dirname(indexed);
  const handler = createArtifactHandler({
    provider: {
      isServable: (candidate) => {
        const normalized = path.normalize(String(candidate || ''));
        if (normalized === indexed) return true;
        return normalized.startsWith(`${artifactDir}${path.sep}`);
      },
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  assert.equal((await request(port, `/artifacts?path=${encodeURIComponent(indexed)}`)).status, 200);
  assert.equal((await request(port, `/artifacts?path=${encodeURIComponent(path.join(dir, 'escape.txt'))}`)).status, 404);
});
