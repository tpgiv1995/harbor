'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { deriveDefaults } = require('../config/defaults.js');

const DONE_STATUSES = new Set(['done', 'completed', 'success']);
const RECENT_DONE_MS = 10 * 60 * 1000;
// A queue file is only touched at dispatch boundaries, so "quiet" is NOT
// "abandoned": a single batch legitimately runs for a long time. The old
// supervisor hard cap no longer exists. This window is now only a coarse
// heuristic for hiding an untouched run, while per-worker liveness below shows
// the age and source of the evidence Harbor actually has.
// A guessed 10 minutes labelled tonight's own 30-minute batches "abandoned"
// while they were actively working, which is the same confidently-wrong pill
// this is meant to remove, pointing the other way.
const HARD_CAP_MS = (Number(process.env.CLAUDE_DELEGATE_HARD_CAP_SECS) || 10800) * 1000;
const RUN_STALE_MS = HARD_CAP_MS + 5 * 60 * 1000;
const WORKING_FRESH_MS = 3 * 60 * 1000;
const JOIN_SLACK_MS = 2 * 60 * 1000;

function resolveWorkspace(workspace) {
  try { return fs.realpathSync(workspace); }
  catch { return path.resolve(workspace); }
}

function sameWorkspace(left, right, platform = process.platform) {
  const a = resolveWorkspace(left);
  const b = resolveWorkspace(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function findQueueForWorkspace(queues, workspace, platform = process.platform) {
  return (queues || []).find((queue) => queue?.workspace && (
    sameWorkspace(queue.workspace, workspace, platform)
    || (queue.batches || []).some((batch) => batch.worktree && sameWorkspace(batch.worktree, workspace, platform))
  )) || null;
}

function timestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function batchUpdatedAt(batch) {
  return Math.max(
    timestamp(batch.updated_at),
    timestamp(batch.completed_at),
    timestamp(batch.finished_at),
    timestamp(batch.started_at),
    timestamp(batch.created_at),
    timestamp(batch.last_dispatched_at),
    timestamp(batch.imported_at),
  );
}

function workerEngine(batch) {
  const explicit = batch.worker_engine || batch.engine || batch.worker_profile || batch.worker_target?.engine;
  if (explicit) return String(explicit);
  const worker = String(batch.worker || '').trim().split(/\s+/)[0].replace(/^\//, '');
  if (!worker) return null;
  const parts = worker.split('-');
  return parts.length > 2 ? parts.at(-1) : worker.replace(/-worker$/, '');
}

function summarizeQueue(queue, workspace, now = Date.now()) {
  if (!queue || !queue.workspace || !sameWorkspace(queue.workspace, workspace)) return null;
  const batches = Array.isArray(queue.batches) ? queue.batches : [];
  const completed = batches.filter((batch) => DONE_STATUSES.has(String(batch.status || '').toLowerCase()));
  const remaining = batches.length - completed.length;
  const etaRemaining = batches.filter((batch) => !DONE_STATUSES.has(String(batch.status || '').toLowerCase())
    && !['blocked', 'failed', 'error'].includes(String(batch.status || '').toLowerCase())).length;
  const incomplete = batches.filter((batch) => !DONE_STATUSES.has(String(batch.status || '').toLowerCase()));
  const current = incomplete.sort((a, b) => batchUpdatedAt(b) - batchUpdatedAt(a))[0] || null;
  const durations = completed.map((batch) => {
    const start = timestamp(batch.started_at || batch.startedAt || batch.created_at);
    const end = timestamp(batch.completed_at || batch.finished_at || batch.updated_at);
    return start && end > start ? end - start : 0;
  }).filter(Boolean);
  const updatedAt = Math.max(timestamp(queue.updated_at), ...batches.map(batchUpdatedAt), 0);
  const activeCount = batches.filter((batch) => String(batch.status || '').toLowerCase() === 'active').length;
  // Two completed durations minimum: one sample extrapolated across the rest
  // of the queue is an invention wearing an average's clothes, and the whole
  // 2026-08-25 rework exists because this surface used to invent.
  const etaMs = durations.length >= 2 && etaRemaining
    ? Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * etaRemaining
      / (Math.min(activeCount, etaRemaining) || 1))
    : null;
  const state = remaining === 0
    ? 'completed'
    : (updatedAt > 0 && now - updatedAt > RUN_STALE_MS ? 'abandoned' : 'live');
  return {
    queueId: queue.queue_id || null,
    workspace: resolveWorkspace(queue.workspace),
    done: completed.length,
    total: batches.length,
    remaining,
    currentBatchId: current?.id || null,
    workerEngine: current ? workerEngine(current) : null,
    etaMs,
    updatedAt,
    state,
    // The pill is for orchestration that is HAPPENING. Pat's complaint was that
    // it is "almost always stale", and relabelling a dead run 'abandoned' does
    // not fix that: a run whose session died seventeen hours ago was still
    // sitting on every window of that workspace. A completed run already
    // disappears after RECENT_DONE_MS; an abandoned one now does too, so the
    // pill is present only when there is something live to look at. The state
    // survives on the summary for the Orch panel, which is where the history of
    // a dead run belongs.
    visible: (remaining > 0 && state !== 'abandoned')
      || (updatedAt > 0 && now - updatedAt <= RECENT_DONE_MS),
  };
}

function eventTime(event) {
  return timestamp(event?.t || event?.time || event?.timestamp);
}

function eventForBatch(batch, events) {
  const needles = [batch.id, batch.title].filter(Boolean).map((value) => String(value).toLowerCase());
  return (events || []).filter((event) => {
    const message = String(event?.msg || '').toLowerCase();
    return needles.some((needle) => message.includes(needle));
  }).sort((a, b) => eventTime(b) - eventTime(a))[0] || null;
}

function joinBatchesToSessions(queue, indexRows = [], events = [], now = Date.now()) {
  const rows = Array.isArray(indexRows) ? indexRows : [];
  return (queue?.batches || []).map((batch) => {
    const status = String(batch.status || 'pending').toLowerCase();
    const dispatchedAt = timestamp(batch.last_dispatched_at || batch.started_at);
    const exact = batch.last_session_id
      ? rows.filter((row) => row.id === batch.last_session_id)
      : [];
    const titleNeedle = `batch title: ${String(batch.title || '').trim()}`.toLowerCase();
    const heuristic = batch.title ? rows.filter((row) => {
      const prompt = String(row.firstPrompt || row.first_prompt || row.title || '').trim().toLowerCase();
      const startedAt = timestamp(row.startedAt || row.start);
      return prompt.startsWith(titleNeedle) && (!dispatchedAt || !startedAt || startedAt >= dispatchedAt - JOIN_SLACK_MS);
    }) : [];
    const session = (exact.length ? exact : heuristic)
      .sort((a, b) => timestamp(b.signalAt || b.mtimeMs || b.lastActive) - timestamp(a.signalAt || a.mtimeMs || a.lastActive))[0] || null;
    const event = eventForBatch(batch, events);
    const transcriptSignal = timestamp(session?.signalAt || session?.mtimeMs || session?.lastActive);
    const eventSignal = eventTime(event);
    const signalAt = Math.max(transcriptSignal, eventSignal, status === 'done' ? batchUpdatedAt(batch) : 0);
    const signalAgeMs = signalAt ? Math.max(0, now - signalAt) : null;
    const signalSource = transcriptSignal >= eventSignal && transcriptSignal ? 'transcript' : eventSignal ? 'event' : null;
    let workerState = null;
    if (DONE_STATUSES.has(status)) workerState = 'done';
    else if (['blocked', 'failed', 'error'].includes(status)) workerState = 'error-blocked';
    else if (status === 'active') {
      const eventSaysFinished = /\b(finished|worker done|exited|completed)\b/i.test(String(event?.msg || ''));
      if (session?.finished === true || eventSaysFinished) workerState = 'awaiting-review';
      else if (signalAt && signalAgeMs <= WORKING_FRESH_MS) workerState = 'working';
      else if (signalAt) workerState = 'quiet';
      else workerState = 'no-signal';
    }
    return {
      batchId: batch.id,
      sessionId: session?.id || batch.last_session_id || null,
      workerState,
      signalAt: signalAt || null,
      signalAgeMs,
      signalSource,
      quietMs: workerState === 'quiet' ? signalAgeMs : null,
      elapsedMs: dispatchedAt ? Math.max(0, now - dispatchedAt) : null,
    };
  });
}

function formatSignalAge(ms) {
  if (ms == null) return 'no liveness signal';
  if (ms < 60_000) return 'last signal now';
  return `last signal ${Math.max(1, Math.floor(ms / 60_000))}m ago`;
}

function refineSummary(summary, joined = []) {
  if (!summary) return null;
  const counts = { working: 0, awaitingReview: 0, quiet: 0, missing: 0 };
  for (const row of joined) {
    if (row.workerState === 'working') counts.working += 1;
    else if (row.workerState === 'awaiting-review') counts.awaitingReview += 1;
    else if (row.workerState === 'quiet') counts.quiet += 1;
    else if (row.workerState === 'no-signal') counts.missing += 1;
  }
  const currentState = counts.quiet ? 'quiet' : counts.working ? 'working'
    : counts.awaitingReview ? 'awaiting-review' : counts.missing ? 'no-signal' : null;
  const current = joined.filter((row) => row.workerState === currentState)
    .sort((a, b) => (a.signalAgeMs ?? Infinity) - (b.signalAgeMs ?? Infinity))[0] || null;
  const stateWord = counts.quiet ? 'quiet' : counts.working ? 'working' : counts.awaitingReview ? 'awaiting review' : counts.missing ? 'no signal' : summary.state;
  return { ...summary, ...counts, currentState: current?.workerState || null, stateWord,
    signalAgeMs: current?.signalAgeMs ?? null, signal: current ? formatSignalAge(current.signalAgeMs) : null };
}

function deriveRun(queue, indexRows = [], events = [], now = Date.now()) {
  const liveBatches = joinBatchesToSessions(queue, indexRows, events, now);
  const summary = refineSummary(summarizeQueue(queue, queue.workspace, now), liveBatches);
  return { queue, summary, liveBatches, events };
}

function parseEvents(text) {
  return String(text || '').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const event = JSON.parse(line);
      return typeof event?.t === 'string' && typeof event?.msg === 'string'
        ? [{ t: event.t, msg: event.msg }]
        : [];
    } catch { return []; }
  }).reverse();
}

function queuePath(workspace, stateDir) {
  stateDir ||= deriveDefaults().paths.delegateStateDir;
  // claude-delegate hashes Path(...).resolve(), which FOLLOWS symlinks;
  // realpath here keeps both sides pointing at the same queue file for
  // symlinked project roots. Fall back to resolve when the path is gone.
  const resolved = resolveWorkspace(workspace);
  const digest = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12);
  return path.join(stateDir, 'queues', `${digest}.json`);
}

async function readJson(file, readFile = fs.promises.readFile) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function watchExact(file, callback) {
  const directory = path.dirname(file);
  const basename = path.basename(file);
  // A fresh machine has no queues dir yet; watching it would throw ENOENT.
  // Create it (harmless: claude-delegate owns the same path) and degrade to a
  // poll if creation is impossible.
  try {
    fs.mkdirSync(directory, { recursive: true });
    const watcher = fs.watch(directory, (_event, filename) => {
      if (!filename || filename.toString() === basename) callback();
    });
    watcher.on('error', () => { /* watcher death degrades to no live refresh */ });
    return watcher;
  } catch {
    const timer = setInterval(callback, 10000);
    timer.unref?.();
    return { close: () => clearInterval(timer) };
  }
}

function createDelegateProvider(options = {}) {
  const readFile = options.readFile || fs.promises.readFile;
  const stateDir = options.stateDir || deriveDefaults().paths.delegateStateDir;
  const queuePathFor = options.queuePathFor || ((workspace) => queuePath(workspace, stateDir));
  const watchFile = options.watchFile || watchExact;
  const debounceMs = options.debounceMs ?? 2000;
  const pollMs = options.pollMs ?? 10000;
  const lastGoodQueues = new Map();

  return {
    async getQueue(workspace) {
      // claude-delegate writes tmp+rename, but a reader can still catch a
      // partial file. Distinguish absence from corruption: a DELETED queue is
      // genuinely empty; a PARSE failure keeps the last good copy.
      const file = queuePathFor(workspace);
      try {
        const parsed = await readJson(file, readFile);
        if (parsed) { lastGoodQueues.set(file, parsed); return parsed; }
        lastGoodQueues.delete(file);
        return { batches: [] };
      } catch {
        return lastGoodQueues.get(file) || { batches: [] };
      }
    },

    async getSummary(workspace, now = Date.now()) {
      return summarizeQueue(await this.getQueue(workspace), workspace, now);
    },

    async listQueues() {
      const directory = path.join(stateDir, 'queues');
      const names = await fs.promises.readdir(directory).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
      const queues = await Promise.all(names.filter((name) => name.endsWith('.json') && !name.endsWith('.bak.json'))
        .map((name) => readJson(path.join(directory, name), readFile).catch(() => null)));
      return queues.filter((queue) => queue?.workspace);
    },

    async getEvents(queueId) {
      if (!queueId) return [];
      const file = path.join(stateDir, 'events', `${queueId}.jsonl`);
      try { return parseEvents(await readFile(file, 'utf8')); }
      catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },

    watchQueue(workspace, callback, queueId = null) {
      let timer = null;
      const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(callback, debounceMs);
      };
      const watchers = [watchFile(queuePathFor(workspace), changed)];
      if (queueId) watchers.push(watchFile(path.join(stateDir, 'events', `${queueId}.jsonl`), changed));
      const pollTimer = setInterval(changed, pollMs);
      pollTimer.unref?.();
      return () => {
        clearTimeout(timer);
        clearInterval(pollTimer);
        for (const watcher of watchers) watcher.close();
      };
    },
  };
}

module.exports = {
  deriveRun,
  findQueueForWorkspace,
  formatSignalAge,
  joinBatchesToSessions,
  parseEvents,
  refineSummary,
  sameWorkspace,
  summarizeQueue,
  createDelegateProvider,
  queuePath,
  readJson,
};
