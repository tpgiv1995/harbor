'use strict';

// What one agent is doing, folded from the transcript lines appended since the
// last read (2026-11-02, the team chart). Claude transcripts and Codex rollouts
// fold into the same shape: model and effort actually used, whether a turn is
// running, the tool calls still open (a tool_use id stays open until its
// tool_result), the last few actions with times, the latest request and the
// latest thing the agent said. Turn boundaries reuse shared/claude-turn-state
// so the chart, the rail and the Orch liveness agree on "working".
//
// Lines can be enormous (a tool result can be megabytes), so a user line that
// only carries tool results is read with a regex for its ids, never parsed.

const { turnSignal } = require('../../shared/claude-turn-state.cjs');
// One rule for what a person typed: the conversation window's own. It drops
// background-task notices, system reminders, local command output and the
// rest of the harness plumbing that arrives as a user-role record.
const { userTextFor, isCompactContinuation } = require('./transcript.js');

const MAX_ACTIONS = 5;
const CLIP_PROMPT = 600;
const CLIP_TEXT = 600;
const HUGE_LINE = 256 * 1024;

function createFold() {
  return {
    model: null, effort: null, working: false,
    turnStartedMs: null, turnEndedMs: null, lastInTurnMs: null, lastEventMs: null,
    open: {}, actions: [], lastPrompt: null, lastText: null,
    turnsEnded: 0, stepsEnded: 0,
  };
}

function clip(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function baseName(value) { return String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || ''; }

// A short, readable account of one tool call: the command, the file, the
// pattern or the helper's task. Never the whole input.
function actionSummary(name, input) {
  const value = input && typeof input === 'object' ? input : {};
  if (/^(Bash|PowerShell|exec_command|shell|local_shell)$/i.test(name)) return clip(value.command || value.cmd || '', 90);
  if (/^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return baseName(value.file_path || value.notebook_path || '');
  if (/^(Grep|Glob)$/.test(name)) return clip(value.pattern || '', 60);
  if (/^(Agent|Task)$/.test(name)) return clip(value.description || value.prompt || '', 80);
  if (/^(WebFetch|WebSearch)$/.test(name)) return clip(value.url || value.query || '', 80);
  if (/^Skill$/.test(name)) return clip(value.skill || '', 40);
  if (typeof input === 'string') {
    const cmd = /cmd\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input) || /"command"\s*:\s*(?:\[\s*)?"((?:[^"\\]|\\.)*)"/.exec(input);
    if (cmd) return clip(cmd[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"'), 90);
    return clip(input, 90);
  }
  const first = Object.values(value).find((item) => typeof item === 'string');
  return clip(first || '', 60);
}

function pushAction(fold, action) {
  fold.actions.push(action);
  if (fold.actions.length > MAX_ACTIONS) fold.actions.splice(0, fold.actions.length - MAX_ACTIONS);
}

function stamp(fold, ms) {
  if (Number.isFinite(ms) && ms > (fold.lastEventMs || 0)) fold.lastEventMs = ms;
}

function endTurn(fold, ms) {
  if (fold.working) fold.turnsEnded += 1;
  fold.working = false;
  fold.turnEndedMs = ms || fold.turnEndedMs;
  fold.open = {};
}

function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('\n');
}

// Slash commands, local command output, hook chatter and compaction preambles
// are not requests a person made.
function isRealPrompt(text) {
  const value = String(text || '').trimStart();
  if (!value) return false;
  return !/^(<command-name>|<command-message>|<local-command|<bash-|<user-prompt-submit-hook>|Caveat: |This session is being continued|\[Request interrupted)/.test(value);
}

// Cheap path for a huge line: only the ids and the time matter.
function applyHugeClaudeLine(fold, line) {
  const ts = /"timestamp":"([^"]+)"/.exec(line);
  const ms = ts ? Date.parse(ts[1]) : NaN;
  stamp(fold, ms);
  if (line.includes('"tool_result"')) {
    for (const match of line.matchAll(/"tool_use_id":"([^"]+)"/g)) delete fold.open[match[1]];
    if (fold.working) fold.lastInTurnMs = Math.max(fold.lastInTurnMs || 0, ms || 0) || fold.lastInTurnMs;
  }
}

function applyClaudeRow(fold, row) {
  if (!row || row.isSidechain) return;
  const ms = Date.parse(row.timestamp);
  stamp(fold, ms);
  const signal = turnSignal(row);
  if (row.type === 'assistant') {
    const model = row.message?.model;
    if (model && model !== '<synthetic>') fold.model = model;
    for (const part of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (part?.type === 'tool_use' && part.id) {
        fold.open[part.id] = { name: part.name || 'Tool', startedMs: Number.isFinite(ms) ? ms : null, summary: actionSummary(part.name || '', part.input) };
        pushAction(fold, { name: part.name || 'Tool', summary: fold.open[part.id].summary, atMs: Number.isFinite(ms) ? ms : null });
      } else if (part?.type === 'text' && part.text?.trim()) {
        fold.lastText = clip(part.text, CLIP_TEXT);
      }
    }
    if (row.message?.stop_reason) fold.stepsEnded += 1;
  } else if (row.type === 'user') {
    const content = row.message?.content;
    if (Array.isArray(content)) for (const part of content) if (part?.type === 'tool_result' && part.tool_use_id) delete fold.open[part.tool_use_id];
    const text = promptText(content);
    const typed = !row.isMeta && isRealPrompt(text) && !isCompactContinuation(row, text) ? userTextFor(text) : null;
    if (typed && !typed.command) {
      fold.lastPrompt = clip(typed.text, CLIP_PROMPT);
      if (!fold.working) fold.turnStartedMs = Number.isFinite(ms) ? ms : fold.turnStartedMs;
    }
  }
  if (signal === 'working') {
    if (!fold.working) fold.turnStartedMs = fold.turnStartedMs && fold.turnStartedMs > (fold.turnEndedMs || 0) ? fold.turnStartedMs : (Number.isFinite(ms) ? ms : null);
    fold.working = true;
    if (Number.isFinite(ms)) fold.lastInTurnMs = ms;
  } else if (signal === 'idle') {
    endTurn(fold, Number.isFinite(ms) ? ms : null);
  }
}

function applyCodexRow(fold, row) {
  if (!row) return;
  const ms = Date.parse(row.timestamp);
  stamp(fold, ms);
  const payload = row.payload || {};
  if (row.type === 'turn_context') {
    if (payload.model) fold.model = payload.model;
    const effort = payload.effort || payload.collaboration_mode?.settings?.reasoning_effort;
    if (effort) fold.effort = effort;
    return;
  }
  if (row.type === 'event_msg') {
    if (payload.type === 'task_started') {
      fold.working = true;
      fold.turnStartedMs = Number.isFinite(ms) ? ms : fold.turnStartedMs;
      if (Number.isFinite(ms)) fold.lastInTurnMs = ms;
    } else if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
      endTurn(fold, Number.isFinite(ms) ? ms : null);
    } else if (fold.working && Number.isFinite(ms)) {
      fold.lastInTurnMs = ms;
    }
    return;
  }
  if (row.type !== 'response_item') return;
  if (fold.working && Number.isFinite(ms)) fold.lastInTurnMs = ms;
  const type = payload.type;
  if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(type)) {
    const id = payload.call_id || payload.id;
    const name = payload.name || (type === 'local_shell_call' ? 'shell' : 'Tool');
    let input = payload.input ?? payload.arguments ?? payload.action;
    if (typeof input === 'string' && type === 'function_call') { try { input = JSON.parse(input); } catch { /* keep text */ } }
    const summary = actionSummary(name, input);
    if (id) fold.open[id] = { name, startedMs: Number.isFinite(ms) ? ms : null, summary };
    pushAction(fold, { name, summary, atMs: Number.isFinite(ms) ? ms : null });
  } else if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(type)) {
    const id = payload.call_id || payload.id;
    if (id) delete fold.open[id];
  } else if (type === 'message') {
    const parts = Array.isArray(payload.content) ? payload.content : [];
    const text = parts.map((part) => part?.text || '').join('\n');
    if (payload.role === 'user' && text.trim() && !text.trimStart().startsWith('<')) fold.lastPrompt = clip(text, CLIP_PROMPT);
    if (payload.role === 'assistant' && text.trim()) { fold.lastText = clip(text, CLIP_TEXT); fold.stepsEnded += 1; }
  }
}

// One line of text in, the fold updated. Unparseable lines are skipped.
function applyLine(fold, line, provider) {
  if (!line || line.length < 2) return;
  if (provider !== 'codex' && line.length > HUGE_LINE && !line.includes('"type":"assistant"')) { applyHugeClaudeLine(fold, line); return; }
  let row;
  try { row = JSON.parse(line); } catch { return; }
  if (provider === 'codex') applyCodexRow(fold, row); else applyClaudeRow(fold, row);
}

function foldSnapshot(fold) {
  return {
    model: fold.model, effort: fold.effort, working: fold.working,
    turnStartedMs: fold.turnStartedMs, turnEndedMs: fold.turnEndedMs, lastInTurnMs: fold.lastInTurnMs, lastEventMs: fold.lastEventMs,
    openTools: Object.entries(fold.open).map(([id, tool]) => ({ id, ...tool })),
    actions: fold.actions.slice(),
    lastPrompt: fold.lastPrompt, lastText: fold.lastText,
    turnsEnded: fold.turnsEnded, stepsEnded: fold.stepsEnded,
  };
}

module.exports = { MAX_ACTIONS, HUGE_LINE, createFold, applyLine, applyClaudeRow, applyCodexRow, actionSummary, foldSnapshot, isRealPrompt };
