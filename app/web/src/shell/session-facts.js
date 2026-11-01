import turnMeta from '../../../src/renderer/stage/turn-meta.cjs';

// The pure half of the phone header's session facts (SessionMeta.jsx renders
// them). Plain JS so the node tests import it without a JSX transform.

const { formatDuration } = turnMeta;

export function formatContextTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return `${Math.max(1, Math.round(tokens / 1000))}k`;
}

// A percentage only from Claude's own math; tokens alone otherwise; nothing
// when neither is known (the 2026-07-21 rule: Harbor never invents a denominator).
export function contextFact(header, providerLabel = 'Claude') {
  const pct = header?.contextPct;
  if (typeof pct === 'number') return { kind: 'pct', pct, label: `${pct}%`, warn: pct >= 70, title: `${pct}% of the context window used` };
  const tokens = header?.contextTokens;
  if (typeof tokens === 'number' && tokens > 0) return { kind: 'tokens', label: formatContextTokens(tokens), title: `${tokens.toLocaleString()} tokens in context; ${providerLabel} has not reported the window size yet` };
  return null;
}

export function statusFact({ session, header, meter, now = Date.now() }) {
  // A header painted from the phone's cache is what was true when the app was
  // last connected; say so rather than claim the session is working now.
  if (header?.stale) {
    if (header.blocked) return { kind: 'stale', label: 'Last seen waiting on you' };
    if (header.working) return { kind: 'stale', label: 'Last seen working' };
  }
  if (session?.agentStatus === 'blocked' || header?.blocked || session?.needsAnswer) return { kind: 'blocked', label: 'Waiting on you' };
  if (header?.working || session?.agentStatus === 'working') return { kind: 'working', label: meter ? `Working ${meter}` : 'Working' };
  const last = header?.lastWriteMs || session?.lastActiveMs || null;
  const ago = last ? formatDuration(Math.max(0, now - last)) : null;
  if (!session?.isLive && !session?.paneId) return { kind: 'off', label: ago ? `Not running, last active ${ago} ago` : 'Not running' };
  return { kind: 'idle', label: ago ? `Idle ${ago}` : 'Idle' };
}
