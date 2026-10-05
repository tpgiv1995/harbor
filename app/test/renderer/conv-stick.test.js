'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const STICK_THRESHOLD_PX = 56;

function distFromBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight;
}

function makeScroller({ clientHeight = 400, scrollHeight = 1000, scrollTop = 600 } = {}) {
  const state = { clientHeight, scrollHeight, scrollTop };
  const listeners = new Set();
  return {
    state,
    get clientHeight() { return state.clientHeight; },
    get scrollHeight() { return state.scrollHeight; },
    get scrollTop() { return state.scrollTop; },
    set scrollTop(v) {
      const max = Math.max(0, state.scrollHeight - state.clientHeight);
      state.scrollTop = Math.min(v, max);
      for (const fn of listeners) fn();
    },
    onScroll(fn) { listeners.add(fn); },
  };
}

function makeStickController({ guardProgrammatic = true } = {}) {
  const stickRef = { current: true };
  const programmaticScrollRef = { current: false };

  const scrollToTail = (node) => {
    if (!node || !stickRef.current) return;
    if (guardProgrammatic) programmaticScrollRef.current = true;
    stickRef.current = true;
    node.scrollTop = node.scrollHeight;
    if (guardProgrammatic) programmaticScrollRef.current = false;
  };

  const onScroll = (node) => {
    if (guardProgrammatic && programmaticScrollRef.current) return;
    stickRef.current = distFromBottom(node) < STICK_THRESHOLD_PX;
  };

  return { stickRef, programmaticScrollRef, scrollToTail, onScroll };
}

test('programmatic scrollToTail ignores its own onScroll when content jumps in the same tick', () => {
  const node = makeScroller({ clientHeight: 400, scrollHeight: 1200, scrollTop: 800 });
  const buggy = makeStickController({ guardProgrammatic: false });
  const fixed = makeStickController({ guardProgrammatic: true });

  const buggyScroll = () => {
    buggy.stickRef.current = true;
    node.scrollTop = node.scrollHeight;
    node.state.scrollHeight += 150;
    buggy.onScroll(node);
  };
  const fixedScroll = () => {
    fixed.programmaticScrollRef.current = true;
    fixed.stickRef.current = true;
    node.scrollTop = node.scrollHeight;
    node.state.scrollHeight += 150;
    fixed.onScroll(node);
    fixed.programmaticScrollRef.current = false;
  };

  buggyScroll();
  assert.equal(buggy.stickRef.current, false, 'unguarded programmatic scroll can disengage');

  node.state.scrollHeight = 1200;
  node.state.scrollTop = 800;
  fixedScroll();
  assert.equal(fixed.stickRef.current, true, 'guarded programmatic scroll stays engaged');
});

test('user scroll up disengages stick; returning near bottom re-engages and follows growth', () => {
  const node = makeScroller({ clientHeight: 400, scrollHeight: 1200, scrollTop: 800 });
  const { stickRef, scrollToTail, onScroll } = makeStickController();
  node.onScroll(() => onScroll(node));

  scrollToTail(node);
  assert.equal(stickRef.current, true);

  node.scrollTop = 0;
  assert.equal(stickRef.current, false);

  scrollToTail(node);
  assert.equal(node.scrollTop, 0, 'scroll-up reader is not forced back down');

  node.scrollTop = node.scrollHeight - 20;
  onScroll(node);
  assert.equal(stickRef.current, true);

  scrollToTail(node);
  assert.equal(node.scrollTop, node.scrollHeight - node.clientHeight);
});
