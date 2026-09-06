'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
});

function decodeBase64(value) {
  const source = String(value || '');
  if (!source || source.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source)
    || source.slice(0, -2).includes('=')) {
    throw new Error('upload:image bytesBase64 must be valid base64');
  }
  return Buffer.from(source, 'base64');
}

function createImageUploader({ userDataDir, runId = crypto.randomUUID() } = {}) {
  const userData = path.resolve(String(userDataDir || ''));
  if (!path.isAbsolute(userData) || !userDataDir) throw new TypeError('createImageUploader requires userDataDir');
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new TypeError('upload:image run id is invalid');
  const uploadRoot = path.join(userData, 'server-upload');
  const scratch = path.join(uploadRoot, runId);

  return async function uploadImage({ name, mediaType, bytesBase64 } = {}) {
    if (!name || path.basename(name) !== name || path.isAbsolute(name)) {
      throw new Error('upload:image name must be a plain file name');
    }
    const extension = EXTENSIONS[mediaType];
    if (!extension) {
      throw new Error(`upload:image mediaType must be one of ${Object.keys(EXTENSIONS).join(', ')}`);
    }
    if (String(bytesBase64 || '').length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
      throw new Error(`upload:image exceeds ${MAX_IMAGE_BYTES} byte limit`);
    }
    const bytes = decodeBase64(bytesBase64);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`upload:image exceeds ${MAX_IMAGE_BYTES} byte limit`);

    await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
    const [actualUserData, actualScratch, scratchStat] = await Promise.all([
      fs.realpath(userData), fs.realpath(scratch), fs.lstat(scratch),
    ]);
    const expectedScratch = path.join(actualUserData, 'server-upload', runId);
    if (!scratchStat.isDirectory() || actualScratch !== expectedScratch) {
      throw new Error('upload:image scratch directory is not contained in userData');
    }
    const target = path.join(actualScratch, `${crypto.randomUUID()}${extension}`);
    if (path.dirname(target) !== actualScratch) throw new Error('upload:image target escaped scratch directory');
    await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    return { ok: true, path: target };
  };
}

module.exports = { EXTENSIONS, MAX_IMAGE_BYTES, createImageUploader };
