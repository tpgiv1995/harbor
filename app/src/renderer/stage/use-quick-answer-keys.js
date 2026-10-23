import { useEffect, useRef } from 'react';
import { canQuickAnswer } from '../../shared/session-run-state.cjs';
import { QUICK_ANSWER_EVENT, quickAnswerDecision } from './quick-answer-keys.cjs';

// Cmd/Ctrl+Shift+Y / N for the SELECTED window's permission prompt. The
// listener is registered once and reads the selection through a ref, so its
// closure holds only this hook's scope, never an App render (use-callback.js).
// It does not answer anything itself: it asks that window header's QuickAnswer
// to press its own button.
export function useQuickAnswerKeys(session, pane) {
  const selected = useRef(null);
  selected.current = { session, pane };
  useEffect(() => {
    const onKey = (event) => {
      const decision = quickAnswerDecision(event);
      if (!decision) return;
      const { session: current, pane: currentPane } = selected.current || {};
      if (!canQuickAnswer(current, currentPane)) return;
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent(QUICK_ANSWER_EVENT, { detail: { sessionId: current.id, decision } }));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
