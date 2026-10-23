'use strict';

const { watchPath } = require('../watch-path.js');

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

// realpathSync walks every path component with a synchronous lstat, and the
// Orch summaries compare every queue workspace and every batch worktree
// against every open workspace on each broadcast: 150-430ms of blocked main
// thread per broadcast, profiled 2026-10-09. A path's real location does not
// move between broadcasts, so each answer is reused for RESOLVE_TTL_MS; a
// worktree created or removed in that window is seen on the next expiry.
const RESOLVE_TTL_MS = 30_000;
const resolvedWorkspaces = new Map();

function resolveWorkspace(workspace) {
  const key = String(workspace);
  const now = Date.now();
  const hit = resolvedWorkspaces.get(key);
  if (hit && now - hit.at < RESOLVE_TTL_MS) return hit.path;
  let resolved;
  try { resolved = fs.realpathSync(workspace); }
  catch { resolved = path.resolve(workspace); }
  resolvedWorkspaces.set(key, { path: resolved, at: now });
  return resolved;
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

const STOPPED_STATUSES = new Set(['blocked', 'failed', 'error']);
// An active batch that has already run past the average is not about to
// finish this second; it is charged this share of the average as what is left,
// and the summary counts it in `overrunning` so the ETA can say it is soft.
const OVERRUN_REMAINING_SHARE = 0.25;

function statusOf(batch) {
  return String(batch?.status || 'pending').toLowerCase();
}

// The LATEST attempt's start. `claude-delegate next` rewrites
// last_dispatched_at on every claim but keeps the first started_at, so a
// failed first try and a later retry would otherwise read as one long run,
// inventing both concurrency and duration (review finding, 2026-10-12).
function attemptStart(batch) {
  return timestamp(batch.last_dispatched_at || batch.started_at || batch.startedAt);
}

function attemptEnd(batch) {
  return timestamp(batch.completed_at || batch.finished_at || batch.updated_at);
}

// Named things two workers cannot use at the same moment (an emulator, one
// build slot, a deploy target). A batch that declares one does not start while
// another active batch holds it. Lowercased so `Android-Emulator` and
// `android-emulator` are one device.
function resourcesOf(batch) {
  // A blank name names nothing; the CLI drops it the same way and refuses to
  // queue one (Astra review, round 3: "" slipped past a truthiness check here).
  return (Array.isArray(batch?.resources) ? batch.resources : [])
    .map((name) => String(name).toLowerCase()).filter((name) => name.trim());
}

function completedDurations(batches) {
  return batches.filter((batch) => DONE_STATUSES.has(statusOf(batch))).map((batch) => {
    const start = attemptStart(batch) || timestamp(batch.created_at);
    const end = attemptEnd(batch);
    return start && end > start ? end - start : 0;
  }).filter(Boolean);
}

// The most batches the run has ever had going at once, from each batch's
// latest attempt. It is the width the ETA assumes, because the orchestrator
// that ran nine at once will run nine again after a lull. A pending batch has
// no worker, whatever stamps a reset left on it.
function peakConcurrency(batches) {
  const edges = [];
  for (const batch of batches) {
    const status = statusOf(batch);
    const start = attemptStart(batch);
    if (!start || status === 'pending') continue;
    const end = DONE_STATUSES.has(status) || STOPPED_STATUSES.has(status) ? attemptEnd(batch) : Infinity;
    if (!(end > start)) continue;
    edges.push([start, 1], [end, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  let peak = 0;
  for (const [, delta] of edges) { live += delta; peak = Math.max(peak, live); }
  return peak;
}

// A binary heap: the scheduler below pops the earliest finish and the
// lowest queue position, so a large queue costs n log n instead of a full
// rescan per finish (5,000 chained batches took 2s on the main thread before).
function heap(less) {
  const items = [];
  const swap = (i, j) => { [items[i], items[j]] = [items[j], items[i]]; };
  return {
    get size() { return items.length; },
    peek: () => items[0],
    push(item) {
      items.push(item);
      for (let i = items.length - 1; i > 0;) {
        const parent = (i - 1) >> 1;
        if (!less(items[i], items[parent])) break;
        swap(i, parent);
        i = parent;
      }
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length) {
        items[0] = last;
        for (let i = 0; ;) {
          const left = 2 * i + 1;
          const right = left + 1;
          let best = i;
          if (left < items.length && less(items[left], items[best])) best = left;
          if (right < items.length && less(items[right], items[best])) best = right;
          if (best === i) break;
          swap(i, best);
          i = best;
        }
      }
      return top;
    },
  };
}

// Remaining wall-clock time, scheduled the way the run actually executes:
// every batch costs the average completed duration, at most `width` run at
// once, a batch starts only when the batches it depends on are DONE, and a
// batch that declares a resource waits while another holds it. The old rule
// (average x remaining / active count) fell back to fully serial whenever
// nothing happened to be active between waves, and never knew that a chain of
// three dependent batches takes three durations however wide the run.
// Null when the remaining work can never all finish: a dependency on a failed,
// blocked or missing batch, or a cycle (a batch depending on itself included).
function estimateRemainingMs(batches, avgMs, now) {
  const order = new Map(batches.map((batch, index) => [String(batch.id), index]));
  const remaining = batches.map((batch, index) => ({ batch, index }))
    .filter(({ batch }) => !DONE_STATUSES.has(statusOf(batch)) && !STOPPED_STATUSES.has(statusOf(batch)));
  if (!remaining.length) return 0;
  const indegree = new Map();
  const children = new Map();
  for (const { batch, index } of remaining) {
    indegree.set(index, 0);
    for (const dep of (batch.depends_on || []).map(String)) {
      if (dep === String(batch.id) || !order.has(dep)) return null;
      const parent = batches[order.get(dep)];
      if (DONE_STATUSES.has(statusOf(parent))) continue;
      if (STOPPED_STATUSES.has(statusOf(parent))) return null;
      indegree.set(index, indegree.get(index) + 1);
      if (!children.has(order.get(dep))) children.set(order.get(dep), []);
      children.get(order.get(dep)).push(index);
    }
  }
  const active = remaining.filter(({ batch }) => statusOf(batch) === 'active');
  const width = Math.max(1, active.length, peakConcurrency(batches));
  const left = (batch) => {
    if (statusOf(batch) !== 'active') return avgMs;
    const since = attemptStart(batch);
    const elapsed = since ? Math.max(0, now - since) : 0;
    return Math.max(avgMs - elapsed, avgMs * OVERRUN_REMAINING_SHARE);
  };
  // An active batch whose own dependency is not done was started too early
  // (a hand edit, a status update); simulating it as running would quietly
  // break whatever chain it sits in, so the estimate is unknown instead.
  if (active.some(({ index }) => indegree.get(index) > 0)) return null;
  const running = heap((a, b) => a.end < b.end || (a.end === b.end && a.index < b.index));
  const ready = heap((a, b) => a < b);
  // A batch blocked by a held resource waits on that resource's own list,
  // so a release looks at one waiter instead of rescanning every blocked
  // batch (1,000 batches contending for one emulator cost a full rescan per
  // finish). The lowest queue position among a free resource's waiters is
  // always a start candidate, which keeps queue order exactly as before.
  const waiters = new Map();
  const held = new Map();
  const promote = (name) => {
    const queue = waiters.get(name);
    if (queue?.size && !(held.get(name) > 0)) ready.push(queue.pop());
  };
  const hold = (batch, delta) => {
    for (const name of resourcesOf(batch)) {
      held.set(name, (held.get(name) || 0) + delta);
      if (delta < 0 && held.get(name) === 0) promote(name);
    }
  };
  for (const { batch, index } of active) { running.push({ end: left(batch), index }); hold(batch, 1); }
  for (const { batch, index } of remaining) {
    if (statusOf(batch) !== 'active' && indegree.get(index) === 0) ready.push(index);
  }
  let clock = 0;
  let finished = 0;
  while (finished < remaining.length) {
    while (running.size < width && ready.size) {
      const index = ready.pop();
      const batch = batches[index];
      const blocker = resourcesOf(batch).find((name) => held.get(name) > 0);
      if (blocker !== undefined) {
        if (!waiters.has(blocker)) waiters.set(blocker, heap((a, b) => a < b));
        waiters.get(blocker).push(index);
        // It may have been the start candidate for its other, free resources.
        for (const name of resourcesOf(batch)) if (name !== blocker) promote(name);
        continue;
      }
      running.push({ end: clock + left(batch), index });
      hold(batch, 1);
    }
    if (!running.size) return null;
    clock = running.peek().end;
    while (running.size && running.peek().end <= clock) {
      const { index } = running.pop();
      finished += 1;
      hold(batches[index], -1);
      for (const child of children.get(index) || []) {
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0 && statusOf(batches[child]) !== 'active') ready.push(child);
      }
    }
  }
  return Math.round(clock);
}

// Who holds each declared resource right now: the active batches.
function heldResources(batches) {
  const held = new Map();
  for (const batch of batches) {
    if (statusOf(batch) !== 'active') continue;
    for (const name of resourcesOf(batch)) if (!held.has(name)) held.set(name, String(batch.id));
  }
  return held;
}

// Why a pending batch is not running: everything it needs is done and free
// (ready, so an idle one is the orchestrator's to dispatch), or it waits on
// unfinished dependencies (missing ones count, as in the CLI) or on a resource
// an active batch holds, named "<resource> (held by <batch>)".
function pendingReadiness(batch, byId, held = new Map()) {
  const waitingOn = (batch.depends_on || []).map(String).filter((id) => {
    const dep = byId.get(id);
    return !dep || !DONE_STATUSES.has(statusOf(dep));
  });
  for (const name of resourcesOf(batch)) {
    if (held.has(name)) waitingOn.push(`${name} (held by ${held.get(name)})`);
  }
  return { ready: waitingOn.length === 0, waitingOn };
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
  const durations = completedDurations(batches);
  const avgMs = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
  const updatedAt = Math.max(timestamp(queue.updated_at), ...batches.map(batchUpdatedAt), 0);
  const byId = new Map(batches.map((batch) => [String(batch.id), batch]));
  const held = heldResources(batches);
  const pending = batches.filter((batch) => statusOf(batch) === 'pending');
  const ready = pending.filter((batch) => pendingReadiness(batch, byId, held).ready).length;
  // Two completed durations minimum: one sample extrapolated across the rest
  // of the queue is an invention wearing an average's clothes, and the whole
  // 2026-08-25 rework exists because this surface used to invent.
  const etaMs = durations.length >= 2 && etaRemaining ? estimateRemainingMs(batches, avgMs, now) : null;
  const etaUnknown = etaMs != null || !etaRemaining ? null
    : durations.length < 2 ? 'needs two finished batches'
      : 'the dependencies cannot finish as recorded (failed, blocked, missing, circular, or a batch started before its dependency)';
  // Active batches already past the average: the ETA charges each a quarter
  // of it, which is a guess, so the surfaces say how many are running long.
  const overrunning = durations.length >= 2 ? batches.filter((batch) => statusOf(batch) === 'active'
    && attemptStart(batch) && now - attemptStart(batch) > avgMs).length : 0;
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
    active: batches.filter((batch) => statusOf(batch) === 'active').length,
    ready,
    waiting: pending.length - ready,
    overrunning,
    etaMs,
    etaUnknown,
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

function sessionStartedAt(row) {
  return timestamp(row.startedAt || row.start || row.lineage?.startedMs);
}

function sessionActivityAt(row) {
  return timestamp(row.signalAt || row.mtimeMs || row.lastActive);
}

function mostRecentlyActive(list) {
  return list.sort((a, b) => sessionActivityAt(b) - sessionActivityAt(a))[0] || null;
}

// A batch's worker is found in three tiers, strongest first, and a weaker tier
// is consulted only when every stronger one is empty: the exact session id
// the queue recorded, then the BATCH TITLE: prompt, then a session started in
// the batch's own lane worktree. Codex workers were never launched with the
// title prefix, so before the lane tier they joined only by id and otherwise
// read "no liveness signal". Mixing tiers and sorting by activity let a later
// session in the same worktree (the next batch's worker, a review) outrank
// the real worker, so the tiers stay separate.
function joinBatchesToSessions(queue, indexRows = [], events = [], now = Date.now()) {
  const rows = Array.isArray(indexRows) ? indexRows : [];
  const batches = queue?.batches || [];
  const byId = new Map(batches.map((batch) => [String(batch.id), batch]));
  const held = heldResources(batches);
  const dispatchOf = (batch) => timestamp(batch.last_dispatched_at || batch.started_at);
  // A session another batch names as its own worker is never a heuristic
  // match for this one, in either heuristic tier.
  const claimedBy = new Map(batches.filter((batch) => batch.last_session_id).map((batch) => [batch.last_session_id, batch.id]));
  const ownedElsewhere = (row, batch) => claimedBy.has(row.id) && claimedBy.get(row.id) !== batch.id;
  const strong = batches.map((batch) => {
    if (batch.last_session_id) {
      const exact = mostRecentlyActive(rows.filter((row) => row.id === batch.last_session_id));
      if (exact) return exact;
    }
    if (!batch.title) return null;
    const dispatchedAt = dispatchOf(batch);
    const titleNeedle = `batch title: ${String(batch.title).trim()}`.toLowerCase();
    // The title prefix is how claude workers announce themselves; a codex
    // worker's prompt may carry the packet after a preamble, so for codex the
    // line may sit anywhere in the prompt.
    return mostRecentlyActive(rows.filter((row) => {
      if (ownedElsewhere(row, batch)) return false;
      const startedAt = timestamp(row.startedAt || row.start);
      if (dispatchedAt && startedAt && startedAt < dispatchedAt - JOIN_SLACK_MS) return false;
      const prompt = String(row.firstPrompt || row.first_prompt || row.title || '').trim().toLowerCase();
      return prompt.startsWith(titleNeedle) || (row.provider === 'codex' && prompt.includes(titleNeedle));
    }));
  });
  const taken = new Set(strong.filter(Boolean).map((row) => row.id));
  // Lanes are shared by successive batches, so each batch owns a window that
  // never overlaps another's: from its dispatch (less the join slack when no
  // earlier batch was dispatched into the lane) up to the next dispatch into
  // the same lane, and the EARLIEST session in it is the worker; anything later
  // (a review, a resume) came after it. Windows that met at the midpoint of two
  // close dispatches overlapped, so a worker that started late could be taken
  // by the next batch while its own batch read "no liveness signal".
  const laneWorker = (batch) => {
    const dispatchedAt = dispatchOf(batch);
    if (!batch.worktree || !dispatchedAt) return null;
    const laneStamps = batches
      .filter((other) => other !== batch && other.worktree && sameWorkspace(other.worktree, batch.worktree))
      .map(dispatchOf).filter(Boolean);
    const earlier = laneStamps.some((at) => at <= dispatchedAt);
    const from = earlier ? dispatchedAt : dispatchedAt - JOIN_SLACK_MS;
    const until = laneStamps.filter((at) => at > dispatchedAt).reduce((min, at) => Math.min(min, at), Infinity);
    const worker = rows.filter((row) => {
      const startedAt = sessionStartedAt(row);
      if (!startedAt || !row.cwd || startedAt < from || startedAt >= until) return false;
      if (taken.has(row.id) || ownedElsewhere(row, batch)) return false;
      return sameWorkspace(row.cwd, batch.worktree);
    }).sort((a, b) => sessionStartedAt(a) - sessionStartedAt(b))[0] || null;
    // One worker, one batch, even for two dispatches stamped the same instant.
    if (worker) taken.add(worker.id);
    return worker;
  };
  return batches.map((batch, index) => {
    const status = String(batch.status || 'pending').toLowerCase();
    const dispatchedAt = dispatchOf(batch);
    const session = strong[index] || laneWorker(batch);
    const event = eventForBatch(batch, events);
    const transcriptSignal = timestamp(session?.signalAt || session?.mtimeMs || session?.lastActive);
    const eventSignal = eventTime(event);
    const signalAt = Math.max(transcriptSignal, eventSignal, status === 'done' ? batchUpdatedAt(batch) : 0);
    const signalAgeMs = signalAt ? Math.max(0, now - signalAt) : null;
    const signalSource = transcriptSignal >= eventSignal && transcriptSignal ? 'transcript' : eventSignal ? 'event' : null;
    let workerState = null;
    let waitingOn = null;
    if (status === 'pending') {
      ({ waitingOn } = pendingReadiness(batch, byId, held));
      workerState = waitingOn.length ? 'waiting' : 'ready';
    } else if (DONE_STATUSES.has(status)) workerState = 'done';
    else if (['blocked', 'failed', 'error'].includes(status)) workerState = 'error-blocked';
    else if (status === 'active') {
      const eventSaysFinished = /\b(finished|worker done|exited|completed)\b/i.test(String(event?.msg || ''));
      // How the worker's last turn ended (the transcript's turnEnd). A failed
      // or stopped turn has finished too, but "awaiting review" (or, with no
      // end at all, "possibly hung") would hide that it did not succeed.
      if (session?.turnEnd === 'error') workerState = 'failed';
      else if (session?.turnEnd === 'aborted') workerState = 'stopped';
      else if (session?.finished === true || eventSaysFinished) workerState = 'awaiting-review';
      else if (signalAt && signalAgeMs <= WORKING_FRESH_MS) workerState = 'working';
      else if (signalAt) workerState = 'quiet';
      else workerState = 'no-signal';
    }
    return {
      batchId: batch.id,
      sessionId: session?.id || batch.last_session_id || null,
      workerState,
      waitingOn,
      signalAt: signalAt || null,
      signalAgeMs,
      signalSource,
      quietMs: workerState === 'quiet' ? signalAgeMs : null,
      elapsedMs: dispatchedAt ? Math.max(0, now - dispatchedAt) : null,
      // The worker's own last turn, before the queue has a reviewed excerpt.
      workerError: workerState === 'failed' ? session?.turnError?.message || 'turn failed' : null,
      workerResult: session?.resultText || null,
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
  const counts = { working: 0, awaitingReview: 0, quiet: 0, missing: 0, failed: 0, stopped: 0 };
  for (const row of joined) {
    if (row.workerState === 'working') counts.working += 1;
    else if (row.workerState === 'awaiting-review') counts.awaitingReview += 1;
    else if (row.workerState === 'failed') counts.failed += 1;
    else if (row.workerState === 'stopped') counts.stopped += 1;
    else if (row.workerState === 'quiet') counts.quiet += 1;
    else if (row.workerState === 'no-signal') counts.missing += 1;
  }
  const currentState = counts.failed ? 'failed' : counts.quiet ? 'quiet' : counts.working ? 'working'
    : counts.awaitingReview ? 'awaiting-review' : counts.stopped ? 'stopped' : counts.missing ? 'no-signal' : null;
  const current = joined.filter((row) => row.workerState === currentState)
    .sort((a, b) => (a.signalAgeMs ?? Infinity) - (b.signalAgeMs ?? Infinity))[0] || null;
  // Nothing running while batches are ready is the run sitting idle, which is
  // exactly what the pill must say rather than a bare "live".
  const idleReady = summary.ready && summary.state === 'live' ? 'ready, not started' : null;
  const stateWord = counts.failed ? 'worker failed' : counts.quiet ? 'quiet' : counts.working ? 'working' : counts.awaitingReview ? 'awaiting review'
    : counts.stopped ? 'worker stopped' : counts.missing ? 'no signal' : idleReady || summary.state;
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
    const watcher = watchPath(directory, (_event, filename) => {
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
