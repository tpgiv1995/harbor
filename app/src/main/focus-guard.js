'use strict';

// Keeping an out-of-band restart OFF the screen, verified against X rather than
// assumed from a flag.
//
// Live-caught 2026-07-27, and it interrupted a full-screen game: a scripted
// restart came up over the game with `--no-focus-steal` set the whole time.
// X said it plainly afterwards, `_NET_ACTIVE_WINDOW` was Harbor and
// `_NET_CLIENT_LIST_STACKING` put Harbor above the game. The flag only ever
// drove `showInactive()`, and `showInactive()` is not the guarantee:
//
//   * `maximize()` was called AFTER the window was mapped, and asking mutter to
//     maximize a mapped window activates it. Maximizing while still hidden
//     shows it unfocused instead (Electron's own documented behaviour).
//   * the single-instance handler called `mainWindow.focus()` unconditionally,
//     so a relaunch that raced a not-yet-dead instance stole focus by design.
//
// Both are fixed at the source, but a flag driving a WM hint is a PROXY, and
// this exists because the proxy was believed over the outcome. So the outcome
// gets checked: read who X says is active, and if the answer is us when it was
// somebody else a moment ago, hand it straight back. Restoring the window that
// WAS active also restacks it above ours, which is what "open it behind
// the game" actually means: not focus alone, since an unfocused window still
// covers the game.
//
// Everything here degrades to a no-op: no X, no tools, no display, not Linux.

const { spawnSync } = require('node:child_process');

const WINDOW_ID_RE = /window id # (0x[0-9a-fA-F]+)/;

function run(cmd, args, env) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 2000, env });
    if (res.error || res.status !== 0) return null;
    return res.stdout || '';
  } catch {
    return null;
  }
}

// The window X currently considers active, as a normalized hex id, or null.
function readActiveWindow(deps = {}) {
  const exec = deps.run || run;
  const out = exec('xprop', ['-root', '_NET_ACTIVE_WINDOW'], deps.env);
  const match = WINDOW_ID_RE.exec(out || '');
  if (!match) return null;
  const id = normalizeId(match[1]);
  // xprop reports 0x0 when nothing is active; that is not a window to restore.
  return id === '0x0' ? null : id;
}

// X ids come back with and without leading zeros depending on the tool
// ("0x016001aa" from wmctrl, "0x16001aa" from xprop), so compare normalized.
function normalizeId(value) {
  if (value == null) return null;
  const raw = typeof value === 'number' || typeof value === 'bigint'
    ? value.toString(16)
    : String(value).trim().replace(/^0x/i, '');
  if (!raw || !/^[0-9a-fA-F]+$/.test(raw)) return null;
  return `0x${raw.replace(/^0+/, '').toLowerCase() || '0'}`;
}

// Electron hands back the XID as a native-endian unsigned long.
function windowXid(win) {
  try {
    const handle = win?.getNativeWindowHandle?.();
    if (!handle || !handle.length) return null;
    const value = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    return normalizeId(value);
  } catch {
    return null;
  }
}

// Give the screen back to whoever had it. Activating the previous window also
// raises it above ours, which is the part that matters: an unfocused window
// still covers a full-screen game.
function restoreActiveWindow(previousId, deps = {}) {
  const exec = deps.run || run;
  const id = normalizeId(previousId);
  if (!id) return false;
  // The window may be GONE by now. Live-caught 2026-07-28 on the very restart
  // meant to prove this guard: the window that had the screen was closed during
  // it, wmctrl failed silently, and Harbor sat on top of the game believing it
  // had handed the screen back.
  if (!windowExists(id, deps)) return false;
  return exec('wmctrl', ['-i', '-a', id], deps.env) != null;
}

function windowExists(id, deps = {}) {
  const exec = deps.run || run;
  const out = exec('wmctrl', ['-l'], deps.env);
  if (out == null) return false;
  const want = normalizeId(id);
  return String(out).split('\n').some((line) => normalizeId(line.split(/\s+/)[0] || '') === want);
}

// Nobody to hand the screen to, so get out of the way instead. A one-shot
// XLowerWindow, NOT the _NET_WM_STATE_BELOW hint: Harbor has to be usable the
// moment Pat clicks it, and a sticky always-below would be its own bug.
function lowerSelf(ourId, deps = {}) {
  const exec = deps.run || run;
  const id = normalizeId(ourId);
  if (!id) return false;
  return exec('xdotool', ['windowlower', id], deps.env) != null;
}

// Watch for the WM activating us despite the request not to, and undo it.
// Bounded and repeated, because activation can arrive a beat after the map.
function guardAgainstFocusSteal(win, options = {}) {
  const {
    previousActive,
    // Twelve seconds of watching, not one and a half. Mutter does not
    // necessarily activate the new window within the first beat: every scripted
    // restart on 2026-07-28 was corrected by the verifier script AFTER the
    // guard's old window had already closed, which means the guard was watching
    // the wrong seconds.
    attempts = 24,
    intervalMs = 500,
    setTimeoutFn = setTimeout,
    ...deps
  } = options;
  if (!previousActive) return { checked: false, corrections: 0 };

  const state = { checked: true, corrections: 0 };
  let left = attempts;
  const tick = () => {
    left -= 1;
    if (win?.isDestroyed?.()) return;
    // Resolve OUR id per tick. Electron's native window handle is not
    // necessarily meaningful at ready-to-show, and reading it once up front
    // meant a null there disabled the guard for the whole launch.
    const ours = deps.selfId ? normalizeId(deps.selfId) : windowXid(win);
    if (!ours || normalizeId(previousActive) === ours) {
      if (left > 0) setTimeoutFn(tick, intervalMs)?.unref?.();
      return;
    }
    if (readActiveWindow(deps) === ours) {
      // We took the screen we were told not to take. Put it back, then CHECK
      // that putting it back worked. The correction is exactly the step that
      // failed on 2026-07-28: the window it tried to restore had been closed
      // during the restart, so the polite route did nothing and Harbor stayed
      // on top of the game. A correction that is not verified is the same
      // mistake as a flag that is not verified.
      const handedBack = restoreActiveWindow(previousActive, deps);
      if (handedBack) state.corrections += 1;
      try { win?.blur?.(); } catch { /* window may be gone */ }
      if (!handedBack || readActiveWindow(deps) === ours) {
        // Whoever had it is gone, or would not take it back. Get out of the way
        // under our own power rather than leave the screen taken.
        if (lowerSelf(ours, deps)) state.lowered = (state.lowered || 0) + 1;
      }
      // One correction is the whole job. Continuing to watch for twelve seconds
      // after that would fight Pat's own click on the window he just got back.
      return;
    }
    if (left > 0) setTimeoutFn(tick, intervalMs)?.unref?.();
  };
  tick();
  if (left > 0) setTimeoutFn(tick, intervalMs)?.unref?.();
  return state;
}

module.exports = {
  readActiveWindow,
  restoreActiveWindow,
  windowExists,
  lowerSelf,
  guardAgainstFocusSteal,
  windowXid,
  normalizeId,
};
