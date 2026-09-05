'use strict';

/**
 * Which collapse state the rail actually renders with.
 *
 * A project the user collapsed must stay collapsed. There is exactly one
 * exception, and it is narrow ON PURPOSE: while a SEARCH is running, a hit
 * buried inside a collapsed project is indistinguishable from no hit at all,
 * so a query flattens collapse for as long as it is typed.
 *
 * The rule used to key off `narrowing = searching || timeFilterActive`, which
 * looked equivalent and was not. The rail's resting state is the 48h chip
 * (`useState({ kind: 'rolling', days: 2 })` in Sidebar.jsx), and
 * `timeFilterActive` is true for EVERY chip except All. So the guard was live
 * in the default view, an empty set went to flattenSidebarRows on every
 * render, and the caret did nothing at all: it could not hide a session and it
 * could not even flip its own arrow, because the row's `collapsed` flag comes
 * back out of that same flatten. Collapse only ever worked if you first clicked
 * All, which is not a state anyone sits in. It also silently defeated the
 * boot-time auto-collapse of non-live projects.
 *
 * A time filter is a VIEW, not a hunt. It does not ask a question that a
 * collapsed project could falsely answer "no" to, so it has no business
 * overriding an explicit collapse. Only the query does.
 *
 * The stored set is never mutated: flattening is a rendering decision, and
 * clearing a search has to give every collapsed project back.
 *
 * The time filter is deliberately NOT a parameter. It cannot reach the answer,
 * so no future edit can quietly reconnect it, and the suite passes
 * `timeFilterActive: true` anyway to assert exactly that.
 *
 * Reported by Pat 2026-08-08: "projects are not collapsing in side panel".
 */
function collapseForView({
  collapsedProjects = new Set(),
  searching = false,
} = {}) {
  if (searching) return new Set();
  return collapsedProjects;
}

/**
 * The one-button collapse-all / expand-all, as VS Code's explorer and search
 * toolbars do it: ONE control that offers the action the tree is not already
 * in, rather than two buttons of which one is always a no-op. The rail's
 * control row has been overflowed onto a wasted line once already (2026-07-27),
 * and a pair of buttons here would spend that room to say the same thing.
 *
 * DISABLED while searching, and that is the load-bearing part. A query
 * flattens collapse for the view (see collapseForView above), so a
 * collapse-all pressed mid-search would store a set that changes nothing on
 * screen: the exact dead-control failure the 2026-08-08 caret bug was made of.
 * The button says why instead of lying.
 *
 * Expand-all only clears the labels currently in VIEW. A project narrowed out
 * by a time chip or the project filter keeps whatever collapse the user gave
 * it, because expanding what you cannot see is not what the button offered.
 *
 * Ask: Pat, 2026-08-25, "collapse all / expand all button at top of left side
 * panel".
 */
function planCollapseAll({
  projects = [],
  collapsedProjects = new Set(),
  searching = false,
} = {}) {
  const labels = projects
    .map((project) => project?.label)
    .filter((label) => typeof label === 'string');
  const action = labels.some((label) => !collapsedProjects.has(label)) ? 'collapse' : 'expand';
  const next = new Set(collapsedProjects);
  for (const label of labels) {
    if (action === 'collapse') next.add(label);
    else next.delete(label);
  }
  return {
    action,
    disabled: searching || labels.length === 0,
    reason: searching ? 'Search shows every project; clear it to collapse' : null,
    projectCount: labels.length,
    next,
  };
}

module.exports = { collapseForView, planCollapseAll };
