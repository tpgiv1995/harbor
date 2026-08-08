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
