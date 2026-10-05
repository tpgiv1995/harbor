'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createArtifactThumbs } = require('../../src/main/providers/artifact-thumbs.js');

function makeProvider(overrides = {}) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-thumbs-'));
  let calls = 0;
  const provider = createArtifactThumbs({
    cacheDir,
    pdfGenerator: overrides.pdfGenerator || (async (_file, outPath) => {
      calls += 1;
      fs.writeFileSync(outPath, 'png-bytes');
      return true;
    }),
    ...overrides,
  });
  return { provider, cacheDir, calls: () => calls };
}

test('generates once per file version and serves the disk cache after', async () => {
  const { provider, calls } = makeProvider();
  const first = await provider.thumbFor({ path: '/tmp/a.pdf', mtimeMs: 1000, kind: 'pdf' });
  assert.ok(first && first.endsWith('.png'));
  assert.equal(fs.readFileSync(first, 'utf8'), 'png-bytes');
  const second = await provider.thumbFor({ path: '/tmp/a.pdf', mtimeMs: 1000, kind: 'pdf' });
  assert.equal(second, first);
  assert.equal(calls(), 1, 'cache hit must not regenerate');
});

test('a changed mtime is a new version and regenerates', async () => {
  const { provider, calls } = makeProvider();
  const v1 = await provider.thumbFor({ path: '/tmp/a.pdf', mtimeMs: 1000, kind: 'pdf' });
  const v2 = await provider.thumbFor({ path: '/tmp/a.pdf', mtimeMs: 2000, kind: 'pdf' });
  assert.notEqual(v1, v2);
  assert.equal(calls(), 2);
});

test('a failing generator yields null, never a throw, and does not poison the cache', async () => {
  const { provider } = makeProvider({
    pdfGenerator: async () => false,
  });
  assert.equal(await provider.thumbFor({ path: '/tmp/bad.pdf', mtimeMs: 1, kind: 'pdf' }), null);
  const { provider: healthy } = makeProvider();
  assert.ok(await healthy.thumbFor({ path: '/tmp/bad.pdf', mtimeMs: 1, kind: 'pdf' }));
});

test('unknown kinds and nonsense input yield null', async () => {
  const { provider } = makeProvider();
  assert.equal(await provider.thumbFor({ path: '/tmp/a.xyz', mtimeMs: 1, kind: 'word' }), null);
  assert.equal(await provider.thumbFor({ path: '', mtimeMs: 1, kind: 'pdf' }), null);
  assert.equal(await provider.thumbFor({ path: '/tmp/a.pdf', mtimeMs: NaN, kind: 'pdf' }), null);
});

test('html generation without an injected capturer yields null', async () => {
  const { provider } = makeProvider();
  assert.equal(await provider.thumbFor({ path: '/tmp/a.html', mtimeMs: 1, kind: 'html' }), null);
});
