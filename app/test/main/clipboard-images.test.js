'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createImageWriter,
  createImageReader,
  createClipboardImageHandlers,
  createElectronClipboardImageSetter,
} = require('../../src/main/clipboard-images.js');

const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function pasteFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-pastes-'));
  const cacheDir = path.join(root, 'pastes');
  fs.mkdirSync(cacheDir, { recursive: true });
  const pasted = path.join(cacheDir, 'paste-1.png');
  fs.writeFileSync(pasted, PNG_BYTES);
  return { root, cacheDir, pasted };
}

test('image writer creates the paste directory and atomically renames the temporary file', async () => {
  const calls = [];
  const fakeFs = {
    mkdirSync: (...args) => calls.push(['mkdir', ...args]),
    writeFileSync: (...args) => calls.push(['write', ...args]),
    renameSync: (...args) => calls.push(['rename', ...args]),
  };
  // The literal '/home/you/...' spellings this used to assert made the spec
  // true only on POSIX: path.join is the platform's, so on a Windows runner the
  // writer correctly produced backslashes and the spec called it a failure.
  // Composed the same way the code composes it, the assertion is about the
  // BEHAVIOUR (one mkdir, an atomic tmp+rename) on either OS.
  const cacheDir = path.join('/home/you/.cache/harbor/pastes');
  const write = createImageWriter({
    fsImpl: fakeFs,
    cacheDir,
    now: () => 123456,
    pid: 77,
  });

  const destination = await write(Uint8Array.from([1, 2]), 'png');
  const temporary = `${destination}.tmp-77`;

  assert.equal(destination, path.join(cacheDir, 'paste-123456.png'));
  assert.deepEqual(calls, [
    ['mkdir', cacheDir, { recursive: true }],
    ['write', temporary, Buffer.from([1, 2])],
    ['rename', temporary, destination],
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

test('image reader returns a data URI for an image this app pasted', async () => {
  const { cacheDir, pasted } = pasteFixture();
  const read = createImageReader({ cacheDir });
  const uri = await read(pasted);
  assert.equal(uri, `data:image/png;base64,${PNG_BYTES.toString('base64')}`);
  // Whatever separator spelling the renderer hands back is the same file.
  assert.equal(await read(pasted.replace(/\\/g, '/')), uri);
});

test('image reader refuses any path outside the paste cache, however it is spelled', async () => {
  const { root, cacheDir, pasted } = pasteFixture();
  const outsider = path.join(root, 'secret.png');
  fs.writeFileSync(outsider, PNG_BYTES);
  const read = createImageReader({ cacheDir });

  // A renderer string is never trusted: not a sibling of the cache, not a
  // traversal back out of it, not a subdirectory of it, not a non-image.
  assert.equal(await read(outsider), null);
  assert.equal(await read(path.join(cacheDir, '..', 'secret.png')), null);
  assert.equal(await read(`${cacheDir}/nested/deep.png`), null);
  assert.equal(await read(path.join(cacheDir, 'notes.txt')), null);
  assert.equal(await read(''), null);
  assert.equal(await read(null), null);
  // The real one still works, so the refusals above are the rule and not a
  // reader that simply never returns anything.
  assert.ok(String(await read(pasted)).startsWith('data:image/png;base64,'));
});

test('image reader serves an explicitly named path outside the cache (the E2E stand-in)', async () => {
  const { root, cacheDir } = pasteFixture();
  const named = path.join(root, 'e2e-clipboard.png');
  fs.writeFileSync(named, PNG_BYTES);
  assert.equal(await createImageReader({ cacheDir })(named), null);
  const read = createImageReader({ cacheDir, allowPaths: [named] });
  assert.ok(String(await read(named)).startsWith('data:image/png;base64,'));
});

test('clipboard:image-data-uri answers null rather than throwing when there is no preview', async () => {
  const handlers = createClipboardImageHandlers({
    saveImage: async () => '/x.png',
    readImage: () => null,
    readImageDataUri: async () => null,
  });
  assert.equal(await handlers['clipboard:image-data-uri']({}, { path: '/nope.png' }), null);
  assert.equal(await handlers['clipboard:image-data-uri']({}), null);
  // A composition that wires no reader at all must still answer the channel.
  const bare = createClipboardImageHandlers({ saveImage: async () => '/x.png', readImage: () => null });
  assert.equal(await bare['clipboard:image-data-uri']({}, { path: '/x.png' }), null);
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
