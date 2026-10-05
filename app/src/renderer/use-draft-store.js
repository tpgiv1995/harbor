import { useCallback, useEffect, useRef, useState } from 'react';
import draftStore from './draft-store.cjs';

const {
  emptyDraft, loadDraftStore, mergeDraftEntry, renamedDraftStore, persistDraftStore,
} = draftStore;

export function useDraftStore() {
  const [store, setStore] = useState(loadDraftStore);
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    persistDraftStore(store);
  }, [store]);

  const getDraft = useCallback((sessionId) => {
    if (!sessionId) return emptyDraft();
    return draftStore.deserializeDraft(storeRef.current[sessionId]);
  }, []);

  const patchDraft = useCallback((sessionId, patch) => {
    if (!sessionId) return;
    setStore((prev) => {
      const serialized = mergeDraftEntry(prev[sessionId], patch);
      if (!serialized.text && serialized.paths.length === 0 && !serialized.filePaths?.length) {
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

  const renameDraft = useCallback((fromId, toId) => {
    setStore((prev) => renamedDraftStore(prev, fromId, toId));
  }, []);

  return { getDraft, patchDraft, clearDraft, renameDraft };
}
