'use strict';

function createRouter() {
  const handlers = new Map();
  const pushListeners = new Set();

  return {
    register(method, handler) {
      if (handlers.has(method)) throw new Error(`RPC method already registered: ${method}`);
      handlers.set(method, handler);
    },

    async call(method, payload, ctx = {}) {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`unknown RPC method: ${method}`);
      // The shared ask channel can answer remotely, but opening an OS browser
      // belongs to the local desktop. Check before the IPC adapter drops ctx.
      if (method === 'ask:answer' && payload?.action === 'open-url' && ctx.source !== 'ipc') {
        return { ok: false, reason: 'Open this URL in the browser on your device' };
      }
      return handler(payload, ctx);
    },

    methods() {
      return [...handlers.keys()];
    },

    onPush(listener) {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },

    emit(channel, ...args) {
      for (const listener of pushListeners) listener(channel, ...args);
    },
  };
}

module.exports = { createRouter };
