'use strict';

// Where a conversation window stays scrolled (2026-11-16, Pat: "when im
// minimized out of a chat/session for some reason the windows sometimes just
// scroll to the top of the chat").
//
// A window is in one of two places: FOLLOWING (pinned to the latest message,
// new replies keep it there) or READING (left on a message somewhere above;
// that message stays put while replies arrive below it). Only Pat moves a
// window between the two, by scrolling it, sending to it, or the wheel and
// PageUp/PageDown routed to it. Everything else that moves a scroll box (the
// grid re-laying out when a window opens or closes, a minimized page collapsing
// and coming back, a full-stage toggle, a tile moved in the page when windows
// are rearranged, transcript blocks trimmed or replaced) is the browser's doing,
// and the window is put back where Pat left it.
//
// What this replaced read every scroll event as Pat's: when a layout change
// made the browser nudge the scroll position, the window decided Pat had
// scrolled up, stopped following, and sat on old messages while the session
// worked. A rearranged window was worse: the browser resets a scroll box that
// is moved in the page to the top, and an idle window never got a new block to
// pull it back down (scripts/drive-conversation-scroll-win.js reproduces both
// on the old code).
//
// Pure helpers only; the hook in use-conversation-scroll.js does the DOM work.

// Within this many pixels of the bottom, a downward scroll counts as following.
const STICK_THRESHOLD_PX = 56;
// A wheel notch or key press scrolls smoothly over roughly 150-400 ms; scroll
// events that land inside this window after Pat's input are his.
const USER_SCROLL_GRACE_MS = 700;
// Keys that scroll the box holding focus or the one last clicked, and Tab,
// which scrolls a focused button inside a window into view.
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ', 'Spacebar', 'Tab']);
// How much of the window one PageUp/PageDown moves (the rest stays as context).
const PAGE_FRACTION = 0.85;

// After a scroll Pat made: moving up always stops following (so a slow
// trackpad scroll up while replies stream is never pulled back down); moving
// down, or standing still, follows again once within the threshold.
function followAfterUserScroll({ prevTop, top, dist }) {
  if (Number.isFinite(prevTop) && top < prevTop - 0.5) return dist <= 1;
  return dist < STICK_THRESHOLD_PX;
}

// Index of the first item whose bottom edge is below `edge` (the window's top),
// by binary search over items in page order. `bottomAt(i)` reads item i's
// bottom. Returns -1 for no items, and the last index when every item ends
// above the edge.
function firstVisibleIndex(count, bottomAt, edge) {
  if (!(count > 0)) return -1;
  let lo = 0;
  let hi = count - 1;
  let found = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bottomAt(mid) > edge + 1) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

// A wheel event's distance in pixels (deltaMode 0 pixels, 1 lines, 2 pages).
function wheelPixels(event, pageHeight) {
  const dy = Number(event?.deltaY) || 0;
  if (event?.deltaMode === 1) return dy * 40;
  if (event?.deltaMode === 2) return dy * (Number(pageHeight) || 0);
  return dy;
}

// Would the browser scroll something between `start` and `boundary` (exclusive)
// for a wheel of `dy`? A box with room to move that way takes the wheel; a box
// that contains its own overscroll (menus, lists) takes it even at its end.
// `styleOf(el)` returns { overflowY, overscrollBehaviorY }.
function scrollsWithin(start, boundary, dy, styleOf) {
  for (let el = start; el && el !== boundary; el = el.parentElement) {
    const style = styleOf(el) || {};
    if (!/(auto|scroll|overlay)/.test(style.overflowY || '')) continue;
    if (!(el.scrollHeight > el.clientHeight + 1)) continue;
    if (/(contain|none)/.test(style.overscrollBehaviorY || '')) return true;
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  }
  return false;
}

const FOLLOW = Object.freeze({ follow: true, key: null, offset: 0 });
const readingPlace = (anchor) => (anchor && anchor.key ? { follow: false, key: anchor.key, offset: anchor.offset } : FOLLOW);

// One window's place and whether a scroll movement is Pat's. `now` is a clock
// in ms. Pat's input marks a grace period; a pointer held down (scrollbar drag,
// selecting text past the edge) and a routed smooth scroll in flight also count.
function createPlaceKeeper({ initial = FOLLOW, now = () => Date.now(), graceMs = USER_SCROLL_GRACE_MS } = {}) {
  let place = initial || FOLLOW;
  let intentUntil = 0;
  let held = false;
  let smoothing = false;
  let lastTop = Number.NaN;
  const keeper = {
    get place() { return place; },
    set(next) { place = next || FOLLOW; },
    markIntent(ms = graceMs) { intentUntil = Math.max(intentUntil, now() + ms); },
    hold(on) { held = Boolean(on); if (!held) keeper.markIntent(); },
    smoothing(on) { smoothing = Boolean(on); if (!smoothing) keeper.markIntent(); },
    isUser() { return held || smoothing || now() < intentUntil; },
    noteTop(top) { lastTop = top; },
    // A scroll event. The browser's own movement answers 'restore' (put the
    // window back); Pat's movement answers his new place and keeps it.
    scrolled({ top, dist, readAnchor }) {
      if (!keeper.isUser()) return 'restore';
      const follow = followAfterUserScroll({ prevTop: lastTop, top, dist });
      lastTop = top;
      place = follow ? FOLLOW : readingPlace(readAnchor());
      return place;
    },
    // Pat begins a scroll of `dy`: going up leaves FOLLOWING at once, before
    // the smooth scroll moves the box, so a reply landing mid-gesture cannot
    // pull him back down.
    starting(dy, { top, readAnchor }) {
      if (dy < 0 && place.follow && top > 0) place = readingPlace(readAnchor());
    },
  };
  return keeper;
}

// Where to put a window back. `anchorTop` is the anchored message's top edge
// measured from the window's top, or null when that message is not on the
// page. Answers the scrollTop to set (null for "already there") and the place,
// which turns to FOLLOW when the anchored message has left a loaded window
// (trimmed out of its bounded history) rather than stranding Pat anywhere.
function restoreTarget({ place, scrollTop, scrollHeight, clientHeight, anchorTop, hasBlocks }) {
  let next = place || FOLLOW;
  if (!next.follow && next.key) {
    if (anchorTop !== null && anchorTop !== undefined) {
      const delta = anchorTop - next.offset;
      return { top: Math.abs(delta) >= 1 ? scrollTop + delta : null, place: next };
    }
    if (!hasBlocks) return { top: null, place: next };
    next = FOLLOW;
  }
  const bottom = Math.max(0, scrollHeight - clientHeight);
  return { top: Math.abs(scrollTop - bottom) >= 1 ? bottom : null, place: next };
}

// Where each session's window was left, so a window that is unmounted and
// mounted again (switching to Tasks and back, the >_ toggle, a renderer
// remount) opens where Pat left it. Small records, oldest dropped past `max`.
function createPlaceMemory(max = 64) {
  const places = new Map();
  return {
    get(id) { return id ? places.get(id) || null : null; },
    set(id, place) {
      if (!id || !place) return;
      places.delete(id);
      places.set(id, place);
      while (places.size > max) places.delete(places.keys().next().value);
    },
    get size() { return places.size; },
  };
}

module.exports = {
  STICK_THRESHOLD_PX,
  USER_SCROLL_GRACE_MS,
  SCROLL_KEYS,
  PAGE_FRACTION,
  FOLLOW,
  readingPlace,
  createPlaceKeeper,
  restoreTarget,
  followAfterUserScroll,
  firstVisibleIndex,
  wheelPixels,
  scrollsWithin,
  createPlaceMemory,
};
