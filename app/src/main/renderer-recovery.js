'use strict';

// WHAT HARBOR DOES WHEN ITS OWN RENDERER DIES.
//
// Live-caught 2026-08-10, reported as "my harbor app keeps closing
// unexpectedly". At 02:20:29 the render frame went away and the main process
// carried on as if nothing had happened: it kept publishing sidebar updates
// into a frame that no longer existed, logged 704 copies of
//
//   Error sending from webFrameMain: Render frame was disposed before
//   WebFrameMain could be accessed
//
// over the next eleven minutes, and never recovered. From the outside the app
// had closed; from the process table it was still running, still holding the
// single-instance lock, which is why clicking the launcher did nothing. A
// windowless process that answers no clicks and writes an error a second is the
// worst of both outcomes: it neither works nor gets out of the way.
//
// Two rules come out of that, and they are separate on purpose.

// RULE ONE: never push into a frame that cannot receive it.
//
// `isDestroyed()` is not enough, which is the whole reason those 704 lines
// exist. When a renderer CRASHES the WebContents object survives and reports
// itself perfectly healthy; it is the frame underneath that is gone. Electron
// then prints the failure from inside `send()` itself, so the try/catch around
// the call site cannot suppress it either. The only fix is to not call.
function canReceivePush(webContents) {
  if (!webContents) return false;
  try {
    if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return false;
    // The renderer process is gone but the object remains: exactly the 02:20 case.
    if (typeof webContents.isCrashed === 'function' && webContents.isCrashed()) return false;
    // A detached main frame is the same story one layer down.
    const frame = webContents.mainFrame;
    if (frame && frame.detached === true) return false;
  } catch {
    // Touching a half-torn-down object can throw on its own; that is a no.
    return false;
  }
  return true;
}

// Reasons Electron gives for `render-process-gone`. A clean exit is the
// renderer going away because we asked it to (quit, reload), and recovering
// from it would fight the thing that caused it.
const CLEAN_REASONS = new Set(['clean-exit']);

/**
 * RULE TWO: a dead renderer is either brought back or gets out of the way.
 *
 * Reloading is the right first move: it is what a user does by hand and it
 * restores the window without losing the daemon, the sessions or the drafts
 * (which live on disk and in localStorage, not in the dead frame).
 *
 * But a renderer that dies on load would reload forever, so the retry is
 * bounded, and once it is spent the app QUITS rather than lingering. Quitting
 * looks like the louder failure and is the kinder one: the instance lock is
 * released, the taskbar icon works again, and one click gets a working window.
 * Sitting there windowless is the state that had no way out.
 *
 * @param {object} o
 * @param {string} o.reason        Electron's `details.reason`.
 * @param {boolean} o.shuttingDown The app is already quitting.
 * @param {number} o.attempts      Recoveries already made in this streak.
 * @param {number} o.sinceLastMs   Time since the previous death.
 * @param {number} o.maxAttempts   How many reloads before giving up.
 * @param {number} o.streakMs      Deaths closer together than this are a streak.
 * @returns {{action:'ignore'|'reload'|'quit', attempts:number, why:string}}
 */
function planRendererRecovery({
  reason = 'unknown',
  shuttingDown = false,
  attempts = 0,
  sinceLastMs = Number.POSITIVE_INFINITY,
  maxAttempts = 2,
  streakMs = 60_000,
} = {}) {
  if (shuttingDown) {
    return { action: 'ignore', attempts, why: 'the app is already quitting' };
  }
  if (CLEAN_REASONS.has(reason)) {
    return { action: 'ignore', attempts, why: `the renderer exited cleanly (${reason})` };
  }
  // A death long after the last one starts a fresh streak: an app that crashed
  // once this morning has not spent its retries for the rest of the day.
  const streak = sinceLastMs <= streakMs ? attempts + 1 : 1;
  if (streak > maxAttempts) {
    return {
      action: 'quit',
      attempts: streak,
      why: `the renderer died ${streak} times in a row (${reason}); quitting so the app can be started again`,
    };
  }
  return {
    action: 'reload',
    attempts: streak,
    why: `the renderer went away (${reason}); reloading the window`,
  };
}

module.exports = { canReceivePush, planRendererRecovery, CLEAN_REASONS };
