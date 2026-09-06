'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readActiveWindow,
  restoreActiveWindow,
  guardAgainstFocusSteal,
  normalizeId,
} = require('../../src/main/focus-guard.js');

// Live-caught 2026-07-27, and it interrupted a full-screen game: a scripted
// Harbor restart came up over the game while `--no-focus-steal` was set the
// whole time. X said so afterwards, `_NET_ACTIVE_WINDOW` was Harbor and the
// stacking put Harbor above the game. The flag drove a WM hint and nothing
// ever checked what the WM did with it.

const xpropOut = (id) => `_NET_ACTIVE_WINDOW(WINDOW): window id # ${id}\n`;

test('the active window is read from X, with ids normalized across tools', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return xpropOut('0x016001aa'); };
  assert.equal(readActiveWindow({ run }), '0x16001aa');
  assert.deepEqual(calls[0], ['xprop', '-root', '_NET_ACTIVE_WINDOW']);
  assert.equal(normalizeId('0x16001AA'), '0x16001aa');
  assert.equal(normalizeId(0x16001aa), '0x16001aa');
});

test('no X, no tools, no window: every read degrades to null instead of throwing', () => {
  assert.equal(readActiveWindow({ run: () => null }), null);
  assert.equal(readActiveWindow({ run: () => 'garbage' }), null);
  assert.equal(readActiveWindow({ run: () => xpropOut('0x0') }), null, 'nothing active is not a window to restore');
  assert.equal(restoreActiveWindow(null), false);
});

function fakeWindow(xid) {
  return {
    blurred: 0,
    isDestroyed: () => false,
    blur() { this.blurred += 1; },
    getNativeWindowHandle: () => {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt(xid));
      return buf;
    },
  };
}

// The whole point: not "did we ask nicely", but "did the screen actually stay
// where it was". These two are deliberately a PAIR. A guard that never fires
// passes the first test for the wrong reason, so the second requires it to fire
// on the exact state Pat hit.
test('when the WM leaves the screen alone, nothing is touched', () => {
  const win = fakeWindow(0xc00004);
  const calls = [];
  const run = (cmd, args) => {
    calls.push(cmd);
    return cmd === 'xprop' ? xpropOut('0x16001aa') : '';
  };
  const res = guardAgainstFocusSteal(win, {
    previousActive: '0x16001aa',
    attempts: 1,
    run,
    setTimeoutFn: () => null,
  });
  assert.equal(res.corrections, 0);
  assert.equal(win.blurred, 0);
  assert.ok(!calls.includes('wmctrl'), 'the game is never poked when it still has the screen');
});

test('when the WM activates us anyway, the screen goes straight back', () => {
  const win = fakeWindow(0xc00004);
  const activated = [];
  const run = (cmd, args) => {
    if (cmd === 'xprop') return xpropOut('0xc00004'); // X says WE are active
    if (cmd === 'wmctrl' && args[0] === '-l') return '0x016001aa  0 host Fullscreen Game\n';
    if (cmd === 'wmctrl') { activated.push(args.join(' ')); return ''; }
    return null;
  };
  const res = guardAgainstFocusSteal(win, {
    previousActive: '0x016001aa',
    attempts: 1,
    run,
    setTimeoutFn: () => null,
  });
  assert.equal(res.corrections, 1);
  assert.deepEqual(activated, ['-i -a 0x16001aa'], 'the game is activated, which restacks it above us');
  assert.equal(win.blurred, 1);
});

// Live-caught 2026-07-28, on the very restart that was meant to prove the guard:
// the window that had the screen was CLOSED during the restart, so handing it
// back failed silently and Harbor sat on top of the game anyway. A correction
// that is not checked is the same mistake as a flag that is not checked.
test('when the window that had the screen is gone, Harbor gets out of the way itself', () => {
  const win = fakeWindow(0xc00004);
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'xprop') return xpropOut('0xc00004');   // we are active, and stay active
    if (cmd === 'wmctrl' && args[0] === '-l') return '0x00c00004  0 host Harbor\n'; // 0x400003 is gone
    if (cmd === 'xdotool') return '';
    return null;
  };
  const res = guardAgainstFocusSteal(win, {
    previousActive: '0x400003',
    attempts: 1,
    run,
    setTimeoutFn: () => null,
  });
  assert.equal(res.corrections, 0, 'nothing could be handed back');
  assert.equal(res.lowered, 1);
  assert.ok(calls.includes('xdotool windowlower 0xc00004'), 'so it lowers itself instead');
  assert.ok(!calls.some((c) => c.startsWith('wmctrl -i -a')), 'and never pokes a window that no longer exists');
});

test('a restore that silently does nothing still ends with Harbor out of the way', () => {
  const win = fakeWindow(0xc00004);
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'xprop') return xpropOut('0xc00004');   // the restore did not take
    if (cmd === 'wmctrl' && args[0] === '-l') return '0x016001aa  0 host Fullscreen Game\n';
    return '';
  };
  const res = guardAgainstFocusSteal(win, {
    previousActive: '0x16001aa',
    attempts: 1,
    run,
    setTimeoutFn: () => null,
  });
  assert.ok(calls.includes('wmctrl -i -a 0x16001aa'), 'it tried the polite route first');
  assert.equal(res.lowered, 1, 'and checked that it worked');
});

test('the guard keeps watching, because activation can arrive after the map', () => {
  const win = fakeWindow(0xc00004);
  let active = '0x16001aa';
  const timers = [];
  const run = (cmd, args) => {
    if (cmd === 'xprop') return xpropOut(active);
    if (cmd === 'wmctrl' && args[0] === '-l') return '0x016001aa  0 host Fullscreen Game\n';
    if (cmd === 'wmctrl') { active = '0x16001aa'; return ''; }
    return null;
  };
  const res = guardAgainstFocusSteal(win, {
    previousActive: '0x16001aa',
    attempts: 4,
    run,
    setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} }; },
  });
  assert.equal(res.corrections, 0, 'nothing to do on the first look');
  active = '0xc00004'; // the WM raises us a beat later
  timers.shift()?.();
  assert.equal(res.corrections, 1, 'the late steal is caught too');
});

test('a launch that was already the active window is left alone', () => {
  // Pat's own click: the window he just asked for IS the one that should have
  // the screen, and the guard must never fight that. The check moved INTO the
  // tick (Electron's native handle is not reliable at ready-to-show, and
  // reading it once up front let a null there disable the guard for the whole
  // launch), so what this proves is that it never probes or corrects.
  const win = fakeWindow(0xc00004);
  const res = guardAgainstFocusSteal(win, {
    previousActive: '0xc00004',
    attempts: 1,
    run: () => { throw new Error('must not probe'); },
    setTimeoutFn: () => null,
  });
  assert.equal(res.corrections, 0);
  assert.equal(res.lowered, undefined);
});

test('a window whose X id is not readable yet is retried, not written off', () => {
  // The old code resolved our id ONCE at ready-to-show and gave up if it was
  // not there, which is a silent way to have no guard at all.
  let handleReady = false;
  const win = {
    isDestroyed: () => false,
    blur() {},
    getNativeWindowHandle: () => {
      if (!handleReady) return Buffer.alloc(0);
      const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(0xc00004)); return b;
    },
  };
  const timers = [];
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'xprop') return xpropOut('0xc00004');
    if (cmd === 'wmctrl' && args[0] === '-l') return '0x016001aa  0 host Fullscreen Game\n';
    return '';
  };
  const res = guardAgainstFocusSteal(win, {
    previousActive: '0x16001aa',
    attempts: 4,
    run,
    setTimeoutFn: (fn) => { timers.push(fn); return { unref() {} }; },
  });
  assert.equal(res.corrections, 0, 'nothing it could do on the first look');
  handleReady = true;
  timers.shift()?.();
  assert.equal(res.corrections, 1, 'and it corrected once the id was readable');
});

test('with nothing recorded as previously active, the guard stays out of it', () => {
  const win = fakeWindow(0xc00004);
  const res = guardAgainstFocusSteal(win, {
    previousActive: null,
    run: () => { throw new Error('must not probe'); },
    setTimeoutFn: () => null,
  });
  assert.equal(res.checked, false);
});
