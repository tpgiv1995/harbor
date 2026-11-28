import { useCallback, useEffect, useState } from 'react';
import notesModel from '../../../src/shared/notes-model.cjs';
import { CONNECTION } from '../rpc/client.js';
import { readCachedDoc, writeCachedDoc } from '../rpc/local-cache.js';

const { conflictNotice, normalizeDoc } = notesModel;

export function useNotes(client) {
  // The last notes the phone read paint at once, offline included (local-cache.js).
  const [doc, setDocState] = useState(() => {
    const cached = readCachedDoc('notes');
    return cached ? normalizeDoc(cached) : null;
  });
  const setDoc = useCallback((next) => {
    setDocState(next);
    if (next) writeCachedDoc('notes', next);
  }, []);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = useCallback(async () => {
    if (!client || client.getState() !== CONNECTION.connected) return;
    try {
      const result = await client.call('notes:read');
      if (result?.ok && result.doc) {
        setDoc(normalizeDoc(result.doc));
        setError(null);
        setNotice(result.repairDeferred ? 'File is busy. You can read the saved copy; retry changes shortly.' : null);
      } else {
        setError(result?.reason || 'the notes file could not be read');
      }
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [client, setDoc]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!client) return undefined;
    const unsubscribeChanged = client.onChannel('notes:changed', (payload) => {
      if (payload?.doc) {
        setDoc(normalizeDoc(payload.doc));
        setError(null);
      }
    });
    const unsubscribeConnection = client.onConnection((state) => {
      if (state === CONNECTION.connected) refresh();
    });
    return () => {
      unsubscribeChanged();
      unsubscribeConnection();
    };
  }, [client, refresh, setDoc]);

  const mutate = useCallback(async (op) => {
    if (!client) {
      const result = { ok: false, reason: 'not connected' };
      setNotice(result.reason);
      return result;
    }
    const result = await client.call('notes:mutate', op)
      .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    if (result?.ok && result.doc) setDoc(normalizeDoc(result.doc));
    setNotice(result?.ok ? conflictNotice(result) : (result?.reason || 'that change did not save'));
    return result || { ok: false };
  }, [client, setDoc]);

  return {
    doc,
    error,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    mutate,
    refresh,
  };
}
