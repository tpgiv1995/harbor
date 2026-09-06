'use strict';

const { methodChannel } = require('./channels.js');

function registerIpcHandler(router, ipcMain, method, handler) {
  if (router) {
    router.register(method, (payload, ctx) => handler(ctx.event, payload));
    return;
  }
  ipcMain.handle(method, handler);
}

function bindIpcMain(router, ipcMain, getWebContents) {
  for (const method of router.methods()) {
    const channel = methodChannel(method);
    if (!channel) throw new Error(`missing RPC channel metadata: ${method}`);
    const dispatch = (event, payload) => router.call(method, payload, {
      source: 'ipc',
      event,
    });
    if (channel.ipc === 'send') ipcMain.on(method, dispatch);
    else ipcMain.handle(method, dispatch);
  }

  return router.onPush((channel, ...args) => {
    const webContents = getWebContents?.();
    if (!webContents) return;
    try { webContents.send(channel, ...args); } catch { /* window went away mid-send */ }
  });
}

module.exports = { bindIpcMain, registerIpcHandler };
