'use strict';

// Notification driver for R8: fires an Electron notification when a pane transitions from
// working to idle/done/blocked AND is not the focused pane (window unfocused
// counts as all panes unfocused).  Multiple completions within COALESCE_MS are
// batched into one summary toast.
//
// Part of Harbor (see README.md).

const COALESCE_MS = 5000;
const NOTIFY_STATUSES = new Set(['idle', 'done', 'blocked']);
const WORKING = 'working';

function createNotifier(opts = {}) {
  // Injected by caller (or defaults from the module).
  const getFocusedPaneId = opts.getFocusedPaneId || (() => null);
  const isWindowFocused = opts.isWindowFocused || (() => false);
  const getWorkspaceLabel = opts.getWorkspaceLabel || (() => '');
  const notify = opts.notify || (() => {
    throw new Error('notification capability unavailable');
  });
  const setBadgeCount = opts.setBadgeCount || (() => {});
  const getPaneState = opts.getPaneState || (() => null);
  // Notifications off, or this window muted (notify-prefs.js): no toast and no
  // badge for it. Checked when the transition happens, so turning them back on
  // never replays what was skipped.
  const isSuppressed = opts.isSuppressed || (() => false);
  const deferred = new Map();
  const held = (paneId) => {
    const state = getPaneState(paneId);
    return state?.delegatedBy || state?.background || state?.working;
  };
  // A prompt is waiting on the user NOW, so background work never holds it
  // back; only a machine-made session's prompt is not the user's to answer.
  const heldEntry = (entry) => (entry.status === 'blocked'
    ? Boolean(getPaneState(entry.paneId)?.delegatedBy) : held(entry.paneId));

  // pane_id -> last known agent_status
  const prevStatus = new Map();
  // pane_id -> the prompt it is blocked on: the keeper's status seq, or the
  // CLI's msg from a keeper without one. The msg is elided, so two prompts can
  // share it; the seq tells a new prompt from a repeat of the same one.
  const prevPrompt = new Map();
  const promptKey = (data) => (Number.isInteger(data.agent_status_seq) ? `seq:${data.agent_status_seq}`
    : `msg:${typeof data.agent_status_msg === 'string' ? data.agent_status_msg : ''}`);
  // Pending entries for the current coalesce window
  let pending = [];
  let coalesceTimer = null;
  // Panes with a completion the user has not yet seen. A Set keeps the badge
  // aligned with agents/sessions rather than repeated completion events.
  const unacknowledgedPanes = new Set();

  function updateBadge() {
    setBadgeCount(unacknowledgedPanes.size);
  }

  function acknowledgePane(paneId) {
    if (!unacknowledgedPanes.delete(paneId)) return;
    updateBadge();
  }

  // The user answered this pane's prompt inside Harbor (a one-click Allow or
  // Deny, the window's card, or a message sent into it): its badge goes like a
  // focus clears it, and a "needs you" still waiting in the coalesce window is
  // dropped, since it would send the user to a prompt that is already answered.
  function answered(paneId) {
    if (!paneId) return;
    pending = pending.filter((entry) => entry.paneId !== paneId || entry.status !== 'blocked');
    acknowledgePane(paneId);
  }

  function acknowledgeAll() {
    if (!unacknowledgedPanes.size) return;
    unacknowledgedPanes.clear();
    updateBadge();
  }

  // A pane that stopped on a prompt is waiting for the user, not finished, and
  // says what it waits on in the CLI's own words ("approve Write: <path>").
  function fireToast(entries) {
    let title = 'Harbor';
    let body;
    if (entries.length === 1) {
      const { sessionTitle, project, status, msg } = entries[0];
      const name = project ? `${sessionTitle} (${project})` : sessionTitle;
      body = status === 'blocked' ? `${name} needs you${msg ? `: ${msg}` : ''}` : `${name} finished`;
    } else {
      const blocked = entries.filter((entry) => entry.status === 'blocked').length;
      const finished = entries.length - blocked;
      body = [finished ? `${finished} session${finished === 1 ? '' : 's'} finished` : null,
        blocked ? `${blocked} need${blocked === 1 ? 's' : ''} you` : null].filter(Boolean).join(' · ');
    }
    // Clicking it opens the window that needs you first, else the first one.
    const target = entries.find((entry) => entry.status === 'blocked') || entries[0];
    notify(title, body, { paneId: target?.paneId || null });
  }

  function flushPending() {
    coalesceTimer = null;
    if (!pending.length) return;
    const entries = pending.splice(0);
    // A prompt is only worth a toast while the pane is still sitting on it.
    // One answered inside the window has moved on, and the finish that may
    // have followed it speaks for the pane instead.
    const prompting = new Set(entries
      .filter((entry) => entry.status === 'blocked' && prevStatus.get(entry.paneId) === 'blocked'
        && prevPrompt.get(entry.paneId) === entry.prompt)
      .map((entry) => entry.paneId));
    const batch = entries.filter((entry) => {
      const prompt = entry.status === 'blocked';
      if (prompt && !prompting.has(entry.paneId)) return false;
      // A prompt still on screen says more than the turn before it ending.
      if (!prompt && prompting.has(entry.paneId)) return false;
      if (!heldEntry(entry)) return true;
      deferred.set(entry.paneId, entry);
      unacknowledgedPanes.delete(entry.paneId);
      return false;
    });
    // An answered prompt no longer counts toward the badge, unless the pane
    // has something else to show (a finish in this batch, or a deferral).
    const shown = new Set(batch.map((entry) => entry.paneId));
    for (const entry of entries) {
      if (entry.status !== 'blocked' || prompting.has(entry.paneId)) continue;
      if (!shown.has(entry.paneId) && !deferred.has(entry.paneId)) unacknowledgedPanes.delete(entry.paneId);
    }
    updateBadge();
    if (batch.length) fireToast(batch);
  }

  // One slot per pane for a prompt and one for a finish, the newer entry
  // replacing the older in its slot. Keeping only the FIRST entry per pane
  // meant a prompt that arrived within the window of a finish was never
  // announced. The two slots are settled at flush (flushPending).
  function enqueue(entry) {
    const blocked = entry.status === 'blocked';
    pending = pending.filter((item) => item.paneId !== entry.paneId || (item.status === 'blocked') !== blocked);
    pending.push(entry);
    if (!coalesceTimer) {
      coalesceTimer = setTimeout(flushPending, COALESCE_MS);
    }
  }

  // Call on every pane.agent_status_changed event from the daemon subscription.
  // event: { event: 'pane.agent_status_changed', data: { pane_id, agent_status, title?, workspace_label? } }
  function onAgentStatusChanged(event) {
    const data = event?.data || {};
    const paneId = data.pane_id;
    const newStatus = data.agent_status;
    if (!paneId || !newStatus) return;

    const prev = prevStatus.get(paneId);
    prevStatus.set(paneId, newStatus);
    const prompt = newStatus === 'blocked' ? promptKey(data) : null;
    const prevPromptKey = prevPrompt.get(paneId);
    if (prompt) prevPrompt.set(paneId, prompt); else prevPrompt.delete(paneId);
    // An idle the CLI's `clear` became (session-daemon/client.js): the CLI
    // is exiting, so a killed working session is not a finished turn.
    if (data.agent_status_cleared) return;

    // working -> {idle,done,blocked}, plus a NEW prompt straight after a
    // prompt: after an Allow the CLI works for about a second before the next
    // request, under the 1 s status poll, so back-to-back prompts usually
    // arrive as blocked -> blocked. A new seq (or new words, from a keeper
    // without seq) is a new prompt; the same one reported again stays quiet.
    const nextPrompt = prev === 'blocked' && prompt !== null && prevPromptKey !== undefined && prompt !== prevPromptKey;
    if (prev !== WORKING && !nextPrompt) return;
    if (!NOTIFY_STATUSES.has(newStatus)) return;

    // Skip if this pane is the focused pane AND the window has OS focus.
    // When the window is unfocused, all panes count as unfocused (R8).
    if (isWindowFocused() && paneId === getFocusedPaneId()) return;
    if (isSuppressed(paneId)) return;

    // Status events carry no title; the bridge knows the session's.
    const sessionTitle = data.title || getPaneState(paneId)?.title || `pane ${String(paneId).slice(0, 8)}`;
    const msg = newStatus === 'blocked' && typeof data.agent_status_msg === 'string' && data.agent_status_msg ? data.agent_status_msg : null;
    // Wire events carry workspace_id, not a label (schema-verified); resolve
    // through the injected lookup.
    const project = getWorkspaceLabel(data.workspace_id) || '';
    const entry = { paneId, sessionTitle, project, status: newStatus, msg, prompt };
    if (heldEntry(entry)) { deferred.set(paneId, entry); return; }
    deferred.delete(paneId);
    if (!unacknowledgedPanes.has(paneId)) {
      unacknowledgedPanes.add(paneId);
      updateBadge();
    }
    enqueue(entry);
  }

  function onBackgroundChanged() {
    for (const [paneId, entry] of deferred) {
      const state = getPaneState(paneId);
      if (state?.alive === false || state?.delegatedBy) { deferred.delete(paneId); continue; }
      if (heldEntry(entry)) continue;
      // The final idle event owns the transition if it has not arrived yet.
      if (prevStatus.get(paneId) === WORKING) continue;
      deferred.delete(paneId);
      if (isWindowFocused() && paneId === getFocusedPaneId()) continue;
      if (isSuppressed(paneId)) continue;
      unacknowledgedPanes.add(paneId);
      enqueue(entry);
    }
    updateBadge();
  }

  // Seed previous-status map from a session.snapshot so the first event for
  // a long-running pane is treated correctly.
  function seedFromSnapshot(snapshot) {
    for (const pane of snapshot?.panes || []) {
      if (pane.pane_id && pane.agent_status) {
        prevStatus.set(pane.pane_id, pane.agent_status);
        if (pane.agent_status === 'blocked') prevPrompt.set(pane.pane_id, promptKey(pane));
      }
    }
    for (const agent of snapshot?.agents || []) {
      const paneId = agent.pane_id;
      const status = agent.agent_status || agent.status;
      if (paneId && status) prevStatus.set(paneId, status);
    }
  }

  function destroy() {
    if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
    pending = [];
    prevStatus.clear();
    prevPrompt.clear();
    deferred.clear();
    unacknowledgedPanes.clear();
    setBadgeCount(0);
  }

  // Exposed for tests
  function _flushNow() { flushPending(); }
  function _pendingCount() { return pending.length; }

  return {
    onAgentStatusChanged,
    onBackgroundChanged,
    seedFromSnapshot,
    acknowledgePane,
    acknowledgeAll,
    answered,
    destroy,
    _flushNow,
    _pendingCount,
  };
}

// Hands status events to `deliver` one at a time, in arrival order, after the
// scan `scanFor(data)` returns for that event (or none). Without the queue, a
// `working` that arrived while the idle before it waited on its scan was
// delivered first: the notifier ended on the stale idle, toasted a finish for
// a pane that was working again, and missed the real finish after it. A scan
// that rejects (or throws) still delivers its event.
function createStatusQueue({ scanFor = () => null, deliver }) {
  let queue = Promise.resolve();
  return (event) => {
    let scan;
    try { scan = Promise.resolve(scanFor(event?.data || {})).catch(() => {}); }
    catch { scan = null; }
    queue = queue.then(() => scan)
      .finally(() => deliver(event))
      .catch(() => {});
    return queue;
  };
}

module.exports = { createNotifier, createStatusQueue, COALESCE_MS, NOTIFY_STATUSES, WORKING };
