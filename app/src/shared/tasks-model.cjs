'use strict';

// The task store's whole brain, kept pure so every rule below is testable
// without Electron, a filesystem or a React tree. The main process owns the
// file (providers/tasks.js) and the renderer owns the pixels (renderer/tasks/);
// both apply the SAME reducer to the SAME document shape, so a mutation cannot
// mean one thing on disk and another on screen.
//
// Shape (version 1):
//   { version, lists: [{ id, name, createdAt, order }],
//     tasks: [{ id, listId, parentId, depth, title, notes, done, completedAt,
//               completedBy, starred, myDayDate, dueDate, tags,
//               createdAt, updatedAt, order }] }
//
// Deliberate choices, each of which cost something to get wrong elsewhere:
//   * Dates that a human means as "a day" (due date, My Day) are stored as
//     LOCAL 'YYYY-MM-DD' strings, never epoch ms and never UTC. A UTC day key
//     rolls over at 7pm Central, which would silently empty My Day mid-evening.
//   * "My Day" is a DATE STAMP, not a flag. Microsoft's My Day resets every
//     morning; a stamp gives that for free with no background job and no clock
//     the app has to wake up for.
//   * Cascading a parent's completion down to its children records WHICH parent
//     did it (completedBy), so unticking that parent restores exactly the
//     children it completed and nothing else. A one-way cascade would quietly
//     destroy state on a misclick.
//   * normalizeDoc is TOTAL: any JSON at all comes back as a usable document.
//     This file is a plain, hand-editable JSON file in the user's config dir,
//     so "someone edited it by hand" and "half of it is nonsense" are ordinary
//     inputs, not exceptions.

const { DAY_ROLL_HOUR } = require('./date-roll.cjs');

const DOC_VERSION = 1;
// Three levels of task, as asked: a level-1 task, its sub-task, and that
// sub-task's own sub-task. Stored zero-based, so depth 2 is the floor.
const MAX_DEPTH = 2;
const MAX_TITLE = 500;
const MAX_NOTES = 20000;
const MAX_TAG = 40;
const MAX_TAGS_PER_TASK = 12;
const DEFAULT_LIST_NAME = 'Tasks';

const SMART_VIEWS = ['myday', 'important', 'planned', 'all', 'completed'];
// No 'importance' here any more: a star now floats to the top of My order
// itself (see starFirst), so that option would be a second name for the
// default. A saved 'importance' falls back to 'manual', which is what it did.
const SORTS = ['manual', 'due', 'created', 'title'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day a moment BELONGS to, as a local 'YYYY-MM-DD' key.
 *
 * Local, never UTC: a UTC key rolls over mid-evening in Central time and would
 * empty My Day while the user is still working.
 *
 * And it rolls at 6am, not midnight, reusing the same DAY_ROLL_HOUR the session
 * rail already groups by, so 1am belongs to the day that has not ended yet. A
 * midnight roll would clear My Day out from under a late session, which is the
 * single most annoying thing a task list can do. The My Day header names the
 * date it is showing, so this is visible rather than mysterious.
 */
function dayKey(date = new Date()) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getHours() < DAY_ROLL_HOUR) d.setDate(d.getDate() - 1);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Milliseconds until dayKey() would return a different answer. */
function msUntilDayRoll(date = new Date()) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), DAY_ROLL_HOUR, 0, 0, 0);
  if (next <= d) next.setDate(next.getDate() + 1);
  return next - d;
}

/** Parse a 'YYYY-MM-DD' key back to local midnight, or null. */
function dayDate(key) {
  if (!DATE_RE.test(String(key || ''))) return null;
  const [y, m, d] = String(key).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A day key `delta` days after `key`, or null if the key is not a day key. */
function shiftDay(key, delta) {
  const date = dayDate(key);
  if (!date) return null;
  date.setDate(date.getDate() + delta);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Whole days from `from` to `to`, both local day keys. */
function daysBetween(from, to) {
  const a = dayDate(from);
  const b = dayDate(to);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

function cleanDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (DATE_RE.test(String(value))) return String(value);
  // Tolerate a full ISO timestamp landing in a date field (a hand edit, or a
  // future importer): keep the day it names in LOCAL terms.
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : dayKey(parsed);
}

function cleanText(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r\n/g, '\n').slice(0, max);
}

function cleanTitle(value) {
  return cleanText(value, MAX_TITLE).replace(/[\n\t]+/g, ' ').trim();
}

function cleanStamp(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * A list colour is stored, not derived. Before this field every list took a
 * hash of its own NAME (renderer projectColor), which meant the colour was not
 * the user's to choose and silently changed when a list was renamed.
 *
 * null means "no colour chosen", and every renderer must fall back to the
 * name hash for that case, so lists that predate this field keep exactly the
 * colour they already had on screen.
 *
 * Total by contract, like the rest of normalizeDoc: the tasks file is
 * hand-editable, so `#nope`, 42, or an object are ordinary inputs and all of
 * them mean null rather than a corrupt document. Accepts #rgb and #rrggbb
 * with or without the leading hash, and always stores lowercase #rrggbb so
 * two spellings of one colour cannot compare unequal.
 */
function cleanColor(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw.toLowerCase().split('').map((c) => c + c).join('')}`;
  }
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

/**
 * Tags are compared case-insensitively but keep the casing they were typed in,
 * so "Work" and "work" are one tag and it reads the way the user wrote it.
 */
function cleanTags(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw ?? '').replace(/[\s,]+/g, ' ').trim().slice(0, MAX_TAG);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_TASK) break;
  }
  return out;
}

function tagKey(tag) {
  return String(tag || '').trim().toLowerCase();
}

let idCounter = 0;
function makeId(prefix = 't') {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

// The seeded list's id is FIXED, not generated, and that is load-bearing. A
// document is normalised on every read, so a generated seed id would be a
// different id each time until something was written: a fresh install that read
// the (absent) file, took the list id, and then asked to rename that list would
// be told the list no longer exists. Live-caught while driving the real app.
const DEFAULT_LIST_ID = 'list-default';

function emptyDoc(now = Date.now()) {
  return {
    version: DOC_VERSION,
    lists: [{ id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, createdAt: now, order: 0 }],
    tasks: [],
  };
}

/**
 * Coerce ANY input into a valid document. Never throws, never drops a task that
 * still carries a title, and repairs the parent graph (missing parents, cycles,
 * cross-list parents, wrong depth) rather than trusting what is on disk.
 */
function normalizeDoc(input, { now = Date.now(), idFactory = makeId } = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  const lists = [];
  const listIds = new Set();
  for (const entry of Array.isArray(raw.lists) ? raw.lists : []) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id || '').trim() || idFactory('l');
    if (listIds.has(id)) continue;
    listIds.add(id);
    lists.push({
      id,
      name: cleanTitle(entry.name) || 'Untitled list',
      color: cleanColor(entry.color),
      createdAt: cleanStamp(entry.createdAt, now),
      order: Number.isFinite(entry.order) ? entry.order : lists.length,
    });
  }
  if (lists.length === 0) {
    const seeded = emptyDoc(now).lists[0];
    lists.push(seeded);
    listIds.add(seeded.id);
  }
  lists.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  lists.forEach((list, index) => { list.order = index; });
  const fallbackListId = lists[0].id;

  const tasks = [];
  const byId = new Map();
  for (const entry of Array.isArray(raw.tasks) ? raw.tasks : []) {
    if (!entry || typeof entry !== 'object') continue;
    const title = cleanTitle(entry.title);
    if (!title) continue; // a task with no name is not a task
    const id = String(entry.id || '').trim() || idFactory('t');
    if (byId.has(id)) continue;
    const createdAt = cleanStamp(entry.createdAt, now);
    const done = entry.done === true;
    const task = {
      id,
      listId: listIds.has(entry.listId) ? entry.listId : fallbackListId,
      parentId: entry.parentId ? String(entry.parentId) : null,
      depth: 0,
      title,
      notes: cleanText(entry.notes, MAX_NOTES),
      done,
      completedAt: done ? cleanStamp(entry.completedAt, createdAt) : null,
      completedBy: done && entry.completedBy ? String(entry.completedBy) : null,
      starred: entry.starred === true,
      myDayDate: cleanDate(entry.myDayDate),
      dueDate: cleanDate(entry.dueDate),
      tags: cleanTags(entry.tags),
      createdAt,
      updatedAt: cleanStamp(entry.updatedAt, createdAt),
      order: Number.isFinite(entry.order) ? entry.order : tasks.length,
    };
    tasks.push(task);
    byId.set(id, task);
  }

  // Repair the parent graph. A parent that does not exist, points at itself, or
  // sits in a different list is dropped to a root; a cycle is broken at the
  // first task that walks back into itself; depth is always RECOMPUTED, never
  // read, so a hand-edited depth can never nest something 40 levels deep.
  for (const task of tasks) {
    if (!task.parentId) continue;
    const parent = byId.get(task.parentId);
    if (!parent || parent.id === task.id || parent.listId !== task.listId) {
      task.parentId = null;
      continue;
    }
    const seen = new Set([task.id]);
    let walker = parent;
    while (walker) {
      if (seen.has(walker.id)) { task.parentId = null; break; }
      seen.add(walker.id);
      walker = walker.parentId ? byId.get(walker.parentId) : null;
    }
  }
  for (const task of tasks) {
    let depth = 0;
    let walker = task.parentId ? byId.get(task.parentId) : null;
    while (walker && depth <= MAX_DEPTH + 2) {
      depth += 1;
      walker = walker.parentId ? byId.get(walker.parentId) : null;
    }
    // Anything deeper than the three allowed levels FLATTENS onto the deepest
    // legal ancestor rather than being deleted: a level-4 and a level-5 task
    // under the same branch both come back as level-3 siblings. Nothing is
    // lost, and the shape is legal without anyone choosing what to discard.
    while (depth > MAX_DEPTH) {
      const parent = byId.get(task.parentId);
      task.parentId = parent ? parent.parentId : null;
      depth -= 1;
    }
    task.depth = depth;
  }

  return { version: DOC_VERSION, lists, tasks };
}

function childrenOf(doc, parentId) {
  return doc.tasks
    .filter((task) => task.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

function rootsOf(doc, listId) {
  return doc.tasks
    .filter((task) => !task.parentId && task.listId === listId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/** Every descendant of `taskId`, depth-first, excluding the task itself. */
function descendants(doc, taskId) {
  const out = [];
  const walk = (id) => {
    for (const child of childrenOf(doc, id)) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(taskId);
  return out;
}

/** Titles from the root down to (but not including) `task`. */
function breadcrumb(doc, task) {
  const byId = new Map(doc.tasks.map((t) => [t.id, t]));
  const trail = [];
  let walker = task.parentId ? byId.get(task.parentId) : null;
  const guard = new Set();
  while (walker && !guard.has(walker.id)) {
    guard.add(walker.id);
    trail.unshift(walker.title);
    walker = walker.parentId ? byId.get(walker.parentId) : null;
  }
  return trail;
}

function isMyDay(task, today) {
  return Boolean(task.myDayDate) && task.myDayDate === today;
}

/**
 * How a due date reads relative to today. Null when there is no due date; a
 * COMPLETED task is never "overdue", because nagging about finished work is
 * exactly the noise that makes a task list get ignored.
 */
function dueState(task, today) {
  if (!task.dueDate) return null;
  if (task.done) return 'done';
  const delta = daysBetween(today, task.dueDate);
  if (delta === null) return null;
  if (delta < 0) return 'overdue';
  if (delta === 0) return 'today';
  if (delta === 1) return 'tomorrow';
  return 'future';
}

function dueLabel(task, today) {
  if (!task.dueDate) return null;
  const delta = daysBetween(today, task.dueDate);
  const date = dayDate(task.dueDate);
  if (delta === 0) return 'Due today';
  if (delta === 1) return 'Due tomorrow';
  if (delta === -1) return 'Due yesterday';
  if (delta !== null && delta < 0) return `${Math.abs(delta)} days overdue`;
  if (!date) return null;
  // The year comes from `today`, never from the wall clock: a pure selector
  // must render the same string in a test as it does in the app.
  const sameYear = String(task.dueDate).slice(0, 4) === String(today).slice(0, 4);
  return `Due ${date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  })}`;
}

// ─── selectors ─────────────────────────────────────────────────────────────

function matchesQuery(task, query) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return task.title.toLowerCase().includes(needle)
    || task.notes.toLowerCase().includes(needle)
    || task.tags.some((tag) => tag.toLowerCase().includes(needle));
}

function smartMatch(task, view, today) {
  switch (view) {
    case 'myday': return !task.done && isMyDay(task, today);
    case 'important': return !task.done && task.starred;
    case 'planned': return !task.done && Boolean(task.dueDate);
    case 'all': return !task.done;
    case 'completed': return task.done;
    default: return false;
  }
}

function counts(doc, today) {
  const byList = {};
  for (const list of doc.lists) byList[list.id] = 0;
  const smart = { myday: 0, important: 0, planned: 0, all: 0, completed: 0, overdue: 0, dueToday: 0 };
  for (const task of doc.tasks) {
    if (!task.done && byList[task.listId] !== undefined) byList[task.listId] += 1;
    for (const view of SMART_VIEWS) if (smartMatch(task, view, today)) smart[view] += 1;
    const state = dueState(task, today);
    if (state === 'overdue') smart.overdue += 1;
    if (state === 'today') smart.dueToday += 1;
  }
  return { byList, ...smart };
}

/** Every tag in use, with how many OPEN tasks carry it, most used first. */
function tagIndex(doc) {
  const map = new Map();
  for (const task of doc.tasks) {
    for (const tag of task.tags) {
      const key = tagKey(tag);
      const entry = map.get(key) || { tag, key, open: 0, total: 0 };
      entry.total += 1;
      if (!task.done) entry.open += 1;
      map.set(key, entry);
    }
  }
  // Most open work first, then most used overall, then alphabetical: a tag with
  // one thing left on it but a long history still outranks a one-off.
  return [...map.values()].sort(
    (a, b) => b.open - a.open || b.total - a.total || a.tag.localeCompare(b.tag),
  );
}

/**
 * A star PINS its task to the top of the order it sits in.
 *
 * This is the first key of "My order" everywhere: a list's tree (among each
 * task's own siblings, so a starred sub-task rises without leaving its parent),
 * a smart view's flat run, and the CLI, which reads through the same selector.
 * It deliberately does NOT override an EXPLICIT sort: asking for Due date and
 * getting three undated starred tasks on top would be the app arguing with a
 * direct instruction. It is the whole of the old 'importance' sort, which is
 * why that option is gone rather than sitting in the menu doing what My order
 * now does.
 */
function starFirst(a, b) {
  return Number(Boolean(b.starred)) - Number(Boolean(a.starred));
}

function sortComparator(sort, today) {
  switch (sort) {
    case 'due':
      return (a, b) => {
        // No due date sorts last: "someday" never outranks "Thursday".
        const av = a.dueDate ? daysBetween(today, a.dueDate) : Infinity;
        const bv = b.dueDate ? daysBetween(today, b.dueDate) : Infinity;
        return av - bv || a.order - b.order;
      };
    case 'created':
      // Newest first. The order tie-break matters: two tasks typed in the same
      // millisecond (an import, or a fast hand) would otherwise fall back to
      // insertion order and read as OLDEST first, which is the opposite of what
      // the option says.
      return (a, b) => b.createdAt - a.createdAt || b.order - a.order;
    case 'title':
      return (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    case 'manual':
    default:
      return (a, b) => starFirst(a, b) || a.order - b.order || a.createdAt - b.createdAt;
  }
}

/**
 * Build the rows a view renders.
 *
 * A real list renders as a TREE (roots with their sub-tasks nested), because
 * that is where structure is edited. A smart view renders FLAT with a
 * breadcrumb, because "Important" has to be able to show a starred level-3
 * sub-task without dragging its whole family in with it.
 *
 * Completed tasks are split out rather than hidden: they stay reachable under
 * their own section instead of vanishing, which is what makes ticking one feel
 * safe.
 */
function selectRows(doc, options = {}) {
  const {
    view = 'all',
    listId = null,
    today = dayKey(),
    query = '',
    sort = 'manual',
    tag = null,
  } = options;
  const isList = view === 'list';
  const activeSort = SORTS.includes(sort) ? sort : 'manual';
  const wantTag = tag ? tagKey(tag) : null;

  const passes = (task) => {
    if (wantTag && !task.tags.some((t) => tagKey(t) === wantTag)) return false;
    if (!matchesQuery(task, query)) return false;
    if (isList) return task.listId === listId;
    return smartMatch(task, view, today);
  };

  const listName = new Map(doc.lists.map((l) => [l.id, l.name]));
  const decorate = (task, depth) => {
    const kids = childrenOf(doc, task.id);
    return {
      task,
      depth,
      listName: listName.get(task.listId) || '',
      childCount: kids.length,
      childDoneCount: kids.filter((k) => k.done).length,
      breadcrumb: isList ? [] : breadcrumb(doc, task),
      due: dueState(task, today),
      dueLabel: dueLabel(task, today),
      myDay: isMyDay(task, today),
    };
  };

  if (!isList) {
    // "My order" has no meaning ACROSS lists, because order is only ever
    // assigned among siblings: sorted on it alone a smart view interleaves
    // three projects at random and looks broken. Grouping by list first keeps
    // each list's own order intact and reads as deliberate.
    // The star outranks that grouping, because "at the top" has to mean the top
    // of what is on screen; a star buried at the head of the third list is the
    // same thing as no star at all.
    const listOrder = new Map(doc.lists.map((l, index) => [l.id, index]));
    const base = sortComparator(activeSort, today);
    const compare = activeSort === 'manual'
      ? (a, b) => starFirst(a, b)
        || (listOrder.get(a.listId) ?? 0) - (listOrder.get(b.listId) ?? 0)
        || base(a, b)
      : base;
    const matched = doc.tasks.filter(passes).sort(compare);
    return {
      mode: 'flat',
      open: matched.filter((t) => !t.done).map((t) => decorate(t, 0)),
      done: matched.filter((t) => t.done).map((t) => decorate(t, 0)),
    };
  }

  // Tree mode. A sub-task whose PARENT is filtered out still has to be
  // reachable, so a filtered tree keeps any ancestor that leads to a match;
  // ancestors kept only as scaffolding are marked so the UI can dim them.
  const keep = new Set();
  const byId = new Map(doc.tasks.map((t) => [t.id, t]));
  for (const task of doc.tasks) {
    if (!passes(task)) continue;
    keep.add(task.id);
    let walker = task.parentId ? byId.get(task.parentId) : null;
    const guard = new Set();
    while (walker && !guard.has(walker.id)) {
      guard.add(walker.id);
      keep.add(walker.id);
      walker = walker.parentId ? byId.get(walker.parentId) : null;
    }
  }

  const open = [];
  const done = [];
  const comparator = sortComparator(activeSort, today);
  const walk = (parentId, depth, into) => {
    const kids = childrenOf(doc, parentId).filter((task) => keep.has(task.id));
    for (const task of [...kids].sort(comparator)) {
      const row = decorate(task, depth);
      row.scaffold = !passes(task);
      into.push(row);
      walk(task.id, depth + 1, into);
    }
  };
  // Roots split by their own completion; a completed root takes its subtree with
  // it into the Completed section so the two lists never show the same task.
  for (const root of [...rootsOf(doc, listId)].sort(comparator)) {
    if (!keep.has(root.id)) continue;
    const into = root.done ? done : open;
    const row = decorate(root, 0);
    row.scaffold = !passes(root);
    into.push(row);
    walk(root.id, 1, into);
  }
  return { mode: 'tree', open, done };
}

// ─── mutations ─────────────────────────────────────────────────────────────

function fail(reason) {
  return { ok: false, reason };
}

function nextOrder(siblings) {
  return siblings.reduce((max, t) => Math.max(max, t.order), -1) + 1;
}

function touch(task, now) {
  task.updatedAt = now;
  return task;
}

/**
 * Apply one operation and return a NEW document. Never mutates the input, so a
 * caller can keep the previous document for a retry or a diff, and always
 * answers {ok} rather than throwing: every refusal here is something the UI has
 * to be able to say out loud.
 */
function applyOp(input, op, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const idFactory = ctx.idFactory || makeId;
  const today = ctx.today || dayKey(new Date(now));
  // normalizeDoc allocates every list, task and tag array fresh, so the result
  // shares no reference with the input: the caller's document is never mutated
  // and can be kept for a retry or a diff.
  const doc = normalizeDoc(input, { now, idFactory });
  const type = op && typeof op === 'object' ? String(op.type || '') : '';
  const byId = (id) => doc.tasks.find((t) => t.id === id) || null;

  switch (type) {
    case 'list.add': {
      const name = cleanTitle(op.name);
      if (!name) return fail('a list needs a name');
      const list = {
        id: idFactory('l'),
        name,
        // An unparseable colour is null, never a refusal: a bad hex must not
        // cost the user the list they were creating.
        color: cleanColor(op.color),
        createdAt: now,
        order: doc.lists.length,
      };
      doc.lists.push(list);
      return { ok: true, doc, listId: list.id };
    }

    // Separate from list.rename on purpose: recolouring must not require a
    // name and renaming must not clear a colour. Passing null clears it, which
    // returns the list to the name-hash fallback.
    case 'list.color': {
      const list = doc.lists.find((l) => l.id === op.listId);
      if (!list) return fail('that list no longer exists');
      if (op.color !== null && op.color !== undefined && cleanColor(op.color) === null) {
        return fail(`"${op.color}" is not a colour; use a hex value like #4ec9b6`);
      }
      list.color = cleanColor(op.color);
      return { ok: true, doc };
    }

    case 'list.rename': {
      const list = doc.lists.find((l) => l.id === op.listId);
      if (!list) return fail('that list no longer exists');
      const name = cleanTitle(op.name);
      if (!name) return fail('a list needs a name');
      list.name = name;
      return { ok: true, doc };
    }

    case 'list.remove': {
      const list = doc.lists.find((l) => l.id === op.listId);
      if (!list) return fail('that list no longer exists');
      // Refusing the last list beats silently re-seeding one: the user keeps a
      // place to put tasks, and can rename it to whatever they meant.
      if (doc.lists.length === 1) return fail('this is the only list; rename it instead of deleting it');
      doc.lists = doc.lists.filter((l) => l.id !== list.id);
      doc.lists.forEach((l, index) => { l.order = index; });
      doc.tasks = doc.tasks.filter((t) => t.listId !== list.id);
      return { ok: true, doc };
    }

    case 'task.add': {
      const title = cleanTitle(op.title);
      if (!title) return fail('a task needs a name');
      const parent = op.parentId ? byId(op.parentId) : null;
      if (op.parentId && !parent) return fail('the parent task no longer exists');
      if (parent && parent.depth >= MAX_DEPTH) {
        return fail(`sub-tasks go three levels deep; ${parent.title} is already at the bottom`);
      }
      const listId = parent
        ? parent.listId
        : (doc.lists.find((l) => l.id === op.listId) ? op.listId : doc.lists[0].id);
      const siblings = parent ? childrenOf(doc, parent.id) : rootsOf(doc, listId);
      const task = {
        id: idFactory('t'),
        listId,
        parentId: parent ? parent.id : null,
        depth: parent ? parent.depth + 1 : 0,
        title,
        notes: cleanText(op.notes, MAX_NOTES),
        done: false,
        completedAt: null,
        completedBy: null,
        starred: op.starred === true,
        myDayDate: op.myDay === true ? today : cleanDate(op.myDayDate),
        dueDate: cleanDate(op.dueDate),
        tags: cleanTags(op.tags),
        createdAt: now,
        updatedAt: now,
        order: nextOrder(siblings),
      };
      doc.tasks.push(task);
      return { ok: true, doc, taskId: task.id };
    }

    case 'task.update': {
      const task = byId(op.taskId);
      if (!task) return fail('that task no longer exists');
      const patch = op.patch && typeof op.patch === 'object' ? op.patch : {};
      if ('title' in patch) {
        const title = cleanTitle(patch.title);
        if (!title) return fail('a task needs a name');
        task.title = title;
      }
      if ('notes' in patch) task.notes = cleanText(patch.notes, MAX_NOTES);
      if ('dueDate' in patch) task.dueDate = cleanDate(patch.dueDate);
      if ('starred' in patch) task.starred = patch.starred === true;
      if ('tags' in patch) task.tags = cleanTags(patch.tags);
      if ('myDay' in patch) task.myDayDate = patch.myDay === true ? today : null;
      if ('myDayDate' in patch) task.myDayDate = cleanDate(patch.myDayDate);
      if ('listId' in patch) {
        if (!doc.lists.some((l) => l.id === patch.listId)) return fail('that list no longer exists');
        // Moving a task moves its whole subtree: a sub-task can never sit in a
        // different list from its parent (normalizeDoc would orphan it).
        if (task.parentId) return fail('move the top-level task to move this one');
        const moving = [task, ...descendants(doc, task.id)];
        const siblings = rootsOf(doc, patch.listId);
        task.order = nextOrder(siblings);
        for (const item of moving) { item.listId = patch.listId; touch(item, now); }
      }
      return { ok: true, doc, taskId: touch(task, now).id };
    }

    case 'task.setDone': {
      const task = byId(op.taskId);
      if (!task) return fail('that task no longer exists');
      const done = op.done !== false;
      if (done) {
        task.done = true;
        task.completedAt = now;
        task.completedBy = null;
        // Finishing a parent finishes what is under it, stamped with WHICH
        // parent did it so unticking can put back exactly this much.
        for (const child of descendants(doc, task.id)) {
          if (child.done) continue;
          child.done = true;
          child.completedAt = now;
          child.completedBy = task.id;
          touch(child, now);
        }
      } else {
        task.done = false;
        task.completedAt = null;
        task.completedBy = null;
        for (const child of descendants(doc, task.id)) {
          if (child.done && child.completedBy === task.id) {
            child.done = false;
            child.completedAt = null;
            child.completedBy = null;
            touch(child, now);
          }
        }
      }
      return { ok: true, doc, taskId: touch(task, now).id };
    }

    case 'task.remove': {
      const task = byId(op.taskId);
      if (!task) return fail('that task no longer exists');
      const doomed = new Set([task.id, ...descendants(doc, task.id).map((t) => t.id)]);
      doc.tasks = doc.tasks.filter((t) => !doomed.has(t.id));
      return { ok: true, doc, removed: doomed.size };
    }

    case 'task.reorder': {
      const task = byId(op.taskId);
      if (!task) return fail('that task no longer exists');
      const siblings = task.parentId
        ? childrenOf(doc, task.parentId)
        : rootsOf(doc, task.listId);
      const ids = siblings.map((t) => t.id);
      const from = ids.indexOf(task.id);
      if (from < 0) return fail('that task is no longer where it was');
      let to = Number.isFinite(op.toIndex) ? Math.trunc(op.toIndex) : null;
      if (to === null && op.beforeId) {
        const at = ids.indexOf(op.beforeId);
        if (at < 0) return fail('that position no longer exists');
        to = at > from ? at - 1 : at;
      }
      if (to === null) return fail('reorder needs a destination');
      to = Math.max(0, Math.min(ids.length - 1, to));
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      ids.forEach((id, index) => { const t = byId(id); if (t) { t.order = index; touch(t, now); } });
      return { ok: true, doc };
    }

    case 'tasks.purgeCompleted': {
      // Clearing completed work is a real need on a list that has been running
      // for months, and it is destructive, so it is its own explicit op rather
      // than a side effect of anything else.
      const inScope = (t) => (op.listId ? t.listId === op.listId : true);
      const doomed = new Set();
      for (const task of doc.tasks) {
        if (!task.done || !inScope(task)) continue;
        doomed.add(task.id);
        for (const child of descendants(doc, task.id)) doomed.add(child.id);
      }
      if (doomed.size === 0) return fail('there is nothing completed to clear');
      doc.tasks = doc.tasks.filter((t) => !doomed.has(t.id));
      return { ok: true, doc, removed: doomed.size };
    }

    default:
      return fail(`unknown operation: ${type || '(none)'}`);
  }
}

/**
 * Did this input rely on the reader to invent identity? A list or task with no
 * id of its own gets a fresh one on EVERY normalise, so the caller has to write
 * the repaired document back before anything can reference those ids. Only the
 * store needs this; it is the difference between "hand-edited a task in" and
 * "clicking its checkbox says it does not exist".
 */
function mintsIds(input) {
  const missing = (entries) => Array.isArray(entries) && entries.some(
    (entry) => entry && typeof entry === 'object'
      && !(typeof entry.id === 'string' && entry.id.trim()),
  );
  const raw = input && typeof input === 'object' ? input : {};
  return missing(raw.lists) || missing(raw.tasks);
}

module.exports = {
  DAY_ROLL_HOUR,
  DEFAULT_LIST_ID,
  DOC_VERSION,
  mintsIds,
  MAX_DEPTH,
  msUntilDayRoll,
  DEFAULT_LIST_NAME,
  SMART_VIEWS,
  SORTS,
  applyOp,
  breadcrumb,
  childrenOf,
  cleanColor,
  counts,
  dayKey,
  dayDate,
  daysBetween,
  descendants,
  dueLabel,
  dueState,
  emptyDoc,
  isMyDay,
  makeId,
  normalizeDoc,
  rootsOf,
  selectRows,
  shiftDay,
  sortComparator,
  tagIndex,
  tagKey,
};
