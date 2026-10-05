'use strict';

// The notes store's whole brain, kept pure so every rule below is testable
// without Electron, a filesystem or a React tree. The main process owns the
// file (providers/notes.js) and the renderer owns the pixels (renderer/notes/);
// both apply the SAME reducer to the SAME document shape.
//
// Shape (version 1):
//   { version, groups: [{ id, name, color, createdAt, order }],
//     notes: [{ id, groupId, title, body, tags, pinned, createdAt, updatedAt }] }
//
// Groups mirror tasks-model's LISTS: a hard partition where every note lives in
// exactly one group, seeded with a fixed-id default so a fresh install can name
// its own starter group. Topics reuse the `tags` field a note already carries,
// so a note can wear several. The two organizers compose the same way tasks'
// lists and tags do: a group is the bucket, a topic is a cross-cutting filter.

const DOC_VERSION = 1;
const MAX_TITLE = 300;
const MAX_BODY = 100000;
const MAX_TAG = 40;
const MAX_TAGS = 12;

// The seeded group's id is FIXED, not generated, and that is load-bearing: a
// document is normalised on every read, so a generated seed id would differ on
// every read until something was written, and a fresh install that took the id
// and then renamed the group would be told the group no longer exists. This is
// the same trap tasks-model's DEFAULT_LIST_ID was built to dodge.
const DEFAULT_GROUP_ID = 'group-default';
const DEFAULT_GROUP_NAME = 'Notes';

function cleanText(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').slice(0, max);
}

function cleanTitle(value) {
  return cleanText(value, MAX_TITLE).replace(/[\n\t]+/g, ' ').trim();
}

function cleanTags(value) {
  const input = Array.isArray(value) ? value : [];
  const seen = new Set();
  const tags = [];
  for (const item of input) {
    const tag = String(item ?? '').replace(/[\s,]+/g, ' ').trim().slice(0, MAX_TAG);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/**
 * A group colour is stored, not derived. null means "no colour chosen", and
 * every renderer falls back to a name hash for that case, so groups that
 * predate this field keep the colour they already had on screen. Total by
 * contract like the rest of normalizeDoc: the notes file is hand-editable, so
 * `#nope`, 42 or an object are ordinary inputs and all mean null rather than a
 * corrupt document. Accepts #rgb and #rrggbb with or without the hash and
 * always stores lowercase #rrggbb so two spellings cannot compare unequal.
 * Kept byte-identical to tasks-model.cleanColor on purpose.
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

function cleanStamp(value, fallback) {
  const stamp = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(stamp) && stamp > 0 ? stamp : fallback;
}

function tagKey(tag) {
  return String(tag || '').trim().toLowerCase();
}

let idCounter = 0;
function makeId(prefix = 'n') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function seededGroup(now) {
  return { id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME, color: null, createdAt: now, order: 0 };
}

function emptyDoc(now = Date.now()) {
  return { version: DOC_VERSION, groups: [seededGroup(now)], notes: [] };
}

/**
 * Coerce ANY input into a valid document. Never throws; seeds a default group
 * when there are none, and lands every note in a real group (a missing or
 * unknown groupId falls back to the first group) so nothing is ever orphaned.
 */
function normalizeDoc(input, { now = Date.now(), idFactory = makeId } = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  const groups = [];
  const groupIds = new Set();
  for (const entry of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = String(entry.id || '').trim() || idFactory('g');
    if (groupIds.has(id)) continue;
    groupIds.add(id);
    groups.push({
      id,
      name: cleanTitle(entry.name) || 'Untitled group',
      color: cleanColor(entry.color),
      createdAt: cleanStamp(entry.createdAt, now),
      order: Number.isFinite(entry.order) ? entry.order : groups.length,
    });
  }
  if (groups.length === 0) {
    const seeded = seededGroup(now);
    groups.push(seeded);
    groupIds.add(seeded.id);
  }
  groups.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  groups.forEach((group, index) => { group.order = index; });
  const fallbackGroupId = groups[0].id;

  const notes = [];
  const ids = new Set();
  for (const entry of Array.isArray(raw.notes) ? raw.notes : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = String(entry.id || '').trim() || idFactory('n');
    if (ids.has(id)) continue;
    ids.add(id);
    const createdAt = cleanStamp(entry.createdAt, now);
    notes.push({
      id,
      groupId: groupIds.has(entry.groupId) ? entry.groupId : fallbackGroupId,
      title: cleanTitle(entry.title),
      body: cleanText(entry.body, MAX_BODY),
      tags: cleanTags(entry.tags),
      pinned: entry.pinned === true,
      createdAt,
      updatedAt: cleanStamp(entry.updatedAt, createdAt),
    });
  }
  return { version: DOC_VERSION, groups, notes };
}

function fail(reason) {
  return { ok: false, reason };
}

function applyOp(input, op, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const idFactory = ctx.idFactory || makeId;
  const doc = normalizeDoc(input, { now, idFactory });
  const type = op && typeof op === 'object' ? String(op.type || '') : '';
  const find = (id) => doc.notes.find((note) => note.id === id) || null;
  const findGroup = (id) => doc.groups.find((group) => group.id === id) || null;

  // An OP refuses an oversized body out loud rather than slicing: the editor
  // would keep showing text the disk no longer holds, and the loss would only
  // surface on reload. normalizeDoc still caps on READ, because repairing a
  // hand-edited file is a different job from accepting a mutation.
  const oversized = (value) => typeof value === 'string' && value.length > MAX_BODY;

  switch (type) {
    // ── groups ───────────────────────────────────────────────────────────
    case 'group.add': {
      const name = cleanTitle(op.name);
      if (!name) return fail('a group needs a name');
      const group = {
        id: idFactory('g'),
        name,
        // An unparseable colour is null, never a refusal: a bad hex must not
        // cost the user the group they were creating.
        color: cleanColor(op.color),
        createdAt: now,
        order: doc.groups.length,
      };
      doc.groups.push(group);
      return { ok: true, doc, groupId: group.id };
    }

    // Separate from group.rename on purpose: recolouring must not require a
    // name and renaming must not clear a colour. Passing null clears it, which
    // returns the group to the name-hash fallback.
    case 'group.color': {
      const group = findGroup(op.groupId);
      if (!group) return fail('that group no longer exists');
      if (op.color !== null && op.color !== undefined && cleanColor(op.color) === null) {
        return fail(`"${op.color}" is not a colour; use a hex value like #4ec9b6`);
      }
      group.color = cleanColor(op.color);
      return { ok: true, doc };
    }

    case 'group.rename': {
      const group = findGroup(op.groupId);
      if (!group) return fail('that group no longer exists');
      const name = cleanTitle(op.name);
      if (!name) return fail('a group needs a name');
      group.name = name;
      return { ok: true, doc };
    }

    case 'group.remove': {
      const group = findGroup(op.groupId);
      if (!group) return fail('that group no longer exists');
      // Refusing the last group beats silently re-seeding one: the user keeps a
      // place to put notes, and can rename it to whatever they meant.
      if (doc.groups.length === 1) return fail('this is the only group; rename it instead of deleting it');
      doc.groups = doc.groups.filter((g) => g.id !== group.id);
      doc.groups.forEach((g, index) => { g.order = index; });
      // A note OUTLIVES its group: deleting a group reassigns its notes to the
      // first remaining group rather than destroying them with it. A note is a
      // far bigger loss than a task, so this diverges from tasks' list.remove
      // (which deletes the tasks) on purpose. updatedAt is left ALONE: the note
      // itself did not change, and bumping it would jump every reassigned note
      // to the top of the recently-updated list for a move the user did not
      // make to its content.
      const home = doc.groups[0].id;
      let movedNotes = 0;
      for (const note of doc.notes) {
        if (note.groupId === group.id) { note.groupId = home; movedNotes += 1; }
      }
      return { ok: true, doc, movedNotes };
    }

    // ── notes ────────────────────────────────────────────────────────────
    case 'note.add': {
      if (oversized(op.body)) return fail(`note body is over ${MAX_BODY} characters; split it`);
      const note = {
        id: idFactory('n'),
        // An unknown groupId lands in the first group rather than refusing: the
        // caller (the view, the CLI) may pass a stale id, and losing the note
        // over a bad bucket would be the wrong trade.
        groupId: findGroup(op.groupId) ? op.groupId : doc.groups[0].id,
        title: cleanTitle(op.title),
        body: cleanText(op.body, MAX_BODY),
        tags: cleanTags(op.tags),
        pinned: false,
        createdAt: now,
        updatedAt: now,
      };
      doc.notes.push(note);
      return { ok: true, doc, noteId: note.id };
    }
    case 'note.update': {
      const note = find(op.noteId);
      if (!note) return fail('that note no longer exists');
      const patch = op.patch && typeof op.patch === 'object' ? op.patch : {};
      if (oversized(patch.body)) return fail(`note body is over ${MAX_BODY} characters; split it`);
      // A group move is an EXPLICIT decision, so an unknown target fails out
      // loud here (unlike note.add's tolerant fallback): the user picked a
      // group, and silently landing the note somewhere else would be a lie.
      if ('groupId' in patch && !findGroup(patch.groupId)) return fail('that group no longer exists');
      if ('groupId' in patch) note.groupId = patch.groupId;
      if ('title' in patch) note.title = cleanTitle(patch.title);
      if ('body' in patch) note.body = cleanText(patch.body, MAX_BODY);
      if ('tags' in patch) note.tags = cleanTags(patch.tags);
      if ('pinned' in patch) note.pinned = patch.pinned === true;
      note.updatedAt = now;
      return { ok: true, doc, noteId: note.id };
    }
    case 'note.append': {
      // Appends compose INSIDE the reducer so the read-modify-write happens
      // under the store's lock; a CLI that reads the body, edits it, and
      // writes it back can silently erase a flush that landed in between
      // (caught in review 2026-08-25; appendAssignment exists for the same
      // reason in tasks-model).
      const note = find(op.noteId);
      if (!note) return fail('that note no longer exists');
      const text = cleanText(op.text, MAX_BODY);
      if (!text) return fail('nothing to append');
      const joined = note.body ? `${note.body}\n${text}` : text;
      if (joined.length > MAX_BODY) return fail(`note body would pass ${MAX_BODY} characters; split it`);
      note.body = joined;
      note.updatedAt = now;
      return { ok: true, doc, noteId: note.id };
    }
    case 'note.remove': {
      const note = find(op.noteId);
      if (!note) return fail('that note no longer exists');
      doc.notes = doc.notes.filter((item) => item.id !== note.id);
      return { ok: true, doc, removed: 1 };
    }
    case 'note.pin': {
      const note = find(op.noteId);
      if (!note) return fail('that note no longer exists');
      note.pinned = op.pinned === true;
      note.updatedAt = now;
      return { ok: true, doc, noteId: note.id };
    }
    default:
      return fail(`unknown operation: ${type || '(none)'}`);
  }
}

/**
 * The notes a view renders. `groupId` restricts to one group (null = every
 * group), `tag` restricts to notes wearing that topic (case-insensitive), and
 * both compose with the text query. Ordered pinned-first, then most recently
 * updated, exactly as before.
 */
function selectNotes(doc, { query = '', groupId = null, tag = null } = {}) {
  const normalized = normalizeDoc(doc);
  const needle = String(query || '').trim().toLowerCase();
  const wantTag = tag ? tagKey(tag) : null;
  return normalized.notes
    .filter((note) => (!groupId || note.groupId === groupId))
    .filter((note) => (!wantTag || note.tags.some((t) => tagKey(t) === wantTag)))
    .filter((note) => !needle || `${note.title}\n${note.body}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || b.updatedAt - a.updatedAt
      || b.createdAt - a.createdAt
      || a.id.localeCompare(b.id));
}

/** How many notes each group holds, keyed by group id (every group present, 0 included). */
function groupCounts(doc) {
  const normalized = normalizeDoc(doc);
  const counts = {};
  for (const group of normalized.groups) counts[group.id] = 0;
  for (const note of normalized.notes) {
    if (counts[note.groupId] !== undefined) counts[note.groupId] += 1;
  }
  return counts;
}

/**
 * Every topic in use, with how many notes carry it, most used first. Tags are
 * compared case-insensitively but keep the casing they were typed in, so "Work"
 * and "work" are one topic and it reads the way the user wrote it.
 */
function tagIndex(doc) {
  const normalized = normalizeDoc(doc);
  const map = new Map();
  for (const note of normalized.notes) {
    for (const tag of note.tags) {
      const key = tagKey(tag);
      const entry = map.get(key) || { tag, key, count: 0 };
      entry.count += 1;
      map.set(key, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Did this input rely on the reader to invent identity? A group or note with no
 * id of its own gets a fresh one on EVERY normalise, so the store has to write
 * the repaired document back before anything can reference those ids.
 */
function mintsIds(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const missing = (entries) => Array.isArray(entries) && entries.some((entry) => (
    entry && typeof entry === 'object'
      && !(typeof entry.id === 'string' && entry.id.trim())
  ));
  return missing(raw.groups) || missing(raw.notes);
}

module.exports = {
  DEFAULT_GROUP_ID,
  DEFAULT_GROUP_NAME,
  DOC_VERSION,
  MAX_BODY,
  MAX_TITLE,
  applyOp,
  cleanColor,
  emptyDoc,
  groupCounts,
  makeId,
  mintsIds,
  normalizeDoc,
  selectNotes,
  tagIndex,
  tagKey,
};
