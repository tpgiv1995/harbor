'use strict';

// A whole-transcript fold, independent of the conversation's bounded tail.
// Only accepted tool results create work. Recurring cron registrations are
// inventory, never an unfinished turn: they can remain installed indefinitely.
const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped']);
const { turnSignal, freshWorking } = require('../../shared/claude-turn-state.cjs');
const LAUNCH_TOOLS = /^(Bash|PowerShell|Agent|Task|Workflow|Monitor|ScheduleWakeup|CronCreate|CronDelete|TaskStop|KillShell|SendMessage|mcp__.*)$/;
function textParts(content) {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n') : '';
}
function interestingLine(line) {
  return line.includes('tool_use') || line.includes('tool_result') || line.includes('task-notification')
    || line.includes('"user"') || line.includes('"assistant"') || line.includes('"system"');
}
function createBackgroundState() {
  return { tools: {}, tasks: {}, notifications: {}, pendingNotices: {}, working: false, lastInTurnMs: 0, lastTurnEndMs: 0, lastSignalMs: 0 };
}
function field(text, tag) { return text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || ''; }
function finish(task, status, ms) {
  if (!task) return;
  task.status = status;
  task.endedMs = ms;
  task.lastSignalMs = ms;
}
function applyBackgroundLine(state, row) {
  if (!row || row.isSidechain || row.isMeta) return state;
  const ms = Date.parse(row.timestamp) || 0;
  const content = row.message?.content;
  const parts = Array.isArray(content) ? content : [];
  // Notifications are accepted only from the CLI's three carriers, never from
  // a tool's output quoting an old transcript or from assistant prose.
  const carrier = row.type === 'queue-operation' && row.operation === 'enqueue' ? row.content
    : row.type === 'attachment' && row.attachment?.type === 'queued_command' ? row.attachment.prompt
      : row.type === 'user' ? textParts(content) : '';
  let notified = false;
  for (const match of String(carrier || '').matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
    notified = true;
    const block = match[0];
    const id = field(block, 'task-id');
    const task = state.tasks[id];
    const status = field(block, 'status');
    if (!task) {
      if (TERMINAL.has(status) && ms >= (state.pendingNotices[id]?.ms || 0)) state.pendingNotices[id] = { status, ms };
      continue;
    }
    const signature = `${id}|${status}|${field(block, 'tool-use-id')}|${field(block, 'summary')}|${field(block, 'event')}`;
    if (state.notifications[signature] != null
      && !(row.type === 'queue-operation' && task.status === 'running' && ms > task.startedMs
        && state.notifications[signature] < task.startedMs)) continue;
    state.notifications[signature] = ms;
    if (ms && ms < task.startedMs) continue;
    task.lastSignalMs = ms;
    if (TERMINAL.has(status)) finish(task, status, ms);
  }
  const signal = turnSignal(row);
  const userTurn = row.type === 'user' && signal === 'working' && !parts.some((p) => p.type === 'tool_result');
  if (userTurn) {
    for (const task of Object.values(state.tasks)) {
      if (task.kind === 'wakeup' && task.status === 'running' && task.dueMs && ms >= task.dueMs) finish(task, 'completed', ms);
    }
  }
  if (signal) state.working = signal === 'working';
  if (signal === 'working') state.lastInTurnMs = ms;
  if (signal === 'idle') state.lastTurnEndMs = ms;
  if (row.type === 'assistant' || userTurn || notified) state.lastSignalMs = Math.max(state.lastSignalMs, ms);
  for (const part of parts) {
    if (row.type === 'assistant' && part.type === 'tool_use' && LAUNCH_TOOLS.test(part.name)) {
      const input = part.input || {};
      const kept = Object.fromEntries(['description', 'name', 'command', 'prompt', 'to', 'task_id', 'shell_id', 'id', 'job_id', 'stop'].filter((key) => input[key] != null).map((key) => [key, typeof input[key] === 'string' ? input[key].slice(0, key === 'command' ? 64000 : 500) : input[key]]));
      state.tools[part.id] = { name: part.name, input: kept, startedMs: ms, cwd: row.cwd || null };
    }
    if (row.type !== 'user' || part.type !== 'tool_result') continue;
    const tool = state.tools[part.tool_use_id];
    if (!tool) continue;
    delete state.tools[part.tool_use_id];
    if (part.is_error) continue;
    const text = textParts(part.content);
    const input = tool.input;
    if (tool.name === 'SendMessage') {
      const task = state.tasks[input.to];
      if (task) {
        task.rounds ||= [];
        task.rounds.push({ startedMs: task.startedMs, endedMs: task.endedMs, status: task.status });
        Object.assign(task, { status: 'running', startedMs: tool.startedMs, endedMs: null, lastSignalMs: ms });
      }
      continue;
    }
    if (tool.name === 'TaskStop' || tool.name === 'KillShell') {
      if (/successfully stopped|killed|terminated/i.test(text)) finish(state.tasks[input.task_id || input.shell_id], 'stopped', ms);
      continue;
    }
    if (tool.name === 'CronDelete') {
      finish(state.tasks[input.id || input.job_id], 'stopped', ms);
      continue;
    }
    let id; let kind;
    if (tool.name === 'ScheduleWakeup') {
      if (!input.stop && !/Next wakeup scheduled/i.test(text)) continue;
      for (const task of Object.values(state.tasks)) if (task.kind === 'wakeup' && task.status === 'running') finish(task, 'stopped', ms);
      if (input.stop) continue;
      id = `wakeup:${part.tool_use_id}`; kind = 'wakeup';
    } else if (/^(Bash|PowerShell)$/.test(tool.name) && (id = text.match(/^Command (?:running in background with ID:|did not complete within its [\d.]+s timeout and was moved to the background \(ID:)\s*([\w-]+)/i)?.[1])) kind = 'command';
    else if (tool.name.startsWith('mcp__') && (id = text.match(/^MCP tool [^\n]+moved to the background as task\s+([\w-]+)/i)?.[1])) kind = 'mcp';
    else if (/^(Agent|Task)$/.test(tool.name) && /^Async agent launched/i.test(text) && (id = text.match(/agentId:\s*([\w-]+)/)?.[1])) kind = 'agent';
    else if (tool.name === 'Workflow' && /^Workflow launched in background/i.test(text) && (id = text.match(/Task ID:\s*([\w-]+)/i)?.[1])) kind = 'workflow';
    else if (tool.name === 'Monitor' && (id = text.match(/^Monitor started \(task\s+([\w-]+)/i)?.[1])) kind = 'monitor';
    else if (tool.name === 'CronCreate' && (id = text.match(/^Scheduled recurring job\s+([\w-]+)/i)?.[1])) kind = 'cron';
    if (!id) continue;
    const seconds = Number(text.match(/\(in\s+([\d.]+)s\)/)?.[1]);
    state.tasks[id] = {
      id, kind, toolUseId: part.tool_use_id, status: 'running', blocking: kind !== 'cron',
      description: String(input.description || input.name || input.prompt || tool.name).slice(0, 500),
      command: String(input.command || '').slice(0, 64000), prompt: String(input.prompt || '').split('\n').find((s) => s.trim())?.slice(0, 500) || '',
      cwd: tool.cwd, startedMs: tool.startedMs, lastSignalMs: ms, endedMs: null,
      dueMs: kind === 'wakeup' && seconds > 0 ? ms + seconds * 1000 : null,
    };
    const early = state.pendingNotices[id];
    if (early && early.ms >= tool.startedMs) finish(state.tasks[id], early.status, early.ms);
    delete state.pendingNotices[id];
  }
  return state;
}
function backgroundSnapshot(state, now = Date.now()) {
  const tasks = Object.values(state.tasks);
  return { tasks, outstanding: tasks.filter((t) => t.blocking && t.status === 'running'),
    awaitingFinal: tasks.some((t) => t.blocking && t.endedMs > state.lastTurnEndMs),
    working: freshWorking(state, now), lastInTurnMs: state.lastInTurnMs, lastTurnEndMs: state.lastTurnEndMs, lastSignalMs: state.lastSignalMs };
}
module.exports = { createBackgroundState, applyBackgroundLine, backgroundSnapshot, interestingLine, textParts, TERMINAL };
