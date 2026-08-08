'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createImageWriter,
  createClipboardImageHandlers,
  createElectronClipboardImageSetter,
} = require('../../src/main/clipboard-images.js');

test('image writer creates the paste directory and atomically renames the temporary file', async () => {
  const calls = [];
  const fakeFs = {
    mkdirSync: (...args) => calls.push(['mkdir', ...args]),
    writeFileSync: (...args) => calls.push(['write', ...args]),
    renameSync: (...args) => calls.push(['rename', ...args]),
  };
  const write = createImageWriter({
    fsImpl: fakeFs,
    cacheDir: '/home/you/.cache/harbor/pastes',
    now: () => 123456,
    pid: 77,
  });

  const destination = await write(Uint8Array.from([1, 2]), 'png');

  assert.equal(destination, '/home/you/.cache/harbor/pastes/paste-123456.png');
  assert.deepEqual(calls, [
    ['mkdir', '/home/you/.cache/harbor/pastes', { recursive: true }],
    ['write', '/home/you/.cache/harbor/pastes/paste-123456.png.tmp-77', Buffer.from([1, 2])],
    ['rename', '/home/you/.cache/harbor/pastes/paste-123456.png.tmp-77', destination],
  ]);
});

test('clipboard:save-image forwards renderer bytes to the injected image writer', async () => {
  const calls = [];
  const handlers = createClipboardImageHandlers({
    saveImage: async (buffer, ext) => {
      calls.push({ buffer, ext });
      return '/tmp/paste.png';
    },
    readImage: () => null,
  });

  const source = Uint8Array.from([137, 80, 78, 71]);
  const result = await handlers['clipboard:save-image']({}, { buffer: source, ext: 'png' });

  assert.equal(result, '/tmp/paste.png');
  assert.deepEqual(calls, [{ buffer: Buffer.from(source), ext: 'png' }]);
});

test('clipboard:read-image returns null without writing when native clipboard is empty', async () => {
  let writes = 0;
  const handlers = createClipboardImageHandlers({
    saveImage: async () => {
      writes += 1;
      return '/tmp/unexpected.png';
    },
    readImage: () => ({ isEmpty: () => true }),
  });

  assert.equal(await handlers['clipboard:read-image'](), null);
  assert.equal(writes, 0);
});

test('clipboard:read-image writes native clipboard PNG bytes', async () => {
  const calls = [];
  const png = Buffer.from([1, 2, 3]);
  const handlers = createClipboardImageHandlers({
    saveImage: async (buffer, ext) => {
      calls.push({ buffer, ext });
      return '/cache/paste-1.png';
    },
    readImage: () => ({ isEmpty: () => false, toPNG: () => png }),
  });

  assert.equal(await handlers['clipboard:read-image'](), '/cache/paste-1.png');
  assert.deepEqual(calls, [{ buffer: png, ext: 'png' }]);
});

test('Electron clipboard image setter round-trips the screenshot PNG before succeeding', async () => {
  const source = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
  let stored = null;
  const clipboard = {
    writeImage: (image) => { stored = image; },
    readImage: () => stored,
  };
  const nativeImage = {
    createFromPath: (imagePath) => {
      assert.equal(imagePath, '/cache/screenshot.png');
      return { isEmpty: () => false, toPNG: () => source };
    },
  };
  const setImage = createElectronClipboardImageSetter({ clipboard, nativeImage });
  await setImage('/cache/screenshot.png');
  assert.deepEqual(clipboard.readImage().toPNG(), source);
});

test('Electron clipboard image setter fails honestly when the round-trip differs', async () => {
  const clipboard = {
    writeImage() {},
    readImage: () => ({ isEmpty: () => false, toPNG: () => Buffer.from('different') }),
  };
  const nativeImage = {
    createFromPath: () => ({ isEmpty: () => false, toPNG: () => Buffer.from('source') }),
  };
  const setImage = createElectronClipboardImageSetter({ clipboard, nativeImage });
  await assert.rejects(() => setImage('/cache/screenshot.png'), /could not verify Electron clipboard image/);
});
