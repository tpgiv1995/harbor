'use strict';

// Filter/sort/group/search decisions for the Artifacts view, pure so the gate
// can prove them without a DOM (the JSX builds entries and renders whatever
// this returns). Built 2026-08-22 on Pat's ask: the project grouping is right
// most days, but sometimes he just wants recency, or a by-day reading of what
// the fleet produced.
//
// A "day" follows the SAME 6am roll as the rail and the Tasks view
// (shared/date-roll DAY_ROLL_HOUR, reused rather than re-declared): work done
// at 1am belongs to the evening it continued, and a midnight roll would split
// one working night into two groups.

const { displayDayFor } = require('../../shared/date-roll.cjs');

const GROUP_MODES = ['project', 'day', 'none'];
const SORT_MODES = ['newest', 'oldest', 'largest', 'name'];

const COMPARATORS = {
  newest: (a, b) => (b.artifact.mtimeMs || 0) - (a.artifact.mtimeMs || 0),
  oldest: (a, b) => (a.artifact.mtimeMs || 0) - (b.artifact.mtimeMs || 0),
  largest: (a, b) => (b.artifact.bytes || 0) - (a.artifact.bytes || 0),
  name: (a, b) => String(a.artifact.name || '').localeCompare(String(b.artifact.name || ''), undefined, { sensitivity: 'base' }),
};

function normalizeGroupBy(value) {
  return GROUP_MODES.includes(value) ? value : 'project';
}

function normalizeSortBy(value) {
  return SORT_MODES.includes(value) ? value : 'newest';
}

// Search matches what the card SHOWS plus what the tooltip would tell you:
// filename, project label, and session title, case-insensitive substring.
function matchesSearch(entry, needle) {
  if (!needle) return true;
  const hay = `${entry.artifact.name || ''}\n${entry.projectLabel || ''}\n${entry.sessionTitle || ''}`.toLowerCase();
  return hay.includes(needle);
}

function dayLabelFor(dayStartMs, nowMs) {
  const today = displayDayFor(new Date(nowMs)).getTime();
  const delta = Math.round((today - dayStartMs) / 86_400_000);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Yesterday';
  return new Date(dayStartMs).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

/**
 * entries: [{ artifact, sessionTitle, projectLabel, projectKey, cwd }]
 * Returns { groups: [{ key, label, mode, cwd, items }], total, matched }.
 * `total` is the pre-search count of the kind-filtered set; `matched` is what
 * survived the search, so the header can say "12 matching" honestly.
 */
function planArtifactsView({
  entries = [], kind = 'all', search = '', groupBy = 'project', sortBy = 'newest', nowMs = 0,
} = {}) {
  const mode = normalizeGroupBy(groupBy);
  const sort = normalizeSortBy(sortBy);
  const needle = String(search || '').trim().toLowerCase();
  const kindFiltered = kind === 'all' ? entries : entries.filter((e) => e.artifact.kind === kind);
  const matchedEntries = kindFiltered.filter((e) => matchesSearch(e, needle));
  const sorted = [...matchedEntries].sort(COMPARATORS[sort]);

  let groups;
  if (mode === 'none') {
    groups = sorted.length ? [{ key: 'all', label: null, mode, cwd: null, items: sorted }] : [];
  } else if (mode === 'day') {
    const byDay = new Map();
    for (const entry of sorted) {
      const dayStart = displayDayFor(new Date(entry.artifact.mtimeMs || 0)).getTime();
      if (!byDay.has(dayStart)) byDay.set(dayStart, []);
      byDay.get(dayStart).push(entry);
    }
    const dayKeys = [...byDay.keys()].sort(sort === 'oldest' ? (a, b) => a - b : (a, b) => b - a);
    groups = dayKeys.map((dayStart) => ({
      key: `day:${dayStart}`,
      label: dayLabelFor(dayStart, nowMs || Date.now()),
      mode,
      cwd: null,
      items: byDay.get(dayStart),
    }));
  } else {
    const byKey = new Map();
    for (const entry of sorted) {
      const key = entry.projectKey || entry.projectLabel || 'unknown project';
      if (!byKey.has(key)) {
        byKey.set(key, {
          key: `project:${key}`, label: entry.projectLabel || 'unknown project', mode, cwd: entry.cwd || null, items: [],
        });
      }
      byKey.get(key).items.push(entry);
    }
    // Group order follows the chosen sort's own verdict on each group's first
    // (already sorted) item, so "oldest" reads oldest-first at both levels.
    groups = [...byKey.values()].sort((a, b) => COMPARATORS[sort](a.items[0], b.items[0]));
  }

  return { groups, total: kindFiltered.length, matched: matchedEntries.length };
}

module.exports = {
  GROUP_MODES,
  SORT_MODES,
  normalizeGroupBy,
  normalizeSortBy,
  planArtifactsView,
};
