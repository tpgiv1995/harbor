'use strict';

// Two-click confirm arming for destructive chips (worker close).
// The contract: a confirm gesture is never silently consumed. A click inside
// the double-click window is not consent (the user cannot have read the
// question yet), but it must keep the confirm armed and restart its window
// so the next distinct click always fires; and the disarm window must be
// long enough to read the confirm copy before it quietly reverts.
// (Live-caught 2026-07-20: the old Take over chip ate clicks in both dead
// zones; that chip is gone, and worker close keeps the corrected arming.)

const DOUBLE_CLICK_MS = 300;
const DISARM_MS = 10_000;

// state: null when disarmed, else { at, ...callerState }.
// Returns { armed, fire }: armed is the next state (null when firing),
// fire says this click is the consent.
function armedConfirmClick(state, now, callerState = {}) {
  if (!state) return { armed: { ...callerState, at: now }, fire: false };
  if (now - state.at < DOUBLE_CLICK_MS) {
    return { armed: { ...state, ...callerState, at: now }, fire: false };
  }
  return { armed: null, fire: true };
}

module.exports = { armedConfirmClick, DOUBLE_CLICK_MS, DISARM_MS };
