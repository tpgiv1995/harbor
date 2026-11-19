'use strict';

const crypto = require('node:crypto');
const { createLinuxPlatform } = require('./linux.js');
const { createWin32Platform } = require('./win32.js');
const { createDarwinPlatform } = require('./darwin.js');

function withElectronCapabilities(adapter, initial = null) {
  let electron = initial;
  adapter.configureElectron = (bindings) => { electron = bindings; };
  // What the clipboard holds now, as the clipboard itself returns it (its own
  // re-encoding, the same on every read of the same content), or null.
  const fingerprintOf = (image) => {
    if (!image || image.isEmpty()) return null;
    const { width, height } = image.getSize();
    return `${width}x${height}:${crypto.createHash('sha256').update(image.toBitmap()).digest('hex')}`;
  };
  const clipboardFingerprint = () => fingerprintOf(electron?.clipboard?.readImage?.());
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
    // THE CLIPBOARD IS EVERYONE'S (Sol's review, round twenty-four): any copy
    // (Harbor's own Board "Copy as PNG", a code block, another app, a Win+Shift+S
    // screenshot) can replace this image before Claude reads it, and Claude
    // then attaches that one. The sender asks, once the chip shows, whether the
    // clipboard still holds exactly what was written here; a busy clipboard is
    // read again a few times before it counts as changed.
    // Taken from the read that verified the write, back to back with it, which
    // narrows (not closes) the gap in which another copy could be fingerprinted
    // as ours (round twenty-five). Closing it, or a clipboard manager putting
    // this exact image back after another was read, needs the Windows clipboard
    // sequence number, which Electron does not expose: a native module, or
    // sending desktop screenshots by path. Pat's decision.
    const wrote = fingerprintOf(roundTrip);
    return {
      stillOnClipboard: async () => {
        if (!wrote) return false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const now = clipboardFingerprint();
          if (now === wrote) return true;
          if (now !== null) return false;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
      },
    };
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
