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
  const deferred = new Map();
  const held = (paneId) => {
    const state = getPaneState(paneId);
    return state?.delegatedBy || state?.background || state?.working;
  };

  // pane_id -> last known agent_status
  const prevStatus = new Map();
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

  function acknowledgeAll() {
    if (!unacknowledgedPanes.size) return;
    unacknowledgedPanes.clear();
    updateBadge();
  }

  // A pane that stopped on a prompt is waiting for the user, not finished.
  function fireToast(entries) {
    let title = 'Harbor';
    let body;
    if (entries.length === 1) {
      const { sessionTitle, project, status } = entries[0];
      const name = project ? `${sessionTitle} (${project})` : sessionTitle;
      body = status === 'blocked' ? `${name} needs you` : `${name} finished`;
    } else {
      const blocked = entries.filter((entry) => entry.status === 'blocked').length;
      const finished = entries.length - blocked;
      body = [finished ? `${finished} session${finished === 1 ? '' : 's'} finished` : null,
        blocked ? `${blocked} need${blocked === 1 ? 's' : ''} you` : null].filter(Boolean).join(' · ');
    }
    notify(title, body);
  }

  function flushPending() {
    coalesceTimer = null;
    if (!pending.length) return;
    const entries = pending.splice(0);
    // A prompt is only worth a toast while the pane is still sitting on it.
    // One answered inside the window has moved on, and the finish that may
    // have followed it speaks for the pane instead.
    const prompting = new Set(entries
      .filter((entry) => entry.status === 'blocked' && prevStatus.get(entry.paneId) === 'blocked')
      .map((entry) => entry.paneId));
    const batch = entries.filter((entry) => {
      const prompt = entry.status === 'blocked';
      if (prompt && !prompting.has(entry.paneId)) return false;
      // A prompt still on screen says more than the turn before it ending.
      if (!prompt && prompting.has(entry.paneId)) return false;
      if (!held(entry.paneId)) return true;
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

    // Only working -> {idle,done,blocked} transitions
    if (prev !== WORKING) return;
    if (!NOTIFY_STATUSES.has(newStatus)) return;

    // Skip if this pane is the focused pane AND the window has OS focus.
    // When the window is unfocused, all panes count as unfocused (R8).
    if (isWindowFocused() && paneId === getFocusedPaneId()) return;

    const sessionTitle = data.title || `pane ${String(paneId).slice(0, 8)}`;
    // Wire events carry workspace_id, not a label (schema-verified); resolve
    // through the injected lookup.
    const project = getWorkspaceLabel(data.workspace_id) || '';
    if (held(paneId)) { deferred.set(paneId, { paneId, sessionTitle, project, status: newStatus }); return; }
    deferred.delete(paneId);
    if (!unacknowledgedPanes.has(paneId)) {
      unacknowledgedPanes.add(paneId);
      updateBadge();
    }
    enqueue({ paneId, sessionTitle, project, status: newStatus });
  }

  function onBackgroundChanged() {
    for (const [paneId, entry] of deferred) {
      const state = getPaneState(paneId);
      if (state?.alive === false || state?.delegatedBy) { deferred.delete(paneId); continue; }
      if (held(paneId)) continue;
      // The final idle event owns the transition if it has not arrived yet.
      if (prevStatus.get(paneId) === WORKING) continue;
      deferred.delete(paneId);
      if (isWindowFocused() && paneId === getFocusedPaneId()) continue;
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
    destroy,
    _flushNow,
    _pendingCount,
  };
}

module.exports = { createNotifier, COALESCE_MS, NOTIFY_STATUSES, WORKING };
