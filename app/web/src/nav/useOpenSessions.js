import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_ACTIVE = 'harbor-web-active';

export function useOpenSessions() {
  const [activeId, setActiveId] = useState(() => localStorage.getItem(STORAGE_ACTIVE) || null);
  // The voice transcript subscription depends on this array. A new array per
  // render closes and reopens the same transcript, whose replacement push
  // renders the composer again. Keep the subscription tied to the session ID.
  const openIds = useMemo(() => activeId ? [activeId] : [], [activeId]);

  useEffect(() => {
    try {
      if (activeId) localStorage.setItem(STORAGE_ACTIVE, activeId);
      else localStorage.removeItem(STORAGE_ACTIVE);
    } catch { /* ignore */ }
  }, [activeId]);

  const openSession = useCallback((sessionId) => {
    if (!sessionId) return;
    setActiveId(sessionId);
  }, []);

  const setActive = useCallback((sessionId) => {
    if (!sessionId) return;
    setActiveId(sessionId);
  }, []);

  return {
    // Compatibility for live voice: the only open transcript is the active
    // conversation, never a retained stack of session windows.
    openIds,
    activeId,
    openSession,
    setActive,
  };
}
