'use strict';

// Windows cannot maximize passively. Keep the intended state separately until
// the user activates the window, including the rectangle Restore must recover.
const pending = new WeakMap();

function isMaximized(window) {
  return pending.has(window) || window.isMaximized();
}

function savedState(window) {
  const deferred = pending.get(window);
  if (deferred) return { ...deferred.normal, maximized: true };
  return { ...(window.isMaximized() ? window.getNormalBounds() : window.getBounds()), maximized: window.isMaximized() };
}

function showInactiveMaximized(window, screen, onState = () => {}) {
  const normal = window.getBounds();
  const activate = () => {
    if (window.isDestroyed() || !pending.has(window)) return;
    pending.delete(window);
    // setBounds(workArea) changed the native normal rectangle. Put it back
    // before the real maximize so Restore is not another full-screen window.
    window.setBounds(normal);
    window.maximize();
    onState();
  };
  pending.set(window, { normal, activate });
  window.once('focus', activate);
  window.setBounds(screen.getDisplayMatching(normal).workArea);
  window.showInactive();
  onState();
}

function toggleMaximized(window) {
  const deferred = pending.get(window);
  if (deferred) {
    pending.delete(window);
    window.removeListener('focus', deferred.activate);
    window.setBounds(deferred.normal);
  } else if (window.isMaximized()) window.unmaximize();
  else window.maximize();
}

module.exports = { isMaximized, savedState, showInactiveMaximized, toggleMaximized };
