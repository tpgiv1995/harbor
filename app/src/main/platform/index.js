'use strict';

const { createLinuxPlatform } = require('./linux.js');
const { createWin32Platform } = require('./win32.js');
const { createDarwinPlatform } = require('./darwin.js');

function withElectronCapabilities(adapter, initial = null) {
  let electron = initial;
  adapter.configureElectron = (bindings) => { electron = bindings; };
  adapter.clipboardImage = async (imagePath) => {
    if (!electron?.clipboard || !electron?.nativeImage) {
      throw new Error('Electron clipboard capability unavailable');
    }
    const image = electron.nativeImage.createFromPath(imagePath);
    if (!image || image.isEmpty()) throw new Error(`could not read image for clipboard: ${imagePath}`);
    const expected = Buffer.from(image.toPNG());
    electron.clipboard.writeImage(image);
    const roundTrip = electron.clipboard.readImage();
    if (!roundTrip || roundTrip.isEmpty() || !Buffer.from(roundTrip.toPNG()).equals(expected)) {
      throw new Error('could not verify Electron clipboard image; image was NOT attached');
    }
  };
  adapter.notify = (title, body) => {
    if (!electron?.Notification) throw new Error('Electron notification capability unavailable');
    new electron.Notification({ title, body }).show();
  };
  return adapter;
}

function createPlatform(name = process.platform, dependencies = {}) {
  if (name === 'linux') return withElectronCapabilities(createLinuxPlatform(dependencies), dependencies.electron);
  if (name === 'win32') return withElectronCapabilities(createWin32Platform(dependencies), dependencies.electron);
  if (name === 'darwin') return withElectronCapabilities(createDarwinPlatform(dependencies), dependencies.electron);
  throw new Error(`unsupported platform: ${name}`);
}

const platform = createPlatform();

module.exports = { createPlatform, platform };
