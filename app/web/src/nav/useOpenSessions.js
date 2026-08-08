import { useCallback, useEffect, useState } from 'react';

const STORAGE_ACTIVE = 'harbor-web-active';

export function useOpenSessions() {
  const [activeId, setActiveId] = useState(() => localStorage.getItem(STORAGE_ACTIVE) || null);

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
    openIds: activeId ? [activeId] : [],
    activeId,
    openSession,
    setActive,
  };
}
