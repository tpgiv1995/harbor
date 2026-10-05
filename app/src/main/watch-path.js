'use strict';

const fs = require('node:fs');

function unavailable(target, error) {
  console.warn(`Harbor: cannot watch ${target}; automatic file updates may be delayed: ${error?.message || error}`);
}

// libuv can abort on a Windows 8.3 spelling. JS realpath leaves that spelling
// intact; native realpath expands it. Never fall back to the unsafe input.
function watchPath(target, options, listener) {
  try {
    const resolved = fs.realpathSync.native(target);
    const watcher = fs.watch(resolved, options, listener);
    watcher.on('error', (error) => unavailable(target, error));
    return watcher;
  } catch (error) {
    unavailable(target, error);
    throw error;
  }
}

module.exports = { watchPath };
