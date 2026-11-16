'use strict';

// Where a conversation window stays scrolled (2026-11-16): the rules in
// src/renderer/stage/conversation-scroll.cjs, driven through a model window
// whose rows re-wrap the way a real window's do when it is resized. The live
// proof on the real renderer is scripts/drive-conversation-scroll-win.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  STICK_THRESHOLD_PX,
  USER_SCROLL_GRACE_MS,
  FOLLOW,
  createPlaceKeeper,
  restoreTarget,
  followAfterUserScroll,
  firstVisibleIndex,
  wheelPixels,
  scrollsWithin,
  createPlaceMemory,
} = require('../../src/renderer/stage/conversation-scroll.cjs');

// A window of rows, each `chars` long, wrapped at `width` (one line per 10
// chars, 20px a line, 14px gap), like a conversation column narrowing.
function makeWindow({ rows = 40, width = 400, clientHeight = 300 } = {}) {
  const win = {
    rows: Array.from({ length: rows }, (_, i) => ({ key: `b${i}`, chars: 200 + (i % 5) * 40 })),
    width,
    clientHeight,
    scrollTop: 0,
    layout() {
      let y = 0;
      for (const row of this.rows) {
        const lines = Math.max(1, Math.ceil(row.chars / Math.max(10, this.width / 10)));
        row.top = y;
        row.height = lines * 20;
        y += row.height + 14;
      }
      this.scrollHeight = Math.max(y, this.clientHeight);
      this.scrollTop = Math.min(Math.max(0, this.scrollTop), this.scrollHeight - this.clientHeight);
    },
    get dist() { return this.scrollHeight - this.scrollTop - this.clientHeight; },
    anchor() {
      const i = firstVisibleIndex(this.rows.length, (k) => this.rows[k].top + this.rows[k].height - this.scrollTop, 0);
      const row = this.rows[i];
      return row ? { key: row.key, offset: row.top - this.scrollTop } : null;
    },
    rowTop(key) {
      const row = this.rows.find((r) => r.key === key);
      return row ? row.top - this.scrollTop : null;
    },
  };
  win.layout();
  return win;
}

// What the hook does on a layout change: ask restoreTarget, apply it.
function restore(win, keeper, hasBlocks = true) {
  const place = keeper.place;
  const plan = restoreTarget({
    place,
    scrollTop: win.scrollTop,
    scrollHeight: win.scrollHeight,
    clientHeight: win.clientHeight,
    anchorTop: !place.follow && place.key ? win.rowTop(place.key) : null,
    hasBlocks,
  });
  if (plan.place !== place) keeper.set(plan.place);
  if (plan.top !== null) win.scrollTop = Math.min(Math.max(0, plan.top), win.scrollHeight - win.clientHeight);
  keeper.noteTop(win.scrollTop);
}

function clock(start = 1000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('a scroll movement nobody asked for is put back, never read as Pat scrolling up', () => {
  const c = clock();
  const win = makeWindow();
  const keeper = createPlaceKeeper({ now: c.now });
  restore(win, keeper);
  assert.equal(win.dist, 0, 'opens at the latest message');
  // The grid gains a window: this one narrows, its rows wrap taller, and the
  // browser leaves scrollTop where it was (now far from the bottom).
  win.width = 220;
  win.layout();
  assert.ok(win.dist > STICK_THRESHOLD_PX, 'the reflow left it short of the bottom');
  // The old code read the scroll event this causes as Pat's and stopped following.
  assert.equal(keeper.scrolled({ top: win.scrollTop, dist: win.dist, readAnchor: () => win.anchor() }), 'restore');
  assert.equal(keeper.place.follow, true, 'still following');
  restore(win, keeper);
  assert.equal(win.dist, 0, 'back at the latest message');
});

test('a window reading history keeps the same message at the same spot through a reflow', () => {
  const c = clock();
  const win = makeWindow();
  const keeper = createPlaceKeeper({ now: c.now });
  restore(win, keeper);
  // Pat wheels up into the history.
  keeper.markIntent();
  win.scrollTop = 900;
  const place = keeper.scrolled({ top: win.scrollTop, dist: win.dist, readAnchor: () => win.anchor() });
  assert.equal(place.follow, false);
  const before = win.anchor();
  c.t += USER_SCROLL_GRACE_MS + 1;
  // Collapse (a minimized window) and back, with a reply landing meanwhile.
  for (const width of [20, 400]) {
    win.width = width;
    if (width === 20) win.rows.push({ key: 'late', chars: 300 });
    win.layout();
    assert.equal(keeper.scrolled({ top: win.scrollTop, dist: win.dist, readAnchor: () => win.anchor() }), 'restore');
    restore(win, keeper);
  }
  const after = win.anchor();
  assert.equal(after.key, before.key, 'same message at the top');
  assert.ok(Math.abs(after.offset - before.offset) < 1, `same offset (${before.offset} -> ${after.offset})`);
});

test('a window put back at its top by the page (a moved tile) returns to its place', () => {
  const c = clock();
  const win = makeWindow();
  const keeper = createPlaceKeeper({ now: c.now });
  restore(win, keeper);
  win.scrollTop = 0; // what the browser does to a scroll box moved in the page
  restore(win, keeper);
  assert.equal(win.dist, 0);
});

test('Pat starting to scroll up stops following before the scroll moves, so a reply cannot pull him down', () => {
  const c = clock();
  const win = makeWindow();
  const keeper = createPlaceKeeper({ now: c.now });
  restore(win, keeper);
  keeper.markIntent();
  keeper.starting(-100, { top: win.scrollTop, readAnchor: () => win.anchor() });
  assert.equal(keeper.place.follow, false, 'reading from the first wheel notch');
  const pinned = win.anchor();
  // A reply streams in before the smooth scroll has moved anything.
  win.rows.push({ key: 'reply', chars: 600 });
  win.layout();
  restore(win, keeper);
  assert.equal(win.anchor().key, pinned.key, 'held where the wheel started');
  assert.ok(win.dist > 0, 'not pulled to the new reply');
});

test('scrolling up even a little leaves following; scrolling back down near the bottom follows again', () => {
  assert.equal(followAfterUserScroll({ prevTop: 1000, top: 990, dist: 10 }), false, 'a small step up while replies stream');
  assert.equal(followAfterUserScroll({ prevTop: 1000, top: 1000, dist: 0 }), true);
  assert.equal(followAfterUserScroll({ prevTop: 900, top: 960, dist: STICK_THRESHOLD_PX - 1 }), true, 'down into the threshold');
  assert.equal(followAfterUserScroll({ prevTop: 900, top: 920, dist: STICK_THRESHOLD_PX + 40 }), false);
  assert.equal(followAfterUserScroll({ prevTop: Number.NaN, top: 0, dist: 0 }), true, 'nothing to scroll');
});

test('what counts as Pat: a held pointer, a routed smooth scroll, and a grace period after input', () => {
  const c = clock();
  const keeper = createPlaceKeeper({ now: c.now });
  assert.equal(keeper.isUser(), false);
  keeper.hold(true);
  c.t += 60_000;
  assert.equal(keeper.isUser(), true, 'dragging the scrollbar or selecting text');
  keeper.hold(false);
  c.t += USER_SCROLL_GRACE_MS - 1;
  assert.equal(keeper.isUser(), true, 'the smooth scroll after release');
  c.t += 2;
  assert.equal(keeper.isUser(), false);
  keeper.smoothing(true);
  c.t += 10_000;
  assert.equal(keeper.isUser(), true, 'a routed wheel still animating');
  keeper.smoothing(false);
  c.t += USER_SCROLL_GRACE_MS + 1;
  assert.equal(keeper.isUser(), false);
});

test('a message that left a loaded window turns the window to following; one still loading is waited for', () => {
  const reading = { follow: false, key: 'gone', offset: -20 };
  const loading = restoreTarget({ place: reading, scrollTop: 0, scrollHeight: 0, clientHeight: 300, anchorTop: null, hasBlocks: false });
  assert.deepEqual(loading, { top: null, place: reading });
  const trimmed = restoreTarget({ place: reading, scrollTop: 100, scrollHeight: 2000, clientHeight: 300, anchorTop: null, hasBlocks: true });
  assert.deepEqual(trimmed, { top: 1700, place: FOLLOW });
  const there = restoreTarget({ place: reading, scrollTop: 500, scrollHeight: 2000, clientHeight: 300, anchorTop: -20.4, hasBlocks: true });
  assert.equal(there.top, null, 'already within a pixel');
});

test('firstVisibleIndex finds the first row ending below the edge, same as a linear scan', () => {
  const bottoms = [10, 40, 90, 91, 200, 260, 400];
  for (const edge of [-5, 0, 9, 10, 40, 89, 90, 150, 399, 1000]) {
    const linear = bottoms.findIndex((b) => b > edge + 1);
    const expected = linear === -1 ? bottoms.length - 1 : linear;
    assert.equal(firstVisibleIndex(bottoms.length, (i) => bottoms[i], edge), expected, `edge ${edge}`);
  }
  assert.equal(firstVisibleIndex(0, () => 0, 0), -1);
});

test('wheel distance in pixels for each delta mode', () => {
  assert.equal(wheelPixels({ deltaY: -100, deltaMode: 0 }, 500), -100);
  assert.equal(wheelPixels({ deltaY: 3, deltaMode: 1 }, 500), 120);
  assert.equal(wheelPixels({ deltaY: -1, deltaMode: 2 }, 500), -500);
  assert.equal(wheelPixels({}, 500), 0);
});

test('the wheel stays with anything that scrolls itself: a long draft, a menu', () => {
  const boundary = { parentElement: null };
  const node = (props, parent = boundary) => ({ parentElement: parent, scrollTop: 0, scrollHeight: 0, clientHeight: 0, ...props });
  const styles = new Map();
  const styleOf = (el) => styles.get(el) || { overflowY: 'visible' };
  const draft = node({ scrollTop: 40, scrollHeight: 300, clientHeight: 100 });
  const word = node({}, draft);
  styles.set(draft, { overflowY: 'auto', overscrollBehaviorY: 'auto' });
  assert.equal(scrollsWithin(word, boundary, -100, styleOf), true, 'room to go up');
  assert.equal(scrollsWithin(word, boundary, 100, styleOf), true, 'room to go down');
  draft.scrollTop = 200;
  assert.equal(scrollsWithin(word, boundary, 100, styleOf), false, 'at its end: the wheel goes to the conversation');
  const menu = node({ scrollTop: 0, scrollHeight: 400, clientHeight: 200 });
  styles.set(menu, { overflowY: 'auto', overscrollBehaviorY: 'contain' });
  assert.equal(scrollsWithin(node({}, menu), boundary, -100, styleOf), true, 'a contained menu keeps it even at its end');
  const plain = node({}, node({}));
  assert.equal(scrollsWithin(plain, boundary, 100, styleOf), false, 'the command bar itself does not scroll');
});

test('remembered places are per session, refreshed on use, and capped', () => {
  const memory = createPlaceMemory(3);
  memory.set('a', { follow: false, key: 'k1', offset: 0 });
  memory.set('b', FOLLOW);
  memory.set('c', FOLLOW);
  memory.set('a', { follow: false, key: 'k2', offset: 4 });
  memory.set('d', FOLLOW);
  assert.equal(memory.size, 3);
  assert.equal(memory.get('b'), null, 'the oldest went');
  assert.equal(memory.get('a').key, 'k2', 'a was refreshed, so it stayed');
  assert.equal(memory.get(null), null);
});
