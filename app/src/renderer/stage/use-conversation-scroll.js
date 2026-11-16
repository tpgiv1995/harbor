import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import conversationScroll from './conversation-scroll.cjs';

// Keeps one conversation window where Pat left it: FOLLOWING the latest
// message, or READING a message above it. The rules and the incident behind
// them are in conversation-scroll.cjs (createPlaceKeeper, restoreTarget); this
// hook only reads and sets the page. Only Pat's own input (wheel, pointer,
// keys, a send, the routed wheel and PageUp/PageDown) changes the place; every
// other scroll movement and every layout change puts the window back on it.
//
// Cost per open window: one ResizeObserver over the window and its content
// (one already existed), passive wheel, pointerdown, scroll and scrollend
// listeners on the window, and a binary search of the window's top-level rows
// (about ten rect reads) on scroll events that follow Pat's input. Shared by
// all windows: one keydown, focus, resize and follow listener on `window`.

const {
  SCROLL_KEYS,
  PAGE_FRACTION,
  FOLLOW,
  createPlaceKeeper,
  restoreTarget,
  firstVisibleIndex,
  createPlaceMemory,
} = conversationScroll;

const memory = createPlaceMemory(64);
const mounted = new Set();
let lastPressed = null;
let sharedInstalled = false;
const clock = () => performance.now();

const isEditable = (el) => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));

function installShared() {
  if (sharedInstalled || typeof window === 'undefined') return;
  sharedInstalled = true;
  // The browser scrolls the box that holds focus, or the one last clicked, with
  // these keys. Typing in the composer is not scrolling, so editable focus is skipped.
  window.addEventListener('keydown', (event) => {
    if (!SCROLL_KEYS.has(event.key)) return;
    const active = document.activeElement;
    if (isEditable(active)) return;
    for (const win of mounted) {
      if (win === lastPressed || win.contains(active)) win.markIntent();
    }
  }, true);
  // Coming back to Harbor (from a minimize, another app) or resizing it: every
  // window re-applies its place, whatever the browser did meanwhile.
  const restoreAll = () => { for (const win of mounted) win.restore(); };
  window.addEventListener('focus', restoreAll);
  window.addEventListener('resize', restoreAll);
  // Pat sent something to a window (CommandBar submit): it follows again.
  window.addEventListener('harbor-conv-follow', (event) => {
    const id = event.detail?.sessionId;
    for (const win of mounted) if (id && win.sessionId() === id) win.follow();
  });
}

export function useConversationScroll({ sessionId, hasBlocks, layoutDeps = [] }) {
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const keeperRef = useRef(null);
  if (!keeperRef.current) keeperRef.current = createPlaceKeeper({ initial: memory.get(sessionId) || FOLLOW, now: clock });
  const smoothRef = useRef({ target: null, timer: 0 });
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const hasBlocksRef = useRef(hasBlocks);
  hasBlocksRef.current = hasBlocks;

  // A window that is display:none (another window has the full stage, or a
  // dense grid hides it behind a question card) has no box to read or set.
  const shown = (node) => Boolean(node && node.isConnected && node.clientHeight > 0);

  const keep = useCallback((place) => {
    keeperRef.current.set(place);
    memory.set(sessionIdRef.current, keeperRef.current.place);
  }, []);

  // The first top-level row showing at the window's top edge, and how far that
  // row starts from the edge (negative when its top is scrolled past).
  const readAnchor = useCallback(() => {
    const node = scrollRef.current;
    const body = contentRef.current;
    if (!node || !body) return null;
    const rows = body.children;
    const edge = node.getBoundingClientRect().top;
    const first = firstVisibleIndex(rows.length, (i) => rows[i].getBoundingClientRect().bottom, edge);
    for (let i = Math.max(first, 0); i < rows.length; i += 1) {
      const key = rows[i].getAttribute('data-anchor');
      if (key) return { key, offset: rows[i].getBoundingClientRect().top - edge };
    }
    return null;
  }, []);

  const restore = useCallback(() => {
    const node = scrollRef.current;
    const body = contentRef.current;
    if (!shown(node) || !body) return;
    const keeper = keeperRef.current;
    const place = keeper.place;
    let anchorTop = null;
    if (!place.follow && place.key) {
      const row = body.querySelector(`:scope > [data-anchor="${CSS.escape(place.key)}"]`);
      if (row) anchorTop = row.getBoundingClientRect().top - node.getBoundingClientRect().top;
    }
    const plan = restoreTarget({
      place,
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      anchorTop,
      hasBlocks: hasBlocksRef.current,
    });
    if (plan.place !== place) keep(plan.place);
    if (plan.top !== null) node.scrollTop = plan.top;
    keeper.noteTop(node.scrollTop);
  }, [keep]);

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!shown(node)) return;
    const top = node.scrollTop;
    const result = keeperRef.current.scrolled({ top, dist: node.scrollHeight - top - node.clientHeight, readAnchor });
    if (result === 'restore') restore();
    else memory.set(sessionIdRef.current, result);
  }, [readAnchor, restore]);

  const starting = useCallback((dy) => {
    const node = scrollRef.current;
    if (!node) return;
    const before = keeperRef.current.place;
    keeperRef.current.starting(dy, { top: node.scrollTop, readAnchor });
    if (keeperRef.current.place !== before) memory.set(sessionIdRef.current, keeperRef.current.place);
  }, [readAnchor]);

  // The wheel and PageUp/PageDown routed from elsewhere on the stage (Stage.jsx)
  // arrive as this event on the window's scroll box: Pat's own scroll.
  const scrollByUser = useCallback((detail) => {
    const node = scrollRef.current;
    if (!shown(node)) return;
    const dy = detail?.page ? Math.sign(detail.page) * Math.round(node.clientHeight * PAGE_FRACTION) : Number(detail?.by) || 0;
    if (!dy) return;
    const keeper = keeperRef.current;
    keeper.markIntent();
    starting(dy);
    const smooth = smoothRef.current;
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    // Successive notches add up instead of restarting from mid-animation.
    const target = Math.max(0, Math.min(max, (smooth.target ?? node.scrollTop) + dy));
    smooth.target = target;
    keeper.smoothing(true);
    clearTimeout(smooth.timer);
    smooth.timer = setTimeout(() => { smooth.target = null; keeper.smoothing(false); }, 1500);
    node.scrollTo({ top: target, behavior: 'smooth' });
  }, [starting]);

  const follow = useCallback(() => {
    keep(FOLLOW);
    restore();
  }, [keep, restore]);

  useEffect(() => {
    const node = scrollRef.current;
    const body = contentRef.current;
    if (!node) return undefined;
    installShared();
    const keeper = keeperRef.current;
    const win = {
      contains: (el) => Boolean(el && node.contains(el)),
      markIntent: () => keeper.markIntent(),
      restore,
      follow,
      sessionId: () => sessionIdRef.current,
    };
    mounted.add(win);
    const release = () => {
      keeper.hold(false);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    };
    const onPointerDown = () => {
      lastPressed = win;
      keeper.hold(true);
      window.addEventListener('pointerup', release, true);
      window.addEventListener('pointercancel', release, true);
    };
    const onWheel = (event) => {
      if (event.ctrlKey) return;
      keeper.markIntent();
      starting(event.deltaY);
    };
    const onRouted = (event) => scrollByUser(event.detail);
    const onScrollEnd = () => {
      const smooth = smoothRef.current;
      if (smooth.target === null) return;
      smooth.target = null;
      clearTimeout(smooth.timer);
      keeper.smoothing(false);
    };
    node.addEventListener('pointerdown', onPointerDown, { passive: true });
    node.addEventListener('wheel', onWheel, { passive: true });
    node.addEventListener('harbor-conv-scroll', onRouted);
    node.addEventListener('scrollend', onScrollEnd);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => restore());
      ro.observe(node);
      if (body) ro.observe(body);
    }
    restore();
    return () => {
      mounted.delete(win);
      if (lastPressed === win) lastPressed = null;
      release();
      clearTimeout(smoothRef.current.timer);
      smoothRef.current.target = null;
      keeper.smoothing(false);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('harbor-conv-scroll', onRouted);
      node.removeEventListener('scrollend', onScrollEnd);
      ro?.disconnect();
    };
  }, [follow, restore, scrollByUser, starting]);

  // A window whose session id changes (a provisional window becoming its real
  // session) keeps its place under the new id.
  useEffect(() => { memory.set(sessionId, keeperRef.current.place); }, [sessionId]);

  // New or changed blocks: put the window back on its place before paint.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { restore(); }, layoutDeps);

  return { scrollRef, contentRef, onScroll, onImageLoad: restore };
}

