'use strict';

// One rule for "does this navigation replace the app page", shared by every
// main-process handler that asks (2026-10-09, Pat's screenshots of a window
// frozen on a 10:40 PM reply while the session's terminal showed it had
// answered three more messages since).
//
// The main window never leaves its own page: will-navigate refuses every
// navigation except the page itself (a reload, or the same page with another
// query string). The transcript release on did-start-navigation assumed that
// any main-frame navigation that STARTS is a reload, but Electron fires
// did-start-navigation BEFORE will-navigate gets its chance to refuse
// (measured on Electron 37.10.3 in a hidden window: a link click logs
// did-start-navigation, then will-navigate, and the page survives untouched).
// So one click on a link in a conversation released the transcript reader of
// EVERY open window while every window stayed on screen, and nothing ever
// asked for them again: all of them froze on their last update, the rail kept
// moving, and the only way out was closing and reopening each window. The
// live main process showed 2 readers for 14 open windows. The guard and the
// release now answer from this one function, so they cannot disagree again.

function parse(value) {
  try { return new URL(String(value || 'about:blank')); } catch { return null; }
}

// The app page itself: same origin and same path as the page now showing.
// This is exactly what will-navigate lets through. An unparseable address is
// never the page, so the guard refuses it rather than throwing before it can.
function isShellNavigation(targetUrl, currentUrl) {
  const target = parse(targetUrl);
  const current = parse(currentUrl);
  if (!target || !current) return false;
  return target.origin === current.origin && target.pathname === current.pathname;
}

// Only a main-frame, cross-document navigation to the page itself replaces
// the running renderer. A link, a dropped file, or any other address the guard
// refuses leaves the page (and everything it has open) exactly where it was.
function navigationReplacesPage({ url, currentUrl, isMainFrame, isSameDocument }) {
  if (!isMainFrame || isSameDocument) return false;
  return isShellNavigation(url, currentUrl);
}

module.exports = { isShellNavigation, navigationReplacesPage };
