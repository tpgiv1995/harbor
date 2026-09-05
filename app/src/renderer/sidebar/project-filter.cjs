'use strict';

// The rail's multi-select project filter. Pure, so the gate can prove it
// without a DOM. Ask: Pat, 2026-08-25, "filter button/option at top of left
// side panel (click it and can select one or multiple different projects to
// filter and show results for)".
//
// It narrows per SESSION, never per group, for the same reason the scratch
// exclusion in filterProjects does: under DATE grouping one group holds
// sessions from many projects, so a per-group test would answer the question
// wrong in half the rail's modes. A group left with no sessions drops out.

const { isOrchestrationCwd, ORCHESTRATION_PROJECT } = require('../../shared/sidebar-model.cjs');

/**
 * The project name the RAIL uses for a session, which is not always
 * `session.project`: orchestration debris collapses into one group, so the
 * filter must offer 'Orchestration' once rather than forty scratch worktrees
 * the rail itself refuses to show as projects.
 *
 * Mirrors groupSessions' key derivation EXACTLY, including the bare
 * `|| '~'` fallback (no trimming), because an option whose label does not
 * equal the group label it came from is an option that filters to nothing.
 */
function railProjectLabel(session) {
  if (isOrchestrationCwd({ cwd: session?.cwd, label: session?.project })) return ORCHESTRATION_PROJECT;
  return session?.project || '~';
}

function normalizeProjectFilter(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((label) => typeof label === 'string' && label))];
}

/**
 * The pickable list, with the count each choice would show.
 *
 * Counts come from the model AS PASSED, so they describe the window the rail
 * is currently in (the 48h chip, a search) rather than the whole corpus: an
 * option that promises 40 and delivers 2 is worse than no count at all.
 *
 * An already-SELECTED label is always listed, even at count 0. Otherwise a
 * selection could vanish from the very menu that has to un-select it, which is
 * the dead end this codebase keeps paying for elsewhere.
 */
function projectFilterOptions(model, { selected = [] } = {}) {
  const counts = new Map();
  for (const project of model?.projects || []) {
    for (const session of project.sessions || []) {
      const label = railProjectLabel(session);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  for (const label of normalizeProjectFilter(selected)) {
    if (!counts.has(label)) counts.set(label, 0);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

/**
 * Selected projects float to the top of the menu.
 *
 * `pinned` is captured when the menu OPENS and held for as long as it is open,
 * rather than tracking the live selection: re-ordering on every tick would
 * move the row out from under the pointer mid-multi-select, which is why
 * Linear and GitHub also settle this on reopen. Alphabetical order holds
 * within each half, so nothing else moves.
 */
function orderProjectOptions(options, pinned = []) {
  const first = new Set(normalizeProjectFilter(pinned));
  if (first.size === 0) return options;
  const top = options.filter((option) => first.has(option.label));
  if (top.length === 0) return options;
  return [...top, ...options.filter((option) => !first.has(option.label))];
}

/** Substring match on the label, for the menu's own search field. */
function matchProjectOptions(options, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) => option.label.toLowerCase().includes(needle));
}

function toggleProjectFilter(selected, label) {
  const next = normalizeProjectFilter(selected);
  const at = next.indexOf(label);
  if (at >= 0) next.splice(at, 1);
  else next.push(label);
  return next;
}

/**
 * An EMPTY selection means "every project", not "no projects", and returns the
 * model itself so the caller's memo sees no change on the resting path.
 *
 * `sessionCount`, `lastActiveMs` and `hasLive` are recomputed from what
 * survived, the same way filterProjects does, so the group header cannot go on
 * reporting a live session or a clock that the filter just removed. The max is
 * taken explicitly rather than read off `sessions[0]`, so this stays correct
 * whatever order it is handed.
 */
function applyProjectFilter(model, selected) {
  const wanted = selected instanceof Set
    ? selected
    : new Set(normalizeProjectFilter(selected));
  if (wanted.size === 0) return model;
  const projects = [];
  for (const project of model?.projects || []) {
    const sessions = (project.sessions || []).filter((session) => wanted.has(railProjectLabel(session)));
    if (sessions.length === 0) continue;
    projects.push({
      ...project,
      sessions,
      sessionCount: sessions.length,
      lastActiveMs: sessions.reduce((max, session) => Math.max(max, session.lastActiveMs || 0), 0),
      hasLive: sessions.some((session) => session.isLive),
    });
  }
  return { ...model, projects };
}

/** What the trigger says when it is not opened. */
function projectFilterLabel(selected) {
  const chosen = normalizeProjectFilter(selected);
  if (chosen.length === 0) return 'All projects';
  if (chosen.length === 1) return chosen[0];
  return `${chosen.length} projects`;
}

module.exports = {
  railProjectLabel,
  normalizeProjectFilter,
  projectFilterOptions,
  orderProjectOptions,
  matchProjectOptions,
  toggleProjectFilter,
  applyProjectFilter,
  projectFilterLabel,
};
