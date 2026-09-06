'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const { realTmpDir } = require('../support/real-tmpdir.js');
const path = require('node:path');
const test = require('node:test');
const { createImageUploader, MAX_IMAGE_BYTES } = require('../../src/server/upload.js');
const { canSymlink } = require('../support/can-symlink.js');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(realTmpDir(), 'harbor-upload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user-data');
  await fs.mkdir(userDataDir, { recursive: true });
  return { root, userDataDir };
}

test('image upload writes decoded bytes to its per-run userData scratch directory', async (t) => {
  const { userDataDir } = await fixture(t);
  const upload = createImageUploader({ userDataDir, runId: 'run-one' });
  const result = await upload({ name: 'photo.png', mediaType: 'image/png', bytesBase64: Buffer.from('png').toString('base64') });
  assert.equal(result.ok, true);
  assert.equal(path.dirname(result.path), path.join(userDataDir, 'server-upload', 'run-one'));
  assert.equal(path.extname(result.path), '.png');
  assert.deepEqual(await fs.readFile(result.path), Buffer.from('png'));
});

test('image upload refuses traversal and absolute caller names', async (t) => {
  const { userDataDir } = await fixture(t);
  const upload = createImageUploader({ userDataDir, runId: 'run-two' });
  await assert.rejects(upload({ name: '../escape.png', mediaType: 'image/png', bytesBase64: 'eA==' }), /upload:image name must be a plain file name/);
  await assert.rejects(upload({ name: '/escape.png', mediaType: 'image/png', bytesBase64: 'eA==' }), /upload:image name must be a plain file name/);
});

test('image upload refuses a symlinked per-run scratch directory', {
  skip: !canSymlink() && 'cannot create symlinks in this session: no SeCreateSymbolicLinkPrivilege',
}, async (t) => {
  const { root, userDataDir } = await fixture(t);
  const outside = path.join(root, 'outside');
  const scratch = path.join(userDataDir, 'server-upload', 'run-link');
  await fs.mkdir(path.dirname(scratch), { recursive: true });
  await fs.mkdir(outside);
  await fs.symlink(outside, scratch);
  const upload = createImageUploader({ userDataDir, runId: 'run-link' });
  await assert.rejects(upload({ name: 'x.png', mediaType: 'image/png', bytesBase64: 'eA==' }), /upload:image scratch directory is not contained in userData/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('image upload refuses oversize bytes before writing', async (t) => {
  const { userDataDir } = await fixture(t);
  const upload = createImageUploader({ userDataDir, runId: 'run-big' });
  const bytesBase64 = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64');
  await assert.rejects(upload({ name: 'big.jpg', mediaType: 'image/jpeg', bytesBase64 }), new RegExp(`upload:image exceeds ${MAX_IMAGE_BYTES} byte limit`));
});

test('image upload refuses media types outside the image allowlist', async (t) => {
  const { userDataDir } = await fixture(t);
  const upload = createImageUploader({ userDataDir, runId: 'run-type' });
  await assert.rejects(upload({ name: 'payload.svg', mediaType: 'image/svg+xml', bytesBase64: 'eA==' }), /upload:image mediaType must be one of image\/png, image\/jpeg, image\/gif, image\/webp/);
});
