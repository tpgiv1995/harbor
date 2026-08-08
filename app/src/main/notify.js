'use strict';

// Notification driver for R8: fires an Electron notification when a pane transitions from
// working to idle/done/blocked AND is not the focused pane (window unfocused
// counts as all panes unfocused).  Multiple completions within COALESCE_MS are
// batched into one summary toast.
//
// Part of /home/you/dev/harbor (see README.md).

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

  function fireToast(entries) {
    let title = 'Harbor';
    let body;
    if (entries.length === 1) {
      const { sessionTitle, project } = entries[0];
      body = project ? `${sessionTitle} (${project}) finished` : `${sessionTitle} finished`;
    } else {
      body = `${entries.length} sessions finished`;
    }
    notify(title, body);
  }

  function flushPending() {
    coalesceTimer = null;
    if (!pending.length) return;
    const batch = pending.splice(0);
    fireToast(batch);
  }

  function enqueue(entry) {
    pending.push(entry);
    if (!coalesceTimer) {
      coalesceTimer = setTimeout(flushPending, COALESCE_MS);
    }
  }

  // Call on every pane.agent_status_changed event from the herdr subscription.
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
    if (!unacknowledgedPanes.has(paneId)) {
      unacknowledgedPanes.add(paneId);
      updateBadge();
    }
    enqueue({ paneId, sessionTitle, project });
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
    unacknowledgedPanes.clear();
    setBadgeCount(0);
  }

  // Exposed for tests
  function _flushNow() { flushPending(); }
  function _pendingCount() { return pending.length; }

  return {
    onAgentStatusChanged,
    seedFromSnapshot,
    acknowledgePane,
    acknowledgeAll,
    destroy,
    _flushNow,
    _pendingCount,
  };
}

module.exports = { createNotifier, COALESCE_MS, NOTIFY_STATUSES, WORKING };
