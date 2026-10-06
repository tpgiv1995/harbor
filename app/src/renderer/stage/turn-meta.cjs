'use strict';

// Per-task token readouts (2026-10-05). The numbers come from the transcript's
// own usage records (main/providers/transcript.js noteTurnUsage); this only
// formats them the way Claude's working line does ("↓ 2.4k tokens").

function formatTokens(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// "↓ 4.2k tokens · 38s", or null when there is nothing worth showing.
function turnMetaLabel(meta) {
  const tokens = formatTokens(meta?.outputTokens);
  if (!tokens || meta.outputTokens <= 0) return null;
  const time = formatDuration(meta.durationMs);
  return time ? `↓ ${tokens} tokens · ${time}` : `↓ ${tokens} tokens`;
}

// "↓ 2.4k" (the CLI's own spelling) back to 2400, or null.
function parseTokenCount(text) {
  const match = /([\d.,]+)\s*([kKmM]?)/.exec(String(text || ''));
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const scale = { k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[match[2]] || 1;
  return Math.round(n * scale);
}

// The header's live chip: elapsed since the task's prompt, ticking locally,
// and the larger of the CLI's last-seen count and the transcript's running
// total. Both halves have gaps on their own: the CLI hides its working line
// while prose streams, and the transcript only lands a reply once a content
// block completes. Together they read steadily.
function liveMeterLabel({ startMs = null, now = Date.now(), cliTokens = null, turnTokens = null, cliElapsed = null } = {}) {
  const elapsed = Number.isFinite(startMs) && now >= startMs ? formatDuration(now - startMs) : cliElapsed;
  const best = Math.max(Number.isFinite(cliTokens) ? cliTokens : 0, Number.isFinite(turnTokens) ? turnTokens : 0);
  const tokens = best > 0 ? `↓ ${formatTokens(best)}` : null;
  const label = [elapsed, tokens].filter(Boolean).join(' · ');
  return label || null;
}

module.exports = { formatTokens, formatDuration, turnMetaLabel, parseTokenCount, liveMeterLabel };
