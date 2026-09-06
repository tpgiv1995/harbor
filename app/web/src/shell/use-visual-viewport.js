import { useEffect, useRef, useState } from 'react';

/**
 * Tracks the rectangle iOS says is visible. No keyboard state is inferred:
 * standalone Safari may resize both viewports, so their height delta is not a
 * keyboard signal.
 */
export function useVisualViewport() {
  const [viewport, setViewport] = useState(() => readViewport());
  // The last rectangle actually published. Kept in a ref rather than read back
  // out of state inside the updater, because a state updater must stay pure:
  // React may invoke it more than once for one dispatch, so deciding "did this
  // change" by a flag set inside it is not something that holds.
  const publishedRef = useRef(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;

    // AN EVENT IS NOT A CHANGE (live-caught on Pat's phone, 2026-08-08).
    // `readViewport()` builds a FRESH OBJECT every time, so `setViewport` used
    // to change state identity on every `scroll` and `resize` the visual
    // viewport fires, even when all four numbers were byte-identical. iOS
    // fires those continuously while the keyboard is up and while a list has
    // momentum, at the display's refresh rate.
    //
    // That alone would only be wasted renders. What made it an outage is what
    // sits downstream: a re-render of AppShell rebuilds SessionScreen's `pane`
    // object, AskCard's poll effect is keyed on it, and re-running that effect
    // fires an IMMEDIATE `session:menu-state` RPC. So one scroll event cost
    // exactly one RPC, measured 40-for-40 against the real client. On a 120Hz
    // phone that is ~110 RPC/s: the server's per-client queue (256 items)
    // overflows in about two seconds, it closes the socket 1013, the client
    // reconnects four seconds later and does it again. Pat's phone flapped
    // every 60-115 seconds for as long as he held the app open, and every
    // in-flight send died with the socket.
    //
    // So the rectangle is compared before it is published. The downstream
    // amplifiers are each fixed at their own layer too (a stable `pane`, an
    // effect keyed on primitives), because any one of the three left standing
    // rebuilds the storm from a different re-render source; this is the one
    // that stops the events at the source.
    const same = (a, b) => a.height === b.height && a.width === b.width
      && a.offsetTop === b.offsetTop && a.offsetLeft === b.offsetLeft;

    const update = () => {
      const next = readViewport();
      if (publishedRef.current && same(publishedRef.current, next)) return;
      publishedRef.current = next;
      setViewport(next);
      // The CSS custom properties and the scroll-to-bottom are written only
      // when the rectangle actually moved. Writing them on every event is what
      // let `applyViewportCss`'s own rAF scroll provoke the next visualViewport
      // event and keep the cycle fed.
      applyViewportCss(next);
    };
    // The first call always publishes (publishedRef starts null), so the CSS
    // custom properties are written on mount exactly as before.
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      clearViewportCss();
      // Cleared with the CSS it gated. Left set, a remount (StrictMode's
      // double-invoke is the everyday case) would compare equal on its first
      // event and never re-write the custom properties this teardown just
      // removed, leaving the shell sized by nothing.
      publishedRef.current = null;
    };
  }, []);

  return viewport;
}

function readViewport() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  return {
    height: vv?.height ?? window.innerHeight,
    offsetTop: vv?.offsetTop ?? 0,
    offsetLeft: vv?.offsetLeft ?? 0,
    width: vv?.width ?? window.innerWidth,
  };
}

/** Write visual-viewport dimensions to :root so the shell can shrink with the keyboard. */
function applyViewportCss(viewport) {
  const root = document.documentElement;
  const { body } = document;
  root.style.setProperty('--app-h', `${viewport.height}px`);
  root.style.setProperty('--app-offset-top', `${viewport.offsetTop}px`);
  root.style.setProperty('--app-offset-left', `${viewport.offsetLeft}px`);
  root.style.setProperty('--app-w', `${viewport.width}px`);
  root.style.overflow = 'hidden';
  if (body) body.style.overflow = 'hidden';
  const mount = document.getElementById('root');
  if (mount) mount.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    const conv = document.querySelector('.conv');
    if (conv) conv.scrollTop = conv.scrollHeight;
  });
}

function clearViewportCss() {
  const root = document.documentElement;
  const { body } = document;
  root.style.removeProperty('--app-h');
  root.style.removeProperty('--app-offset-top');
  root.style.removeProperty('--app-offset-left');
  root.style.removeProperty('--app-w');
  root.style.overflow = '';
  if (body) {
    body.style.overflow = '';
  }
  const mount = document.getElementById('root');
  if (mount) {
    mount.style.overflow = '';
  }
}
