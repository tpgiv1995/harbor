'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerIpcHandler } = require('./rpc/ipc-transport.js');

function createImageWriter({
  fsImpl = fs,
  cacheDir = path.join(os.homedir(), '.cache', 'harbor', 'pastes'),
  now = Date.now,
  pid = process.pid,
} = {}) {
  return async (bytes, ext = 'png') => {
    const safeExt = String(ext).toLowerCase().replace(/^\./, '') === 'jpg' ? 'jpg' : 'png';
    const destination = path.join(cacheDir, `paste-${now()}.${safeExt}`);
    const temporary = `${destination}.tmp-${pid}`;
    fsImpl.mkdirSync(cacheDir, { recursive: true });
    fsImpl.writeFileSync(temporary, Buffer.from(bytes));
    fsImpl.renameSync(temporary, destination);
    return destination;
  };
}

const PREVIEW_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

// Reads back an image this app itself wrote, as a data URI, so a pending
// attachment chip in the composer can be opened and looked at before it is
// sent. A chip only ever carries a path that came out of saveImage, so the
// allowlist is that one directory (plus whatever the composition root names
// explicitly, which is how the E2E clipboard stand-in stays reachable); an
// arbitrary renderer string is never read. Same posture as the artifact
// scheme: the channel serves a known set, not a path someone asked for.
function createImageReader({
  fsImpl = fs,
  cacheDir = path.join(os.homedir(), '.cache', 'harbor', 'pastes'),
  allowPaths = [],
} = {}) {
  const allowedDir = path.resolve(cacheDir);
  const allowedFiles = new Set(allowPaths.map((entry) => path.resolve(String(entry))));
  return async (filePath) => {
    const raw = String(filePath == null ? '' : filePath);
    if (!raw || raw.includes('\0')) return null;
    const resolved = path.resolve(raw);
    if (path.dirname(resolved) !== allowedDir && !allowedFiles.has(resolved)) return null;
    const mime = PREVIEW_MIME[path.extname(resolved).slice(1).toLowerCase()];
    if (!mime) return null;
    try {
      const stat = await fsImpl.promises.stat(resolved);
      if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) return null;
      const bytes = await fsImpl.promises.readFile(resolved);
      return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
    } catch {
      return null;
    }
  };
}

function createClipboardImageHandlers({ saveImage, readImage, readImageDataUri }) {
  return {
    'clipboard:save-image': async (_event, { buffer, ext = 'png' } = {}) => (
      saveImage(Buffer.from(buffer), ext)
    ),
    'clipboard:read-image': async () => {
      const image = readImage();
      if (!image || image.isEmpty()) return null;
      return saveImage(image.toPNG(), 'png');
    },
    // null means "no preview", never an error: a chip that cannot be previewed
    // must still be sendable and removable.
    'clipboard:image-data-uri': async (_event, { path: target } = {}) => (
      readImageDataUri ? readImageDataUri(target) : null
    ),
  };
}

function registerClipboardImageIpc(ipcMain, dependencies) {
  const handlers = createClipboardImageHandlers(dependencies);
  for (const [channel, handler] of Object.entries(handlers)) {
    registerIpcHandler(dependencies?.router, ipcMain, channel, handler);
  }
  return handlers;
}

function createElectronClipboardImageSetter({ clipboard, nativeImage } = {}) {
  if (!clipboard?.writeImage || !clipboard?.readImage || !nativeImage?.createFromPath) {
    throw new TypeError('Electron clipboard image setter requires clipboard and nativeImage');
  }
  return async (imagePath) => {
    const image = nativeImage.createFromPath(imagePath);
    if (!image || image.isEmpty()) throw new Error(`could not read image for clipboard: ${imagePath}`);
    const expected = Buffer.from(image.toPNG());
    clipboard.writeImage(image);
    const roundTrip = clipboard.readImage();
    if (!roundTrip || roundTrip.isEmpty()
      || !Buffer.from(roundTrip.toPNG()).equals(expected)) {
      throw new Error('could not verify Electron clipboard image; image was NOT attached');
    }
  };
}

module.exports = {
  createImageWriter,
  createImageReader,
  createClipboardImageHandlers,
  createElectronClipboardImageSetter,
  registerClipboardImageIpc,
};
