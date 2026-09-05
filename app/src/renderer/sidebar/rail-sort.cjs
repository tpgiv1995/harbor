'use strict';

// How the rail orders what it shows. Pure, so the gate can prove it without a
// DOM: Sidebar.jsx picks a mode and renders whatever this returns.
//
// The vocabulary is deliberately the SAME as the Files view's
// (artifacts-view-model.cjs, shipped 2026-08-22): newest / oldest / name, plus
// one size-ish mode. Two tabs of one app must not invent two words for one
// idea, so `busiest` is this view's `largest` and every other mode name is
// shared verbatim. Ask: Pat, 2026-08-25, "sort option button at top of side
// panel (sort alphabetically, sort by date, etc)".
//
// Ordering happens at BOTH levels, because a rail whose projects sorted A-Z
// while their sessions stayed on recency would be answering half the question.
// The one exception is stated below and it is about date groups.

const SORT_MODES = ['newest', 'oldest', 'name', 'busiest'];
const DEFAULT_SORT = 'newest';

// The trigger chip shows the current mode without being opened, so the label
// has to read as an ANSWER ("Newest") rather than as the menu's own title.
// One-word adjectives, all four. 'Most sessions' was the first spelling and it
// ellipsized to "Most sessio..." in the 112px chip at the rail's own default
// width, measured; the precision it was carrying lives in the hint below,
// which the row's tooltip and the menu footer both show.
const SORT_LABELS = {
  newest: 'Newest',
  oldest: 'Oldest',
  name: 'Name',
  busiest: 'Busiest',
};

const SORT_HINTS = {
  newest: 'Most recently active first',
  oldest: 'Least recently active first',
  name: 'A to Z, projects and their sessions',
  busiest: 'Projects with the most sessions first (sessions keep recency order)',
};

function normalizeRailSort(value) {
  return SORT_MODES.includes(value) ? value : DEFAULT_SORT;
}

function sortLabel(value) {
  return SORT_LABELS[normalizeRailSort(value)];
}

function sortHint(value) {
  return SORT_HINTS[normalizeRailSort(value)];
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
}

// What the rail actually DRAWS for a session, so an A-Z sort agrees with the
// column the eye is reading: an orchestration worker renders its childTitle.
function sessionSortName(session) {
  if (session?.isChildTask && session?.childTitle) return session.childTitle;
  return session?.title || '';
}

// A date group's label is a DATE ('Today', 'Aug 12'). Sorting those as text
// puts August before Today and reads as a bug, so `name` falls back to
// chronological for them; every other mode means the same thing either way.
// Direction still applies, which is what makes "Oldest" read oldest-first at
// both levels, the same rule the Files view follows for its day groups.
function effectiveProjectMode(mode, projects) {
  if (mode === 'name' && projects.some((project) => project?.isDateGroup)) return 'newest';
  return mode;
}

// `displayName` is injected rather than imported because the rail draws
// homeLabel(label) ('~' renders as 'home') and that rule lives in an ESM module
// this CommonJS one cannot require. Live-caught while driving the real rail on
// 2026-08-25: sorting the RAW labels put 'home' between '(unknown)' and
// 'Assets', because '~' collates with the symbols. An A-Z list has to be A-Z in
// the column being read, so the comparator reads the same string the row does.
function projectComparators(displayName) {
  return {
    newest: (a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0),
    oldest: (a, b) => (a.lastActiveMs || 0) - (b.lastActiveMs || 0),
    name: (a, b) => compareText(displayName(a.label), displayName(b.label)),
    busiest: (a, b) => (b.sessionCount || 0) - (a.sessionCount || 0),
  };
}

const SESSION_COMPARATORS = {
  newest: (a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0),
  oldest: (a, b) => (a.lastActiveMs || 0) - (b.lastActiveMs || 0),
  name: (a, b) => compareText(sessionSortName(a), sessionSortName(b)),
  // A session has no session count of its own. Rather than invent one, the
  // sessions inside a busiest-sorted project keep the order they always had.
  busiest: (a, b) => (b.lastActiveMs || 0) - (a.lastActiveMs || 0),
};

// Ties are broken on a stable identity, never left to the sort's own
// stability: these rows are keyed into a virtualized list, and two renders that
// disagree about order would remount rows under the user's cursor.
function withTieBreak(compare, tieBreak) {
  return (a, b) => {
    const primary = compare(a, b);
    if (primary !== 0) return primary;
    return tieBreak(a, b);
  };
}

/**
 * Reorder a rail model in place of nothing: input is never mutated, because
 * the caller memoizes on it and a mutation would make an unrelated render
 * disagree with the last one.
 *
 * model: { projects: [{ label, sessions, sessionCount, lastActiveMs, ... }] }
 * Returns the same shape with both levels reordered. `lastActiveMs`,
 * `sessionCount` and `hasLive` are carried through UNTOUCHED: they are facts
 * about the set, not about its order, and recomputing them from a re-sorted
 * `sessions[0]` is exactly how a name sort would start reporting the
 * alphabetically-first session's clock as the project's last activity.
 */
function sortSidebarModel(model, { sort = DEFAULT_SORT, displayName = (label) => label } = {}) {
  const mode = normalizeRailSort(sort);
  // The model already arrives recency-first from groupSessions/filterProjects,
  // so the default mode is an identity: returning `model` itself keeps the
  // caller's memo cheap AND guarantees this feature cannot alter the view Pat
  // has been looking at for months.
  if (mode === DEFAULT_SORT) return model;
  const incoming = model?.projects || [];
  const projectCompare = projectComparators(displayName)[effectiveProjectMode(mode, incoming)];
  const sessionCompare = withTieBreak(
    SESSION_COMPARATORS[mode],
    (a, b) => compareText(a?.id, b?.id),
  );
  const projects = [...incoming]
    .map((project) => ({
      ...project,
      sessions: [...(project.sessions || [])].sort(sessionCompare),
    }))
    .sort(withTieBreak(projectCompare, (a, b) => compareText(displayName(a.label), displayName(b.label))));
  return { ...model, projects };
}

module.exports = {
  SORT_MODES,
  DEFAULT_SORT,
  SORT_LABELS,
  SORT_HINTS,
  normalizeRailSort,
  sortLabel,
  sortHint,
  sortSidebarModel,
  sessionSortName,
};
