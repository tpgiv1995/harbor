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

// A queued message's state, under its bubble (2026-11-01, Pat: messages
// "sticking in the queue" were visible only in the terminal). The parser marks
// each queued bubble 'waiting' until Claude's own dequeue/remove record, then
// 'delivered' with the time it was taken (transcript.js, queue-operation).
// Waiting says so; a delivery that took 10 s or more says how long; a quick one
// says nothing. Blocks from before this change carry no state and show nothing.
const QUEUE_WAIT_WORTH_SHOWING_MS = 10_000;
function queueStateLabel(block) {
  if (!block?.queued || !block.queueState) return null;
  if (block.queueState === 'waiting') return 'Waiting in Claude\'s queue: it reads this at its next step';
  const waited = Date.parse(block.deliveredTs) - Date.parse(block.ts);
  if (!Number.isFinite(waited) || waited < QUEUE_WAIT_WORTH_SHOWING_MS) return null;
  return `Waited ${formatDuration(waited)} in Claude's queue`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// The window header's count of what still waits, with who sent it.
function queueChip(queue, { formatTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) } = {}) {
  const waiting = Number(queue?.waiting) || 0;
  if (waiting <= 0) return null;
  const from = queue.from || {};
  const parts = [];
  if (from.you) parts.push(`${from.you} from you`);
  if (from.peer) parts.push(`${from.peer} from other sessions`);
  if (from.task) parts.push(`${plural(from.task, 'background result', 'background results')}`);
  const oldest = Date.parse(queue.oldestTs);
  const since = Number.isFinite(oldest) ? ` The oldest was sent at ${formatTime(oldest)}.` : '';
  return {
    label: `${waiting} queued`,
    title: `${plural(waiting, 'message waits', 'messages wait')} for Claude's next step${parts.length ? ` (${parts.join(', ')})` : ''}. Claude reads its queue between tool calls, so a long step holds them.${since}`,
  };
}

// What the command bar says while typed messages wait in Claude's queue
// (2026-11-02, Pat: "i dont have a way to send messages now that are queued").
// Claude reads its queue only between steps, so a long step (three sub-agents,
// eight minutes) holds them. Measured on 2.1.316 in a throwaway session: Esc,
// which is the bar's Stop button, ends the current step and Claude takes the
// queued message at once (answered in 3 s); Enter on an empty box does nothing.
// Background results count in the header chip but not here: Stop is for Pat's
// own messages and other sessions' messages.
function queueSendNowHint(queue) {
  const from = queue?.from || {};
  const n = (Number(from.you) || 0) + (Number(from.peer) || 0);
  if (n <= 0) return null;
  return {
    status: `${plural(n, 'message waits', 'messages wait')} in Claude's queue. Stop sends ${n === 1 ? 'it' : 'them'} now`,
    stopTitle: `Stop Claude's current step so it reads your ${plural(n, 'queued message', 'queued messages')} now (Esc)`,
  };
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

// What a sub-agent behind a "Delegated" row is doing (transcript.js
// readSubagentProgress): "12 tools so far · Searching for X" while it runs,
// "No activity for 15+ min · 12 tools so far" while it is quiet but not
// finished (silence is not death), "Used 12 tools" once it has finished, and
// nothing when nothing is known. "12+" when a stretch was too large to read.
function subagentLabel(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const n = Number.isFinite(sub.tools) ? sub.tools : null;
  const count = (k) => `${k}${sub.partial ? '+' : ''} tool${k === 1 && !sub.partial ? '' : 's'}`;
  // A history too large to read and nothing counted since: say so, never "Starting".
  if (sub.partial && !n) return sub.running ? 'Working (its earlier steps were too many to count)' : sub.quiet ? 'No activity for 15+ min (its earlier steps were too many to count)' : 'Done (its steps were too many to count)';
  if (sub.running) {
    if (!n) return sub.now ? `Starting · ${sub.now}` : 'Starting';
    return `${count(n)} so far${sub.now ? ` · ${sub.now}` : ''}`;
  }
  if (sub.quiet) return `No activity for 15+ min${n ? ` · ${count(n)} so far` : ''}`;
  return n ? `Used ${count(n)}` : null;
}

module.exports = { formatTokens, formatDuration, turnMetaLabel, parseTokenCount, liveMeterLabel, queueStateLabel, queueChip, queueSendNowHint, subagentLabel };
