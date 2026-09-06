// useCallback without the closure-context chain (2026-09-06 renderer OOM).
//
// V8 gives every invocation of a function ONE context object holding every
// variable any inner closure captures. In a component the size of the root App
// that is the whole render: the sidebar model, its sessions-by-id Map, the
// transcripts Map, the tiles. React's useCallback keeps the closure from the
// render where its deps last changed, and that closure keeps its render's
// context, and THAT context's slots hold the other memoized callbacks current
// at the time, from renders older still. With dozens of memoized callbacks
// whose deps change at different moments, the chain runs back to boot: every
// render context since launch stays reachable, each with its own copy of the
// sidebar model (main publishes a fresh one ~2/sec under live sessions). The
// heap snapshot that named it held ~2000 such copies, 1.7GB, and the renderer
// died at the 3.5GB V8 ceiling (0xE0000008) every 3-4 hours.
//
// This hook keeps useCallback's contract - the returned function's identity
// changes exactly when `deps` change, so effects and memos keyed on it re-run
// on the same cadence - but the memoized function is a trampoline whose own
// context holds only a ref. The ref always points at the CURRENT render's
// closure, so no render's context outlives the next render. Calls go to the
// latest closure rather than the one from the render where deps last changed;
// with exhaustive deps those are the same values, and where they are not, the
// latest is the one a stale closure would have wanted anyway.
//
// Proof: scripts/drive-render-leak-win.js pushes hundreds of fresh models
// through the real App and reads the heap over CDP after a forced GC. At
// pre-fix HEAD it retains one model per push (1648KB measured); with the root
// App on this hook it must stay flat. Import THIS in any component that
// captures a heavy per-render value, never useCallback from 'react'.

import { useMemo, useRef } from 'react';

export function useCallback(fn, deps) {
  const latest = useRef(fn);
  latest.current = fn;
  // The factory is created each render but never retained: useMemo keeps only
  // its result. The trampoline's context is this hook's scope, which holds
  // `latest` and nothing else.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (...args) => latest.current(...args), deps);
}
