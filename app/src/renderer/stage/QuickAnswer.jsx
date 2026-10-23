import React, { useEffect, useRef, useState } from 'react';
import { quickAllowOffered } from '../../shared/session-run-state.cjs';
import { QUICK_ANSWER_EVENT, quickAnswerKeys } from './quick-answer-keys.cjs';

const KEYS = quickAnswerKeys(typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent || '');

// One-click Allow / Deny for a permission prompt the CLI itself reported (OSC
// 7501 blocked/permission), on the window header beside the run-state chip and
// on the rail row. It goes through the same verified answer path as the
// window's AskCard (session:menu-answer): main re-reads the pane, answers only a
// dialog it recognises as a permission prompt, picks only the one-time "Yes",
// and Deny is Esc. Every click names the prompt it was shown for (`expect`, the
// CLI's words, and `expectSeq`, the keeper's per-change sequence), and main
// refuses it when the pane reports anything else by then, so a stale button can
// never approve a request nobody saw. Anything else (a "don't ask again"
// choice, feedback, notes) stays on the window's own card.
export function QuickAnswer({ pane, sessionId, expect, expectSeq = null, className = '', listenKeys = false }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const busyRef = useRef(null);
  const allowOffered = quickAllowOffered(expect);
  // A new prompt clears the last one's error.
  useEffect(() => { setError(null); }, [expect, expectSeq]);
  const answer = async (decision, event) => {
    event?.stopPropagation?.();
    if (busyRef.current) return;
    if (decision === 'allow' && !allowOffered) return;
    busyRef.current = decision;
    setBusy(decision);
    setError(null);
    try {
      const res = await window.harbor.session.answerMenu({
        pane, sessionId, action: { type: 'permission-quick', decision, expect, expectSeq: expectSeq ?? null },
      });
      if (!res?.ok) setError(res?.reason || 'that answer did not land');
    } catch (e) {
      setError(e?.message || 'that answer did not land');
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };
  // The selected window's keyboard shortcut (use-quick-answer-keys.js) presses
  // these buttons, so the shortcut and a click share one path and one error.
  const answerRef = useRef(answer);
  answerRef.current = answer;
  useEffect(() => {
    if (!listenKeys) return undefined;
    const onAnswer = (event) => {
      if (event.detail?.sessionId === sessionId) answerRef.current(event.detail.decision);
    };
    window.addEventListener(QUICK_ANSWER_EVENT, onAnswer);
    return () => window.removeEventListener(QUICK_ANSWER_EVENT, onAnswer);
  }, [listenKeys, sessionId]);
  const hint = (which) => (listenKeys ? ` (${KEYS[which]})` : '');
  return (
    <span className={`quick-answer${className ? ` ${className}` : ''}`} role="group" aria-label="Answer the permission prompt" title={error || undefined}>
      {allowOffered ? (
        <button
          type="button"
          className="qa-btn qa-allow"
          disabled={Boolean(busy)}
          title={`Allow once: ${expect}${hint('allow')}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => answer('allow', e)}
        >
          {busy === 'allow' ? '…' : 'Allow'}
        </button>
      ) : null}
      <button
        type="button"
        className="qa-btn qa-deny"
        disabled={Boolean(busy)}
        title={`Deny (Esc): ${expect}${hint('deny')}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => answer('deny', e)}
      >
        {busy === 'deny' ? '…' : 'Deny'}
      </button>
      {error ? <span className="qa-error" role="alert" title={error}>{error}</span> : null}
    </span>
  );
}
