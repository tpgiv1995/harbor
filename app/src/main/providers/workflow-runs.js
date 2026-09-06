'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Workflow-run visibility for a session's window (Pat, 2026-07-24: "both are
// running dynamic workflows. i have zero insight into this").
//
// There is NO live progress file anywhere: the Workflow harness keeps phase
// and label state in-process and writes a rich completion record only at the
// end. Everything live is derived from files next to the session transcript:
//
//   <session-dir>/subagents/workflows/<runId>/journal.jsonl   started/result per agent
//   <session-dir>/subagents/workflows/<runId>/agent-<id>.jsonl  full subagent transcript
//   <session-dir>/subagents/workflows/<runId>/agent-<id>.meta.json  { model, ... }
//   <session-dir>/workflows/<runId>.json                     completion record (authoritative)
//
// plus the PARENT transcript's Workflow tool_result (runId, Summary, Script
// file) for the run's name while it is live. A run with started > results,
// no completion record, and cold files is reported as killed mid-run, the
// exact state the 2026-07-24 OOM kill left behind; never dressed up as
// running or completed.

const RUNNING_FRESH_MS = 150 * 1000;
const AGENT_TAIL_BYTES = 8 * 1024;
const AGENT_HEAD_BYTES = 4 * 1024;
const PREVIEW_MAX = 200;

function clip(text, max = PREVIEW_MAX) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readHead(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function readTail(file, bytes) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// First user block of an agent transcript = the agent's prompt.
function agentPromptPreview(file) {
  const head = readHead(file, AGENT_HEAD_BYTES);
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const obj = JSON.parse(line);
      const content = obj?.message?.content;
      if (typeof content === 'string' && content.trim()) return clip(content);
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && block.text?.trim()) return clip(block.text);
        }
      }
    } catch { /* partial line */ }
  }
  return null;
}

// Last tool call and last context size from an agent transcript tail.
function agentTailFacts(file) {
  const tail = readTail(file, AGENT_TAIL_BYTES);
  const facts = { lastTool: null, tokens: null };
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"type":"assistant"')) continue;
    try {
      const obj = JSON.parse(line);
      const content = obj?.message?.content;
      if (facts.lastTool === null && Array.isArray(content)) {
        const tool = content.find((b) => b?.type === 'tool_use');
        if (tool?.name) facts.lastTool = tool.name;
      }
      const usage = obj?.message?.usage;
      if (facts.tokens === null && usage) {
        const total = (usage.input_tokens || 0)
          + (usage.cache_read_input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0);
        if (total > 0) facts.tokens = total;
      }
      if (facts.lastTool !== null && facts.tokens !== null) break;
    } catch { /* partial line */ }
  }
  return facts;
}

function parseJournal(file) {
  const started = new Map(); // agentId -> true
  const results = new Map(); // agentId -> result preview
  const raw = (() => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  })();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'started' && obj.agentId) started.set(obj.agentId, true);
      if (obj.type === 'result' && obj.agentId) {
        const value = obj.result;
        results.set(obj.agentId, value == null ? null
          : clip(typeof value === 'string' ? value : JSON.stringify(value)));
      }
    } catch { /* partial trailing line */ }
  }
  return { started, results };
}

// The Workflow tool_result in the parent transcript names the run while it is
// live: "Summary: ..." and "Script file: ...". Bounded scan, cached per run.
function liveRunIdentity(parentTranscript, runId) {
  const identity = { name: null, summary: null };
  // Bounded: a parent transcript can run to hundreds of MB; the Workflow
  // tool_result for a live run is near the tail. A miss only costs the
  // display name (the runId stands in).
  const raw = readTail(parentTranscript, 8 * 1024 * 1024);
  const at = raw.indexOf(runId);
  if (at === -1) return identity;
  const windowText = raw.slice(Math.max(0, at - 4000), at + 4000);
  const summary = windowText.match(/Summary: ([^\\"]{4,200})/);
  if (summary) identity.summary = clip(summary[1]);
  const script = windowText.match(/Script file: ([^\\"\n]{4,300}\.js)/);
  if (script) {
    const head = readHead(script[1].trim(), 4096);
    const name = head.match(/name:\s*'([^']+)'/) || head.match(/name:\s*"([^"]+)"/);
    if (name) identity.name = name[1];
    const phases = [];
    const phasesBlock = head.match(/phases:\s*\[([\s\S]*?)\]/);
    if (phasesBlock) {
      for (const m of phasesBlock[1].matchAll(/title:\s*['"]([^'"]+)['"]/g)) phases.push({ title: m[1] });
    }
    if (phases.length) identity.phases = phases;
  }
  return identity;
}

function createWorkflowRuns({ getSessionMeta, findTranscript = null } = {}) {
  if (typeof getSessionMeta !== 'function') {
    throw new TypeError('createWorkflowRuns requires getSessionMeta(sessionId)');
  }
  const identityCache = new Map(); // runId -> { name, summary, phases }
  const promptCache = new Map(); // runId/agentId -> preview

  function completedRun(recordFile) {
    const record = safeReadJson(recordFile);
    if (!record?.runId) return null;
    const agents = (record.workflowProgress || [])
      .filter((row) => row?.type === 'workflow_agent')
      .map((row) => ({
        agentId: row.agentId || String(row.index),
        label: row.label || null,
        phaseTitle: row.phaseTitle || null,
        state: row.state || 'done',
        model: row.model || null,
        tokens: row.tokens ?? null,
        toolCalls: row.toolCalls ?? null,
        durationMs: row.durationMs ?? null,
        lastTool: row.lastToolName || null,
        promptPreview: row.promptPreview ? clip(row.promptPreview) : null,
        resultPreview: row.resultPreview ? clip(row.resultPreview) : null,
        lastActivityMs: row.lastProgressAt ?? null,
      }));
    return {
      runId: record.runId,
      name: record.workflowName || record.runId,
      status: record.status || 'completed',
      summary: record.summary ? clip(record.summary) : null,
      phases: Array.isArray(record.phases) && record.phases.length ? record.phases : null,
      startedAtMs: record.startTime ?? null,
      durationMs: record.durationMs ?? null,
      totalTokens: record.totalTokens ?? null,
      totalToolCalls: record.totalToolCalls ?? null,
      agentsTotal: record.agentCount ?? agents.length,
      agentsDone: agents.filter((a) => a.state === 'done').length,
      agentsRunning: 0,
      lastActivityMs: null,
      agents,
    };
  }

  function liveRun(runDir, runId, parentTranscript, nowMs) {
    const journalFile = path.join(runDir, 'journal.jsonl');
    const { started, results } = parseJournal(journalFile);
    let lastActivityMs = 0;
    try {
      lastActivityMs = fs.statSync(journalFile).mtimeMs;
    } catch { /* no journal yet */ }

    const agents = [];
    for (const agentId of started.keys()) {
      const file = path.join(runDir, `agent-${agentId}.jsonl`);
      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch { /* not materialized yet */ }
      if (stat) lastActivityMs = Math.max(lastActivityMs, stat.mtimeMs);
      const done = results.has(agentId);
      const meta = safeReadJson(path.join(runDir, `agent-${agentId}.meta.json`));
      const cacheKey = `${runId}/${agentId}`;
      if (!promptCache.has(cacheKey) && stat) {
        promptCache.set(cacheKey, agentPromptPreview(file));
      }
      const tailFacts = (!done && stat) ? agentTailFacts(file) : { lastTool: null, tokens: null };
      agents.push({
        agentId,
        label: null,
        phaseTitle: null,
        state: done ? 'done' : 'running',
        model: meta?.model || null,
        tokens: tailFacts.tokens,
        toolCalls: null,
        durationMs: null,
        lastTool: tailFacts.lastTool,
        promptPreview: promptCache.get(cacheKey) || null,
        resultPreview: done ? (results.get(agentId) || null) : null,
        lastActivityMs: stat ? Math.round(stat.mtimeMs) : null,
      });
    }

    if (!identityCache.has(runId)) {
      identityCache.set(runId, liveRunIdentity(parentTranscript, runId));
    }
    const identity = identityCache.get(runId) || {};
    const fresh = nowMs - lastActivityMs < RUNNING_FRESH_MS;
    const doneCount = agents.filter((a) => a.state === 'done').length;
    return {
      runId,
      name: identity.name || identity.summary || runId,
      // No completion record: a cold run was killed mid-flight (the OOM-kill
      // shape). Say so; never render it as still running or quietly done.
      status: fresh ? 'running' : 'killed',
      summary: identity.summary || null,
      phases: identity.phases || null,
      startedAtMs: null,
      durationMs: null,
      totalTokens: null,
      totalToolCalls: null,
      agentsTotal: agents.length,
      agentsDone: doneCount,
      agentsRunning: fresh ? agents.length - doneCount : 0,
      lastActivityMs: Math.round(lastActivityMs) || null,
      agents,
    };
  }

  return {
    async runsForSession(sessionId) {
      let meta = null;
      try {
        meta = await getSessionMeta(sessionId);
      } catch {
        return { runs: [] };
      }
      // The index is a CACHE, not the source of truth. Resolving only through
      // `meta.path` means a session younger than the index shows no workflow
      // strip at all, silently, which is the same shape as the two transcript
      // lookups already fixed for exactly this reason (the conversation view on
      // 2026-07-28, the question card on 2026-07-29). Swept in with the second.
      let transcript = meta?.path || null;
      if (!transcript && findTranscript) {
        try {
          transcript = await findTranscript({
            provider: meta?.provider || 'claude',
            sessionId,
            cwd: meta?.cwd || null,
          });
        } catch { transcript = null; }
      }
      if (!transcript || !transcript.endsWith('.jsonl')) return { runs: [] };
      const sessionDir = transcript.slice(0, -'.jsonl'.length);
      const nowMs = Date.now();

      const records = new Map(); // runId -> record file
      try {
        for (const entry of fs.readdirSync(path.join(sessionDir, 'workflows'))) {
          const m = entry.match(/^(wf_[a-z0-9-]+)\.json$/);
          if (m) records.set(m[1], path.join(sessionDir, 'workflows', entry));
        }
      } catch { /* no completed runs */ }

      const liveDirs = new Map(); // runId -> dir
      const liveRoot = path.join(sessionDir, 'subagents', 'workflows');
      try {
        for (const entry of fs.readdirSync(liveRoot)) {
          if (entry.startsWith('wf_')) liveDirs.set(entry, path.join(liveRoot, entry));
        }
      } catch { /* no live runs */ }

      const runs = [];
      for (const [runId, dir] of liveDirs) {
        if (records.has(runId)) continue; // the record is authoritative
        const run = liveRun(dir, runId, transcript, nowMs);
        if (run) runs.push(run);
      }
      for (const file of records.values()) {
        const run = completedRun(file);
        if (run) runs.push(run);
      }
      // Running first, then newest activity/completion.
      runs.sort((a, b) => {
        const rank = (r) => (r.status === 'running' ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return (b.lastActivityMs || b.startedAtMs || 0) - (a.lastActivityMs || a.startedAtMs || 0);
      });
      return { runs };
    },
  };
}

module.exports = { createWorkflowRuns, RUNNING_FRESH_MS };
