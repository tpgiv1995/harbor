import React, { useEffect, useRef, useState } from 'react';
import { copyText } from './md.jsx';

// The one-click "Copy session id" control (Pat uses it constantly). The window
// header and every team chart card render THIS component, so the label, the
// tick, its timing and the accessible name cannot drift apart. `copyText`
// reports whether the copy landed (navigator.clipboard fails silently over
// file://), so the tick only shows on a real copy.
export function canCopySessionId(id) {
  const text = String(id || '');
  return Boolean(text) && !text.startsWith('pane:') && !text.startsWith('live:') && !text.startsWith('launch:') && !text.startsWith('proc:');
}

export function CopySessionId({ sessionId, className = '' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!canCopySessionId(sessionId)) return null;
  return (
    <button
      type="button"
      className={`ico tile-id${copied ? ' ok' : ''}${className ? ` ${className}` : ''}`}
      title={copied ? 'Session id copied' : 'Copy this session’s id'}
      aria-label="Copy session id"
      onClick={async (event) => {
        event.stopPropagation();
        if (await copyText(sessionId)) {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        }
      }}
    >
      {copied ? '✓' : 'id'}
    </button>
  );
}
