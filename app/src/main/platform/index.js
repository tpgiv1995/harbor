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
    const expected = image.getSize();
    electron.clipboard.writeImage(image);
    // Verify by DIMENSIONS, not by byte-exact PNG. The Windows clipboard stores
    // images as DIB, so a round trip does NOT preserve PNG bytes for any image
    // with an alpha channel (transparency handling differs and Electron
    // re-encodes on read); a byte-exact `.equals()` check threw "image was NOT
    // attached" on transparent icon renders that had in fact landed on the
    // clipboard (2026-09-01). The write only needs to have put a non-empty image
    // of the right size there; whether it actually PASTED is proven downstream by
    // waitForImageMarker, which waits for the CLI to confirm the [Image] marker.
    const roundTrip = electron.clipboard.readImage();
    const got = roundTrip && !roundTrip.isEmpty() ? roundTrip.getSize() : null;
    if (!got || got.width !== expected.width || got.height !== expected.height) {
      throw new Error('could not verify Electron clipboard image; image was NOT attached');
    }
  };
  // A notification is held until it is clicked or closed: one the garbage
  // collector reclaims drops its click handler, so a click on a toast still on
  // screen would do nothing.
  const shown = new Set();
  adapter.notify = (title, body, { onClick } = {}) => {
    if (!electron?.Notification) throw new Error('Electron notification capability unavailable');
    const notification = new electron.Notification({ title, body });
    shown.add(notification);
    const release = () => shown.delete(notification);
    notification.on?.('click', () => { release(); try { onClick?.(); } catch { /* the window is gone */ } });
    notification.on?.('close', release);
    notification.show();
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
