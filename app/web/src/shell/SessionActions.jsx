import React, { useEffect, useRef, useState } from 'react';
import { canCopySessionId } from './session-actions.cjs';
import { copyText } from './copy-text.js';

// The two session buttons in the phone header (2026-10-31, Pat, from the phone:
// "the button to start a new session from an existing chat" and "a one click
// option ... to copy the session ID"). Both are the desktop window header's own
// buttons (the `+` and `id` in stage/SessionTile.jsx). They are ghost buttons,
// like the settings button beside them, so the tap area is the full 44px square
// and they inherit its look; they sit on the project line with the title on its
// own row below (shell.css).

export function NewSessionHereButton({ label, disabled, onOpen }) {
  return (
    <button
      type="button"
      className="btn-ghost hdr-act hdr-act-new"
      disabled={disabled}
      onClick={onOpen}
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d="M9.5 4H6.2A2.2 2.2 0 0 0 4 6.2v7.6A2.2 2.2 0 0 0 6.2 16h7.6a2.2 2.2 0 0 0 2.2-2.2V10.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M8 12l.5-2.6 6.6-6.6a1.5 1.5 0 0 1 2.1 2.1l-6.6 6.6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

// One tap copies the session's real id. `copyText` is called first thing in the
// handler, so on iOS Safari navigator.clipboard.writeText still runs inside the
// gesture. The check shows only for a copy that landed; a copy that did not says
// so instead of leaving the tap looking like a no-op.
export function CopySessionIdButton({ sessionId }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);
  const ready = canCopySessionId(sessionId);

  useEffect(() => {
    setState('idle');
    return () => clearTimeout(timer.current);
  }, [sessionId]);

  const copy = async () => {
    if (!ready) return;
    const landed = await copyText(String(sessionId));
    setState(landed ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), landed ? 1600 : 2400);
  };

  const label = !ready
    ? 'Session id not available yet'
    : state === 'copied' ? 'Session id copied' : state === 'failed' ? 'Could not copy the session id' : 'Copy session id';
  // What a screen reader hears when the tap lands or fails: the button's own label
  // changes, but a changed label is not announced. A polite live region that is
  // always in the page is (2026-10-31 review).
  const announcement = state === 'copied' ? 'Session id copied' : state === 'failed' ? 'Could not copy the session id' : '';
  return (
    <>
    <button
      type="button"
      className={`btn-ghost hdr-act hdr-act-id${state === 'copied' ? ' is-copied' : ''}${state === 'failed' ? ' is-failed' : ''}`}
      disabled={!ready}
      onClick={copy}
      aria-label={label}
      title={label}
      data-copy-state={state}
    >
      {state === 'copied' ? (
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path d="M4.5 10.5l3.7 3.7 7.3-8.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : state === 'failed' ? (
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <span className="hdr-act-id-text" aria-hidden="true">id</span>
      )}
    </button>
    <span className="hdr-live" role="status" aria-live="polite">{announcement}</span>
    </>
  );
}
