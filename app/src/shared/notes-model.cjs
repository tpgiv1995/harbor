'use strict';

const DOC_VERSION = 1;
const MAX_TITLE = 300;
const MAX_BODY = 100000;
const MAX_TAG = 40;
const MAX_TAGS = 12;

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

function cleanStamp(value, fallback) {
  const stamp = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(stamp) && stamp > 0 ? stamp : fallback;
}

let idCounter = 0;
function makeId(prefix = 'n') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function emptyDoc() {
  return { version: DOC_VERSION, notes: [] };
}

function normalizeDoc(input, { now = Date.now(), idFactory = makeId } = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
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
      title: cleanTitle(entry.title),
      body: cleanText(entry.body, MAX_BODY),
      tags: cleanTags(entry.tags),
      pinned: entry.pinned === true,
      createdAt,
      updatedAt: cleanStamp(entry.updatedAt, createdAt),
    });
  }
  return { version: DOC_VERSION, notes };
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

  // An OP refuses an oversized body out loud rather than slicing: the editor
  // would keep showing text the disk no longer holds, and the loss would only
  // surface on reload. normalizeDoc still caps on READ, because repairing a
  // hand-edited file is a different job from accepting a mutation.
  const oversized = (value) => typeof value === 'string' && value.length > MAX_BODY;

  switch (type) {
    case 'note.add': {
      if (oversized(op.body)) return fail(`note body is over ${MAX_BODY} characters; split it`);
      const note = {
        id: idFactory('n'),
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

function selectNotes(doc, { query = '' } = {}) {
  const normalized = normalizeDoc(doc);
  const needle = String(query || '').trim().toLowerCase();
  return normalized.notes
    .filter((note) => !needle || `${note.title}\n${note.body}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || b.updatedAt - a.updatedAt
      || b.createdAt - a.createdAt
      || a.id.localeCompare(b.id));
}

function mintsIds(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return Array.isArray(raw.notes) && raw.notes.some((entry) => (
    entry && typeof entry === 'object'
      && !(typeof entry.id === 'string' && entry.id.trim())
  ));
}

module.exports = {
  DOC_VERSION,
  MAX_BODY,
  MAX_TITLE,
  applyOp,
  emptyDoc,
  makeId,
  mintsIds,
  normalizeDoc,
  selectNotes,
};
