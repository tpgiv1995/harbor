'use strict';

const WORKING_FRESH_MS = 3 * 60 * 1000;
const TERMINAL_STOPS = new Set(['end_turn', 'stop_sequence', 'refusal', 'max_tokens']);
function turnSignal(row) {
  if (!row || row.isSidechain || row.isMeta) return null;
  if (row.type === 'system') return row.subtype === 'turn_duration' || row.subtype === 'api_error'
    || ['warning', 'error'].includes(row.level) ? 'idle' : null;
  if (row.type === 'assistant') return row.isApiErrorMessage || TERMINAL_STOPS.has(row.message?.stop_reason) ? 'idle' : 'working';
  if (row.type !== 'user') return null;
  const content = row.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n') : '';
  if (row.isCompactSummary || /^\s*(?:This session is being continued from a previous conversation|<local-command-stdout>|\[Request interrupted by user(?: for tool use)?\])/.test(text)) return 'idle';
  return text.trim() || Array.isArray(content) && content.some((p) => p.type === 'image' || p.type === 'tool_result') ? 'working' : null;
}
// Fold evidence expires even while a process lives. Notifications cannot
// refresh this clock; only a real in-turn transcript signal can do that.
function freshWorking(background, now = Date.now()) {
  return Boolean(background?.working && background.lastInTurnMs && now - background.lastInTurnMs < WORKING_FRESH_MS);
}
module.exports = { WORKING_FRESH_MS, TERMINAL_STOPS, turnSignal, freshWorking };
