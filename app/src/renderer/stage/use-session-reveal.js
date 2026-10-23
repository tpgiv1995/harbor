import { useEffect, useRef } from 'react';

// A clicked notification (main/notify.js -> session:reveal): main has already
// brought Harbor forward, and this opens the window the toast was about, or
// selects it when it is already on the stage. Registered once and reading the
// latest sessions through a ref, so the listener holds no App render
// (use-callback.js).
export function useSessionReveal(sessions, openSession) {
  const latest = useRef(null);
  latest.current = { sessions, openSession };
  useEffect(() => window.harbor?.session?.onReveal?.(({ sessionId } = {}) => {
    const { sessions: byId, openSession: open } = latest.current || {};
    const session = sessionId ? byId?.get?.(sessionId) : null;
    if (session) open?.(session);
  }), []);
}
