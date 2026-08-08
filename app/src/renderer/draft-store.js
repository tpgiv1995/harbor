import { useCallback, useEffect, useRef, useState } from 'react';

export const DRAFT_STORE_KEY = 'harbor-drafts';
export const MAX_DRAFT_ENTRIES = 50;

export function emptyDraft() {
  return { text: '', attachments: [] };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const paths = Array.isArray(raw.paths)
    ? raw.paths.filter((path) => typeof path === 'string' && path)
    : [];
  const at = Number.isFinite(raw.at) ? raw.at : Date.now();
  if (!text && paths.length === 0) return null;
  return { text, paths, at };
}

export function loadDraftStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_STORE_KEY) || '{}');
    if (!raw || typeof raw !== 'object') return {};
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

export function serializeDraft({ text, attachments }) {
  return {
    text: String(text || ''),
    paths: (attachments || []).map((item) => item?.path).filter(Boolean),
    at: Date.now(),
  };
}

export function deserializeDraft(entry) {
  if (!entry) return emptyDraft();
  return {
    text: entry.text || '',
    attachments: Array.isArray(entry.attachments)
      ? entry.attachments
      : (entry.paths || []).map((path) => ({ path, thumbDataUri: null })),
  };
}

export function mergeDraftEntry(entry, patch) {
  const current = deserializeDraft(entry);
  const draft = {
    text: patch.text !== undefined ? patch.text : current.text,
    attachments: patch.attachments !== undefined ? patch.attachments : current.attachments,
  };
  return { ...serializeDraft(draft), attachments: draft.attachments };
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
export function renamedDraftStore(store, fromId, toId) {
  if (!store || !fromId || !toId || fromId === toId) return store || {};
  const entry = store[fromId];
  if (!entry) return store;
  const next = { ...store };
  delete next[fromId];
  if (!next[toId]) next[toId] = entry;
  return next;
}

export function persistDraftStore(store) {
  const cleaned = {};
  for (const [sessionId, entry] of Object.entries(store || {})) {
    const normalized = normalizeEntry(entry);
    if (normalized) cleaned[sessionId] = normalized;
  }
  const capped = capDraftStore(cleaned);
  localStorage.setItem(DRAFT_STORE_KEY, JSON.stringify(capped));
  return capped;
}

export function useDraftStore() {
  const [store, setStore] = useState(loadDraftStore);
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    persistDraftStore(store);
  }, [store]);

  const getDraft = useCallback((sessionId) => {
    if (!sessionId) return emptyDraft();
    return deserializeDraft(storeRef.current[sessionId]);
  }, []);

  const patchDraft = useCallback((sessionId, patch) => {
    if (!sessionId) return;
    setStore((prev) => {
      const serialized = mergeDraftEntry(prev[sessionId], patch);
      if (!serialized.text && serialized.paths.length === 0) {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      }
      return { ...prev, [sessionId]: serialized };
    });
  }, []);

  const clearDraft = useCallback((sessionId) => {
    if (!sessionId) return;
    setStore((prev) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  // Carry a draft across a session's id changing under an open window; see
  // renamedDraftStore for why the composer went blank without it.
  const renameDraft = useCallback((fromId, toId) => {
    setStore((prev) => renamedDraftStore(prev, fromId, toId));
  }, []);

  return { getDraft, patchDraft, clearDraft, renameDraft };
}
