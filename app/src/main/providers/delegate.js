'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { deriveDefaults } = require('../config/defaults.js');

const DONE_STATUSES = new Set(['done', 'completed', 'success']);
const RECENT_DONE_MS = 10 * 60 * 1000;
// A queue file is only touched at dispatch boundaries, so "quiet" is NOT
// "abandoned": a single batch legitimately runs for a long time. The supervisor
// in claude-delegate already defines the longest a worker may live
// (CLAUDE_DELEGATE_HARD_CAP_SECS, default 10800s) and kills it past that, so a
// run quiet for longer than the hard cap plus a margin is genuinely orphaned.
// A guessed 10 minutes labelled tonight's own 30-minute batches "abandoned"
// while they were actively working, which is the same confidently-wrong pill
// this is meant to remove, pointing the other way.
const HARD_CAP_MS = (Number(process.env.CLAUDE_DELEGATE_HARD_CAP_SECS) || 10800) * 1000;
const RUN_STALE_MS = HARD_CAP_MS + 5 * 60 * 1000;

function resolveWorkspace(workspace) {
  try { return fs.realpathSync(workspace); }
  catch { return path.resolve(workspace); }
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
  if (!queue || !queue.workspace || resolveWorkspace(queue.workspace) !== resolveWorkspace(workspace)) return null;
  const batches = Array.isArray(queue.batches) ? queue.batches : [];
  const completed = batches.filter((batch) => DONE_STATUSES.has(String(batch.status || '').toLowerCase()));
  const remaining = batches.length - completed.length;
  const incomplete = batches.filter((batch) => !DONE_STATUSES.has(String(batch.status || '').toLowerCase()));
  const current = incomplete.sort((a, b) => batchUpdatedAt(b) - batchUpdatedAt(a))[0] || null;
  const durations = completed.map((batch) => {
    const start = timestamp(batch.started_at || batch.startedAt || batch.created_at);
    const end = timestamp(batch.completed_at || batch.finished_at || batch.updated_at);
    return start && end > start ? end - start : 0;
  }).filter(Boolean);
  const updatedAt = Math.max(timestamp(queue.updated_at), ...batches.map(batchUpdatedAt), 0);
  const etaMs = durations.length && remaining
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) * remaining
    : 0;
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
  const writeFile = options.writeFile || fs.promises.writeFile;
  const stateDir = options.stateDir || deriveDefaults().paths.delegateStateDir;
  const queuePathFor = options.queuePathFor || ((workspace) => queuePath(workspace, stateDir));
  const workersPath = options.workersPath || path.join(stateDir, 'workers.json');
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

    async getEvents(queueId) {
      if (!queueId) return [];
      const file = path.join(stateDir, 'events', `${queueId}.jsonl`);
      try { return parseEvents(await readFile(file, 'utf8')); }
      catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },

    async getWorkers(workspace) {
      const data = (await readJson(workersPath, readFile)) || { workers: {} };
      const resolved = path.resolve(workspace);
      return Object.values(data.workers || {}).filter(
        (worker) => worker && worker.workspace && path.resolve(worker.workspace) === resolved,
      );
    },

    async removeWorker(sessionId) {
      if (!sessionId) return { ok: true, removed: false };
      const data = (await readJson(workersPath, readFile)) || { workers: {} };
      const workers = data.workers || {};
      const key = Object.keys(workers).find((id) => id === sessionId
        || workers[id]?.session_id === sessionId
        || workers[id]?.sessionId === sessionId);
      if (!key) return { ok: true, removed: false };
      delete workers[key];
      await writeFile(workersPath, `${JSON.stringify({ ...data, workers }, null, 2)}\n`, 'utf8');
      return { ok: true, removed: true };
    },

    watchQueue(workspace, callback, queueId = null) {
      let timer = null;
      const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(callback, debounceMs);
      };
      const watchers = [
        watchFile(queuePathFor(workspace), changed),
        watchFile(workersPath, changed),
      ];
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
  parseEvents,
  summarizeQueue,
  createDelegateProvider,
  queuePath,
  readJson,
};
