'use strict';

const MAX_LABEL_COUNT = 9;

function normalizedCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function countLabel(count) {
  return count > MAX_LABEL_COUNT ? '9+' : String(count);
}

function sessionPhrase(count, state) {
  return `${count} ${count === 1 ? 'session' : 'sessions'} ${state}`;
}

function planTaskbarBadge(counts = {}) {
  const blocked = normalizedCount(counts.blocked);
  const finished = normalizedCount(counts.finished);
  const description = `${sessionPhrase(blocked, 'waiting for your answer')}; ${sessionPhrase(finished, 'finished')}`;

  if (blocked > 0) {
    return { kind: 'amber', count: blocked, label: countLabel(blocked), description };
  }
  if (finished > 0) {
    return { kind: 'accent', count: finished, label: countLabel(finished), description };
  }
  return { kind: 'clear', count: 0, label: '', description };
}

// What the taskbar actually shows. Two plans with the same key draw the same overlay.
function taskbarBadgeKey(plan) {
  return plan ? `${plan.kind}|${plan.label}|${plan.description}` : '';
}

// Coalesce badge changes into one native set, and send only real changes.
//
// The App recomputes the plan on every transcript update of every open window, so the scheduler
// sends only when what the taskbar would show changes; re-sending the same badge is harmless to
// Windows (an identical set on a showing overlay is invisible, filmed 2026-10-04) but pointless.
// The 2026-09-29 "blink" ("i see '2' and it shows for a couple seconds, goes away, then pops up
// again with 2") was NOT a replayed identical set, as first believed: app.setBadgeCount was
// wiping the overlay every few seconds and each re-send popped it back (main/index.js
// setAppBadgeCount).
//
// And only a change may restart the coalescing clock (2026-10-04, "i dont get the blue / yellow
// alert numbers anymore"). When each recompute re-armed the timer, any window streaming faster
// than the delay kept the badge from ever being sent (scripts/drive-taskbar-badge-win.js: a
// question raised while another window streamed, 36 updates in 4s, zero sends).
function createTaskbarBadgeScheduler({
  send,
  render,
  delayMs = 250,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  let shownKey = null; // what the taskbar shows; null until the first send
  let pendingKey = null; // the change on its way, if any
  let timer = null;
  return function update(plan) {
    const key = taskbarBadgeKey(plan);
    if (timer !== null) {
      // This change is already on its way: an unrelated update must not push it back.
      if (key === pendingKey) return false;
      clearTimer(timer);
      timer = null;
      pendingKey = null;
    }
    if (key === shownKey) return false;
    pendingKey = key;
    timer = setTimer(() => {
      timer = null;
      pendingKey = null;
      shownKey = key;
      send(render(plan));
    }, delayMs);
    return true;
  };
}

module.exports = { MAX_LABEL_COUNT, planTaskbarBadge, taskbarBadgeKey, createTaskbarBadgeScheduler };
