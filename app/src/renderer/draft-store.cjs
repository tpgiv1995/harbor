'use strict';

const DRAFT_STORE_KEY = 'harbor-drafts';
const MAX_DRAFT_ENTRIES = 50;

function emptyDraft() {
  return { text: '', attachments: [] };
}

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function normalizeAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const path = typeof raw.path === 'string' ? raw.path : '';
  if (!path) return null;
  if (raw.kind === 'file') return { kind: 'file', path, basename: basename(path) };
  // The original image attachment shape had no kind. Treat it as an image so
  // old drafts keep their preview and clipboard-send behavior.
  return {
    kind: 'image',
    path,
    thumbDataUri: typeof raw.thumbDataUri === 'string' ? raw.thumbDataUri : null,
  };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const paths = Array.isArray(raw.paths)
    ? raw.paths.filter((path) => typeof path === 'string' && path)
    : [];
  const filePaths = Array.isArray(raw.filePaths)
    ? raw.filePaths.filter((path) => typeof path === 'string' && path)
    : [];
  const at = Number.isFinite(raw.at) ? raw.at : Date.now();
  if (!text && paths.length === 0 && filePaths.length === 0) return null;
  return { text, paths, ...(filePaths.length ? { filePaths } : {}), at };
}

function loadDraftStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_STORE_KEY) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const next = {};
    for (const [sessionId, entry] of Object.entries(raw)) {
      const normalized = normalizeEntry(entry);
      if (normalized) next[sessionId] = normalized;
    }
    return next;
  } catch {
    return {};
  }
}

function serializeDraft({ text, attachments } = {}) {
  const normalized = Array.isArray(attachments)
    ? attachments.map(normalizeAttachment).filter(Boolean)
    : [];
  const paths = normalized
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => attachment.path);
  const filePaths = normalized
    .filter((attachment) => attachment.kind === 'file')
    .map((attachment) => attachment.path);
  return {
    text: String(text || ''),
    paths,
    ...(filePaths.length ? { filePaths } : {}),
    at: Date.now(),
  };
}

function deserializeDraft(entry) {
  if (!entry || typeof entry !== 'object') return emptyDraft();
  const attachments = Array.isArray(entry.attachments)
    ? entry.attachments.map(normalizeAttachment).filter(Boolean)
    : [
      ...(Array.isArray(entry.paths) ? entry.paths : [])
        .map((path) => normalizeAttachment({ kind: 'image', path })),
      ...(Array.isArray(entry.filePaths) ? entry.filePaths : [])
        .map((path) => normalizeAttachment({ kind: 'file', path })),
    ].filter(Boolean);
  return {
    text: typeof entry.text === 'string' ? entry.text : '',
    attachments,
  };
}

function mergeDraftEntry(entry, patch = {}) {
  const current = deserializeDraft(entry);
  const draft = {
    text: patch.text !== undefined ? patch.text : current.text,
    attachments: patch.attachments !== undefined ? patch.attachments : current.attachments,
  };
  return { ...serializeDraft(draft), attachments: deserializeDraft({ attachments: draft.attachments }).attachments };
}

function capDraftStore(store) {
  const ids = Object.keys(store);
  if (ids.length <= MAX_DRAFT_ENTRIES) return store;
  const keep = ids
    .sort((a, b) => (store[b]?.at || 0) - (store[a]?.at || 0))
    .slice(0, MAX_DRAFT_ENTRIES);
  const next = {};
  for (const id of keep) next[id] = store[id];
  return next;
}

// Move a draft from one session id to another, for when a session's id CHANGES
// under an open window. A new session opens as a provisional `pane:<id>` Pat can
// type into immediately, and upgrades to the real session id the moment the
// transcript materializes; without this the typed text stayed keyed to the dead
// `pane:<id>`, the composer looked up the new id, found nothing, and cleared
// itself, losing the message Pat was writing (2026-07-27). A draft already
// under the destination WINS: it is the newer intent, and clobbering it would
// trade one lost message for another.
function renamedDraftStore(store, fromId, toId) {
  if (!store || !fromId || !toId || fromId === toId) return store || {};
  const entry = store[fromId];
  if (!entry) return store;
  const next = { ...store };
  delete next[fromId];
  if (!next[toId]) next[toId] = entry;
  return next;
}

// Follow a provisional->real id upgrade chain to the id a draft now lives under.
// A new session opens as `pane:<id>` and upgrades to its real session id the
// moment its transcript materializes (renameDraft moves the draft, and the
// caller records the from->to hop in an alias map). Any draft write or clear
// captured against the OLD id must resolve through this first, or it lands on a
// dead key: the composer's own clear-on-send did exactly that and left the
// just-sent text in the box until this was shared with the dictation path
// (2026-09-16). Cycle-guarded so a malformed map can never spin.
function resolveDraftAlias(aliasMap, id) {
  if (!aliasMap || !id) return id || null;
  let current = id;
  const seen = new Set();
  while (aliasMap.has(current) && !seen.has(current)) {
    seen.add(current);
    current = aliasMap.get(current);
  }
  return current;
}

function persistDraftStore(store) {
  const cleaned = {};
  for (const [sessionId, entry] of Object.entries(store || {})) {
    const normalized = normalizeEntry(entry);
    if (normalized) cleaned[sessionId] = normalized;
  }
  const capped = capDraftStore(cleaned);
  localStorage.setItem(DRAFT_STORE_KEY, JSON.stringify(capped));
  return capped;
}

module.exports = {
  DRAFT_STORE_KEY,
  MAX_DRAFT_ENTRIES,
  emptyDraft,
  loadDraftStore,
  serializeDraft,
  deserializeDraft,
  mergeDraftEntry,
  renamedDraftStore,
  resolveDraftAlias,
  persistDraftStore,
};
