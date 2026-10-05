'use strict';

// Capture-only entry point. Intercept BEFORE importing the product main file:
// ready-to-show handlers and secondary windows cannot display anything.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const electron = require('electron');
const { ownedRoot } = require('./capture-runtime.cjs');
const fixture = ownedRoot(process.env.HARBOR_SHOT_ROOT || '');
const captureProof = require('./capture-home-guard.cjs');
for (const key of ['HOME', 'USERPROFILE', 'HARBOR_USER_DATA_DIR', 'HARBOR_SESSIOND_DIR', 'HARBOR_CONTEXT_DIR']) {
  const target = path.resolve(process.env[key] || '');
  if (target !== fixture && !target.startsWith(fixture + path.sep)) throw new Error(`unisolated ${key}`);
}
if (process.env.HARBOR_ALLOW_REAL_SIGNALS) throw new Error('real signals forbidden in captures');
const noOp = () => {};
const RealWindow = electron.BrowserWindow;
const ownedWindows = new Set();
class HiddenWindow extends RealWindow {
  static getAllWindows() { return [...ownedWindows].filter(w => !w.isDestroyed()); }
  constructor(options = {}) {
    super({ ...options, show: false, focusable: false, skipTaskbar: true,
      webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    ownedWindows.add(this);
    this.once('closed', () => ownedWindows.delete(this));
    for (const key of ['show', 'showInactive', 'focus', 'maximize', 'restore', 'moveTop', 'setAlwaysOnTop', 'setFullScreen', 'setKiosk']) this[key] = noOp;
    this.webContents.focus = noOp;
    this.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
}
class SilentNotification { static isSupported() { return false; } show() {} on() { return this; } }
const safeElectron = { ...electron, BrowserWindow: HiddenWindow, Notification: SilentNotification,
  dialog: { ...electron.dialog, showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 1 }),
    showMessageBoxSync: () => 1, showErrorBox: noOp },
  shell: { ...electron.shell, openExternal: async () => {}, openPath: async () => '', showItemInFolder: noOp },
};
const load = Module._load;
Module._load = function(name, ...args) { return name === 'electron' ? safeElectron : load.call(this, name, ...args); };
electron.app.focus = noOp;
electron.app.relaunch = noOp;
for (const dir of [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.HARBOR_USER_DATA_DIR]) fs.mkdirSync(dir, { recursive: true });
electron.app.setPath('appData', process.env.APPDATA);
electron.app.setPath('home', fixture);
electron.app.setPath('userData', process.env.HARBOR_USER_DATA_DIR);
electron.app.setPath('crashDumps', path.join(fixture, 'crashes'));
captureProof.proof.electronHome = electron.app.getPath('home');
captureProof.proof.userData = electron.app.getPath('userData');
captureProof.save();
// Synthetic telemetry: never photograph the workstation's current workload.
process.getSystemMemoryInfo = () => ({ total: 32768 * 1024, free: 18432 * 1024, swapTotal: 65536 * 1024, swapFree: 38912 * 1024 });
setTimeout(() => electron.app.exit(124), 480000).unref();
const appRoot = path.resolve(__dirname, '../..');
electron.app.setAppPath(appRoot);
electron.app.setName('harbor');
if (process.env.HARBOR_CAPTURE_HTML) {
  electron.app.whenReady().then(() => {
    const win = new HiddenWindow({ width: Number(process.env.HARBOR_CAPTURE_WIDTH), height: Number(process.env.HARBOR_CAPTURE_HEIGHT), useContentSize: true, frame: false, backgroundColor: '#0b0d11' });
    win.loadFile(process.env.HARBOR_CAPTURE_HTML);
  });
} else if (process.env.HARBOR_CAPTURE_PHONE === '1') {
  electron.app.whenReady().then(() => new HiddenWindow({ width: 430, height: 932, useContentSize: true, frame: false }).loadURL('about:blank'));
} else {
  require(path.join(appRoot, 'src/main/index.js'));
}
