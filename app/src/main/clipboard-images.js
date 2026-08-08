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

function createClipboardImageHandlers({ saveImage, readImage }) {
  return {
    'clipboard:save-image': async (_event, { buffer, ext = 'png' } = {}) => (
      saveImage(Buffer.from(buffer), ext)
    ),
    'clipboard:read-image': async () => {
      const image = readImage();
      if (!image || image.isEmpty()) return null;
      return saveImage(image.toPNG(), 'png');
    },
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
  createClipboardImageHandlers,
  createElectronClipboardImageSetter,
  registerClipboardImageIpc,
};
